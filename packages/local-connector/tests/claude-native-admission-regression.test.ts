import assert from "node:assert/strict";
import test from "node:test";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NativeClaudePolicy } from "../src/claude/native-policy.ts";
import { verifyNativeInstallation } from "../src/claude/native-installation.ts";
import { nativeToolNames } from "../src/workspace/tool-contracts.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { nativeFixture } from "./claude-native-fixture.ts";

test("should retain settings authority checks when personal instructions import settings", async (t) => {
  const f = await nativeFixture(t);
  await writeFile(join(f.config, "CLAUDE.md"), "Personal context @settings.json\n", {
    mode: 0o600,
  });
  await f.json(f.settingsPath, { ...f.personal, apiKeyHelper: "synthetic-command" });
  await assert.rejects(
    new NativeClaudePolicy({}).admit(f.root, () => {}),
    {
      code: "POLICY_UNCONFIRMED",
    },
  );
  assert.equal(f.probes.length, 0);
});

test("should restrict configured plugins when settings also appear as instruction imports", async (t) => {
  const f = await nativeFixture(t);
  await writeFile(join(f.config, "CLAUDE.md"), "Personal context @settings.json\n", {
    mode: 0o600,
  });
  const policy = new NativeClaudePolicy({});
  await policy.admit(f.root, () => {});
  const record = claudeRecord(f.record);
  record.context!.materialization!.version = policy.version;
  record.context!.materialization!.policyFingerprint = policy.fingerprint;
  const launch = policy.launch(
    record.context!,
    record.settings!,
    nativeToolNames("SELECTED", false),
    false,
  );
  const overlay = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]);
  assert.equal(overlay.enabledPlugins["personal@catalog"], false);
});

for (const source of ["inherited", "settings"] as const) {
  test(`should reject custom authentication headers from ${source} before native probes`, async (t) => {
    const f = await nativeFixture(t);
    const env = { ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer synthetic-token" };
    if (source === "settings")
      await f.json(f.settingsPath, { ...f.personal, env: { ...f.personal.env, ...env } });
    await assert.rejects(
      new NativeClaudePolicy(source === "inherited" ? env : {}).admit(f.root, () => {}),
      {
        code: "POLICY_UNCONFIRMED",
      },
    );
    assert.equal(f.probes.length, 0);
  });
}

for (const directory of [".local", ".local/share"]) {
  test(`should reject a writable ${directory} installation ancestor before native probes`, async (t) => {
    const f = await nativeFixture(t);
    const ancestor = join(f.home, directory);
    await chmod(ancestor, 0o777);
    try {
      await assert.rejects(
        verifyNativeInstallation(f.root, {}, () => {}),
        {
          code: "POLICY_UNCONFIRMED",
        },
      );
      assert.equal(f.probes.length, 0);
    } finally {
      await chmod(ancestor, 0o700);
    }
  });
}

test("should enable owned conversation persistence only for the chat task", async (t) => {
  const f = await nativeFixture(t);
  await f.json(f.settingsPath, {
    ...f.personal,
    env: { ...f.personal.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" },
  });
  const before = await readFile(f.settingsPath);
  const policy = new NativeClaudePolicy({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" });
  await policy.admit(f.root, () => {});
  const record = claudeRecord(f.record);
  record.context!.materialization!.version = policy.version;
  record.context!.materialization!.policyFingerprint = policy.fingerprint;
  const launch = policy.launch(
    record.context!,
    record.settings!,
    nativeToolNames("SELECTED", false),
    false,
  );
  const overlay = JSON.parse(launch.args[launch.args.indexOf("--settings") + 1]);
  assert.equal(launch.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "0");
  assert.equal(overlay.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "0");
  const followUp = policy.launch(
    record.context!,
    record.settings!,
    nativeToolNames("SELECTED", false),
    true,
  );
  assert.equal(followUp.args[followUp.args.indexOf("--resume") + 1], record.context!.threadId);
  assert.equal(followUp.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, "0");
  assert.deepEqual(await readFile(f.settingsPath), before);
});
