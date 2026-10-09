import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

type CatalogState = {
  catalogAbsent: boolean;
  catalogLegacy: boolean;
  catalogFixed: boolean;
  catalogPrevious?: boolean;
};
const absentCatalog: CatalogState = {
  catalogAbsent: true,
  catalogLegacy: false,
  catalogFixed: false,
};
const legacyCatalog: CatalogState = {
  catalogAbsent: false,
  catalogLegacy: true,
  catalogFixed: false,
};
const fixedCatalog: CatalogState = {
  catalogAbsent: false,
  catalogLegacy: false,
  catalogFixed: true,
};
type SourceSummaryState = {
  sourceSummaryAbsent: boolean;
  sourceSummaryLegacy: boolean;
  sourceSummaryFixed: boolean;
};
const absentSourceSummary: SourceSummaryState = {
  sourceSummaryAbsent: true,
  sourceSummaryLegacy: false,
  sourceSummaryFixed: false,
};
const legacySourceSummary: SourceSummaryState = {
  sourceSummaryAbsent: false,
  sourceSummaryLegacy: true,
  sourceSummaryFixed: false,
};
const fixedSourceSummary: SourceSummaryState = {
  sourceSummaryAbsent: false,
  sourceSummaryLegacy: false,
  sourceSummaryFixed: true,
};
type CommitBindingState = {
  commitBindingAbsent: boolean;
  commitBindingLegacy: boolean;
  commitBindingFixed: boolean;
};
const absentCommitBinding: CommitBindingState = {
  commitBindingAbsent: true,
  commitBindingLegacy: false,
  commitBindingFixed: false,
};
const legacyCommitBinding: CommitBindingState = {
  commitBindingAbsent: false,
  commitBindingLegacy: true,
  commitBindingFixed: false,
};
const fixedCommitBinding: CommitBindingState = {
  commitBindingAbsent: false,
  commitBindingLegacy: false,
  commitBindingFixed: true,
};
const migrationNames = [
  "20261005001000-owner-local-ai-setup.sql",
  "20261006001100-own-ai-input-pause.sql",
  "20261006001200-owner-approved-repository-access.sql",
  "20261006001300-shared-input-source-history.sql",
  "20261008001400-runtime-settings-catalog-validation.sql",
  "20261008001500-source-history-summary-validation.sql",
  "20261008001600-runtime-settings-binding-receipt.sql",
  "20261009001700-runtime-model-display-names.sql",
];

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
    failFeatureConfirmation: false,
    failCatalogConfirmation: false,
    catalogBefore: undefined as CatalogState | undefined,
    catalogAfter: { ...fixedCatalog },
    sourceSummaryBefore: undefined as SourceSummaryState | undefined,
    sourceSummaryAfter: { ...fixedSourceSummary },
    commitBindingBefore: undefined as CommitBindingState | undefined,
    commitBindingAfter: { ...fixedCommitBinding },
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
    if (input.startsWith("BEGIN READ ONLY;") && input.includes("'catalogLegacy'")) {
      if (f.applied && f.failCatalogConfirmation)
        throw new Error("private confirmation diagnostic");
      return JSON.stringify({
        catalogPrevious: false,
        ...(f.applied
          ? f.catalogAfter
          : (f.catalogBefore ??
            (Object.values(f.before).every(Boolean) ? legacyCatalog : absentCatalog))),
        ...(f.applied
          ? f.sourceSummaryAfter
          : (f.sourceSummaryBefore ??
            (Object.values(f.before).every(Boolean) ? fixedSourceSummary : absentSourceSummary))),
        ...(f.applied
          ? f.commitBindingAfter
          : (f.commitBindingBefore ??
            (Object.values(f.before).every(Boolean) ? fixedCommitBinding : absentCommitBinding))),
      });
    }
    if (input.startsWith("BEGIN READ ONLY;") && input.includes("'actorPrecondition'"))
      return JSON.stringify(f.baseline);
    if (input.startsWith("BEGIN READ ONLY;")) {
      if (f.applied && f.failFeatureConfirmation)
        throw new Error("private confirmation diagnostic");
      return f.raw ?? JSON.stringify(f.applied ? f.after : f.before);
    }
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

test("should apply all eight reviewed migrations in one transaction and confirm installed features", async (t) => {
  const f = await fixture(t);
  const result = await f.run(true, f.execute);
  assert.equal(result.status, "APPLIED");
  assert.deepEqual(result.features, present);
  assert.equal(result.modelInputs, 0);
  assert.deepEqual(result.migrations, migrationNames);
  const sql = f.calls.find((call) => call.input.startsWith("BEGIN;"))!.input;
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
  assert.equal(f.calls.length, 7);
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

test("should leave an already fixed catalog unchanged without writes", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.catalogBefore = { ...fixedCatalog };
  assert.equal((await f.run(true, f.execute)).status, "ALREADY_PRESENT");
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 0);
  assert.equal(f.applied, false);
});

test("should patch the reviewed catalog on an installed stack without replaying migrations", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  const result = await f.run(true, f.execute);
  assert.equal(result.status, "APPLIED");
  assert.deepEqual(result.features, present);
  assert.deepEqual(result.migrations, ["20261009001700-runtime-model-display-names.sql"]);
  const writes = f.calls.filter((call) => call.input.startsWith("BEGIN;"));
  assert.equal(writes.length, 1);
  assert.ok(
    writes[0].input.includes("create or replace function runtime_settings_private.catalog_ok"),
  );
  assert.equal(writes[0].input.includes("create schema"), false);
  assert.equal(writes[0].input.includes("alter table"), false);
});

test("should select exactly pending corrections across all three legacy and fixed combinations", async (t) => {
  for (const catalogFixed of [false, true]) {
    for (const sourceFixed of [false, true]) {
      for (const bindingFixed of [false, true]) {
        await t.test(
          `should select pending patches with catalogFixed=${catalogFixed}, sourceFixed=${sourceFixed}, bindingFixed=${bindingFixed}`,
          async (t) => {
            const f = await fixture(t);
            f.before = { ...present };
            f.catalogBefore = { ...(catalogFixed ? fixedCatalog : legacyCatalog) };
            f.sourceSummaryBefore = { ...(sourceFixed ? fixedSourceSummary : legacySourceSummary) };
            f.commitBindingBefore = {
              ...(bindingFixed ? fixedCommitBinding : legacyCommitBinding),
            };
            const expected = [migrationNames[5], migrationNames[6], migrationNames[7]].filter(
              (_, index) => ![sourceFixed, bindingFixed, catalogFixed][index],
            );
            const result = await f.run(true, f.execute);
            assert.deepEqual(result.features, present);
            assert.equal(result.modelInputs, 0);
            assert.equal(result.status, expected.length ? "APPLIED" : "ALREADY_PRESENT");
            assert.deepEqual(result.migrations ?? [], expected);
            const writes = f.calls.filter((call) => call.input.startsWith("BEGIN;"));
            assert.equal(writes.length, expected.length ? 1 : 0);
            if (writes.length) {
              const sql = writes[0].input;
              assert.equal(sql.match(/^begin;$/gim)?.length, 1);
              assert.equal(sql.match(/^commit;$/gim)?.length, 1);
              assert.equal(sql.includes("create schema"), false);
              assert.equal(sql.includes("alter table"), false);
              for (const [index, signature] of [
                "runtime_settings_private.catalog_ok",
                "source_history_private.confirm_whole",
                "runtime_settings_private.commit_binding",
              ].entries()) {
                assert.equal(
                  sql.includes(`create or replace function ${signature}`),
                  expected.includes(migrationNames[index === 0 ? 7 : index + 4]),
                );
              }
            }
          },
        );
      }
    }
  }
});

test("should block unknown or inconsistent commit binding metadata without writes", async (t) => {
  for (const state of [
    { commitBindingAbsent: false, commitBindingLegacy: false, commitBindingFixed: false },
    { commitBindingAbsent: false, commitBindingLegacy: true, commitBindingFixed: true },
    absentCommitBinding,
  ]) {
    await t.test(`should refuse commit binding state ${JSON.stringify(state)}`, async (t) => {
      const f = await fixture(t);
      f.before = { ...present };
      f.catalogBefore = { ...fixedCatalog };
      f.commitBindingBefore = { ...state };
      await assert.rejects(f.run(true, f.execute), { code: "COMMIT_BINDING_SOURCE_UNVERIFIED" });
      assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 0);
      assert.equal(f.calls.length, 3);
    });
  }
});

test("should reject modified SQL016 before fresh or installed correction writes", async (t) => {
  for (const installed of [false, true]) {
    await t.test(
      `should block changed SQL016 on ${installed ? "installed" : "fresh"} stack`,
      async (t) => {
        const f = await fixture(t);
        if (installed) {
          f.before = { ...present };
          f.catalogBefore = { ...fixedCatalog };
          f.commitBindingBefore = { ...legacyCommitBinding };
        }
        const driverModule = await modifiedMigrationDriver(f.dir, migrationNames[6]);
        await assert.rejects(driverModule.runLocalSettingsUpgrade(true, f.execute), {
          code: "MIGRATION_INPUT_CHANGED",
        });
        assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 0);
      },
    );
  }
});

test("should leave missing commit binding postcommit evidence unconfirmed without retries", async (t) => {
  for (const state of [
    legacyCommitBinding,
    { commitBindingAbsent: false, commitBindingLegacy: false, commitBindingFixed: false },
  ]) {
    await t.test(
      `should require fixed commit binding after ${JSON.stringify(state)}`,
      async (t) => {
        const f = await fixture(t);
        f.before = { ...present };
        f.catalogBefore = { ...fixedCatalog };
        f.commitBindingBefore = { ...legacyCommitBinding };
        f.commitBindingAfter = { ...state };
        await assert.rejects(f.run(true, f.execute), { code: "APPLY_NOT_CONFIRMED" });
        assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 1);
        assert.equal(f.calls.length, 7);
      },
    );
  }
});

test("should patch the reviewed source summary when the catalog is already fixed", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.catalogBefore = { ...fixedCatalog };
  f.sourceSummaryBefore = { ...legacySourceSummary };
  const result = await f.run(true, f.execute);
  assert.equal(result.status, "APPLIED");
  assert.deepEqual(result.migrations, ["20261008001500-source-history-summary-validation.sql"]);
  assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 1);
});

test("should reject missing deferred receipt constraints before applying any migration", async (t) => {
  const f = await fixture(t);
  f.baseline.receiptIntegrity = false;
  await assert.rejects(f.run(true, f.execute), { code: "BASELINE_NOT_READY" });
  assert.equal(f.calls.length, 4);
  assert.equal(f.applied, false);
});

test("should reject missing actor preconditions before applying any migration", async (t) => {
  const f = await fixture(t);
  f.baseline.actorPrecondition = false;
  await assert.rejects(f.run(true, f.execute), { code: "BASELINE_NOT_READY" });
  assert.equal(f.calls.length, 4);
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
  assert.equal(f.calls.length, 5);
});

test("should keep missing post-commit evidence unconfirmed without applying again", async (t) => {
  const f = await fixture(t);
  f.after = { ...missing };
  await assert.rejects(f.run(true, f.execute), { code: "APPLY_NOT_CONFIRMED" });
  assert.equal(f.calls.length, 7);
});

test("should reject malformed database responses before any write", async (t) => {
  const f = await fixture(t);
  f.raw = JSON.stringify({ ...missing, extra: true });
  await assert.rejects(f.run(true, f.execute), { code: "UNVERIFIED_DATABASE_RESPONSE" });
  assert.equal(f.applied, false);
});

async function modifiedMigrationDriver(dir: string, name: string) {
  const scriptDir = join(dir, "scripts");
  const migrationDir = join(dir, "supabase/migrations");
  await mkdir(scriptDir);
  await mkdir(migrationDir, { recursive: true });
  await copyFile(
    resolve("scripts/apply-local-ai-settings.mjs"),
    join(scriptDir, "apply-local-ai-settings.mjs"),
  );
  for (const migration of migrationNames)
    await copyFile(resolve("supabase/migrations", migration), join(migrationDir, migration));
  await writeFile(join(migrationDir, name), "SELECT 'unreviewed input';");
  return import(pathToFileURL(join(scriptDir, "apply-local-ai-settings.mjs")).href);
}

test("should reject modified migration inputs before opening the write transaction", async (t) => {
  const f = await fixture(t);
  const driverModule = await modifiedMigrationDriver(f.dir, migrationNames[0]);
  await assert.rejects(driverModule.runLocalSettingsUpgrade(true, f.execute), {
    code: "MIGRATION_INPUT_CHANGED",
  });
  assert.equal(f.calls.length, 4);
  assert.equal(f.applied, false);
});

test("should keep the original four-feature check read only on a legacy catalog", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  assert.deepEqual(await f.run(false, f.execute), {
    status: "CHECKED",
    features: present,
    modelInputs: 0,
  });
  assert.equal(f.calls.length, 2);
  assert.equal(f.applied, false);
});

test("should block an unknown installed catalog source without writes", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.catalogBefore = { catalogAbsent: false, catalogLegacy: false, catalogFixed: false };
  await assert.rejects(f.run(true, f.execute), { code: "CATALOG_SOURCE_UNVERIFIED" });
  assert.equal(f.calls.length, 3);
  assert.equal(f.applied, false);
});

test("should block catalog source changes on a stack missing all feature markers", async (t) => {
  const f = await fixture(t);
  f.catalogBefore = { ...legacyCatalog };
  await assert.rejects(f.run(true, f.execute), { code: "CATALOG_SOURCE_UNVERIFIED" });
  assert.equal(f.applied, false);
});

test("should enforce the existing baseline before patching an installed catalog", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.baseline.actorPrecondition = false;
  await assert.rejects(f.run(true, f.execute), { code: "BASELINE_NOT_READY" });
  assert.equal(f.applied, false);
});

test("should leave patch commit or confirmation failures unconfirmed without retries", async (t) => {
  for (const stage of ["commit", "features", "catalog", "unchanged-catalog"] as const) {
    await t.test(`should withhold private diagnostics after ${stage} failure`, async (t) => {
      const f = await fixture(t);
      f.before = { ...present };
      if (stage === "commit") f.failApply = true;
      if (stage === "features") f.failFeatureConfirmation = true;
      if (stage === "catalog") f.failCatalogConfirmation = true;
      if (stage === "unchanged-catalog") f.catalogAfter = { ...legacyCatalog };
      await assert.rejects(f.run(true, f.execute), (error: Error) => {
        assert.equal(error.message, "APPLY_NOT_CONFIRMED");
        assert.equal(error.message.includes("private"), false);
        return true;
      });
      assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 1);
    });
  }
});

test("should reject modified SQL017 before either installation or patch writes", async (t) => {
  for (const installed of [false, true]) {
    await t.test(
      `should block changed SQL017 on ${installed ? "installed" : "fresh"} stack`,
      async (t) => {
        const f = await fixture(t);
        if (installed) f.before = { ...present };
        const driverModule = await modifiedMigrationDriver(f.dir, migrationNames[7]);
        await assert.rejects(driverModule.runLocalSettingsUpgrade(true, f.execute), {
          code: "MIGRATION_INPUT_CHANGED",
        });
        assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 0);
        assert.equal(f.applied, false);
      },
    );
  }
});

test("should apply only pending reviewed catalog and source summary corrections", async (t) => {
  const cases = [
    {
      name: "both legacy",
      catalog: legacyCatalog,
      source: legacySourceSummary,
      expected: [migrationNames[5], migrationNames[7]],
    },
    {
      name: "only SQL017 fixed",
      catalog: fixedCatalog,
      source: legacySourceSummary,
      expected: [migrationNames[5]],
    },
    {
      name: "only SQL015 fixed",
      catalog: legacyCatalog,
      source: fixedSourceSummary,
      expected: [migrationNames[7]],
    },
    { name: "both fixed", catalog: fixedCatalog, source: fixedSourceSummary, expected: [] },
  ];
  for (const entry of cases) {
    await t.test(`should retain exact pending corrections with ${entry.name}`, async (t) => {
      const f = await fixture(t);
      f.before = { ...present };
      f.catalogBefore = { ...entry.catalog };
      f.sourceSummaryBefore = { ...entry.source };
      const result = await f.run(true, f.execute);
      assert.deepEqual(result.features, present);
      assert.equal(result.status, entry.expected.length ? "APPLIED" : "ALREADY_PRESENT");
      assert.deepEqual(result.migrations ?? [], entry.expected);
      const writes = f.calls.filter((call) => call.input.startsWith("BEGIN;"));
      assert.equal(writes.length, entry.expected.length ? 1 : 0);
      if (writes.length) {
        assert.equal(writes[0].input.includes("create schema"), false);
        assert.equal(writes[0].input.includes("alter table"), false);
        assert.equal(
          writes[0].input.includes(
            "create or replace function runtime_settings_private.catalog_ok",
          ),
          entry.expected.includes(migrationNames[7]),
        );
        assert.equal(
          writes[0].input.includes(
            "create or replace function source_history_private.confirm_whole",
          ),
          entry.expected.includes(migrationNames[5]),
        );
      }
    });
  }
});

test("should refuse an unknown source summary function before writes", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.sourceSummaryBefore = {
    sourceSummaryAbsent: false,
    sourceSummaryLegacy: false,
    sourceSummaryFixed: false,
  };
  await assert.rejects(f.run(true, f.execute), { code: "SOURCE_SUMMARY_SOURCE_UNVERIFIED" });
  assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 0);
});

test("should reject modified SQL015 before fresh or installed correction writes", async (t) => {
  for (const installed of [false, true]) {
    await t.test(
      `should block changed SQL015 on ${installed ? "installed" : "fresh"} stack`,
      async (t) => {
        const f = await fixture(t);
        if (installed) {
          f.before = { ...present };
          f.catalogBefore = { ...fixedCatalog };
          f.sourceSummaryBefore = { ...legacySourceSummary };
        }
        const driverModule = await modifiedMigrationDriver(f.dir, migrationNames[5]);
        await assert.rejects(driverModule.runLocalSettingsUpgrade(true, f.execute), {
          code: "MIGRATION_INPUT_CHANGED",
        });
        assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 0);
      },
    );
  }
});

test("should require both functions fixed after committing either correction", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.sourceSummaryAfter = { ...legacySourceSummary };
  await assert.rejects(f.run(true, f.execute), { code: "APPLY_NOT_CONFIRMED" });
  assert.equal(f.calls.filter((call) => call.input.startsWith("BEGIN;")).length, 1);
});

test("should apply only SQL016 when catalog and source summary are already fixed", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.catalogBefore = { ...fixedCatalog };
  f.sourceSummaryBefore = { ...fixedSourceSummary };
  f.commitBindingBefore = { ...legacyCommitBinding };
  const result = await f.run(true, f.execute);
  assert.equal(result.status, "APPLIED");
  assert.deepEqual(result.features, present);
  assert.deepEqual(result.migrations, ["20261008001600-runtime-settings-binding-receipt.sql"]);
  const writes = f.calls.filter((call) => call.input.startsWith("BEGIN;"));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].input.includes("create schema"), false);
  assert.equal(writes[0].input.includes("alter table"), false);
  assert.equal(
    writes[0].input.includes("create or replace function runtime_settings_private.catalog_ok"),
    false,
  );
  assert.equal(
    writes[0].input.includes("create or replace function source_history_private.confirm_whole"),
    false,
  );
  const definition = "create or replace function runtime_settings_private.commit_binding";
  assert.ok(writes[0].input.includes(definition));
  const inspected = f.calls.find((call) => call.input.includes("'commitBindingLegacy'"))!.input;
  assert.ok(
    inspected.includes(
      "runtime_settings_private.commit_binding(device_binding_private.devices,runtime_settings_private.operations,jsonb)",
    ),
  );
  for (const check of [
    "p.prokind='f' AND p.prosecdef=true",
    "p.provolatile='v' AND NOT p.proretset",
    "p.prorettype='jsonb'::regtype",
    "p.proargnames=ARRAY['d','o','b']::text[]",
    "p.proargmodes IS NULL",
    "lanname='plpgsql'",
    `p.proconfig=ARRAY['search_path=""']::text[]`,
    "md5(p.prosrc)='0c34725047c7f1b58d36705c65470f11'",
    "md5(p.prosrc)='cecd1af840fc72e425a5b57b273bc218'",
  ])
    assert.ok(inspected.includes(check), check);
  const tx = writes[0].input;
  const precondition = tx.slice(0, tx.indexOf("$local_correction_guard$"));
  for (const hash of [
    "bbb006cfb7bc9767a4bb25fdff528096",
    "342051dce08e88ea3f9d9f7d6bc0cba6",
    "0c34725047c7f1b58d36705c65470f11",
  ])
    assert.ok(precondition.includes(hash));
  const precedingGuard = tx.slice(tx.indexOf("$local_correction_guard$"), tx.indexOf(definition));
  assert.ok(precedingGuard.includes("md5(p.prosrc)='0c34725047c7f1b58d36705c65470f11'"));
  assert.ok(precedingGuard.includes("COMMIT_BINDING_SOURCE_UNVERIFIED"));
});

for (const previous of [false, true]) {
  test(`should upgrade reviewed ${previous ? "SQL014" : "initial"} catalog directly to SQL017`, async (t) => {
    const f = await fixture(t);
    f.before = { ...present };
    f.catalogBefore = {
      catalogAbsent: false,
      catalogLegacy: !previous,
      catalogPrevious: previous,
      catalogFixed: false,
    };
    const result = await f.run(true, f.execute);
    assert.deepEqual(result.migrations, [migrationNames[7]]);
    const sql = f.calls.find((c) => c.input.startsWith("BEGIN;"))!.input;
    assert.equal(
      (sql.match(/create or replace function runtime_settings_private.catalog_ok/g) ?? []).length,
      1,
    );
    assert.ok(sql.includes("value-'displayName'"));
    assert.equal(sql.includes("alter table"), false);
    assert.equal(sql.includes("create schema"), false);
    const guard = sql.slice(
      0,
      sql.indexOf("create or replace function runtime_settings_private.catalog_ok"),
    );
    for (const hash of ["832697b9f563f43e138ecbb812538055", "e2a0c2af48bb54566c10ab0a2a6b9a0b"])
      assert.ok(guard.includes(hash));
  });
}

test("should preserve SQL017 while applying another pending correction without downgrade", async (t) => {
  const f = await fixture(t);
  f.before = { ...present };
  f.catalogBefore = { ...fixedCatalog };
  f.sourceSummaryBefore = { ...legacySourceSummary };
  const result = await f.run(true, f.execute);
  assert.deepEqual(result.migrations, [migrationNames[5]]);
  const sql = f.calls.find((c) => c.input.startsWith("BEGIN;"))!.input;
  assert.equal(
    sql.includes("create or replace function runtime_settings_private.catalog_ok"),
    false,
  );
  assert.ok(sql.includes("bbb006cfb7bc9767a4bb25fdff528096"));
});
