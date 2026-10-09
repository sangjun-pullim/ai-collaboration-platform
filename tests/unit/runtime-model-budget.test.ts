import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityHash,
  projectCapability,
  isModelDisplayName,
  jsonbTextBytes,
  omitOversizedModelDisplayNames,
  type Capability,
} from "../../src/features/runtime-settings/contracts.ts";

function catalog(count: number): Capability {
  const models = Array.from({ length: count }, (_, i) => ({
    id: `model-${i}-${"x".repeat(50)}`,
    model: `model-${i}-${"y".repeat(50)}`,
    efforts: ["low", "high"],
    defaultEffort: "low",
    isDefault: i === 0,
  }));
  const contents = {
    runtime: "codex" as const,
    version: "synthetic-1",
    models,
    defaultSettings: { model: models[0].model, effort: "low" },
    policy: "verified" as const,
  };
  return { ...contents, snapshotHash: capabilityHash(contents) };
}

test("should omit only display metadata when originally valid catalogs approach their byte bound", () => {
  const original = catalog(55);
  assert.ok(jsonbTextBytes(original) > 12000);
  assert.ok(jsonbTextBytes(original) < 16384);
  projectCapability(original);
  const named = {
    ...original,
    models: original.models.map((m) => ({ ...m, displayName: "Native " + "x".repeat(110) })),
  };
  assert.ok(jsonbTextBytes(named) > 16384);
  assert.deepEqual(projectCapability(omitOversizedModelDisplayNames(named)), original);
  const { snapshotHash, ...contents } = original;
  assert.equal(capabilityHash({ ...contents, models: named.models }), snapshotHash);
  const small = catalog(1);
  const smallNamed = {
    ...small,
    models: small.models.map((m) => ({ ...m, displayName: "Native (1M context)" })),
  };
  assert.deepEqual(omitOversizedModelDisplayNames(smallNamed), smallNamed);
});

test("should reject unsafe or unknown metadata even when cosmetic labels would exceed the budget", () => {
  const original = catalog(55);
  for (const displayName of [
    null,
    4,
    "",
    "Native\nlabel",
    "Native\tlabel",
    " Native",
    "Native ",
    "Native/label",
    "Native\\label",
    "Native@host",
    "sk-private",
    "Token label",
    "Native .. label",
    "a".repeat(121),
    "Native " + "f".repeat(24),
    "Native 00000000-0000-4000-8000-000000000001",
    "Opus 😀",
  ]) {
    assert.equal(isModelDisplayName(displayName), false, JSON.stringify(displayName));
    const bad = { ...original, models: original.models.map((m) => ({ ...m, displayName })) };
    assert.throws(() => projectCapability(bad), { code: "INVALID_BODY" });
  }
  const unknown = {
    ...original,
    models: original.models.map((m) => ({ ...m, displayName: "Native", unknown: true })),
  };
  assert.throws(() => projectCapability(omitOversizedModelDisplayNames(unknown)), {
    code: "INVALID_BODY",
  });
});

test("should keep the historical no-name catalog hash bytes exact", () => {
  const contents = {
    runtime: "claude" as const,
    version: "2.1.293",
    models: [
      { id: "opus", model: "opus", efforts: ["high"], defaultEffort: "high", isDefault: true },
    ],
    defaultSettings: { model: "opus", effort: "high" },
    policy: "verified" as const,
  };
  assert.equal(
    capabilityHash(contents),
    "0fed2a1acf1666658cdade8f046c78a3cba9d56a0be3e7361367cf3ef0a9fb0a",
  );
});

test("should reserve a proven worst-case bound for receipt, SQL response and HTTP envelope", () => {
  // These values overestimate the closed schemas: SQL bigint has at most 19 digits,
  // aliases at most 40 Unicode characters (4 UTF-8 bytes each), and model/effort 120 ASCII bytes.
  const id = "00000000-0000-4000-8000-000000000001",
    maxNumber = "9".repeat(19),
    alias = "𐐀".repeat(40),
    model = "m".repeat(120),
    effort = "e".repeat(120),
    hash = "a".repeat(64);
  const receipt = {
    operationId: id,
    readMode: "AUTO_CODE",
    state: "LOCAL_CONFIRMATION",
    configRevision: maxNumber,
    runtime: "claude",
    model,
    effort,
    snapshotHash: hash,
    localRootReference: id,
    repositoryAlias: alias,
    sessionAlias: alias,
    catalog: null,
    bindingEpoch: maxNumber,
    agentId: id,
    workspaceId: id,
  };
  const requested = {
    operationId: id,
    deviceId: id,
    expectedConfigRevision: maxNumber,
    runtime: "claude",
    model,
    effort,
    snapshotHash: hash,
    localRootReference: id,
    repositoryAlias: alias,
    sessionAlias: alias,
    expectedEpoch: maxNumber,
    readMode: "AUTO_CODE",
  };
  const response = {
    protocol: 1,
    deviceId: id,
    configRevision: maxNumber,
    catalog: null,
    operation: {
      operationId: id,
      deviceId: id,
      expectedConfigRevision: maxNumber,
      state: "LOCAL_CONFIRMATION",
      requested,
      receipt,
    },
    applied: receipt,
    current: false,
    currentBinding: { agentId: id, workspaceId: id, bindingEpoch: maxNumber, runtime: "claude" },
  };
  // Replace each catalog:null's 4 bytes with the conservative 8192-byte catalog budget.
  assert.ok(jsonbTextBytes(receipt) - 4 + 8192 <= 16384);
  assert.ok(jsonbTextBytes(response) - 4 + 8192 <= 16200);
  assert.ok(jsonbTextBytes({ ok: true, data: response }) - 4 + 8192 <= 16384);
  assert.ok(jsonbTextBytes(response) - 4 < 5000);
});
