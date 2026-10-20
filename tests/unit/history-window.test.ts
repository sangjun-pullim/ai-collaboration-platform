import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  historyWindowRequest,
  projectHistoryWindow,
  type HistoryWindow,
} from "../../src/features/investigation-coordinator/history-window-contracts.ts";
import {
  initialHistoryWindow,
  prependHistoryWindow,
  mergeHistory,
} from "../../src/features/investigation-coordinator/history-state.ts";
import { RoomChatController } from "../../src/features/investigation-coordinator/room-chat-controller.ts";
import { callHistoryWindow } from "../../src/features/investigation-coordinator/history-window-client.ts";
import {
  WorkflowError,
  type RecoveryHistoryPage,
} from "../../src/features/investigation-coordinator/contracts.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const actor = {
  userId: fixture.ask.expectedUserId,
  roomId: fixture.ask.roomId,
  role: "participant" as const,
};
function windowPage(
  first = 61,
  end = 100,
  beforeSequence: number | null = null,
  high = end,
): HistoryWindow {
  const snapshot: RecoveryHistoryPage = {
    ...fixture.history,
    events: [],
    runs: [],
    bindings: [],
    cycle: null,
    nextCursor: high,
    highWaterSequence: high,
    hasMore: false,
    recovery: {
      hasBlockingRuns: false,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
  };
  const events = Array.from({ length: Math.max(0, end - first + 1) }, (_, i) => ({
    ...fixture.history.events[0],
    eventId: `00000000-0000-4000-8000-${String(first + i).padStart(12, "0")}`,
    sequence: first + i,
    kind: "SPEECH",
    publicText: `message ${first + i}`,
    cycleId: null,
    requestId: null,
    questionId: null,
    agentId: null,
    bindingEpoch: null,
    requestKind: null,
    adoption: "NONE",
  }));
  return {
    protocol: 1,
    roomId: actor.roomId,
    beforeSequence,
    oldestSequence: events[0]?.sequence ?? null,
    hasOlder: !!events.length && first > 1,
    events,
    snapshot,
  };
}
test("should bound and validate transport responses and preserve access denials", async (t) => {
  const request = {
    protocol: 1 as const,
    expectedUserId: actor.userId,
    roomId: actor.roomId,
    beforeSequence: null,
  };
  let response = new Response(JSON.stringify({ ok: true, data: windowPage() }), {
    headers: { "Content-Type": "application/json" },
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.deepEqual(JSON.parse(init.body as string), request);
    return response;
  });
  assert.equal((await callHistoryWindow(request, new AbortController().signal)).events.length, 40);
  response = new Response(JSON.stringify({ ok: false, error: { code: "FORBIDDEN" } }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(callHistoryWindow(request, new AbortController().signal), {
    code: "FORBIDDEN",
  });
  response = new Response("x".repeat(262145), { headers: { "Content-Type": "application/json" } });
  await assert.rejects(callHistoryWindow(request, new AbortController().signal), {
    code: "UNAVAILABLE",
  });
  response = new Response("{}", { headers: { "Content-Type": "text/html" } });
  await assert.rejects(callHistoryWindow(request, new AbortController().signal), {
    code: "UNAVAILABLE",
  });
  response = new Response(new Uint8Array([0xc3, 0x28]), {
    headers: { "Content-Type": "application/json" },
  });
  await assert.rejects(callHistoryWindow(request, new AbortController().signal), {
    code: "UNAVAILABLE",
  });
  let timeoutMs = 0;
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    timeoutMs = ms;
    return timeout.signal;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => reject(new Error("timeout"))),
      ),
  );
  const pending = callHistoryWindow(request, new AbortController().signal);
  timeout.abort();
  await assert.rejects(pending, { code: "UNAVAILABLE" });
  assert.equal(timeoutMs, 10000);
});
test("should validate bounded latest and older windows without changing the legacy history contract", () => {
  assert.equal(projectHistoryWindow(windowPage()).events.length, 40);
  assert.equal(projectHistoryWindow(windowPage(21, 60, 61, 100)).beforeSequence, 61);
  assert.equal(projectHistoryWindow(windowPage(1, 0, null, 0)).events.length, 0);
  assert.equal(
    historyWindowRequest({
      protocol: 1,
      expectedUserId: actor.userId,
      roomId: actor.roomId,
      beforeSequence: null,
    }).beforeSequence,
    null,
  );
  for (const beforeSequence of [0, -1, 1.2, "40", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () =>
        historyWindowRequest({
          protocol: 1,
          expectedUserId: actor.userId,
          roomId: actor.roomId,
          beforeSequence,
        }),
      { code: "INVALID_BODY" },
    );
  for (const mutate of [
    (p: HistoryWindow) => {
      p.events.reverse();
    },
    (p: HistoryWindow) => {
      p.events[2].sequence++;
    },
    (p: HistoryWindow) => {
      p.events[0].roomId = actor.userId;
    },
    (p: HistoryWindow) => {
      p.events[0].eventId = p.events[1].eventId;
    },
    (p: HistoryWindow) => {
      p.hasOlder = false;
    },
    (p: HistoryWindow) => {
      p.beforeSequence = 99;
    },
    (p: HistoryWindow) => {
      p.events = [];
      p.oldestSequence = null;
      p.hasOlder = false;
    },
    (p: HistoryWindow) => {
      p.events.forEach((e) => {
        e.publicText = "한".repeat(8192);
      });
    },
  ]) {
    const p = windowPage();
    mutate(p);
    assert.throws(() => projectHistoryWindow(p), { code: "UNAVAILABLE" });
  }
});
test("should separate the loaded history floor from live continuity and preserve a concurrent append", () => {
  let state = initialHistoryWindow(projectHistoryWindow(windowPage()));
  assert.equal(state.cursor, 100);
  assert.equal(state.gap, false);
  assert.equal(state.window?.oldest, 61);
  const latest = windowPage(101, 101, null, 101);
  state = mergeHistory(state, { ...latest.snapshot, events: latest.events });
  const snapshot = state.snapshot;
  const conflict = windowPage(21, 60, 61, 100);
  conflict.events[0].eventId = state.events[0].eventId;
  assert.throws(() => prependHistoryWindow(state, projectHistoryWindow(conflict)), {
    code: "UNAVAILABLE",
  });
  state = prependHistoryWindow(state, projectHistoryWindow(windowPage(21, 60, 61, 100)));
  assert.equal(state.cursor, 101);
  assert.equal(state.snapshot, snapshot);
  assert.equal(state.gap, false);
  assert.equal(state.events.length, 81);
  assert.equal(state.window?.oldest, 21);
  state = prependHistoryWindow(state, projectHistoryWindow(windowPage(1, 20, 21, 101)));
  assert.equal(state.window?.hasOlder, false);
  assert.equal(state.events.length, 101);
  assert.throws(() => prependHistoryWindow(state, windowPage(1, 20, 21, 101)), {
    code: "UNAVAILABLE",
  });
});
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
test("should recover a live gap and drain independent retirements after recent initialization", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const recovery = (start: number, end: number) => ({
    hasBlockingRuns: false,
    candidate: null,
    retirements: Array.from({ length: end - start + 1 }, (_, i) => ({
      sequence: start + i,
      requestId: `00000000-0000-4000-8000-${String(1000 + start + i).padStart(12, "0")}`,
      cycleId: actor.userId,
      agentId: actor.userId,
      bindingEpoch: 1,
      retiredAt: "2026-10-01T00:00:00.000Z",
    })),
    nextRetirementCursor: end,
    highWaterRetirementSequence: 64,
    hasMoreRetirements: end < 64,
  });
  const initial = windowPage();
  initial.snapshot.recovery = recovery(1, 32);
  const calls: { afterSequence: number; afterRetirementSequence: number }[] = [];
  const controller = new RoomChatController(
    actor,
    async (_action, body) => {
      calls.push({
        afterSequence: Number(body.afterSequence),
        afterRetirementSequence: Number(body.afterRetirementSequence),
      });
      const p = windowPage(calls.length === 1 ? 102 : 101, 102, null, 102);
      return {
        ...p.snapshot,
        events: p.events,
        recovery: calls.length === 1 ? recovery(33, 64) : recovery(65, 64),
      };
    },
    {
      storage: () => ({ getItem: () => null }) as unknown as Storage,
      now: () => 10000,
      hidden: () => false,
    },
    async (body) => (body.beforeSequence === null ? initial : windowPage(21, 60, 61, 100)),
  );
  try {
    controller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(controller.getSnapshot().history.cursor, 100);
    assert.equal(controller.getSnapshot().history.retirementCursor, 32);
    await controller.poll();
    assert.equal(controller.getSnapshot().history.gap, true);
    assert.equal(controller.getSnapshot().history.cursor, 100);
    assert.equal(controller.getSnapshot().history.retirementCursor, 64);
    await controller.loadOlder();
    assert.equal(controller.getSnapshot().history.gap, true);
    assert.equal(controller.getSnapshot().history.retirementCursor, 64);
    await controller.poll();
    const state = controller.getSnapshot().history;
    assert.equal(state.cursor, 102);
    assert.equal(state.gap, false);
    assert.equal(state.retirementCursor, 64);
    assert.equal(state.retirements.length, 64);
    assert.equal(state.window?.oldest, 21);
    assert.equal(state.events.length, 82);
    assert.deepEqual(calls, [
      { afterSequence: 100, afterRetirementSequence: 32 },
      { afterSequence: 100, afterRetirementSequence: 64 },
    ]);
  } finally {
    controller.stop();
  }
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
test("should load one recent page and fetch older history only on demand without losing live events", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: (number | null)[] = [],
    forward: number[] = [];
  let pending = deferred<unknown>();
  const controller = new RoomChatController(
    actor,
    async (_action, body) => {
      forward.push(Number(body.afterSequence));
      const p = windowPage(101, 101, null, 101);
      return { ...p.snapshot, events: p.events };
    },
    {
      storage: () => ({ getItem: () => null }) as unknown as Storage,
      now: () => 10000,
      hidden: () => false,
    },
    async (body) => {
      calls.push(body.beforeSequence);
      return body.beforeSequence === null ? windowPage() : pending.promise;
    },
  );
  try {
    controller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(controller.getSnapshot().history.events.length, 40);
    t.mock.timers.tick(0);
    await flush();
    assert.deepEqual(calls, [null]);
    assert.deepEqual(forward, []);
    const first = controller.loadOlder();
    void controller.loadOlder();
    assert.deepEqual(calls, [null, 61]);
    await controller.poll();
    assert.deepEqual(forward, [100]);
    pending.resolve(windowPage(21, 60, 61, 100));
    await first;
    assert.equal(controller.getSnapshot().history.cursor, 101);
    assert.equal(controller.getSnapshot().history.events.length, 81);
    pending = deferred();
    const failed = controller.loadOlder();
    pending.reject(new Error("offline"));
    await failed;
    assert.ok(controller.getSnapshot().olderError);
    assert.equal(controller.getSnapshot().history.window?.oldest, 21);
    pending = deferred();
    const retry = controller.loadOlder();
    pending.resolve(windowPage(1, 20, 21, 101));
    await retry;
    assert.equal(controller.getSnapshot().olderError, null);
    assert.equal(controller.getSnapshot().history.window?.hasOlder, false);
    controller.stop();
    controller.start();
    t.mock.timers.tick(0);
    await flush();
    assert.equal(controller.getSnapshot().history.events.length, 40);
  } finally {
    controller.stop();
  }
});
test("should discard late older pages and clear the visible window after access loss", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<unknown>();
  let deny = false;
  const controller = new RoomChatController(
    actor,
    async () => {
      throw new WorkflowError("FORBIDDEN");
    },
    {
      storage: () => ({ getItem: () => null, removeItem: () => {} }) as unknown as Storage,
      now: () => 10000,
      hidden: () => false,
    },
    async (body) =>
      body.beforeSequence === null
        ? windowPage()
        : deny
          ? Promise.reject(new WorkflowError("FORBIDDEN"))
          : pending.promise,
  );
  try {
    controller.start();
    t.mock.timers.tick(0);
    await flush();
    const older = controller.loadOlder();
    controller.stop();
    pending.resolve(windowPage(21, 60, 61, 100));
    await older;
    assert.equal(controller.getSnapshot().history.events.length, 40);
    controller.start();
    t.mock.timers.tick(0);
    await flush();
    deny = true;
    await controller.loadOlder();
    assert.equal(controller.getSnapshot().permissionDenied, true);
    assert.equal(controller.getSnapshot().history.events.length, 0);
  } finally {
    controller.stop();
  }
});
