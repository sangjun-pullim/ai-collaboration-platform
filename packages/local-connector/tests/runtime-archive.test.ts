import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  rename,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeArchive, journalByteLimit } from "../src/runtime-archive.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { digest, RuntimeError } from "../src/runtime-contracts.ts";
import { runtimeFixture, appendFixtureCompletion, uuid } from "./runtime-fixture.ts";

function archivePath(f: Awaited<ReturnType<typeof runtimeFixture>>, hash: string) {
  return join(f.store.dir, "archives", f.scope.agentId, `${hash}.json`);
}

test("should commit archive evidence before switching the active journal", async () => {
  for (const boundary of ["file-sync", "directory-sync", "main-switch", "after-switch"] as const) {
    const f = await runtimeFixture();
    let restore: (() => void) | undefined;
    try {
      appendFixtureCompletion(f.record);
      await f.store.write(f.record);
      const before = await readFile(f.store.file);
      const hash = digest(before),
        path = archivePath(f, hash),
        directory = join(f.store.dir, "archives", f.scope.agentId);
      const probe = await open(f.store.file, "r");
      const prototype = Object.getPrototypeOf(probe) as FileHandle;
      const originalSync = prototype.sync;
      await probe.close();
      let interrupted = false,
        archiveFileSynced = false,
        archiveDirectorySynced = false;
      const replacement = mock.method(prototype, "sync", async function (this: FileHandle) {
        const stat = await this.stat();
        if (existsSync(path)) {
          const archive = await lstat(path);
          const archiveDirectory = await lstat(directory);
          if (stat.ino === archive.ino && stat.dev === archive.dev) {
            if (boundary === "file-sync" && !interrupted) {
              interrupted = true;
              throw new Error("SYNTHETIC_file-sync");
            }
            await originalSync.call(this);
            archiveFileSynced = true;
            return;
          }
          if (stat.ino === archiveDirectory.ino && stat.dev === archiveDirectory.dev) {
            assert.equal(archiveFileSynced, true);
            if (boundary === "directory-sync" && !interrupted) {
              interrupted = true;
              throw new Error("SYNTHETIC_directory-sync");
            }
            await originalSync.call(this);
            archiveDirectorySynced = true;
            return;
          }
        }
        return originalSync.call(this);
      });
      restore = () => replacement.mock.restore();
      await assert.rejects(
        f.store.compact(f.record, () => {
          if (
            (boundary === "main-switch" && archiveDirectorySynced && !interrupted) ||
            (boundary === "after-switch" &&
              archiveDirectorySynced &&
              !interrupted &&
              !readFileSync(f.store.file).equals(before))
          ) {
            interrupted = true;
            throw new Error(`SYNTHETIC_${boundary}`);
          }
        }),
        /SYNTHETIC/,
      );
      restore();
      restore = undefined;
      const disk = (await f.store.read())!;
      if (boundary === "after-switch") {
        assert.equal(disk.attempts.length, 0);
        assert.equal((await f.store.lastAttempt(disk))!.state, "UPLOADED");
      } else {
        assert.deepEqual(disk, f.record);
        // Orphan evidence cannot become completion authority until the owned main journal commits.
        assert.equal(disk.archives, undefined);
        const next = await f.store.compact(f.record);
        assert.equal(next.attempts.length, 0);
        assert.equal((await f.store.lastAttempt(next))!.state, "UPLOADED");
      }
      assert.deepEqual(await readFile(path), before);
      assert.equal((await lstat(path)).mode & 0o777, 0o600);
      assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    } finally {
      restore?.();
      await f.close();
    }
  }
});

test("should reject missing changed foreign linked or oversized archive evidence", async () => {
  for (const mutation of [
    "missing",
    "changed",
    "foreign",
    "hardlink",
    "symlink",
    "parent",
    "mode",
    "oversized",
    "utf8",
    "replacement",
    "duplicate",
    "prefix",
    "epoch",
    "pointer",
    "order",
    "parent-mode",
  ] as const) {
    const f = await runtimeFixture();
    try {
      appendFixtureCompletion(f.record);
      appendFixtureCompletion(f.record);
      await f.store.write(f.record);
      const next = await f.store.compact(f.record);
      await f.store.read(); // Re-read after validation; a prior successful read is never trusted as a cache.
      let path = archivePath(f, next.archives![0].hash);
      const original = await readFile(path);
      if (mutation === "missing") await unlink(path);
      if (mutation === "changed")
        await writeFile(path, Buffer.concat([original, Buffer.from(" ")]));
      if (mutation === "hardlink") await link(path, join(f.directory, "linked"));
      if (mutation === "symlink") {
        await rename(path, `${path}.saved`);
        await symlink(`${path}.saved`, path);
      }
      if (mutation === "parent") {
        const parent = join(f.store.dir, "archives", f.scope.agentId);
        await rename(parent, `${parent}.saved`);
        await symlink(`${parent}.saved`, parent);
      }
      if (mutation === "mode") await chmod(path, 0o644);
      if (mutation === "oversized") await writeFile(path, Buffer.alloc(journalByteLimit + 1));
      if (mutation === "replacement") {
        await rename(path, `${path}.saved`);
        await writeFile(path, "{}", { mode: 0o600 });
      }
      if (["foreign", "utf8", "prefix", "epoch"].includes(mutation)) {
        const source = JSON.parse(original.toString());
        if (mutation === "foreign") source.scope.deviceId = "00000000-0000-0000-0000-000000000000";
        if (mutation === "prefix") source.archives = next.archives;
        if (mutation === "epoch") source.scope.bindingEpoch = 2;
        const bytes =
          mutation === "utf8" ? Buffer.from([0xff]) : Buffer.from(JSON.stringify(source));
        const hash = digest(bytes);
        path = archivePath(f, hash);
        await writeFile(path, bytes, { mode: 0o600 });
        next.archives![0].hash = hash;
        next.lastArchive!.hash = hash;
      }
      if (mutation === "duplicate")
        next.archives![0].requestIds.push(next.archives![0].requestIds[0]);
      if (mutation === "order") next.archives![0].requestIds.reverse();
      if (mutation === "parent-mode") await chmod(join(f.store.dir, "archives"), 0o755);
      if (mutation === "pointer")
        next.lastArchive!.attemptId = "00000000-0000-0000-0000-000000000000";
      await writeFile(f.store.file, JSON.stringify(next));
      await assert.rejects(f.store.read(), { code: "UNSAFE_STORAGE" }, mutation);
    } finally {
      await f.close();
    }
  }
});

test("should retain archive evidence through explicit local removal without adopting it as a new agent", async () => {
  const f = await runtimeFixture();
  try {
    appendFixtureCompletion(f.record);
    await f.store.write(f.record);
    const before = await readFile(f.store.file);
    const next = await f.store.compact(f.record);
    await f.store.remove();
    assert.equal(await f.store.read(), undefined);
    assert.deepEqual(await RuntimeStore.agents(f.stateDir, "one"), []);
    assert.deepEqual(await readFile(archivePath(f, next.archives![0].hash)), before);
    assert.deepEqual(
      await new RuntimeArchive(f.store.dir, f.scope.agentId).read(next.archives![0].hash),
      before,
    );
    const clean = { ...f.record, attempts: [], operations: [] };
    await f.store.write(clean);
    assert.equal((await f.store.read())!.archives, undefined);
  } finally {
    await f.close();
  }
});

test("should reject archive metadata beyond the reference or request bounds before reading evidence", async () => {
  const f = await runtimeFixture();
  try {
    const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
    const references = Array.from({ length: 65 }, (_, index) => ({
      hash: digest(String(index)),
      requestIds: [uuid()],
    }));
    await assert.rejects(archive.verify(references), { code: "UNSAFE_STORAGE" });
    const requests = [
      { hash: digest("too-many-requests"), requestIds: Array.from({ length: 4097 }, () => uuid()) },
    ];
    await assert.rejects(archive.verify(requests), { code: "UNSAFE_STORAGE" });
    assert.equal(existsSync(archive.dir), false);
  } finally {
    await f.close();
  }
});

async function trackArchiveHandles(paths: string[], pendingPaths: string[] = []) {
  const identities = await Promise.all(paths.map((path) => lstat(path)));
  const probe = await open(paths[0], "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalStat = prototype.stat;
  const originalRead = prototype.read;
  await probe.close();
  const handles = new Set<FileHandle>();
  const closed = new Set<FileHandle>();
  const closeRestores: (() => void)[] = [];
  let closeFailure = false;
  let duringRead: ((handle: FileHandle) => void) | undefined;
  const statMock = mock.method(prototype, "stat", async function (this: FileHandle) {
    const stat = await originalStat.call(this);
    const currentIdentities = [...identities];
    for (const path of pendingPaths) {
      try {
        currentIdentities.push(await lstat(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      currentIdentities.some((file) => file.dev === stat.dev && file.ino === stat.ino) &&
      !handles.has(this)
    ) {
      handles.add(this);
      const originalClose = this.close;
      const closeMock = mock.method(this, "close", async function (this: FileHandle) {
        closed.add(this);
        await originalClose.call(this);
        if (closeFailure) {
          closeFailure = false;
          throw new Error("SYNTHETIC_CLOSE");
        }
      });
      closeRestores.push(() => closeMock.mock.restore());
    }
    return stat;
  });
  const readMock = mock.method(
    prototype,
    "read",
    async function (this: FileHandle, ...args: Parameters<FileHandle["read"]>) {
      const result = await originalRead.apply(this, args);
      if (handles.has(this)) duringRead?.(this);
      return result;
    },
  );
  return {
    handles,
    closed,
    failClose: () => {
      closeFailure = true;
    },
    onRead: (run: (handle: FileHandle) => void) => {
      duringRead = run;
    },
    restore: () => {
      readMock.mock.restore();
      statMock.mock.restore();
      closeRestores.forEach((restore) => restore());
    },
  };
}

test("should close all owned archive handles after scoped validation failures", async () => {
  for (const boundary of [
    "success",
    "batch",
    "callback",
    "guard",
    "read-guard",
    "read-io",
    "close",
    "callback-close",
    "guard-close",
  ] as const) {
    const f = await runtimeFixture();
    let tracking: Awaited<ReturnType<typeof trackArchiveHandles>> | undefined;
    try {
      const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
      const hashes = [
        await archive.save(Buffer.from('"first"')),
        await archive.save(Buffer.from('"second"')),
      ];
      const paths = hashes.map((hash) => archivePath(f, hash));
      const refs = hashes.map((hash) => ({ hash, requestIds: [uuid()] }));
      tracking = await trackArchiveHandles(paths);
      if (boundary === "batch") await unlink(paths[1]);
      if (boundary.includes("close")) tracking.failClose();
      const sentinel = new Error(`SYNTHETIC_${boundary}`);
      if (boundary === "read-io")
        tracking.onRead(() => {
          if (tracking!.handles.size === 2) throw sentinel;
        });
      let callbackRan = false;
      const work = archive.withVerifiedContents(
        refs,
        (contents) => {
          callbackRan = true;
          assert.equal(Object.isFrozen(contents), true);
          assert.deepEqual(contents, ['"first"', '"second"']);
          if (boundary.startsWith("callback")) throw sentinel;
          return "serialized";
        },
        () => {
          if (
            (boundary.startsWith("guard") && callbackRan) ||
            (boundary === "read-guard" && tracking!.handles.size === 2)
          )
            throw sentinel;
        },
      );
      if (boundary === "success") assert.equal(await work, "serialized");
      else if (boundary === "batch" || boundary === "close" || boundary === "read-io")
        await assert.rejects(work, { code: "UNSAFE_STORAGE" });
      else await assert.rejects(work, (error) => error === sentinel);
      assert.equal(tracking.handles.size, boundary === "batch" ? 1 : 2);
      assert.deepEqual(tracking.closed, tracking.handles);
      for (const handle of tracking.handles) await assert.rejects(handle.stat(), { code: "EBADF" });
      if (boundary === "batch" || boundary === "read-guard" || boundary === "read-io")
        assert.equal(callbackRan, false);
    } finally {
      tracking?.restore();
      await f.close();
    }
  }
});

test("should revalidate earlier held archives before invoking a scoped callback", async () => {
  const f = await runtimeFixture();
  let tracking: Awaited<ReturnType<typeof trackArchiveHandles>> | undefined;
  try {
    const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
    const hashes = [
      await archive.save(Buffer.from('"first"')),
      await archive.save(Buffer.from('"second"')),
    ];
    const paths = hashes.map((hash) => archivePath(f, hash));
    tracking = await trackArchiveHandles(paths);
    let changed = false,
      callbackRan = false;
    tracking.onRead(() => {
      if (tracking!.handles.size === 2 && !changed) {
        changed = true;
        writeFileSync(paths[0], '"other"');
      }
    });
    await assert.rejects(
      archive.withVerifiedContents(
        hashes.map((hash) => ({ hash, requestIds: [uuid()] })),
        () => {
          callbackRan = true;
          return "serialized";
        },
      ),
      { code: "UNSAFE_STORAGE" },
    );
    assert.equal(changed, true);
    assert.equal(callbackRan, false);
    assert.deepEqual(tracking.closed, tracking.handles);
  } finally {
    tracking?.restore();
    await f.close();
  }
});

test("should preserve archive read bytes and scoped UTF8 BOM decoding", async () => {
  const f = await runtimeFixture();
  try {
    const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('"한글"')]);
    const hash = await archive.save(bytes);
    assert.deepEqual(await archive.read(hash), bytes);
    assert.equal(
      await archive.withVerifiedContents([{ hash, requestIds: [uuid()] }], (contents) => {
        assert.deepEqual(contents, ['"한글"']);
        return JSON.stringify(JSON.parse(contents[0]));
      }),
      '"한글"',
    );
  } finally {
    await f.close();
  }
});

test("should reject asynchronous scoped results without retaining archive handles", async () => {
  const f = await runtimeFixture();
  let tracking: Awaited<ReturnType<typeof trackArchiveHandles>> | undefined;
  try {
    const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
    const hash = await archive.save(Buffer.from('"first"'));
    tracking = await trackArchiveHandles([archivePath(f, hash)]);
    const asyncResult = (() => Promise.resolve("serialized")) as unknown as (
      contents: readonly string[],
    ) => string;
    await assert.rejects(
      archive.withVerifiedContents([{ hash, requestIds: [uuid()] }], asyncResult),
      { code: "UNSAFE_STORAGE" },
    );
    assert.equal(tracking.handles.size, 1);
    assert.deepEqual(tracking.closed, tracking.handles);
  } finally {
    tracking?.restore();
    await f.close();
  }
});

for (const route of ["read", "verify", "save-existing", "save-new"] as const) {
  for (const failure of [
    "plain-guard",
    "runtime-guard",
    "runtime-guard-close",
    "success-close",
  ] as const) {
    test(`should preserve public archive ${route} error semantics for ${failure}`, async () => {
      const f = await runtimeFixture();
      let tracking: Awaited<ReturnType<typeof trackArchiveHandles>> | undefined;
      try {
        const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
        const bytes = Buffer.from('"public read guard evidence"');
        const hash = digest(bytes);
        const path = archivePath(f, hash);
        if (route === "save-new") {
          const seed = await archive.save(Buffer.from('"seed"'));
          tracking = await trackArchiveHandles([archivePath(f, seed)], [path]);
        } else {
          await archive.save(bytes);
          tracking = await trackArchiveHandles([path]);
        }
        const primary =
          failure === "plain-guard" ? new Error("SYNTHETIC_GUARD") : new RuntimeError("UNKNOWN");
        if (failure.endsWith("close")) tracking.failClose();
        let payloadRead = false,
          guardThrown = false;
        tracking.onRead(() => {
          payloadRead = true;
        });
        const check = () => {
          // save also checks directory/fsync: inject only after its actual payload read.
          if (payloadRead && failure !== "success-close") {
            guardThrown = true;
            throw primary;
          }
        };
        const work =
          route === "read"
            ? archive.read(hash, check)
            : route === "verify"
              ? archive.verify([{ hash, requestIds: [uuid()] }], check)
              : archive.save(bytes, check);
        if (failure === "runtime-guard") await assert.rejects(work, (error) => error === primary);
        else await assert.rejects(work, { code: "UNSAFE_STORAGE" });
        assert.equal(payloadRead, true);
        assert.equal(guardThrown, failure !== "success-close");
        assert.equal(tracking.handles.size, 1);
        assert.deepEqual(tracking.closed, tracking.handles);
        for (const handle of tracking.handles)
          await assert.rejects(handle.stat(), { code: "EBADF" });
      } finally {
        tracking?.restore();
        await f.close();
      }
    });
  }
}

test("should preserve scoped guard identity when failed reads or validation also fail to close", async () => {
  for (const boundary of ["read", "validation"] as const) {
    for (const kind of ["plain", "runtime"] as const) {
      const f = await runtimeFixture();
      let tracking: Awaited<ReturnType<typeof trackArchiveHandles>> | undefined;
      try {
        const archive = new RuntimeArchive(f.store.dir, f.scope.agentId);
        const hashes = [
          await archive.save(Buffer.from('"first"')),
          await archive.save(Buffer.from('"second"')),
        ];
        tracking = await trackArchiveHandles(hashes.map((hash) => archivePath(f, hash)));
        tracking.failClose();
        let payloadRead = false,
          callbackRan = false;
        const primary =
          kind === "plain" ? new Error("SYNTHETIC_GUARD") : new RuntimeError("UNKNOWN");
        tracking.onRead(() => {
          payloadRead = true;
        });
        await assert.rejects(
          archive.withVerifiedContents(
            hashes.map((hash) => ({ hash, requestIds: [uuid()] })),
            () => {
              callbackRan = true;
              return "serialized";
            },
            () => {
              if (
                (boundary === "read" && payloadRead) ||
                (boundary === "validation" && callbackRan)
              )
                throw primary;
            },
          ),
          (error) => error === primary,
        );
        assert.equal(tracking.handles.size, boundary === "read" ? 1 : 2);
        assert.equal(callbackRan, boundary === "validation");
        assert.deepEqual(tracking.closed, tracking.handles);
        for (const handle of tracking.handles)
          await assert.rejects(handle.stat(), { code: "EBADF" });
      } finally {
        tracking?.restore();
        await f.close();
      }
    }
  }
});
