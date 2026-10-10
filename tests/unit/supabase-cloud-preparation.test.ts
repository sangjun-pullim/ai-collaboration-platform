import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "supabase-cloud-preparation-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "supabase/migrations"), { recursive: true });
  const prepare = (await import(pathToFileURL(resolve("scripts/prepare-supabase-cloud.mjs")).href))
    .prepareSupabaseCloud;
  return { root, parent: root, prepare };
}

test("should preserve migration versions and SQL bytes in CLI-compatible filenames", async (t) => {
  const f = await fixture(t);
  const sql = "create table public.example(id uuid primary key);\n";
  await writeFile(join(f.root, "supabase/migrations/20261001000100-first.sql"), sql);
  await writeFile(join(f.root, "supabase/migrations/20261002000200_second.sql"), "select 1;\n");
  await writeFile(join(f.root, ".env.local"), "PRIVATE_TEST_MARKER");
  const result = await f.prepare(f);
  assert.equal(result.status, "PREPARED");
  assert.equal(result.modelInputs, 0);
  assert.deepEqual(await readdir(join(result.workdir, "supabase/migrations")), [
    "20261001000100_first.sql",
    "20261002000200_second.sql",
  ]);
  assert.equal(
    await readFile(join(result.workdir, "supabase/migrations/20261001000100_first.sql"), "utf8"),
    sql,
  );
  assert.equal(result.migrations[0].sha256, createHash("sha256").update(sql).digest("hex"));
  assert.equal(result.migrations[0].version, "20261001000100");
  assert.equal(
    await readFile(join(f.root, "supabase/migrations/20261001000100-first.sql"), "utf8"),
    sql,
  );
  assert.deepEqual(await readdir(result.workdir), ["migration-manifest.json", "supabase"]);
});

test("should reject duplicate migration versions before preparing a partial migration set", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "supabase/migrations/20261001000100-first.sql"), "select 1;");
  await writeFile(join(f.root, "supabase/migrations/20261001000100_second.sql"), "select 2;");
  await assert.rejects(f.prepare(f), /DUPLICATE_MIGRATION_VERSION/);
  assert.deepEqual(await readdir(f.root), ["supabase"]);
});

test("should reject invalid SQL filenames instead of silently skipping migrations", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "supabase/migrations/001-first.sql"), "select 1;");
  await assert.rejects(f.prepare(f), /INVALID_MIGRATION_NAME/);
  assert.deepEqual(await readdir(f.root), ["supabase"]);
});

test("should reject symlinked migration files and directories without copying their contents", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "private.sql"), "PRIVATE_TEST_MARKER");
  await symlink(
    join(f.root, "private.sql"),
    join(f.root, "supabase/migrations/20261001000100-first.sql"),
  );
  await assert.rejects(f.prepare(f), /UNSAFE_MIGRATION_PATH/);
  await rm(join(f.root, "supabase/migrations"), { recursive: true });
  await mkdir(join(f.root, "external"));
  await symlink(join(f.root, "external"), join(f.root, "supabase/migrations"));
  await assert.rejects(f.prepare(f), /UNSAFE_MIGRATION_PATH/);
});

test("should reject an empty migration set rather than report it as deployable", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.prepare(f), /NO_MIGRATIONS/);
});
