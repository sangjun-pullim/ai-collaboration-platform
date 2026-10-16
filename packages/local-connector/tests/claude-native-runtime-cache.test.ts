import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  readFile,
  readdir,
  mkdir,
  writeFile,
  chmod,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { RuntimeError } from "../src/runtime-contracts.ts";
import {
  ensureNativeRuntime,
  inspectCachedNativeRuntime,
  type NativeRuntimeRelease,
} from "../src/claude/native-runtime-cache.ts";

async function fixture(t: TestContext) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "native-cache-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bytes = Buffer.from("synthetic signed binary; never execute\n");
  const release: NativeRuntimeRelease = Object.freeze({
    version: "2.1.293",
    platform: "darwin-arm64",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const parent = join(
    home,
    "Library",
    "Application Support",
    "ai-collab",
    "runtimes",
    "claude",
    release.version,
  );
  const target = join(parent, release.platform, "claude");
  let downloads = 0,
    signatures = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    downloads++;
    assert.equal(
      url,
      "https://downloads.claude.ai/claude-code-releases/2.1.293/darwin-arm64/claude",
    );
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
  });
  const signature = async (path: string) => {
    signatures++;
    assert.deepEqual(await readFile(path), bytes);
  };
  const prepare = (check = () => {}) => ensureNativeRuntime(home, release, check, signature);
  return {
    home,
    bytes,
    release,
    parent,
    target,
    prepare,
    signature,
    counts: () => ({ downloads, signatures }),
  };
}

test("should publish verified runtime and reuse it without another download", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.prepare(), f.target);
  const initial = inspectCachedNativeRuntime(f.home, f.release);
  assert.equal(await f.prepare(), f.target);
  assert.deepEqual(inspectCachedNativeRuntime(f.home, f.release, initial.binary), initial);
  assert.deepEqual(f.counts(), { downloads: 1, signatures: 1 });
  assert.deepEqual(await readdir(f.parent), [f.release.platform]);
});

for (const fault of ["short", "long", "hash", "header", "status", "redirect", "network"] as const) {
  test(`should reject ${fault} download without executing or publishing it`, async (t) => {
    const f = await fixture(t);
    t.mock.method(globalThis, "fetch", async () => {
      if (fault === "network") throw new Error("private network details must not escape");
      const bytes =
        fault === "short"
          ? f.bytes.subarray(1)
          : fault === "long"
            ? Buffer.concat([f.bytes, Buffer.from("x")])
            : fault === "hash"
              ? Buffer.alloc(f.bytes.length)
              : f.bytes;
      const response = new Response(bytes, {
        status: fault === "status" ? 503 : 200,
        headers: fault === "header" ? { "content-length": "999" } : {},
      });
      if (fault === "redirect") Object.defineProperty(response, "redirected", { value: true });
      return response;
    });
    await assert.rejects(f.prepare(), { code: "POLICY_UNCONFIRMED" });
    assert.equal(f.counts().signatures, 0);
    assert.deepEqual(await readdir(f.parent), []);
  });
}

test("should clean only its own candidate on publisher rejection", async (t) => {
  const f = await fixture(t);
  await mkdir(f.parent, { recursive: true, mode: 0o700 });
  await mkdir(join(f.parent, ".preparing-other"), { mode: 0o700 });
  await assert.rejects(
    ensureNativeRuntime(
      f.home,
      f.release,
      () => {},
      async () => {
        throw new RuntimeError("POLICY_UNCONFIRMED");
      },
    ),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.deepEqual(await readdir(f.parent), [".preparing-other"]);
});

test("should converge concurrent preparations without replacing the winner", async (t) => {
  const f = await fixture(t);
  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const verify = async (path: string) => {
    await f.signature(path);
    if (++entered === 2) release();
    await barrier;
  };
  const results = await Promise.all(
    [1, 2].map(() => ensureNativeRuntime(f.home, f.release, () => {}, verify)),
  );
  assert.deepEqual(results, [f.target, f.target]);
  assert.deepEqual(await readdir(f.parent), [f.release.platform]);
  assert.deepEqual(await readFile(f.target), f.bytes);
});

for (const fault of ["symlink", "hardlink", "writable", "damaged", "empty-directory"] as const) {
  test(`should preserve and reject an existing ${fault} cache`, async (t) => {
    const f = await fixture(t);
    await f.prepare();
    if (fault === "symlink") {
      await rm(f.target);
      await writeFile(join(f.home, "other"), f.bytes);
      await symlink(join(f.home, "other"), f.target);
    }
    if (fault === "hardlink") await link(f.target, join(f.home, "other"));
    if (fault === "writable") await chmod(f.target, 0o720);
    if (fault === "damaged") await writeFile(f.target, Buffer.alloc(f.bytes.length));
    if (fault === "empty-directory") await rm(f.target);
    const before = await readdir(dirname(f.target));
    await assert.rejects(f.prepare());
    assert.deepEqual(await readdir(dirname(f.target)), before);
    assert.equal(f.counts().downloads, 1);
  });
}

for (const reason of ["cancel", "idle"] as const) {
  test(`should stop ${reason} during a stalled download and remove its candidate`, async (t) => {
    const f = await fixture(t);
    t.mock.timers.enable({ apis: ["setInterval", "Date"] });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start() {
              started();
            },
          }),
        ),
    );
    let cancelled = false;
    const operation = f.prepare(() => {
      if (cancelled) throw new RuntimeError("RUNTIME_CLOSED");
    });
    const rejection = assert.rejects(operation, {
      code: reason === "cancel" ? "RUNTIME_CLOSED" : "POLICY_UNCONFIRMED",
    });
    await ready;
    cancelled = reason === "cancel";
    t.mock.timers.tick(reason === "cancel" ? 1000 : 15_000);
    await rejection;
    assert.deepEqual(await readdir(f.parent), []);
  });
}

test("should detect replacement of an admitted cached binary", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const prior = inspectCachedNativeRuntime(f.home, f.release).binary;
  await writeFile(f.target, Buffer.alloc(f.bytes.length));
  assert.throws(() => inspectCachedNativeRuntime(f.home, f.release, prior), {
    code: "POLICY_UNCONFIRMED",
  });
});

test("should bound total download time even while bytes keep arriving", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            ready();
          },
        }),
      ),
  );
  const operation = f.prepare();
  const rejection = assert.rejects(operation, { code: "POLICY_UNCONFIRMED" });
  await started;
  for (let second = 0; second < 120; second += 10) {
    stream.enqueue(Buffer.from("x"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10_000);
  }
  await rejection;
  assert.equal(f.counts().signatures, 0);
  assert.deepEqual(await readdir(f.parent), []);
});

test("should reject foreign-owned cache ancestry without another download", async (t) => {
  const f = await fixture(t);
  await f.prepare();
  const uid = process.getuid!();
  t.mock.method(process, "getuid", () => uid + 1);
  await assert.rejects(f.prepare(), { code: "POLICY_UNCONFIRMED" });
  assert.equal(f.counts().downloads, 1);
});
