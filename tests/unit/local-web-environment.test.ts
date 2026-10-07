import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

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
