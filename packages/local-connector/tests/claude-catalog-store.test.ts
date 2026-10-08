import test from "node:test";
import assert from "node:assert/strict";
import { fsyncSync, fstatSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProviderAdapter } from "../src/provider-adapter.ts";
import { FakeProvider } from "./fake-provider.ts";
import { digest } from "../src/runtime-contracts.ts";
import { ClaudeCatalogStore } from "../src/claude/catalog-store.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";
import { policyFixture } from "./claude-policy-fixture.ts";
import { uuid } from "./runtime-fixture.ts";

test("should durably reserve the exact root version fingerprint and session before admission", async () => {
  const f = await policyFixture();
  const events: string[] = [];
  const syncedDirectories: number[] = [];
  try {
    await f.admit();
    const store = new ClaudeCatalogStore(f.profile, {
      file(fd) {
        fsyncSync(fd);
        events.push("file");
      },
      directory(fd) {
        fsyncSync(fd);
        syncedDirectories.push(fstatSync(fd).ino);
        events.push("directory");
      },
    });
    const lease = store.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
    assert.deepEqual(events, ["directory", "file", "directory", "file", "directory"]);
    assert.deepEqual(syncedDirectories, [
      (await lstat(f.profile.dir)).ino,
      (await lstat(store.directory)).ino,
      (await lstat(f.profile.dir)).ino,
    ]);
    const ledger = JSON.parse(await readFile(store.file, "utf8"));
    assert.equal(ledger.status, "RESERVED");
    assert.deepEqual(ledger.context, lease.context);
    assert.equal(ledger.context.materialization.version, f.policy.version);
    assert.equal(ledger.context.materialization.policyFingerprint, f.policy.fingerprint);
    assert.equal((await lstat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(store.file)).mode & 0o777, 0o600);
    store.assertStartup(lease);
    assert.throws(() => new ClaudeCatalogStore(f.profile).assertStartup(), {
      code: "CLEANUP_INCOMPLETE",
    });
    store.finish(lease, { reaped: true, code: "REAPED" });
    new ClaudeCatalogStore(f.profile).assertStartup();
  } finally {
    await f.close();
  }
});
test("should preserve the profile barrier after catalog directory rename or replacement", async () => {
  for (const replacement of [false, true]) {
    const f = await policyFixture();
    let children = 0;
    const adapter = createProviderAdapter("codex", {
      profile: f.profile,
      codex: {
        transportFactory() {
          children++;
          return new FakeProvider();
        },
      },
    });
    try {
      await f.admit();
      const store = new ClaudeCatalogStore(f.profile);
      const lease = store.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
      store.finish(lease, { reaped: false, code: "CLEANUP_INCOMPLETE" });
      const anchor = join(f.profile.dir, `${f.profile.profile}.claude-catalog.identity.json`);
      const preserved = await readFile(anchor);
      await rename(store.directory, store.directory + ".moved");
      if (replacement) {
        await mkdir(store.directory, { mode: 0o700 });
        const foreign = new ClaudeCatalogStore({ dir: f.profile.dir, profile: "other" });
        const closed = foreign.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
        foreign.finish(closed, { reaped: true, code: "REAPED" });
        const value = JSON.parse(await readFile(foreign.file, "utf8"));
        value.profile = f.profile.profile;
        await writeFile(store.file, JSON.stringify(value), { mode: 0o600 });
      }
      assert.throws(() => new ClaudeCatalogStore(f.profile).assertStartup(), {
        code: "UNSAFE_STORAGE",
      });
      assert.throws(
        () =>
          new ClaudeCatalogStore(f.profile).reserve(
            f.context.root,
            f.policy.version,
            "b".repeat(64),
          ),
        { code: "UNSAFE_STORAGE" },
      );
      await assert.rejects(
        adapter.capabilities(f.root, () => {}),
        { code: "UNSAFE_STORAGE" },
      );
      assert.equal(children, 0);
      assert.deepEqual(await readFile(anchor), preserved);
    } finally {
      await adapter.close();
      await f.close();
    }
  }
});
test("should preserve a barrier after file or directory sync failure", async () => {
  for (const failure of ["file", "directory"] as const) {
    const f = await policyFixture();
    try {
      await f.admit();
      let directories = 0;
      const store = new ClaudeCatalogStore(f.profile, {
        file(fd) {
          if (failure === "file") throw new Error("synthetic sync failure");
          fsyncSync(fd);
        },
        directory(fd) {
          directories++;
          if (failure === "directory" && directories === 2)
            throw new Error("synthetic sync failure");
          fsyncSync(fd);
        },
      });
      assert.throws(
        () => store.reserve(f.context.root, f.policy.version, f.policy.fingerprint),
        /synthetic sync failure/,
      );
      assert.throws(() => new ClaudeCatalogStore(f.profile).assertStartup());
      assert.throws(() =>
        new ClaudeCatalogStore(f.profile).reserve(
          f.context.root,
          f.policy.version,
          f.policy.fingerprint,
        ),
      );
    } finally {
      await f.close();
    }
  }
});
test("should reject foreign reservations unsafe links and file rename without clearing the barrier", async () => {
  for (const change of [
    "token",
    "context",
    "link",
    "rename",
    "mode",
    "profile",
    "replacement",
  ] as const) {
    const f = await policyFixture();
    try {
      await f.admit();
      const store = new ClaudeCatalogStore(f.profile),
        lease = store.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
      if (change === "token")
        assert.throws(() => store.assertStartup({ ...lease, token: uuid() }), {
          code: "CLEANUP_INCOMPLETE",
        });
      if (change === "context")
        assert.throws(
          () =>
            store.assertStartup({ ...lease, context: { ...lease.context, generation: uuid() } }),
          { code: "CLEANUP_INCOMPLETE" },
        );
      if (change === "link") {
        await rename(store.file, store.file + ".old");
        await symlink(store.file + ".old", store.file);
      }
      if (change === "rename") await rename(store.file, store.file + ".old");
      if (change === "replacement") {
        const value = JSON.parse(await readFile(store.file, "utf8"));
        value.status = "CLOSED";
        await rename(store.file, store.file + ".old");
        await writeFile(store.file, JSON.stringify(value), { mode: 0o600 });
      }
      if (change === "mode") await chmod(store.file, 0o644);
      if (change === "profile") {
        const value = JSON.parse(await readFile(store.file, "utf8"));
        value.profile = "foreign";
        await writeFile(store.file, JSON.stringify(value), { mode: 0o600 });
      }
      if (["link", "rename", "mode", "profile", "replacement"].includes(change))
        assert.throws(() => new ClaudeCatalogStore(f.profile).assertStartup(), {
          code: "UNSAFE_STORAGE",
        });
    } finally {
      await f.close();
    }
  }
});
test("should preserve UNKNOWN and refuse automatic new reservations after incomplete cleanup", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    const store = new ClaudeCatalogStore(f.profile),
      lease = store.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
    store.finish(lease, { reaped: false, code: "CLEANUP_INCOMPLETE" });
    const before = await readFile(store.file);
    for (const fingerprint of [f.policy.fingerprint, "b".repeat(64)]) {
      assert.throws(
        () =>
          new ClaudeCatalogStore(f.profile).reserve(f.context.root, f.policy.version, fingerprint),
        { code: "CLEANUP_INCOMPLETE" },
      );
    }
    assert.throws(() => store.assertStartup(lease), { code: "CLEANUP_INCOMPLETE" });
    assert.deepEqual(await readFile(store.file), before);
  } finally {
    await f.close();
  }
});
test("should serialize same-profile catalog and settings commands without treating dead locks as cleanup", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    const settings = new SettingsStore(f.profile),
      catalog = new ClaudeCatalogStore(f.profile);
    await withSettingsDeviceLock(f.profile, "runtime-capabilities", async () => {
      const lease = catalog.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
      await assert.rejects(
        settings.locked(async () => {}),
        { code: "RUNTIME_BUSY" },
      );
      catalog.finish(lease, { reaped: false, code: "CLEANUP_INCOMPLETE" });
    });
    await writeFile(
      settings.lockPath,
      JSON.stringify({ pid: 2147483647, token: uuid(), identity: digest(settings.file) }),
      {
        mode: 0o600,
      },
    );
    await settings.locked(async () => {
      assert.throws(() => new ClaudeCatalogStore(f.profile).assertStartup(), {
        code: "CLEANUP_INCOMPLETE",
      });
    });
    await assert.rejects(lstat(settings.lockPath), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(catalog.file, "utf8")).status, "UNKNOWN");
  } finally {
    await f.close();
  }
});
