import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, open, readFile, rename, symlink, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeArchive, journalByteLimit } from "../src/runtime-archive.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { digest } from "../src/runtime-contracts.ts";
import { runtimeFixture, appendFixtureCompletion, uuid } from "./runtime-fixture.ts";

function archivePath(f: Awaited<ReturnType<typeof runtimeFixture>>, hash: string) {
  return join(f.store.dir, "archives", f.scope.agentId, `${hash}.json`);
}

test("should commit archive evidence before switching the active journal", async () => {
  for (const boundary of ["file-sync", "directory-sync", "main-switch", "after-switch"] as const) {
    const f = await runtimeFixture();
    let restore: (() => void) | undefined;
    try {
      appendFixtureCompletion(f.record); await f.store.write(f.record);
      const before = await readFile(f.store.file);
      const hash = digest(before), path = archivePath(f, hash), directory = join(f.store.dir, "archives", f.scope.agentId);
      const probe = await open(f.store.file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalSync = prototype.sync;
      await probe.close();
      let interrupted = false, archiveFileSynced = false, archiveDirectorySynced = false;
      const replacement = mock.method(prototype, "sync", async function (this: FileHandle) {
        const stat = await this.stat();
        if (existsSync(path)) {
          const archive = await lstat(path);
          const archiveDirectory = await lstat(directory);
          if (stat.ino === archive.ino && stat.dev === archive.dev) {
            if (boundary === "file-sync" && !interrupted) { interrupted = true; throw new Error("SYNTHETIC_file-sync"); }
            await originalSync.call(this); archiveFileSynced = true; return;
          }
          if (stat.ino === archiveDirectory.ino && stat.dev === archiveDirectory.dev) {
            assert.equal(archiveFileSynced, true);
            if (boundary === "directory-sync" && !interrupted) { interrupted = true; throw new Error("SYNTHETIC_directory-sync"); }
            await originalSync.call(this); archiveDirectorySynced = true; return;
          }
        }
        return originalSync.call(this);
      });
      restore = () => replacement.mock.restore();
      await assert.rejects(f.store.compact(f.record, () => {
        if (boundary === "main-switch" && archiveDirectorySynced && !interrupted ||
            boundary === "after-switch" && archiveDirectorySynced && !interrupted && !readFileSync(f.store.file).equals(before)) {
          interrupted = true; throw new Error(`SYNTHETIC_${boundary}`);
        }
      }), /SYNTHETIC/);
      restore(); restore = undefined;
      const disk = (await f.store.read())!;
      if (boundary === "after-switch") {
        assert.equal(disk.attempts.length, 0); assert.equal((await f.store.lastAttempt(disk))!.state, "UPLOADED");
      } else {
        assert.deepEqual(disk, f.record);
        // Orphan evidence cannot become completion authority until the owned main journal commits.
        assert.equal(disk.archives, undefined);
        const next = await f.store.compact(f.record);
        assert.equal(next.attempts.length, 0); assert.equal((await f.store.lastAttempt(next))!.state, "UPLOADED");
      }
      assert.deepEqual(await readFile(path), before);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    } finally { restore?.(); await f.close(); }
  }
});

test("should reject missing changed foreign linked or oversized archive evidence", async () => {
  for (const mutation of ["missing", "changed", "foreign", "hardlink", "symlink", "parent", "mode", "oversized", "utf8", "replacement", "duplicate", "prefix", "epoch", "pointer", "order", "parent-mode"] as const) {
    const f = await runtimeFixture();
    try {
      appendFixtureCompletion(f.record); appendFixtureCompletion(f.record); await f.store.write(f.record);
      const next = await f.store.compact(f.record);
      await f.store.read(); // Re-read after validation; a prior successful read is never trusted as a cache.
      let path = archivePath(f, next.archives![0].hash);
      const original = await readFile(path);
      if (mutation === "missing") await unlink(path);
      if (mutation === "changed") await writeFile(path, Buffer.concat([original, Buffer.from(" ")]));
      if (mutation === "hardlink") await link(path, join(f.directory, "linked"));
      if (mutation === "symlink") { await rename(path, `${path}.saved`); await symlink(`${path}.saved`, path); }
      if (mutation === "parent") { const parent = join(f.store.dir, "archives", f.scope.agentId); await rename(parent, `${parent}.saved`); await symlink(`${parent}.saved`, parent); }
      if (mutation === "mode") await chmod(path, 0o644);
      if (mutation === "oversized") await writeFile(path, Buffer.alloc(journalByteLimit + 1));
      if (mutation === "replacement") { await rename(path, `${path}.saved`); await writeFile(path, "{}", { mode: 0o600 }); }
      if (["foreign", "utf8", "prefix", "epoch"].includes(mutation)) {
        const source = JSON.parse(original.toString());
        if (mutation === "foreign") source.scope.deviceId = "00000000-0000-0000-0000-000000000000";
        if (mutation === "prefix") source.archives = next.archives;
        if (mutation === "epoch") source.scope.bindingEpoch = 2;
        const bytes = mutation === "utf8" ? Buffer.from([0xff]) : Buffer.from(JSON.stringify(source));
        const hash = digest(bytes); path = archivePath(f, hash);
        await writeFile(path, bytes, { mode: 0o600 });
        next.archives![0].hash = hash; next.lastArchive!.hash = hash;
      }
      if (mutation === "duplicate") next.archives![0].requestIds.push(next.archives![0].requestIds[0]);
      if (mutation === "order") next.archives![0].requestIds.reverse();
      if (mutation === "parent-mode") await chmod(join(f.store.dir, "archives"), 0o755);
      if (mutation === "pointer") next.lastArchive!.attemptId = "00000000-0000-0000-0000-000000000000";
      await writeFile(f.store.file, JSON.stringify(next));
      await assert.rejects(f.store.read(), { code: "UNSAFE_STORAGE" }, mutation);
    } finally { await f.close(); }
  }
});

test("should retain archive evidence through explicit local removal without adopting it as a new agent", async () => {
  const f = await runtimeFixture();
  try {
    appendFixtureCompletion(f.record); await f.store.write(f.record);
    const before = await readFile(f.store.file);
    const next = await f.store.compact(f.record);
    await f.store.remove();
    assert.equal(await f.store.read(), undefined);
    assert.deepEqual(await RuntimeStore.agents(f.stateDir, "one"), []);
    assert.deepEqual(await readFile(archivePath(f, next.archives![0].hash)), before);
    assert.deepEqual(await new RuntimeArchive(f.store.dir, f.scope.agentId).read(next.archives![0].hash), before);
    const clean = { ...f.record, attempts: [], operations: [] };
    await f.store.write(clean);
    assert.equal((await f.store.read())!.archives, undefined);
  } finally { await f.close(); }
});

test("should reject archive metadata beyond the reference or request bounds before reading evidence", async () => {
  const f = await runtimeFixture();
  try {
    const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
    const references = Array.from({ length: 65 }, (_, index) => ({ hash: digest(String(index)), requestIds: [uuid()] }));
    await assert.rejects(archive.verify(references), { code: "UNSAFE_STORAGE" });
    const requests = [{ hash: digest("too-many-requests"), requestIds: Array.from({ length: 4097 }, () => uuid()) }];
    await assert.rejects(archive.verify(requests), { code: "UNSAFE_STORAGE" });
    assert.equal(existsSync(archive.dir), false);
  } finally { await f.close(); }
});
