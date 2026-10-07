import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLocalSettingsUpgrade } from "./apply-local-ai-settings.mjs";

const project = "ai-collab-txxcvm61";
const host = `unix://${join(homedir(), ".orbstack/run/docker.sock")}`;
const root = fileURLToPath(new URL("../", import.meta.url));

class WebSetupError extends Error {
  constructor(code, diagnostic) {
    super(code);
    this.code = code;
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

function statusFailure(tool, error, stdout, stderr) {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  const has = (...markers) => markers.some((marker) => text.includes(marker));
  let reason = "CLI_FAILED";
  if (error.code === "ENOENT") reason = "CLI_NOT_INSTALLED";
  else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reason = "CLI_OUTPUT_TOO_LARGE";
  else if (error.killed) reason = "CLI_TIMEOUT";
  else if (has("telemetry.json")) reason = "CLI_STATE_UNAVAILABLE";
  else if (has("unknown command", "unknown flag", "unrecognized option", "unrecognized argument"))
    reason = "CLI_ARGUMENTS_UNSUPPORTED";
  else if (
    has(
      "enotcached",
      "npm err! canceled",
      "npm error canceled",
      "no matching supabase cli binary package",
      "could not determine executable",
    )
  )
    reason = "CLI_INSTALLATION_UNAVAILABLE";
  else if (
    has(
      "cannot connect to the docker",
      "no such container",
      "statusdbinspecterror",
      "statusdbnotreadyerror",
      "statusdbnotrunningerror",
      "permission denied while trying to connect to the docker",
    )
  )
    reason = "DOCKER_UNAVAILABLE";
  else if (
    has(
      "failed to read config",
      "failed to load config",
      "statusconfigloaderror",
      "statusinvalidconfigerror",
      "statusworkdirerror",
      "invalid jwt",
      "invalid config",
      "invalid signing",
    )
  )
    reason = "CONFIGURATION_UNAVAILABLE";
  const failure = new WebSetupError("LOCAL_STATUS_UNAVAILABLE", {
    tool,
    reason,
    exitCode: Number.isInteger(error.code) ? error.code : null,
  });
  failure.cliMissing = error.code === "ENOENT";
  return failure;
}

function docker(args, input = "") {
  return new Promise((accept, reject) => {
    const env = Object.fromEntries(
      ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    const child = execFile(
      "docker",
      ["--host", host, ...args],
      { env, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 16_384 },
      (error, stdout) => {
        if (error) return reject(new WebSetupError("LOCAL_DOCKER_UNAVAILABLE"));
        accept(stdout);
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function anonKey(value) {
  if (typeof value !== "string") throw new WebSetupError("PUBLIC_KEY_UNVERIFIED");
  const key = value;
  if (key.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key))
    throw new WebSetupError("PUBLIC_KEY_UNVERIFIED");
  try {
    if (JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8")).role !== "anon")
      throw new Error();
  } catch {
    throw new WebSetupError("PUBLIC_KEY_UNVERIFIED");
  }
  return key;
}

async function rejectEnvironmentFiles(directory) {
  for (const name of [".env.development.local", ".env.local", ".env.development", ".env"]) {
    try {
      await lstat(join(directory, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new WebSetupError("ENVIRONMENT_FILES_UNVERIFIED");
    }
    throw new WebSetupError("ENVIRONMENT_FILES_PRESENT");
  }
}

async function localStatus(workdir) {
  const args = ["status", "--workdir", workdir, "--output", "json"];
  const env = {
    ...Object.fromEntries(
      ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    ),
    DOCKER_HOST: host,
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  function read(command, commandArgs) {
    return new Promise((accept, reject) => {
      // Status includes private fields. Capture it in memory and never print or persist it.
      execFile(
        command,
        commandArgs,
        { env, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 65_536 },
        (error, stdout, stderr) =>
          error ? reject(statusFailure(command, error, stdout, stderr)) : accept(stdout),
      );
    });
  }
  try {
    return await read("supabase", args);
  } catch (error) {
    if (!error.cliMissing) throw error;
  }
  try {
    return await read("npx", ["--offline", "--no-install", "supabase", ...args]);
  } catch (error) {
    if (error instanceof WebSetupError) throw error;
    throw new WebSetupError("LOCAL_STATUS_UNAVAILABLE");
  }
}

/** Resolve local public settings; private status fields never enter the web environment. */
export async function localWebEnvironment(
  execute = docker,
  inherited = process.env,
  readStatus = localStatus,
  directory = root,
) {
  await rejectEnvironmentFiles(directory);
  let database;
  const checked = await runLocalSettingsUpgrade(false, async (args, input) => {
    const raw = await execute(args, input);
    if (args[0] === "inspect") database = JSON.parse(raw);
    return raw;
  });
  if (!Object.values(checked.features).every(Boolean))
    throw new WebSetupError("DATABASE_FEATURES_MISSING");
  let gateway;
  try {
    gateway = JSON.parse(
      await execute([
        "inspect",
        "--format",
        '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}',
        `supabase_kong_${project}`,
      ]),
    );
  } catch {
    throw new WebSetupError("GATEWAY_UNVERIFIED");
  }
  const ports = Object.values(gateway?.ports ?? {}).flatMap((value) => value ?? []);
  if (
    typeof gateway?.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(gateway.id) ||
    gateway.labels?.["com.supabase.cli.project"] !== project ||
    gateway.running !== true ||
    ports.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    ports[0].HostPort !== "56321"
  )
    throw new WebSetupError("GATEWAY_UNVERIFIED");
  let dbWorkdir;
  try {
    dbWorkdir = await realpath(database.labels["com.supabase.cli.workdir"]);
    const apiWorkdir = await realpath(gateway.labels["com.supabase.cli.workdir"]);
    if (dbWorkdir !== apiWorkdir) throw new Error();
  } catch {
    throw new WebSetupError("GATEWAY_WORKDIR_MISMATCH");
  }
  let key;
  try {
    const status = JSON.parse(await readStatus(dbWorkdir));
    if (status?.API_URL !== "http://127.0.0.1:56321")
      throw new WebSetupError("LOCAL_STATUS_ENDPOINT_MISMATCH");
    key = anonKey(status.ANON_KEY);
  } catch (error) {
    if (error instanceof WebSetupError) throw error;
    throw new WebSetupError("PUBLIC_KEY_UNVERIFIED");
  }
  return {
    ...Object.fromEntries(
      ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP"].flatMap((name) =>
        inherited[name] ? [[name, inherited[name]]] : [],
      ),
    ),
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_URL: "http://127.0.0.1:56321",
    SUPABASE_PUBLISHABLE_KEY: key,
    APP_ORIGIN: "http://127.0.0.1:4318",
  };
}

async function main() {
  if (process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) !== 24)
    throw new WebSetupError("MACOS_NODE24_REQUIRED");
  const checkOnly = process.argv.length === 3 && process.argv[2] === "--check";
  if (process.argv.length !== 2 && !checkOnly) throw new WebSetupError("INVALID_ARGUMENTS");
  const env = await localWebEnvironment();
  process.stdout.write(
    `${JSON.stringify({ status: checkOnly ? "CHECKED" : "STARTING", origin: env.APP_ORIGIN, modelInputs: 0 })}\n`,
  );
  if (checkOnly) return;
  const child = spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "4318"],
    { cwd: root, env, stdio: "inherit" },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
  child.on("error", () => {
    process.stderr.write(`${JSON.stringify({ status: "BLOCKED", code: "WEB_START_FAILED" })}\n`);
    process.exitCode = 1;
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "BLOCKED", code: error instanceof WebSetupError ? error.code : "LOCAL_STACK_UNVERIFIED", diagnostic: error instanceof WebSetupError ? error.diagnostic : undefined, modelInputs: 0 })}\n`,
    );
    process.exitCode = 1;
  });
