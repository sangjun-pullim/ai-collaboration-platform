import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RepositoryReader } from "../src/workspace/repository-reader.ts";
import { captureDirectory, readSafeFile } from "../src/workspace/safe-file-reader.ts";
import { publicText, RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import { digest, RuntimeError } from "../src/runtime-contracts.ts";

async function fixture(check = () => {}, now?: () => number) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "owned-repository-reader-"));
  const identity = await RuntimeFilePolicy.root(root);
  return {
    root,
    identity,
    reader: new RepositoryReader(identity, check, now),
    close: () => rm(root, { recursive: true, force: true }),
    async file(path: string, content: string | Buffer) {
      const parts = path.split("/");
      parts.pop();
      if (parts.length) await mkdir(join(root, ...parts), { recursive: true });
      await writeFile(join(root, path), content, { mode: 0o644 });
    },
  };
}
async function coldRead(root: string, path: string) {
  const readerUrl = new URL("../src/workspace/repository-reader.js", import.meta.url).href;
  const policyUrl = new URL("../src/runtime-file-policy.js", import.meta.url).href;
  const program = [
    `import { RepositoryReader } from ${JSON.stringify(readerUrl)};`,
    `import { RuntimeFilePolicy } from ${JSON.stringify(policyUrl)};`,
    "const root = await RuntimeFilePolicy.root(process.argv[1]);",
    "try { console.log(JSON.stringify(await new RepositoryReader(root, () => {}).read({path:process.argv[2]}))); }",
    "catch (error) { console.error(error.code); process.exitCode = 1; }",
  ].join("\n");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", program, root, path],
    { env: {}, timeout: 10000, killSignal: "SIGKILL" },
  );
  return JSON.parse(stdout) as Awaited<ReturnType<RepositoryReader["read"]>>;
}
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

test("should discover unselected source with paged lists literal search and raw-byte reads", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 80; i++)
      await f.file(`src/file${String(i).padStart(2, "0")}.ts`, `export const value${i} = ${i};\n`);
    await f.file(
      "auth.ts",
      "// authentication implementation\nexport const authenticate = true;\n",
    );
    await f.file("src/auth/login.ts", "// literal [.*] marker\nexport const login = true;\n");
    assert.deepEqual((await f.reader.list()).entries, [
      { path: "auth.ts", type: "file" },
      { path: "src", type: "directory" },
    ]);
    assert.equal((await f.reader.read({ path: "auth.ts" })).text.includes("authenticate"), true);
    const first = await f.reader.list({ directory: "src" });
    assert.equal(first.entries.length, 64);
    assert.equal(first.truncated, true);
    assert.ok(first.nextCursor);
    const second = await f.reader.list({ directory: "src", after: first.nextCursor! });
    assert.equal(second.entries.length, 17);
    assert.equal(second.truncated, false);
    assert.equal(new Set([...first.entries, ...second.entries].map((e) => e.path)).size, 81);
    const found = await f.reader.search({ query: "[.*]" });
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].path, "src/auth/login.ts");
    assert.equal(found.matches[0].line, 1);
    assert.equal(found.matches[0].excerptHash, digest(found.matches[0].excerpt));
    const read = await f.reader.read({
      path: found.matches[0].path,
      offset: found.matches[0].byteStart,
      expectedHash: found.matches[0].hash,
    });
    assert.ok(read.text.startsWith(found.matches[0].excerpt));
    assert.equal(read.hash, found.matches[0].hash);
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["src/auth/login.ts"]), {
      code: "TOOL_REJECTED",
    });
  } finally {
    await f.close();
  }
});

test("should exclude protected names materials generated files and unsafe structural paths", async () => {
  const f = await fixture();
  const blocked = [
    ".hidden/a.ts",
    ".env.example",
    "AGENTS.md",
    "claude.MD",
    "CODEX.md",
    "MCP.JSON",
    "auth.json",
    "credentials.json",
    "secrets.yaml",
    "api-key.json",
    "token.txt",
    "agent-settings.json",
    "settings.json",
    "a.min.js",
    "a.generated.ts",
    "node_modules/a.ts",
    "DIST/a.ts",
    "vendor/a.ts",
    "coverage/a.ts",
    "cache/a.ts",
    "a.pem",
    "a.db",
    "a.png",
    ".codex/settings/a.ts",
  ];
  try {
    await f.file("package.json", '{"name":"synthetic-project"}');
    await f.file("tsconfig.test.json", '{"compilerOptions":{}}');
    for (const path of blocked) await f.file(path, "synthetic marker");
    for (const path of [
      ...blocked,
      "src/AGENTS.md/a.ts",
      "../a.ts",
      "/a.ts",
      "a\\b.ts",
      "a\0.ts",
      "a//b.ts",
      "a/./b.ts",
    ])
      await assert.rejects(f.reader.read({ path }), { code: "TOOL_REJECTED" });
    assert.deepEqual(
      (await f.reader.list()).entries.map((e) => e.path),
      ["package.json", "tsconfig.test.json"],
    );
    assert.equal((await f.reader.search({ query: "synthetic marker" })).matches.length, 0);
    for (const directory of ["../", "/", "a\\b", ".hidden", "DIST"])
      await assert.rejects(f.reader.list({ directory }), { code: "TOOL_REJECTED" });
    await assert.rejects(f.reader.list({ after: "nested/file.ts" }), { code: "TOOL_REJECTED" });
  } finally {
    await f.close();
  }
});

test("should enforce common reader containment before any I/O even without caller validation", async (t) => {
  const f = await fixture();
  let io = 0;
  const mocked = t.mock.method(fsPromises, "lstat", async () => {
    io++;
    throw new Error("unexpected I/O");
  });
  syncBuiltinESMExports();
  try {
    for (const path of ["../a.ts", "/a.ts", "a\\b.ts", "a\0.ts", "a//b.ts", "a/./b.ts"])
      await assert.rejects(
        readSafeFile(f.identity, path, () => {}, "repository"),
        { code: "TOOL_REJECTED" },
      );
    for (const directory of [
      join(f.root, ".."),
      `${f.root}-other`,
      "relative",
      `${f.root}/../outside`,
    ])
      await assert.rejects(
        captureDirectory(f.identity, directory, () => {}),
        { code: "TOOL_REJECTED" },
      );
    assert.equal(io, 0);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should sort cursors using UTF-16 code units and bound list JSON output", async () => {
  const f = await fixture();
  try {
    for (const name of ["\uE000.ts", "😀.ts", "a.ts"]) await f.file(name, "code");
    assert.deepEqual(
      (await f.reader.list()).entries.map((e) => e.path),
      ["a.ts", "😀.ts", "\uE000.ts"],
    );
    assert.deepEqual(
      (await f.reader.list({ after: "😀.ts" })).entries.map((e) => e.path),
      ["\uE000.ts"],
    );
    for (let i = 0; i < 60; i++) await f.file(`${"q".repeat(190)}${i}.ts`, "code");
    const result = await f.reader.list();
    assert.ok(size(result) <= 8192);
    assert.ok(result.entries.length < 64);
    assert.equal(result.truncated, true);
  } finally {
    await f.close();
  }
});

test("should validate entire large files before bounded Unicode and JSON escaped excerpts", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from("\uFEFF" + '😀\\"\t'.repeat(15000));
    await f.file("large.ts", bytes);
    const first = await f.reader.read({ path: "large.ts" });
    assert.ok(first.text.startsWith("\uFEFF"));
    assert.equal(first.hash, digest(bytes));
    assert.equal(first.size, bytes.length);
    assert.ok(size(first) <= 8192);
    assert.equal(first.byteStart, 0);
    assert.equal(first.excerptHash, digest(bytes.subarray(0, first.byteEnd)));
    assert.ok(first.nextOffset);
    assert.equal(Buffer.byteLength(first.text), first.byteEnd);
    assert.equal(first.truncated, true);
    const next = await f.reader.read({
      path: "large.ts",
      offset: first.nextOffset!,
      expectedHash: first.hash,
    });
    assert.equal(next.byteStart, first.byteEnd);
    assert.equal(next.excerptHash, digest(bytes.subarray(next.byteStart, next.byteEnd)));
    assert.ok(size(next) <= 8192);
    assert.ok(!(next.text.charCodeAt(0) >= 0xdc00 && next.text.charCodeAt(0) <= 0xdfff));
    assert.equal((await f.reader.read({ path: "large.ts", offset: 3 })).byteStart, 3);
    for (const offset of [1, 2, 4, -1, 0.5, bytes.length + 1])
      await assert.rejects(f.reader.read({ path: "large.ts", offset }), { code: "TOOL_REJECTED" });
    await f.file("secret.ts", "x".repeat(100000) + "\npassword=synthetic-private-secret");
    await f.file("invalid.ts", Buffer.from([0x61, 0xff]));
    await f.file("control.ts", "a\x01");
    for (const path of ["secret.ts", "invalid.ts", "control.ts"])
      await assert.rejects(f.reader.read({ path }), { code: "TOOL_REJECTED" });
    await f.file("large.ts", "changed");
    await assert.rejects(f.reader.read({ path: "large.ts", expectedHash: first.hash }), {
      code: "SNAPSHOT_CHANGED",
    });
  } finally {
    await f.close();
  }
});

test("should accept two MiB and reject oversize rather than return clipped success", async () => {
  const f = await fixture();
  try {
    await f.file("boundary.ts", "x".repeat(2 * 1024 * 1024));
    assert.equal((await f.reader.read({ path: "boundary.ts" })).size, 2 * 1024 * 1024);
    await f.file("oversize.ts", "x".repeat(2 * 1024 * 1024 + 1));
    await assert.rejects(f.reader.read({ path: "oversize.ts" }), { code: "TOOL_REJECTED" });
    assert.equal((await f.reader.search({ query: "unmatched" })).truncated, true);
  } finally {
    await f.close();
  }
});

test("should retain search BOM byte ranges hashes line numbers and sixteen-match output limit", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from("\uFEFF😀 header\nsecond literal [.*]\nthird literal [.*]\n");
    await f.file("bom.ts", bytes);
    const result = await f.reader.search({ query: "literal [.*]" });
    assert.equal(result.matches.length, 2);
    for (const [i, match] of result.matches.entries()) {
      assert.equal(match.line, i + 2);
      assert.equal(match.hash, digest(bytes));
      assert.equal(match.excerptHash, digest(bytes.subarray(match.byteStart, match.byteEnd)));
      assert.equal(bytes.subarray(match.byteStart, match.byteEnd).toString("utf8"), match.excerpt);
      assert.ok(
        (
          await f.reader.read({
            path: match.path,
            offset: match.byteStart,
            expectedHash: match.hash,
          })
        ).text.startsWith(match.excerpt),
      );
    }
    await f.file("many.ts", "match\n".repeat(30));
    const many = await f.reader.search({ query: "match" });
    assert.equal(many.matches.length, 16);
    assert.equal(many.truncated, true);
    assert.ok(size(many) <= 8192);
    await f.file("escaped.ts", '"\\😀match'.repeat(5000));
    const escaped = await f.reader.search({ query: "😀match" });
    assert.ok(size(escaped) <= 8192);
    assert.equal(escaped.truncated, true);
    for (const query of ["", "x".repeat(257)])
      await assert.rejects(f.reader.search({ query }), { code: "TOOL_REJECTED" });
  } finally {
    await f.close();
  }
});

test("should reject symlinks hardlinks shared-write files and shared-write ancestors", async () => {
  const f = await fixture();
  try {
    await f.file("safe.ts", "safe");
    await symlink(join(f.root, "safe.ts"), join(f.root, "linked.ts"));
    await assert.rejects(f.reader.read({ path: "linked.ts" }), { code: "TOOL_REJECTED" });
    await link(join(f.root, "safe.ts"), join(f.root, "hard.ts"));
    await assert.rejects(f.reader.read({ path: "hard.ts" }), { code: "TOOL_REJECTED" });
    await f.file("shared.ts", "safe");
    await chmod(join(f.root, "shared.ts"), 0o666);
    await assert.rejects(f.reader.read({ path: "shared.ts" }), { code: "TOOL_REJECTED" });
    await f.file("src/a.ts", "safe");
    await chmod(join(f.root, "src"), 0o777);
    await assert.rejects(f.reader.read({ path: "src/a.ts" }), { code: "SNAPSHOT_CHANGED" });
    await assert.rejects(f.reader.list({ directory: "src" }), { code: "SNAPSHOT_CHANGED" });
    assert.equal(
      (await f.reader.list()).entries.some((entry) => entry.path.endsWith(".ts")),
      false,
    );
  } finally {
    await f.close();
  }
});

test("should reject descriptor path root and ancestor swaps and close every opened file", async (t) => {
  for (const swap of ["descriptor", "path", "ancestor", "root"]) {
    const f = await fixture();
    await f.file("src/a.ts", "safe");
    await f.file("replacement.ts", "replacement");
    const original = fsPromises.open;
    let opened: FileHandle | undefined;
    let swapped = false;
    const mocked = t.mock.method(
      fsPromises,
      "open",
      async (...args: Parameters<typeof fsPromises.open>) => {
        opened = await original(
          swap === "descriptor" ? join(f.root, "replacement.ts") : args[0],
          args[1],
          args[2],
        );
        if (!swapped) {
          swapped = true;
          if (swap === "path") {
            await rename(join(f.root, "src/a.ts"), join(f.root, "src/parked.ts"));
            await rename(join(f.root, "replacement.ts"), join(f.root, "src/a.ts"));
          }
          if (swap === "ancestor") {
            await rename(join(f.root, "src"), join(f.root, "parked"));
            await mkdir(join(f.root, "src"));
            await f.file("src/a.ts", "new");
          }
          if (swap === "root") {
            await rename(f.root, `${f.root}-parked`);
            await mkdir(f.root);
          }
        }
        return opened;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.reader.read({ path: "src/a.ts" }), { code: "SNAPSHOT_CHANGED" });
      await assert.rejects(opened!.stat(), { code: "EBADF" });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      await f.close();
      await rm(`${f.root}-parked`, { recursive: true, force: true });
    }
  }
});

test("should reserve four concurrent operations and release capacity after handle cleanup", async (t) => {
  const f = await fixture();
  await f.file("a.ts", "safe");
  const original = fsPromises.open;
  const opened: FileHandle[] = [];
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const allOpened = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const mocked = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original(...args);
      opened.push(handle);
      if (opened.length === 4) ready();
      await delayed;
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    const reads = Array.from({ length: 4 }, () => f.reader.read({ path: "a.ts" }));
    await allOpened;
    await assert.rejects(f.reader.read({ path: "a.ts" }), { code: "RUNTIME_BUSY" });
    release();
    await Promise.all(reads);
    for (const handle of opened) await assert.rejects(handle.stat(), { code: "EBADF" });
    await f.reader.read({ path: "a.ts" });
  } finally {
    release();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should preserve authority errors and refuse late successful I/O with handles closed", async (t) => {
  for (const failure of ["authority", "deadline"]) {
    let time = 0,
      lost = false;
    const authority = new RuntimeError("AUTHORITY_LOST");
    const f = await fixture(
      () => {
        if (lost) throw authority;
      },
      () => time,
    );
    await f.file("a.ts", "safe");
    const original = fsPromises.open;
    let opened: FileHandle | undefined;
    const mocked = t.mock.method(
      fsPromises,
      "open",
      async (...args: Parameters<typeof fsPromises.open>) => {
        opened = await original(...args);
        if (failure === "authority") lost = true;
        else time = 3000;
        return opened;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        f.reader.read({ path: "a.ts" }),
        failure === "authority" ? (error) => error === authority : { code: "RUNTIME_CAPACITY" },
      );
      await assert.rejects(opened!.stat(), { code: "EBADF" });
      lost = false;
      mocked.mock.restore();
      syncBuiltinESMExports();
      await f.reader.read({ path: "a.ts" });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      await f.close();
    }
  }
});

test("should accumulate call and byte budgets including failed reads and exclude idle time", async (t) => {
  let time = 0;
  const f = await fixture(
    () => {},
    () => time,
  );
  try {
    for (let i = 0; i < 256; i++) {
      time += 60000;
      await assert.rejects(f.reader.read({ path: "../bad.ts" }), { code: "TOOL_REJECTED" });
    }
    await assert.rejects(f.reader.list(), { code: "RUNTIME_CAPACITY" });
    const reader = new RepositoryReader(
      f.identity,
      () => {},
      () => time,
    );
    await f.file("large.ts", "x".repeat(2 * 1024 * 1024));
    const original = fsPromises.open;
    let opened: FileHandle | undefined;
    const mocked = t.mock.method(
      fsPromises,
      "open",
      async (...args: Parameters<typeof fsPromises.open>) => {
        opened = await original(...args);
        t.mock.method(opened, "read", async () => ({ bytesRead: 0, buffer: Buffer.alloc(0) }));
        return opened;
      },
    );
    syncBuiltinESMExports();
    try {
      for (let i = 0; i < 15; i++)
        await assert.rejects(reader.read({ path: "large.ts" }), { code: "TOOL_REJECTED" });
      await assert.rejects(reader.read({ path: "large.ts" }), { code: "RUNTIME_CAPACITY" });
      await assert.rejects(opened!.stat(), { code: "EBADF" });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await f.close();
  }
});

test("should accumulate active intervals without counting idle time", async (t) => {
  let time = 0;
  const f = await fixture(
    () => {},
    () => time,
  );
  await f.file("a.ts", "safe");
  const original = fsPromises.open;
  const mocked = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original(...args);
      time += 2000;
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    for (let i = 0; i < 14; i++) {
      await f.reader.read({ path: "a.ts" });
      time += 100000;
    }
    await assert.rejects(f.reader.read({ path: "a.ts" }), { code: "RUNTIME_CAPACITY" });
    await assert.rejects(f.reader.list(), { code: "RUNTIME_CAPACITY" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should bound streaming entry and directory budgets cumulatively and close directory handles", async (t) => {
  const f = await fixture(
    () => {},
    () => 0,
  );
  const info = await fsPromises.lstat(f.root);
  let opened = 0,
    closed = 0,
    observed = 0;
  const stat = t.mock.method(fsPromises, "lstat", async () => info);
  const canonical = t.mock.method(
    fsPromises,
    "realpath",
    async (path: Parameters<typeof fsPromises.realpath>[0]) => String(path),
  );
  const directories = t.mock.method(fsPromises, "opendir", async () => {
    opened++;
    return {
      async read() {
        observed++;
        return { name: `.hidden${observed}`, isDirectory: () => false };
      },
      async close() {
        closed++;
      },
    } as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>;
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await f.reader.list()).truncated, true);
    assert.equal(observed, 20000);
    assert.equal(opened, closed);
    assert.equal((await f.reader.search({ query: "anything" })).truncated, true);
    assert.equal(observed, 20000);
    assert.equal(opened, closed);
    directories.mock.restore();
    stat.mock.restore();
    canonical.mock.restore();
    syncBuiltinESMExports();
    for (let i = 0; i < 512; i++) await mkdir(join(f.root, `dir${i}`));
    const original = fsPromises.opendir;
    opened = 0;
    closed = 0;
    const counted = t.mock.method(
      fsPromises,
      "opendir",
      async (...args: Parameters<typeof fsPromises.opendir>) => {
        const handle = await original(...args);
        opened++;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          closed++;
        });
        return handle;
      },
    );
    syncBuiltinESMExports();
    try {
      const reader = new RepositoryReader(
        f.identity,
        () => {},
        () => 0,
      );
      assert.equal((await reader.search({ query: "unmatched" })).truncated, true);
      assert.equal(opened, 512);
      assert.equal(closed, 512);
      assert.equal((await reader.list()).truncated, true);
      assert.equal(opened, 512);
    } finally {
      counted.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    directories.mock.restore();
    stat.mock.restore();
    canonical.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should count parallel active time once and retain concurrency during delayed cleanup", async (t) => {
  let time = 0;
  const f = await fixture(
    () => {},
    () => time,
  );
  await f.file("a.ts", "safe");
  const original = fsPromises.open;
  let count = 0;
  let release!: () => void, ready!: () => void, cleanup!: () => void, cleaning!: () => void;
  const delay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const all = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const closing = new Promise<void>((resolve) => {
    cleaning = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    cleanup = resolve;
  });
  const mocked = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      const handle = await original(...args);
      count++;
      if (count <= 4) {
        if (count === 4) ready();
        await delay;
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          cleaning();
          await finish;
          await close();
        });
      } else time += 2000;
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    const reads = Array.from({ length: 4 }, () => f.reader.read({ path: "a.ts" }));
    await all;
    time = 2000;
    release();
    await closing;
    await assert.rejects(f.reader.list(), { code: "RUNTIME_BUSY" });
    cleanup();
    await Promise.all(reads);
    for (let i = 0; i < 13; i++) await f.reader.read({ path: "a.ts" });
    await assert.rejects(f.reader.read({ path: "a.ts" }), { code: "RUNTIME_CAPACITY" });
  } finally {
    release();
    cleanup();
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should close streaming handles before preserving authority loss and delayed directory deadlines", async (t) => {
  for (const failure of ["authority", "deadline"]) {
    let time = 0,
      lost = false,
      closed = false;
    const authority = new RuntimeError("AUTHORITY_LOST");
    const f = await fixture(
      () => {
        if (lost) throw authority;
      },
      () => time,
    );
    const original = fsPromises.opendir;
    const mocked = t.mock.method(
      fsPromises,
      "opendir",
      async (...args: Parameters<typeof fsPromises.opendir>) => {
        const handle = await original(...args);
        const close = handle.close.bind(handle);
        t.mock.method(handle, "close", async () => {
          await close();
          closed = true;
        });
        if (failure === "authority") lost = true;
        else time = 3000;
        return handle;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        f.reader.list(),
        failure === "authority" ? (error) => error === authority : { code: "RUNTIME_CAPACITY" },
      );
      assert.equal(closed, true);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      await f.close();
    }
  }
});

test("should refuse foreign-owner metadata and nonregular files before opening", async (t) => {
  const f = await fixture();
  await f.file("a.ts", "safe");
  await f.file("src/a.ts", "safe");
  const original = fsPromises.lstat;
  let opens = 0;
  const openOriginal = fsPromises.open;
  const opened = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      opens++;
      return openOriginal(...args);
    },
  );
  try {
    for (const kind of ["file-owner", "ancestor-owner", "fifo"]) {
      const mocked = t.mock.method(
        fsPromises,
        "lstat",
        async (...args: Parameters<typeof fsPromises.lstat>) => {
          const info = await original(...args);
          const target = kind === "ancestor-owner" ? join(f.root, "src") : join(f.root, "a.ts");
          if (String(args[0]) === target) {
            if (kind === "fifo") info.isFile = () => false;
            else Object.defineProperty(info, "uid", { value: process.getuid!() + 1 });
          }
          return info;
        },
      );
      syncBuiltinESMExports();
      try {
        await assert.rejects(
          f.reader.read({ path: kind === "ancestor-owner" ? "src/a.ts" : "a.ts" }),
          { code: kind === "ancestor-owner" ? "SNAPSHOT_CHANGED" : "TOOL_REJECTED" },
        );
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
      }
    }
    assert.equal(opens, 0);
  } finally {
    opened.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should copy approved root identity and avoid implicit access before the execution check", async (t) => {
  let lost = false;
  const authority = new RuntimeError("AUTHORITY_LOST");
  const f = await fixture(() => {
    if (lost) throw authority;
  });
  await f.file("a.ts", "safe");
  try {
    f.identity.path = "/unapproved";
    assert.equal((await f.reader.read({ path: "a.ts" })).text, "safe");
    let io = 0;
    const mocked = t.mock.method(fsPromises, "lstat", async () => {
      io++;
      throw new Error("unexpected I/O");
    });
    syncBuiltinESMExports();
    try {
      lost = true;
      await assert.rejects(f.reader.list(), (error) => error === authority);
      assert.equal(io, 0);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await f.close();
  }
});

test("should place a late literal match inside the bounded excerpt with reusable raw offset", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from("😀".repeat(20000) + "late-literal-marker\n");
    await f.file("late.ts", bytes);
    const found = await f.reader.search({ query: "late-literal-marker" });
    assert.equal(found.matches.length, 1);
    const match = found.matches[0];
    assert.ok(match.excerpt.includes("late-literal-marker"));
    assert.ok(match.byteStart > 0);
    assert.equal(match.excerptHash, digest(bytes.subarray(match.byteStart, match.byteEnd)));
    assert.ok(
      (
        await f.reader.read({ path: match.path, offset: match.byteStart, expectedHash: match.hash })
      ).text.startsWith(match.excerpt),
    );
  } finally {
    await f.close();
  }
});

test("should discover ordinary settings implementation while excluding agent settings material", async () => {
  const f = await fixture();
  try {
    await f.file(
      "src/settings/manager.ts",
      "// ordinary settings implementation marker\nexport const setting = true;\n",
    );
    await f.file(".codex/settings.json", "synthetic agent material");
    const list = await f.reader.list({ directory: "src/settings" });
    assert.deepEqual(
      list.entries.map((entry) => entry.path),
      ["src/settings/manager.ts"],
    );
    assert.ok(
      (await f.reader.read({ path: "src/settings/manager.ts" })).text.includes("ordinary settings"),
    );
    const search = await f.reader.search({ query: "ordinary settings implementation marker" });
    assert.equal(search.matches.length, 1);
    await assert.rejects(f.reader.read({ path: ".codex/settings.json" }), {
      code: "TOOL_REJECTED",
    });
  } finally {
    await f.close();
  }
});

test("should preserve a one-shot non-RuntimeError execution-check failure after opening", async (t) => {
  let lost = false;
  const authority = Object.assign(new Error("synthetic authority loss"), {
    code: "AUTHORITY_LOST",
  });
  const f = await fixture(() => {
    if (lost) {
      lost = false;
      throw authority;
    }
  });
  await f.file("a.ts", "safe");
  const original = fsPromises.open;
  let opened: FileHandle | undefined;
  const mocked = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      opened = await original(...args);
      lost = true;
      return opened;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.reader.read({ path: "a.ts" }), (error) => error === authority);
    await assert.rejects(opened!.stat(), { code: "EBADF" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should report complete-file line counts independently from bounded excerpts", async () => {
  const f = await fixture();
  try {
    for (const [path, content, count] of [
      ["empty.ts", "", 1],
      ["one.ts", "one", 1],
      ["trailing.ts", "one\n", 2],
      ["crlf.ts", "\uFEFFone\r\ntwo\r\n", 3],
    ] as const) {
      await f.file(path, content);
      const result = await f.reader.read({ path });
      assert.equal(result.lineCount, count);
      assert.equal(result.text, content);
      assert.ok(size(result) <= 8192);
    }
    const content = "\uFEFF" + "long synthetic line 😀\r\n".repeat(10000);
    await f.file("many-lines.ts", content);
    const first = await f.reader.read({ path: "many-lines.ts" });
    assert.equal(first.lineCount, 10001);
    assert.equal(first.truncated, true);
    assert.ok(first.text.split("\n").length < first.lineCount);
    assert.ok(size(first) <= 8192);
    const next = await f.reader.read({
      path: "many-lines.ts",
      offset: first.nextOffset!,
      expectedHash: first.hash,
    });
    assert.equal(next.lineCount, 10001);
    assert.ok(size(next) <= 8192);
  } finally {
    await f.close();
  }
});

test("should reject quoted sensitive fields anywhere in automatic configuration and code reads", async () => {
  const f = await fixture();
  try {
    const cases = [
      ["configuration.json", '{"password":"synthetic-private-value"}'],
      ["short-configuration.json", '{"password":"tiny"}'],
      ["short-configuration.yaml", '"api_key": tiny'],
      ["short-configuration.ts", 'const object = { "credential": "tiny" };'],
      ["api-configuration.json", '{"api_key":"synthetic-private-value"}'],
      ["configuration-credential.json", '{"credential":"synthetic-private-value"}'],
      ["configuration.yaml", '"credential": "synthetic-private-value"'],
      ["configuration.ts", 'const object = { "client-secret": "synthetic-private-value" };'],
      ["configuration.js", "const object = { 'access_token': 'synthetic-private-value' };"],
    ];
    for (const [path, material] of cases) {
      const prefix = path.endsWith(".json")
        ? '{"padding":"' + "x".repeat(100000) + '","nested":'
        : "// synthetic padding\n".repeat(5000);
      const content = prefix + material + (path.endsWith(".json") ? "}" : "");
      await f.file(path, content);
      await assert.rejects(f.reader.read({ path }), { code: "TOOL_REJECTED" });
    }
    const searched = await f.reader.search({ query: "synthetic-private-value" });
    assert.equal(searched.matches.length, 0);
    assert.equal(searched.truncated, true);
  } finally {
    await f.close();
  }
});

test("should permit empty credential placeholders and code references without embedded literal material", async () => {
  const f = await fixture();
  try {
    const examples = [
      ["empty-configuration.json", '{"password":"","api_key":""}'],
      ["empty-configuration.yaml", '"password": ""\n"api_key": null\n'],
      ["auth.ts", 'const request = { "password": user.password, "credential": readCredential() };'],
    ];
    for (const [path, text] of examples) {
      await f.file(path, text);
      assert.equal((await f.reader.read({ path })).text, text);
    }
  } finally {
    await f.close();
  }
});

test("should address review1 H1 by reserving the final streaming entry before concurrent reads", async (t) => {
  const f = await fixture(
    () => {},
    () => 0,
  );
  const info = await fsPromises.lstat(f.root);
  let phase = "seed",
    seeded = 0,
    attempts = 0,
    raced = 0,
    closed = 0;
  const stat = t.mock.method(fsPromises, "lstat", async () => info);
  const canonical = t.mock.method(
    fsPromises,
    "realpath",
    async (path: Parameters<typeof fsPromises.realpath>[0]) => String(path),
  );
  const opened = t.mock.method(
    fsPromises,
    "opendir",
    async () =>
      ({
        async read() {
          attempts++;
          if (phase === "seed") {
            if (seeded === 19998) return null;
            seeded++;
            return { name: `.hidden${seeded}`, isDirectory: () => false };
          }
          raced++;
          // A bounded release avoids requiring four admitted reads after the fix leaves one slot.
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
          return { name: `.race${raced}`, isDirectory: () => false };
        },
        async close() {
          closed++;
        },
      }) as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>,
  );
  syncBuiltinESMExports();
  try {
    await f.reader.list();
    phase = "race";
    await Promise.all(Array.from({ length: 4 }, () => f.reader.list()));
    assert.ok(attempts <= 20000, `stream reads exceeded cap: ${attempts}`);
    assert.ok(seeded + raced <= 20000);
    assert.equal(raced, 1);
    assert.equal(closed, 5);
  } finally {
    opened.mock.restore();
    canonical.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should address review1 H1 by retaining a consumed entry when the post-read check fails", async (t) => {
  let throwNext = false;
  const authority = new RuntimeError("AUTHORITY_LOST");
  const f = await fixture(
    () => {
      if (throwNext) {
        throwNext = false;
        throw authority;
      }
    },
    () => 0,
  );
  const info = await fsPromises.lstat(f.root);
  let phase = "seed",
    seeded = 0,
    attempts = 0;
  const stat = t.mock.method(fsPromises, "lstat", async () => info);
  const canonical = t.mock.method(
    fsPromises,
    "realpath",
    async (path: Parameters<typeof fsPromises.realpath>[0]) => String(path),
  );
  const opened = t.mock.method(
    fsPromises,
    "opendir",
    async () =>
      ({
        async read() {
          attempts++;
          if (phase === "seed") {
            if (seeded === 19998) return null;
            seeded++;
            return { name: `.hidden${seeded}`, isDirectory: () => false };
          }
          if (phase === "fail") {
            throwNext = true;
            return { name: ".last", isDirectory: () => false };
          }
          return null;
        },
        async close() {},
      }) as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>,
  );
  syncBuiltinESMExports();
  try {
    await f.reader.list();
    phase = "fail";
    await assert.rejects(f.reader.list(), (error) => error === authority);
    const consumed = attempts;
    phase = "after";
    assert.equal((await f.reader.list()).truncated, true);
    assert.equal(attempts, consumed);
  } finally {
    opened.mock.restore();
    canonical.mock.restore();
    stat.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should address review1 H2 by retaining the complete query in every output-fitted match", async () => {
  const f = await fixture();
  try {
    const query = "Q".repeat(256);
    await f.file("match.ts", query + "a".repeat(7100) + "\n" + "x".repeat(80) + query + "\n");
    const result = await f.reader.search({ query });
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.every((match) => match.excerpt.includes(query)));
    assert.equal(result.truncated, true);
    assert.ok(size(result) <= 8192);
    for (const match of result.matches)
      assert.ok(
        (
          await f.reader.read({
            path: match.path,
            offset: match.byteStart,
            expectedHash: match.hash,
          })
        ).text.startsWith(match.excerpt),
      );
  } finally {
    await f.close();
  }
});

test("should address review1 H3 by rejecting standard escaped keys and constant template material", async () => {
  const f = await fixture();
  try {
    for (const [path, text] of [
      ["escaped-configuration.json", '{"pass\\u0077ord":"tiny"}'],
      ["escaped-configuration.yaml", '"api\\x5fkey": tiny'],
      ["template-configuration.ts", 'const object = { "credential": `tiny` };'],
      ["escaped-template.ts", 'const object = { "client\\u002dsecret": `tiny` };'],
    ]) {
      await f.file(path, text);
      await assert.rejects(f.reader.read({ path }), { code: "TOOL_REJECTED" });
    }
    const search = await f.reader.search({ query: "tiny" });
    assert.equal(search.matches.length, 0);
    assert.equal(search.truncated, true);
  } finally {
    await f.close();
  }
});

test("should address review1 H4 by preserving a one-shot external policy error during search", async (t) => {
  let fail = false,
    failures = 0;
  const authority = new RuntimeError("TOOL_REJECTED");
  const f = await fixture(() => {
    if (fail) {
      fail = false;
      failures++;
      throw authority;
    }
  });
  await f.file("a.ts", "synthetic searchable marker");
  const original = fsPromises.open;
  let opened: FileHandle | undefined;
  const mocked = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      opened = await original(...args);
      fail = true;
      return opened;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.reader.search({ query: "marker" }), (error) => error === authority);
    assert.equal(failures, 1);
    await assert.rejects(opened!.stat(), { code: "EBADF" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should omit an unfit complete astral query after prior search matches consume output", async () => {
  const f = await fixture();
  try {
    const query = "😀".repeat(128);
    await f.file(
      "astral-match.ts",
      query + "a".repeat(6900) + "\n" + "x".repeat(80) + query + "\n",
    );
    const result = await f.reader.search({ query });
    assert.equal(result.truncated, true);
    assert.ok(size(result) <= 8192);
    assert.ok(result.matches.length > 0);
    assert.ok(result.matches.every((match) => match.excerpt.includes(query)));
    assert.equal(result.matches.length, 1);
  } finally {
    await f.close();
  }
});

test("should reject supported escaped sensitive spellings and preserve decoded empty placeholders and references", async () => {
  const f = await fixture();
  try {
    for (const [path, text] of [
      ["unicode-configuration.json", '{"\\u0070assword":"tiny"}'],
      ["yaml-unicode.yaml", '"\\U00000070assword": tiny'],
      ["hex-configuration.ts", 'const object = { "api\\x5fkey": "tiny" };'],
      ["codepoint-configuration.ts", 'const object = { "\\u{63}redential": `tiny` };'],
      ["single-configuration.ts", "const object = { 'pass\\u0077ord': `tiny` };"],
      ["multi-template.ts", 'const object = { "password": `tiny\nconstant` };'],
      ["escaped-template.ts", 'const object = { "password": `\\${synthetic}` };'],
    ]) {
      await f.file(path, text);
      await assert.rejects(f.reader.read({ path }), { code: "TOOL_REJECTED" });
    }
    for (const [path, text] of [
      ["empty-escaped.json", '{"pass\\u0077ord":""}'],
      ["empty-template.ts", 'const object = { "credential": `` };'],
      ["reference-template.ts", 'const object = { "password": `${user.password}` };'],
      ["reference-escaped.ts", 'const object = { "pass\\u0077ord": user.password };'],
      ["yaml-literal-key.yaml", "'pass\\u0077ord': tiny"],
    ]) {
      await f.file(path, text);
      assert.equal((await f.reader.read({ path })).text, text);
    }
  } finally {
    await f.close();
  }
});

test("should read a 105 KiB escaped-quote Unicode file without exhausting the logical deadline", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('😀\\"\t'.repeat(15360));
    assert.equal(bytes.length, 107520);
    await f.file("unicode.ts", bytes);
    const result = await f.reader.read({ path: "unicode.ts" });
    assert.equal(result.size, bytes.length);
    assert.equal(result.hash, digest(bytes));
    assert.ok(size(result) <= 8192);
    assert.equal(result.excerptHash, digest(bytes.subarray(result.byteStart, result.byteEnd)));
    assert.equal(result.text, bytes.subarray(result.byteStart, result.byteEnd).toString("utf8"));
    assert.equal(result.truncated, true);
  } finally {
    await f.close();
  }
});

test("should read escaped-quote Unicode within the logical budget in a normal owned Node process", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('😀\\"\t'.repeat(15360));
    await f.file("unicode.ts", bytes);
    const result = await coldRead(f.root, "unicode.ts");
    assert.equal(result.size, bytes.length);
    assert.equal(result.hash, digest(bytes));
    assert.ok(size(result) <= 8192);
    assert.equal(result.text, bytes.subarray(result.byteStart, result.byteEnd).toString("utf8"));
    assert.equal(result.excerptHash, digest(bytes.subarray(result.byteStart, result.byteEnd)));
  } finally {
    await f.close();
  }
});

test("should read 512 KiB escaped-quote Unicode with bounded JSON and clean owned child completion", async () => {
  const f = await fixture();
  try {
    const unit = '😀\\"\t';
    const bytes = Buffer.concat([
      Buffer.from(unit.repeat(Math.floor(524288 / Buffer.byteLength(unit)))),
      Buffer.alloc(524288 % Buffer.byteLength(unit), "a"),
    ]);
    assert.equal(bytes.length, 524288);
    await f.file("unicode.ts", bytes);
    const result = await coldRead(f.root, "unicode.ts");
    assert.equal(result.size, bytes.length);
    assert.equal(result.hash, digest(bytes));
    assert.ok(size(result) <= 8192);
    assert.equal(result.text, bytes.subarray(result.byteStart, result.byteEnd).toString("utf8"));
    assert.equal(result.excerptHash, digest(bytes.subarray(result.byteStart, result.byteEnd)));
    assert.equal(result.truncated, true);
    assert.equal(result.nextOffset, result.byteEnd);
  } finally {
    await f.close();
  }
});

test("should read large ordinary quoted JavaScript JSON and YAML strings without suffix rescans", async () => {
  const f = await fixture();
  try {
    const escaped = '😀\\"\t'.repeat(75000);
    const examples = [
      ["quoted.js", 'const description = "' + escaped + '";\n'],
      ["quoted.yaml", '"description": "' + escaped + '"\n'],
      ["quoted.json", JSON.stringify({ description: '😀"\\\t'.repeat(60000) })],
    ];
    for (const [path, content] of examples) {
      const bytes = Buffer.from(content);
      assert.ok(bytes.length > 512 * 1024);
      await f.file(path, bytes);
      const result = await f.reader.read({ path });
      assert.equal(result.size, bytes.length);
      assert.equal(result.hash, digest(bytes));
      assert.ok(size(result) <= 8192);
      assert.equal(result.text, bytes.subarray(result.byteStart, result.byteEnd).toString("utf8"));
      assert.equal(result.excerptHash, digest(bytes.subarray(result.byteStart, result.byteEnd)));
      assert.equal(result.truncated, true);
    }
  } finally {
    await f.close();
  }
});

test("should keep automatic secret inspection sensitive to literal material in nested text and at file end", async () => {
  const f = await fixture();
  try {
    for (const [path, text] of [
      ["nested.js", 'const description = \'{"password":"tiny"}\';'],
      ["tail.yaml", '"description": "' + '😀\\"\t'.repeat(75000) + '"\n"api\\x5fkey": tiny'],
      [
        "tail.js",
        'const description = "' +
          '😀\\"\t'.repeat(75000) +
          '";\nconst material = { "credential": `tiny` };',
      ],
    ]) {
      await f.file(path, text);
      await assert.rejects(f.reader.read({ path }), { code: "TOOL_REJECTED" });
    }
  } finally {
    await f.close();
  }
});

test("should read repeated JWT header prefixes at 512 KiB and the full 2 MiB file limit in owned cold processes", async () => {
  const f = await fixture();
  try {
    for (const length of [524288, 2 * 1024 * 1024]) {
      const prefix = 'const example = "';
      const suffix = '";\n';
      const unit = "-eyJabcdefghijklmn";
      const bodyLength = length - Buffer.byteLength(prefix + suffix);
      const bytes = Buffer.from(
        prefix +
          unit.repeat(Math.floor(bodyLength / unit.length)) +
          "a".repeat(bodyLength % unit.length) +
          suffix,
      );
      assert.equal(bytes.length, length);
      if (length === 524288)
        assert.equal(
          digest(bytes),
          "b40874c651cec8f13a19a69798415a25eecd587f6c06d179f72127c9b475591e",
        );
      await f.file("example.ts", bytes);
      const result = await coldRead(f.root, "example.ts");
      assert.equal(result.size, length);
      assert.equal(result.hash, digest(bytes));
      assert.ok(size(result) <= 8192);
      assert.equal(result.byteStart, 0);
      assert.equal(result.text, bytes.subarray(result.byteStart, result.byteEnd).toString("utf8"));
      assert.equal(result.excerptHash, digest(bytes.subarray(result.byteStart, result.byteEnd)));
      assert.equal(result.truncated, true);
      assert.equal(result.nextOffset, result.byteEnd);
      assert.equal(result.lineCount, 2);
    }
  } finally {
    await f.close();
  }
});

test("should preserve JWT case boundaries header minimum and nonempty payload signature in repository selected and public text", async () => {
  const f = await fixture();
  const header = "eyJ" + "a".repeat(12);
  try {
    const cases: [string, boolean][] = [
      [header + ".b.c", true],
      ["EYJ" + "A".repeat(12) + ".B.C", true],
      ["eYj" + "_-".repeat(6) + ".-.z", true],
      [header + ".-.--z--", true],
      [header + ".b._", true],
      [header + ".b.c---", true],
      [header + ".b.-c", true],
      ["-" + header + ".b.c", true],
      ["word-" + header + ".b.c", true],
      ["😀" + header + ".b.c", true],
      ["a.b." + header + ".b.c", true],
      ["eyJ" + "a".repeat(11) + "-.b.c", true],
      ["eyJhbGciOiJub25lIn0.eyJleGFtcGxlIjp0cnVlfQ.c3ludGhldGlj", true],
      ["eyJ" + "a".repeat(11) + ".b.c", false],
      ["a" + header + ".b.c", false],
      ["0" + header + ".b.c", false],
      ["_" + header + ".b.c", false],
      [header + "..c", false],
      [header + ".b.", false],
      [header + ".b.-", false],
      [header + ".b.----", false],
      [header + ".b+.c", false],
      [header + ".b/.c", false],
      [header + ".b=.c", false],
      [header + ".b .c", false],
      [header + ".b.😀", false],
      [header + ".b..c", false],
      [header + "\n.b.c", false],
    ];
    for (const [text, rejected] of cases) {
      await f.file("example.ts", text);
      if (rejected) {
        await assert.rejects(f.reader.read({ path: "example.ts" }), { code: "TOOL_REJECTED" });
        await assert.rejects(RuntimeFilePolicy.select(f.root, ["example.ts"]), {
          code: "TOOL_REJECTED",
        });
        assert.throws(() => publicText(text), { code: "PUBLIC_TEXT_REJECTED" });
      } else {
        const result = await f.reader.read({ path: "example.ts" });
        assert.equal(result.text, text);
        assert.equal(result.hash, digest(text));
        const selected = await RuntimeFilePolicy.select(f.root, ["example.ts"]);
        assert.equal(await selected.read("example.ts"), text);
        assert.equal(selected.files[0].hash, digest(text));
        assert.equal(publicText(text), text.trim());
      }
    }
  } finally {
    await f.close();
  }
});

test("should inspect actual JWT and other legacy secret material after near-limit repeated header prefixes", async () => {
  const f = await fixture();
  try {
    const header = "eyJ" + "a".repeat(12);
    const tails = [
      header + ".payload.signature",
      "-----BEGIN SYNTHETIC PRIVATE KEY",
      "-----BEGIN OPENSSH",
      "sk-" + "a".repeat(16),
      "SK-PROJ-" + "a".repeat(16),
      "AKIA" + "A".repeat(16),
      "password=synthetic-private-value",
      "credential:synthetic-private-value",
      "authorization=synthetic-private-value",
      '{"password":"tiny"}',
      '"api\\x5fkey": tiny',
      'const data = { "credential": `tiny` };',
    ];
    for (const tail of tails) {
      const prefix = 'const example = "';
      const suffix = '";\n' + tail;
      const bodyLength = 2 * 1024 * 1024 - Buffer.byteLength(prefix + suffix);
      const unit = "-eyJabcdefghijklmn";
      const text =
        prefix +
        unit.repeat(Math.floor(bodyLength / unit.length)) +
        "a".repeat(bodyLength % unit.length) +
        suffix;
      assert.equal(Buffer.byteLength(text), 2 * 1024 * 1024);
      // A fresh reader keeps this full-file inspection independent of cumulative byte budgets.
      await f.file("example.yaml", text);
      await assert.rejects(
        new RepositoryReader(f.identity, () => {}).read({ path: "example.yaml" }),
        {
          code: "TOOL_REJECTED",
        },
      );
    }
  } finally {
    await f.close();
  }
});
