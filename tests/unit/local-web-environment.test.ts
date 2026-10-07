import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

type Execute = (args: string[], input?: string) => Promise<string>;
const anon = `e30.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.signature`;

async function fixture(t: TestContext) {
  const base = join(tmpdir(), "ai-collab-implementation-txxcvm61");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "local-web-unit-"));
  const canonicalDir = await realpath(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const driver = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  const database = {
    id: "a".repeat(64),
    labels: { "com.supabase.cli.project": "ai-collab-txxcvm61", "com.supabase.cli.workdir": dir },
    running: true,
    ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "56322" }] },
  };
  const f = {
    resolve: undefined as unknown as (
      execute: Execute,
      inherited?: Record<string, string>,
    ) => Promise<Record<string, string>>,
    dir,
    database,
    gateway: {
      ...database,
      labels: { ...database.labels },
      id: "b".repeat(64),
      ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "56321" }] },
    },
    features: { aiSettings: true, aiPause: true, folderAutoRead: true, answerSources: true },
    status: {
      API_URL: "http://127.0.0.1:56321",
      ANON_KEY: anon,
      SERVICE_ROLE_KEY: "private-admin-value",
      JWT_SECRET: "private-signing-value",
      DB_URL: "private-database-value",
    },
    statusReads: 0,
    statusFailure: null as Error | null,
    calls: [] as { args: string[]; input: string }[],
    execute: undefined as unknown as Execute,
  };
  f.resolve = (execute, inherited = {}) =>
    driver.localWebEnvironment(
      execute,
      inherited,
      async (workdir: string) => {
        assert.equal(workdir, canonicalDir);
        f.statusReads++;
        if (f.statusFailure) throw f.statusFailure;
        return JSON.stringify(f.status);
      },
      dir,
    );
  f.execute = async (args, input = "") => {
    f.calls.push({ args, input });
    if (args[0] === "exec") {
      assert.deepEqual(args.slice(0, 4), ["exec", "-i", database.id, "psql"]);
      assert.ok(input.startsWith("BEGIN READ ONLY;"));
      assert.ok(input.endsWith("ROLLBACK;"));
      return JSON.stringify(f.features);
    }
    assert.equal(args[0], "inspect");
    if (args.at(-1) === "supabase_db_ai-collab-txxcvm61") return JSON.stringify(database);
    if (args.at(-1) === "supabase_kong_ai-collab-txxcvm61") return JSON.stringify(f.gateway);
    assert.fail("Unexpected gateway key read: official Kong environment does not contain it");
  };
  return f;
}

async function failingCli(t: TestContext, stderr: string, code = 1) {
  const f = await fixture(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  const executable = join(f.dir, "supabase");
  const body = `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${code});\n`;
  await writeFile(executable, body, { mode: 0o700 });
  process.env.PATH = `${f.dir}:${dirname(process.execPath)}:/usr/bin:/bin`;
  const driver = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  return () => driver.localWebEnvironment(f.execute, {}, undefined, f.dir);
}

test("should retain the safe configuration failure reason from the real status boundary", async (t) => {
  const run = await failingCli(
    t,
    "failed to read config: private-admin-value private-database-value",
  );
  await assert.rejects(run(), (error: Error & { code?: string; diagnostic?: unknown }) => {
    assert.equal(error.code, "LOCAL_STATUS_UNAVAILABLE");
    assert.deepEqual(error.diagnostic, {
      tool: "supabase",
      reason: "CONFIGURATION_UNAVAILABLE",
      exitCode: 1,
    });
    assert.equal(JSON.stringify(error).includes("private-admin-value"), false);
    return true;
  });
});

test("should distinguish unavailable Docker without exposing raw diagnostics", async (t) => {
  const run = await failingCli(t, "Cannot connect to the Docker daemon: private-signing-value");
  await assert.rejects(run(), (error: Error & { diagnostic?: { reason?: string } }) => {
    assert.equal(error.diagnostic?.reason, "DOCKER_UNAVAILABLE");
    assert.equal(JSON.stringify(error).includes("private-signing-value"), false);
    return true;
  });
});

test("should preserve an offline cache failure when the PATH CLI is missing", async (t) => {
  const f = await fixture(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  await writeFile(
    join(f.dir, "npx"),
    `#!${process.execPath}\nif(process.argv[2]!=="--offline"||process.argv[3]!=="--no-install")process.exit(99);\nprocess.stderr.write("npm error canceled: private-admin-value");\nprocess.exit(1);\n`,
    { mode: 0o700 },
  );
  process.env.PATH = f.dir;
  const driver = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  await assert.rejects(
    driver.localWebEnvironment(f.execute, {}, undefined, f.dir),
    (error: Error & { diagnostic?: unknown }) => {
      assert.deepEqual(error.diagnostic, {
        tool: "npx",
        reason: "CLI_INSTALLATION_UNAVAILABLE",
        exitCode: 1,
      });
      assert.equal(JSON.stringify(error).includes("private-admin-value"), false);
      return true;
    },
  );
});

test("should classify npm cancellation for a missing offline package without revealing its output", async (t) => {
  const run = await failingCli(
    t,
    'npm error npx canceled due to missing packages and no YES option: ["private-package-value"]',
  );
  await assert.rejects(run(), (error: Error & { diagnostic?: unknown }) => {
    assert.deepEqual(error.diagnostic, {
      tool: "supabase",
      reason: "CLI_INSTALLATION_UNAVAILABLE",
      exitCode: 1,
    });
    assert.equal(JSON.stringify(error).includes("private-package-value"), false);
    return true;
  });
});

test("should reuse the installed pinned CLI cache without downloading another package", async (t) => {
  const f = await fixture(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  await writeFile(
    join(f.dir, "npx"),
    `#!${process.execPath}\nconst expected=["--offline","--no-install","supabase@2.118.0","status","--workdir",${JSON.stringify(await realpath(f.dir))},"--output","json"];\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(expected)){process.stderr.write('npm error npx canceled due to missing packages and no YES option');process.exit(1);}\nif(process.env.NPM_CONFIG_OFFLINE!=="true")process.exit(99);\nprocess.stdout.write(${JSON.stringify(JSON.stringify(f.status))});\n`,
    { mode: 0o700 },
  );
  process.env.PATH = f.dir;
  const driver = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  const environment = await driver.localWebEnvironment(f.execute, {}, undefined, f.dir);
  assert.equal(environment.SUPABASE_PUBLISHABLE_KEY, anon);
  assert.equal(environment.SUPABASE_URL, "http://127.0.0.1:56321");
  assert.equal(environment.LOCAL_ACCESS_ADMIN_KEY, undefined);
});

async function checkCommand(t: TestContext, failure: boolean) {
  const f = await fixture(t);
  const webRoot = join(f.dir, "web");
  await mkdir(join(webRoot, "scripts"), { recursive: true });
  for (const name of ["dev-local-web.mjs", "apply-local-ai-settings.mjs"]) {
    await writeFile(join(webRoot, "scripts", name), await readFile(resolve("scripts", name)));
  }
  const marker = join(webRoot, "web-started");
  const nextDir = join(webRoot, "node_modules/next/dist/bin");
  await mkdir(nextDir, { recursive: true });
  await writeFile(
    join(nextDir, "next"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`,
  );
  const dockerBody = `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[2]==="inspect"){process.stdout.write(JSON.stringify(a.at(-1).includes("_db_")?${JSON.stringify(f.database)}:${JSON.stringify(f.gateway)}));}else{let input="";process.stdin.on("data",b=>input+=b);process.stdin.on("end",()=>{if(!input.startsWith("BEGIN READ ONLY;")||!input.endsWith("ROLLBACK;"))process.exit(99);process.stdout.write(${JSON.stringify(JSON.stringify(f.features))});});}\n`;
  await writeFile(join(f.dir, "docker"), dockerBody, { mode: 0o700 });
  const cliBody = failure
    ? 'process.stderr.write("failed to read config: private-admin-value private-signing-value");process.exit(1);'
    : `process.stdout.write(${JSON.stringify(JSON.stringify(f.status))});`;
  await writeFile(join(f.dir, "supabase"), `#!${process.execPath}\n${cliBody}\n`, { mode: 0o700 });
  return {
    marker,
    run: async () =>
      promisify(execFile)(
        process.execPath,
        [await realpath(join(webRoot, "scripts/dev-local-web.mjs")), "--check"],
        {
          env: { PATH: f.dir, HOME: process.env.HOME, TMPDIR: tmpdir() },
          timeout: 5_000,
          maxBuffer: 16_384,
        },
      ),
  };
}

test(
  "should emit only the safe failure JSON in a check-only command",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const command = await checkCommand(t, true);
    await assert.rejects(command.run(), (error: Error & { stdout?: string; stderr?: string }) => {
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(error.stderr ?? ""), {
        status: "BLOCKED",
        code: "LOCAL_STATUS_UNAVAILABLE",
        diagnostic: { tool: "supabase", reason: "CONFIGURATION_UNAVAILABLE", exitCode: 1 },
        modelInputs: 0,
      });
      return true;
    });
  },
);

test(
  "should check settings without starting Next or revealing status credentials",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const command = await checkCommand(t, false);
    const result = await command.run();
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "CHECKED",
      origin: "http://127.0.0.1:4318",
      modelInputs: 0,
    });
    await assert.rejects(readFile(command.marker), { code: "ENOENT" });
  },
);

test("should discard unknown error text and retain only a fixed category and numeric exit status", async (t) => {
  const run = await failingCli(t, "private-admin-value private-signing-value", 23);
  await assert.rejects(run(), (error: Error & { diagnostic?: unknown }) => {
    assert.deepEqual(error.diagnostic, { tool: "supabase", reason: "CLI_FAILED", exitCode: 23 });
    assert.equal(JSON.stringify(error).includes("private-"), false);
    return true;
  });
});

test("should resolve matching local public settings without forwarding inherited secrets or remote overrides", async (t) => {
  const f = await fixture(t);
  const env = await f.resolve(f.execute, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    LOCAL_ACCESS_ADMIN_KEY: "private-admin-value",
    LOCAL_ACCESS_DB_URL: "private-database-value",
    ANTHROPIC_API_KEY: "private-provider-value",
    OPENAI_API_KEY: "private-provider-value",
    NODE_OPTIONS: "unsafe-node-options",
    SUPABASE_URL: "https://different-server.example",
    SUPABASE_PUBLISHABLE_KEY: "sb_secret_private-value",
    APP_ORIGIN: "https://different-web.example",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_URL: "http://127.0.0.1:56321",
    SUPABASE_PUBLISHABLE_KEY: anon,
    APP_ORIGIN: "http://127.0.0.1:4318",
  });
  assert.equal(f.calls.length, 3);
  assert.equal(f.statusReads, 1);
});

test("should reject missing DB features before reading any gateway key", async (t) => {
  const f = await fixture(t);
  f.features.aiSettings = false;
  await assert.rejects(f.resolve(f.execute), { code: "DATABASE_FEATURES_MISSING" });
  assert.equal(f.calls.length, 2);
});

test("should reject a gateway from another project before reading its key", async (t) => {
  const f = await fixture(t);
  f.gateway.labels["com.supabase.cli.project"] = "another-project";
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_UNVERIFIED" });
  assert.equal(f.calls.length, 3);
});

test("should reject stopped or publicly exposed gateways before reading their key", async (t) => {
  const f = await fixture(t);
  f.gateway.running = false;
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_UNVERIFIED" });
  f.gateway.running = true;
  f.gateway.ports["8000/tcp"][0].HostIp = "0.0.0.0";
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_UNVERIFIED" });
  assert.equal(f.calls.length, 6);
});

test("should reject a gateway with a different canonical workdir before reading its key", async (t) => {
  const f = await fixture(t);
  f.gateway.labels["com.supabase.cli.workdir"] = process.cwd();
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_WORKDIR_MISMATCH" });
  assert.equal(f.calls.length, 3);
});

test("should keep the verified workdir when the gateway name changes after inspection", async (t) => {
  const f = await fixture(t);
  const execute = f.execute;
  f.execute = async (args, input) => {
    const raw = await execute(args, input);
    if (args.at(-1) === "supabase_kong_ai-collab-txxcvm61") {
      f.gateway.id = "c".repeat(64);
      f.gateway.labels["com.supabase.cli.workdir"] = process.cwd();
    }
    return raw;
  };
  await f.resolve(f.execute, {});
  assert.equal(f.statusReads, 1);
});

test("should reject malformed or privileged keys without returning their contents", async (t) => {
  const f = await fixture(t);
  const privileged = `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  for (const value of [
    "",
    "private-diagnostic",
    "sb_secret_private-value",
    privileged,
    `SUPABASE_ANON_KEY=${anon}`,
  ]) {
    f.status.ANON_KEY = value;
    await assert.rejects(f.resolve(f.execute), (error: Error & { code?: string }) => {
      assert.equal(error.code, "PUBLIC_KEY_UNVERIFIED");
      assert.equal(error.message, "PUBLIC_KEY_UNVERIFIED");
      return true;
    });
  }
});

test("should resolve official CLI status when the gateway has no public key environment variable", async (t) => {
  const f = await fixture(t);
  const env = await f.resolve(f.execute, {});
  assert.equal(env.SUPABASE_PUBLISHABLE_KEY, anon);
  assert.equal(f.statusReads, 1);
  assert.equal(f.calls.length, 3);
});

test("should reject root development environment files without reading their contents", async (t) => {
  const f = await fixture(t);
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const file = join(f.dir, name);
    await writeFile(file, "LOCAL_ACCESS_ADMIN_KEY=private-admin-value\n", { mode: 0o000 });
    await assert.rejects(f.resolve(f.execute), { code: "ENVIRONMENT_FILES_PRESENT" });
    await rm(file);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.statusReads, 0);
});

test("should reject status for a different API endpoint before returning any configuration", async (t) => {
  const f = await fixture(t);
  for (const url of ["http://127.0.0.1:54321", "https://different-server.example", ""]) {
    f.status.API_URL = url;
    await assert.rejects(f.resolve(f.execute), { code: "LOCAL_STATUS_ENDPOINT_MISMATCH" });
  }
});

test("should mask failed status output instead of exposing private fields", async (t) => {
  const f = await fixture(t);
  f.statusFailure = new Error("private-admin-value private-database-value");
  await assert.rejects(f.resolve(f.execute), (error: Error & { code?: string }) => {
    assert.equal(error.code, "PUBLIC_KEY_UNVERIFIED");
    assert.equal(error.message, "PUBLIC_KEY_UNVERIFIED");
    return true;
  });
});
