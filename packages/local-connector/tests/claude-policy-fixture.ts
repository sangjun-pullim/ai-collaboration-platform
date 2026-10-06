import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeLaunchPolicy,
  createSyntheticClaudeEvidence,
  type SyntheticClaudeLayout,
} from "../src/claude/launch-policy.ts";
import { StateStore } from "../src/state-store.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";

export async function policyFixture(
  change?: (layout: SyntheticClaudeLayout) => void,
  environment: NodeJS.ProcessEnv = {},
) {
  const f = await runtimeFixture();
  const config = join(f.directory, "claude-config"),
    fixture = join(f.directory, "claude-fixture.mjs");
  await mkdir(config, { mode: 0o700 });
  await mkdir(join(f.root, ".claude"), { mode: 0o700 });
  await writeFile(fixture, "// AI_COLLAB_SYNTHETIC_CLAUDE_FIXTURE\nprocess.exit(0);\n", {
    mode: 0o600,
  });
  const layout: SyntheticClaudeLayout = {
    fixtureDirectory: f.directory,
    fixture,
    root: f.root,
    gitRoot: f.root,
    mainCheckout: f.root,
    configDirectory: config,
    userConfiguration: join(f.directory, ".claude.json"),
    legacyLocal: join(f.directory, "legacy-settings.local.json"),
    instructions: [],
    sourceCompleteness: true,
    managedCompleteness: true,
    startupPrecedence: true,
    reloadPrecedence: true,
    effortPrecedence: true,
    nullableEffortUnaffected: false,
    transcriptEncoding: "short-cwd-v1",
  };
  change?.(layout);
  const evidence = createSyntheticClaudeEvidence(layout);
  const policy = new ClaudeLaunchPolicy(evidence, environment);
  const record = claudeRecord(f.record);
  return {
    ...f,
    config,
    fixture,
    layout,
    evidence,
    filePolicy: f.policy,
    runtime: f,
    policy,
    environment,
    profile: new StateStore(f.stateDir, "one"),
    record,
    context: record.context!,
    settings: record.settings!,
    async admit() {
      await policy.admit(f.root, () => {});
      record.context!.materialization!.policyFingerprint = policy.fingerprint;
    },
    async json(path: string, value: unknown) {
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    },
  };
}
