import { repositoryFileLimit } from "./safe-file-reader.ts";
import { isId, isHash } from "../contracts.ts";
import {
  digest,
  stableJson,
  type AttemptJournal,
  type RuntimeSettings,
  type OwnedContext,
  type RuntimeOperation,
} from "../runtime-contracts.ts";
import { approvalTime, repositoryMode } from "./repository-access.ts";
import { isRepositoryFile } from "./repository-path-policy.ts";
import { isOriginRoleRequestKind, isRepositoryTool } from "./tool-contracts.ts";

type Check = (value: unknown) => boolean;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const uint = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= repositoryFileLimit;
const positive = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= repositoryFileLimit + 1;
const exact = (value: unknown, shape: Record<string, Check>): value is Record<string, unknown> =>
  object(value) &&
  Object.keys(value).length === Object.keys(shape).length &&
  Object.entries(shape).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const base = { version: (value: unknown) => value === 1, generation: isId, approvalHash: isHash };
function selfHash(value: Record<string, unknown>, field: string) {
  const { [field]: hash, ...body } = value;
  return hash === digest(stableJson(body));
}
const excerpt = {
  path: (value: unknown) => typeof value === "string" && isRepositoryFile(value),
  hash: isHash,
  readAt: approvalTime,
  byteStart: uint,
  byteEnd: uint,
  excerptHash: isHash,
};
function validExcerpt(value: unknown, peer = false): boolean {
  return (
    exact(
      value,
      peer ? { ...excerpt, startLine: positive, endLine: positive, lineCount: positive } : excerpt,
    ) &&
    Number(value.byteEnd) >= Number(value.byteStart) &&
    (!peer ||
      (Number(value.endLine) >= Number(value.startLine) &&
        Number(value.endLine) <= Number(value.lineCount)))
  );
}
export function validRepositoryIntent(value: unknown): boolean {
  return (
    exact(value, {
      ...base,
      kind: (kind) => kind === "REPOSITORY_TOOL_INTENT",
      tool: (tool) => typeof tool === "string" && isRepositoryTool(tool),
      argumentsHash: isHash,
      createdAt: approvalTime,
      intentHash: isHash,
    }) && selfHash(value, "intentHash")
  );
}
export function validRepositoryObservation(value: unknown): boolean {
  return (
    exact(value, {
      ...base,
      kind: (kind) => kind === "REPOSITORY_TOOL_OBSERVATION",
      tool: (tool) => typeof tool === "string" && isRepositoryTool(tool),
      resultHash: isHash,
      files: (files) =>
        Array.isArray(files) && files.length <= 16 && files.every((file) => validExcerpt(file)),
      observationHash: isHash,
    }) &&
    selfHash(value, "observationHash") &&
    (value.tool !== "list_workspace_files" || (value.files as unknown[]).length === 0) &&
    (value.tool !== "read_workspace_file" || (value.files as unknown[]).length <= 1)
  );
}
export function validPeerEvidenceObservation(value: unknown): boolean {
  return (
    exact(value, {
      ...base,
      kind: (kind) => kind === "PEER_EVIDENCE_OBSERVATION",
      purpose: (purpose) => purpose === "VERIFIED_FOR_PEER_QUESTION",
      files: (files) =>
        Array.isArray(files) &&
        files.length >= 1 &&
        files.length <= 4 &&
        files.every((file) => validExcerpt(file, true)),
      observationHash: isHash,
    }) && selfHash(value, "observationHash")
  );
}
/** Validates trusted durable metadata only; it never derives observations from model JSON. */
export function validRepositoryCalls(
  attempt: AttemptJournal,
  settings: RuntimeSettings | null,
  context: OwnedContext | null,
  operations: RuntimeOperation[],
): boolean {
  const calls = attempt.toolCalls.filter(
    (call) => call.repositoryIntent || call.repositoryObservation || call.peerEvidenceObservation,
  );
  if (!calls.length) return true;
  if (
    !settings ||
    !context ||
    repositoryMode(settings, context) !== "AUTO_CODE" ||
    attempt.generation !== context.generation
  )
    return false;
  const approvalHash = digest(stableJson(settings.repositoryAccess));
  return calls.every((call) => {
    const intent = call.repositoryIntent,
      observation = call.repositoryObservation,
      peer = call.peerEvidenceObservation;
    if (
      [intent, observation, peer].some(
        (value) =>
          value && (value.generation !== context.generation || value.approvalHash !== approvalHash),
      )
    )
      return false;
    if (intent && (call.operationId !== null || peer || (call.result !== null && !observation)))
      return false;
    if (
      observation &&
      (!intent ||
        !call.result ||
        observation.tool !== intent.tool ||
        observation.resultHash !== digest(stableJson(call.result)))
    )
      return false;
    if (peer) {
      const operation = call.operationId;
      const saved = operations.find((item) => item.operationId === operation);
      if (
        !operation ||
        !saved ||
        saved.action !== "question" ||
        saved.body.requestId !== attempt.requestId ||
        saved.body.attemptId !== attempt.snapshot?.attemptId ||
        saved.body.fence !== attempt.snapshot?.fence ||
        (call.result !== null && (saved.state !== "CONFIRMED" || saved.result === null)) ||
        intent ||
        observation ||
        !settings.autoQuestionsConfirmed ||
        !isOriginRoleRequestKind(attempt.snapshot?.payload.requestKind) ||
        (settings.provider === "claude" && attempt.nativeIntent?.toolPolicy?.peerAllowed !== true)
      )
        return false;
    }
    return true;
  });
}
/** Automatic intent is saved before I/O; output is the sole permitted later enrichment. */
export function validRepositoryCallChange(before: AttemptJournal, after: AttemptJournal): boolean {
  for (const old of before.toolCalls) {
    const next = after.toolCalls.find((call) => call.callId === old.callId);
    if (!next) {
      if (old.repositoryIntent || old.repositoryObservation || old.peerEvidenceObservation)
        return false;
      else continue;
    }
    for (const key of [
      "repositoryIntent",
      "repositoryObservation",
      "peerEvidenceObservation",
    ] as const) {
      if (old[key] && stableJson(old[key]) !== stableJson(next[key])) return false;
      if (!old[key] && next[key] && key !== "repositoryObservation") return false;
    }
    if (
      next.repositoryObservation &&
      !old.repositoryObservation &&
      (!old.repositoryIntent || old.result || next.result === null)
    )
      return false;
    if (
      (old.repositoryIntent || old.peerEvidenceObservation) &&
      (old.payloadHash !== next.payloadHash ||
        old.operationId !== next.operationId ||
        (old.result && stableJson(old.result) !== stableJson(next.result)))
    )
      return false;
    if (
      (old.repositoryIntent || old.peerEvidenceObservation) &&
      ((!old.result && next.result) ||
        (!old.repositoryObservation && next.repositoryObservation)) &&
      (before.terminal ||
        before.toolCancellations?.some((cancel) => cancel.callId === old.callId) ||
        !["ACKNOWLEDGED", "RUNNING"].includes(before.state))
    )
      return false;
  }
  for (const call of after.toolCalls.filter(
    (call) => !before.toolCalls.some((old) => old.callId === call.callId),
  )) {
    if (
      (call.repositoryIntent || call.peerEvidenceObservation) &&
      (call.result !== null ||
        call.repositoryObservation ||
        before.terminal ||
        !["ACKNOWLEDGED", "RUNNING"].includes(before.state))
    )
      return false;
  }
  return true;
}
