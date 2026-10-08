import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  eventTarget,
  questionForReply,
  nearTimelineBottom,
  shouldSendOnEnter,
  timelineEvents,
} from "../../src/features/investigation-coordinator/chat-presentation.ts";
import { roomDefaults } from "../../src/features/room-access/room-defaults.ts";
import type { HistoryPage } from "../../src/features/investigation-coordinator/contracts.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const page = fixture.history as HistoryPage;

test("should distinguish persisted target identity from matching current metadata", () => {
  const event = page.events[0];
  const run = page.runs[0];
  const binding = page.bindings[0];
  const target = eventTarget(
    event,
    [run],
    [
      {
        ...binding,
        ownerAlias: "현재 이름",
        sessionAlias: "새 이름",
        repositoryAlias: "현재 저장소",
      },
    ],
  );
  assert.ok(target);
  assert.equal(target.agentId, event.agentId);
  assert.equal(target.epoch, event.bindingEpoch);
  assert.equal(target.savedAlias, `${run.ownerAlias} · ${run.sessionAlias}`);
  assert.equal(target.current?.repositoryAlias, "현재 저장소");
  assert.equal(
    eventTarget(event, [run], [{ ...binding, bindingEpoch: binding.bindingEpoch + 1 }])?.current,
    undefined,
  );
  assert.equal(eventTarget(event, [run], [])?.savedAlias, target.savedAlias);
  assert.equal(eventTarget(event, [], [binding])?.savedAlias, null);
  assert.equal(eventTarget({ ...event, agentId: null, bindingEpoch: null }, [], [binding]), null);
  // Matching metadata does not invent a historical repository snapshot.
  assert.equal("repositoryAlias" in target, false);
});
test("should link the reply's saved question to its recorded run without current alias fallback", () => {
  const question = page.events[0];
  const run = page.runs[0];
  const answer = {
    ...question,
    kind: "ANSWER" as const,
    requestId: null,
    agentId: null,
    bindingEpoch: null,
  };
  assert.equal(eventTarget(answer, [run], [])?.agentId, run.agentId);
  assert.equal(eventTarget({ ...answer, questionId: null }, [run], page.bindings), null);
});
test("should send Enter only outside composition and preserve Shift Enter", () => {
  assert.equal(shouldSendOnEnter("Enter", false, false, 13), true);
  for (const [shift, composing, keyCode] of [
    [true, false, 13],
    [false, true, 13],
    [false, false, 229],
  ] as const)
    assert.equal(shouldSendOnEnter("Enter", shift, composing, keyCode), false);
  assert.equal(shouldSendOnEnter("a", false, false, 65), false);
});
test("should follow new messages only near the bottom", () => {
  assert.equal(nearTimelineBottom(800, 200, 1000), true);
  assert.equal(nearTimelineBottom(0, 200, 1000), false);
  assert.equal(nearTimelineBottom(736, 200, 1000), false);
});
test("should create a name-only chat room with explicit omitted context", () => {
  assert.deepEqual(roomDefaults("  팀 대화  "), {
    title: "팀 대화",
    goal: "참가자 간 AI 채팅",
    observation: "입력하지 않음",
    environment: "입력하지 않음",
  });
});

test("should retain an older request status when its summary has left the latest page", () => {
  const event = page.events[0];
  const run = page.runs[0];
  const target = eventTarget(
    event,
    [],
    [],
    [
      {
        requestId: run.requestId,
        cycleId: run.cycleId,
        agentId: run.agentId,
        requestKind: run.requestKind,
        state: "COMPLETED",
        terminal: "COMPLETED",
        sequence: 2,
      },
    ],
  );
  assert.ok(target);
  assert.equal(target.agentId, event.agentId);
  assert.equal(target.epoch, event.bindingEpoch);
  assert.equal(target.state, "COMPLETED");
  assert.equal(target.savedAlias, null);
  assert.equal(target.current, undefined);
});

test("should link an answer to the question rather than an earlier run-state event", () => {
  const question = page.events[0];
  const report = {
    ...question,
    kind: "RUN_STATE" as const,
    eventId: "00000000-0000-4000-8000-000000000099",
    publicText: "",
  };
  const answer = { ...question, kind: "ANSWER" as const, replyTo: question.questionId };
  assert.equal(questionForReply(answer, [report, question]), question);
  assert.equal(questionForReply(answer, [report]), null);
});

test("should show the latest adoption of one answer without changing public history", () => {
  const question = page.events[0];
  const pending = {
    ...question,
    kind: "ANSWER" as const,
    eventId: "pending-answer",
    sequence: question.sequence + 1,
    adoption: "PENDING" as const,
  };
  const accepted = {
    ...pending,
    eventId: "accepted-answer",
    sequence: pending.sequence + 1,
    adoption: "ACCEPTED" as const,
  };
  const original = [question, pending, accepted];
  const snapshot = structuredClone(original);
  assert.deepEqual(timelineEvents(original), [question, accepted]);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(timelineEvents([accepted, question, pending]), [accepted, question]);
});

test("should retain distinct answer runs and answers without a complete identity", () => {
  const answer = {
    ...page.events[0],
    kind: "ANSWER" as const,
    eventId: "first-answer",
  };
  const other = { ...answer, eventId: "other-answer", requestId: "another-run" };
  const unknown = { ...answer, eventId: "unknown-answer", requestId: null };
  const unknownLater = { ...unknown, eventId: "unknown-later", sequence: unknown.sequence + 1 };
  assert.deepEqual(timelineEvents([answer, other, unknown, unknownLater]), [
    answer,
    other,
    unknown,
    unknownLater,
  ]);
});
