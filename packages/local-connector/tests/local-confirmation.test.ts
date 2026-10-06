import test from "node:test";
import assert from "node:assert/strict";
import { rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { confirmLocalScope } from "../src/settings/local-confirmation.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import type { FolderPickerExecute } from "../src/settings/folder-picker.ts";

const output = (root: string, handoff = "Shared evidence.") =>
  `Repository\u001e${handoff}\u001e${join(root, "public.txt")}\n`;
test("should use fixed argv and keep the local root out of the AppleScript source", async () => {
  const f = await runtimeFixture();
  try {
    const execute: FolderPickerExecute = async (file, args, options) => {
      assert.equal(file, "/usr/bin/osascript");
      assert.equal(args[0], "-e");
      assert.equal(args[2], f.root);
      assert.equal(args.length, 3);
      assert.equal(args[1].includes(f.root), false);
      assert.equal(args[1].includes("on run argv"), true);
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" });
      assert.equal(options.killSignal, "SIGKILL");
      assert.equal(options.timeout, 120000);
      return { stdout: output(f.root), stderr: "" };
    };
    const selected = await confirmLocalScope(f.policy.root, { execute });
    assert.equal(selected.confirmed, true);
    if (selected.confirmed) {
      assert.equal(selected.repositoryAlias, "Repository");
      assert.deepEqual(selected.files, f.policy.files);
      assert.equal(selected.handoff, "Shared evidence.");
    }
  } finally {
    await f.close();
  }
});

test("should preserve an optional empty public description", async () => {
  const f = await runtimeFixture();
  try {
    const choice = await confirmLocalScope(f.policy.root, {
      execute: async () => ({ stdout: output(f.root, ""), stderr: "" }),
    });
    assert.equal(choice.confirmed, true);
    if (choice.confirmed) assert.equal(choice.handoff, "");
  } finally {
    await f.close();
  }
});

test("should reject paths outside the confirmed root and protected private files", async () => {
  const f = await runtimeFixture();
  try {
    await writeFile(join(f.directory, "outside.txt"), "Outside");
    await writeFile(join(f.root, ".env"), "PRIVATE=value");
    await symlink(join(f.directory, "outside.txt"), join(f.root, "linked.txt"));
    for (const path of [
      join(f.directory, "outside.txt"),
      join(f.root, ".env"),
      join(f.root, "linked.txt"),
      "relative.txt",
    ]) {
      const choice = await confirmLocalScope(f.policy.root, {
        execute: async () => ({
          stdout: `Repository\u001eShared evidence.\u001e${path}\n`,
          stderr: "",
        }),
      });
      assert.deepEqual(choice, { confirmed: false });
    }
  } finally {
    await f.close();
  }
});

test("should reject unsafe aliases raw errors secrets duplicate files and oversized output", async () => {
  const f = await runtimeFixture();
  try {
    for (const stdout of [
      output(f.root).replace("Repository", "../private"),
      output(f.root, `Local root ${f.root}`),
      output(f.root, "api_key=private-secret-material"),
      output(f.root, "Error: private provider details"),
      output(f.root) + `${join(f.root, "public.txt")}\n`,
      output(f.root) + "\u001e",
      "x".repeat(65537),
      output(f.root) + "\0",
    ])
      assert.deepEqual(
        await confirmLocalScope(f.policy.root, { execute: async () => ({ stdout, stderr: "" }) }),
        { confirmed: false },
      );
  } finally {
    await f.close();
  }
});

test("should return a fixed cancelled result without exposing native permission errors", async () => {
  const f = await runtimeFixture();
  try {
    for (const error of [
      { code: "EPERM", stderr: f.root },
      { code: "ABORT_ERR", stderr: "credential=private" },
      { code: 1, stderr: "User cancelled (-128)" },
    ]) {
      assert.deepEqual(
        await confirmLocalScope(f.policy.root, {
          execute: async () => {
            throw error;
          },
        }),
        { confirmed: false },
      );
    }
  } finally {
    await f.close();
  }
});

test("should refuse a changed root before launching the native dialog", async () => {
  const f = await runtimeFixture();
  try {
    await rename(f.root, join(f.directory, "renamed"));
    let calls = 0;
    assert.deepEqual(
      await confirmLocalScope(f.policy.root, {
        execute: async () => {
          calls++;
          return { stdout: "", stderr: "" };
        },
      }),
      { confirmed: false },
    );
    assert.equal(calls, 0);
  } finally {
    await f.close();
  }
});

test("should not launch a pre-aborted dialog and await an interrupted dialog's cleanup", async () => {
  const f = await runtimeFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    assert.deepEqual(
      await confirmLocalScope(f.policy.root, {
        signal: controller.signal,
        execute: async () => {
          calls++;
          throw new Error();
        },
      }),
      { confirmed: false },
    );
    assert.equal(calls, 0);
    const active = new AbortController();
    let cleaned = false;
    const choice = await confirmLocalScope(f.policy.root, {
      signal: active.signal,
      execute: async (_file, _args, options) => {
        active.abort();
        assert.equal(options.signal.aborted, true);
        await new Promise((resolve) => setTimeout(resolve, 5));
        cleaned = true;
        return { stdout: output(f.root), stderr: "" };
      },
    });
    assert.equal(cleaned, true);
    assert.deepEqual(choice, { confirmed: false });
  } finally {
    await f.close();
  }
});

test("should explicitly approve automatic repository scope without choosing files", async () => {
  const f = await runtimeFixture();
  try {
    const choice = await confirmLocalScope(f.policy.root, {
      execute: async (_file, args) => {
        assert.equal(args[1].includes("choose file with prompt"), false);
        assert.equal(args[1].includes("경로"), true);
        return { stdout: "Repository\u001eShared evidence.\u001eAUTO_CODE\n", stderr: "" };
      },
    });
    assert.equal(choice.confirmed, true);
    if (choice.confirmed) {
      assert.deepEqual(choice.files, []);
      assert.equal(choice.readMode, "AUTO_CODE");
    }
    for (const token of ["", "AUTO", "AUTO_CODE\nambiguous"])
      assert.deepEqual(
        await confirmLocalScope(f.policy.root, {
          execute: async () => ({
            stdout: `Repository\u001eShared evidence.\u001e${token}`,
            stderr: "",
          }),
        }),
        { confirmed: false },
      );
  } finally {
    await f.close();
  }
});
