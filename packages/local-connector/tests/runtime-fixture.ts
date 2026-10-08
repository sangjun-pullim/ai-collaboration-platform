import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexVersion,
  digest,
  stableJson,
  type Capabilities,
  type RuntimeScope,
  type RuntimeSettings,
  type OwnedContext,
  type SettingsObservation,
} from "../src/runtime-contracts.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import { RuntimeStore, runtimeRecord } from "../src/runtime-store.ts";
export const uuid = () => randomUUID();
export function capabilities(): Capabilities {
  const models = [
    {
      id: "test-a",
      model: "test-a",
      efforts: ["low", "high"],
      defaultEffort: "low",
      isDefault: true,
    },
    {
      id: "test-b",
      model: "test-b",
      efforts: ["medium"],
      defaultEffort: "medium",
      isDefault: false,
    },
  ];
  return {
    version: codexVersion,
    models,
    defaultSettings: { model: "test-a", effort: "low" },
    snapshotHash: digest(JSON.stringify(models)),
    policy: "CONFIRMED",
  };
}
export function observation(settings: RuntimeSettings): SettingsObservation {
  return {
    requested: settings.requested,
    thread: {
      model: settings.requested.model,
      provider: "openai",
      effort: settings.requested.effort,
    },
    turn: {
      requestedModel: settings.requested.model,
      requestedEffort: settings.requested.effort,
      model: null,
      rerouted: false,
      effortVerification: "UNVERIFIED",
    },
  };
}
export async function runtimeFixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "owned-runtime-unit-"));
  const root = join(directory, "repository");
  const stateDir = join(directory, "state");
  await mkdir(root);
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(join(root, "public.txt"), "Selected public evidence.\n", { mode: 0o644 });
  const scope: RuntimeScope = {
    server: "http://127.0.0.1:7777",
    deviceId: uuid(),
    organizationId: uuid(),
    roomId: uuid(),
    agentId: uuid(),
    bindingEpoch: 1,
  };
  const policy = await RuntimeFilePolicy.select(root, ["public.txt"]);
  const settings: RuntimeSettings = {
    provider: "codex",
    requested: { model: "test-a", effort: "low" },
    capabilities: capabilities(),
    files: [...policy.files],
    handoff: "Investigate selected public evidence.",
    publicScopeConfirmed: true,
    autoQuestionsConfirmed: true,
  };
  const context: OwnedContext = {
    ownership: "CONNECTOR_CREATED",
    generation: uuid(),
    threadId: uuid(),
    root: policy.root,
    epoch: 1,
    level: "L1",
    ownedTurns: [],
  };
  const store = new RuntimeStore(stateDir, "one", scope.agentId);
  const record = { ...runtimeRecord(scope), settings, context };
  return {
    directory,
    root,
    stateDir,
    scope,
    policy,
    settings,
    context,
    store,
    record,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Build already validated legacy completion evidence without admitting a provider. */
export function appendFixtureCompletion(
  record: import("../src/runtime-contracts.ts").RuntimeRecord,
  count = 1,
) {
  const requestId = uuid(),
    attemptId = uuid(),
    turnId = uuid();
  const payload = {
    requestId,
    cycleId: uuid(),
    agentId: record.scope.agentId,
    bindingEpoch: record.scope.bindingEpoch,
    roomRevision: 1,
    requestKind: "ORIGIN" as const,
    questionId: null,
    publicText: "Fixture evidence",
    replyText: null,
    deadline: new Date(Date.now() + 120000).toISOString(),
  };
  const snapshot = {
    requestId,
    attemptId,
    agentId: record.scope.agentId,
    bindingEpoch: record.scope.bindingEpoch,
    fence: 1,
    state: "EXECUTING" as const,
    leaseExpiresAt: payload.deadline,
    startIntentAt: new Date().toISOString(),
    payload,
  };
  const terminal = {
    threadId: record.context!.threadId,
    turnId,
    terminal: "COMPLETED" as const,
    privateText: "Fixture conclusion",
    publicText: "Fixture conclusion",
    finalItems: [{ id: "fixture", hash: digest("Fixture conclusion") }],
    textProof: "FINAL_ANSWER" as const,
    observation: observation(record.settings!),
  };
  const attempt: import("../src/runtime-contracts.ts").AttemptJournal = {
    requestId,
    scope: structuredClone(record.scope),
    generation: record.context!.generation,
    state: "UPLOADED",
    snapshot,
    native: { threadId: terminal.threadId, turnId },
    terminal,
    receipt: {
      requestId,
      attemptId,
      terminal: "COMPLETED",
      adoption: "ACCEPTED",
      continuationRequestId: null,
    },
    reason: null,
    toolCalls: [],
  };
  record.attempts.push(attempt);
  record.context!.ownedTurns.push({ turnId, terminal: "COMPLETED" });
  record.context!.level = "L2";
  for (let index = 0; index < count; index++) {
    const operationId = uuid();
    const body = {
      protocol: 1,
      agentId: record.scope.agentId,
      bindingEpoch: record.scope.bindingEpoch,
      operationId,
      requestId,
      attemptId,
      fence: 1,
    };
    record.operations.push({
      operationId,
      action: "lease",
      body,
      payloadHash: digest(stableJson({ action: "lease", body })),
      state: "CONFIRMED",
      result: structuredClone(snapshot),
    });
  }
  const operationId = uuid();
  const body = {
    protocol: 1,
    agentId: record.scope.agentId,
    bindingEpoch: record.scope.bindingEpoch,
    operationId,
    requestId,
    attemptId,
    fence: 1,
    terminal: "COMPLETED",
    publicText: terminal.publicText,
  };
  record.operations.push({
    operationId,
    action: "complete",
    body,
    payloadHash: digest(stableJson({ action: "complete", body })),
    state: "CONFIRMED",
    result: structuredClone(attempt.receipt),
  });
  return attempt;
}
