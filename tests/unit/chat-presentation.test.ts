import test from "node:test";
import * as presentation from "../../src/features/investigation-coordinator/chat-presentation.ts";
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

test("should never treat an agent question origin as its saved recipient", () => {
  const question = { ...page.events[0], senderKind: "AGENT" as const };
  assert.equal(eventTarget(question, page.runs, page.bindings), null);
});

test("should use the source-read PEER snapshot rather than the agent question origin", () => {
  const question = { ...page.events[0], senderKind: "AGENT" as const };
  const snapshot = {
    requestId: "00000000-0000-4000-8000-000000000098",
    agentId: "00000000-0000-4000-8000-000000000099",
    bindingEpoch: 9,
    ownerAlias: "수신 사람",
    sessionAlias: "수신 세션",
    repositoryAlias: "수신 저장소",
    runtime: "claude" as const,
    reservedAt: "2026-10-06T00:00:00.000Z",
  };
  const target = eventTarget(question, page.runs, page.bindings, [], snapshot);
  assert.equal(target?.agentId, snapshot.agentId);
  assert.equal(target?.savedAlias, "수신 사람 · 수신 세션");
  assert.equal(target?.current, undefined);
});

type StatusContext = {
  events: HistoryPage["events"];
  runs: HistoryPage["runs"];
  historicalRuns?: import("../../src/features/investigation-coordinator/history-state.ts").HistoricalRun[];
  bindings: HistoryPage["bindings"];
  cycle: HistoryPage["cycle"];
  observedAt: number;
  now: number;
  pollError?: string | null;
  gap?: boolean;
  role?: "owner" | "participant" | "observer";
};
type Status = {
  requestId: string;
  interruptStage: "REQUESTED" | "ACKNOWLEDGED" | null;
  state: string;
  label: string;
  target: string;
  question: HistoryPage["events"][number] | null;
  spinning: boolean;
  freshness: string | null;
  ownConnection: boolean;
  guidance: string;
  detail: string;
  updatedAt: string | null;
};
function context(overrides: Partial<StatusContext> = {}): StatusContext {
  return {
    ...page,
    historicalRuns: [],
    observedAt: Date.parse(page.runs[0].updatedAt),
    now: Date.parse(page.runs[0].updatedAt),
    role: "participant",
    ...overrides,
  };
}
function statuses(input: StatusContext): Status[] {
  const fn = (presentation as Record<string, unknown>).answerStatuses;
  assert.equal(typeof fn, "function", "answer statuses must be visible and evidence based");
  return (fn as (input: StatusContext) => { statuses: Status[] })(input).statuses;
}
function notice(
  event: HistoryPage["events"][number],
  input: StatusContext,
): { explanation: string; statuses: Status[] } {
  const fn = (presentation as Record<string, unknown>).humanInputNotice;
  assert.equal(typeof fn, "function", "human input needs a reason and next step");
  return (
    fn as (
      event: HistoryPage["events"][number],
      input: StatusContext,
    ) => { explanation: string; statuses: Status[] }
  )(event, input);
}
const stateLabels = {
  QUEUED: "질문 접수 · AI 응답 대기",
  LEASED: "답변 준비 중",
  RUNNING: "답변 생성 중",
  COMPLETED: "답변 완료",
  FAILED: "답변 실패",
  INTERRUPTED: "중단 확인",
  CANCELLED: "시작 전 취소",
  UNKNOWN: "실행 결과 확인 필요",
} as const;
for (const [state, label] of Object.entries(stateLabels)) {
  test(`should present ${state} with saved target and question evidence`, () => {
    const [status] = statuses(
      context({
        runs: [{ ...page.runs[0], state: state as HistoryPage["runs"][number]["state"] }],
      }),
    );
    assert.equal(status.label, label);
    assert.equal(status.target, "소유자 · 공개 세션");
    assert.equal(status.question?.eventId, page.events[0].eventId);
    assert.equal(status.spinning, ["QUEUED", "LEASED", "RUNNING"].includes(state));
    if (state === "UNKNOWN") {
      assert.match(status.detail, /성공.*중단.*확인되지/);
      assert.match(status.guidance, /소유자.*Mac.*터미널/);
    }
    if (["FAILED", "INTERRUPTED", "CANCELLED"].includes(state))
      assert.match(status.guidance, /새 질문/);
  });
}
test("should retain known state without motion when polling fails is stale or history has a gap", () => {
  for (const overrides of [
    { pollError: "조회 실패" },
    { gap: true },
    { now: context().now + 40_000 },
    { observedAt: 0 },
    { now: context().now - 1 },
  ]) {
    const [status] = statuses(context(overrides));
    assert.equal(status.state, "QUEUED");
    assert.equal(status.spinning, false);
    assert.equal(status.freshness, "상태 갱신 지연/확인 불가");
    assert.equal(status.updatedAt, page.runs[0].updatedAt);
  }
});
test("should await actual terminal after interruption request and acknowledgement", () => {
  const interrupt = {
    ...page.events[0],
    kind: "INTERRUPT_REQUESTED" as const,
    sequence: 2,
    questionId: null,
  };
  const ack = { ...interrupt, kind: "INTERRUPT_ACKNOWLEDGED" as const, sequence: 3 };
  for (const events of [[interrupt], [interrupt, ack]]) {
    const [status] = statuses(
      context({
        events: [...page.events, ...events],
        runs: [{ ...page.runs[0], state: "RUNNING" }],
      }),
    );
    assert.equal(status.label, "중단 요청 중 · 종료 확인 대기");
    assert.equal(status.spinning, false);
  }
  assert.equal(
    statuses(
      context({
        events: [...page.events, interrupt, ack],
        runs: [{ ...page.runs[0], state: "INTERRUPTED" }],
      }),
    )[0].label,
    "중단 확인",
  );
  assert.equal(
    statuses(
      context({
        events: [...page.events, interrupt, ack],
        runs: [{ ...page.runs[0], state: "UNKNOWN" }],
      }),
    )[0].label,
    "중단 수신 확인 · 종료 확인 대기",
  );
});
test("should retain UNKNOWN while distinguishing server request and Mac acknowledgement", () => {
  const requested = {
    ...page.events[0],
    eventId: "interrupt",
    sequence: 2,
    kind: "INTERRUPT_REQUESTED" as const,
    questionId: null,
  };
  const ack = {
    ...requested,
    eventId: "ack",
    sequence: 3,
    kind: "INTERRUPT_ACKNOWLEDGED" as const,
  };
  for (const [events, stage, detail] of [
    [[requested], "REQUESTED", /서버.*접수/],
    [
      [requested, ack, { ...requested, eventId: "repeat", sequence: 4 }],
      "ACKNOWLEDGED",
      /Mac.*수신/,
    ],
  ] as const) {
    const status = statuses(
      context({
        events: [...page.events, ...events],
        runs: [{ ...page.runs[0], state: "UNKNOWN" }],
        pollError: "조회 실패",
        bindings: [],
      }),
    )[0];
    assert.equal(status.state, "UNKNOWN");
    assert.equal(status.interruptStage, stage);
    assert.match(status.label, /중단.*종료 확인 대기/);
    assert.match(status.detail, detail);
    assert.match(status.detail, /실제 실행 종료를 뜻하지/);
    assert.equal(status.spinning, false);
  }
  for (const state of ["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"] as const) {
    const status = statuses(
      context({ events: [...page.events, requested, ack], runs: [{ ...page.runs[0], state }] }),
    )[0];
    assert.equal(status.interruptStage, null);
    assert.equal(status.label, stateLabels[state]);
  }
});
test("should respect the historical interrupt stage cutoff", () => {
  const requested = {
    ...page.events[0],
    eventId: "interrupt",
    sequence: 2,
    kind: "INTERRUPT_REQUESTED" as const,
  };
  const human = {
    ...requested,
    eventId: "human",
    sequence: 3,
    kind: "HUMAN_INPUT_REQUIRED" as const,
    createdAt: "2026-10-01T00:00:01.000Z",
  };
  const ack = {
    ...requested,
    eventId: "ack",
    sequence: 4,
    kind: "INTERRUPT_ACKNOWLEDGED" as const,
  };
  const input = context({ events: [...page.events, requested, human, ack] });
  assert.equal(notice(human, input).statuses[0].interruptStage, "REQUESTED");
  assert.equal(statuses(input)[0].interruptStage, "ACKNOWLEDGED");
});
test("should scope immediate receipts to exact request cycle agent and epoch and exclude historical notices", () => {
  const run = page.runs[0];
  const receipt = {
    requestId: run.requestId,
    cycleId: run.cycleId,
    agentId: run.agentId,
    epoch: run.bindingEpoch,
    state: "REQUESTED" as const,
  };
  const human = {
    ...page.events[0],
    eventId: "human-notice",
    sequence: 2,
    createdAt: "2026-10-01T00:00:01.000Z",
    kind: "HUMAN_INPUT_REQUIRED" as const,
  };
  const input = { ...context({ events: [...page.events, human] }), cancelReceipts: [receipt] };
  assert.equal(presentation.answerStatuses(input).statuses[0].interruptStage, "REQUESTED");
  assert.equal(presentation.humanInputNotice(human, input).statuses[0].interruptStage, null);
  for (const overrides of [
    { requestId: "other" },
    { cycleId: "other" },
    { agentId: "other" },
    { epoch: 2 },
  ]) {
    assert.equal(
      presentation.answerStatuses({ ...input, cancelReceipts: [{ ...receipt, ...overrides }] })
        .statuses[0].interruptStage,
      null,
    );
  }
});
test("should ignore unrelated cycle epoch and request interruption evidence", () => {
  for (const overrides of [
    { cycleId: "other-cycle" },
    { bindingEpoch: 2 },
    { requestId: "other-request" },
    { agentId: "other-agent" },
  ]) {
    const interruption = {
      ...page.events[0],
      kind: "INTERRUPT_ACKNOWLEDGED" as const,
      sequence: 3,
      ...overrides,
    };
    assert.equal(
      statuses(context({ events: [...page.events, interruption] }))[0].label,
      stateLabels.QUEUED,
    );
  }
});
test("should never associate a different epoch cycle or request with a direct question", () => {
  for (const overrides of [
    { bindingEpoch: 2 },
    { cycleId: "other-cycle" },
    { requestId: "other-request" },
    { agentId: "other-agent" },
  ]) {
    const [status] = statuses(context({ runs: [{ ...page.runs[0], ...overrides }] }));
    assert.equal(status.question, null);
  }
});
test("should associate an agent question with its PEER recipient rather than its origin", () => {
  const question = {
    ...page.events[0],
    senderKind: "AGENT" as const,
    requestKind: "ORIGIN" as const,
    requestId: "origin-request",
    agentId: "origin-agent",
    bindingEpoch: 8,
  };
  const origin = {
    ...page.runs[0],
    requestKind: "ORIGIN" as const,
    requestId: question.requestId,
    agentId: question.agentId,
    bindingEpoch: 8,
    questionId: null,
  };
  const result = statuses(context({ events: [question], runs: [origin, page.runs[0]] }));
  assert.equal(
    result.find((s) => s.requestId === page.runs[0].requestId)?.question?.eventId,
    question.eventId,
  );
  assert.equal(result.find((s) => s.requestId === origin.requestId)?.question, null);
});
test("should preserve historical terminal identity without using renamed current aliases", () => {
  const run = page.runs[0];
  const report = {
    ...page.events[0],
    senderKind: "AGENT" as const,
    senderAlias: "저장된 세션",
    kind: "RUN_STATE" as const,
    questionId: null,
    sequence: 4,
    runState: "COMPLETED" as const,
  };
  const [status] = statuses(
    context({
      runs: [],
      events: [...page.events, report],
      historicalRuns: [
        {
          requestId: run.requestId,
          cycleId: run.cycleId,
          agentId: run.agentId,
          requestKind: run.requestKind,
          state: "COMPLETED",
          terminal: "COMPLETED",
          sequence: 4,
        },
      ],
      bindings: [{ ...page.bindings[0], ownerAlias: "바뀐 소유자", sessionAlias: "바뀐 세션" }],
    }),
  );
  assert.equal(status.label, "답변 완료");
  assert.match(status.target, /저장된 세션/);
  assert.doesNotMatch(status.target, /바뀐/);
  assert.equal(status.question?.eventId, page.events[0].eventId);
});
test("should offer only owned connection guidance and never offer observer mutations", () => {
  for (const role of ["owner", "participant", "observer"] as const) {
    const [status] = statuses(
      context({
        role,
        runs: [{ ...page.runs[0], state: "UNKNOWN" }],
        bindings: [{ ...page.bindings[0], owned: true }],
      }),
    );
    assert.equal(status.ownConnection, role !== "observer");
    assert.match(status.guidance, /터미널/);
  }
});
test("should explain human input using only evidence in the same cycle before the event", () => {
  const report = {
    ...page.events[0],
    kind: "RUN_STATE" as const,
    questionId: null,
    sequence: 2,
    runState: "UNKNOWN" as const,
  };
  const required = {
    ...page.events[0],
    kind: "HUMAN_INPUT_REQUIRED" as const,
    senderKind: "SYSTEM" as const,
    publicText: "",
    requestId: null,
    questionId: null,
    agentId: null,
    bindingEpoch: null,
    sequence: 3,
  };
  const result = notice(
    required,
    context({
      events: [...page.events, report, required],
      runs: [{ ...page.runs[0], state: "COMPLETED", updatedAt: "2026-10-01T00:00:10.000Z" }],
    }),
  );
  assert.match(result.explanation, /정확한 사유.*기록되지/);
  assert.equal(result.statuses[0].state, "UNKNOWN");
  assert.match(result.statuses[0].guidance, /같은 질문의 현재 답변 상태/);
  assert.doesNotMatch(result.statuses[0].guidance, /실행 종료가 확인될 때까지/);
  for (const evidence of [
    { ...report, cycleId: "other-cycle" },
    { ...report, sequence: 4 },
  ]) {
    const unrelated = notice(
      required,
      context({ events: [page.events[0], evidence, required], runs: [] }),
    );
    assert.equal(unrelated.statuses.length, 0);
    assert.match(unrelated.explanation, /같은 질문.*상태/);
  }
});
test("should use a known deadline only for the event cycle and event time", () => {
  const required = {
    ...page.events[0],
    kind: "HUMAN_INPUT_REQUIRED" as const,
    senderKind: "SYSTEM" as const,
    sequence: 13,
    requestId: null,
    questionId: null,
    agentId: null,
    bindingEpoch: null,
  };
  assert.match(notice(required, context()).explanation, /기한.*지났/);
  assert.doesNotMatch(
    notice(required, context({ cycle: { ...page.cycle!, cycleId: "other-cycle" } })).explanation,
    /기한.*지났/,
  );
});
test("should have no invented state when no request evidence exists", () => {
  assert.deepEqual(statuses(context({ events: [], runs: [], historicalRuns: [] })), []);
});

test("should keep a retained summary state when its last run event is older", () => {
  const run = page.runs[0];
  const report = {
    ...page.events[0],
    kind: "RUN_STATE" as const,
    senderKind: "AGENT" as const,
    sequence: 2,
    questionId: null,
    runState: "RUNNING" as const,
  };
  const [status] = statuses(
    context({
      runs: [],
      events: [...page.events, report],
      historicalRuns: [
        {
          requestId: run.requestId,
          cycleId: run.cycleId,
          agentId: run.agentId,
          requestKind: run.requestKind,
          state: "UNKNOWN",
          terminal: null,
          sequence: 2,
        },
      ],
    }),
  );
  assert.equal(status.state, "UNKNOWN");
  assert.equal(status.spinning, false);
});
test("should not overwrite event-time evidence with a later summary in the same millisecond", () => {
  const report = {
    ...page.events[0],
    kind: "RUN_STATE" as const,
    sequence: 2,
    questionId: null,
    runState: "RUNNING" as const,
  };
  const required = {
    ...report,
    kind: "HUMAN_INPUT_REQUIRED" as const,
    senderKind: "SYSTEM" as const,
    requestId: null,
    questionId: null,
    agentId: null,
    bindingEpoch: null,
    sequence: 3,
  };
  const later = { ...report, sequence: 4, runState: "INTERRUPTED" as const };
  const result = notice(
    required,
    context({
      runs: [{ ...page.runs[0], state: "INTERRUPTED" }],
      events: [page.events[0], report, required, later],
    }),
  );
  assert.equal(result.statuses[0].state, "RUNNING");
  assert.equal(result.statuses[0].spinning, false);
});

test("should associate a retained direct status using the persisted human-question epoch without current aliases", () => {
  const run = page.runs[0];
  const [status] = statuses(
    context({
      runs: [],
      historicalRuns: [
        {
          requestId: run.requestId,
          cycleId: run.cycleId,
          agentId: run.agentId,
          requestKind: run.requestKind,
          state: "COMPLETED",
          terminal: "COMPLETED",
          sequence: 0,
        },
      ],
      bindings: [{ ...page.bindings[0], sessionAlias: "현재 변경된 세션" }],
    }),
  );
  assert.equal(status.question?.eventId, page.events[0].eventId);
  assert.equal(status.target, "대상 AI 이름 미기록");
  assert.equal(status.updatedAt, null);
});
test("should avoid motion for a run outside the current cycle or its target epoch", () => {
  for (const cycle of [
    null,
    { ...page.cycle!, cycleId: "new-cycle" },
    { ...page.cycle!, targetEpoch: 2 },
  ]) {
    const [status] = statuses(context({ cycle: cycle as HistoryPage["cycle"] }));
    assert.equal(status.label, stateLabels.QUEUED);
    assert.equal(status.spinning, false);
  }
});
test("should disclose confirmed same-cycle reservation limits without claiming the event reason", () => {
  const required = {
    ...page.events[0],
    kind: "HUMAN_INPUT_REQUIRED" as const,
    senderKind: "SYSTEM" as const,
    requestId: null,
    questionId: null,
    agentId: null,
    bindingEpoch: null,
  };
  const cycle = {
    cycleId: required.cycleId!,
    originAgentId: "origin",
    peerAgentId: page.runs[0].agentId,
    originEpoch: 1,
    peerEpoch: 1,
    generation: 1,
    roomRevision: 1,
    state: "HUMAN_INPUT_REQUIRED" as const,
    runsReserved: 11,
    peerRoundsReserved: 5,
    deadline: "2099-01-01T00:00:00.000Z",
  };
  const result = notice(required, context({ cycle }));
  assert.match(result.explanation, /현재 같은 조사의 예약.*11\/11회.*5\/5회/);
  assert.match(result.explanation, /정확한 사유.*기록되지/);
  assert.doesNotMatch(
    notice(required, context({ cycle: { ...cycle, cycleId: "other" } })).explanation,
    /예약/,
  );
});

function cancelledPeerEvents(): HistoryPage["events"] {
  const queued = {
    ...page.events[0],
    eventId: "peer-queued",
    sequence: 20,
    kind: "RUN_STATE" as const,
    senderKind: "AGENT" as const,
    senderAlias: "저장된 수신 세션",
    questionId: null,
    publicText: "",
    runState: "QUEUED" as const,
    adoption: "NONE" as const,
  };
  const question = {
    ...page.events[0],
    eventId: "origin-question",
    sequence: 21,
    senderKind: "AGENT" as const,
    senderAlias: "원래 질문 세션",
    requestId: "origin-request",
    agentId: "origin-agent",
    bindingEpoch: 7,
    requestKind: "ORIGIN" as const,
  };
  const cancelled = {
    ...queued,
    eventId: "peer-cancelled",
    sequence: 30,
    runState: "CANCELLED" as const,
  };
  return [queued, question, cancelled];
}
test("should recover a cancelled historical PEER question without a latest summary or answer", () => {
  const events = cancelledPeerEvents();
  const [status] = statuses(context({ runs: [], events, bindings: [] }));
  assert.equal(status.state, "CANCELLED");
  assert.equal(status.question?.eventId, events[1].eventId);
  assert.match(status.target, /저장된 수신 세션/);
  assert.equal(status.spinning, false);
});

for (const kind of ["ORIGIN", "CONTINUATION", "RESUME"] as const) {
  test(`should recover ${kind} recipient by sequence with equal timestamps shuffled events and a replaced connection`, () => {
    const events = cancelledPeerEvents();
    events[1] = { ...events[1], requestKind: kind };
    const snapshot = structuredClone(events);
    const [status] = statuses(
      context({
        runs: [],
        events: [events[2], events[1], events[0]],
        bindings: [
          { ...page.bindings[0], owned: true, bindingEpoch: 2, sessionAlias: "새 연결 세션" },
        ],
      }),
    );
    assert.equal(status.question?.eventId, events[1].eventId);
    assert.equal(status.label, "시작 전 취소");
    assert.equal(status.ownConnection, false);
    assert.doesNotMatch(status.target, /새 연결/);
    assert.deepEqual(events, snapshot);
  });
}
const rejectedRecoveryCases: [string, (events: HistoryPage["events"]) => HistoryPage["events"]][] =
  [
    ["another cycle", (e) => [e[0], { ...e[1], cycleId: "other-cycle" }, e[2]]],
    ["another room", (e) => [e[0], { ...e[1], roomId: "other-room" }, e[2]]],
    ["nonadjacent sequence", (e) => [e[0], { ...e[1], sequence: 22 }, e[2]]],
    ["missing queued reservation", (e) => e.slice(1)],
    ["missing origin question", (e) => [e[0], e[2]]],
    ["nonqueued reservation", (e) => [{ ...e[0], runState: "LEASED" }, e[1], e[2]]],
    ["invalid origin kind", (e) => [e[0], { ...e[1], requestKind: "PEER" }, e[2]]],
    ["missing origin kind", (e) => [e[0], { ...e[1], requestKind: null }, e[2]]],
    ["reused origin request", (e) => [e[0], { ...e[1], requestId: e[0].requestId }, e[2]]],
    ["reused origin agent", (e) => [e[0], { ...e[1], agentId: e[0].agentId }, e[2]]],
    [
      "missing recipient epoch",
      (e) => [{ ...e[0], bindingEpoch: null }, e[1], { ...e[2], bindingEpoch: null }],
    ],
    ["missing origin epoch", (e) => [e[0], { ...e[1], bindingEpoch: null }, e[2]]],
    ["mismatched revision", (e) => [e[0], { ...e[1], roomRevision: 2 }, e[2]]],
    ["conflicting recipient epoch", (e) => [e[0], e[1], { ...e[2], bindingEpoch: 2 }]],
    ["conflicting recipient cycle", (e) => [e[0], e[1], { ...e[2], cycleId: "other-cycle" }]],
    ["conflicting recipient agent", (e) => [e[0], e[1], { ...e[2], agentId: "other-agent" }]],
    ["conflicting recipient kind", (e) => [e[0], e[1], { ...e[2], requestKind: "ORIGIN" }]],
    [
      "duplicate sequence",
      (e) => [...e, { ...e[1], eventId: "sequence-collision", questionId: "other-question" }],
    ],
    ["duplicate reservation sequence", (e) => [...e, { ...e[0], eventId: "sequence-collision" }]],
    [
      "duplicate event identifier",
      (e) => [...e, { ...e[1], sequence: 25, questionId: "other-question" }],
    ],
    [
      "duplicate question identifier",
      (e) => [
        ...e,
        { ...e[1], eventId: "question-collision", sequence: 25, requestId: "different-origin" },
      ],
    ],
    [
      "duplicate question identifier across cycles",
      (e) => [
        ...e,
        {
          ...e[1],
          eventId: "question-collision",
          sequence: 25,
          cycleId: "other-cycle",
          requestId: "different-origin",
        },
      ],
    ],
    [
      "conflicting origin identity",
      (e) => [
        ...e,
        {
          ...e[1],
          kind: "RUN_STATE",
          eventId: "conflicting-origin",
          sequence: 19,
          publicText: "",
          runState: "RUNNING",
          agentId: "other-origin",
        },
      ],
    ],
  ];
for (const [name, transform] of rejectedRecoveryCases) {
  test(`should not infer a historical recipient with ${name}`, () => {
    const result = statuses(context({ runs: [], events: transform(cancelledPeerEvents()) }));
    assert.equal(
      result.find((status) => status.requestId === page.runs[0].requestId)?.question ?? null,
      null,
    );
  });
}
test("should not infer adjacency across a history gap or a conflicting saved request", () => {
  const events = cancelledPeerEvents();
  assert.equal(statuses(context({ runs: [], events, gap: true }))[0].question, null);
  const originSummary = {
    ...page.runs[0],
    requestId: "origin-request",
    agentId: "other-origin",
    requestKind: "ORIGIN" as const,
    questionId: null,
  };
  const result = statuses(context({ runs: [originSummary], events }));
  assert.equal(
    result.find((status) => status.requestId === page.runs[0].requestId)?.question,
    null,
  );
});
test("should preserve explicit recipient evidence even when unrelated history has a gap", () => {
  const events = cancelledPeerEvents();
  const [status] = statuses(
    context({ events, gap: true, runs: [{ ...page.runs[0], state: "CANCELLED" }] }),
  );
  assert.equal(status.question?.eventId, events[1].eventId);
  assert.equal(status.spinning, false);
  assert.equal(status.freshness, "상태 갱신 지연/확인 불가");
});
test("should project large synthetic history without duplicate requests or cross-cycle question links", () => {
  const events: HistoryPage["events"] = [];
  const total = 2000;
  for (let index = 0; index < total; index++) {
    const sample = cancelledPeerEvents().map((event) => ({
      ...event,
      eventId: `${event.eventId}-${index}`,
      cycleId: `cycle-${index}`,
      sequence: index * 4 + (event.kind === "QUESTION" ? 2 : event.runState === "QUEUED" ? 1 : 3),
      requestId: event.kind === "QUESTION" ? `origin-${index}` : `peer-${index}`,
      questionId: event.kind === "QUESTION" ? `question-${index}` : null,
    }));
    events.push(...sample, {
      ...sample[2],
      kind: "HUMAN_INPUT_REQUIRED",
      eventId: `required-${index}`,
      sequence: index * 4 + 4,
      senderKind: "SYSTEM",
      requestId: null,
      agentId: null,
      bindingEpoch: null,
      requestKind: null,
      runState: null,
      adoption: "HUMAN_INPUT_REQUIRED",
    });
  }
  const projected = presentation.answerStatuses(
    context({ events: events.reverse(), runs: [], cycle: null, bindings: [] }),
  );
  assert.equal(projected.statuses.length, total);
  assert.equal(new Set(projected.statuses.map((status) => status.requestId)).size, total);
  assert.equal(projected.byQuestion.size, total);
  assert.equal(projected.notices.size, total);
  for (const status of projected.statuses) {
    const index = status.requestId.slice("peer-".length);
    assert.equal(status.question?.questionId, `question-${index}`);
    assert.equal(status.question?.cycleId, status.cycleId);
    assert.equal(status.state, "CANCELLED");
    assert.deepEqual(projected.byQuestion.get(status.question!.eventId), [status]);
    assert.equal(
      projected.notices.get(`required-${index}`)?.statuses[0].question?.eventId,
      status.question!.eventId,
    );
  }
});

test("should retain cancelled recipient association outside thirty-two unrelated latest summaries", () => {
  const events = cancelledPeerEvents();
  const run = page.runs[0];
  const latest = Array.from({ length: 32 }, (_, index) => ({
    ...run,
    requestId: `new-request-${index}`,
    cycleId: `new-cycle-${index}`,
    state: "COMPLETED" as const,
    ownerAlias: "최근 소유자",
    sessionAlias: "최근 세션",
  }));
  const result = statuses(
    context({
      runs: latest,
      events,
      historicalRuns: [
        {
          requestId: run.requestId,
          cycleId: run.cycleId,
          agentId: run.agentId,
          requestKind: "PEER",
          state: "CANCELLED",
          terminal: null,
          sequence: 30,
        },
      ],
    }),
  );
  const status = result.find((value) => value.requestId === run.requestId)!;
  assert.equal(status.question?.eventId, events[1].eventId);
  assert.equal(status.state, "CANCELLED");
  assert.doesNotMatch(status.target, /최근/);
  assert.equal(result.length, 33);
});
test("should reject conflicting retained and duplicate summary identities during reservation recovery", () => {
  const events = cancelledPeerEvents();
  const run = page.runs[0];
  for (const overrides of [
    { cycleId: "other-cycle" },
    { agentId: "other-agent" },
    { requestKind: "ORIGIN" as const },
  ]) {
    const result = statuses(
      context({
        runs: [],
        events,
        historicalRuns: [
          {
            requestId: run.requestId,
            cycleId: run.cycleId,
            agentId: run.agentId,
            requestKind: "PEER",
            state: "CANCELLED",
            terminal: null,
            sequence: 30,
            ...overrides,
          },
        ],
      }),
    );
    assert.equal(result[0]?.question ?? null, null);
  }
  const result = statuses(
    context({
      events,
      runs: [
        { ...run, questionId: null },
        { ...run, questionId: null, bindingEpoch: 2 },
      ],
    }),
  );
  assert.equal(result[0].question, null);
});

const peerRevisionSummary: HistoryPage["runs"][number] = {
  ...page.runs[0],
  questionId: null,
  state: "CANCELLED",
};
const originRevisionSummary: HistoryPage["runs"][number] = {
  ...page.runs[0],
  requestId: "origin-request",
  agentId: "origin-agent",
  bindingEpoch: 7,
  requestKind: "ORIGIN",
  questionId: null,
};
function assertRevisionConflict(events: HistoryPage["events"], runs: HistoryPage["runs"] = []) {
  const original = structuredClone({ events, runs });
  const result = statuses(context({ events, runs }));
  const peer = result.find((status) => status.requestId === page.runs[0].requestId)!;
  assert.equal(peer.state, "CANCELLED");
  assert.equal(peer.question, null);
  assert.deepEqual({ events, runs }, original);
}
test("should reject historical association when a later peer state has a conflicting roomRevision", () => {
  const events = cancelledPeerEvents();
  events[2] = { ...events[2], roomRevision: 2 };
  assertRevisionConflict(events);
});
test("should reject historical association when the origin request later reports another roomRevision", () => {
  const events = cancelledPeerEvents();
  events.push({
    ...events[1],
    kind: "RUN_STATE",
    eventId: "origin-later-revision",
    sequence: 31,
    publicText: "",
    questionId: null,
    runState: "COMPLETED",
    terminal: "COMPLETED",
    adoption: "NONE",
    roomRevision: 2,
  });
  assertRevisionConflict(events);
});
test("should reject historical association when a peer summary conflicts with its first event roomRevision", () => {
  assertRevisionConflict(cancelledPeerEvents(), [{ ...peerRevisionSummary, roomRevision: 2 }]);
});
test("should reject historical association when the origin summary conflicts with its first event roomRevision", () => {
  assertRevisionConflict(cancelledPeerEvents(), [{ ...originRevisionSummary, roomRevision: 2 }]);
});
for (const revisions of [
  [2, 1],
  [1, 2],
]) {
  test(`should reject duplicate peer summaries with roomRevision order ${revisions.join(" then ")}`, () => {
    assertRevisionConflict(
      cancelledPeerEvents(),
      revisions.map((roomRevision) => ({ ...peerRevisionSummary, roomRevision })),
    );
  });
  test(`should reject duplicate origin summaries with roomRevision order ${revisions.join(" then ")}`, () => {
    assertRevisionConflict(
      cancelledPeerEvents(),
      revisions.map((roomRevision) => ({ ...originRevisionSummary, roomRevision })),
    );
  });
}
