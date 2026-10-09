import {
  stableJson,
  type AttemptJournal,
  type RuntimeOperation,
  type RuntimeRecord,
} from "../runtime-contracts.ts";
import { validRepositoryCallChange } from "../workspace/repository-observation.ts";
import { record, unsafe, claimMatches, unresolvedRuntime } from "./record-helpers.ts";

const transitions: Record<string, string[]> = {
  CLAIM_PENDING: ["CLAIMED", "UNKNOWN", "NOT_STARTED"],
  CLAIMED: ["SERVER_INTENT_PENDING", "UNKNOWN", "NOT_STARTED"],
  SERVER_INTENT_PENDING: ["SERVER_INTENT_CONFIRMED", "UNKNOWN", "NOT_STARTED"],
  SERVER_INTENT_CONFIRMED: ["PROVIDER_INTENT", "UNKNOWN", "NOT_STARTED"],
  PROVIDER_INTENT: ["ACKNOWLEDGED", "UNKNOWN"],
  ACKNOWLEDGED: ["RUNNING", "TERMINAL", "UNKNOWN"],
  RUNNING: ["TERMINAL", "UNKNOWN"],
  UNKNOWN: ["TERMINAL", "NOT_STARTED"],
  TERMINAL: ["UPLOADED"],
  UPLOADED: [],
  NOT_STARTED: [],
};

function confirmedReadyReceipt(operation: RuntimeOperation) {
  const result = operation.result;
  return (
    operation.action === "ready" &&
    operation.state === "CONFIRMED" &&
    record(result) &&
    result.agentId === operation.body.agentId &&
    result.bindingEpoch === operation.body.bindingEpoch &&
    result.reportedReady === operation.body.reportedReady
  );
}

function operationReferences(value: RuntimeRecord) {
  const refs = new Set(value.attempts.flatMap((a) => a.toolCalls.map((c) => c.operationId)));
  if (value.preparation) refs.add(value.preparation.operationId);
  return refs;
}

function removableReady(previous: RuntimeRecord, next: RuntimeRecord): Set<string> {
  const latest = next.operations
    .filter((o) => o.action === "ready" && o.state === "CONFIRMED")
    .at(-1);
  if (!latest || !confirmedReadyReceipt(latest)) return new Set();
  // A newer receipt can supersede the old latest only after its intent was already durable.
  const latestIndex = previous.operations.findIndex((o) => o.operationId === latest.operationId);
  const beforeRefs = operationReferences(previous),
    afterRefs = operationReferences(next);
  return new Set(
    previous.operations
      .filter(
        (o, index) =>
          index < latestIndex &&
          confirmedReadyReceipt(o) &&
          !beforeRefs.has(o.operationId) &&
          !afterRefs.has(o.operationId),
      )
      .map((o) => o.operationId),
  );
}

/** Connector-local housekeeping; unresolved and execution evidence is never compacted. */
export function pruneConfirmedReady(value: RuntimeRecord): void {
  const removable = removableReady(value, value);
  value.operations = value.operations.filter((o) => !removable.has(o.operationId));
}
export function validateChange(previous: RuntimeRecord, next: RuntimeRecord) {
  validateArchiveChange(previous, next);
  const scopeChange = validateScopeChange(previous, next);
  validatePreparationChange(previous, next, scopeChange);
  validateSettingsAndContextChange(previous, next, scopeChange);
  validateOperationOrder(previous, next);
  validateOperationChanges(previous, next);
  validateAttemptChanges(previous, next);
  validateAppendedAttempts(previous, next);
}
function validateArchiveChange(previous: RuntimeRecord, next: RuntimeRecord) {
  if (previous.version !== next.version) unsafe();
  if (stableJson(previous.archives ?? []) !== stableJson(next.archives ?? [])) unsafe();
  const added = next.attempts.slice(previous.attempts.length);
  if (
    stableJson(previous.lastArchive ?? null) !== stableJson(next.lastArchive ?? null) &&
    !(previous.lastArchive && !next.lastArchive && added.length > 0)
  )
    unsafe();
}
function validateScopeChange(previous: RuntimeRecord, next: RuntimeRecord) {
  const { bindingEpoch: beforeEpoch, ...before } = previous.scope;
  const { bindingEpoch: afterEpoch, ...after } = next.scope;
  const preparation = previous.preparation;
  const prepared =
    preparation?.state === "REPLACE_PENDING" &&
    next.preparation === null &&
    afterEpoch === preparation.previousEpoch + 1 &&
    stableJson(next.context) === stableJson(preparation.candidate) &&
    stableJson(next.settings) === stableJson(preparation.settings) &&
    next.ready === false;
  const invalidated =
    !unresolvedRuntime(previous) &&
    next.context === null &&
    next.settings === null &&
    next.preparation === null &&
    next.ready === false;
  if (
    stableJson(before) !== stableJson(after) ||
    (afterEpoch !== beforeEpoch && !(afterEpoch === beforeEpoch + 1 && (prepared || invalidated)))
  )
    unsafe();
  return { preparation, prepared, invalidated, beforeEpoch, afterEpoch };
}
type ScopeChange = ReturnType<typeof validateScopeChange>;
function validatePreparationChange(
  previous: RuntimeRecord,
  next: RuntimeRecord,
  { preparation, prepared, beforeEpoch, afterEpoch }: ScopeChange,
) {
  if (preparation) {
    const current = next.preparation;
    if (!current) {
      if (!prepared) unsafe();
    } else {
      const { state: oldState, candidate: oldCandidate, ...oldIdentity } = preparation;
      const { state: newState, candidate: newCandidate, ...newIdentity } = current;
      const forward = {
        PROVIDER_PENDING: "PROVIDER_CREATED",
        PROVIDER_CREATED: "CANDIDATE",
        CANDIDATE: "REPLACE_PENDING",
        REPLACE_PENDING: null,
      };
      if (
        stableJson(oldIdentity) !== stableJson(newIdentity) ||
        (oldState !== newState && forward[oldState] !== newState) ||
        (oldCandidate !== null && stableJson(oldCandidate) !== stableJson(newCandidate)) ||
        (oldState === newState && stableJson(oldCandidate) !== stableJson(newCandidate))
      )
        unsafe();
      if (
        afterEpoch !== beforeEpoch ||
        stableJson(previous.context) !== stableJson(next.context) ||
        stableJson(previous.settings) !== stableJson(next.settings)
      )
        unsafe();
    }
  } else if (
    next.preparation &&
    (next.preparation.state !== "PROVIDER_PENDING" || next.preparation.candidate !== null)
  )
    unsafe();
}
function validateSettingsAndContextChange(
  previous: RuntimeRecord,
  next: RuntimeRecord,
  { prepared, invalidated }: ScopeChange,
) {
  if (
    !prepared &&
    !invalidated &&
    (previous.settings?.repositoryAccess || next.settings?.repositoryAccess) &&
    stableJson(previous.settings) !== stableJson(next.settings)
  )
    unsafe();
  if (previous.context && !prepared && !invalidated) {
    const current = next.context;
    const {
      level: oldLevel,
      ownedTurns: oldTurns,
      materialization: oldMaterialization,
      ...oldIdentity
    } = previous.context;
    if (!current) unsafe();
    const {
      level: newLevel,
      ownedTurns: newTurns,
      materialization: newMaterialization,
      ...newIdentity
    } = current;
    if (
      stableJson(oldIdentity) !== stableJson(newIdentity) ||
      (oldLevel === "L2" && newLevel !== "L2") ||
      stableJson(oldTurns) !== stableJson(newTurns.slice(0, oldTurns.length))
    )
      unsafe();
    if (stableJson(oldMaterialization ?? null) !== stableJson(newMaterialization ?? null)) {
      if (
        !oldMaterialization ||
        !newMaterialization ||
        oldMaterialization.state !== "RESERVED" ||
        newMaterialization.state !== "MATERIALIZED" ||
        stableJson({
          ...oldMaterialization,
          state: "MATERIALIZED",
          initHash: newMaterialization.initHash,
        }) !== stableJson(newMaterialization) ||
        !next.attempts.some(
          (a) =>
            a.nativeIntent?.sessionId === current.threadId &&
            a.native?.threadId === current.threadId &&
            a.native.turnId === a.nativeIntent.inputId,
        )
      )
        unsafe();
    }
  }
}
function validateOperationOrder(previous: RuntimeRecord, next: RuntimeRecord) {
  // Intent order determines the latest receipt; compaction must never reorder surviving intents.
  const positions = new Map(previous.operations.map((o, index) => [o.operationId, index]));
  let last = -1,
    appended = false;
  for (const operation of next.operations) {
    const position = positions.get(operation.operationId);
    if (position === undefined) appended = true;
    else {
      if (appended || position <= last) unsafe();
      last = position;
    }
  }
}
function validateOperationChanges(previous: RuntimeRecord, next: RuntimeRecord) {
  const readyDeletions = removableReady(previous, next);
  for (const old of previous.operations) {
    const current = next.operations.find((o) => o.operationId === old.operationId);
    if (!current && readyDeletions.has(old.operationId)) continue;
    if (
      !current ||
      old.action !== current.action ||
      old.payloadHash !== current.payloadHash ||
      stableJson(old.body) !== stableJson(current.body) ||
      (["CONFIRMED", "CLOSED"].includes(old.state) && stableJson(old) !== stableJson(current)) ||
      (old.state === "TRANSMITTED" && current.state === "PENDING")
    )
      unsafe();
  }
}
function validateAttemptChanges(previous: RuntimeRecord, next: RuntimeRecord) {
  for (const [index, old] of previous.attempts.entries()) {
    const current = next.attempts[index];
    if (!current || !validRepositoryCallChange(old, current)) unsafe();
    validateSourceObservationChange(old, current, next);
    validateAttemptIdentityAndClosureChange(old, current, previous);
    validateAttemptEvidenceChange(old, current);
    validateAttemptInterruptionChange(old, current);
  }
}
function validateSourceObservationChange(
  old: AttemptJournal,
  current: AttemptJournal,
  next: RuntimeRecord,
) {
  if (
    old.sourceObservation &&
    stableJson(old.sourceObservation) !== stableJson(current?.sourceObservation)
  )
    unsafe();
  if (
    !old.sourceObservation &&
    current?.sourceObservation &&
    (old.state !== "SERVER_INTENT_CONFIRMED" ||
      current.state !== "PROVIDER_INTENT" ||
      !old.snapshot?.startIntentAt ||
      !next.context ||
      !next.settings ||
      old.generation !== next.context.generation ||
      old.scope.bindingEpoch !== next.context.epoch ||
      stableJson(old.scope) !== stableJson(next.scope))
  )
    unsafe();
}
function validateAttemptIdentityAndClosureChange(
  old: AttemptJournal,
  current: AttemptJournal,
  previous: RuntimeRecord,
) {
  if (old.state === "UPLOADED" && stableJson(old) !== stableJson(current)) unsafe();
  if (
    !current ||
    old.requestId !== current.requestId ||
    (old.claimOperationId && old.claimOperationId !== current.claimOperationId) ||
    (old.unstartedClosure && stableJson(old) !== stableJson(current))
  )
    unsafe();
  if (!old.claimOperationId && current.claimOperationId) {
    const claims = previous.operations.filter(
      (o) =>
        o.action === "claim" &&
        o.body.requestId === old.requestId &&
        o.body.bindingEpoch === old.scope.bindingEpoch,
    );
    if (claims.length !== 1 || claims[0].operationId !== current.claimOperationId) unsafe();
  }
  if (
    current.unstartedClosure?.kind === "LOCAL_NOT_TRANSMITTED" &&
    previous.operations.some(
      (o) => claimMatches(current, o) && !["PENDING", "CLOSED"].includes(o.state),
    )
  )
    unsafe();
  if (
    !old.unstartedClosure &&
    current.unstartedClosure?.kind === "SERVER_ABANDONED" &&
    !previous.operations.some(
      (o) => claimMatches(current, o) && ["TRANSMITTED", "CONFIRMED"].includes(o.state),
    )
  )
    unsafe();
  if (!old.unstartedClosure && current.unstartedClosure?.kind === "SERVER_INPUT_PAUSED") {
    const claim = previous.operations.find((o) => claimMatches(current, o));
    if (
      !claim ||
      claim.state !== "TRANSMITTED" ||
      claim.result !== null ||
      old.snapshot ||
      old.nativeIntent ||
      old.native ||
      old.terminal ||
      old.receipt ||
      old.toolCalls.length
    )
      unsafe();
  }
  if (current.unstartedClosure && stableJson(old.snapshot) !== stableJson(current.snapshot))
    unsafe();
}
function validateAttemptEvidenceChange(old: AttemptJournal, current: AttemptJournal) {
  if (
    !current ||
    stableJson(old.scope) !== stableJson(current.scope) ||
    old.generation !== current.generation ||
    (old.state !== current.state && !transitions[old.state].includes(current.state)) ||
    (old.native && stableJson(old.native) !== stableJson(current.native)) ||
    (old.nativeIntent && stableJson(old.nativeIntent) !== stableJson(current.nativeIntent)) ||
    (old.terminal && stableJson(old.terminal) !== stableJson(current.terminal))
  )
    unsafe();
  if (
    old.snapshot &&
    (!current.snapshot ||
      old.snapshot.attemptId !== current.snapshot.attemptId ||
      old.snapshot.fence !== current.snapshot.fence ||
      stableJson(old.snapshot.payload) !== stableJson(current.snapshot.payload))
  )
    unsafe();
  if (old.snapshot?.startIntentAt && old.snapshot.startIntentAt !== current.snapshot?.startIntentAt)
    unsafe();
  if (old.receipt && stableJson(old.receipt) !== stableJson(current.receipt)) unsafe();
}
function validateAttemptInterruptionChange(old: AttemptJournal, current: AttemptJournal) {
  if (
    old.nativeInterruption &&
    (!current.nativeInterruption ||
      stableJson(old.nativeInterruption.intent) !== stableJson(current.nativeInterruption.intent) ||
      old.nativeInterruption.intentHash !== current.nativeInterruption.intentHash ||
      old.nativeInterruption.requestHash !== current.nativeInterruption.requestHash ||
      (old.nativeInterruption.receipt &&
        stableJson(old.nativeInterruption.receipt) !==
          stableJson(current.nativeInterruption.receipt)))
  )
    unsafe();
  const interruptionAdded = !old.nativeInterruption && current.nativeInterruption;
  const receiptAdded = !old.nativeInterruption?.receipt && current.nativeInterruption?.receipt;
  if (
    ((interruptionAdded || receiptAdded) &&
      !["PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING"].includes(old.state)) ||
    (!old.nativeInterruption && current.nativeInterruption?.receipt)
  )
    unsafe();
  if (
    (old.toolCancellations ?? []).some(
      (c, index) => stableJson(c) !== stableJson(current.toolCancellations?.[index]),
    )
  )
    unsafe();
}
function validateAppendedAttempts(previous: RuntimeRecord, next: RuntimeRecord) {
  for (const appended of next.attempts.slice(previous.attempts.length)) {
    if ((previous.archives ?? []).some((ref) => ref.requestIds.includes(appended.requestId)))
      unsafe();
    if (
      stableJson(appended.scope) !== stableJson(next.scope) ||
      appended.generation !== next.context?.generation
    )
      unsafe();
    if (
      !appended.claimOperationId ||
      appended.state !== "CLAIM_PENDING" ||
      appended.snapshot ||
      appended.unstartedClosure ||
      appended.native ||
      appended.nativeIntent ||
      appended.sourceObservation ||
      appended.nativeInterruption ||
      appended.terminal ||
      appended.receipt ||
      appended.toolCalls.length
    )
      unsafe();
    if (
      previous.attempts.some(
        (old) => old.requestId === appended.requestId && old.state !== "NOT_STARTED",
      )
    )
      unsafe();
  }
}
