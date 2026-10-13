import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as web from "../../src/features/investigation-coordinator/contracts.ts";
import * as local from "../../packages/local-connector/src/workflow-contracts.ts";
import {
  emptyHistory,
  mergeHistory,
} from "../../src/features/investigation-coordinator/history-state.ts";
import {
  restoreDirectIntent,
  pinRetirement,
  retirementPinMatches,
} from "../../src/features/investigation-coordinator/direct-intents.ts";
import { answerStatuses } from "../../src/features/investigation-coordinator/chat-presentation.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/retirement-contracts.json", "utf8"));
const recoveryAction = "read-recovery" as web.Action;
const retireAction = "retire" as web.Action;

test("should validate recovery and retirement identically while preserving strict legacy read", () => {
  for (const contract of [web, local]) {
    assert.deepEqual(contract.validateBody(recoveryAction, fixture.read), fixture.read);
    assert.deepEqual(contract.validateBody(retireAction, fixture.retire), fixture.retire);
    assert.deepEqual(contract.projectResponse(recoveryAction, fixture.history), fixture.history);
    assert.deepEqual(contract.projectResponse(retireAction, fixture.receipt), fixture.receipt);
    const { recovery, ...legacy } = fixture.history;
    void recovery;
    assert.deepEqual(contract.projectHistory(legacy), legacy);
    assert.throws(() => contract.projectHistory(fixture.history), { code: "UNAVAILABLE" });
  }
});

test("should reject duplicate retirement sequences and candidates with foreign execution identities", () => {
  for (const contract of [web, local]) {
    for (const field of ["requestId", "cycleId", "agentId", "bindingEpoch", "roomRevision"]) {
      const page = structuredClone(fixture.history);
      page.recovery.candidate[field] =
        typeof page.recovery.candidate[field] === "number" ? 9 : fixture.retire.operationId;
      assert.throws(() => contract.projectResponse(recoveryAction, page), { code: "UNAVAILABLE" });
    }
    const page = structuredClone(fixture.history);
    const { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt } = fixture.receipt;
    page.recovery.retirements = [
      { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt },
      { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt },
    ];
    page.recovery.nextRetirementCursor = 1;
    page.recovery.highWaterRetirementSequence = 1;
    assert.throws(() => contract.projectResponse(recoveryAction, page), { code: "UNAVAILABLE" });
  }
});

test("should restore the exact retirement only for its saved actor and room", () => {
  const saved = JSON.stringify({ action: "retire", body: fixture.retire });
  const storage = { getItem: () => saved, removeItem: () => {} } as unknown as Storage;
  assert.deepEqual(
    restoreDirectIntent(storage, fixture.retire.expectedUserId, fixture.retire.roomId),
    JSON.parse(saved),
  );
  assert.equal(restoreDirectIntent(storage, fixture.retire.agentId, fixture.retire.roomId), null);
});

test("should accumulate independent retirement pages without reverting newer snapshots", () => {
  const page = structuredClone(fixture.history);
  const { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt } = fixture.receipt;
  page.recovery.candidate = null;
  page.recovery.retirements = [{ sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt }];
  page.recovery.nextRetirementCursor = 1;
  page.recovery.highWaterRetirementSequence = 1;
  page.roomRevision = 2;
  let history = mergeHistory(emptyHistory(page.roomId), page);
  history = mergeHistory(history, fixture.history);
  assert.equal(history.snapshot!.roomRevision, 2);
  assert.equal((history as unknown as { retirementCursor: number }).retirementCursor, 1);
  assert.deepEqual(
    (history as unknown as { retirements: unknown[] }).retirements,
    page.recovery.retirements,
  );
});

test("should hide only the exact retired card while preserving UNKNOWN and interrupt evidence in history", () => {
  const { state, attemptId, fence, roomRevision, ...retirement } = fixture.receipt;
  void state;
  void attemptId;
  void fence;
  void roomRevision;
  const context = {
    events: fixture.history.events,
    runs: fixture.history.runs,
    bindings: fixture.history.bindings,
    cycle: fixture.history.cycle,
    observedAt: 1,
    now: 1,
    retirements: [retirement],
    cancelReceipts: [
      {
        requestId: retirement.requestId,
        cycleId: retirement.cycleId,
        agentId: retirement.agentId,
        epoch: retirement.bindingEpoch,
        state: "REQUESTED" as const,
      },
    ],
  };
  const presentation = answerStatuses(context);
  assert.equal(presentation.statuses.length, 0);
  const saved = presentation.byQuestion.get(fixture.history.events[0].eventId)![0];
  assert.equal(saved.state, "UNKNOWN");
  assert.equal(saved.interruptStage, "REQUESTED");
  assert.equal(saved.label, "답변 미확인 · 이전 기록");
  assert.equal(
    answerStatuses({ ...context, retirements: [{ ...retirement, bindingEpoch: 9 }] }).statuses
      .length,
    1,
  );
});

test("should pin every confirmation identity and require reconfirmation after polling changes", () => {
  const candidate = fixture.history.recovery.candidate;
  const userId = fixture.retire.expectedUserId;
  const roomId = fixture.retire.roomId;
  const pin = pinRetirement(userId, roomId, candidate);
  assert.equal(retirementPinMatches(pin, userId, roomId, candidate), true);
  assert.equal(retirementPinMatches(pin, fixture.retire.agentId, roomId, candidate), false);
  assert.equal(retirementPinMatches(pin, userId, fixture.retire.agentId, candidate), false);
  assert.equal(retirementPinMatches(pin, userId, roomId, null), false);
  for (const key of Object.keys(candidate)) {
    const changed = {
      ...candidate,
      [key]:
        typeof candidate[key] === "boolean"
          ? !candidate[key]
          : typeof candidate[key] === "number"
            ? candidate[key] + 1
            : fixture.retire.operationId,
    };
    assert.equal(retirementPinMatches(pin, userId, roomId, changed), false, key);
  }
});

test("should reject unsafe cursors identities and unsupported retirement states on both contracts", () => {
  for (const contract of [web, local]) {
    for (const key of ["afterSequence", "afterRetirementSequence"]) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
        assert.throws(
          () => contract.validateBody(recoveryAction, { ...fixture.read, [key]: value }),
          { code: "INVALID_BODY" },
        );
      }
    }
    for (const key of Object.keys(fixture.retire)) {
      const missing = { ...fixture.retire };
      delete missing[key];
      assert.throws(
        () => contract.validateBody(retireAction, missing),
        { code: "INVALID_BODY" },
        key,
      );
    }
    for (const patch of [
      { confirmed: false },
      { bindingEpoch: 0 },
      { fence: Number.MAX_SAFE_INTEGER + 1 },
      { attemptId: "wrong" },
      { unexpected: true },
    ]) {
      assert.throws(() => contract.validateBody(retireAction, { ...fixture.retire, ...patch }), {
        code: "INVALID_BODY",
      });
    }
    for (const patch of [
      { state: "COMPLETED" },
      { state: "INTERRUPTED" },
      { sequence: 0 },
      { roomRevision: 0 },
      { retiredAt: "invalid" },
      { terminal: "UNKNOWN" },
    ]) {
      assert.throws(
        () => contract.projectResponse(retireAction, { ...fixture.receipt, ...patch }),
        { code: "UNAVAILABLE" },
      );
    }
  }
});

test("should refuse out of order oversized inconsistent retirement pages and non-direct candidates", () => {
  const entry = {
    sequence: 1,
    requestId: fixture.receipt.requestId,
    cycleId: fixture.receipt.cycleId,
    agentId: fixture.receipt.agentId,
    bindingEpoch: 1,
    retiredAt: fixture.receipt.retiredAt,
  };
  for (const contract of [web, local]) {
    for (const retirements of [
      [{ ...entry, sequence: 2 }, entry],
      Array.from({ length: 33 }, (_, index) => ({ ...entry, sequence: index + 1 })),
    ]) {
      const history = structuredClone(fixture.history);
      Object.assign(history.recovery, {
        candidate: null,
        retirements,
        nextRetirementCursor: retirements.at(-1)!.sequence,
        highWaterRetirementSequence: 33,
        hasMoreRetirements: true,
      });
      assert.throws(() => contract.projectResponse(recoveryAction, history), {
        code: "UNAVAILABLE",
      });
    }
    for (const patch of [
      { hasMoreRetirements: true },
      { nextRetirementCursor: 1 },
      { highWaterRetirementSequence: 1 },
    ]) {
      const history = structuredClone(fixture.history);
      Object.assign(history.recovery, patch);
      assert.throws(() => contract.projectResponse(recoveryAction, history), {
        code: "UNAVAILABLE",
      });
    }
    for (const patch of [
      { cycle: null },
      { runs: [] },
      { runs: [{ ...fixture.history.runs[0], state: "COMPLETED" }] },
    ]) {
      assert.throws(
        () => contract.projectResponse(recoveryAction, { ...fixture.history, ...patch }),
        { code: "UNAVAILABLE" },
      );
    }
    const liveDevice = structuredClone(fixture.history);
    liveDevice.recovery.candidate.deviceRevoked = false;
    liveDevice.recovery.candidate.canRetire = false;
    assert.deepEqual(contract.projectResponse(recoveryAction, liveDevice), liveDevice);
    liveDevice.recovery.candidate.canRetire = true;
    assert.throws(() => contract.projectResponse(recoveryAction, liveDevice), {
      code: "UNAVAILABLE",
    });
  }
});

test("should reject a retirement that conflicts with a known request identity in the same recovery page", () => {
  for (const contract of [web, local]) {
    const history = structuredClone(fixture.history);
    const { state, attemptId, fence, roomRevision, ...retirement } = fixture.receipt;
    void state;
    void attemptId;
    void fence;
    void roomRevision;
    Object.assign(history.recovery, {
      candidate: null,
      retirements: [{ ...retirement, cycleId: fixture.retire.operationId }],
      nextRetirementCursor: 1,
      highWaterRetirementSequence: 1,
    });
    assert.throws(() => contract.projectResponse(recoveryAction, history), { code: "UNAVAILABLE" });
  }
});

test("should preserve last report time and saved target after a retired request leaves the latest snapshot", () => {
  const { state, attemptId, fence, roomRevision, ...retirement } = fixture.receipt;
  void state;
  void attemptId;
  void fence;
  let history = mergeHistory(emptyHistory(fixture.history.roomId), fixture.history);
  history = mergeHistory(history, {
    ...fixture.history,
    roomRevision,
    runs: [],
    events: [],
    cycle: null,
    recovery: {
      ...fixture.history.recovery,
      candidate: null,
      retirements: [retirement],
      nextRetirementCursor: 1,
      highWaterRetirementSequence: 1,
    },
  } as web.RecoveryHistoryPage);
  const presentation = answerStatuses({
    events: history.events,
    runs: [],
    historicalRuns: history.runs,
    bindings: [],
    cycle: null,
    observedAt: 1,
    retirements: history.retirements,
  });
  const archived = presentation.byQuestion.get(fixture.history.events[0].eventId)![0];
  assert.equal(archived.updatedAt, fixture.history.runs[0].updatedAt);
  assert.equal(
    archived.target,
    `${fixture.history.runs[0].ownerAlias} · ${fixture.history.runs[0].sessionAlias}`,
  );
  assert.equal(archived.retiredAt, retirement.retiredAt);
  assert.equal(presentation.statuses.length, 0);
});
