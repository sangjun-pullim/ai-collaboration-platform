import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeLaunchPolicy,
  createSyntheticClaudeEvidence,
  type SyntheticClaudeEvidence,
} from "../src/claude/launch-policy.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import { NATIVE_TOOL_NAMES } from "../src/claude/input-proof.ts";
import { policyFixture } from "./claude-policy-fixture.ts";
const tools = [NATIVE_TOOL_NAMES[0]];

test("should reject absent or malformed native evidence before any source or guard access", async () => {
  for (const evidence of [
    undefined,
    {
      kind: "NATIVE",
      version: "2.1.287",
      fingerprint: "a".repeat(64),
      executable: "/must-not-read",
    } as unknown as SyntheticClaudeEvidence,
  ]) {
    const policy = new ClaudeLaunchPolicy(evidence, {});
    await assert.rejects(
      policy.admit("/must-not-read", () => {}),
      { code: "POLICY_UNCONFIRMED" },
    );
  }
});
test("should confine synthetic evidence to its exact Node fixture and reject official substitution", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    const launch = f.policy.launch(f.context, f.settings, tools, false);
    assert.equal(launch.executable, f.evidence.executable);
    assert.equal(launch.args[0], f.fixture);
    for (const evidence of [
      { ...f.evidence, executable: "/usr/local/bin/claude" },
      structuredClone(f.evidence),
    ]) {
      await assert.rejects(
        new ClaudeLaunchPolicy(evidence, {}).admit(f.root, () => {}),
        { code: "POLICY_UNCONFIRMED" },
      );
    }
    await writeFile(f.fixture, "// AI_COLLAB_SYNTHETIC_CLAUDE_FIXTURE\nprocess.exit(1);\n", {
      mode: 0o600,
    });
    assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
  } finally {
    await f.close();
  }
});
test("should preserve user and project instructions while restricting exact product tools", async () => {
  const f = await policyFixture();
  try {
    const user = join(f.config, "CLAUDE.md"),
      project = join(f.root, "CLAUDE.md");
    await writeFile(user, "Personal instructions", { mode: 0o600 });
    await writeFile(project, "Project instructions", { mode: 0o600 });
    await f.json(join(f.config, "settings.json"), {
      hooks: { Stop: [{ command: "synthetic" }] },
      enabledPlugins: { synthetic: true },
    });
    const before = await readFile(join(f.config, "settings.json"));
    await f.admit();
    const launch = f.policy.launch(f.context, f.settings, tools, false);
    assert.equal(launch.args[launch.args.indexOf("--tools") + 1], "");
    assert.equal(launch.args[launch.args.indexOf("--allowedTools") + 1], tools[0]);
    assert.ok(launch.args.includes("--strict-mcp-config"));
    assert.equal(launch.args[launch.args.indexOf("--permission-mode") + 1], "dontAsk");
    const overlay = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]);
    assert.deepEqual(overlay, {
      disableAllHooks: true,
      enabledPlugins: { synthetic: false },
      env: {},
    });
    assert.ok(
      !launch.args.some((arg) =>
        [
          "--bare",
          "--restricted",
          "--dangerously-skip-permissions",
          "--prompt",
          "--fallback-model",
        ].includes(arg),
      ),
    );
    assert.throws(() => f.policy.launch(f.context, f.settings, ["Read"], false), {
      code: "POLICY_UNCONFIRMED",
    });
    f.settings.autoQuestionsConfirmed = false;
    assert.throws(() => f.policy.launch(f.context, f.settings, NATIVE_TOOL_NAMES, false), {
      code: "POLICY_UNCONFIRMED",
    });
    assert.equal(await readFile(user, "utf8"), "Personal instructions");
    assert.equal(await readFile(project, "utf8"), "Project instructions");
    assert.deepEqual(await readFile(join(f.config, "settings.json")), before);
  } finally {
    await f.close();
  }
});
test("should preserve provider auth and omit product credentials", async () => {
  const f = await policyFixture(undefined, {
    ANTHROPIC_API_KEY: "synthetic-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token",
    PATH: "/synthetic/bin",
    DATABASE_URL: "synthetic-secret",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-secret",
    ADMIN_TOKEN: "synthetic-secret",
    BEARER_TOKEN: "synthetic-secret",
    LOCAL_ACCESS_KEY: "synthetic-secret",
    LOCAL_DEVICE_KEY: "synthetic-secret",
    LOCAL_WORKFLOW_KEY: "synthetic-secret",
    AI_COLLAB_KEY: "synthetic-secret",
    DIRECT_URL: "synthetic-secret",
    DB_PASSWORD: "synthetic-secret",
    JWT_SECRET: "synthetic-secret",
    GOTRUE_JWT_SECRET: "synthetic-secret",
    PGRST_JWT_SECRET: "synthetic-secret",
    SERVER_SECRET: "synthetic-secret",
    LOCAL_AUTH_TOKEN: "synthetic-secret",
    SERVICE_ROLE_KEY: "synthetic-secret",
    TEAM_ENTRY_DB_URL: "synthetic-secret",
  });
  try {
    await f.admit();
    const env = f.policy.launch(f.context, f.settings, tools, false).env;
    assert.equal(env.ANTHROPIC_API_KEY, "synthetic-auth");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "synthetic-token");
    assert.equal(env.CLAUDE_CONFIG_DIR, f.config);
    assert.ok(!Object.values(env).includes("synthetic-secret"));
  } finally {
    await f.close();
  }
});
test("should pin selected effort against inherited shell and settings env without changing defaults", async () => {
  const f = await policyFixture(undefined, { CLAUDE_CODE_EFFORT_LEVEL: "low" });
  try {
    const path = join(f.config, "settings.json");
    await f.json(path, { env: { CLAUDE_CODE_EFFORT_LEVEL: "medium" } });
    const before = await readFile(path);
    await f.admit();
    f.settings.requested.effort = "high";
    const launch = f.policy.launch(f.context, f.settings, tools, false);
    assert.equal(launch.env.CLAUDE_CODE_EFFORT_LEVEL, "high");
    assert.equal(launch.args[launch.args.indexOf("--effort") + 1], "high");
    assert.equal(
      JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]).env.CLAUDE_CODE_EFFORT_LEVEL,
      "high",
    );
    assert.equal(f.environment.CLAUDE_CODE_EFFORT_LEVEL, "low");
    assert.deepEqual(await readFile(path), before);
  } finally {
    await f.close();
  }
});
test("should reject conflicting managed effort and unconfirmed nullable effort", async () => {
  for (const managed of [false, true]) {
    const f = await policyFixture(undefined, managed ? {} : { CLAUDE_CODE_EFFORT_LEVEL: "high" });
    try {
      if (managed)
        await f.json(join(f.config, "managed-settings.json"), {
          env: { CLAUDE_CODE_EFFORT_LEVEL: "low" },
        });
      await f.admit();
      if (managed) f.settings.requested.effort = "high";
      assert.throws(() => f.policy.launch(f.context, f.settings, tools, false), {
        code: "POLICY_UNCONFIRMED",
      });
    } finally {
      await f.close();
    }
  }
});
test("should omit effort for an unaffected nullable selection", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    assert.ok(!f.policy.launch(f.context, f.settings, tools, false).args.includes("--effort"));
  } finally {
    await f.close();
  }
});
test("should reject effort source changes during reload", async () => {
  const f = await policyFixture();
  try {
    const path = join(f.config, "settings.json");
    await f.json(path, { env: { CLAUDE_CODE_EFFORT_LEVEL: "high" } });
    await f.admit();
    f.settings.requested.effort = "high";
    f.policy.launch(f.context, f.settings, tools, false);
    await f.json(path, { env: { CLAUDE_CODE_EFFORT_LEVEL: "low" } });
    assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
  } finally {
    await f.close();
  }
});
test("should reject managed conflicts and unconfirmed sources", async () => {
  for (const flag of [
    "sourceCompleteness",
    "managedCompleteness",
    "startupPrecedence",
    "reloadPrecedence",
    "effortPrecedence",
  ] as const) {
    const f = await policyFixture((layout) => {
      layout[flag] = false;
    });
    try {
      await assert.rejects(f.admit(), { code: "POLICY_UNCONFIRMED" });
    } finally {
      await f.close();
    }
  }
  const f = await policyFixture();
  try {
    await f.json(join(f.config, "managed-settings.json"), { hooks: { Stop: [{}] } });
    await assert.rejects(f.admit(), { code: "POLICY_UNCONFIRMED" });
  } finally {
    await f.close();
  }
});
test("should reject a managed hook override even when no managed hooks are present", async () => {
  const f = await policyFixture();
  try {
    await f.json(join(f.config, "managed-settings.json"), { disableAllHooks: false });
    await assert.rejects(f.admit(), { code: "POLICY_UNCONFIRMED" });
  } finally {
    await f.close();
  }
});
test("should detect existing and newly created policy sources and unsafe links", async () => {
  for (const change of ["existing", "created", "link", "replacement"] as const) {
    const f = await policyFixture();
    try {
      const path = join(f.config, "settings.json");
      if (change === "existing") await f.json(path, { model: "old" });
      await f.admit();
      if (change === "link") await symlink(f.fixture, path);
      else if (change === "replacement") {
        await rename(f.fixture, f.fixture + ".old");
        await writeFile(f.fixture, "// AI_COLLAB_SYNTHETIC_CLAUDE_FIXTURE\nprocess.exit(0);\n", {
          mode: 0o600,
        });
      } else await f.json(path, { model: "new" });
      assert.throws(() => f.policy.assertLive(f.root, () => {}), {
        code: change === "link" ? "UNSAFE_STORAGE" : "SNAPSHOT_CHANGED",
      });
    } finally {
      await f.close();
    }
  }
});
test("should distinguish authentication-only changes from policy changes", async () => {
  const f = await policyFixture();
  try {
    const path = join(f.config, ".credentials.json");
    await f.json(path, { claudeAiOauth: { accessToken: "synthetic-first" } });
    await f.admit();
    const hash = f.policy.fingerprint;
    await f.json(path, { claudeAiOauth: { accessToken: "synthetic-renewed" } });
    f.environment.ANTHROPIC_API_KEY = "synthetic-renewed";
    assert.doesNotThrow(() => f.policy.assertLive(f.root, () => {}));
    assert.equal(f.policy.fingerprint, hash);
    await f.json(path, {
      claudeAiOauth: { accessToken: "synthetic-renewed" },
      env: { CLAUDE_CODE_EFFORT_LEVEL: "high" },
    });
    assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
  } finally {
    await f.close();
  }
});
test("should distinguish exact user configuration auth refresh from MCP changes", async () => {
  const f = await policyFixture();
  try {
    const path = f.layout.userConfiguration;
    await f.json(path, {
      oauthAccount: { emailAddress: "synthetic-first" },
      mcpServers: { personal: { command: "synthetic-personal" } },
    });
    await f.admit();
    const fingerprint = f.policy.fingerprint;
    await f.json(path, {
      oauthAccount: { emailAddress: "synthetic-renewed" },
      mcpServers: { personal: { command: "synthetic-personal" } },
    });
    f.policy.assertLive(f.root, () => {});
    assert.equal(f.policy.fingerprint, fingerprint);
    await f.json(path, {
      oauthAccount: { emailAddress: "synthetic-renewed" },
      mcpServers: { personal: { command: "synthetic-changed" } },
    });
    assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
  } finally {
    await f.close();
  }
});
test("should reject creation of a previously absent policy source parent", async () => {
  const f = await policyFixture((layout) => {
    layout.legacyLocal = join(layout.fixtureDirectory, "missing-local", "settings.local.json");
  });
  try {
    await f.admit();
    await mkdir(join(f.directory, "missing-local"), { mode: 0o700 });
    assert.throws(() => f.policy.assertLive(f.root, () => {}), { code: "SNAPSHOT_CHANGED" });
  } finally {
    await f.close();
  }
});
test("should use one exact owned transcript and reject unconfirmed long-path layout without scanning", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    const path = f.policy.transcriptPath(f.context);
    assert.equal(
      path,
      join(
        f.config,
        "projects",
        f.root.replace(/[^a-zA-Z0-9]/g, "-"),
        f.context.threadId + ".jsonl",
      ),
    );
    const foreign = join(f.config, "projects", "other-project");
    await mkdir(foreign, { recursive: true, mode: 0o700 });
    await writeFile(join(foreign, f.context.threadId + ".jsonl"), "invalid private history", {
      mode: 0o600,
    });
    assert.equal((await f.policy.history(f.context, () => {})).materialized, false);
    await mkdir(join(f.config, "projects", f.root.replace(/[^a-zA-Z0-9]/g, "-")), { mode: 0o700 });
    await writeFile(path, '{"type":"synthetic"}\n', { mode: 0o600 });
    assert.deepEqual((await f.policy.history(f.context, () => {})).records, [
      { type: "synthetic" },
    ]);
    const other = await policyFixture((layout) => {
      layout.transcriptEncoding = "UNCONFIRMED";
    });
    try {
      await other.admit();
      assert.throws(() => other.policy.transcriptPath(other.context), {
        code: "CONTEXT_UNCONFIRMED",
      });
    } finally {
      await other.close();
    }
  } finally {
    await f.close();
  }
});
test("should use reserved ID for first input and absolute owned transcript for resume", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    const first = f.policy.launch(f.context, f.settings, tools, false),
      resumed = f.policy.launch(f.context, f.settings, tools, true);
    assert.equal(first.args[first.args.indexOf("--session-id") + 1], f.context.threadId);
    assert.ok(!first.args.includes("--resume"));
    assert.equal(
      resumed.args[resumed.args.indexOf("--resume") + 1],
      f.policy.transcriptPath(f.context),
    );
    assert.ok(!resumed.args.includes("--session-id"));
  } finally {
    await f.close();
  }
});
test("should reject a confirmed short layout when the actual canonical cwd needs long-path encoding", async () => {
  const f = await policyFixture();
  try {
    const root = join(f.root, "long-cwd-" + "x".repeat(160));
    await mkdir(root, { mode: 0o700 });
    assert.ok(root.length > 200);
    const evidence = createSyntheticClaudeEvidence({
      ...f.layout,
      root,
      gitRoot: root,
      mainCheckout: root,
    });
    const policy = new ClaudeLaunchPolicy(evidence, {});
    await policy.admit(root, () => {});
    const selected = await RuntimeFilePolicy.select(root, []);
    const context = {
      ...f.context,
      root: selected.root,
      materialization: { ...f.context.materialization!, policyFingerprint: policy.fingerprint },
    };
    assert.throws(() => policy.transcriptPath(context), { code: "CONTEXT_UNCONFIRMED" });
    await assert.rejects(
      policy.history(context, () => {}),
      { code: "CONTEXT_UNCONFIRMED" },
    );
  } finally {
    await f.close();
  }
});

import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
import { nativeToolNames } from "../src/workspace/tool-contracts.ts";
import { uuid } from "./runtime-fixture.ts";
test("should admit automatic tools only under exact bound synthetic approval while preserving real policy closure", async () => {
  const f = await policyFixture();
  try {
    await f.admit();
    f.settings.files = [];
    f.settings.autoQuestionsConfirmed = false;
    f.settings.repositoryAccess = createRepositoryAccess(
      f.context.generation,
      f.context.root,
      uuid(),
      uuid(),
    );
    const launch = f.policy.launch(
      f.context,
      f.settings,
      nativeToolNames("AUTO_CODE", false),
      false,
    );
    assert.equal(
      launch.args[launch.args.indexOf("--allowedTools") + 1],
      nativeToolNames("AUTO_CODE", false).join(","),
    );
    assert.throws(
      () => f.policy.launch(f.context, f.settings, nativeToolNames("AUTO_CODE", true), false),
      { code: "POLICY_UNCONFIRMED" },
    );
    assert.throws(
      () => f.policy.launch(f.context, f.settings, nativeToolNames("SELECTED", false), false),
      { code: "POLICY_UNCONFIRMED" },
    );
    const closed = new ClaudeLaunchPolicy(undefined, {});
    assert.throws(
      () => closed.launch(f.context, f.settings, nativeToolNames("AUTO_CODE", false), false),
      { code: "POLICY_UNCONFIRMED" },
    );
  } finally {
    await f.close();
  }
});
