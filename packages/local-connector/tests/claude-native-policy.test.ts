import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createProviderAdapter } from "../src/provider-adapter.ts";
import { NativeClaudePolicy } from "../src/claude/native-policy.ts";
import { nativeIdentity, OWNED_SERVER } from "../src/claude/input-proof.ts";
import {
  assertNativeInstallation,
  verifyNativeInstallation,
} from "../src/claude/native-installation.ts";
import { digest, type OwnedContext, type RuntimeSettings } from "../src/runtime-contracts.ts";
import { nativeToolNames } from "../src/workspace/tool-contracts.ts";
import { FakeTransport } from "./claude-runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { nativeFixture } from "./claude-native-fixture.ts";
import { uuid } from "./runtime-fixture.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

test("should admit a verified native Claude installation through the default factory", async (t) => {
  const f = await nativeFixture(t);
  const native = new FakeTransport();
  const launches: import("../src/claude/transport.ts").Launch[] = [];
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    claude: {
      environment: {},
      transport(launch) {
        launches.push(launch);
        return native;
      },
    },
  });
  try {
    const before = await readFile(f.settingsPath);
    const capability = await adapter.capabilities(f.root, () => {});
    assert.equal(capability.policy, "CONFIRMED");
    assert.equal(capability.version, "2.1.288");
    assert.equal(launches[0].executable, f.executable);
    assert.equal(launches[0].args[0], "--print");
    assert.equal(native.writes.length, 0);
    assert.equal(f.probes.filter((probe) => probe.executable === "/usr/bin/codesign").length, 1);
    assert.deepEqual(await readFile(f.settingsPath), before);
  } finally {
    await adapter.close();
  }
});

test("should ignore AGENTS sources while their builtin reader is disabled", async (t) => {
  const f = await nativeFixture(t);
  const target = join(f.home, "codex-only.md");
  await writeFile(target, "Codex-only synthetic instructions\n", { mode: 0o600 });
  await symlink(target, join(f.root, "AGENTS.md"));
  const policy = new NativeClaudePolicy({});
  await policy.admit(f.root, () => {});
  assert.notEqual(policy.fingerprint, "0".repeat(64));
});

test("should admit the reviewed updated native version without changing personal files", async (t) => {
  const f = await nativeFixture(t);
  const updated = join(dirname(f.executable), "2.1.293");
  await writeFile(updated, "synthetic updated native bytes; do not execute\n", { mode: 0o700 });
  await unlink(join(f.home, ".local", "bin", "claude"));
  await symlink(updated, join(f.home, ".local", "bin", "claude"));
  f.state.installationVersion = "2.1.293";
  f.state.version = "2.1.293 (Claude Code)\n";
  const before = await readFile(f.settingsPath);
  const policy = new NativeClaudePolicy({});
  await policy.admit(f.root, () => {});
  assert.equal(policy.version, "2.1.293");
  const context = claudeRecord(f.record).context!;
  context.provider = "claude";
  context.ownedTurns = [];
  context.materialization = {
    state: "RESERVED",
    version: policy.version,
    policyFingerprint: policy.fingerprint,
    initHash: null,
  };
  const launch = policy.launch(context, null, nativeToolNames("SELECTED", false), false);
  assert.equal(launch.executable, updated);
  assert.equal(launch.args[launch.args.indexOf("--session-id") + 1], context.threadId);
  assert.deepEqual(await readFile(f.settingsPath), before);
  assert.equal(fs.realpathSync(join(f.home, ".local", "bin", "claude")), updated);
});

test("should reject an unreviewed updated native version before probes or model input", async (t) => {
  const f = await nativeFixture(t);
  const updated = join(dirname(f.executable), "2.1.294");
  await writeFile(updated, "synthetic unreviewed bytes; do not execute\n", { mode: 0o700 });
  await unlink(join(f.home, ".local", "bin", "claude"));
  await symlink(updated, join(f.home, ".local", "bin", "claude"));
  const policy = new NativeClaudePolicy({});
  await assert.rejects(
    policy.admit(f.root, () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(f.probes.length, 0);
});

for (const failure of [
  "publisher",
  "version",
  "managed domain",
  "managed error",
  "local policy",
  "login",
  "team",
  "api",
  "config",
] as const) {
  test(`should reject unverified ${failure} before catalog creation or model input`, async (t) => {
    const f = await nativeFixture(t);
    if (failure === "publisher") f.state.signature = false;
    if (failure === "version") f.state.version = "2.1.289 (Claude Code)\n";
    if (failure === "managed domain") f.state.managed = true;
    if (failure === "managed error") f.state.defaultsError = true;
    if (failure === "local policy")
      f.state.managedPath = "/Library/Application Support/ClaudeCode/managed-settings.d";
    if (failure === "login") f.state.auth.loggedIn = false;
    if (failure === "team") f.state.auth.subscriptionType = "team";
    if (failure === "api") f.state.auth.authMethod = "api-key";
    if (failure === "config") f.state.auth.configDirectory = join(f.directory, "other-profile");
    let children = 0,
      reservations = 0;
    const adapter = createProviderAdapter("claude", {
      profile: f.profile,
      reserveCatalog: async () => {
        reservations++;
        return f.record.context!;
      },
      claude: {
        environment: {},
        transport() {
          children++;
          return new FakeTransport();
        },
      },
    });
    try {
      await assert.rejects(
        adapter.capabilities(f.root, () => {}),
        { code: "POLICY_UNCONFIRMED" },
      );
      assert.deepEqual({ children, reservations }, { children: 0, reservations: 0 });
      if (failure === "publisher") assert.equal(f.probes.length, 1);
    } finally {
      await adapter.close();
    }
  });
}

async function admittedFixture(t: import("node:test").TestContext) {
  const f = await nativeFixture(t);
  const policy = new NativeClaudePolicy({
    CLAUDE_CODE_EFFORT_LEVEL: "medium",
    LOCAL_AUTH_TOKEN: "must-strip",
  });
  await policy.admit(f.root, () => {});
  const record = claudeRecord(f.record);
  const context: OwnedContext = record.context!;
  context.materialization!.version = "2.1.288";
  context.materialization!.policyFingerprint = policy.fingerprint;
  const settings: RuntimeSettings = record.settings!;
  return { ...f, policy, context, settings };
}

test("should preserve personal settings while applying only task read-only overrides", async (t) => {
  const f = await admittedFixture(t);
  const before = await readFile(f.settingsPath);
  const tools = nativeToolNames("SELECTED", false);
  const launch = f.policy.launch(f.context, f.settings, tools, false);
  const overlay = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]);
  assert.equal(launch.executable, f.executable);
  assert.equal(launch.args[0], "--print");
  assert.equal(launch.args[launch.args.indexOf("--setting-sources") + 1], "user,project,local");
  assert.equal(launch.args[launch.args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
  assert.ok(launch.args.includes("--strict-mcp-config"));
  assert.equal(overlay.disableAllHooks, true);
  assert.equal(overlay.enabledPlugins["personal@catalog"], false);
  assert.equal(overlay.enabledPlugins["cc-plugin-agents-md@builtin"], false);
  assert.equal(overlay.enabledPlugins["cc-plugin-telemetry@builtin"], false);
  assert.equal(launch.env.LOCAL_AUTH_TOKEN, undefined);
  assert.ok(!launch.args.includes("--effort"));
  assert.equal(launch.env.CLAUDE_CODE_EFFORT_LEVEL, "medium");
  f.settings.requested.effort = "high";
  const selected = f.policy.launch(f.context, f.settings, tools, true);
  assert.equal(selected.args[selected.args.indexOf("--effort") + 1], "high");
  assert.equal(selected.args[selected.args.indexOf("--resume") + 1], f.context.threadId);
  assert.ok(!selected.args.includes("--session-id"));
  assert.deepEqual(await readFile(f.settingsPath), before);
});

test("should ignore native bookkeeping refresh and retain account and execution drift detection", async (t) => {
  const f = await admittedFixture(t);
  const fingerprint = f.policy.fingerprint;
  f.global.numStartups++;
  f.global.cachedStatsigGates.example = false;
  f.global.oauthAccount.profileFetchedAt++;
  f.global.projects[f.root].lastCost++;
  await f.json(f.globalPath, f.global);
  f.policy.assertLive(f.root, () => {});
  assert.equal(f.policy.fingerprint, fingerprint);
  f.global.oauthAccount.organizationUuid = "other-org";
  await f.json(f.globalPath, f.global);
  assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
});

test("should retain the live fingerprint when only the additional model cache timestamp refreshes", async (t) => {
  const f = await nativeFixture(t);
  const global = { ...f.global, additionalModelOptionsAnsweredAt: 1 };
  await f.json(f.globalPath, global);
  const policy = new NativeClaudePolicy({});
  await policy.admit(f.root, () => {});
  const fingerprint = policy.fingerprint;
  const settings = await readFile(f.settingsPath);
  const probes = f.probes.length;
  global.additionalModelOptionsAnsweredAt = 2;
  await f.json(f.globalPath, global);
  policy.assertLive(f.root, () => {});
  assert.equal(policy.fingerprint, fingerprint);
  assert.equal(f.probes.length, probes);
  assert.deepEqual(await readFile(f.settingsPath), settings);
});

test("should retain the live fingerprint when the additional model cache and timestamp refresh together", async (t) => {
  const f = await nativeFixture(t);
  const global = {
    ...f.global,
    additionalModelOptionsCache: { models: ["synthetic-model-one"] },
    additionalModelOptionsAnsweredAt: 1,
  };
  await f.json(f.globalPath, global);
  const policy = new NativeClaudePolicy({});
  await policy.admit(f.root, () => {});
  const fingerprint = policy.fingerprint;
  global.additionalModelOptionsCache.models = ["synthetic-model-two"];
  global.additionalModelOptionsAnsweredAt = 2;
  await f.json(f.globalPath, global);
  policy.assertLive(f.root, () => {});
  assert.equal(policy.fingerprint, fingerprint);
});

test("should keep authority and unknown native settings pinned across model cache timestamp refresh", async (t) => {
  for (const change of [
    "MCP authorization token",
    "account",
    "organization",
    "permissions",
    "MCP endpoint",
    "unknown setting",
    "unknown timestamp key",
  ] as const) {
    await t.test(`should reject ${change} drift with SNAPSHOT_CHANGED`, async (t) => {
      const f = await nativeFixture(t);
      const global = {
        ...f.global,
        additionalModelOptionsAnsweredAt: 1,
        additionalModelOptionsAnsweredAtUnknown: 1,
        unknownSetting: { enabled: true },
        permissions: { allow: ["Read"] },
        mcpServers: {
          fixture: {
            type: "http",
            url: "https://fixture.example.invalid/mcp",
            headers: { Authorization: "Bearer synthetic-token-one" },
          },
        },
      };
      await f.json(f.globalPath, global);
      const policy = new NativeClaudePolicy({});
      await policy.admit(f.root, () => {});
      const fingerprint = policy.fingerprint;
      const probes = f.probes.length;
      global.additionalModelOptionsAnsweredAt = 2;
      await f.json(f.globalPath, global);
      policy.assertLive(f.root, () => {});
      assert.equal(policy.fingerprint, fingerprint);
      if (change === "MCP authorization token")
        global.mcpServers.fixture.headers.Authorization = "Bearer synthetic-token-two";
      if (change === "account") global.oauthAccount.accountUuid = "different-account";
      if (change === "organization") global.oauthAccount.organizationUuid = "different-org";
      if (change === "permissions") global.permissions.allow.push("Write");
      if (change === "MCP endpoint")
        global.mcpServers.fixture.url = "https://other.example.invalid/mcp";
      if (change === "unknown setting") global.unknownSetting.enabled = false;
      if (change === "unknown timestamp key") global.additionalModelOptionsAnsweredAtUnknown = 2;
      await f.json(f.globalPath, global);
      assert.throws(() => policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
      assert.equal(f.probes.length, probes);
    });
  }
});

test("should reject account status changes before a new catalog or input", async (t) => {
  const f = await admittedFixture(t);
  f.state.auth.email = "different@example.invalid";
  await assert.rejects(
    f.policy.admit(f.root, () => {}),
    { code: "SNAPSHOT_CHANGED" },
  );
});

test("should reject changed source files and installation identity during an active context", async (t) => {
  const f = await admittedFixture(t);
  await writeFile(f.executable, "different binary\n", { mode: 0o700 });
  assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
});

test("should reject cloned native evidence without reading files", async (t) => {
  const f = await nativeFixture(t);
  const installation = await verifyNativeInstallation(f.root, {}, () => {});
  assert.throws(
    () =>
      assertNativeInstallation(structuredClone(installation), () => assert.fail("unbranded IO")),
    { code: "POLICY_UNCONFIRMED" },
  );
});

test("should reject command helpers and unsupported inherited authority before native probes", async (t) => {
  const f = await nativeFixture(t);
  await f.json(f.settingsPath, { ...f.personal, apiKeyHelper: "synthetic-command" });
  await assert.rejects(
    new NativeClaudePolicy({}).admit(f.root, () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(f.probes.length, 0);
  await f.json(f.settingsPath, f.personal);
  await assert.rejects(
    new NativeClaudePolicy({ NODE_OPTIONS: "--require unsafe" }).admit(f.root, () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(f.probes.length, 0);
});

test("should read only the exact reserved native history without probing another session", async (t) => {
  const f = await admittedFixture(t);
  const history = await f.policy.history(f.context, () => {});
  assert.equal(history.format, "claude-jsonl-v1");
  assert.equal(history.materialized, false);
  assert.equal(history.sessionId, f.context.threadId);
  assert.equal(history.records.length, 0);
  assert.equal(digest(history.root), digest(f.root));
  await unlink(join(f.home, ".local", "bin", "claude"));
  assert.throws(() => f.policy.assertLive(f.root, () => {}));
});

test("should reuse unchanged instruction imports and reject a changed imported file", async (t) => {
  const f = await nativeFixture(t);
  const imported = join(f.config, "preferences.md");
  await writeFile(join(f.config, "CLAUDE.md"), "Personal instructions @preferences.md\n", {
    mode: 0o600,
  });
  await writeFile(imported, "Original synthetic preference\n", { mode: 0o600 });
  const policy = new NativeClaudePolicy({});
  await policy.admit(f.root, () => {});
  const read = fs.readSync;
  let reads = 0;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof read>) => {
    reads++;
    return read(...args);
  });
  syncBuiltinESMExports();
  policy.assertLive(f.root, () => {});
  assert.equal(reads, 0);
  await writeFile(imported, "Changed synthetic preference\n", { mode: 0o600 });
  assert.throws(() => policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
});

for (const version of ["2.1.288", "2.1.293"] as const) {
  test(`should disable only reviewed builtin plugins for native ${version}`, async (t) => {
    const f = await nativeFixture(t);
    if (version === "2.1.293") {
      const executable = join(dirname(f.executable), version);
      await writeFile(executable, "synthetic updated native bytes; do not execute\n", {
        mode: 0o700,
      });
      await unlink(join(f.home, ".local", "bin", "claude"));
      await symlink(executable, join(f.home, ".local", "bin", "claude"));
      f.state.installationVersion = version;
      f.state.version = `${version} (Claude Code)\n`;
    }
    const before = await readFile(f.settingsPath);
    const policy = new NativeClaudePolicy({});
    await policy.admit(f.root, () => {});
    const context = claudeRecord(f.record).context!;
    context.materialization!.version = policy.version;
    context.materialization!.policyFingerprint = policy.fingerprint;
    const tools = nativeToolNames("SELECTED", false);
    const launch = policy.launch(context, null, tools, false);
    const overlay = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]);
    assert.deepEqual(overlay.enabledPlugins, {
      "cc-plugin-agents-md@builtin": false,
      ...(version === "2.1.293" ? { "cc-plugin-plugin-authoring@builtin": false } : {}),
      "cc-plugin-telemetry@builtin": false,
      "personal@catalog": false,
    });
    assert.equal(overlay.enabledPlugins["unknown@builtin"], undefined);
    assert.deepEqual(await readFile(f.settingsPath), before);
    context.materialization!.policyFingerprint = "0".repeat(64);
    assert.throws(() => policy.launch(context, null, tools, false), {
      code: "CONTEXT_UNCONFIRMED",
    });
  });

  test(`should require an empty native plugin identity for ${version} despite builtin overrides`, async (t) => {
    const f = await nativeFixture(t);
    const context = claudeRecord(f.record).context!;
    const tools = nativeToolNames("SELECTED", false);
    const frame = {
      type: "system",
      subtype: "init",
      uuid: uuid(),
      session_id: context.threadId,
      cwd: f.root,
      claude_code_version: version,
      permissionMode: "dontAsk",
      model: "claude-test",
      tools,
      plugins: [] as unknown[],
      mcp_servers: [{ name: OWNED_SERVER, source: "sdk", status: "connected" }],
    };
    assert.equal(
      nativeIdentity(frame, context.threadId, f.root, version, tools).model,
      "claude-test",
    );
    for (const plugin of [
      {
        name: "cc-plugin-plugin-authoring",
        source: "cc-plugin-plugin-authoring@builtin",
        path: "(builtin)",
      },
      { name: "unknown", source: "unknown@builtin", path: "(builtin)" },
      { name: "personal", source: "personal@catalog", path: "/synthetic/private-plugin" },
    ]) {
      assert.throws(
        () =>
          nativeIdentity({ ...frame, plugins: [plugin] }, context.threadId, f.root, version, tools),
        { code: "CONTEXT_UNCONFIRMED" },
      );
    }
  });
}

async function fallbackNativeFixture(t: import("node:test").TestContext) {
  const f = await nativeFixture(t);
  const reviewed = join(dirname(f.executable), "2.1.293");
  const updated = join(dirname(f.executable), "2.1.294");
  await writeFile(reviewed, "synthetic reviewed bytes; do not execute\n", { mode: 0o700 });
  await writeFile(updated, "synthetic unreviewed bytes; do not execute\n", { mode: 0o700 });
  const entry = join(f.home, ".local", "bin", "claude");
  await unlink(entry);
  await symlink(updated, entry);
  f.state.installationVersion = "2.1.293";
  f.state.version = "2.1.293 (Claude Code)\n";
  return { ...f, reviewed, updated, entry };
}

test("should use the latest reviewed installed native version without changing the updated personal CLI", async (t) => {
  const f = await fallbackNativeFixture(t);
  const before = await readFile(f.settingsPath);
  const native = new FakeTransport();
  const launches: import("../src/claude/transport.ts").Launch[] = [];
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    claude: {
      environment: {},
      transport(launch) {
        launches.push(launch);
        return native;
      },
    },
  });
  try {
    const capability = await adapter.capabilities(f.root, () => {});
    assert.equal(capability.version, "2.1.293");
    assert.equal(launches[0].executable, f.reviewed);
    assert.equal(
      f.probes.some((probe) => probe.executable === f.updated),
      false,
    );
    assert.equal(
      f.probes.find((probe) => probe.executable === "/usr/bin/codesign")!.args.at(-1),
      f.reviewed,
    );
    assert.equal(fs.realpathSync(f.entry), f.updated);
    assert.deepEqual(await readFile(f.settingsPath), before);
    assert.equal(native.writes.length, 0);
  } finally {
    await adapter.close();
  }
});

test("should reject a reviewed fallback whose publisher cannot be verified before catalog or input", async (t) => {
  const f = await fallbackNativeFixture(t);
  f.state.signature = false;
  let transports = 0;
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    claude: {
      environment: {},
      transport() {
        transports++;
        return new FakeTransport();
      },
    },
  });
  try {
    await assert.rejects(
      adapter.capabilities(f.root, () => {}),
      { code: "POLICY_UNCONFIRMED" },
    );
    assert.equal(transports, 0);
    assert.equal(f.probes.length, 1);
    assert.equal(f.probes[0].args.at(-1), f.reviewed);
    assert.equal(
      f.probes.some((probe) => probe.executable === f.updated),
      false,
    );
    assert.equal(fs.realpathSync(f.entry), f.updated);
  } finally {
    await adapter.close();
  }
});

test("should reject a symlinked reviewed fallback before any executable probe", async (t) => {
  const f = await fallbackNativeFixture(t);
  await unlink(f.reviewed);
  await symlink(f.executable, f.reviewed);
  await assert.rejects(
    new NativeClaudePolicy({}).admit(f.root, () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(f.probes.length, 0);
});

test("should reject a group writable reviewed fallback before any executable probe", async (t) => {
  const f = await fallbackNativeFixture(t);
  await chmod(f.reviewed, 0o720);
  await assert.rejects(
    new NativeClaudePolicy({}).admit(f.root, () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(f.probes.length, 0);
});

test("should reject an entry outside the native version directory even when a reviewed fallback exists", async (t) => {
  const f = await fallbackNativeFixture(t);
  const foreign = join(f.directory, "foreign-claude");
  await writeFile(foreign, "synthetic foreign bytes; do not execute\n", { mode: 0o700 });
  await unlink(f.entry);
  await symlink(foreign, f.entry);
  await assert.rejects(
    new NativeClaudePolicy({}).admit(f.root, () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(f.probes.length, 0);
});

test("should retain live binary drift detection for the reviewed fallback", async (t) => {
  const f = await fallbackNativeFixture(t);
  const installation = await verifyNativeInstallation(f.root, {}, () => {});
  assert.equal(installation.executable, f.reviewed);
  await writeFile(f.reviewed, "changed synthetic reviewed bytes\n", { mode: 0o700 });
  assert.throws(() => assertNativeInstallation(installation, () => {}), {
    code: "SNAPSHOT_CHANGED",
  });
  assert.equal(fs.realpathSync(f.entry), f.updated);
});

test("should keep using a reviewed current CLI instead of preferring a different cached version", async (t) => {
  const f = await fallbackNativeFixture(t);
  await unlink(f.entry);
  await symlink(f.executable, f.entry);
  f.state.installationVersion = "2.1.288";
  f.state.version = "2.1.288 (Claude Code)\n";
  const installation = await verifyNativeInstallation(f.root, {}, () => {});
  assert.equal(installation.version, "2.1.288");
  assert.equal(installation.executable, f.executable);
  assert.equal(
    f.probes.some((probe) => probe.executable === f.reviewed),
    false,
  );
});
