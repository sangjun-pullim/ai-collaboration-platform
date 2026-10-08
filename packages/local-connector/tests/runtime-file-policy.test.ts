import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, {
  link,
  symlink,
  writeFile,
  chmod,
  mkdir,
  rename,
  type FileHandle,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { RuntimeFilePolicy, publicText } from "../src/runtime-file-policy.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

test(
  "should refuse FIFO and opened descriptor or post-open path identity swaps",
  { timeout: 10000 },
  async (t) => {
    const f = await runtimeFixture();
    try {
      const fifo = join(f.root, "synthetic.fifo");
      await promisify(execFile)("/usr/bin/mkfifo", [fifo], { env: {}, timeout: 2000 });
      await assert.rejects(RuntimeFilePolicy.select(f.root, ["synthetic.fifo"]), {
        code: "TOOL_REJECTED",
      });
    } finally {
      await f.close();
    }
    for (const swap of ["opened-descriptor", "path-swap"]) {
      const g = await runtimeFixture(),
        target = join(g.root, "public.txt"),
        replacement = join(g.root, "replacement.txt");
      await writeFile(replacement, "Synthetic replacement evidence.\n", { mode: 0o644 });
      const original = fsPromises.open;
      let opened: FileHandle | undefined,
        swapped = false;
      const mocked = t.mock.method(
        fsPromises,
        "open",
        async (...args: Parameters<typeof fsPromises.open>) => {
          if (String(args[0]) !== target || swapped) return original(...args);
          swapped = true;
          if (swap === "opened-descriptor") {
            opened = await original(replacement, args[1], args[2]);
            return opened;
          }
          opened = await original(...args);
          await rename(target, join(g.root, "parked.txt"));
          await rename(replacement, target);
          return opened;
        },
      );
      syncBuiltinESMExports();
      try {
        await assert.rejects(g.policy.read("public.txt"), { code: "SNAPSHOT_CHANGED" });
        assert.equal(swapped, true);
        await assert.rejects(opened!.stat(), { code: "EBADF" });
      } finally {
        mocked.mock.restore();
        syncBuiltinESMExports();
        await g.close();
      }
    }
  },
);

test("should read only selected unchanged text files through scoped tools", async () => {
  const f = await runtimeFixture();
  try {
    assert.equal(await f.policy.read("public.txt"), "Selected public evidence.\n");
    for (const path of [
      "../public.txt",
      "/public.txt",
      "a//b",
      "a\\b",
      ".git/config",
      "credentials",
      "key.pem",
      "missing.txt",
    ])
      await assert.rejects(f.policy.read(path));
    await writeFile(join(f.root, "binary.txt"), Buffer.from([0, 0xff]));
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["binary.txt"]));
    await writeFile(join(f.root, "secret.txt"), "password=synthetic-private-value");
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["secret.txt"]));
    await writeFile(join(f.root, "large.txt"), "x".repeat(65537));
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["large.txt"]));
    await symlink(join(f.root, "public.txt"), join(f.root, "link.txt"));
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["link.txt"]));
    await link(join(f.root, "public.txt"), join(f.root, "hard.txt"));
    await assert.rejects(f.policy.read("public.txt"));
    await mkdir(join(f.root, "directory"));
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["directory"]));
    await assert.rejects(
      RuntimeFilePolicy.select(
        f.root,
        Array.from({ length: 33 }, (_, i) => `file${i}`),
      ),
    );
  } finally {
    await f.close();
  }
  const g = await runtimeFixture();
  try {
    await writeFile(join(g.root, "public.txt"), "Changed evidence.\n");
    await assert.rejects(g.policy.read("public.txt"), { code: "SNAPSHOT_CHANGED" });
    await chmod(join(g.root, "public.txt"), 0o666);
    await assert.rejects(RuntimeFilePolicy.select(g.root, ["public.txt"]));
    for (const text of [
      "Private root /Users/example",
      "secret-native-id",
      "credential=synthetic-secret-value",
      "Error: private provider failure",
    ])
      assert.throws(() => publicText(text, ["secret-native-id"]), { code: "PUBLIC_TEXT_REJECTED" });
    assert.equal(publicText("Public evidence."), "Public evidence.");
  } finally {
    await g.close();
  }
});

test("should retain selected BOM decoding and preserve authority errors after descriptor cleanup", async (t) => {
  const f = await runtimeFixture();
  const original = fsPromises.open;
  let opened: FileHandle | undefined;
  let lost = false;
  try {
    await writeFile(join(f.root, "bom.txt"), Buffer.from("\uFEFFSelected BOM evidence.\n"));
    const policy = await RuntimeFilePolicy.select(f.root, ["bom.txt"]);
    assert.equal(await policy.read("bom.txt"), "Selected BOM evidence.\n");
    const authority = Object.assign(new Error("authority test"), { code: "AUTHORITY_LOST" });
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
      await assert.rejects(
        policy.read("bom.txt", () => {
          if (lost) throw authority;
        }),
        (error) => error === authority,
      );
      await assert.rejects(opened!.stat(), { code: "EBADF" });
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
  } finally {
    await f.close();
  }
});

test("should refuse short reads without changing selected snapshots", async (t) => {
  const f = await runtimeFixture();
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
    await assert.rejects(f.policy.read("public.txt"), { code: "TOOL_REJECTED" });
    await assert.rejects(opened!.stat(), { code: "EBADF" });
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should reject foreign current-user ownership before opening a selected file", async (t) => {
  const f = await runtimeFixture();
  const foreignUid = process.getuid!() + 1;
  const originalLstat = fsPromises.lstat;
  let opened = 0;
  const mockedStat = t.mock.method(
    fsPromises,
    "lstat",
    async (...args: Parameters<typeof fsPromises.lstat>) => {
      const info = await originalLstat(...args);
      if ([f.root, join(f.root, "public.txt")].includes(String(args[0])))
        Object.defineProperty(info, "uid", { value: foreignUid });
      return info;
    },
  );
  const originalOpen = fsPromises.open;
  const mockedOpen = t.mock.method(
    fsPromises,
    "open",
    async (...args: Parameters<typeof fsPromises.open>) => {
      opened++;
      return originalOpen(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    const policy = new RuntimeFilePolicy({ ...f.policy.root, uid: foreignUid }, f.policy.files);
    await assert.rejects(policy.read("public.txt"), { code: "TOOL_REJECTED" });
    assert.equal(opened, 0);
  } finally {
    mockedStat.mock.restore();
    mockedOpen.mock.restore();
    syncBuiltinESMExports();
    await f.close();
  }
});

test("should retain selected per-file and combined byte limits", async () => {
  const f = await runtimeFixture();
  try {
    const paths = Array.from({ length: 9 }, (_, index) => `boundary${index}.txt`);
    for (const path of paths)
      await writeFile(join(f.root, path), "x".repeat(65536), { mode: 0o644 });
    const policy = await RuntimeFilePolicy.select(f.root, paths.slice(0, 8));
    assert.equal((await policy.read(paths[0])).length, 65536);
    await assert.rejects(RuntimeFilePolicy.select(f.root, paths), { code: "TOOL_REJECTED" });
  } finally {
    await f.close();
  }
});

test("should retain legacy quoted-key text behavior independently from automatic content checks", async () => {
  const f = await runtimeFixture();
  try {
    const text = '{"password":"synthetic-private-value"}';
    await writeFile(join(f.root, "configuration.json"), text, { mode: 0o644 });
    const selected = await RuntimeFilePolicy.select(f.root, ["configuration.json"]);
    assert.equal(await selected.read("configuration.json"), text);
    assert.equal(publicText(text), text);
  } finally {
    await f.close();
  }
});

test("should retain legacy escaped-key and template text behavior without automatic inspection", async () => {
  const f = await runtimeFixture();
  try {
    for (const [path, text] of [
      ["escaped.json", '{"pass\\u0077ord":"tiny"}'],
      ["template.ts", 'const object = { "credential": `tiny` };'],
    ]) {
      await writeFile(join(f.root, path), text, { mode: 0o644 });
      const policy = await RuntimeFilePolicy.select(f.root, [path]);
      assert.equal(await policy.read(path), text);
      assert.equal(publicText(text), text);
    }
  } finally {
    await f.close();
  }
});
