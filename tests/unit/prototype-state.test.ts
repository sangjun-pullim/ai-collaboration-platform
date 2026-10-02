import test from "node:test";
import assert from "node:assert/strict";
import { exampleSetup, outboundText } from "../../src/features/investigation-prototype/mock-scenario.ts";
import { initialState, pauseStatus, prototypeReducer as reduce } from "../../src/features/investigation-prototype/prototype-state.ts";
import type { Action, Outcome, PrototypeState } from "../../src/features/investigation-prototype/prototype-state.ts";

function room(): PrototypeState {
  return reduce(initialState(), { type: "create", setup: { ...exampleSetup, scope: [...exampleSetup.scope] } });
}

test("should require a generic investigation goal and environment", () => {
  assert.equal(room().stage, "room");
  for (const key of ["goal", "symptom", "expected", "environment", "bindingA", "bindingB"] as const) {
    const state = reduce(initialState(), { type: "create", setup: { ...exampleSetup, [key]: " " } });
    assert.equal(state.stage, "setup");
    assert.ok(state.errors[key]);
  }
  assert.ok(reduce(initialState(), { type: "create", setup: { ...exampleSetup, scope: [] } }).errors.scope);
  assert.ok(reduce(initialState(), { type: "create", setup: { ...exampleSetup, scope: ["token"] } }).errors.scope);
  const limited = reduce(initialState(), { type: "create", setup: { ...exampleSetup, scope: ["events"] } });
  assert.equal(limited.shared.length, 1);
  assert.equal(limited.shared[0].location, undefined);
});

test("should keep private explanations out of shared events and drafts", () => {
  const before = room();
  const state = reduce(before, { type: "explain", text: "개인 원문 712", targetId: before.shared[0].id });
  assert.deepEqual(state.shared, before.shared);
  assert.deepEqual(state.draft, before.draft);
  assert.equal(state.privateHistory.length, 1);
  assert.equal(state.privateHistory[0].question, "개인 원문 712");
  assert.notEqual(state.privateHistory[0].target, before.shared[0]);
  const invalid = reduce(state, { type: "explain", text: "missing", targetId: 999 });
  assert.equal(invalid, state);
  const published = reduce(state, { type: "publish-private", explanationId: state.privateHistory[0].id, part: "answer" });
  assert.equal(published.shared.at(-1)?.text, state.privateHistory[0].answer);
  assert.ok(!published.shared.some((event) => event.text === "개인 원문 712"));
  assert.deepEqual(published.runs, before.runs);
  assert.deepEqual(published.draft, before.draft);
});

test("should publish a human statement without starting an ai run", () => {
  const before = room();
  const state = reduce(before, { type: "speak", text: "조회 순서를 확인합시다." });
  assert.equal(state.shared.length, before.shared.length + 1);
  assert.equal(state.shared.at(-1)?.sender, "사람");
  assert.deepEqual(state.runs, before.runs);
  assert.deepEqual(state.draft, before.draft);
  assert.equal(reduce(before, { type: "speak", text: " " }), before);
});

test("should publish only a finalized outbound draft", () => {
  const before = room();
  assert.ok(!before.shared.some((event) => event.text === outboundText));
  assert.equal(reduce(before, { type: "finalize-draft" }), before);
  const checked = reduce(before, { type: "check-draft" });
  assert.equal(checked.draft?.check, "passed");
  assert.deepEqual(checked.shared, before.shared);
  const published = reduce(checked, { type: "finalize-draft" });
  assert.equal(published.draft, null);
  assert.equal(published.shared.at(-1)?.text, outboundText);
  assert.equal(published.shared.at(-1)?.confirmed, true);
  assert.equal(reduce(published, { type: "finalize-draft" }), published);
});

test("should apply public steering after terminal confirmation", () => {
  const before = reduce(room(), { type: "explain", text: "비공개 고민", targetId: 1 });
  const pending = reduce(before, { type: "steer", text: "재조회부터 조사" });
  assert.equal(pending.pendingDirection, "재조회부터 조사");
  assert.equal(pending.appliedDirection, null);
  assert.equal(pending.runs.a.phase, "requested");
  assert.equal(pending.runs.b.phase, "running");
  assert.equal(pending.shared.at(-1)?.kind, "방향 수정");
  assert.ok(!pending.shared.some((event) => event.text.includes("비공개 고민")));
  const ack = reduce(pending, { type: "ack", run: "a" });
  assert.equal(ack.appliedDirection, null);
  const terminal = reduce(ack, { type: "terminal", run: "a", outcome: "interrupted" });
  assert.equal(terminal.appliedDirection, "재조회부터 조사");
  assert.equal(terminal.pendingDirection, null);
  assert.equal(terminal.interventions[0].status, "applied");
});

test("should distinguish pause acknowledgement from terminal state", () => {
  for (const outcome of ["completed", "failed", "interrupted"] as Outcome[]) {
    const requested = reduce(room(), { type: "pause-room" });
    assert.equal(requested.runs.a.phase, "requested");
    assert.equal(pauseStatus(requested), "waiting");
    const ack = reduce(requested, { type: "ack", run: "a" });
    assert.equal(ack.runs.a.phase, "acknowledged");
    assert.equal(pauseStatus(ack), "waiting");
    const unknown = reduce(ack, { type: "unknown", run: "a" });
    assert.equal(unknown.runs.a.phase, "unknown");
    assert.equal(pauseStatus(unknown), "waiting");
    const terminal = reduce(unknown, { type: "terminal", run: "a", outcome });
    assert.equal(terminal.runs.a.outcome, outcome);
    assert.equal(terminal.runs.a.phase, "terminal");
    assert.equal(pauseStatus(terminal), "waiting");
    assert.equal(reduce(terminal, { type: "unknown", run: "a" }), terminal);
    assert.equal(reduce(terminal, { type: "ack", run: "a" }), terminal);
  }
});

test("should stop only the owned ai and await all room terminals", () => {
  let state = reduce(room(), { type: "stop-own" });
  assert.equal(state.runs.a.phase, "requested");
  assert.equal(state.runs.b.phase, "running");
  assert.equal(state.pauseRequested, false);
  state = reduce(state, { type: "terminal", run: "a", outcome: "completed" });
  state = reduce(state, { type: "pause-room" });
  assert.equal(state.runs.a.outcome, "completed");
  assert.equal(state.runs.b.phase, "requested");
  state = reduce(state, { type: "ack", run: "b" });
  assert.equal(pauseStatus(state), "waiting");
  state = reduce(state, { type: "unknown", run: "b" });
  assert.equal(pauseStatus(state), "waiting");
  state = reduce(state, { type: "terminal", run: "b", outcome: "failed" });
  assert.equal(pauseStatus(state), "complete");
  assert.equal(state.runs.a.outcome, "completed");
  assert.equal(state.runs.b.outcome, "failed");
});

test("should reject writing actions in observer mode", () => {
  const observer = reduce(initialState(), { type: "observe" });
  assert.equal(observer.role, "observer");
  assert.ok(observer.shared.length > 0);
  assert.equal(observer.draft, null);
  const actions: Action[] = [
    { type: "create", setup: exampleSetup }, { type: "observe" },
    { type: "speak", text: "write" }, { type: "explain", text: "write", targetId: 1 },
    { type: "publish-private", explanationId: 1, part: "answer" }, { type: "steer", text: "write" },
    { type: "check-draft" }, { type: "finalize-draft" }, { type: "stop-own" }, { type: "pause-room" },
    { type: "ack", run: "a" }, { type: "unknown", run: "a" },
    { type: "terminal", run: "a", outcome: "completed" }, { type: "replay-event" },
    { type: "propose-result" }, { type: "decide", decision: "해결" },
  ];
  for (const action of actions) assert.equal(reduce(observer, action), observer, action.type);
});

test("should record a human decision without inventing validation evidence", () => {
  const before = room();
  const result = reduce(before, { type: "propose-result" });
  assert.equal(result.decision, null);
  assert.deepEqual(result.runs, before.runs);
  assert.ok(result.result?.tasks.every((task) => task.owner && task.evidence && task.nextValidation));
  for (const decision of ["해결", "추가 조사", "보류"] as const) {
    const state = reduce(result, { type: "decide", decision });
    assert.equal(state.decision, decision);
    assert.equal(state.shared.at(-1)?.kind, "사람 결정");
    assert.equal(state.shared.at(-1)?.sender, "사람");
    assert.deepEqual(state.result, result.result);
    assert.deepEqual(state.runs, before.runs);
  }
  const replay = reduce(before, { type: "replay-event" });
  assert.equal(replay.shared.at(-1)?.kind, "답변");
  assert.equal(replay.decision, null);
  assert.equal(reduce(reduce(before, { type: "pause-room" }), { type: "replay-event" }).shared.length, before.shared.length);
});
