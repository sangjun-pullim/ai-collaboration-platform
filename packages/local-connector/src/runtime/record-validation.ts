import { isOriginRoleRequestKind } from "../workspace/tool-contracts.ts";
import { isId, isHash } from "../contracts.ts";
import { projectCapability } from "../settings/contracts.ts";
import { supportsEffort } from "../runtime-settings-policy.ts";
import {
  codexVersion,
  stableJson,
  type AttemptJournal,
  type OwnedContext,
  type RuntimeSettings,
  type RuntimeRecord,
} from "../runtime-contracts.ts";
import { archiveRequestLimit } from "../runtime-archive.ts";
import { repositoryMode, validRepositoryAccess } from "../workspace/repository-access.ts";
import { validRepositoryCalls } from "../workspace/repository-observation.ts";
import { sourceEntries } from "../workflow/source-snapshot.ts";
import { record, unsafe, claimMatches, attemptMatches } from "./record-helpers.ts";
import { validateRecordSchema, validInterruption } from "./record-schema.ts";

function closureValid(a: AttemptJournal, v: RuntimeRecord) {
  const proof = a.unstartedClosure;
  if (
    !proof ||
    proof.claimOperationId !== a.claimOperationId ||
    a.native ||
    a.terminal ||
    a.receipt ||
    a.toolCalls.length ||
    a.snapshot?.startIntentAt != null
  )
    unsafe();
  const claim = v.operations.find((o) => claimMatches(a, o));
  if (proof.kind === "LOCAL_NOT_TRANSMITTED") {
    if (
      a.snapshot ||
      (claim && (!["PENDING", "CLOSED"].includes(claim.state) || claim.result !== null))
    )
      unsafe();
  } else if (proof.kind === "SERVER_INPUT_PAUSED") {
    if (
      !claim ||
      claim.state !== "CLOSED" ||
      claim.result !== null ||
      a.snapshot ||
      a.nativeIntent ||
      v.operations.some(
        (o) =>
          o.body.requestId === a.requestId &&
          o.body.bindingEpoch === a.scope.bindingEpoch &&
          o.action !== "claim" &&
          !v.attempts.some((other) => other !== a && attemptMatches(other, o)),
      )
    )
      unsafe();
  } else {
    const p = proof.snapshot;
    if (
      !claim ||
      p.state !== "ABANDONED" ||
      p.startIntentAt !== null ||
      p.requestId !== a.requestId ||
      p.agentId !== a.scope.agentId ||
      p.bindingEpoch !== a.scope.bindingEpoch
    )
      unsafe();
    for (const saved of [a.snapshot, claim.state === "CONFIRMED" ? claim.result : null]) {
      if (
        saved &&
        (!record(saved) ||
          saved.requestId !== p.requestId ||
          saved.agentId !== p.agentId ||
          saved.bindingEpoch !== p.bindingEpoch ||
          saved.attemptId !== p.attemptId ||
          saved.fence !== p.fence ||
          saved.startIntentAt !== null ||
          stableJson(saved.payload) !== stableJson(p.payload))
      )
        unsafe();
    }
  }
  if (
    v.operations.some(
      (o) =>
        attemptMatches(a, o) &&
        o.action === "start-intent" &&
        o.state === "CONFIRMED" &&
        record(o.result) &&
        o.result.startIntentAt !== null,
    )
  )
    unsafe();
}

export function validate(value: unknown): asserts value is RuntimeRecord {
  validateRecordSchema(value);
  const v = value as RuntimeRecord;
  // Keep the original rejection order across record relationships and each attempt.
  validateArchiveReferences(v);
  validateRecordIdentity(v);
  validateAttemptHistory(v);
  validateOwnedContextIdentity(v);
  validateSettings(v);
  validateContexts(v);
  validatePreparation(v);
  for (const a of v.attempts) validateAttempt(v, a);
  validateOperationRelationships(v);
  validateClosedOperations(v);
}
function validateArchiveReferences(v: RuntimeRecord) {
  const archivedIds = (v.archives ?? []).flatMap((ref) => ref.requestIds);
  if (
    archivedIds.length > archiveRequestLimit ||
    new Set(archivedIds).size !== archivedIds.length ||
    new Set((v.archives ?? []).map((ref) => ref.hash)).size !== (v.archives ?? []).length ||
    v.attempts.some((a) => archivedIds.includes(a.requestId)) ||
    (v.lastArchive && !(v.archives ?? []).some((ref) => ref.hash === v.lastArchive!.hash))
  )
    unsafe();
}
function validateRecordIdentity(v: RuntimeRecord) {
  if (
    new Set(v.attempts.filter((a) => a.claimOperationId).map((a) => a.claimOperationId)).size !==
      v.attempts.filter((a) => a.claimOperationId).length ||
    new Set(v.operations.map((o) => o.operationId)).size !== v.operations.length ||
    (v.ready && (!v.context || !v.settings || v.preparation))
  )
    unsafe();
}
function validateAttemptHistory(v: RuntimeRecord) {
  for (let i = 0; i < v.attempts.length; i++) {
    const a = v.attempts[i],
      older = v.attempts.slice(0, i).filter((old) => old.requestId === a.requestId);
    if (
      older.length &&
      (!a.claimOperationId ||
        older.some(
          (old) =>
            old.state !== "NOT_STARTED" ||
            !old.claimOperationId ||
            stableJson(old.scope) !== stableJson(a.scope) ||
            old.generation !== a.generation,
        ))
    )
      unsafe();
    if (
      a.snapshot &&
      older.some(
        (old) =>
          a.snapshot!.fence <=
          (old.snapshot?.fence ??
            (old.unstartedClosure?.kind === "SERVER_ABANDONED"
              ? old.unstartedClosure.snapshot.fence
              : 0)),
      )
    )
      unsafe();
  }
}
function validateOwnedContextIdentity(v: RuntimeRecord) {
  if (
    v.context &&
    (v.context.epoch !== v.scope.bindingEpoch ||
      new Set(v.context.ownedTurns.map((t) => t.turnId)).size !== v.context.ownedTurns.length)
  )
    unsafe();
}
function validateSettings(v: RuntimeRecord) {
  for (const s of [v.settings, v.preparation?.settings]) {
    if (!s) continue;
    if (
      s.repositoryAccess &&
      (v.version !== 2 || s.files.length !== 0 || !validRepositoryAccess(s.repositoryAccess))
    )
      unsafe();
    if (
      new Set(s.files.map((f) => f.path)).size !== s.files.length ||
      s.files.reduce((sum, f) => sum + f.size, 0) > 512 * 1024 ||
      !s.capabilities.models.some(
        (m) => m.model === s.requested.model && supportsEffort(s.provider, m, s.requested.effort),
      ) ||
      s.capabilities.models.some(
        (m) =>
          (!(s.provider === "claude" && m.defaultEffort === null) &&
            !supportsEffort(s.provider, m, m.defaultEffort)) ||
          new Set(m.efforts).size !== m.efforts.length,
      )
    )
      unsafe();
    if (v.version === 2) {
      if (s.capabilities.runtime !== s.provider) unsafe();
      try {
        projectCapability({ ...s.capabilities, runtime: s.provider, policy: "verified" });
      } catch {
        unsafe();
      }
    }
    if (s.provider === "codex" && s.capabilities.version !== codexVersion) unsafe();
  }
}
function validateContexts(v: RuntimeRecord) {
  for (const [c, s] of [
    [v.context, v.settings],
    [v.preparation?.candidate, v.preparation?.settings],
  ] as const) {
    if (!c || !s) continue;
    try {
      repositoryMode(s, c);
    } catch {
      unsafe();
    }
    if (s.provider === "claude") {
      validateClaudeContext(v, c, s);
    } else if (
      c.provider === "claude" ||
      c.materialization ||
      c.ownedTurns.some((turn) => turn.nativeInterruption || turn.nativeHistory)
    )
      unsafe();
  }
}
function validateClaudeContext(v: RuntimeRecord, c: OwnedContext, s: RuntimeSettings) {
  const m = c.materialization;
  if (
    v.version !== 2 ||
    c.provider !== "claude" ||
    !isId(c.threadId) ||
    !m ||
    m.version !== s.capabilities.version ||
    (m.state === "RESERVED" ? m.initHash !== null || c.ownedTurns.length > 0 : !isHash(m.initHash))
  )
    unsafe();
  if (
    c.ownedTurns.some(
      (turn) =>
        !isHash(turn.promptHash) ||
        !isHash(turn.resultHash) ||
        !turn.toolReceipts ||
        new Set(turn.toolReceipts.map((receipt) => receipt.callId)).size !==
          turn.toolReceipts.length ||
        (turn.toolCancellations &&
          ((turn.terminal !== "INTERRUPTED" && turn.toolCancellations.length > 0) ||
            new Set(turn.toolCancellations.map((c) => c.callId)).size !==
              turn.toolCancellations.length ||
            new Set(turn.toolCancellations.map((c) => c.controlId)).size !==
              turn.toolCancellations.length)),
    )
  )
    unsafe();
  for (const turn of c.ownedTurns) validateClaudeOwnedTurn(v, c, s, m, turn);
}
function validateClaudeOwnedTurn(
  v: RuntimeRecord,
  c: OwnedContext,
  s: RuntimeSettings,
  m: NonNullable<OwnedContext["materialization"]>,
  turn: OwnedContext["ownedTurns"][number],
) {
  const descriptor = v.attempts.find(
    (attempt) =>
      attempt.generation === c.generation && attempt.nativeIntent?.inputId === turn.turnId,
  )?.nativeIntent;
  if (
    (s.repositoryAccess && !turn.toolPolicy) ||
    (descriptor?.toolPolicy && stableJson(descriptor.toolPolicy) !== stableJson(turn.toolPolicy)) ||
    (turn.toolPolicy &&
      (turn.toolPolicy.mode !== repositoryMode(s, c) ||
        (turn.toolPolicy.peerAllowed && !s.autoQuestionsConfirmed)))
  )
    unsafe();
  const owningJournal = v.attempts.find(
    (a) => a.generation === c.generation && a.nativeIntent?.inputId === turn.turnId,
  );
  if (
    owningJournal?.terminal &&
    stableJson(owningJournal.terminal.nativeHistory ?? null) !==
      stableJson(turn.nativeHistory ?? null)
  )
    unsafe();
  const proof = turn.nativeInterruption;
  if (!proof) return;
  const intent = proof.intent;
  const journal = v.attempts.find(
    (a) => a.generation === c.generation && a.nativeIntent?.inputId === turn.turnId,
  );
  if (
    !validInterruption(proof) ||
    intent.sessionId !== c.threadId ||
    intent.inputId !== turn.turnId ||
    intent.promptHash !== turn.promptHash ||
    intent.generation !== c.generation ||
    intent.scope.bindingEpoch !== c.epoch ||
    stableJson(intent.scope) !== stableJson(v.scope) ||
    intent.policyFingerprint !== m.policyFingerprint ||
    (journal && stableJson(journal.nativeInterruption) !== stableJson(proof))
  )
    unsafe();
}
function validatePreparation(v: RuntimeRecord) {
  if (v.preparation) {
    const p = v.preparation,
      c = p.candidate;
    if (p.settings.repositoryAccess) {
      const approvedRoot = c?.root ?? v.context?.root;
      if (!approvedRoot) unsafe();
      try {
        repositoryMode(p.settings, { generation: p.generation, root: approvedRoot });
      } catch {
        unsafe();
      }
    }
    if (
      p.previousEpoch !== v.scope.bindingEpoch ||
      (p.state === "PROVIDER_PENDING" ? c !== null : c === null) ||
      (c &&
        (c.generation !== p.generation ||
          c.epoch !== p.previousEpoch + 1 ||
          c.level !== "L1" ||
          c.ownedTurns.length !== 0 ||
          (v.context && stableJson(c.root) !== stableJson(v.context.root))))
    )
      unsafe();
  }
}
function validateAttempt(v: RuntimeRecord, a: AttemptJournal) {
  validateAttemptClaim(v, a);
  validateAttemptScope(v, a);
  validateAttemptRepositoryPolicy(v, a);
  validateAttemptNativeEvidence(v, a);
  validateAttemptExecution(v, a);
  validateAttemptTerminal(v, a);
  validateAttemptTools(v, a);
}
function validateAttemptClaim(v: RuntimeRecord, a: AttemptJournal) {
  if (
    a.sourceObservation &&
    (a.unstartedClosure ||
      [
        "CLAIM_PENDING",
        "CLAIMED",
        "SERVER_INTENT_PENDING",
        "SERVER_INTENT_CONFIRMED",
        "NOT_STARTED",
      ].includes(a.state) ||
      !a.snapshot?.startIntentAt ||
      (a.generation === v.context?.generation &&
        (a.scope.bindingEpoch !== v.context.epoch ||
          !v.settings ||
          stableJson(a.sourceObservation.files.entries) !==
            stableJson(sourceEntries(v.settings.files)))))
  )
    unsafe();
  if (a.state === "NOT_STARTED") closureValid(a, v);
  else if (a.unstartedClosure) unsafe();
  const claim = v.operations.find((o) => o.operationId === a.claimOperationId);
  if ((claim && !claimMatches(a, claim)) || (a.claimOperationId && a.snapshot && !claim)) unsafe();
  if (claim?.state === "CONFIRMED" && a.snapshot) {
    const saved = claim.result as Record<string, unknown>;
    if (
      saved.attemptId !== a.snapshot.attemptId ||
      saved.fence !== a.snapshot.fence ||
      stableJson(saved.payload) !== stableJson(a.snapshot.payload)
    )
      unsafe();
  }
}
function validateAttemptScope(v: RuntimeRecord, a: AttemptJournal) {
  if (
    a.scope.agentId !== v.scope.agentId ||
    a.scope.deviceId !== v.scope.deviceId ||
    a.scope.roomId !== v.scope.roomId ||
    a.scope.server !== v.scope.server ||
    a.scope.organizationId !== v.scope.organizationId ||
    a.scope.bindingEpoch > v.scope.bindingEpoch
  )
    unsafe();
  if (
    a.snapshot &&
    (a.snapshot.requestId !== a.requestId ||
      a.snapshot.agentId !== a.scope.agentId ||
      a.snapshot.bindingEpoch !== a.scope.bindingEpoch)
  )
    unsafe();
  if (
    a.native &&
    (!a.snapshot ||
      (v.context?.generation === a.generation && a.native.threadId !== v.context.threadId))
  )
    unsafe();
}
function validateAttemptRepositoryPolicy(v: RuntimeRecord, a: AttemptJournal) {
  if (!validRepositoryCalls(a, v.settings, v.context, v.operations)) unsafe();
  if (v.settings?.repositoryAccess && a.nativeIntent && !a.nativeIntent.toolPolicy) unsafe();
  if (a.nativeIntent?.toolPolicy) {
    if (
      !v.settings ||
      !v.context ||
      a.nativeIntent.toolPolicy.mode !== repositoryMode(v.settings, v.context) ||
      (a.nativeIntent.toolPolicy.peerAllowed &&
        (!v.settings.autoQuestionsConfirmed ||
          !isOriginRoleRequestKind(a.snapshot?.payload.requestKind)))
    )
      unsafe();
  }
}
function validateAttemptNativeEvidence(v: RuntimeRecord, a: AttemptJournal) {
  if (a.nativeIntent) {
    const intent = a.nativeIntent;
    if (
      v.version !== 2 ||
      !a.snapshot ||
      stableJson(intent.scope) !== stableJson(a.scope) ||
      intent.generation !== a.generation ||
      intent.attemptId !== a.snapshot.attemptId ||
      intent.fence !== a.snapshot.fence ||
      (a.native &&
        (a.native.threadId !== intent.sessionId || a.native.turnId !== intent.inputId)) ||
      (v.context?.generation === a.generation &&
        (intent.sessionId !== v.context.threadId ||
          intent.policyFingerprint !== v.context.materialization?.policyFingerprint))
    )
      unsafe();
  }
  if (
    a.nativeInterruption &&
    (v.version !== 2 ||
      !a.nativeIntent ||
      !validInterruption(a.nativeInterruption) ||
      stableJson(a.nativeInterruption.intent) !== stableJson(a.nativeIntent))
  )
    unsafe();
  if (
    a.terminal &&
    stableJson(a.terminal.nativeInterruption ?? null) !== stableJson(a.nativeInterruption ?? null)
  )
    unsafe();
  if (a.terminal?.nativeHistory && (v.version !== 2 || a.nativeIntent?.provider !== "claude"))
    unsafe();
  if (
    v.settings?.provider === "claude" &&
    a.generation === v.context?.generation &&
    (["PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING", "TERMINAL", "UPLOADED"].includes(a.state) ||
      a.native) &&
    !a.nativeIntent
  )
    unsafe();
}
function validateAttemptExecution(v: RuntimeRecord, a: AttemptJournal) {
  if (
    ([
      "CLAIMED",
      "SERVER_INTENT_PENDING",
      "SERVER_INTENT_CONFIRMED",
      "PROVIDER_INTENT",
      "ACKNOWLEDGED",
      "RUNNING",
    ].includes(a.state) &&
      !a.snapshot) ||
    (["ACKNOWLEDGED", "RUNNING"].includes(a.state) && !a.native)
  )
    unsafe();
  if (
    ["PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING"].includes(a.state) &&
    (!a.snapshot?.startIntentAt ||
      !v.operations.some(
        (o) =>
          o.action === "start-intent" &&
          o.state === "CONFIRMED" &&
          o.body.attemptId === a.snapshot?.attemptId &&
          o.body.fence === a.snapshot?.fence,
      ))
  )
    unsafe();
}
function validateAttemptTerminal(v: RuntimeRecord, a: AttemptJournal) {
  if (
    a.terminal &&
    (!a.native ||
      a.terminal.threadId !== a.native.threadId ||
      a.terminal.turnId !== a.native.turnId ||
      (a.terminal.terminal !== "COMPLETED" && a.terminal.publicText !== ""))
  )
    unsafe();
  if (
    (["TERMINAL", "UPLOADED"].includes(a.state) && !a.terminal) ||
    (a.state === "UPLOADED" &&
      (!a.receipt ||
        a.receipt.requestId !== a.requestId ||
        a.receipt.attemptId !== a.snapshot?.attemptId ||
        a.receipt.terminal !== a.terminal?.terminal))
  )
    unsafe();
}
function validateAttemptTools(v: RuntimeRecord, a: AttemptJournal) {
  if (new Set(a.toolCalls.map((c) => c.callId)).size !== a.toolCalls.length) unsafe();
  if (a.toolCancellations) {
    if (
      v.version !== 2 ||
      !a.nativeIntent ||
      !a.native ||
      new Set(a.toolCancellations.map((c) => c.callId)).size !== a.toolCancellations.length ||
      new Set(a.toolCancellations.map((c) => c.controlId)).size !== a.toolCancellations.length ||
      a.toolCancellations.some(
        (c) =>
          !a.toolCalls.some(
            (tool) => tool.callId === c.callId && tool.payloadHash === c.payloadHash,
          ),
      ) ||
      (a.terminal && a.terminal.terminal !== "INTERRUPTED" && a.toolCancellations.length > 0) ||
      (a.terminal &&
        stableJson(a.terminal.toolCancellations ?? []) !== stableJson(a.toolCancellations))
    )
      unsafe();
  }
}
function validateOperationRelationships(v: RuntimeRecord) {
  for (const o of v.operations)
    if (
      o.body.agentId !== v.scope.agentId ||
      Number(o.body.bindingEpoch) > v.scope.bindingEpoch ||
      (o.body.requestId &&
        !v.attempts.some(
          (a) =>
            a.requestId === o.body.requestId &&
            a.scope.bindingEpoch === o.body.bindingEpoch &&
            (o.action === "claim"
              ? a.claimOperationId
                ? claimMatches(a, o)
                : v.attempts.filter((a) => a.requestId === o.body.requestId).length === 1
              : attemptMatches(a, o)),
        ))
    )
      unsafe();
}
function validateClosedOperations(v: RuntimeRecord) {
  for (const o of v.operations)
    if (
      o.state === "CLOSED" &&
      !v.attempts.some(
        (a) =>
          (["lease", "interrupt-ack"].includes(o.action) &&
            a.state === "UPLOADED" &&
            attemptMatches(a, o)) ||
          (a.state === "NOT_STARTED" &&
            (claimMatches(a, o) ||
              ((o.action === "start-intent" ||
                (o.action === "lease" && a.unstartedClosure?.kind === "SERVER_ABANDONED")) &&
                attemptMatches(a, o)))),
      )
    )
      unsafe();
}
