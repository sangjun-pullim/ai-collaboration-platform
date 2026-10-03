import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, lstat, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore, pruneConfirmedReady, assertRuntimeCapacity, terminalReserveBytes, admissionReserveBytes } from "../src/runtime-store.ts";
import { RuntimeError, digest, stableJson, type RuntimeOperation, type AttemptJournal, type TerminalEvidence } from "../src/runtime-contracts.ts";
import { runtimeFixture, uuid, observation, appendFixtureCompletion } from "./runtime-fixture.ts";
import { runnerFixture, SyntheticAdapter } from "./runner-fixture.ts";

test("should reject duplicate live claims forged unstarted proofs and changes to closed attempt evidence", async () => {
  const f = await runnerFixture();
  try {
    f.queue(); await f.runner(f.adapter, { beforeMutation: async kind => { if (kind === "server-intent") throw new RuntimeError("UNKNOWN"); } }).run({ once: true });
    const before = (await f.store.read())!, a = before.attempts[0], claim = before.operations.find(o => o.operationId === a.claimOperationId)!;
    const proof = { ...structuredClone(a.snapshot!), state: "ABANDONED" as const, startIntentAt: null };
    const mutations: ((value: typeof before) => void)[] = [
      value => { value.attempts.push({ ...structuredClone(a), claimOperationId: uuid() }); },
      value => { value.attempts[0].state = "NOT_STARTED"; },
      value => { value.attempts[0].claimOperationId = uuid(); },
      value => { value.attempts[0].state = "NOT_STARTED"; value.attempts[0].unstartedClosure = { kind: "LOCAL_NOT_TRANSMITTED", claimOperationId: claim.operationId }; },
      ...["attemptId", "requestId", "agentId", "bindingEpoch", "fence", "startIntentAt", "payload", "unknown"].map(field => (value: typeof before) => {
        const forged = structuredClone(proof) as unknown as Record<string, unknown>;
        forged[field] = field === "fence" || field === "bindingEpoch" ? 2 : field === "startIntentAt" ? new Date().toISOString() : field === "payload" ? { ...proof.payload, publicText: "SYNTHETIC_CHANGED" } : uuid();
        value.attempts[0].state = "NOT_STARTED"; value.attempts[0].unstartedClosure = { kind: "SERVER_ABANDONED", claimOperationId: claim.operationId, snapshot: forged as unknown as typeof proof };
      }),
      value => { value.attempts[0].state = "NOT_STARTED"; value.attempts[0].unstartedClosure = { kind: "SERVER_ABANDONED", claimOperationId: claim.operationId, snapshot: proof }; value.attempts[0].snapshot = proof; },
      value => { value.attempts[0].state = "NOT_STARTED"; value.attempts[0].unstartedClosure = { kind: "SERVER_ABANDONED", claimOperationId: claim.operationId, snapshot: proof }; value.attempts[0].toolCalls.push({ callId: "SYNTHETIC_CALL", payloadHash: digest("SYNTHETIC"), operationId: null, result: null }); },
      value => { value.attempts[0].state = "NOT_STARTED"; value.attempts[0].unstartedClosure = { kind: "SERVER_ABANDONED", claimOperationId: claim.operationId, snapshot: proof }; value.attempts.push({ ...structuredClone(a), claimOperationId: uuid(), state: "CLAIM_PENDING", snapshot: null }); },
    ];
    for (const mutate of mutations) { const bad = structuredClone(before); mutate(bad); await assert.rejects(async () => f.store.write(bad), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), before); }
    f.expireUnstarted(); await f.runner(new SyntheticAdapter()).run({ once: true }); const closed = (await f.store.read())!; assert.equal(closed.attempts[0].state, "NOT_STARTED");
    const closedChanges: ((value: typeof closed) => void)[] = [
      value => { value.attempts.shift(); }, value => { value.attempts.reverse(); },
      value => { value.attempts[0].state = "UNKNOWN"; delete value.attempts[0].unstartedClosure; },
      value => { value.attempts[0].reason = "UNKNOWN"; }, value => { value.attempts[0].snapshot!.leaseExpiresAt = new Date().toISOString(); },
      value => { value.attempts[0].unstartedClosure = { kind: "LOCAL_NOT_TRANSMITTED", claimOperationId: claim.operationId }; },
      value => { if (value.attempts[0].unstartedClosure?.kind === "SERVER_ABANDONED") value.attempts[0].unstartedClosure.snapshot.fence++; },
      value => { value.operations.find(o => o.operationId === claim.operationId)!.result = proof; },
      value => { value.operations = value.operations.filter(o => o.operationId !== claim.operationId); },
      value => { value.attempts[1].snapshot!.fence = proof.fence; },
      value => { value.attempts[1].receipt!.attemptId = proof.attemptId; },
    ];
    for (const mutate of closedChanges) { const bad = structuredClone(closed); mutate(bad); await assert.rejects(async () => f.store.write(bad), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), closed); }
    assert.deepEqual(closed.operations.find(o => o.operationId === claim.operationId), claim);
  } finally { await f.close(); }
});

test("should close only exact server-proof leases and retain confirmed receipts and sealed proof immutability", async () => {
  const f = await runnerFixture();
  try {
    f.queue(); await f.runner(f.adapter, { beforeMutation: async kind => { if (kind === "server-intent") throw new RuntimeError("UNKNOWN"); } }).run({ once: true });
    const before = (await f.store.read())!, a = before.attempts[0], claim = before.operations.find(o => o.operationId === a.claimOperationId)!;
    const operationId = uuid(), body = { protocol: 1, operationId, agentId: a.scope.agentId, bindingEpoch: a.scope.bindingEpoch, requestId: a.requestId, attemptId: a.snapshot!.attemptId, fence: a.snapshot!.fence };
    const lease = { operationId, action: "lease" as const, body, payloadHash: digest(stableJson({ action: "lease", body })), state: "PENDING" as const, result: null };
    before.operations.push(lease); await f.store.write(before);
    const proof = { ...structuredClone(a.snapshot!), state: "ABANDONED" as const, startIntentAt: null };
    const closed = structuredClone(before); closed.attempts[0].state = "NOT_STARTED"; closed.attempts[0].reason = null;
    closed.attempts[0].unstartedClosure = { kind: "SERVER_ABANDONED", claimOperationId: claim.operationId, snapshot: proof };
    closed.operations.at(-1)!.state = "CLOSED";
    const badChanges: ((v: typeof closed) => void)[] = [
      v => { delete v.attempts[0].unstartedClosure; v.attempts[0].state = "UNKNOWN"; },
      v => { v.attempts[0].unstartedClosure = { kind: "LOCAL_NOT_TRANSMITTED", claimOperationId: claim.operationId }; },
      v => { v.attempts[0].state = "PROVIDER_INTENT"; },
      v => { v.operations.at(-1)!.action = "interrupt-ack"; },
      ...["requestId", "attemptId", "agentId", "fence", "bindingEpoch"].map(field => (v: typeof closed) => {
        const op = v.operations.at(-1)!; op.body[field] = ["fence", "bindingEpoch"].includes(field) ? 2 : uuid(); op.payloadHash = digest(stableJson({ action: op.action, body: op.body }));
      }),
      ...["requestId", "agentId", "bindingEpoch"].map(field => (v: typeof closed) => { (v.operations.find(o => o.operationId === claim.operationId)!.result as Record<string, unknown>)[field] = field === "bindingEpoch" ? 2 : uuid(); }),
    ];
    for (const mutate of badChanges) { const bad = structuredClone(closed); mutate(bad); await assert.rejects(async () => f.store.write(bad), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), before); }
    await f.store.write(closed); assert.deepEqual((await f.store.read())!.operations.find(o => o.operationId === claim.operationId), claim);
    const bad = structuredClone(closed); bad.attempts[0].unstartedClosure!.claimOperationId = uuid();
    await assert.rejects(async () => f.store.write(bad), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), closed);
  } finally { await f.close(); }
});

function readyOperation(agentId: string, state: RuntimeOperation["state"] = "CONFIRMED"): RuntimeOperation {
  const operationId = uuid(), body = { protocol: 1, agentId, bindingEpoch: 1, operationId, reportedReady: false };
  return { operationId, action: "ready", body, payloadHash: digest(stableJson({ action: "ready", body })), state, result: state === "CONFIRMED" ? { agentId, bindingEpoch: 1, reportedReady: false, validUntil: null, verification: "reported" } : null };
}
test("should retain immutable created preparation identity through only ordered materialization and finalization", async () => {
  const f = await runtimeFixture(); try {
    await f.store.write(f.record);
    const pending = structuredClone(f.record), generation = uuid();
    pending.preparation = { operationId: uuid(), previousEpoch: 1, generation, settings: f.settings, candidate: null, state: "PROVIDER_PENDING" }; await f.store.write(pending);
    const created = structuredClone(pending); created.preparation!.candidate = { ...structuredClone(f.context), generation, epoch: 2 }; created.preparation!.state = "PROVIDER_CREATED";
    for (const state of ["CANDIDATE", "REPLACE_PENDING"] as const) await assert.rejects(async () => f.store.write({ ...created, preparation: { ...created.preparation!, state } }), { code: "UNSAFE_STORAGE" });
    await f.store.write(created); assert.deepEqual(await f.store.read(), created);
    const changes: ((record: typeof created) => void)[] = [
      r => { r.preparation!.state = "PROVIDER_PENDING"; r.preparation!.candidate = null; }, r => { r.preparation!.state = "REPLACE_PENDING"; },
      r => { r.preparation!.candidate!.threadId = "SYNTHETIC_REPLACED"; }, r => { r.preparation!.candidate!.root.ino++; },
      r => { r.preparation!.generation = uuid(); r.preparation!.candidate!.generation = r.preparation!.generation; }, r => { r.preparation!.candidate!.epoch = 3; },
      r => { r.preparation!.candidate!.level = "L2"; }, r => { r.preparation!.candidate!.ownedTurns.push({ turnId: "SYNTHETIC_TURN", terminal: "COMPLETED" }); },
      r => { r.preparation!.operationId = uuid(); }, r => { r.preparation!.previousEpoch++; }, r => { r.preparation!.settings.handoff = "SYNTHETIC_CHANGED"; },
      r => { r.preparation = null; }, r => { r.ready = true; },
      r => { r.context = r.preparation!.candidate!; r.settings = r.preparation!.settings; r.preparation = null; r.scope.bindingEpoch = 2; },
      r => { r.context = r.preparation!.candidate!; r.preparation = null; }
    ];
    for (const change of changes) { const next = structuredClone(created); change(next); await assert.rejects(async () => f.store.write(next), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), created); }
    const candidate = structuredClone(created); candidate.preparation!.state = "CANDIDATE"; await f.store.write(candidate);
    const premature = { ...candidate, context: candidate.preparation!.candidate, settings: candidate.preparation!.settings, scope: { ...candidate.scope, bindingEpoch: 2 }, preparation: null };
    await assert.rejects(async () => f.store.write(premature), { code: "UNSAFE_STORAGE" });
    const replacement = structuredClone(candidate); replacement.preparation!.state = "REPLACE_PENDING"; await f.store.write(replacement);
    const wrongSettings = structuredClone(premature); wrongSettings.settings!.handoff = "SYNTHETIC_WRONG_FINAL"; await assert.rejects(async () => f.store.write(wrongSettings), { code: "UNSAFE_STORAGE" });
    await f.store.write(premature); assert.deepEqual(await f.store.read(), premature);
  } finally { await f.close(); }
});
test("should read existing materialized preparation states without requiring a new provider creation", async () => {
  for (const state of ["CANDIDATE", "REPLACE_PENDING"] as const) {
    const f = await runtimeFixture(); try {
      const generation = uuid(); f.record.preparation = { operationId: uuid(), previousEpoch: 1, generation, settings: f.settings, candidate: { ...f.context, generation, epoch: 2 }, state };
      await f.store.write(f.record); assert.deepEqual(await f.store.read(), f.record);
    } finally { await f.close(); }
  }
});

test("should prune only superseded unreferenced confirmed ready housekeeping", async () => {
  const f = await runtimeFixture(); try {
    const requestId = uuid(), attemptId = uuid(), turnId = uuid(), controlId = uuid(), cycleId = uuid();
    const payload = { requestId, cycleId, agentId: f.scope.agentId, bindingEpoch: 1, roomRevision: 1, requestKind: "ORIGIN" as const, questionId: null, publicText: "Selected evidence", replyText: null, deadline: new Date(Date.now() + 60000).toISOString() };
    const snapshot = { requestId, attemptId, agentId: f.scope.agentId, bindingEpoch: 1, fence: 1, state: "EXECUTING" as const, leaseExpiresAt: payload.deadline, startIntentAt: new Date().toISOString(), payload };
    const receipt = { requestId, attemptId, terminal: "COMPLETED" as const, adoption: "ACCEPTED" as const, continuationRequestId: null };
    const journal: AttemptJournal = { requestId, scope: f.scope, generation: f.context.generation, state: "UPLOADED", snapshot, native: { threadId: f.context.threadId, turnId }, terminal: { threadId: f.context.threadId, turnId, terminal: "COMPLETED", privateText: "", publicText: "", finalItems: [], textProof: "UNCONFIRMED", observation: observation(f.settings) }, receipt, reason: null, toolCalls: [] };
    f.record.attempts.push(journal);
    const obsolete = readyOperation(f.scope.agentId), preparationRef = readyOperation(f.scope.agentId), toolRef = readyOperation(f.scope.agentId), latest = readyOperation(f.scope.agentId);
    const mismatched = readyOperation(f.scope.agentId); (mismatched.result as { bindingEpoch: number }).bindingEpoch = 2;
    f.record.operations.push(obsolete, preparationRef, toolRef, mismatched, readyOperation(f.scope.agentId, "PENDING"), readyOperation(f.scope.agentId, "TRANSMITTED"), latest);
    f.record.preparation = { operationId: preparationRef.operationId, previousEpoch: 1, generation: uuid(), settings: f.settings, candidate: null, state: "PROVIDER_PENDING" };
    journal.toolCalls.push({ callId: "synthetic-reference", payloadHash: digest("synthetic"), operationId: toolRef.operationId, result: null });
    for (const action of ["claim", "start-intent", "lease", "question", "complete", "observe", "interrupt-ack"] as const) {
      for (const state of ["PENDING", "TRANSMITTED", "CONFIRMED", ...(["lease", "interrupt-ack"].includes(action) ? ["CLOSED"] as const : [])] as const) {
        const operationId = uuid(), identity = { protocol: 1, agentId: f.scope.agentId, bindingEpoch: 1, operationId, requestId, attemptId, fence: 1 };
        const body = action === "claim" ? { protocol: 1, agentId: f.scope.agentId, bindingEpoch: 1, operationId, requestId } : action === "question" ? { ...identity, publicText: "Selected question", confirmed: true } : action === "complete" || action === "observe" ? { ...identity, terminal: "COMPLETED", publicText: "" } : action === "interrupt-ack" ? { ...identity, controlId } : identity;
        const result = action === "question" ? { cycleId, questionId: uuid(), peerRequestId: uuid(), accepted: true, cycleState: "ACTIVE" } : action === "complete" || action === "observe" ? receipt : action === "interrupt-ack" ? { controlId, requestId, attemptId, fence: 1, state: "ACKNOWLEDGED" } : snapshot;
        f.record.operations.push({ operationId, action, body, payloadHash: digest(stableJson({ action, body })), state, result: state === "CONFIRMED" ? result : null });
      }
    }
    await f.store.write(f.record); const next = structuredClone(f.record); pruneConfirmedReady(next);
    assert.deepEqual(next.operations, f.record.operations.filter(o => o.operationId !== obsolete.operationId)); await f.store.write(next);
    assert.deepEqual((await f.store.read())!.operations, next.operations);
    // Every protected deletion is tested through the durable transition validator, not only the helper.
    for (const operation of next.operations) {
      const deleted = structuredClone(next); deleted.operations = deleted.operations.filter(o => o.operationId !== operation.operationId);
      if (operation.operationId === preparationRef.operationId) deleted.preparation = null;
      if (operation.operationId === toolRef.operationId) deleted.attempts[0].toolCalls = [];
      await assert.rejects(async () => f.store.write(deleted), { code: "UNSAFE_STORAGE" });
    }
    const edited = structuredClone(next); edited.operations.find(o => o.operationId === latest.operationId)!.body.reportedReady = true;
    await assert.rejects(async () => f.store.write(edited), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), next);
  } finally { await f.close(); }
});
test("should retain unresolved ready intent at the unchanged journal limit", async () => {
  const f = await runtimeFixture(); try {
    f.record.operations = Array.from({ length: 1024 }, (_, i) => readyOperation(f.scope.agentId, i % 2 ? "PENDING" : "TRANSMITTED"));
    await f.store.write(f.record); const unchanged = structuredClone(f.record); pruneConfirmedReady(unchanged); assert.deepEqual(unchanged, f.record);
    unchanged.operations.push(readyOperation(f.scope.agentId, "PENDING")); await assert.rejects(async () => f.store.write(unchanged), { code: "UNSAFE_STORAGE" }); assert.deepEqual(await f.store.read(), f.record);
  } finally { await f.close(); }
});
test("should preserve durable intent order when superseding the latest ready receipt", async () => {
  const f = await runtimeFixture(); try {
    const old = readyOperation(f.scope.agentId), latest = readyOperation(f.scope.agentId), pending = readyOperation(f.scope.agentId, "TRANSMITTED");
    f.record.operations.push(old, latest, pending); await f.store.write(f.record);
    await assert.rejects(async () => f.store.write({ ...f.record, operations: [latest, old, pending] }), { code: "UNSAFE_STORAGE" });
    await assert.rejects(async () => f.store.write({ ...f.record, operations: [readyOperation(f.scope.agentId, "PENDING"), ...f.record.operations] }), { code: "UNSAFE_STORAGE" });
    await assert.rejects(async () => f.store.write({ ...f.record, operations: [readyOperation(f.scope.agentId)] }), { code: "UNSAFE_STORAGE" });
    const next = structuredClone(f.record); next.operations[2].state = "CONFIRMED"; next.operations[2].result = structuredClone(latest.result); pruneConfirmedReady(next);
    assert.deepEqual(next.operations.map(o => o.operationId), [pending.operationId]); await f.store.write(next); assert.deepEqual(await f.store.read(), next);
  } finally { await f.close(); }
});

test("should persist validated runtime journals atomically and refuse unsafe files", async () => {
  const f = await runtimeFixture(); try {
    await f.store.write(f.record); assert.deepEqual(await f.store.read(), f.record);
    assert.equal((await lstat(f.store.file)).mode & 0o777, 0o600); assert.equal((await lstat(f.store.dir)).mode & 0o777, 0o700);
    const original = await readFile(f.store.file); assert.throws(() => f.store.write({ ...f.record, version: 2 } as never)); assert.deepEqual(await readFile(f.store.file), original);
    let checks = 0; await assert.rejects(f.store.write({ ...f.record, ready: true }, () => { if (++checks === 15) throw new Error("Synthetic cancellation"); })); assert.deepEqual(await readFile(f.store.file), original);
    await chmod(f.store.file, 0o644); await assert.rejects(f.store.read()); await chmod(f.store.file, 0o600);
    await link(f.store.file, join(f.directory, "hardlink")); await assert.rejects(f.store.read()); await unlink(join(f.directory, "hardlink"));
    await unlink(f.store.file); await symlink(join(f.directory, "missing"), f.store.file); await assert.rejects(f.store.read()); await unlink(f.store.file);
    await writeFile(f.store.file, " ".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 }); await assert.rejects(f.store.read());
  } finally { await f.close(); }
});
test("should admit only one runner for the same binding and owned session", async () => {
  const f = await runtimeFixture(); try {
    const other = new RuntimeStore(f.stateDir, "two", uuid());
    await f.store.locked(async () => {
      await assert.rejects(f.store.locked(async () => {}), { code: "RUNTIME_BUSY" });
      await f.store.sessionLocked(f.context.threadId, async () => { await assert.rejects(other.sessionLocked(f.context.threadId, async () => {}), { code: "RUNTIME_BUSY" }); });
    });
    await f.store.write(f.record);
    const lock = join(f.store.dir, `${f.scope.agentId}.lock`);
    await writeFile(lock, JSON.stringify({ pid: 2147483647, token: uuid(), identity: digest(f.store.file) }), { mode: 0o600 });
    await f.store.locked(async recovered => { assert.equal(recovered, true); });
  } finally { await f.close(); }
});
test("should recover pending operations without changing their action or payload", async () => {
  const f = await runtimeFixture(); try {
    const operationId = uuid(); const body = { protocol: 1, agentId: f.scope.agentId, bindingEpoch: 1, operationId, reportedReady: false };
    const operation = { operationId, action: "ready" as const, body, payloadHash: digest(stableJson({ action: "ready", body })), state: "TRANSMITTED" as const, result: null };
    f.record.operations.push(operation); await f.store.write(f.record); const recovered = (await f.store.read())!;
    assert.deepEqual(recovered.operations[0], operation); const changed = structuredClone(recovered); changed.operations[0].body.reportedReady = true;
    changed.operations[0].payloadHash = digest(stableJson({ action: "ready", body: changed.operations[0].body })); await assert.rejects(f.store.write(changed));
  } finally { await f.close(); }
});

test("should preserve unresolved evidence and reject archived request reexecution", async () => {
  const f = await runtimeFixture();
  try {
    const archived = appendFixtureCompletion(f.record);
    const unknown = appendFixtureCompletion(f.record); unknown.state = "UNKNOWN"; unknown.terminal = null; unknown.receipt = null;
    const terminal = appendFixtureCompletion(f.record); terminal.state = "TERMINAL"; terminal.receipt = null;
    const question = appendFixtureCompletion(f.record);
    const operationId = uuid();
    const body = { protocol: 1, agentId: f.scope.agentId, bindingEpoch: 1, operationId, requestId: question.requestId,
      attemptId: question.snapshot!.attemptId, fence: 1, publicText: "Fixture question", confirmed: true };
    f.record.operations.push({ operationId, action: "question", body, payloadHash: digest(stableJson({ action: "question", body })), state: "TRANSMITTED", result: null });
    question.toolCalls.push({ callId: "question", payloadHash: digest("question"), operationId, result: null });
    const protectedAttempts = structuredClone(f.record.attempts.slice(1));
    const ownedTurns = structuredClone(f.record.context!.ownedTurns);
    await f.store.write(f.record);
    const next = await f.store.compact(f.record);
    assert.deepEqual(next.attempts, protectedAttempts);
    assert.deepEqual(next.context!.ownedTurns, ownedTurns);
    const reused = structuredClone(next);
    reused.attempts.push({ requestId: archived.requestId, scope: f.scope, generation: f.context.generation,
      state: "CLAIM_PENDING", claimOperationId: uuid(), snapshot: null, native: null, terminal: null, receipt: null, reason: null, toolCalls: [] });
    await assert.rejects(async () => f.store.write(reused), { code: "UNSAFE_STORAGE" });
    for (const mutate of [
      (r: typeof next) => { r.archives = []; },
      (r: typeof next) => { r.context!.ownedTurns = []; },
      (r: typeof next) => { r.archives![0].requestIds.push(uuid()); },
    ]) {
      const bad = structuredClone(next); mutate(bad);
      await assert.rejects(async () => f.store.write(bad), { code: "UNSAFE_STORAGE" });
    }
    assert.deepEqual(await f.store.read(), next);
  } finally { await f.close(); }
});

test("should keep the committed archive snapshot across late writes and shutdown", async () => {
  const f = await runtimeFixture();
  try {
    appendFixtureCompletion(f.record); await f.store.write(f.record);
    const stale = structuredClone(f.record);
    const committed = await f.store.compact(f.record);
    await assert.rejects(async () => f.store.write({ ...stale, ready: false }), { code: "UNSAFE_STORAGE" });
    await assert.rejects(f.store.compact(stale), { code: "UNSAFE_STORAGE" });
    await f.store.write({ ...committed, ready: false });
    assert.deepEqual(await f.store.read(), committed);
    const forged = structuredClone(committed); forged.lastArchive!.attemptId = uuid();
    await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
    const cleared = structuredClone(committed); delete cleared.lastArchive;
    await assert.rejects(async () => f.store.write(cleared), { code: "UNSAFE_STORAGE" });
    cleared.attempts.push({ requestId: uuid(), scope: structuredClone(f.scope), generation: f.context.generation,
      state: "CLAIM_PENDING", claimOperationId: uuid(), snapshot: null, native: null, terminal: null, receipt: null, reason: null, toolCalls: [] });
    await f.store.write(cleared);
    assert.equal((await f.store.lastAttempt(cleared))!.state, "CLAIM_PENDING");
  } finally { await f.close(); }
});

test("should reserve terminal and outbox bytes against lease readiness and tool growth", async () => {
  const f = await runtimeFixture();
  try {
    const escaped = "\u0001".repeat(512);
    const worst: TerminalEvidence = { threadId: escaped, turnId: escaped, terminal: "COMPLETED", privateText: "\u0001".repeat(65536),
      publicText: "\u0001".repeat(4000), finalItems: Array.from({ length: 256 }, () => ({ id: escaped, hash: "a".repeat(64) })),
      textProof: "UNCONFIRMED", observation: { requested: { model: escaped, effort: escaped },
        thread: { model: escaped, provider: escaped, effort: escaped },
        turn: { requestedModel: escaped, requestedEffort: escaped, model: escaped, rerouted: false, effortVerification: "UNVERIFIED" } } };
    // JSON escaping of every permitted string unit costs at most six bytes. A byte-limited
    // text has no more code units than its byte limit, including lone surrogates.
    assert.equal(Buffer.byteLength(JSON.stringify("\u0001".repeat(65536))), 6 * 65536 + 2);
    const terminalBytes = Buffer.byteLength(JSON.stringify(worst));
    const ackBytes = 3 * (6 * 512 + 128); // native pair plus owned turn (terminal/state overhead included)
    const outboxBytes = 2 * (16384 + 1024); // complete and observe validated bodies plus operation wrappers
    const responseBytes = 8 * 2048; // fixed ready/interrupt/terminal receipts, duplicate adoption, UNKNOWN and cleanup
    const terminalObligations = terminalBytes + ackBytes + outboxBytes + responseBytes;
    assert.ok(terminalObligations <= terminalReserveBytes);
    // Admission additionally covers claim/start responses and both snapshot refreshes.
    assert.ok(terminalObligations + 4 * 65536 <= admissionReserveBytes);
    const baseBytes = Buffer.byteLength(JSON.stringify(f.record));
    assertRuntimeCapacity(f.record, false, 2 * 1024 * 1024 - terminalReserveBytes - baseBytes);
    assert.throws(() => assertRuntimeCapacity(f.record, false, 2 * 1024 * 1024 - terminalReserveBytes - baseBytes + 1), { code: "RUNTIME_CAPACITY" });
    assertRuntimeCapacity(f.record, true, 2 * 1024 * 1024 - admissionReserveBytes - baseBytes);
    assert.throws(() => assertRuntimeCapacity(f.record, true, 2 * 1024 * 1024 - admissionReserveBytes - baseBytes + 1), { code: "RUNTIME_CAPACITY" });
    const withReservations = structuredClone(f.record);
    withReservations.settings!.handoff = "x".repeat(65536);
    assert.throws(() => assertRuntimeCapacity(withReservations, false, 4 * 131072), { code: "RUNTIME_CAPACITY" });
    const persisted = appendFixtureCompletion(f.record);
    persisted.state = "TERMINAL"; persisted.receipt = null;
    persisted.native = { threadId: worst.threadId, turnId: worst.turnId }; persisted.terminal = worst;
    f.record.context!.threadId = worst.threadId;
    f.record.context!.ownedTurns = [{ turnId: worst.turnId, terminal: "COMPLETED" }];
    f.record.operations.pop();
    await f.store.write(f.record);
    assert.deepEqual((await f.store.read())!.attempts[0].terminal, worst);
    assert.ok(Buffer.byteLength(JSON.stringify(f.record)) < 2 * 1024 * 1024);

  } finally { await f.close(); }
});

test("should reject new admission at the retained request bound without resetting its context", async () => {
  const f = await runtimeFixture();
  try {
    f.record.archives = Array.from({ length: 16 }, (_, index) => ({ hash: digest(String(index)),
      requestIds: Array.from({ length: index === 15 ? 255 : 256 }, () => uuid()) }));
    assertRuntimeCapacity(f.record, true);
    const turns = structuredClone(f.record.context!.ownedTurns);
    f.record.archives[15].requestIds.push(uuid());
    assert.throws(() => assertRuntimeCapacity(f.record, true), { code: "RUNTIME_CAPACITY" });
    assert.deepEqual(f.record.context!.ownedTurns, turns);
  } finally { await f.close(); }
});

test("should archive a whole reclaimed request only after its unstarted proof and upload are closed", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    await f.runner(f.adapter, { beforeMutation: async kind => {
      if (kind === "server-intent") throw new RuntimeError("UNKNOWN");
    } }).run({ once: true });
    f.expireUnstarted();
    const adapter = new SyntheticAdapter();
    await f.runner(adapter).run({ once: true });
    const before = (await f.store.read())!;
    assert.equal(before.attempts[0].state, "NOT_STARTED");
    assert.equal(before.attempts[1].state, "UPLOADED");
    assert.equal(before.attempts[0].requestId, before.attempts[1].requestId);
    const source = await readFile(f.store.file);
    const next = await f.store.compact(before);
    assert.equal(next.attempts.length, 0);
    assert.deepEqual(next.archives![0].requestIds, [before.attempts[0].requestId]);
    assert.deepEqual(await readFile(join(f.store.dir, "archives", f.scope.agentId, `${digest(source)}.json`)), source);
    assert.deepEqual(next.context!.ownedTurns, before.context!.ownedTurns);
    assert.equal((await f.store.lastAttempt(next))!.state, "UPLOADED");
    assert.equal(adapter.starts, 1);
  } finally { await f.close(); }
});

test("should exclude completed bundles referenced by another attempt or preparation", async () => {
  for (const reference of ["attempt", "preparation"] as const) {
    const f = await runtimeFixture();
    try {
      const completed = appendFixtureCompletion(f.record);
      const completedOperation = f.record.operations.at(-1)!;
      const retained = appendFixtureCompletion(f.record);
      retained.state = "UNKNOWN"; retained.terminal = null; retained.receipt = null;
      if (reference === "attempt") {
        retained.toolCalls.push({ callId: "foreign-reference", payloadHash: digest("foreign-reference"), operationId: completedOperation.operationId, result: null });
      } else {
        f.record.preparation = { operationId: completedOperation.operationId, previousEpoch: 1, generation: uuid(),
          settings: f.settings, candidate: null, state: "PROVIDER_PENDING" };
      }
      await f.store.write(f.record);
      const after = await f.store.compact(f.record);
      assert.deepEqual(after, f.record);
      assert.equal(after.archives, undefined);
      assert.deepEqual(after.attempts.find(a => a.requestId === completed.requestId), completed);
    } finally { await f.close(); }
  }
});
