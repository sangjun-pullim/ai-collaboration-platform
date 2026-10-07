import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../src/state-store.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

/** OS trust and CLI metadata are mocked; this fixture is never real publisher/model evidence. */
export async function nativeFixture(t: TestContext) {
  const f = await runtimeFixture();
  const home = join(f.directory, "native-home");
  const config = join(home, ".claude");
  const bin = join(home, ".local", "bin");
  const versions = join(home, ".local", "share", "claude", "versions");
  for (const path of [config, bin, versions]) await mkdir(path, { recursive: true, mode: 0o700 });
  const executable = join(versions, "2.1.288");
  await writeFile(executable, "synthetic native bytes; do not execute\n", { mode: 0o700 });
  await symlink(executable, join(bin, "claude"));
  const personal = {
    model: "claude-test",
    effortLevel: "medium",
    hooks: {},
    enabledPlugins: { "personal@catalog": true },
    permissions: { allow: ["Bash(*)"] },
    env: { CLAUDE_CODE_SUBAGENT_MODEL: "claude-test" },
  };
  const global = {
    numStartups: 1,
    cachedStatsigGates: { example: true },
    oauthAccount: { accountUuid: "account-1", organizationUuid: "org-1", profileFetchedAt: 1 },
    projects: { [f.root]: { lastCost: 1, hasTrustDialogAccepted: true, mcpServers: {} } },
  };
  const settingsPath = join(config, "settings.json");
  const globalPath = join(home, ".claude.json");
  await writeFile(settingsPath, JSON.stringify(personal), { mode: 0o600 });
  await writeFile(globalPath, JSON.stringify(global), { mode: 0o600 });
  const state = {
    signature: true,
    version: "2.1.288 (Claude Code)\n",
    managed: false,
    managedPath: "",
    defaultsError: false,
    auth: {
      loggedIn: true,
      authMethod: "claude.ai",
      subscriptionType: "max",
      apiProvider: "firstParty",
      configDirectory: config,
      projectsDirectory: join(config, "projects"),
      email: "fixture@example.invalid",
    },
    beforeAuthReply: () => {},
  };
  const probes: { executable: string; args: string[] }[] = [];
  const originalStat = fs.lstatSync;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  t.mock.method(os, "homedir", () => home);
  t.mock.method(fs, "lstatSync", (path: fs.PathLike, options?: unknown) => {
    const value = String(path);
    if (value === state.managedPath) return originalStat(config);
    if (value.startsWith("/Library/")) {
      const error = new Error("synthetic absent system source") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return originalStat(path, options as undefined);
  });
  t.mock.method(childProcess, "execFile", (...args: unknown[]) => {
    const executable = String(args[0]);
    const values = args[1] as string[];
    const options = args[2] as { timeout: number; maxBuffer: number };
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void;
    assert.equal(options.timeout, 5000);
    assert.equal(options.maxBuffer, 256 * 1024);
    probes.push({ executable, args: [...values] });
    let stdout = "",
      stderr = "",
      error: (Error & { code: number }) | null = null;
    const failed = (message: string) => Object.assign(new Error(message), { code: 1 });
    if (executable === "/usr/bin/codesign") {
      assert.ok(values[3].includes("com.anthropic.claude-code"));
      assert.equal(values.at(-1), join(versions, "2.1.288"));
      if (!state.signature) {
        error = failed("synthetic publisher rejected");
        stderr = "synthetic rejected";
      }
    } else if (executable === "/usr/bin/defaults") {
      assert.deepEqual(values, ["read", "com.anthropic.claudecode"]);
      if (state.managed) stdout = "{managedPolicy = 1;}";
      else {
        error = failed("synthetic absent domain");
        stderr = state.defaultsError
          ? "Permission denied"
          : "Domain com.anthropic.claudecode does not exist";
      }
    } else {
      assert.equal(executable, join(versions, "2.1.288"));
      if (values.length === 1 && values[0] === "--version") stdout = state.version;
      else {
        assert.deepEqual(values, ["auth", "status"]);
        state.beforeAuthReply();
        stdout = JSON.stringify(state.auth);
      }
    }
    queueMicrotask(() => callback(error, stdout, stderr));
    return {};
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  });
  t.after(() => f.close());
  return {
    ...f,
    home,
    config,
    executable,
    settingsPath,
    globalPath,
    personal,
    global,
    state,
    probes,
    profile: new StateStore(f.stateDir, "native"),
    json: (path: string, value: unknown) => writeFile(path, JSON.stringify(value), { mode: 0o600 }),
  };
}
