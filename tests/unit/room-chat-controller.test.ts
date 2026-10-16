import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WorkflowError,
  type Body,
  type HistoryPage,
  type RecoveryHistoryPage,
  type HumanAction,
} from "../../src/features/investigation-coordinator/contracts.ts";
import {
  RoomChatController,
  type RoomChatRequest,
} from "../../src/features/investigation-coordinator/room-chat-controller.ts";
import { directIntentKey } from "../../src/features/investigation-coordinator/direct-intents.ts";

const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const actor = {
  userId: fixture.ask.expectedUserId as string,
  roomId: fixture.ask.roomId as string,
  role: "participant" as const,
};
const retirementFixture = JSON.parse(
  readFileSync("tests/fixtures/retirement-contracts.json", "utf8"),
);
const recoveryPage = (history: HistoryPage): RecoveryHistoryPage => ({
  ...history,
  recovery: {
    hasBlockingRuns: false,
    candidate: null,
    retirements: [],
    nextRetirementCursor: 0,
    highWaterRetirementSequence: 0,
    hasMoreRetirements: false,
  },
});
const page = (): RecoveryHistoryPage => ({
  ...recoveryPage(fixture.history),
  ...fixture.history,
  events: [],
  runs: [],
  cycle: null,
  hasMore: false,
  nextCursor: 0,
  highWaterSequence: 0,
});
const fields: Body = {
  targetAgentId: fixture.ask.targetAgentId,
  targetEpoch: fixture.ask.targetEpoch,
  expectedRoomRevision: fixture.ask.expectedRoomRevision,
  publicText: fixture.ask.publicText,
  confirmed: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}
function setup(t: TestContext, role: "participant" | "observer" = "participant") {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  } as Storage;
  let hidden = false;
  let currentPage = page();
  let behavior: RoomChatRequest = async (action) =>
    action === "read-recovery"
      ? currentPage
      : action === "cancel"
        ? fixture.cancelResult
        : action === "speak"
          ? { eventId: fixture.ask.operationId, sequence: 1 }
          : {};
  const calls: {
    action: HumanAction;
    body: Body;
    signal: AbortSignal;
    saved: string | undefined;
  }[] = [];
  const controller = new RoomChatController(
    { ...actor, role },
    (action, body, signal) => {
      calls.push({
        action,
        body,
        signal,
        saved: entries.get(directIntentKey(actor.userId, actor.roomId)),
      });
      return behavior(action, body, signal);
    },
    { storage: () => storage, hidden: () => hidden, now: () => 42 },
  );
  t.after(() => controller.stop());
  controller.start();
  return {
    controller,
    entries,
    storage,
    calls,
    setBehavior: (next: RoomChatRequest) => {
      behavior = next;
    },
    hide: () => {
      hidden = true;
    },
    setPage: (next: HistoryPage | RecoveryHistoryPage) => {
      currentPage = "recovery" in next ? (next as RecoveryHistoryPage) : recoveryPage(next);
    },
  };
}

type Receipt = {
  requestId: string;
  cycleId: string;
  agentId: string;
  epoch: number;
  state: "REQUESTED" | "NO_ACTIVE_RUN";
};
function receipts(controller: RoomChatController): Receipt[] {
  return (controller.getSnapshot() as unknown as { cancelReceipts: Receipt[] }).cancelReceipts;
}
const cancelFields = {
  requestId: fixture.cancel.requestId,
  expectedRoomRevision: fixture.cancel.expectedRoomRevision,
};
test("should remember exact server cancel receipt before polling without raw result data", async (t) => {
  const h = setup(t);
  h.setPage(fixture.history);
  await h.controller.poll();
  assert.equal(await h.controller.mutate("cancel", cancelFields), true);
  assert.deepEqual(receipts(h.controller), [
    {
      requestId: fixture.cancel.requestId,
      cycleId: fixture.history.runs[0].cycleId,
      agentId: fixture.ask.targetAgentId,
      epoch: 1,
      state: "REQUESTED",
    },
  ]);
  assert.equal(h.controller.getSnapshot().history.snapshot!.runs[0].state, "QUEUED");
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  h.setBehavior(async () => {
    throw new WorkflowError("UNAVAILABLE");
  });
  await h.controller.poll();
  assert.equal(receipts(h.controller).length, 1);
});
test("should reject malformed and foreign cancel results retaining exact uncertain retry", async (t) => {
  for (const result of [
    {},
    { ...fixture.cancelResult, requestId: fixture.ask.targetAgentId },
    { ...fixture.cancelResult, state: "ACKNOWLEDGED" },
  ]) {
    t.mock.timers.reset();
    const h = setup(t);
    h.setPage(fixture.history);
    await h.controller.poll();
    h.setBehavior(async () => result);
    assert.equal(await h.controller.mutate("cancel", cancelFields), false);
    assert.deepEqual(receipts(h.controller), []);
    const pending = h.controller.getSnapshot().pendingDirect!;
    assert.ok(pending);
    h.setBehavior(async () => fixture.cancelResult);
    assert.equal(await h.controller.mutate("cancel", {}, pending.body), true);
    assert.deepEqual(h.calls.at(-1)!.body, pending.body);
    assert.equal(receipts(h.controller)[0].state, "REQUESTED");
    h.controller.stop();
  }
});
test("should retain independent receipts through other mutations new cancels and foreign terminal snapshots", async (t) => {
  const h = setup(t);
  const firstRun = fixture.history.runs[0];
  const secondRun = {
    ...firstRun,
    requestId: fixture.ask.operationId,
    cycleId: fixture.ask.targetAgentId,
    bindingEpoch: 2,
  };
  h.setPage({ ...fixture.history, runs: [firstRun, secondRun] });
  await h.controller.poll();
  await h.controller.mutate("cancel", cancelFields);
  await h.controller.mutate("speak", { publicText: "메시지" });
  h.setBehavior(async () => ({ ...fixture.cancelResult, requestId: secondRun.requestId }));
  await h.controller.mutate("cancel", { ...cancelFields, requestId: secondRun.requestId });
  assert.equal(receipts(h.controller).length, 2);
  h.setBehavior(async () =>
    recoveryPage({
      ...fixture.history,
      events: [],
      runs: [{ ...firstRun, state: "INTERRUPTED", bindingEpoch: 2 }],
    }),
  );
  await h.controller.poll();
  assert.equal(receipts(h.controller).length, 2);
  h.setBehavior(async () =>
    recoveryPage({
      ...fixture.history,
      events: [],
      runs: [{ ...firstRun, state: "INTERRUPTED" }],
    }),
  );
  await h.controller.poll();
  assert.deepEqual(
    receipts(h.controller).map((r) => r.requestId),
    [secondRun.requestId],
  );
  h.controller.loseAccess();
  assert.deepEqual(receipts(h.controller), []);
});
test("should bind NO_ACTIVE_RUN to the submitted request without changing answer state", async (t) => {
  const h = setup(t);
  h.setPage(fixture.history);
  await h.controller.poll();
  h.setBehavior(async () => ({ controlId: null, requestId: null, state: "NO_ACTIVE_RUN" }));
  assert.equal(await h.controller.mutate("cancel", cancelFields), true);
  assert.equal(receipts(h.controller)[0].requestId, fixture.cancel.requestId);
  assert.equal(receipts(h.controller)[0].state, "NO_ACTIVE_RUN");
  assert.equal(h.controller.getSnapshot().history.snapshot!.runs[0].state, "QUEUED");
});
test("should never fill cancel receipts after stop restart access loss or actor replacement", async (t) => {
  for (const lose of [false, true]) {
    t.mock.timers.reset();
    const h = setup(t);
    h.setPage(fixture.history);
    await h.controller.poll();
    const response = deferred<unknown>();
    h.setBehavior(() => response.promise);
    const sending = h.controller.mutate("cancel", cancelFields);
    if (lose) h.controller.loseAccess();
    else {
      h.controller.stop();
      h.controller.start();
    }
    response.resolve(fixture.cancelResult);
    assert.equal(await sending, false);
    assert.deepEqual(receipts(h.controller), []);
    const replacement = new RoomChatController(
      { ...actor, userId: fixture.ask.targetAgentId, role: "observer" },
      async () => page(),
    );
    assert.deepEqual(receipts(replacement), []);
    assert.ok(h.controller.getSnapshot().pendingDirect);
    h.controller.stop();
  }
});

test("should own one poll and preserve active hidden and failure delays", async (t) => {
  const h = setup(t);
  const read = deferred<unknown>();
  h.setBehavior(() => read.promise);
  h.controller.start();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.length, 1);
  await h.controller.poll();
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 1);
  h.setBehavior(async () => ({ ...page(), hasMore: true, highWaterSequence: 1 }));
  read.resolve({ ...page(), hasMore: true, highWaterSequence: 1 });
  await flush();
  t.mock.timers.tick(1999);
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 2);
  h.hide();
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(h.calls.length, 3);
  t.mock.timers.tick(29_999);
  assert.equal(h.calls.length, 3);
  h.setBehavior(async () => {
    throw new WorkflowError("UNAVAILABLE");
  });
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 4);
  assert.match(h.controller.getSnapshot().pollError!, /다시 시도/);
  t.mock.timers.tick(29_999);
  assert.equal(h.calls.length, 4);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 5);
});

test("should stop abandoned polls from replacing a restarted room snapshot", async (t) => {
  const h = setup(t);
  const old = deferred<unknown>();
  h.setBehavior(() => old.promise);
  const first = h.controller.poll();
  h.controller.stop();
  assert.equal(h.calls[0].signal.aborted, true);
  h.setBehavior(async () => ({ ...page(), roomRevision: 2 }));
  h.controller.start();
  await h.controller.poll();
  assert.equal(h.controller.getSnapshot().history.snapshot!.roomRevision, 2);
  old.resolve({ ...page(), roomRevision: 99 });
  await first;
  assert.equal(h.controller.getSnapshot().history.snapshot!.roomRevision, 2);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(h.calls.length, 3);
});

test("should persist a direct input before HTTP and confirm only the same uncertain request", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const input = deferred<unknown>();
  h.setBehavior(async (action) => (action === "read-recovery" ? page() : input.promise));
  const sending = h.controller.mutate("ask", fields);
  const sent = h.calls.at(-1)!;
  assert.equal(sent.action, "ask");
  assert.deepEqual(JSON.parse(sent.saved!), { action: "ask", body: sent.body });
  assert.equal(await h.controller.mutate("ask", { ...fields, publicText: "다른 질문" }), false);
  await h.controller.poll();
  assert.equal(h.calls.length, 2);
  input.reject(new WorkflowError("UNAVAILABLE"));
  assert.equal(await sending, false);
  const pending = h.controller.getSnapshot().pendingDirect!;
  assert.equal(pending.body.operationId, sent.body.operationId);
  assert.equal(await h.controller.mutate("ask", fields), false);
  h.setBehavior(async (action) => (action === "read-recovery" ? page() : {}));
  assert.equal(await h.controller.mutate(pending.action, {}, pending.body), true);
  assert.deepEqual(h.calls.at(-1)!.body, sent.body);
  assert.equal(h.entries.size, 0);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.at(-1)!.action, "read-recovery");
});

test("should pause a pending poll and serialize mutations until confirmation", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const read = deferred<unknown>(),
    mutation = deferred<unknown>();
  h.setBehavior((action) => (action === "read-recovery" ? read.promise : mutation.promise));
  const poll = h.controller.poll();
  const request = h.controller.mutate("speak", { publicText: "공동 메시지" });
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(await h.controller.mutate("speak", { publicText: "중복 메시지" }), false);
  t.mock.timers.tick(30_000);
  assert.equal(h.calls.length, 3);
  read.resolve({ ...page(), roomRevision: 99 });
  await poll;
  assert.equal(h.controller.getSnapshot().history.snapshot!.roomRevision, page().roomRevision);
  mutation.resolve({ eventId: fixture.ask.operationId, sequence: 1 });
  assert.equal(await request, true);
  assert.equal(h.controller.getSnapshot().busy, false);
});

test("should abort every owned request and permanently clear history on source access loss", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const read = deferred<unknown>(),
    mutation = deferred<unknown>();
  h.setBehavior((action) => (action === "read-recovery" ? read.promise : mutation.promise));
  const polling = h.controller.poll();
  const sending = h.controller.mutate("ask", fields);
  h.controller.loseAccess();
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(h.calls[2].signal.aborted, true);
  assert.equal(h.controller.getSnapshot().history.snapshot, null);
  assert.equal(h.controller.getSnapshot().permissionDenied, true);
  read.resolve({ ...page(), roomRevision: 99 });
  mutation.resolve({});
  await polling;
  assert.equal(await sending, false);
  assert.equal(h.controller.getSnapshot().history.snapshot, null);
  assert.ok(h.controller.getSnapshot().pendingDirect);
  assert.equal(await h.controller.mutate("ask", fields), false);
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 3);
});

test("should stop after a denied poll and reject observer mutations", async (t) => {
  const h = setup(t, "observer");
  await h.controller.poll();
  assert.equal(await h.controller.mutate("ask", fields), false);
  assert.equal(await h.controller.mutate("speak", { publicText: "메시지" }), false);
  h.setBehavior(async () => {
    throw new WorkflowError("FORBIDDEN");
  });
  await h.controller.poll();
  assert.equal(h.controller.getSnapshot().permissionDenied, true);
  assert.equal(h.controller.getSnapshot().history.snapshot, null);
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 2);
});

test("should preserve an unresolved input on unmount even when HTTP resolves late", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const result = deferred<unknown>();
  h.setBehavior(() => result.promise);
  const sending = h.controller.mutate("ask", fields);
  const saved = h.entries.get(directIntentKey(actor.userId, actor.roomId))!;
  h.controller.stop();
  assert.equal(h.calls.at(-1)!.signal.aborted, true);
  result.resolve({});
  assert.equal(await sending, false);
  assert.equal(h.entries.get(directIntentKey(actor.userId, actor.roomId)), saved);
  h.controller.start();
  assert.deepEqual(h.controller.getSnapshot().pendingDirect, JSON.parse(saved));
});

test("should report an accepted input despite cleanup failure and never submit if saving fails", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const remove = h.storage.removeItem;
  h.storage.removeItem = () => {
    throw new Error("Storage unavailable");
  };
  assert.equal(await h.controller.mutate("ask", fields), true);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.ok(h.controller.getSnapshot().storageError);
  assert.equal(h.calls.filter((call) => call.action === "ask").length, 1);
  h.storage.removeItem = remove;
  h.storage.setItem = () => {
    throw new Error("Storage unavailable");
  };
  assert.equal(await h.controller.mutate("ask", fields), false);
  assert.equal(h.calls.filter((call) => call.action === "ask").length, 1);
});

test("should clear a confirmed rejected direct intent without generating a replacement", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  h.setBehavior(async () => {
    throw new WorkflowError("CONFLICT");
  });
  assert.equal(await h.controller.mutate("ask", fields), false);
  assert.equal(h.entries.size, 0);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.equal(h.calls.filter((call) => call.action === "ask").length, 1);
});

const retireFields = () => {
  const { protocol, roomId, operationId, expectedUserId, ...fields } = retirementFixture.retire;
  void protocol;
  void roomId;
  void operationId;
  void expectedUserId;
  return fields;
};
test("should record a pinned retirement immediately and block new asks until its recovery revision", async (t) => {
  const h = setup(t);
  h.setPage(retirementFixture.history);
  await h.controller.poll();
  assert.equal(h.calls[0].action, "read-recovery");
  assert.equal(h.calls[0].body.afterRetirementSequence, 0);
  h.setBehavior(async () => retirementFixture.receipt);
  assert.equal(await h.controller.mutate("retire", retireFields()), true);
  const history = h.controller.getSnapshot().history;
  assert.equal(history.retirements.length, 1);
  assert.equal(history.retirementCursor, 0);
  assert.equal(history.runs[0].state, "UNKNOWN");
  assert.equal(await h.controller.mutate("ask", fields), false);
  h.setBehavior(async () => {
    throw new WorkflowError("UNAVAILABLE");
  });
  await h.controller.poll();
  assert.equal(h.controller.getSnapshot().history.retirements.length, 1);
  assert.equal(await h.controller.mutate("ask", fields), false);
  h.setBehavior(async () => ({ ...page(), highWaterSequence: 1, nextCursor: 1, roomRevision: 1 }));
  await h.controller.poll();
  assert.equal(await h.controller.mutate("ask", fields), false);
  h.setBehavior(async () => ({
    ...page(),
    highWaterSequence: 1,
    nextCursor: 1,
    roomRevision: retirementFixture.receipt.roomRevision,
  }));
  await h.controller.poll();
  h.setBehavior(async () => fixture.admission);
  assert.equal(await h.controller.mutate("ask", { ...fields, expectedRoomRevision: 2 }), true);
});

test("should reject every mismatched retirement receipt and confirm only the saved operation", async (t) => {
  for (const field of ["requestId", "cycleId", "attemptId", "fence", "agentId", "bindingEpoch"]) {
    t.mock.timers.reset();
    const h = setup(t);
    h.setPage(retirementFixture.history);
    await h.controller.poll();
    const receipt = structuredClone(retirementFixture.receipt);
    receipt[field] = typeof receipt[field] === "number" ? 9 : fixture.ask.operationId;
    h.setBehavior(async () => receipt);
    assert.equal(await h.controller.mutate("retire", retireFields()), false);
    assert.equal(h.controller.getSnapshot().history.retirements.length, 0);
    const pending = h.controller.getSnapshot().pendingDirect!;
    assert.equal(pending.action, "retire");
    assert.equal(
      await h.controller.mutate(
        "retire",
        {},
        { ...pending.body, operationId: fixture.ask.targetAgentId },
      ),
      false,
    );
    h.setBehavior(async () => retirementFixture.receipt);
    assert.equal(await h.controller.mutate("retire", {}, pending.body), true);
    assert.deepEqual(h.calls.at(-1)!.body, pending.body);
    h.controller.stop();
  }
});

test("should preserve access when an uncertain cancel is retried after another actor retires it", async (t) => {
  const h = setup(t);
  h.setPage(fixture.history);
  await h.controller.poll();
  h.setBehavior(async () => {
    throw new WorkflowError("UNAVAILABLE");
  });
  assert.equal(await h.controller.mutate("cancel", cancelFields), false);
  const pending = h.controller.getSnapshot().pendingDirect!;
  const { state, attemptId, fence, roomRevision, ...retirement } = retirementFixture.receipt;
  void state;
  void attemptId;
  void fence;
  h.setBehavior(async () => ({
    ...page(),
    highWaterSequence: 1,
    nextCursor: 1,
    roomRevision,
    recovery: {
      ...page().recovery,
      retirements: [retirement],
      nextRetirementCursor: 1,
      highWaterRetirementSequence: 1,
    },
  }));
  await h.controller.poll();
  h.setBehavior(async () => fixture.cancelResult);
  assert.equal(await h.controller.mutate("cancel", {}, pending.body), true);
  assert.equal(h.controller.getSnapshot().permissionDenied, false);
  assert.equal(h.controller.getSnapshot().history.retirements.length, 1);
  h.setBehavior(async () => ({
    ...page(),
    highWaterSequence: 1,
    nextCursor: 1,
    roomRevision,
    recovery: { ...page().recovery, nextRetirementCursor: 1, highWaterRetirementSequence: 1 },
  }));
  await h.controller.poll();
  assert.equal(h.calls.at(-1)!.action, "read-recovery");
});

test("should drain independent retirement pages beyond the latest thirty-two runs", async (t) => {
  const h = setup(t);
  h.setPage(retirementFixture.history);
  await h.controller.poll();
  const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  const { state, attemptId, fence, roomRevision, ...first } = retirementFixture.receipt;
  void state;
  void attemptId;
  void fence;
  const retirements = [
    first,
    ...Array.from({ length: 32 }, (_, index) => ({
      ...first,
      sequence: index + 2,
      requestId: uuid(index + 100),
      cycleId: uuid(index + 200),
    })),
  ];
  const base = {
    ...page(),
    roomRevision,
    nextCursor: 1,
    highWaterSequence: 1,
    runs: [],
    cycle: null,
  };
  h.setBehavior(async (_action, body) => ({
    ...base,
    recovery: {
      ...page().recovery,
      retirements:
        body.afterRetirementSequence === 0 ? retirements.slice(0, 32) : retirements.slice(32),
      nextRetirementCursor: body.afterRetirementSequence === 0 ? 32 : 33,
      highWaterRetirementSequence: 33,
      hasMoreRetirements: body.afterRetirementSequence === 0,
    },
  }));
  await h.controller.poll();
  assert.equal(h.controller.getSnapshot().history.retirementCursor, 32);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.at(-1)!.body.afterSequence, 1);
  assert.equal(h.calls.at(-1)!.body.afterRetirementSequence, 32);
  const history = h.controller.getSnapshot().history;
  assert.equal(history.retirementCursor, 33);
  assert.equal(history.retirements.length, 33);
  assert.equal(history.runs.find((run) => run.requestId === first.requestId)!.state, "UNKNOWN");
});

test("should use the shared server blocker even when the latest run list is empty", async (t) => {
  const h = setup(t);
  h.setPage({ ...page(), recovery: { ...page().recovery, hasBlockingRuns: true } });
  await h.controller.poll();
  for (const action of ["ask", "start", "resume"] as const)
    assert.equal(await h.controller.mutate(action, fields), false);
  assert.equal(h.calls.length, 1);
});

test("should reject legacy fallback foreign rooms and retirement cursor jumps without enabling stale asks", async (t) => {
  for (const invalid of [
    fixture.history,
    { ...page(), roomId: fixture.ask.targetAgentId },
    {
      ...page(),
      recovery: { ...page().recovery, nextRetirementCursor: 1, highWaterRetirementSequence: 1 },
    },
  ]) {
    t.mock.timers.reset();
    const h = setup(t);
    await h.controller.poll();
    h.setBehavior(async () => invalid);
    await h.controller.poll();
    assert.ok(h.controller.getSnapshot().pollError);
    assert.equal(h.controller.getSnapshot().permissionDenied, false);
    assert.equal(await h.controller.mutate("ask", fields), false);
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every((call) => call.action === "read-recovery"));
    h.controller.stop();
  }
});

test("should refuse observer retirement and protect saved retirement intents on storage and lifecycle failures", async (t) => {
  const observer = setup(t, "observer");
  observer.setPage(retirementFixture.history);
  await observer.controller.poll();
  assert.equal(await observer.controller.mutate("retire", retireFields()), false);
  observer.controller.stop();
  t.mock.timers.reset();
  const h = setup(t);
  h.setPage(retirementFixture.history);
  await h.controller.poll();
  const original = h.storage.setItem;
  h.storage.setItem = () => {
    throw new Error("Storage unavailable");
  };
  assert.equal(await h.controller.mutate("retire", retireFields()), false);
  assert.equal(h.calls.length, 1);
  h.storage.setItem = original;
  const response = deferred<unknown>();
  h.setBehavior(() => response.promise);
  const sending = h.controller.mutate("retire", retireFields());
  const saved = h.controller.getSnapshot().pendingDirect!;
  assert.equal(JSON.parse(h.calls.at(-1)!.saved!).action, "retire");
  h.controller.stop();
  response.resolve(retirementFixture.receipt);
  assert.equal(await sending, false);
  assert.equal(h.controller.getSnapshot().history.retirements.length, 0);
  h.controller.start();
  assert.deepEqual(h.controller.getSnapshot().pendingDirect, saved);
  h.setBehavior(async () => retirementFixture.receipt);
  assert.equal(await h.controller.mutate("retire", {}, saved.body), true);
});

test("should reject foreign retirement identities against previously observed requests outside the new snapshot", async (t) => {
  const h = setup(t);
  h.setPage(retirementFixture.history);
  await h.controller.poll();
  const { state, attemptId, fence, roomRevision, ...retirement } = retirementFixture.receipt;
  void state;
  void attemptId;
  void fence;
  h.setBehavior(async () => ({
    ...page(),
    roomRevision,
    nextCursor: 1,
    highWaterSequence: 1,
    recovery: {
      ...page().recovery,
      retirements: [{ ...retirement, cycleId: fixture.ask.operationId }],
      nextRetirementCursor: 1,
      highWaterRetirementSequence: 1,
    },
  }));
  await h.controller.poll();
  assert.ok(h.controller.getSnapshot().pollError);
  assert.equal(h.controller.getSnapshot().history.retirementCursor, 0);
  assert.equal(h.controller.getSnapshot().history.retirements.length, 0);
});

function historyBatch(after: number, total = 64): RecoveryHistoryPage {
  const end = Math.min(after + 16, total);
  return {
    ...page(),
    events: Array.from({ length: end - after }, (_, index) => ({
      ...fixture.history.events[0],
      eventId: `00000000-0000-4000-8000-${String(after + index + 1000).padStart(12, "0")}`,
      sequence: after + index + 1,
      publicText: `기록 ${after + index + 1}`,
      kind: "SPEECH",
      adoption: "NONE",
      cycleId: null,
      requestId: null,
      questionId: null,
      bindingEpoch: null,
      agentId: null,
      requestKind: null,
    })),
    nextCursor: end,
    highWaterSequence: total,
    hasMore: end < total,
  };
}

test("should load four history pages serially without a polling delay on room entry", async (t) => {
  const h = setup(t);
  h.setBehavior(async (_action, body) => historyBatch(body.afterSequence as number));
  for (let index = 0; index < 4; index++) {
    t.mock.timers.tick(0);
    await flush();
    assert.equal(h.calls.length, index + 1);
    assert.equal(h.controller.getSnapshot().history.events.length, (index + 1) * 16);
  }
  assert.deepEqual(
    h.calls.map((call) => call.body.afterSequence),
    [0, 16, 32, 48],
  );
  t.mock.timers.tick(9999);
  assert.equal(h.calls.length, 4);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 5);
});

test("should keep progressive backfill serialized and abort it when leaving the room", async (t) => {
  const h = setup(t);
  const second = deferred<unknown>();
  h.setBehavior(async (_action, body) =>
    body.afterSequence === 0 ? historyBatch(0) : second.promise,
  );
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.length, 2);
  await h.controller.poll();
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 2);
  h.controller.stop();
  assert.equal(h.calls[1].signal.aborted, true);
  second.resolve(historyBatch(16));
  await flush();
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 2);
  assert.equal(h.controller.getSnapshot().history.cursor, 16);
});

test("should retain hidden-tab throttling even when history advances", async (t) => {
  const h = setup(t);
  h.hide();
  h.setBehavior(async (_action, body) => historyBatch(body.afterSequence as number));
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(29_999);
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.controller.getSnapshot().history.cursor, 32);
});

test("should back off after a failed immediate history page and resume from its cursor", async (t) => {
  const h = setup(t);
  h.setBehavior(async (_action, body) => {
    if (body.afterSequence === 16) throw new WorkflowError("UNAVAILABLE");
    return historyBatch(0);
  });
  t.mock.timers.tick(0);
  await flush();
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.ok(h.controller.getSnapshot().pollError);
  t.mock.timers.tick(19_999);
  assert.equal(h.calls.length, 2);
  h.setBehavior(async (_action, body) => historyBatch(body.afterSequence as number));
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].body.afterSequence, 16);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.length, 4);
});

test("should clear loaded history and stop backfill immediately when access is denied", async (t) => {
  const h = setup(t);
  h.setBehavior(async (_action, body) => {
    if (body.afterSequence === 16) throw new WorkflowError("FORBIDDEN");
    return historyBatch(0);
  });
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.controller.getSnapshot().history.events.length, 16);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.controller.getSnapshot().permissionDenied, true);
  assert.deepEqual(h.controller.getSnapshot().history.events, []);
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 2);
});

const speechReceipt = { eventId: fixture.ask.operationId, sequence: 1 };
const resync = (controller: RoomChatController) =>
  (controller as unknown as { requestResync(): void }).requestResync();

test("should reuse the speech operation after a lost response and never retransmit automatically", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const response = deferred<unknown>();
  h.setBehavior((action) =>
    action === "read-recovery" ? Promise.resolve(page()) : response.promise,
  );
  const sending = h.controller.mutate("speak", { publicText: "보존할 발언" });
  const sent = h.calls.at(-1)!;
  assert.deepEqual(JSON.parse(sent.saved!), { action: "speak", body: sent.body });
  assert.equal(sent.body.expectedUserId, actor.userId);
  assert.equal(await h.controller.mutate("speak", { publicText: "중복" }), false);
  response.reject(new WorkflowError("UNAVAILABLE"));
  assert.equal(await sending, false);
  h.controller.stop();
  h.controller.start();
  const pending = h.controller.getSnapshot().pendingDirect!;
  assert.deepEqual(pending.body, sent.body);
  h.setBehavior(async (action) => (action === "read-recovery" ? page() : speechReceipt));
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.filter((c) => c.action === "speak").length, 1);
  assert.equal(await h.controller.mutate("speak", {}, pending.body), true);
  assert.deepEqual(h.calls.at(-1)!.body, sent.body);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.equal(h.controller.getSnapshot().history.events.length, 0);
});

test("should distinguish confirmed speech from storage cleanup failure and restore no rejected intent", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  h.setBehavior(async () => speechReceipt);
  const remove = h.storage.removeItem;
  h.storage.removeItem = () => {
    throw new Error("Storage cleanup denied");
  };
  assert.equal(await h.controller.mutate("speak", { publicText: "성공 발언" }), true);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.equal(h.controller.getSnapshot().actionError, null);
  h.setBehavior(async () => {
    throw new WorkflowError("CONFLICT");
  });
  assert.equal(await h.controller.mutate("speak", { publicText: "거절 발언" }), false);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  h.controller.stop();
  h.storage.removeItem = remove;
  h.controller.start();
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.match(h.controller.getSnapshot().actionError!, /상태가 바뀌/);
});

test("should preserve speech draft without sending when storage fails and validate speech receipts", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const save = h.storage.setItem;
  h.storage.setItem = () => {
    throw new Error("Storage full");
  };
  assert.equal(await h.controller.mutate("speak", { publicText: "초안" }), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.match(h.controller.getSnapshot().actionError!, /저장/);
  h.storage.setItem = save;
  h.setBehavior(async () => ({}));
  assert.equal(await h.controller.mutate("speak", { publicText: "초안" }), false);
  assert.equal(h.controller.getSnapshot().pendingDirect?.action, "speak");
});

test("should coalesce resync requests during polling and mutation without losing follow-up reads", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const read = deferred<unknown>();
  h.setBehavior(() => read.promise);
  const polling = h.controller.poll();
  for (let i = 0; i < 10; i++) resync(h.controller);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].signal.aborted, false);
  h.setBehavior(async () => page());
  read.resolve(page());
  await polling;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.calls.length, 3);
  const response = deferred<unknown>();
  h.setBehavior((action) =>
    action === "read-recovery" ? Promise.resolve(page()) : response.promise,
  );
  const sending = h.controller.mutate("speak", { publicText: "발언" });
  resync(h.controller);
  resync(h.controller);
  assert.equal(h.calls.length, 4);
  response.resolve(speechReceipt);
  assert.equal(await sending, true);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.calls.length, 5);
  h.controller.stop();
  resync(h.controller);
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(h.calls.length, 5);
});

test("should throttle repeated lifecycle events and preserve poll failure backoff", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  h.setBehavior(async () => {
    throw new WorkflowError("UNAVAILABLE");
  });
  resync(h.controller);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.calls.length, 2);
  for (let i = 0; i < 20; i++) resync(h.controller);
  t.mock.timers.tick(19_999);
  await flush();
  assert.equal(h.calls.length, 2);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(h.calls.length, 3);
  h.controller.loseAccess();
  resync(h.controller);
  t.mock.timers.tick(60_000);
  assert.equal(h.calls.length, 3);
});

test("should retain speech after stopping a request and ignore its late acknowledgement", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const response = deferred<unknown>();
  h.setBehavior(() => response.promise);
  const sending = h.controller.mutate("speak", { publicText: "진행 중 발언" });
  const saved = h.entries.get(directIntentKey(actor.userId, actor.roomId));
  h.controller.stop();
  response.resolve(speechReceipt);
  assert.equal(await sending, false);
  assert.equal(h.entries.get(directIntentKey(actor.userId, actor.roomId)), saved);
  h.controller.start();
  assert.deepEqual(h.controller.getSnapshot().pendingDirect, JSON.parse(saved!));
});

test("should clear definitive speech rejection even when cleanup fails and never restore a settled marker", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const key = directIntentKey(actor.userId, actor.roomId);
  const remove = h.storage.removeItem;
  h.storage.removeItem = (name) => {
    if (name === key) throw new Error("Cleanup unavailable");
    remove(name);
  };
  h.setBehavior(async () => {
    throw new WorkflowError("INVALID_BODY");
  });
  assert.equal(await h.controller.mutate("speak", { publicText: "확정 거절" }), false);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.equal(JSON.parse(h.entries.get(key)!).settled, true);
  h.controller.stop();
  h.controller.start();
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  assert.equal(h.calls.filter((c) => c.action === "speak").length, 1);
});

test("should preserve lifecycle notifications that arrive during a follow-up read", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const first = deferred<unknown>();
  h.setBehavior(() => first.promise);
  const polling = h.controller.poll();
  resync(h.controller);
  const second = deferred<unknown>();
  h.setBehavior(() => second.promise);
  first.resolve(page());
  await polling;
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.calls.length, 3);
  resync(h.controller);
  resync(h.controller);
  h.setBehavior(async () => page());
  second.resolve(page());
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.calls.length, 4);
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(h.calls.length, 4);
});
