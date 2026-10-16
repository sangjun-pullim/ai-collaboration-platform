import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, open, unlink, symlink, writeFile, readFile, chmod, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nativeFixture } from "./claude-native-fixture.ts";
import { reviewedNativeRelease } from "../src/claude/native-runtime-cache.ts";
import {
  verifyNativeInstallation,
  assertNativeInstallation,
} from "../src/claude/native-installation.ts";

/** Sparse synthetic bytes and mocked trust checks are never actual publisher evidence. */
async function fixture(t: TestContext) {
  const f = await nativeFixture(t);
  const release = reviewedNativeRelease();
  const cached = join(
    f.home,
    "Library",
    "Application Support",
    "ai-collab",
    "runtimes",
    "claude",
    release.version,
    release.platform,
    "claude",
  );
  await mkdir(dirname(cached), { recursive: true, mode: 0o700 });
  const file = await open(cached, "wx", 0o700);
  await file.truncate(release.bytes);
  await file.close();
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  for (let left = release.bytes; left > 0; left -= chunk.length)
    hash.update(chunk.subarray(0, Math.min(left, chunk.length)));
  const syntheticHash = hash.digest("hex");
  const createHash = crypto.createHash;
  t.mock.method(crypto, "createHash", (...args: Parameters<typeof createHash>) => {
    const value = createHash(...args);
    const digest = value.digest.bind(value);
    value.digest = ((encoding?: crypto.BinaryToTextEncoding) => {
      const actual = digest("hex");
      const result = actual === syntheticHash ? release.sha256 : actual;
      return encoding ? Buffer.from(result, "hex").toString(encoding) : Buffer.from(result, "hex");
    }) as typeof value.digest;
    return value;
  });
  syncBuiltinESMExports();
  const entry = join(f.home, ".local", "bin", "claude");
  const updated = join(dirname(f.executable), "2.1.301");
  await writeFile(updated, "synthetic current version\n", { mode: 0o700 });
  await unlink(entry);
  await symlink(updated, entry);
  await unlink(f.executable);
  f.state.executable = cached;
  f.state.installationVersion = "2.1.293";
  f.state.version = "2.1.293 (Claude Code)\n";
  return { ...f, cached, entry, updated };
}

test("should admit cached reviewed runtime and remain stable across personal CLI updates", async (t) => {
  const f = await fixture(t);
  const settings = await readFile(f.settingsPath);
  const installation = await verifyNativeInstallation(f.root, {}, () => {});
  assert.equal(installation.source, "APP_CACHE");
  assert.equal(installation.executable, f.cached);
  assert.equal(installation.version, "2.1.293");
  const newer = join(dirname(f.updated), "2.1.302");
  await writeFile(newer, "synthetic later version\n", { mode: 0o700 });
  await unlink(f.entry);
  await symlink(newer, f.entry);
  assertNativeInstallation(installation, () => {});
  assert.equal(
    (await verifyNativeInstallation(f.root, {}, () => {}, installation)).executable,
    f.cached,
  );
  assert.deepEqual(await readFile(f.settingsPath), settings);
  await chmod(f.cached, 0o720);
  assert.throws(() => assertNativeInstallation(installation, () => {}));
});

test("should retain publisher and login checks when using the app cache", async (t) => {
  const f = await fixture(t);
  f.state.signature = false;
  await assert.rejects(
    verifyNativeInstallation(f.root, {}, () => {}),
    { stage: "PUBLISHER" },
  );
  f.state.signature = true;
  f.state.auth.loggedIn = false;
  await assert.rejects(
    verifyNativeInstallation(f.root, {}, () => {}),
    { stage: "LOGIN" },
  );
});

for (const fault of ["missing-binary", "symlink-parent"] as const) {
  test(`should report ${fault} as cache integrity failure before running a probe`, async (t) => {
    const f = await fixture(t);
    if (fault === "missing-binary") await unlink(f.cached);
    else {
      const parent = dirname(f.cached);
      await rename(parent, `${parent}-moved`);
      await symlink(`${parent}-moved`, parent);
    }
    await assert.rejects(
      verifyNativeInstallation(f.root, {}, () => {}),
      {
        code: "POLICY_UNCONFIRMED",
        stage: "CACHE_INTEGRITY",
      },
    );
    assert.equal(f.probes.length, 0);
  });
}
