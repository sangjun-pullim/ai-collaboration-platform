import { execFile, spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAILSAFE_SCHEMA, load } from "js-yaml";
import { runLocalSettingsUpgrade } from "./apply-local-ai-settings.mjs";

const project = "ai-collab-txxcvm61";
const host = `unix://${join(homedir(), ".orbstack/run/docker.sock")}`;
const root = fileURLToPath(new URL("../", import.meta.url));

class WebSetupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
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
      { env, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 65_536 },
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

function entries(value) {
  return Array.isArray(value) ? value : [];
}

function transformedKeys(value, authorization) {
  if (typeof value !== "string") return [];
  const header = authorization ? /^Authorization:\s*(.*)$/i : /^apikey:\s*(.*)$/i;
  const credential = header.exec(value)?.[1];
  if (!credential) return [];
  if (!credential.startsWith("$(")) {
    return authorization
      ? [credential.startsWith("Bearer ") ? credential.slice(7) : ""]
      : [credential];
  }
  // Match the rendered Supabase branches without evaluating Lua or extracting substrings from literals.
  const variable = authorization ? String.raw`headers\.apikey` : String.raw`query_params\.apikey`;
  const bearer = authorization ? "Bearer " : "";
  const forwarded = authorization
    ? String.raw`(?:\(headers\.authorization ~= nil and headers\.authorization:sub\(1, 10\) ~= 'Bearer sb_' and headers\.authorization\) or )?`
    : "";
  const branch = String.raw`\(${variable} == '[^']*' and '${bearer}([^']*)'\)`;
  const expression = new RegExp(
    String.raw`^\$\(${forwarded}${branch} or ${branch} or ${variable}\)$`,
  );
  return expression.exec(credential)?.slice(1) ?? [];
}

function* configuredGatewayKeys(document) {
  for (const consumer of entries(document.consumers)) {
    if (consumer?.username !== "anon") continue;
    for (const credential of entries(consumer.keyauth_credentials)) yield credential?.key;
  }
  for (const service of entries(document.services)) {
    for (const plugin of entries(service?.plugins)) {
      if (
        plugin?.name !== "request-transformer" ||
        (plugin.enabled !== undefined && !["true", "True", "TRUE"].includes(plugin.enabled))
      )
        continue;
      for (const operation of ["add", "replace"]) {
        for (const value of entries(plugin.config?.[operation]?.headers)) {
          yield* transformedKeys(value, true);
        }
      }
      for (const value of entries(plugin.config?.replace?.querystring)) {
        yield* transformedKeys(value, false);
      }
    }
  }
}

async function gatewayPublicKey(execute, gatewayId) {
  let config;
  try {
    // The rendered config includes private fields. Keep it in memory and never print or persist it.
    config = await execute(["exec", gatewayId, "cat", "/home/kong/kong.yml"]);
  } catch {
    throw new WebSetupError("GATEWAY_PUBLIC_KEY_UNAVAILABLE");
  }
  if (typeof config !== "string" || Buffer.byteLength(config) > 65_536)
    throw new WebSetupError("GATEWAY_PUBLIC_KEY_UNVERIFIED");
  let document;
  try {
    document = load(config, {
      schema: FAILSAFE_SCHEMA,
      maxDepth: 24,
      maxTotalMergeKeys: 0,
      onWarning() {
        throw new WebSetupError("GATEWAY_PUBLIC_KEY_UNVERIFIED");
      },
    });
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error();
  } catch {
    throw new WebSetupError("GATEWAY_PUBLIC_KEY_UNVERIFIED");
  }
  const keys = new Set();
  for (const credential of configuredGatewayKeys(document)) {
    try {
      keys.add(anonKey(credential));
    } catch {
      // Only an entire anon JWT in an active configured credential field can enter the web environment.
    }
  }
  if (keys.size !== 1) throw new WebSetupError("GATEWAY_PUBLIC_KEY_UNVERIFIED");
  return keys.values().next().value;
}

/** Resolve local public settings; private status fields never enter the web environment. */
export async function localWebEnvironment(
  execute = docker,
  inherited = process.env,
  readStatus = undefined,
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
    const status = readStatus
      ? JSON.parse(await readStatus(dbWorkdir))
      : {
          API_URL: "http://127.0.0.1:56321",
          ANON_KEY: await gatewayPublicKey(execute, gateway.id),
        };
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

export async function startLocalWeb(
  env,
  {
    build = async () =>
      (await import("./build-local-connection.mjs")).buildLocalConnection({ root }),
    start = (environment) =>
      spawn(
        process.execPath,
        ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", "4318"],
        { cwd: root, env: environment, stdio: "inherit" },
      ),
  } = {},
) {
  await build();
  return start(env);
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
  const child = await startLocalWeb(env);
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
      `${JSON.stringify({ status: "BLOCKED", code: error instanceof WebSetupError ? error.code : "LOCAL_STACK_UNVERIFIED", modelInputs: 0 })}\n`,
    );
    process.exitCode = 1;
  });
