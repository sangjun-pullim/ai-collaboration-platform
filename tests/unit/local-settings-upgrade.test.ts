import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

type Features = {
  aiSettings: boolean;
  aiPause: boolean;
  folderAutoRead: boolean;
  answerSources: boolean;
};
type Execute = (args: string[], input?: string) => Promise<string>;
type Result = { status: string; features: Features; modelInputs: number; migrations?: string[] };
const missing: Features = {
  aiSettings: false,
  aiPause: false,
  folderAutoRead: false,
  answerSources: false,
};
const present: Features = {
  aiSettings: true,
  aiPause: true,
  folderAutoRead: true,
  answerSources: true,
};

async function fixture(t: TestContext) {
  const base = join(tmpdir(), "ai-collab-implementation-txxcvm61");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "local-upgrade-unit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const driverModule = await import(
    pathToFileURL(resolve("scripts/apply-local-ai-settings.mjs")).href
  );
  const f = {
    dir,
    run: driverModule.runLocalSettingsUpgrade as (
      apply?: boolean,
      execute?: Execute,
    ) => Promise<Result>,
    before: { ...missing },
    after: { ...present },
    baseline: { requiredFunctions: true, receiptIntegrity: true, actorPrecondition: true },
    applied: false,
    failApply: false,
    raw: undefined as string | undefined,
    calls: [] as { args: string[]; input: string }[],
    metadata: {
      id: "a".repeat(64),
      labels: { "com.supabase.cli.project": "ai-collab-txxcvm61", "com.supabase.cli.workdir": dir },
      running: true,
      ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "56322" }] },
    },
    execute: undefined as unknown as Execute,
  };
  f.execute = async (args, input = "") => {
    f.calls.push({ args, input });
    if (args[0] === "inspect") return JSON.stringify(f.metadata);
    assert.deepEqual(args.slice(0, 4), ["exec", "-i", "a".repeat(64), "psql"]);
    assert.ok(args.includes("ON_ERROR_STOP=1"));
    if (input.startsWith("BEGIN READ ONLY;") && input.includes("'actorPrecondition'"))
      return JSON.stringify(f.baseline);
    if (input.startsWith("BEGIN READ ONLY;"))
      return f.raw ?? JSON.stringify(f.applied ? f.after : f.before);
    assert.ok(input.includes("$local_settings_guard$"));
    if (f.failApply) throw new Error("private database diagnostic must remain private");
    f.applied = true;
    return "";
  };
  return f;
}

test("should inspect local settings without applying migrations by default", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(false, f.execute), {
    status: "CHECKED",
    features: missing,
    modelInputs: 0,
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.applied, false);
});

test("should apply all four reviewed migrations in one transaction and confirm installed features", async (t) => {
  const f = await fixture(t);
  const result = await f.run(true, f.execute);
  assert.equal(result.status, "APPLIED");
  assert.deepEqual(result.features, present);
  assert.equal(result.modelInputs, 0);
  assert.equal(result.migrations?.length, 4);
  const sql = f.calls[3].input;
  assert.equal(sql.match(/^begin;$/gim)?.length, 1);
  assert.equal(sql.match(/^commit;$/gim)?.length, 1);
  assert.ok(
    sql.indexOf("$local_settings_guard$") <
      sql.indexOf("alter table device_binding_private.agents"),
  );
  assert.ok(sql.indexOf("create schema own_input_private") < sql.indexOf("readMode"));
  assert.ok(sql.indexOf("readMode") < sql.indexOf("create schema source_history_private"));
  assert.ok(sql.indexOf("NOTIFY pgrst") < sql.lastIndexOf("COMMIT;"));
  assert.ok(sql.includes("to_regnamespace('runtime_settings_private') IS NOT NULL"));
  assert.ok(sql.includes("pg_try_advisory_xact_lock"));
  assert.equal(f.calls.length, 5);
});

test("should reject an unowned Docker project before accessing PostgreSQL", async (t) => {
  const f = await fixture(t);
  f.metadata.labels["com.supabase.cli.project"] = "different-project";
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_CONTAINER" });
  assert.equal(f.calls.length, 1);
});

test("should retain the verified immutable container identity across a name replacement", async (t) => {
  const f = await fixture(t);
  const execute = f.execute;
  f.execute = async (args, input) => {
    const result = await execute(args, input);
    if (args[0] === "inspect") f.metadata.id = "b".repeat(64);
    return result;
  };
  assert.equal((await f.run(true, f.execute)).status, "APPLIED");
  for (const call of f.calls.slice(1)) assert.equal(call.args[2], "a".repeat(64));
});

test("should reject missing immutable container evidence before accessing PostgreSQL", async (t) => {
  const f = await fixture(t);
  f.metadata.id = "unverified";
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_CONTAINER" });
  assert.equal(f.calls.length, 1);
});

test("should reject public or unexpected database port bindings before applying", async (t) => {
  const f = await fixture(t);
  f.metadata.ports["5432/tcp"][0].HostIp = "0.0.0.0";
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_CONTAINER" });
  f.metadata.ports["5432/tcp"][0].HostIp = "127.0.0.1";
  f.metadata.ports["5432/tcp"][0].HostPort = "54322";
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_CONTAINER" });
  assert.equal(f.applied, false);
});

test("should reject a workdir outside the owned development stack", async (t) => {
  const f = await fixture(t);
  f.metadata.labels["com.supabase.cli.workdir"] = process.cwd();
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_WORKDIR" });
  assert.equal(f.calls.length, 1);
});

test("should refuse partial upgrades without replaying any migration", async (t) => {
  const f = await fixture(t);
  f.before.aiSettings = true;
  await assert.rejects(f.run(true, f.execute), { code: "PARTIAL_UPGRADE_REQUIRES_INSPECTION" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.applied, false);
});

test("should leave an already present schema unchanged", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  assert.equal((await f.run(true, f.execute)).status, "ALREADY_PRESENT");
  assert.equal(f.calls.length, 2);
  assert.equal(f.applied, false);
});

test("should reject missing deferred receipt constraints before applying any migration", async (t) => {
  const f = await fixture(t);
  f.baseline.receiptIntegrity = false;
  await assert.rejects(f.run(true, f.execute), { code: "BASELINE_NOT_READY" });
  assert.equal(f.calls.length, 3);
  assert.equal(f.applied, false);
});

test("should reject missing actor preconditions before applying any migration", async (t) => {
  const f = await fixture(t);
  f.baseline.actorPrecondition = false;
  await assert.rejects(f.run(true, f.execute), { code: "BASELINE_NOT_READY" });
  assert.equal(f.calls.length, 3);
  assert.equal(f.applied, false);
});

test("should preserve an uncertain apply failure without retrying or publishing private errors", async (t) => {
  const f = await fixture(t);
  f.failApply = true;
  await assert.rejects(f.run(true, f.execute), (error: Error) => {
    assert.equal(error.message, "APPLY_NOT_CONFIRMED");
    assert.equal(error.message.includes("private database"), false);
    return true;
  });
  assert.equal(f.calls.length, 4);
});

test("should keep missing post-commit evidence unconfirmed without applying again", async (t) => {
  const f = await fixture(t);
  f.after = { ...missing };
  await assert.rejects(f.run(true, f.execute), { code: "APPLY_NOT_CONFIRMED" });
  assert.equal(f.calls.length, 5);
});

test("should reject malformed database responses before any write", async (t) => {
  const f = await fixture(t);
  f.raw = JSON.stringify({ ...missing, extra: true });
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_DATABASE_RESPONSE" });
  assert.equal(f.applied, false);
});

test("should reject modified migration inputs before opening the write transaction", async (t) => {
  const f = await fixture(t);
  const source = await readFile(resolve("scripts/apply-local-ai-settings.mjs"), "utf8");
  const scriptDir = join(f.dir, "scripts");
  const migrationDir = join(f.dir, "supabase/migrations");
  await mkdir(scriptDir);
  await mkdir(migrationDir, { recursive: true });
  await writeFile(join(scriptDir, "apply-local-ai-settings.mjs"), source);
  const names = [
    "20261005001000-owner-local-ai-setup.sql",
    "20261006001100-own-ai-input-pause.sql",
    "20261006001200-owner-approved-repository-access.sql",
    "20261006001300-shared-input-source-history.sql",
  ];
  for (const name of names)
    await copyFile(resolve("supabase/migrations", name), join(migrationDir, name));
  await writeFile(join(migrationDir, names[0]), "SELECT 'unreviewed input';");
  const driverModule = await import(
    pathToFileURL(join(scriptDir, "apply-local-ai-settings.mjs")).href
  );
  await assert.rejects(driverModule.runLocalSettingsUpgrade(true, f.execute), {
    code: "MIGRATION_INPUT_CHANGED",
  });
  assert.equal(f.calls.length, 3);
  assert.equal(f.applied, false);
});
