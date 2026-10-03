import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, readdir, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isId, isHash } from "./contracts.ts";
import { serviceOrigin } from "./central-client.ts";
import { validateBody, projectResponse, type DeviceAction } from "./workflow-contracts.ts";
import { codexVersion, digest, RuntimeError, stableJson, type AttemptJournal, type RuntimeRecord, type RuntimeOperation, type RuntimeScope } from "./runtime-contracts.ts";
import { RuntimeArchive, journalByteLimit, archiveReferenceLimit, archiveRequestLimit } from "./runtime-archive.ts";
import { isSelectedPath } from "./runtime-file-policy.ts";

type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (shape: Shape): Check => v => record(v) && Object.keys(v).length === Object.keys(shape).length && Object.entries(shape).every(([key, check]) => check(v[key]));
const optionalExact = (shape: Shape, optional: Shape): Check => v => record(v) && Object.keys(v).every(key => Object.hasOwn(shape, key) || Object.hasOwn(optional, key)) && Object.entries(shape).every(([key, check]) => check(v[key])) && Object.entries(optional).every(([key, check]) => !Object.hasOwn(v, key) || check(v[key]));
const one = (...choices: unknown[]): Check => v => choices.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const list = (check: Check, max: number): Check => v => Array.isArray(v) && v.length <= max && v.every(check);
const string: Check = v => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\0\r\n]/.test(v);
const text: Check = v => typeof v === "string" && Buffer.byteLength(v) <= 65536;
const number: Check = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
const uint: Check = v => number(v) && Number.isSafeInteger(v);
const positive: Check = v => uint(v) && Number(v) > 0;
const bool: Check = v => typeof v === "boolean";
const terminal = one("COMPLETED", "FAILED", "INTERRUPTED");
const scope = exact({ server: v => { try { serviceOrigin(String(v)); return true; } catch { return false; } }, deviceId: isId, organizationId: isId, roomId: isId, agentId: isId, bindingEpoch: positive });
const requested = exact({ model: string, effort: string });
const root = exact({ path: v => string(v) && String(v).startsWith("/"), dev: uint, ino: uint, uid: uint });
const file = exact({ path: isSelectedPath, dev: uint, ino: uint, size: v => uint(v) && Number(v) <= 65536, mtimeMs: number, ctimeMs: number, hash: isHash });
const model = exact({ id: string, model: string, efforts: list(string, 12), defaultEffort: string, isDefault: bool });
const capabilities = exact({ version: one(codexVersion), models: list(model, 256), defaultSettings: nullable(requested), snapshotHash: isHash, policy: one("CONFIRMED") });
const settings = exact({ provider: one("codex"), requested, capabilities, files: list(file, 32), handoff: text, publicScopeConfirmed: one(true), autoQuestionsConfirmed: bool });
const context = exact({ ownership: one("CONNECTOR_CREATED"), generation: isId, threadId: string, root, epoch: positive, level: one("L1", "L2"), ownedTurns: list(exact({ turnId: string, terminal }), 256) });
const observation = exact({ requested, thread: exact({ model: nullable(string), provider: string, effort: nullable(string) }), turn: exact({ requestedModel: string, requestedEffort: string, model: nullable(string), rerouted: bool, effortVerification: one("UNVERIFIED") }) });
const evidence = exact({ threadId: string, turnId: string, terminal, privateText: text, publicText: v => typeof v === "string" && Buffer.byteLength(v) <= 8192 && Array.from(v).length <= 4000, finalItems: list(exact({ id: string, hash: isHash }), 256), textProof: one("FINAL_ANSWER", "UNCONFIRMED"), observation });
const toolResult = exact({ success: bool, contentItems: list(exact({ type: one("inputText"), text }), 4) });
const projected = (action: DeviceAction): Check => v => { try { projectResponse(action, v); return true; } catch { return false; } };
const codes = one("RUNTIME_CAPACITY", "INVALID_RUNTIME", "UNSAFE_STORAGE", "RUNTIME_BUSY", "POLICY_UNCONFIRMED", "UNSUPPORTED_SETTINGS", "CONTEXT_UNCONFIRMED", "SNAPSHOT_CHANGED", "TOOL_REJECTED", "PUBLIC_TEXT_REJECTED", "AUTHORITY_LOST", "PROVIDER_UNAVAILABLE", "UNKNOWN", "CLEANUP_INCOMPLETE", "RUNTIME_CLOSED");
const closure: Check = v => exact({ kind: one("LOCAL_NOT_TRANSMITTED"), claimOperationId: isId })(v) || exact({ kind: one("SERVER_ABANDONED"), claimOperationId: isId, snapshot: projected("claim") })(v);
const journal = optionalExact({ requestId: isId, scope, generation: isId, state: one("CLAIM_PENDING", "CLAIMED", "SERVER_INTENT_PENDING", "SERVER_INTENT_CONFIRMED", "PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING", "TERMINAL", "UPLOADED", "UNKNOWN", "NOT_STARTED"), snapshot: nullable(projected("claim")), native: nullable(exact({ threadId: string, turnId: string })), terminal: nullable(evidence), receipt: nullable(projected("complete")), reason: nullable(codes), toolCalls: list(exact({ callId: string, payloadHash: isHash, operationId: nullable(isId), result: nullable(toolResult) }), 256) }, { claimOperationId: isId, unstartedClosure: closure });
const preparation = exact({ operationId: isId, previousEpoch: positive, generation: isId, settings, candidate: nullable(context), state: one("PROVIDER_PENDING", "PROVIDER_CREATED", "CANDIDATE", "REPLACE_PENDING") });
const operation: Check = v => {
  if (!exact({ operationId: isId, action: one("ready", "claim", "start-intent", "lease", "question", "complete", "interrupt-ack", "observe"), body: record, payloadHash: isHash, state: one("PENDING", "TRANSMITTED", "CONFIRMED", "CLOSED"), result: () => true })(v)) return false;
  const op = v as unknown as RuntimeOperation;
  try { const body = validateBody(op.action, op.body); return body.operationId === op.operationId && stableJson(body) === stableJson(op.body) && op.payloadHash === digest(stableJson({ action: op.action, body: op.body })) && (op.state === "CONFIRMED" ? op.result !== null && projected(op.action)(op.result) : op.result === null); } catch { return false; }
};
const schema = optionalExact({ version: one(1), scope, settings: nullable(settings), context: nullable(context), ready: bool, preparation: nullable(preparation), attempts: list(journal, 256), operations: list(operation, 1024) }, { archives: list(exact({ hash: isHash, requestIds: v => list(isId, 4096)(v) && (v as unknown[]).length > 0 }), 64), lastArchive: exact({ hash: isHash, attemptId: isId }) });
function unsafe(): never { throw new RuntimeError("UNSAFE_STORAGE"); }
function claimMatches(a: AttemptJournal, o: RuntimeOperation) { return o.action === "claim" && o.body.requestId === a.requestId && o.body.bindingEpoch === a.scope.bindingEpoch && o.operationId === a.claimOperationId; }
function attemptMatches(a: AttemptJournal, o: RuntimeOperation) {
  const snapshot = a.snapshot ?? (a.unstartedClosure?.kind === "SERVER_ABANDONED" ? a.unstartedClosure.snapshot : null);
  return !!snapshot && o.body.requestId === a.requestId && o.body.bindingEpoch === a.scope.bindingEpoch && o.body.attemptId === snapshot.attemptId && o.body.fence === snapshot.fence;
}
function closureValid(a: AttemptJournal, v: RuntimeRecord) {
  const proof = a.unstartedClosure;
  if (!proof || proof.claimOperationId !== a.claimOperationId || a.native || a.terminal || a.receipt || a.toolCalls.length || a.snapshot?.startIntentAt != null) unsafe();
  const claim = v.operations.find(o => claimMatches(a, o));
  if (proof.kind === "LOCAL_NOT_TRANSMITTED") { if (a.snapshot || claim && (!["PENDING", "CLOSED"].includes(claim.state) || claim.result !== null)) unsafe(); }
  else {
    const p = proof.snapshot;
    if (!claim || p.state !== "ABANDONED" || p.startIntentAt !== null || p.requestId !== a.requestId || p.agentId !== a.scope.agentId || p.bindingEpoch !== a.scope.bindingEpoch) unsafe();
    for (const saved of [a.snapshot, claim.state === "CONFIRMED" ? claim.result : null]) {
      if (saved && (!record(saved) || saved.requestId !== p.requestId || saved.agentId !== p.agentId || saved.bindingEpoch !== p.bindingEpoch || saved.attemptId !== p.attemptId || saved.fence !== p.fence || saved.startIntentAt !== null || stableJson(saved.payload) !== stableJson(p.payload))) unsafe();
    }
  }
  if (v.operations.some(o => attemptMatches(a, o) && o.action === "start-intent" && o.state === "CONFIRMED" && record(o.result) && o.result.startIntentAt !== null)) unsafe();
}
function validate(value: unknown): asserts value is RuntimeRecord {
  if (!schema(value)) unsafe(); const v = value as RuntimeRecord;
  const archivedIds = (v.archives ?? []).flatMap(ref => ref.requestIds);
  if (archivedIds.length > archiveRequestLimit || new Set(archivedIds).size !== archivedIds.length ||
      new Set((v.archives ?? []).map(ref => ref.hash)).size !== (v.archives ?? []).length ||
      v.attempts.some(a => archivedIds.includes(a.requestId)) ||
      v.lastArchive && !(v.archives ?? []).some(ref => ref.hash === v.lastArchive!.hash)) unsafe();
  if (new Set(v.attempts.filter(a => a.claimOperationId).map(a => a.claimOperationId)).size !== v.attempts.filter(a => a.claimOperationId).length || new Set(v.operations.map(o => o.operationId)).size !== v.operations.length || v.ready && (!v.context || !v.settings || v.preparation)) unsafe();
  for (let i = 0; i < v.attempts.length; i++) {
    const a = v.attempts[i], older = v.attempts.slice(0, i).filter(old => old.requestId === a.requestId);
    if (older.length && (!a.claimOperationId || older.some(old => old.state !== "NOT_STARTED" || !old.claimOperationId || stableJson(old.scope) !== stableJson(a.scope) || old.generation !== a.generation))) unsafe();
    if (a.snapshot && older.some(old => a.snapshot!.fence <= (old.snapshot?.fence ?? (old.unstartedClosure?.kind === "SERVER_ABANDONED" ? old.unstartedClosure.snapshot.fence : 0)))) unsafe();
  }
  if (v.context && (v.context.epoch !== v.scope.bindingEpoch || new Set(v.context.ownedTurns.map(t => t.turnId)).size !== v.context.ownedTurns.length)) unsafe();
  for (const s of [v.settings, v.preparation?.settings]) {
    if (!s) continue;
    if (new Set(s.files.map(f => f.path)).size !== s.files.length || s.files.reduce((sum, f) => sum + f.size, 0) > 512 * 1024 || !s.capabilities.models.some(m => m.model === s.requested.model && m.efforts.includes(s.requested.effort)) || s.capabilities.models.some(m => !m.efforts.length || !m.efforts.includes(m.defaultEffort) || new Set(m.efforts).size !== m.efforts.length)) unsafe();
  }
  if (v.preparation) {
    const p = v.preparation, c = p.candidate;
    if (p.previousEpoch !== v.scope.bindingEpoch || (p.state === "PROVIDER_PENDING" ? c !== null : c === null) || c && (c.generation !== p.generation || c.epoch !== p.previousEpoch + 1 || c.level !== "L1" || c.ownedTurns.length !== 0 || v.context && stableJson(c.root) !== stableJson(v.context.root))) unsafe();
  }
  for (const a of v.attempts) {
    if (a.state === "NOT_STARTED") closureValid(a, v); else if (a.unstartedClosure) unsafe();
    const claim = v.operations.find(o => o.operationId === a.claimOperationId);
    if (claim && !claimMatches(a, claim) || a.claimOperationId && a.snapshot && !claim) unsafe();
    if (claim?.state === "CONFIRMED" && a.snapshot) {
      const saved = claim.result as Record<string, unknown>;
      if (saved.attemptId !== a.snapshot.attemptId || saved.fence !== a.snapshot.fence || stableJson(saved.payload) !== stableJson(a.snapshot.payload)) unsafe();
    }
    if (a.scope.agentId !== v.scope.agentId || a.scope.deviceId !== v.scope.deviceId || a.scope.roomId !== v.scope.roomId || a.scope.server !== v.scope.server || a.scope.organizationId !== v.scope.organizationId || a.scope.bindingEpoch > v.scope.bindingEpoch) unsafe();
    if (a.snapshot && (a.snapshot.requestId !== a.requestId || a.snapshot.agentId !== a.scope.agentId || a.snapshot.bindingEpoch !== a.scope.bindingEpoch)) unsafe();
    if (a.native && (!a.snapshot || v.context?.generation === a.generation && a.native.threadId !== v.context.threadId)) unsafe();
    if (["CLAIMED", "SERVER_INTENT_PENDING", "SERVER_INTENT_CONFIRMED", "PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING"].includes(a.state) && !a.snapshot || ["ACKNOWLEDGED", "RUNNING"].includes(a.state) && !a.native) unsafe();
    if (["PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING"].includes(a.state) && (!a.snapshot?.startIntentAt || !v.operations.some(o => o.action === "start-intent" && o.state === "CONFIRMED" && o.body.attemptId === a.snapshot?.attemptId && o.body.fence === a.snapshot?.fence))) unsafe();
    if (a.terminal && (!a.native || a.terminal.threadId !== a.native.threadId || a.terminal.turnId !== a.native.turnId || a.terminal.terminal !== "COMPLETED" && a.terminal.publicText !== "")) unsafe();
    if (["TERMINAL", "UPLOADED"].includes(a.state) && !a.terminal || a.state === "UPLOADED" && (!a.receipt || a.receipt.requestId !== a.requestId || a.receipt.attemptId !== a.snapshot?.attemptId || a.receipt.terminal !== a.terminal?.terminal)) unsafe();
    if (new Set(a.toolCalls.map(c => c.callId)).size !== a.toolCalls.length) unsafe();
  }
  for (const o of v.operations) if (o.body.agentId !== v.scope.agentId || Number(o.body.bindingEpoch) > v.scope.bindingEpoch || o.body.requestId && !v.attempts.some(a => a.requestId === o.body.requestId && a.scope.bindingEpoch === o.body.bindingEpoch && (o.action === "claim" ? a.claimOperationId ? claimMatches(a, o) : v.attempts.filter(a => a.requestId === o.body.requestId).length === 1 : attemptMatches(a, o)))) unsafe();
  for (const o of v.operations) if (o.state === "CLOSED" && !v.attempts.some(a => ["lease", "interrupt-ack"].includes(o.action) && a.state === "UPLOADED" && attemptMatches(a, o) || a.state === "NOT_STARTED" && (claimMatches(a, o) || (o.action === "start-intent" || o.action === "lease" && a.unstartedClosure?.kind === "SERVER_ABANDONED") && attemptMatches(a, o)))) unsafe();
}
const transitions: Record<string, string[]> = {
  CLAIM_PENDING: ["CLAIMED", "UNKNOWN", "NOT_STARTED"], CLAIMED: ["SERVER_INTENT_PENDING", "UNKNOWN", "NOT_STARTED"], SERVER_INTENT_PENDING: ["SERVER_INTENT_CONFIRMED", "UNKNOWN", "NOT_STARTED"],
  SERVER_INTENT_CONFIRMED: ["PROVIDER_INTENT", "UNKNOWN", "NOT_STARTED"], PROVIDER_INTENT: ["ACKNOWLEDGED", "UNKNOWN"], ACKNOWLEDGED: ["RUNNING", "TERMINAL", "UNKNOWN"],
  RUNNING: ["TERMINAL", "UNKNOWN"], UNKNOWN: ["TERMINAL", "NOT_STARTED"], TERMINAL: ["UPLOADED"], UPLOADED: [], NOT_STARTED: [],
};
function confirmedReadyReceipt(operation: RuntimeOperation) {
  const result = operation.result;
  return operation.action === "ready" && operation.state === "CONFIRMED" && record(result) && result.agentId === operation.body.agentId && result.bindingEpoch === operation.body.bindingEpoch && result.reportedReady === operation.body.reportedReady;
}
function operationReferences(value: RuntimeRecord) {
  const refs = new Set(value.attempts.flatMap(a => a.toolCalls.map(c => c.operationId)));
  if (value.preparation) refs.add(value.preparation.operationId); return refs;
}
function removableReady(previous: RuntimeRecord, next: RuntimeRecord): Set<string> {
  const latest = next.operations.filter(o => o.action === "ready" && o.state === "CONFIRMED").at(-1);
  if (!latest || !confirmedReadyReceipt(latest)) return new Set();
  // A newer receipt can supersede the old latest only after its intent was already durable.
  const latestIndex = previous.operations.findIndex(o => o.operationId === latest.operationId);
  const beforeRefs = operationReferences(previous), afterRefs = operationReferences(next);
  return new Set(previous.operations.filter((o, index) => index < latestIndex && confirmedReadyReceipt(o) && !beforeRefs.has(o.operationId) && !afterRefs.has(o.operationId)).map(o => o.operationId));
}
/** Connector-local housekeeping; unresolved and execution evidence is never compacted. */
export function pruneConfirmedReady(value: RuntimeRecord): void {
  const removable = removableReady(value, value); value.operations = value.operations.filter(o => !removable.has(o.operationId));
}
function validateChange(previous: RuntimeRecord, next: RuntimeRecord) {
  if (stableJson(previous.archives ?? []) !== stableJson(next.archives ?? [])) unsafe();
  const added = next.attempts.slice(previous.attempts.length);
  if (stableJson(previous.lastArchive ?? null) !== stableJson(next.lastArchive ?? null) &&
      !(previous.lastArchive && !next.lastArchive && added.length > 0)) unsafe();
  const { bindingEpoch: beforeEpoch, ...before } = previous.scope; const { bindingEpoch: afterEpoch, ...after } = next.scope;
  const preparation = previous.preparation;
  const prepared = preparation?.state === "REPLACE_PENDING" && next.preparation === null && afterEpoch === preparation.previousEpoch + 1 && stableJson(next.context) === stableJson(preparation.candidate) && stableJson(next.settings) === stableJson(preparation.settings) && next.ready === false;
  const invalidated = !unresolvedRuntime(previous) && next.context === null && next.settings === null && next.preparation === null && next.ready === false;
  if (stableJson(before) !== stableJson(after) || afterEpoch !== beforeEpoch && !(afterEpoch === beforeEpoch + 1 && (prepared || invalidated))) unsafe();
  if (preparation) {
    const current = next.preparation;
    if (!current) { if (!prepared) unsafe(); }
    else {
      const { state: oldState, candidate: oldCandidate, ...oldIdentity } = preparation;
      const { state: newState, candidate: newCandidate, ...newIdentity } = current;
      const forward = { PROVIDER_PENDING: "PROVIDER_CREATED", PROVIDER_CREATED: "CANDIDATE", CANDIDATE: "REPLACE_PENDING", REPLACE_PENDING: null };
      if (stableJson(oldIdentity) !== stableJson(newIdentity) || oldState !== newState && forward[oldState] !== newState || oldCandidate !== null && stableJson(oldCandidate) !== stableJson(newCandidate) || oldState === newState && stableJson(oldCandidate) !== stableJson(newCandidate)) unsafe();
      if (afterEpoch !== beforeEpoch || stableJson(previous.context) !== stableJson(next.context) || stableJson(previous.settings) !== stableJson(next.settings)) unsafe();
    }
  } else if (next.preparation && (next.preparation.state !== "PROVIDER_PENDING" || next.preparation.candidate !== null)) unsafe();
  if (previous.context && !prepared && !invalidated) {
    const current = next.context;
    const { level: oldLevel, ownedTurns: oldTurns, ...oldIdentity } = previous.context;
    if (!current) unsafe();
    const { level: newLevel, ownedTurns: newTurns, ...newIdentity } = current;
    if (stableJson(oldIdentity) !== stableJson(newIdentity) || oldLevel === "L2" && newLevel !== "L2" ||
        stableJson(oldTurns) !== stableJson(newTurns.slice(0, oldTurns.length))) unsafe();
  }
  // Intent order determines the latest receipt; compaction must never reorder surviving intents.
  const positions = new Map(previous.operations.map((o, index) => [o.operationId, index])); let last = -1, appended = false;
  for (const operation of next.operations) {
    const position = positions.get(operation.operationId);
    if (position === undefined) appended = true;
    else { if (appended || position <= last) unsafe(); last = position; }
  }
  const readyDeletions = removableReady(previous, next);
  for (const old of previous.operations) {
    const current = next.operations.find(o => o.operationId === old.operationId);
    if (!current && readyDeletions.has(old.operationId)) continue;
    if (!current || old.action !== current.action || old.payloadHash !== current.payloadHash || stableJson(old.body) !== stableJson(current.body) || ["CONFIRMED", "CLOSED"].includes(old.state) && stableJson(old) !== stableJson(current) || old.state === "TRANSMITTED" && current.state === "PENDING") unsafe();
  }
  for (const [index, old] of previous.attempts.entries()) {
    const current = next.attempts[index];
    if (old.state === "UPLOADED" && stableJson(old) !== stableJson(current)) unsafe();
    if (!current || old.requestId !== current.requestId || old.claimOperationId && old.claimOperationId !== current.claimOperationId || old.unstartedClosure && stableJson(old) !== stableJson(current)) unsafe();
    if (!old.claimOperationId && current.claimOperationId) {
      const claims = previous.operations.filter(o => o.action === "claim" && o.body.requestId === old.requestId && o.body.bindingEpoch === old.scope.bindingEpoch);
      if (claims.length !== 1 || claims[0].operationId !== current.claimOperationId) unsafe();
    }
    if (current.unstartedClosure?.kind === "LOCAL_NOT_TRANSMITTED" && previous.operations.some(o => claimMatches(current, o) && !["PENDING", "CLOSED"].includes(o.state))) unsafe();
    if (!old.unstartedClosure && current.unstartedClosure?.kind === "SERVER_ABANDONED" && !previous.operations.some(o => claimMatches(current, o) && ["TRANSMITTED", "CONFIRMED"].includes(o.state))) unsafe();
    if (current.unstartedClosure && stableJson(old.snapshot) !== stableJson(current.snapshot)) unsafe();
    if (!current || stableJson(old.scope) !== stableJson(current.scope) || old.generation !== current.generation || old.state !== current.state && !transitions[old.state].includes(current.state) || old.native && stableJson(old.native) !== stableJson(current.native) || old.terminal && stableJson(old.terminal) !== stableJson(current.terminal)) unsafe();
    if (old.snapshot && (!current.snapshot || old.snapshot.attemptId !== current.snapshot.attemptId || old.snapshot.fence !== current.snapshot.fence || stableJson(old.snapshot.payload) !== stableJson(current.snapshot.payload))) unsafe();
    if (old.snapshot?.startIntentAt && old.snapshot.startIntentAt !== current.snapshot?.startIntentAt) unsafe();
    if (old.receipt && stableJson(old.receipt) !== stableJson(current.receipt)) unsafe();
  }
  for (const appended of next.attempts.slice(previous.attempts.length)) {
    if ((previous.archives ?? []).some(ref => ref.requestIds.includes(appended.requestId))) unsafe();
    if (stableJson(appended.scope) !== stableJson(next.scope) || appended.generation !== next.context?.generation) unsafe();
    if (!appended.claimOperationId || appended.state !== "CLAIM_PENDING" || appended.snapshot || appended.unstartedClosure || appended.native || appended.terminal || appended.receipt || appended.toolCalls.length) unsafe();
    if (previous.attempts.some(old => old.requestId === appended.requestId && old.state !== "NOT_STARTED")) unsafe();
  }
}
async function directory(path: string, check: () => void = () => {}, privateRoot = path) {
  const parts: string[] = []; let p = resolve(path);
  while (p !== parse(p).root) { parts.unshift(p); p = dirname(p); }
  for (const part of parts) {
    let info; try { info = await lstat(part); check(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; check(); await mkdir(part, { mode: 0o700 }); check(); info = await lstat(part); check(); }
    if (!info.isDirectory() || info.isSymbolicLink()) unsafe();
    if ((part === privateRoot || part.startsWith(`${privateRoot}/`)) && (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)) unsafe();
  }
  const info = await lstat(path); check(); const canonical = await realpath(path); check();
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || canonical !== path) unsafe();
}
function secureFile(s: Stats, limit: number) { if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1 || s.size > limit) unsafe(); }
async function readSecure(path: string, limit: number, check = () => {}) {
  const before = await lstat(path); check(); secureFile(before, limit);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check(); const opened = await handle.stat(); check(); secureFile(opened, limit);
    if (before.ino !== opened.ino || before.dev !== opened.dev) unsafe();
    const data = Buffer.alloc(limit + 1); const { bytesRead } = await handle.read(data, 0, data.length, 0); check();
    const after = await handle.stat(); check(); const current = await lstat(path); check();
    if (bytesRead > limit || bytesRead !== opened.size || [after, current].some(s => s.dev !== opened.dev || s.ino !== opened.ino || s.size !== opened.size || s.mtimeMs !== opened.mtimeMs || s.ctimeMs !== opened.ctimeMs)) unsafe();
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead))), stat: opened, bytes: data.subarray(0, bytesRead) };
  } finally { await handle.close(); }
}
async function syncDirectory(path: string) { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
export function unresolvedRuntime(record: RuntimeRecord) { return !!record.preparation || record.attempts.some(a => !["UPLOADED", "NOT_STARTED"].includes(a.state)) || record.operations.some(o => !["CONFIRMED", "CLOSED"].includes(o.state)); }
function archiveAttemptId(attempt: AttemptJournal): string {
  return attempt.claimOperationId ?? attempt.snapshot!.attemptId;
}
function bundleOperations(value: RuntimeRecord, requests: Set<string>): Set<string> {
  const refs = new Set(value.attempts.filter(a => requests.has(a.requestId)).flatMap(a =>
    [a.claimOperationId, ...a.toolCalls.map(call => call.operationId)]));
  return new Set(value.operations.filter(op => requests.has(String(op.body.requestId)) || refs.has(op.operationId)).map(op => op.operationId));
}
function completedRequests(value: RuntimeRecord): string[] {
  return [...new Set(value.attempts.map(a => a.requestId))].filter(requestId => {
    const attempts = value.attempts.filter(a => a.requestId === requestId);
    if (!attempts.some(a => a.state === "UPLOADED") || attempts.some(a => a.state !== "UPLOADED" && !(a.state === "NOT_STARTED" && a.unstartedClosure))) return false;
    for (const attempt of attempts.filter(a => a.state === "UPLOADED")) {
      if (!value.operations.some(op => ["complete", "observe"].includes(op.action) && op.state === "CONFIRMED" &&
          attemptMatches(attempt, op) && op.body.terminal === attempt.terminal!.terminal &&
          op.body.publicText === attempt.terminal!.publicText && stableJson(op.result) === stableJson(attempt.receipt))) return false;
    }
    const operations = bundleOperations(value, new Set([requestId]));
    if (value.operations.some(op => operations.has(op.operationId) && !["CONFIRMED", "CLOSED"].includes(op.state))) return false;
    if (value.preparation && operations.has(value.preparation.operationId)) return false;
    return !value.attempts.some(a => a.requestId !== requestId &&
      (a.claimOperationId && operations.has(a.claimOperationId) || a.toolCalls.some(call => call.operationId && operations.has(call.operationId))));
  });
}

// These are bytes left free under the 2 MiB cap, not whole-file size thresholds.
export const terminalReserveBytes = 1536 * 1024;
export const admissionReserveBytes = 1792 * 1024;
export const terminalReserveOperations = 8;
export function assertRuntimeCapacity(value: RuntimeRecord, admission = false, extraBytes = 0, extraOperations = 0): void {
  const reserve = admission ? admissionReserveBytes : terminalReserveBytes;
  if (Buffer.byteLength(JSON.stringify(value)) + extraBytes + reserve > journalByteLimit ||
      value.operations.length + extraOperations + terminalReserveOperations + (admission ? 2 : 0) > 1024 ||
      admission && (value.attempts.length >= 256 || (value.context?.ownedTurns.length ?? 0) >= 256 ||
        (value.archives ?? []).length >= archiveReferenceLimit ||
        (value.archives ?? []).reduce((sum, ref) => sum + ref.requestIds.length, 0) >= archiveRequestLimit)) {
    throw new RuntimeError("RUNTIME_CAPACITY");
  }
}
export class RuntimeStore {
  readonly dir: string; readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly archive: RuntimeArchive;
  constructor(readonly stateDir: string, readonly profile: string, readonly agentId: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile) || !isId(agentId)) unsafe();
    this.dir = join(resolve(stateDir), "runtime", profile); this.file = join(this.dir, `${agentId}.json`);
    this.archive = new RuntimeArchive(this.dir, agentId);
  }
  async read(): Promise<RuntimeRecord | undefined> {
    await directory(resolve(this.stateDir)); await directory(this.dir, () => {}, resolve(this.stateDir));
    try { const { value } = await readSecure(this.file, 2 * 1024 * 1024); validate(value); if (value.scope.agentId !== this.agentId) unsafe(); await this.archiveRecords(value); return value; }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; if (e instanceof RuntimeError) throw e; unsafe(); }
  }
  write(value: RuntimeRecord, check = () => {}): Promise<void> {
    const snapshot = structuredClone(value); validate(snapshot); if (snapshot.scope.agentId !== this.agentId) unsafe();
    const work = this.writes.then(async () => {
      check(); await directory(resolve(this.stateDir), check); await directory(this.dir, check, resolve(this.stateDir)); check();
      let previous: RuntimeRecord | undefined;
      try { const input = await readSecure(this.file, 2 * 1024 * 1024, check); validate(input.value); previous = input.value; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      check();
      if (previous) {
        await this.archiveRecords(previous, check);
        validateChange(previous, snapshot);
      } else if ((snapshot.archives ?? []).length || snapshot.lastArchive) unsafe();
      await this.archiveRecords(snapshot, check);
      check();
      const bytes = JSON.stringify(snapshot); if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) unsafe();
      const temp = join(this.dir, `.${this.agentId}-${randomUUID()}.tmp`); let handle: FileHandle | undefined;
      try {
        check(); handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); check();
        await handle.writeFile(bytes); check(); await handle.sync(); check(); await handle.close(); handle = undefined; check();
        try { const current = await lstat(this.file); check(); secureFile(current, 2 * 1024 * 1024); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        check(); await rename(temp, this.file); await syncDirectory(this.dir); check();
      } finally { await handle?.close(); await unlink(temp).catch(() => {}); }
    });
    this.writes = work.catch(() => {}); return work;
  }
  private async archiveRecords(value: RuntimeRecord, check = () => {}): Promise<RuntimeRecord[]> {
    const refs = value.archives ?? [];
    const bytes = await this.archive.verify(refs, check);
    const records: RuntimeRecord[] = [];
    let previousEpoch = 0;
    for (let index = 0; index < refs.length; index++) {
      let source: unknown;
      try {
        source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes[index]));
      }
      catch { unsafe(); }
      validate(source);
      const { bindingEpoch: epoch, ...scope } = source.scope;
      const { bindingEpoch: currentEpoch, ...currentScope } = value.scope;
      if (stableJson(scope) !== stableJson(currentScope) || epoch > currentEpoch || epoch < previousEpoch ||
          stableJson(source.archives ?? []) !== stableJson(refs.slice(0, index))) unsafe();
      previousEpoch = epoch;
      const eligible = completedRequests(source);
      const selected = refs[index].requestIds;
      if (selected.some(id => !eligible.includes(id)) ||
          stableJson(selected) !== stableJson(eligible.filter(id => selected.includes(id)))) unsafe();
      if (source.lastArchive) {
        const prior = records.find((_, i) => refs[i].hash === source.lastArchive!.hash);
        if (!prior || prior.attempts.filter(a => archiveAttemptId(a) === source.lastArchive!.attemptId &&
            refs[records.indexOf(prior)].requestIds.includes(a.requestId)).length !== 1) unsafe();
      }
      records.push(source);
    }
    if (value.lastArchive) {
      const index = refs.findIndex(ref => ref.hash === value.lastArchive!.hash);
      if (index < 0 || records[index].attempts.filter(a => archiveAttemptId(a) === value.lastArchive!.attemptId && refs[index].requestIds.includes(a.requestId)).length !== 1) unsafe();
    }
    return records;
  }
  async lastAttempt(value: RuntimeRecord): Promise<AttemptJournal | undefined> {
    validate(value);
    if (value.scope.agentId !== this.agentId) unsafe();
    const records = await this.archiveRecords(value);
    if (!value.lastArchive) return value.attempts.at(-1);
    const index = (value.archives ?? []).findIndex(ref => ref.hash === value.lastArchive!.hash);
    return structuredClone(records[index].attempts.find(a => archiveAttemptId(a) === value.lastArchive!.attemptId));
  }
  compact(value: RuntimeRecord, check = () => {}): Promise<RuntimeRecord> {
    const snapshot = structuredClone(value);
    validate(snapshot);
    const work = this.writes.then(async () => {
      check();
      await directory(resolve(this.stateDir), check);
      await directory(this.dir, check, resolve(this.stateDir));
      const input = await readSecure(this.file, journalByteLimit, check);
      validate(input.value);
      if (input.value.scope.agentId !== this.agentId || stableJson(input.value) !== stableJson(snapshot)) unsafe();
      await this.archiveRecords(input.value, check);
      const requestIds = completedRequests(snapshot);
      if (!requestIds.length) return snapshot;
      const refs = snapshot.archives ?? [];
      if (refs.length >= archiveReferenceLimit || refs.reduce((sum, ref) => sum + ref.requestIds.length, 0) + requestIds.length > archiveRequestLimit) {
        throw new RuntimeError("RUNTIME_CAPACITY");
      }
      const next = structuredClone(snapshot);
      const removedOperations = bundleOperations(snapshot, new Set(requestIds));
      const hash = digest(input.bytes);
      next.archives = [...refs, { hash, requestIds }];
      const last = snapshot.attempts.at(-1);
      if (!snapshot.lastArchive && last && requestIds.includes(last.requestId)) {
        next.lastArchive = { hash, attemptId: archiveAttemptId(last) };
      }
      next.attempts = next.attempts.filter(a => !requestIds.includes(a.requestId));
      next.operations = next.operations.filter(o => !removedOperations.has(o.operationId));
      validate(next);
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > journalByteLimit) throw new RuntimeError("RUNTIME_CAPACITY");
      // No general write can use this deletion exception. The source is the exact owned disk bytes.
      await this.archive.save(input.bytes, check);
      await this.archiveRecords(next, check);
      const temp = join(this.dir, `.${this.agentId}-${randomUUID()}.tmp`);
      let handle: FileHandle | undefined;
      try {
        check();
        handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        check();
        await handle.writeFile(bytes);
        check();
        await handle.sync();
        check();
        await handle.close();
        handle = undefined;
        const current = await readSecure(this.file, journalByteLimit, check);
        if (!current.bytes.equals(input.bytes)) unsafe();
        check();
        await rename(temp, this.file);
        await syncDirectory(this.dir);
        check();
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
      return next;
    });
    this.writes = work.catch(() => {});
    return work;
  }
  async drainWrites() { await this.writes; }
  async locked<T>(run: (recovered: boolean) => Promise<T>) {
    await directory(resolve(this.stateDir)); await directory(this.dir, () => {}, resolve(this.stateDir));
    return this.lock(join(this.dir, `${this.agentId}.lock`), digest(this.file), run);
  }
  async sessionLocked<T>(threadId: string, run: (recovered: boolean) => Promise<T>) {
    if (!string(threadId)) unsafe();
    const parent = join(await realpath(tmpdir()), `ai-collab-owned-sessions-${process.getuid?.()}`); await directory(parent);
    return this.lock(join(parent, `${digest(threadId)}.lock`), digest(threadId), run);
  }
  private async lock<T>(path: string, identity: string, run: (recovered: boolean) => Promise<T>): Promise<T> {
    let handle: FileHandle; let recovered = false;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") unsafe();
      const recoveryPath = `${path}.recovery`; let recovery: FileHandle;
      try { recovery = await open(recoveryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); } catch { throw new RuntimeError("RUNTIME_BUSY"); }
      try {
        const old = await readSecure(path, 4096); const value = old.value;
        if (!exact({ pid: positive, token: isId, identity: one(identity) })(value)) unsafe();
        try { process.kill(Number(value.pid), 0); throw new RuntimeError("RUNTIME_BUSY"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new RuntimeError("RUNTIME_BUSY"); }
        const current = await lstat(path); if (current.ino !== old.stat.ino || current.dev !== old.stat.dev) unsafe();
        await unlink(path); handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); recovered = true;
      } finally { await recovery.close(); await unlink(recoveryPath); }
    }
    const token = randomUUID(); const own = await handle.stat(); let retain = false;
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, identity })); await handle.sync(); await syncDirectory(dirname(path)); return await run(recovered); }
    catch (error) { if (error instanceof RuntimeError && error.code === "CLEANUP_INCOMPLETE") retain = true; throw error; }
    finally {
      await this.drainWrites(); await handle.close();
      if (!retain) {
        const current = await readSecure(path, 4096);
        if (current.stat.ino !== own.ino || current.stat.dev !== own.dev || (current.value as { token: string }).token !== token) unsafe();
        await unlink(path); await syncDirectory(dirname(path));
      }
    }
  }
  async remove() {
    const record = await this.read(); if (record && unresolvedRuntime(record)) throw new RuntimeError("RUNTIME_BUSY");
    if (record) { await unlink(this.file); await syncDirectory(this.dir); }
  }
  static async agents(stateDir: string, profile: string): Promise<string[]> {
    const parent = join(resolve(stateDir), "runtime", profile);
    try { await directory(parent, () => {}, resolve(stateDir)); return (await readdir(parent)).filter(name => name.endsWith(".json") && isId(name.slice(0, -5))).map(name => name.slice(0, -5)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  }
}
export function runtimeRecord(scope: RuntimeScope): RuntimeRecord { return { version: 1, scope, settings: null, context: null, ready: false, preparation: null, attempts: [], operations: [] }; }
