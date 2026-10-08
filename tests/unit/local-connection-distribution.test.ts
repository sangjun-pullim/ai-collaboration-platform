import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
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
import { promisify } from "node:util";

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connection-distribution-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "packages/local-connector/src"), { recursive: true });
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/local-connection-bootstrap.sh"), "#!/bin/bash\nexit 0\n");
  const build = (await import(pathToFileURL(resolve("scripts/build-local-connection.mjs")).href))
    .buildLocalConnection;
  return {
    root,
    build,
    compiler: async (_root: string, out: string) => {
      await mkdir(join(out, "src"));
      await writeFile(
        join(out, "src/cli.js"),
        'import {answer} from "./answer.js"; process.stdout.write(JSON.stringify({answer,modelInputs:0}));',
      );
      await writeFile(
        join(out, "src/answer.js"),
        'import {basename} from "node:path"; export const answer = basename("/repo/ready");',
      );
    },
  };
}

test("should include transitive production modules without tests or private files", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "packages/local-connector/src/private.env"), "private-marker");
  const manifest = await f.build(f);
  const file = join(f.root, "public", manifest.code.path);
  const bytes = await readFile(file);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.code.sha256);
  assert.equal(bytes.length, manifest.code.bytes);
  const { stdout } = await promisify(execFile)("/usr/bin/tar", ["-tzf", file]);
  assert.deepEqual(stdout.trim().split("\n"), ["package.json", "src/answer.js", "src/cli.js"]);
  const again = await f.build(f);
  assert.deepEqual(again, manifest);
});

test("should run an isolated distribution without checkout or npm installation", async (t) => {
  const f = await fixture(t);
  const m = await f.build(f);
  const unpacked = join(f.root, "unpacked");
  await mkdir(unpacked);
  await promisify(execFile)("/usr/bin/tar", [
    "-xzf",
    join(f.root, "public", m.code.path),
    "-C",
    unpacked,
  ]);
  const { stdout } = await promisify(execFile)(process.execPath, [join(unpacked, "src/cli.js")], {
    cwd: unpacked,
    env: {},
  });
  assert.deepEqual(JSON.parse(stdout), { answer: "ready", modelInputs: 0 });
  assert.ok(!(await readdir(unpacked)).includes("node_modules"));
});

test("should refuse symlinks and external runtime dependencies before publishing", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "private.ts"), "private-marker");
  await symlink(join(f.root, "private.ts"), join(f.root, "packages/local-connector/src/linked.ts"));
  await assert.rejects(f.build(f), /DISTRIBUTION_SYMLINK/);
  await rm(join(f.root, "packages/local-connector/src/linked.ts"));
  await assert.rejects(
    f.build({
      ...f,
      compiler: async (_root: string, out: string) => {
        await mkdir(join(out, "src"));
        await writeFile(join(out, "src/cli.js"), 'import "untrusted-package";');
      },
    }),
    /DISTRIBUTION_DEPENDENCY/,
  );
  await assert.rejects(readFile(join(f.root, "public/local-connection/manifest.json")));
});

test("should publish the manifest only after complete assets", async (t) => {
  const f = await fixture(t);
  const first = await f.build(f);
  await assert.rejects(
    f.build({
      ...f,
      compiler: async () => {
        throw new Error("compiler-failed");
      },
    }),
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "public/local-connection/manifest.json"), "utf8")),
    first,
  );
  assert.equal(
    (await readdir(join(f.root, "public/local-connection"))).filter((name) => name.endsWith(".tmp"))
      .length,
    0,
  );
});

test("should refuse symlinked ancestors and leave the previous manifest intact", async (t) => {
  const f = await fixture(t);
  const first = await f.build(f);
  const output = join(f.root, "public/local-connection");
  await rm(join(f.root, "packages/local-connector"), { recursive: true });
  const other = join(f.root, "other");
  await mkdir(join(other, "src"), { recursive: true });
  await symlink(other, join(f.root, "packages/local-connector"));
  await assert.rejects(f.build(f), /DISTRIBUTION_SYMLINK/);
  assert.deepEqual(JSON.parse(await readFile(join(output, "manifest.json"), "utf8")), first);
  await rm(join(f.root, "packages/local-connector"));
  await mkdir(join(f.root, "packages/local-connector/src"), { recursive: true });
  await rm(join(f.root, "public"), { recursive: true });
  await mkdir(join(f.root, "external"));
  await symlink(join(f.root, "external"), join(f.root, "public"));
  await assert.rejects(f.build(f), /DISTRIBUTION_SYMLINK/);
  assert.deepEqual(await readdir(join(f.root, "external")), []);
});
