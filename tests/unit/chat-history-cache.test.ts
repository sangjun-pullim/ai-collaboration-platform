import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cachedChatHistory,
  cacheChatHistory,
  clearChatHistory,
} from "../../src/features/investigation-coordinator/chat-history-cache.ts";
import {
  emptyHistory,
  mergeHistory,
} from "../../src/features/investigation-coordinator/history-state.ts";
import { RoomChatController } from "../../src/features/investigation-coordinator/room-chat-controller.ts";
import {
  WorkflowError,
  type RecoveryHistoryPage,
} from "../../src/features/investigation-coordinator/contracts.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const actor = {
  userId: fixture.ask.expectedUserId as string,
  roomId: fixture.history.roomId as string,
  role: "participant" as const,
};
const page = (): RecoveryHistoryPage => ({
  ...fixture.history,
  recovery: {
    hasBlockingRuns: false,
    candidate: null,
    retirements: [],
    nextRetirementCursor: 0,
    highWaterRetirementSequence: 0,
    hasMoreRetirements: false,
  },
});
test("should bound room cache by identity role time and three rooms", () => {
  clearChatHistory();
  const history = mergeHistory(emptyHistory(actor.roomId), page());
  for (let i = 0; i < 4; i++) cacheChatHistory({ ...actor, roomId: `room-${i}` }, history, i);
  assert.equal(cachedChatHistory({ ...actor, roomId: "room-0" }, 5), null);
  assert.equal(cachedChatHistory({ ...actor, roomId: "room-3" }, 300_004), null);
  cacheChatHistory(actor, history, 10);
  assert.equal(cachedChatHistory({ ...actor, role: "observer" }, 11), null);
  assert.equal(cachedChatHistory(actor, 12), null);
  cacheChatHistory(actor, history, 10);
  assert.equal(cachedChatHistory({ ...actor, userId: "another-user" }, 11), null);
  assert.equal(cachedChatHistory(actor, 12), null);
  clearChatHistory();
});
test("should keep cached contents private until expected actor HTTP validation and then request only after cursor", async (t) => {
  clearChatHistory();
  const initial = page();
  const history = mergeHistory(emptyHistory(actor.roomId), initial);
  cacheChatHistory(actor, history, 100);
  let resolve!: (value: unknown) => void;
  const pending = new Promise((done) => {
    resolve = done;
  });
  const calls: Record<string, unknown>[] = [];
  const controller = new RoomChatController(
    actor,
    async (action, body) => {
      assert.equal(action, "read-recovery");
      calls.push(body);
      return pending;
    },
    {
      cache: true,
      storage: () => ({ getItem: () => null, removeItem: () => {} }) as unknown as Storage,
      hidden: () => false,
      now: () => 101,
    },
  );
  t.after(() => {
    controller.stop();
    clearChatHistory();
  });
  controller.start();
  const polling = controller.poll();
  assert.equal(controller.getSnapshot().history.events.length, 0);
  assert.equal(controller.getSnapshot().history.snapshot, null);
  assert.equal(calls[0].afterSequence, history.cursor);
  assert.equal(calls[0].expectedUserId, actor.userId);
  resolve({ ...initial, events: [], nextCursor: history.cursor, hasMore: false });
  await polling;
  assert.equal(controller.getSnapshot().history.events, history.events);
});
test("should remove cached contents and pending intents after denied actor validation", async (t) => {
  clearChatHistory();
  const history = mergeHistory(emptyHistory(actor.roomId), page());
  cacheChatHistory(actor, history, 100);
  const controller = new RoomChatController(
    actor,
    async () => {
      throw new WorkflowError("FORBIDDEN");
    },
    {
      cache: true,
      storage: () => ({ removeItem: () => {} }) as unknown as Storage,
      hidden: () => false,
      now: () => 101,
    },
  );
  t.after(() => controller.stop());
  controller.start();
  await controller.poll();
  assert.equal(controller.getSnapshot().history.events.length, 0);
  assert.equal(controller.getSnapshot().pendingDirect, null);
  assert.equal(cachedChatHistory(actor, 102), null);
});

test("should hide same-controller BFCache history and pending speech until fresh actor validation", async (t) => {
  const initial = page();
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  let behavior: () => Promise<unknown> = async () => initial;
  const saved = {
    action: "speak",
    body: {
      protocol: 1,
      roomId: actor.roomId,
      expectedUserId: actor.userId,
      operationId: "00000000-0000-4000-8000-000000000077",
      publicText: "BFCache 인증 전 비공개 발언",
    },
  };
  const controller = new RoomChatController(
    actor,
    async (action, body) => {
      assert.equal(action, "read-recovery");
      assert.equal(body.expectedUserId, actor.userId);
      return behavior();
    },
    {
      storage: () =>
        ({ getItem: () => JSON.stringify(saved), removeItem: () => {} }) as unknown as Storage,
      hidden: () => false,
      now: () => 101,
    },
  );
  t.after(() => controller.stop());
  controller.start();
  await controller.poll();
  assert.ok(controller.getSnapshot().history.events.length > 0);
  assert.equal(controller.getSnapshot().pendingDirect?.body.publicText, saved.body.publicText);
  controller.stop();
  behavior = () =>
    new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
  controller.start();
  const pending = controller.poll();
  assert.equal(controller.getSnapshot().history.snapshot, null);
  assert.equal(controller.getSnapshot().history.events.length, 0);
  assert.equal(controller.getSnapshot().pendingDirect, null);
  resolve({ ...initial, events: [], nextCursor: initial.nextCursor });
  await pending;
  assert.ok(controller.getSnapshot().history.events.length > 0);
  assert.equal(controller.getSnapshot().pendingDirect?.body.publicText, saved.body.publicText);
  controller.stop();
  controller.start();
  const denied = controller.poll();
  assert.equal(controller.getSnapshot().history.events.length, 0);
  assert.equal(controller.getSnapshot().pendingDirect, null);
  reject(new WorkflowError("FORBIDDEN"));
  await denied;
  assert.equal(controller.getSnapshot().history.events.length, 0);
  assert.equal(controller.getSnapshot().pendingDirect, null);
  assert.equal(controller.getSnapshot().permissionDenied, true);
});
