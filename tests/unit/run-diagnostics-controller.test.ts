import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { RoomChatController } from "../../src/features/investigation-coordinator/room-chat-controller.ts";
import type { RunDiagnosticsRequest } from "../../src/features/investigation-coordinator/run-diagnostics-contracts.ts";
import type { RecoveryHistoryPage } from "../../src/features/investigation-coordinator/contracts.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
test("should refresh unchanged runs on stop events and cycle changes and discard superseded diagnostics", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page: RecoveryHistoryPage = {
    ...fixture.history,
    events: [],
    nextCursor: 0,
    highWaterSequence: 0,
    hasMore: false,
    recovery: {
      hasBlockingRuns: true,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
  };
  const run = page.runs[0];
  let resolve!: (value: unknown) => void;
  let calls = 0;
  const response = (body: RunDiagnosticsRequest, reason: string | null = null) => ({
    protocol: 1,
    roomId: body.roomId,
    diagnostics: body.requestIds.map((requestId) => ({
      requestId,
      deadline: "2030-01-01T00:00:00Z",
      stopReason: reason,
      stopObservedAt: reason ? "2030-01-01T00:00:00Z" : null,
    })),
  });
  const controller = new RoomChatController(
    { userId: fixture.ask.expectedUserId, roomId: page.roomId, role: "participant" },
    async () => page,
    {
      now: () => 100,
      hidden: () => false,
      storage: () => ({ getItem: () => null }) as unknown as Storage,
    },
    undefined,
    async (body) => {
      calls++;
      if (calls === 1)
        return new Promise((done) => {
          resolve = done;
        });
      return response(body, "RESPONSE_TIMEOUT");
    },
  );
  t.after(() => controller.stop());
  controller.start();
  await controller.poll();
  await flush();
  assert.equal(calls, 1);
  await controller.poll();
  await flush();
  assert.equal(calls, 1);
  page.cycle = { ...page.cycle!, state: "HUMAN_INPUT_REQUIRED" };
  await controller.poll();
  await flush();
  assert.equal(calls, 2);
  resolve(
    response({
      protocol: 1,
      expectedUserId: fixture.ask.expectedUserId,
      roomId: page.roomId,
      requestIds: [run.requestId],
    }),
  );
  await flush();
  assert.equal(controller.getSnapshot().diagnostics[0].stopReason, "RESPONSE_TIMEOUT");
  const event = {
    ...fixture.history.events[0],
    eventId: "00000000-0000-4000-8000-000000000099",
    sequence: 1,
    kind: "HUMAN_INPUT_REQUIRED",
    senderKind: "SYSTEM",
    senderAlias: "시스템",
    agentId: null,
    bindingEpoch: null,
    requestKind: null,
    requestId: null,
    questionId: null,
    runState: null,
    publicText: "",
    adoption: "HUMAN_INPUT_REQUIRED",
    terminal: null,
    replyTo: null,
    roomMode: null,
  };
  page.events = [event];
  page.nextCursor = 1;
  page.highWaterSequence = 1;
  await controller.poll();
  await flush();
  assert.equal(calls, 3);
  page.events = [];
  await controller.poll();
  await flush();
  assert.equal(calls, 3);
  controller.loseAccess();
  assert.deepEqual(controller.getSnapshot().diagnostics, []);
});
test("should retry diagnostics on later polling only with a bounded budget and explicit retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const page = {
    ...fixture.history,
    events: [],
    nextCursor: 0,
    highWaterSequence: 0,
    hasMore: false,
    recovery: {
      hasBlockingRuns: true,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
  };
  let now = 100,
    calls = 0;
  const controller = new RoomChatController(
    { userId: fixture.ask.expectedUserId, roomId: page.roomId, role: "participant" },
    async () => page,
    {
      now: () => now,
      hidden: () => false,
      storage: () => ({ getItem: () => null }) as unknown as Storage,
    },
    undefined,
    async () => {
      calls++;
      throw Error("lost");
    },
  );
  t.after(() => controller.stop());
  controller.start();
  await controller.poll();
  await flush();
  assert.equal(calls, 1);
  await controller.poll();
  await flush();
  assert.equal(calls, 1);
  for (let i = 0; i < 5; i++) {
    now += 60_000;
    await controller.poll();
    await flush();
  }
  assert.equal(calls, 3);
  assert.equal(controller.getSnapshot().pollError, null);
  controller.retryDiagnostics();
  await flush();
  assert.equal(calls, 4);
  controller.stop();
  assert.deepEqual(controller.getSnapshot().diagnostics, []);
});

test("should keep an unchanged target eligible after three reads superseded by another target", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runA = { ...fixture.history.runs[0] };
  const runB = { ...runA, requestId: randomUUID() };
  const page = {
    ...fixture.history,
    events: [],
    runs: [runA, runB],
    nextCursor: 0,
    highWaterSequence: 0,
    hasMore: false,
    recovery: {
      hasBlockingRuns: true,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
  };
  let now = 0;
  const pending: {
    body: RunDiagnosticsRequest;
    signal: AbortSignal;
    resolve: (value: unknown) => void;
  }[] = [];
  const response = (body: RunDiagnosticsRequest) => ({
    protocol: 1,
    roomId: body.roomId,
    diagnostics: body.requestIds.map((requestId) => ({
      requestId,
      deadline: "2030-01-01T00:00:00Z",
      stopReason: null,
      stopObservedAt: null,
    })),
  });
  const controller = new RoomChatController(
    { userId: fixture.ask.expectedUserId, roomId: page.roomId, role: "participant" },
    async () => page,
    {
      now: () => now,
      hidden: () => false,
      storage: () => ({ getItem: () => null }) as unknown as Storage,
    },
    undefined,
    async (body, signal) => {
      if (!body.requestIds.includes(runA.requestId)) return response(body);
      return new Promise((resolve, reject) => {
        pending.push({ body, signal, resolve });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  );
  t.after(() => controller.stop());
  controller.start();
  for (const start of [0, 20_000, 50_000]) {
    now = start;
    await controller.poll();
    await flush();
    now = start + 1000;
    runB.updatedAt = new Date(Date.parse(runA.updatedAt) + now).toISOString();
    await controller.poll();
    await flush();
  }
  now = 60_000;
  await controller.poll();
  await flush();
  const active = [...pending].reverse().find((request) => !request.signal.aborted);
  assert.ok(active, "Unchanged target A must remain eligible after intentional cancellations");
  active.resolve(response(active.body));
  await flush();
  assert.ok(controller.getSnapshot().diagnostics.some((item) => item.requestId === runA.requestId));
  assert.equal(controller.getSnapshot().diagnosticsError, null);
});

test("should abort room and user lifecycle reads and ignore responses from the previous generation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const page = {
    ...fixture.history,
    events: [],
    nextCursor: 0,
    highWaterSequence: 0,
    hasMore: false,
    recovery: {
      hasBlockingRuns: true,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
  };
  const controller = new RoomChatController(
    { userId: fixture.ask.expectedUserId, roomId: page.roomId, role: "participant" },
    async () => page,
    {
      now: () => 100,
      hidden: () => false,
      storage: () => ({ getItem: () => null }) as unknown as Storage,
    },
    undefined,
    async (_body, currentSignal) => {
      signal = currentSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  );
  t.after(() => controller.stop());
  controller.start();
  await controller.poll();
  await flush();
  controller.invalidateSession(randomUUID());
  assert.equal(signal.aborted, true);
  resolve({
    protocol: 1,
    roomId: page.roomId,
    diagnostics: page.runs.map((run: { requestId: string }) => ({
      requestId: run.requestId,
      deadline: "2030-01-01T00:00:00Z",
      stopReason: "RESPONSE_TIMEOUT",
      stopObservedAt: "2030-01-01T00:00:00Z",
    })),
  });
  await flush();
  assert.deepEqual(controller.getSnapshot().diagnostics, []);
  assert.equal(controller.getSnapshot().permissionDenied, true);
});

test("should load more than forty historical targets in bounded batches without duplicate polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = Array.from({ length: 48 }, (_, i) => ({
    ...fixture.history.events[0],
    kind: "RUN_STATE",
    senderKind: "AGENT",
    senderAlias: "대상 AI",
    requestId: randomUUID(),
    eventId: randomUUID(),
    sequence: i + 1,
    publicText: "",
    questionId: null,
    runState: "CANCELLED",
    terminal: null,
    adoption: "NONE",
    replyTo: null,
    roomMode: null,
  }));
  const page = {
    ...fixture.history,
    events: [],
    runs: [],
    nextCursor: 0,
    highWaterSequence: 48,
    hasMore: true,
    recovery: {
      hasBlockingRuns: false,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
  };
  const calls: RunDiagnosticsRequest[] = [];
  const controller = new RoomChatController(
    { userId: fixture.ask.expectedUserId, roomId: page.roomId, role: "observer" },
    async (_action, body) => {
      const after = Number(body.afterSequence);
      return {
        ...page,
        events: events.slice(after, after + 16),
        nextCursor: Math.min(after + 16, 48),
        hasMore: after + 16 < 48,
      };
    },
    {
      now: () => 100,
      hidden: () => false,
      storage: () => ({ getItem: () => null }) as unknown as Storage,
    },
    undefined,
    async (body) => {
      calls.push(body);
      return {
        protocol: 1,
        roomId: body.roomId,
        diagnostics: body.requestIds.map((requestId) => ({
          requestId,
          deadline: "2030-01-01T00:00:00Z",
          stopReason: null,
          stopObservedAt: null,
        })),
      };
    },
  );
  t.after(() => controller.stop());
  controller.start();
  for (let i = 0; i < 3; i++) {
    await controller.poll();
    await flush();
  }
  assert.equal(new Set(calls.flatMap((call) => call.requestIds)).size, 48);
  assert.ok(calls.every((call) => call.requestIds.length <= 40));
  const count = calls.length;
  await controller.poll();
  await flush();
  assert.equal(calls.length, count);
  assert.equal(controller.getSnapshot().diagnostics.length, 48);
});
