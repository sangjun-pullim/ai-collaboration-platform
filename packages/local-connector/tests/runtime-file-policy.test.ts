import test from "node:test";
import assert from "node:assert/strict";
import fsPromises, { link, symlink, writeFile, chmod, mkdir, rename, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { RuntimeFilePolicy, publicText } from "../src/runtime-file-policy.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

test("should refuse FIFO and opened descriptor or post-open path identity swaps", { timeout: 10000 }, async t => {
  const f = await runtimeFixture();
  try {
    const fifo = join(f.root, "synthetic.fifo");
    await promisify(execFile)("/usr/bin/mkfifo", [fifo], { env: {}, timeout: 2000 });
    await assert.rejects(RuntimeFilePolicy.select(f.root, ["synthetic.fifo"]), { code: "TOOL_REJECTED" });
  } finally { await f.close(); }
  for (const swap of ["opened-descriptor", "path-swap"]) {
    const g = await runtimeFixture(), target = join(g.root, "public.txt"), replacement = join(g.root, "replacement.txt");
    await writeFile(replacement, "Synthetic replacement evidence.\n", { mode: 0o644 });
    const original = fsPromises.open; let opened: FileHandle | undefined, swapped = false;
    const mocked = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
      if (String(args[0]) !== target || swapped) return original(...args);
      swapped = true;
      if (swap === "opened-descriptor") { opened = await original(replacement, args[1], args[2]); return opened; }
      opened = await original(...args); await rename(target, join(g.root, "parked.txt")); await rename(replacement, target); return opened;
    }); syncBuiltinESMExports();
    try { await assert.rejects(g.policy.read("public.txt"), { code: "SNAPSHOT_CHANGED" }); assert.equal(swapped, true); await assert.rejects(opened!.stat(), { code: "EBADF" }); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); await g.close(); }
  }
});

test("should read only selected unchanged text files through scoped tools", async () => {
  const f = await runtimeFixture(); try {
    assert.equal(await f.policy.read("public.txt"), "Selected public evidence.\n");
    for (const path of ["../public.txt", "/public.txt", "a//b", "a\\b", ".git/config", "credentials", "key.pem", "missing.txt"]) await assert.rejects(f.policy.read(path));
    await writeFile(join(f.root, "binary.txt"), Buffer.from([0, 0xff])); await assert.rejects(RuntimeFilePolicy.select(f.root, ["binary.txt"]));
    await writeFile(join(f.root, "secret.txt"), "password=synthetic-private-value"); await assert.rejects(RuntimeFilePolicy.select(f.root, ["secret.txt"]));
    await writeFile(join(f.root, "large.txt"), "x".repeat(65537)); await assert.rejects(RuntimeFilePolicy.select(f.root, ["large.txt"]));
    await symlink(join(f.root, "public.txt"), join(f.root, "link.txt")); await assert.rejects(RuntimeFilePolicy.select(f.root, ["link.txt"]));
    await link(join(f.root, "public.txt"), join(f.root, "hard.txt")); await assert.rejects(f.policy.read("public.txt"));
    await mkdir(join(f.root, "directory")); await assert.rejects(RuntimeFilePolicy.select(f.root, ["directory"]));
    await assert.rejects(RuntimeFilePolicy.select(f.root, Array.from({ length: 33 }, (_, i) => `file${i}`)));
  } finally { await f.close(); }
  const g = await runtimeFixture(); try {
    await writeFile(join(g.root, "public.txt"), "Changed evidence.\n"); await assert.rejects(g.policy.read("public.txt"), { code: "SNAPSHOT_CHANGED" });
    await chmod(join(g.root, "public.txt"), 0o666); await assert.rejects(RuntimeFilePolicy.select(g.root, ["public.txt"]));
    for (const text of ["Private root /Users/example", "secret-native-id", "credential=synthetic-secret-value", "Error: private provider failure"]) assert.throws(() => publicText(text, ["secret-native-id"]), { code: "PUBLIC_TEXT_REJECTED" });
    assert.equal(publicText("Public evidence."), "Public evidence.");
  } finally { await g.close(); }
});
