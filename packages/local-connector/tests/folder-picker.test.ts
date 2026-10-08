import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fsPromises, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickFolder,
  type FolderPickerExecute,
  type FolderPickerExecutionOptions,
} from "../src/settings/folder-picker.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "folder-picker-unit-"));
  const root = join(directory, "project ' ` $(synthetic) folder");
  await mkdir(root, { mode: 0o700 });
  return { directory, root, close: () => rm(directory, { recursive: true, force: true }) };
}

const selected =
  (path: string): FolderPickerExecute =>
  async () => ({ stdout: `${path}\n`, stderr: "" });
const rejected =
  (error: unknown): FolderPickerExecute =>
  async () => {
    throw error;
  };

test("should execute only fixed osascript arguments and return a validated folder identity", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const result = await pickFolder({
      timeoutMs: 1000,
      execute: async (file, args, options) => {
        calls++;
        assert.equal(file, "/usr/bin/osascript");
        assert.deepEqual(args, [
          "-e",
          [
            'set selectedFolder to POSIX path of (choose folder with prompt "Select a project folder for your AI")',
            'if selectedFolder ends with "/" and length of selectedFolder > 1 then set selectedFolder to text 1 thru -2 of selectedFolder',
            "return selectedFolder",
          ].join("\n"),
        ]);
        assert.equal(args.includes(f.root), false);
        assert.equal(options.encoding, "utf8");
        assert.equal(options.timeout, 1000);
        assert.equal(options.maxBuffer, 8192);
        assert.equal(options.killSignal, "SIGKILL");
        assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
        assert.equal(options.signal.aborted, false);
        return { stdout: `${f.root}\n`, stderr: "synthetic private credential" };
      },
    });
    const info = await lstat(f.root);
    assert.deepEqual(result, {
      status: "SELECTED",
      root: { path: f.root, dev: info.dev, ino: info.ino, uid: info.uid },
    });
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});

test("should return fixed cancellation denial timeout and failure states without raw errors", async () => {
  for (const [error, status] of [
    [{ stderr: "private path /Users/synthetic credential=secret (-128)" }, "CANCELLED"],
    [{ stderr: "Not authorized to send Apple events. (-1743)" }, "DENIED"],
    [{ stderr: "Privilege error (-10004)" }, "DENIED"],
    [{ code: "EACCES" }, "DENIED"],
    [{ code: "EPERM" }, "DENIED"],
    [{ code: "ABORT_ERR" }, "CANCELLED"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [{ killed: true, signal: "SIGKILL" }, "TIMEOUT"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "FAILED"],
    [{ stderr: "private path /Users/synthetic credential=secret" }, "FAILED"],
    [{ stderr: "x".repeat(8193) + "(-128)" }, "FAILED"],
  ] as const)
    assert.deepEqual(await pickFolder({ execute: rejected(error) }), { status });
});

test("should reject malformed multiple noncanonical and oversized selected paths", async () => {
  const f = await fixture();
  try {
    for (const stdout of [
      "",
      "relative",
      `${f.root}\nother`,
      `${f.root}\n\n`,
      `${f.root}\r\n`,
      `${f.root}\0`,
      `${f.root}/`,
      `${f.root}/../project`,
      `${f.root}//child`,
      "x".repeat(8193),
    ]) {
      assert.deepEqual(await pickFolder({ execute: async () => ({ stdout, stderr: "" }) }), {
        status: "FAILED",
      });
    }
    assert.deepEqual(await pickFolder({ execute: selected(join(f.directory, "missing")) }), {
      status: "FAILED",
    });
  } finally {
    await f.close();
  }
});

test("should reject symlink roots symlink ancestors protected roots and unsafe permissions", async () => {
  const f = await fixture();
  try {
    const link = join(f.directory, "link");
    await symlink(f.root, link);
    await mkdir(join(f.root, "child"));
    for (const path of [link, join(link, "child"), "/", "/usr", "/private/tmp"]) {
      assert.deepEqual(await pickFolder({ execute: selected(path) }), { status: "FAILED" });
    }
    await chmod(f.root, 0o777);
    assert.deepEqual(await pickFolder({ execute: selected(f.root) }), { status: "FAILED" });
  } finally {
    await f.close();
  }
});

test("should reject unsafe folder owners and map file policy permission errors to failed", async (t) => {
  const f = await fixture();
  const original = fsPromises.lstat;
  try {
    for (const mode of ["owner", "permission"] as const) {
      const mock = t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof lstat>) => {
        if (String(args[0]) !== f.root) return original(...args);
        if (mode === "permission")
          throw Object.assign(new Error("private path"), { code: "EACCES" });
        const info = await original(...args);
        return Object.assign(Object.create(info), { uid: Number(info.uid) + 1 });
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual(await pickFolder({ execute: selected(f.root) }), { status: "FAILED" });
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
      }
    }
  } finally {
    await f.close();
  }
});

test("should reject folder identity drift after initial validation", async (t) => {
  const f = await fixture();
  const original = RuntimeFilePolicy.root;
  const mock = t.mock.method(
    RuntimeFilePolicy,
    "root",
    async (...args: Parameters<typeof original>) => {
      const root = await original(...args);
      await rename(f.root, join(f.directory, "parked"));
      await mkdir(f.root, { mode: 0o700 });
      return root;
    },
  );
  try {
    assert.deepEqual(await pickFolder({ execute: selected(f.root) }), { status: "FAILED" });
  } finally {
    mock.mock.restore();
    await f.close();
  }
});

test("should avoid execution for invalid timeouts and an already aborted signal", async () => {
  let calls = 0;
  const execute: FolderPickerExecute = async () => {
    calls++;
    return { stdout: "/never", stderr: "" };
  };
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 120001])
    assert.deepEqual(await pickFolder({ timeoutMs, execute }), { status: "FAILED" });
  assert.deepEqual(await pickFolder({ signal: AbortSignal.abort(), execute }), {
    status: "CANCELLED",
  });
  assert.equal(calls, 0);
});

test("should cancel during execution and after an executor resolves", async () => {
  const controller = new AbortController();
  assert.deepEqual(
    await pickFolder({
      signal: controller.signal,
      execute: async (_file, _args, options) => {
        controller.abort();
        assert.equal(options.signal.aborted, true);
        throw Object.assign(new Error("private path"), { code: "ABORT_ERR" });
      },
    }),
    { status: "CANCELLED" },
  );
  const after = new AbortController();
  assert.deepEqual(
    await pickFolder({
      signal: after.signal,
      execute: async () => {
        after.abort();
        return { stdout: "/private/path", stderr: "" };
      },
    }),
    { status: "CANCELLED" },
  );
});

test("should abort the executor at the deadline and preserve the timeout state", async () => {
  let interrupted = false;
  const result = await pickFolder({
    timeoutMs: 10,
    execute: async (_file, _args, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            interrupted = true;
            reject(Object.assign(new Error("private credential"), { code: "ABORT_ERR" }));
          },
          { once: true },
        );
      }),
  });
  assert.deepEqual(result, { status: "TIMEOUT" });
  assert.equal(interrupted, true);
});

test("should avoid native execution on unsupported platforms", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
  try {
    assert.deepEqual(await pickFolder(), { status: "UNSUPPORTED" });
  } finally {
    Object.defineProperty(process, "platform", descriptor);
  }
});

test("should wait for the owned native child to close after abort", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
  const controller = new AbortController();
  const child = new EventEmitter();
  let closed = false;
  let finishChild: (() => void) | undefined;
  const mock = t.mock.method(
    childProcess,
    "execFile",
    (
      _file: string,
      _args: readonly string[],
      options: FolderPickerExecutionOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      options.signal.addEventListener(
        "abort",
        () => {
          callback(Object.assign(new Error("private path"), { code: "ABORT_ERR" }), "", "");
          finishChild = () => {
            closed = true;
            child.emit("close", null, "SIGKILL");
          };
        },
        { once: true },
      );
      return child;
    },
  );
  syncBuiltinESMExports();
  try {
    let settled = false;
    const result = pickFolder({ signal: controller.signal }).then((value) => {
      settled = true;
      return value;
    });
    controller.abort();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(closed, false);
    assert.ok(finishChild);
    finishChild();
    assert.deepEqual(await result, { status: "CANCELLED" });
    assert.equal(closed, true);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", descriptor);
  }
});

for (const [name, code, stderr, status] of [
  ["cancel", 1, "private diagnostic (-128)", "CANCELLED"],
  ["TCC denial", 1, "private diagnostic (-1743)", "DENIED"],
  ["privilege denial", 1, "private diagnostic (-10004)", "DENIED"],
  ["maxbuffer", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "private diagnostic (-128)", "FAILED"],
  ["oversized stderr", 1, "x".repeat(8193) + "(-128)", "FAILED"],
] as const) {
  for (const callbackFirst of [true, false])
    test(`should classify native callback ${name} only after ${callbackFirst ? "late close" : "late callback"}`, async (t) => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...descriptor, value: "darwin" });
      const child = new EventEmitter();
      const error = Object.assign(new Error("private diagnostic"), {
        code,
        killed: name === "maxbuffer",
        signal: name === "maxbuffer" ? "SIGKILL" : null,
      });
      assert.equal(Object.hasOwn(error, "stderr"), false);
      let callback!: (error: Error | null, stdout: string, stderr: string) => void;
      const mock = t.mock.method(
        childProcess,
        "execFile",
        (
          file: string,
          args: readonly string[],
          options: FolderPickerExecutionOptions,
          done: typeof callback,
        ) => {
          assert.equal(file, "/usr/bin/osascript");
          assert.equal(args[0], "-e");
          assert.equal(options.timeout, 120000);
          assert.equal(options.maxBuffer, 8192);
          assert.equal(options.killSignal, "SIGKILL");
          callback = done;
          return child;
        },
      );
      syncBuiltinESMExports();
      try {
        let settled = false;
        const result = pickFolder().then((value) => {
          settled = true;
          return value;
        });
        if (callbackFirst) callback(error, "", stderr);
        else child.emit("close", 1, null);
        await Promise.resolve();
        assert.equal(settled, false);
        if (callbackFirst) child.emit("close", 1, null);
        else callback(error, "", stderr);
        assert.deepEqual(await result, { status });
        assert.equal(JSON.stringify(await result).includes("private diagnostic"), false);
        assert.equal(Object.hasOwn(error, "stderr"), false);
      } finally {
        mock.mock.restore();
        syncBuiltinESMExports();
        Object.defineProperty(process, "platform", descriptor);
      }
    });
}
