import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WorkflowError,
  type Body,
  type HistoryPage,
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
const page = (): HistoryPage => ({
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
  let behavior: RoomChatRequest = async (action) => (action === "read" ? currentPage : {});
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
    setPage: (next: HistoryPage) => {
      currentPage = next;
    },
  };
}

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
  h.setBehavior(async () => ({ ...page(), hasMore: true }));
  read.resolve({ ...page(), hasMore: true });
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
  h.setBehavior(async (action) => (action === "read" ? page() : input.promise));
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
  h.setBehavior(async (action) => (action === "read" ? page() : {}));
  assert.equal(await h.controller.mutate(pending.action, {}, pending.body), true);
  assert.deepEqual(h.calls.at(-1)!.body, sent.body);
  assert.equal(h.entries.size, 0);
  assert.equal(h.controller.getSnapshot().pendingDirect, null);
  t.mock.timers.tick(0);
  await flush();
  assert.equal(h.calls.at(-1)!.action, "read");
});

test("should pause a pending poll and serialize mutations until confirmation", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const read = deferred<unknown>(),
    mutation = deferred<unknown>();
  h.setBehavior((action) => (action === "read" ? read.promise : mutation.promise));
  const poll = h.controller.poll();
  const request = h.controller.mutate("speak", { publicText: "공동 메시지" });
  assert.equal(h.calls[1].signal.aborted, true);
  assert.equal(await h.controller.mutate("speak", { publicText: "중복 메시지" }), false);
  t.mock.timers.tick(30_000);
  assert.equal(h.calls.length, 3);
  read.resolve({ ...page(), roomRevision: 99 });
  await poll;
  assert.equal(h.controller.getSnapshot().history.snapshot!.roomRevision, page().roomRevision);
  mutation.resolve({});
  assert.equal(await request, true);
  assert.equal(h.controller.getSnapshot().busy, false);
});

test("should abort every owned request and permanently clear history on source access loss", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const read = deferred<unknown>(),
    mutation = deferred<unknown>();
  h.setBehavior((action) => (action === "read" ? read.promise : mutation.promise));
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

test("should retain an accepted input if local removal fails and never submit if saving fails", async (t) => {
  const h = setup(t);
  await h.controller.poll();
  const remove = h.storage.removeItem;
  h.storage.removeItem = () => {
    throw new Error("Storage unavailable");
  };
  assert.equal(await h.controller.mutate("ask", fields), false);
  assert.ok(h.controller.getSnapshot().pendingDirect);
  assert.equal(h.calls.filter((call) => call.action === "ask").length, 1);
  h.storage.removeItem = remove;
  const pending = h.controller.getSnapshot().pendingDirect!;
  assert.equal(await h.controller.mutate(pending.action, {}, pending.body), true);
  h.storage.setItem = () => {
    throw new Error("Storage unavailable");
  };
  assert.equal(await h.controller.mutate("ask", fields), false);
  assert.equal(h.calls.filter((call) => call.action === "ask").length, 2);
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
