import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeFixture } from "./runtime-fixture.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import { RuntimeError, digest, stableJson, type FileSnapshot } from "../src/runtime-contracts.ts";
import {
  collectSourceObservation,
  validSourceObservation,
  sourceObservationReserveBytes,
  type SourceGitExecutor,
} from "../src/workflow/source-snapshot.ts";
const execute = promisify(execFile);
const hash = "a".repeat(40);
const signal = () => new AbortController().signal;
const collect = (f: Awaited<ReturnType<typeof runtimeFixture>>, run?: SourceGitExecutor) =>
  collectSourceObservation(f.context.root, f.settings.files, () => {}, signal(), run);
const noGit: SourceGitExecutor = async () => {
  throw new Error("no git");
};

test("should collect actual permitted Git metadata including detached and containing repository roots", async () => {
  const f = await runtimeFixture();
  try {
    const env = {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (...args: string[]) => execute("/usr/bin/git", ["-C", f.root, ...args], { env });
    await git("init", "-b", "fixture-main");
    await git("add", "public.txt");
    await git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    );
    const first = await collect(f);
    assert.match(first.git.commit!, /^[a-f0-9]{40}$/);
    assert.equal(first.git.ref, "fixture-main");
    assert.equal(first.git.dirty, "unknown");
    await mkdir(join(f.root, "nested"));
    await writeFile(join(f.root, "nested", "file.txt"), "nested evidence");
    const policy = await RuntimeFilePolicy.select(join(f.root, "nested"), ["file.txt"]);
    const nested = await collectSourceObservation(policy.root, policy.files, () => {}, signal());
    assert.equal(nested.git.commit, first.git.commit);
    assert.deepEqual(nested.files.entries, [{ path: "file.txt", hash: digest("nested evidence") }]);
    await git("-c", "core.hooksPath=/dev/null", "checkout", "--detach");
    const detached = await collect(f);
    assert.equal(detached.git.commit, first.git.commit);
    assert.equal(detached.git.ref, null);
  } finally {
    await f.close();
  }
});

test("should bound commands and keep failed Git metadata unknown without private source", async () => {
  const f = await runtimeFixture();
  try {
    let calls = 0;
    const result = await collect(f, async (command, args, options) => {
      calls++;
      assert.equal(command, "/usr/bin/git");
      assert.ok(args.includes("protocol.allow=never"));
      assert.ok(args.includes("core.fsmonitor=false"));
      assert.ok(args.includes("core.hooksPath=/dev/null"));
      assert.ok(args.includes("core.attributesFile=/dev/null"));
      assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
      assert.equal(options.env.GIT_ALLOW_PROTOCOL, "");
      assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(options.maxBuffer, 4096);
      assert.ok(options.timeout <= 2000 && options.timeout > 0);
      assert.equal(options.cwd, f.root);
      return { stdout: args.includes("symbolic-ref") ? "bad ref\n" : hash };
    });
    assert.equal(calls, 3);
    assert.equal(result.git.commit, hash);
    assert.equal(result.git.ref, null);
    assert.equal(validSourceObservation(result), true);
    const serialized = JSON.stringify(result);
    for (const secret of [f.root, "dev", "ino", "mtime", "Selected public evidence", "threadId"])
      assert.equal(serialized.includes(secret), false);
    assert.equal((await collect(f)).git.commit, null);
    for (const outputs of [
      ["b".repeat(40), "main", hash],
      ["A".repeat(40), "main", "A".repeat(40)],
      ["a".repeat(4097), "main", "a".repeat(4097)],
    ]) {
      let index = 0;
      const unknown = await collect(f, async () => ({ stdout: outputs[index++] }));
      assert.equal(unknown.git.commit, null);
      assert.equal(unknown.git.ref, null);
    }
    assert.equal((await collect(f, noGit)).git.commit, null);
  } finally {
    await f.close();
  }
});

test("should reject root replacement before any child and between children", async () => {
  for (const before of [true, false]) {
    const f = await runtimeFixture();
    let calls = 0;
    try {
      const replace = async () => {
        await rename(f.root, `${f.root}.saved`);
        await mkdir(f.root);
      };
      if (before) await replace();
      await assert.rejects(
        collect(f, async () => {
          calls++;
          await replace();
          return { stdout: hash };
        }),
        { code: "SNAPSHOT_CHANGED" },
      );
      assert.equal(calls, before ? 0 : 1);
    } finally {
      await f.close();
    }
  }
});

test("should reject permission file and authority changes instead of treating them as Git failure", async () => {
  for (const mutation of ["file", "mode", "authority", "abort"]) {
    const f = await runtimeFixture();
    const controller = new AbortController();
    let lost = false,
      calls = 0;
    try {
      await assert.rejects(
        collectSourceObservation(
          f.context.root,
          f.settings.files,
          () => {
            if (lost) throw new RuntimeError("AUTHORITY_LOST");
          },
          controller.signal,
          async () => {
            calls++;
            if (mutation === "file") await writeFile(join(f.root, "public.txt"), "changed");
            if (mutation === "mode") await chmod(f.root, 0o777);
            if (mutation === "authority") lost = true;
            if (mutation === "abort") controller.abort();
            return { stdout: hash };
          },
        ),
        {
          code: mutation === "file" || mutation === "mode" ? "SNAPSHOT_CHANGED" : "AUTHORITY_LOST",
        },
      );
      assert.equal(calls, mutation === "file" ? 3 : 1);
    } finally {
      await f.close();
    }
  }
});

test("should abort the owned Git child at the shared deadline and preserve selected files", async () => {
  const f = await runtimeFixture();
  let calls = 0,
    aborted = false;
  try {
    const result = await collect(f, async (_command, _args, options) => {
      calls++;
      await new Promise<void>((resolve) =>
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      throw new Error("timeout");
    });
    assert.equal(aborted, true);
    assert.equal(calls, 1);
    assert.equal(result.git.commit, null);
    assert.equal(result.files.entries[0].hash, f.settings.files[0].hash);
  } finally {
    await f.close();
  }
});

test("should validate exact ordered manifests hashes timestamps and bounds with sufficient escaped reservation", async () => {
  const f = await runtimeFixture();
  try {
    const value = await collect(f, noGit);
    const seal = (v: typeof value) => {
      v.files.manifestHash = digest(stableJson(v.files.entries));
      const { observationHash: previousHash, ...body } = v;
      void previousHash;
      v.observationHash = digest(stableJson(body));
      return v;
    };
    for (const mutate of [
      (v: typeof value) => Object.assign(v, { root: "private" }),
      (v: typeof value) => Object.assign(v.git, { extra: true }),
      (v: typeof value) => {
        v.git.observedAt = "2026-02-30T00:00:00.000Z";
      },
      (v: typeof value) => {
        v.git.commit = "F".repeat(40);
      },
      (v: typeof value) => {
        v.git.ref = "x".repeat(121);
      },
      (v: typeof value) => {
        v.files.entries.push({ ...v.files.entries[0] });
        seal(v);
      },
      (v: typeof value) => {
        v.files.entries = [
          { path: "z", hash: hash.padEnd(64, "a") },
          { path: "a", hash: hash.padEnd(64, "a") },
        ];
        seal(v);
      },
      (v: typeof value) => {
        v.files.manifestHash = "b".repeat(64);
      },
      (v: typeof value) => {
        v.observationHash = "b".repeat(64);
      },
      (v: typeof value) => {
        v.files.entries[0].path = "../outside";
        seal(v);
      },
      (v: typeof value) => {
        v.files.entries = Array.from({ length: 33 }, (_, i) => ({
          path: String(i).padStart(2, "0"),
          hash: "a".repeat(64),
        }));
        seal(v);
      },
    ]) {
      const bad = structuredClone(value);
      mutate(bad);
      assert.equal(validSourceObservation(bad), false);
    }
    const files = Array.from({ length: 32 }, (_, i) => ({
      ...f.settings.files[0],
      path: `${String(i).padStart(2, "0")}${"\u0001".repeat(510)}`,
    }));
    value.files.entries = files.map(({ path, hash }) => ({ path, hash }));
    value.git.commit = "a".repeat(64);
    value.git.ref = "x".repeat(120);
    seal(value);
    assert.equal(validSourceObservation(value), true);
    assert.ok(
      Buffer.byteLength(',"sourceObservation":' + JSON.stringify(value)) <=
        sourceObservationReserveBytes(files),
    );
    assert.ok(sourceObservationReserveBytes([]) < sourceObservationReserveBytes(files));
    assert.ok(sourceObservationReserveBytes(files) < 128 * 1024);
    const malformed = files as FileSnapshot[];
    malformed[0].path = "x".repeat(129 * 1024);
    value.files.entries = malformed.map(({ path, hash }) => ({ path, hash }));
    seal(value);
    assert.equal(validSourceObservation(value), false);
  } finally {
    await f.close();
  }
});
