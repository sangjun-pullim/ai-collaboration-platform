import { digest, type RuntimeRecord } from "../src/runtime-contracts.ts";
import { capabilityHash } from "../src/settings/contracts.ts";

export function claudeRecord(source: RuntimeRecord): RuntimeRecord {
  const value = structuredClone(source) as unknown as Record<string, unknown>;
  value.version = 2;
  value.settings = {
    ...source.settings,
    provider: "claude",
    requested: { model: "claude-test", effort: null },
    capabilities: {
      runtime: "claude",
      version: "2.1.287",
      models: [
        {
          id: "claude-test",
          model: "claude-test",
          efforts: [],
          defaultEffort: null,
          isDefault: true,
        },
      ],
      defaultSettings: { model: "claude-test", effort: null },
      snapshotHash: digest("claude-capability-fixture"),
      policy: "CONFIRMED",
    },
  };
  const caps = (value.settings as RuntimeRecord["settings"])!.capabilities;
  const { snapshotHash: previousHash, ...contents } = caps;
  void previousHash;
  caps.snapshotHash = capabilityHash({ ...contents, policy: "verified", runtime: "claude" });
  value.context = {
    ...source.context,
    provider: "claude",
    materialization: {
      state: "RESERVED",
      version: "2.1.287",
      policyFingerprint: digest("verified-fixture-policy"),
      initHash: null,
    },
  };
  return value as unknown as RuntimeRecord;
}
