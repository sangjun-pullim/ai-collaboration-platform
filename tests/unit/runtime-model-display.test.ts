import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityHash,
  projectCapability,
} from "../../src/features/runtime-settings/contracts.ts";

function catalog() {
  const contents = {
    runtime: "claude" as const,
    version: "2.1.293",
    models: [
      { id: "opus", model: "opus", efforts: ["high"], defaultEffort: "high", isDefault: true },
    ],
    defaultSettings: { model: "opus", effort: "high" },
    policy: "verified" as const,
  };
  return { ...contents, snapshotHash: capabilityHash(contents) };
}

test("should preserve a supplied display name without changing the executable model", () => {
  const original = catalog();
  const labelled = {
    ...original,
    models: original.models.map((model) => ({ ...model, displayName: "Opus 5.5" })),
  };
  assert.deepEqual(projectCapability(labelled), labelled);
  assert.equal(projectCapability(original).models[0].model, "opus");
});

test("should retain the same settings identity when only a display name changes", () => {
  const { snapshotHash, ...original } = catalog();
  for (const displayName of ["Opus 5.5", "Opus 5.5 (1M context)"]) {
    assert.equal(
      capabilityHash({
        ...original,
        models: original.models.map((model) => ({ ...model, displayName })),
      }),
      snapshotHash,
    );
  }
  assert.notEqual(
    capabilityHash({
      ...original,
      models: original.models.map((model) => ({ ...model, model: "sonnet" })),
    }),
    snapshotHash,
  );
});

test("should reject private display data and unknown model metadata", () => {
  const original = catalog();
  for (const displayName of ["/Users/private/model", "Opus\n5.5", "Bearer private-token"]) {
    assert.throws(
      () =>
        projectCapability({
          ...original,
          models: original.models.map((model) => ({ ...model, displayName })),
        }),
      { code: "INVALID_BODY" },
    );
  }
  assert.throws(
    () =>
      projectCapability({
        ...original,
        models: original.models.map((model) => ({ ...model, description: "Opus 5.5" })),
      }),
    { code: "INVALID_BODY" },
  );
});
