import { isId, isHash } from "../contracts.ts";
import { serviceOrigin } from "../central-client.ts";
import { validateBody, projectResponse, type DeviceAction } from "../workflow-contracts.ts";
import {
  codexVersion,
  claudeInterruptRequest,
  digest,
  stableJson,
  type NativeInterruption,
  type RuntimeOperation,
  type RuntimeRecord,
} from "../runtime-contracts.ts";
import { isSelectedPath } from "../runtime-file-policy.ts";
import { validRepositoryAccess, validToolPolicy } from "../workspace/repository-access.ts";
import {
  validRepositoryIntent,
  validRepositoryObservation,
  validPeerEvidenceObservation,
} from "../workspace/repository-observation.ts";
import { validSourceObservation } from "../workflow/source-snapshot.ts";
import { record, unsafe } from "./record-helpers.ts";

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
const exact =
  (shape: Shape): Check =>
  (v) =>
    record(v) &&
    Object.keys(v).length === Object.keys(shape).length &&
    Object.entries(shape).every(([key, check]) => check(v[key]));
const optionalExact =
  (shape: Shape, optional: Shape): Check =>
  (v) =>
    record(v) &&
    Object.keys(v).every((key) => Object.hasOwn(shape, key) || Object.hasOwn(optional, key)) &&
    Object.entries(shape).every(([key, check]) => check(v[key])) &&
    Object.entries(optional).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key]));
const one =
  (...choices: unknown[]): Check =>
  (v) =>
    choices.includes(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const list =
  (check: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(check);
const string: Check = (v) =>
  typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\0\r\n]/.test(v);
const text: Check = (v) => typeof v === "string" && Buffer.byteLength(v) <= 65536;
const number: Check = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const uint: Check = (v) => number(v) && Number.isSafeInteger(v);
const positive: Check = (v) => uint(v) && Number(v) > 0;
const bool: Check = (v) => typeof v === "boolean";
const terminal = one("COMPLETED", "FAILED", "INTERRUPTED");
const scope = exact({
  server: (v) => {
    try {
      serviceOrigin(String(v));
      return true;
    } catch {
      return false;
    }
  },
  deviceId: isId,
  organizationId: isId,
  roomId: isId,
  agentId: isId,
  bindingEpoch: positive,
});
const requested = exact({ model: string, effort: string });
const root = exact({
  path: (v) => string(v) && String(v).startsWith("/"),
  dev: uint,
  ino: uint,
  uid: uint,
});
const file = exact({
  path: isSelectedPath,
  dev: uint,
  ino: uint,
  size: (v) => uint(v) && Number(v) <= 65536,
  mtimeMs: number,
  ctimeMs: number,
  hash: isHash,
});
const model = exact({
  id: string,
  model: string,
  efforts: list(string, 12),
  defaultEffort: string,
  isDefault: bool,
});
const capabilities = exact({
  version: one(codexVersion),
  models: list(model, 256),
  defaultSettings: nullable(requested),
  snapshotHash: isHash,
  policy: one("CONFIRMED"),
});
const settings = exact({
  provider: one("codex"),
  requested,
  capabilities,
  files: list(file, 32),
  handoff: text,
  publicScopeConfirmed: one(true),
  autoQuestionsConfirmed: bool,
});
const context = exact({
  ownership: one("CONNECTOR_CREATED"),
  generation: isId,
  threadId: string,
  root,
  epoch: positive,
  level: one("L1", "L2"),
  ownedTurns: list(exact({ turnId: string, terminal }), 256),
});
const observation = exact({
  requested,
  thread: exact({ model: nullable(string), provider: string, effort: nullable(string) }),
  turn: exact({
    requestedModel: string,
    requestedEffort: string,
    model: nullable(string),
    rerouted: bool,
    effortVerification: one("UNVERIFIED"),
  }),
});
const evidence = exact({
  threadId: string,
  turnId: string,
  terminal,
  privateText: text,
  publicText: (v) =>
    typeof v === "string" && Buffer.byteLength(v) <= 8192 && Array.from(v).length <= 4000,
  finalItems: list(exact({ id: string, hash: isHash }), 256),
  textProof: one("FINAL_ANSWER", "UNCONFIRMED"),
  observation,
});
const toolResult = exact({
  success: bool,
  contentItems: list(exact({ type: one("inputText"), text }), 4),
});
const projected =
  (action: DeviceAction): Check =>
  (v) => {
    try {
      projectResponse(action, v);
      return true;
    } catch {
      return false;
    }
  };
const codes = one(
  "RUNTIME_CAPACITY",
  "INVALID_RUNTIME",
  "UNSAFE_STORAGE",
  "RUNTIME_BUSY",
  "POLICY_UNCONFIRMED",
  "UNSUPPORTED_SETTINGS",
  "CONTEXT_UNCONFIRMED",
  "SNAPSHOT_CHANGED",
  "TOOL_REJECTED",
  "PUBLIC_TEXT_REJECTED",
  "AUTHORITY_LOST",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
  "CLEANUP_INCOMPLETE",
  "RUNTIME_CLOSED",
);
const closure: Check = (v) =>
  exact({ kind: one("LOCAL_NOT_TRANSMITTED"), claimOperationId: isId })(v) ||
  exact({ kind: one("SERVER_INPUT_PAUSED"), claimOperationId: isId })(v) ||
  exact({ kind: one("SERVER_ABANDONED"), claimOperationId: isId, snapshot: projected("claim") })(v);
const nativeIntent = optionalExact(
  {
    provider: one("claude"),
    sessionId: isId,
    inputId: isId,
    promptHash: isHash,
    generation: isId,
    scope,
    attemptId: isId,
    fence: positive,
    policyFingerprint: isHash,
  },
  { toolPolicy: validToolPolicy },
);
const nativeToolCancellation = exact({
  callId: (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 200,
  controlId: (v) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= 200,
  payloadHash: isHash,
  cancelHash: isHash,
});
const nativeInterruption = optionalExact(
  { intent: nativeIntent, intentHash: isHash, requestHash: isHash },
  {
    receipt: exact({ stillQueued: list(isId, 0), cancelled: list(isId, 1), responseHash: isHash }),
  },
);
export function validInterruption(proof: NativeInterruption): boolean {
  return (
    nativeInterruption(proof) &&
    proof.intentHash === digest(stableJson(proof.intent)) &&
    proof.requestHash === digest(stableJson(claudeInterruptRequest)) &&
    (!proof.receipt ||
      (proof.receipt.cancelled.every((id) => id === proof.intent.inputId) &&
        proof.receipt.responseHash ===
          digest(
            stableJson({
              still_queued: [],
              cancelled: proof.receipt.cancelled,
            }),
          )))
  );
}
const journalSchema = (terminalEvidence: Check, allowNativeIntent = false) =>
  optionalExact(
    {
      requestId: isId,
      scope,
      generation: isId,
      state: one(
        "CLAIM_PENDING",
        "CLAIMED",
        "SERVER_INTENT_PENDING",
        "SERVER_INTENT_CONFIRMED",
        "PROVIDER_INTENT",
        "ACKNOWLEDGED",
        "RUNNING",
        "TERMINAL",
        "UPLOADED",
        "UNKNOWN",
        "NOT_STARTED",
      ),
      snapshot: nullable(projected("claim")),
      native: nullable(exact({ threadId: string, turnId: string })),
      terminal: nullable(terminalEvidence),
      receipt: nullable(projected("complete")),
      reason: nullable(codes),
      toolCalls: list(
        optionalExact(
          {
            callId: string,
            payloadHash: isHash,
            operationId: nullable(isId),
            result: nullable(toolResult),
          },
          allowNativeIntent
            ? {
                repositoryIntent: validRepositoryIntent,
                repositoryObservation: validRepositoryObservation,
                peerEvidenceObservation: validPeerEvidenceObservation,
              }
            : {},
        ),
        256,
      ),
    },
    {
      sourceObservation: validSourceObservation,
      claimOperationId: isId,
      unstartedClosure: closure,
      ...(allowNativeIntent
        ? { nativeIntent, nativeInterruption, toolCancellations: list(nativeToolCancellation, 64) }
        : {}),
    },
  );
const journal = journalSchema(evidence);
const preparation = exact({
  operationId: isId,
  previousEpoch: positive,
  generation: isId,
  settings,
  candidate: nullable(context),
  state: one("PROVIDER_PENDING", "PROVIDER_CREATED", "CANDIDATE", "REPLACE_PENDING"),
});
const operation: Check = (v) => {
  if (
    !exact({
      operationId: isId,
      action: one(
        "ready",
        "claim",
        "start-intent",
        "lease",
        "question",
        "complete",
        "interrupt-ack",
        "observe",
      ),
      body: record,
      payloadHash: isHash,
      state: one("PENDING", "TRANSMITTED", "CONFIRMED", "CLOSED"),
      result: () => true,
    })(v)
  )
    return false;
  const op = v as unknown as RuntimeOperation;
  try {
    const body = validateBody(op.action, op.body);
    return (
      body.operationId === op.operationId &&
      stableJson(body) === stableJson(op.body) &&
      op.payloadHash === digest(stableJson({ action: op.action, body: op.body })) &&
      (op.state === "CONFIRMED"
        ? op.result !== null && projected(op.action)(op.result)
        : op.result === null)
    );
  } catch {
    return false;
  }
};
const recordSchema = (
  version: 1 | 2,
  settingsSchema: Check,
  contextSchema: Check,
  preparationSchema: Check,
  attemptSchema: Check,
) =>
  optionalExact(
    {
      version: one(version),
      scope,
      settings: nullable(settingsSchema),
      context: nullable(contextSchema),
      ready: bool,
      preparation: nullable(preparationSchema),
      attempts: list(attemptSchema, 256),
      operations: list(operation, 1024),
    },
    {
      archives: list(
        exact({
          hash: isHash,
          requestIds: (v) => list(isId, 4096)(v) && (v as unknown[]).length > 0,
        }),
        64,
      ),
      lastArchive: exact({ hash: isHash, attemptId: isId }),
    },
  );
const legacySchema = recordSchema(1, settings, context, preparation, journal);
const providerRequested = exact({ model: string, effort: nullable(string) });
const providerCapabilities = exact({
  runtime: one("codex", "claude"),
  version: string,
  models: list(
    exact({
      id: string,
      model: string,
      efforts: list(string, 12),
      defaultEffort: nullable(string),
      isDefault: bool,
    }),
    256,
  ),
  defaultSettings: nullable(providerRequested),
  snapshotHash: isHash,
  policy: one("CONFIRMED"),
});
const providerSettings = optionalExact(
  {
    provider: one("codex", "claude"),
    requested: providerRequested,
    capabilities: providerCapabilities,
    files: list(file, 32),
    handoff: text,
    publicScopeConfirmed: one(true),
    autoQuestionsConfirmed: bool,
  },
  { repositoryAccess: validRepositoryAccess },
);
const nativeHistoryEvidence: Check = (value) =>
  exact({
    state: one("VERIFIED"),
    format: one("claude-jsonl-v1"),
    recordCount: (v) => Number.isSafeInteger(v) && Number(v) >= 1 && Number(v) <= 4096,
    prefixHash: isHash,
  })(value) ||
  exact({ state: one("UNVERIFIED"), reason: one("MISSING_HISTORY", "HISTORY_REJECTED") })(value);
const providerContext = optionalExact(
  {
    ownership: one("CONNECTOR_CREATED"),
    generation: isId,
    threadId: string,
    root,
    epoch: positive,
    level: one("L1", "L2"),
    ownedTurns: list(
      optionalExact(
        { turnId: string, terminal },
        {
          toolPolicy: validToolPolicy,
          promptHash: isHash,
          resultHash: isHash,
          nativeInterruption,
          nativeHistory: nativeHistoryEvidence,
          toolCancellations: list(nativeToolCancellation, 64),
          toolReceipts: list(
            exact({ callId: string, payloadHash: isHash, responseHash: isHash }),
            64,
          ),
        },
      ),
      256,
    ),
  },
  {
    provider: one("codex", "claude"),
    materialization: exact({
      state: one("RESERVED", "MATERIALIZED"),
      version: string,
      policyFingerprint: isHash,
      initHash: nullable(isHash),
    }),
  },
);
const providerObservation = exact({
  requested: providerRequested,
  thread: exact({ model: nullable(string), provider: string, effort: nullable(string) }),
  turn: exact({
    requestedModel: string,
    requestedEffort: nullable(string),
    model: nullable(string),
    rerouted: bool,
    effortVerification: one("UNVERIFIED"),
  }),
});
const providerEvidence = optionalExact(
  {
    threadId: string,
    turnId: string,
    terminal,
    privateText: text,
    publicText: (v) =>
      typeof v === "string" && Buffer.byteLength(v) <= 8192 && Array.from(v).length <= 4000,
    finalItems: list(exact({ id: string, hash: isHash }), 256),
    textProof: one("FINAL_ANSWER", "UNCONFIRMED"),
    observation: providerObservation,
  },
  {
    nativeInitHash: isHash,
    nativeInterruption,
    nativeHistory: nativeHistoryEvidence,
    toolCancellations: list(nativeToolCancellation, 64),
  },
);
const providerPreparation = exact({
  operationId: isId,
  previousEpoch: positive,
  generation: isId,
  settings: providerSettings,
  candidate: nullable(providerContext),
  state: one("PROVIDER_PENDING", "PROVIDER_CREATED", "CANDIDATE", "REPLACE_PENDING"),
});
const providerSchema = recordSchema(
  2,
  providerSettings,
  providerContext,
  providerPreparation,
  journalSchema(providerEvidence, true),
);

export function validateRecordSchema(value: unknown): asserts value is RuntimeRecord {
  if (!legacySchema(value) && !providerSchema(value)) unsafe();
}
export function validSessionThreadId(value: unknown): boolean {
  return string(value);
}
export function validLockRecord(
  value: unknown,
  identity: string,
): value is Record<string, unknown> {
  return exact({ pid: positive, token: isId, identity: one(identity) })(value);
}
