import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";
import * as presentation from "../../src/features/investigation-coordinator/chat-presentation.ts";
import type { HistoryPage } from "../../src/features/investigation-coordinator/contracts.ts";
const page = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"))
  .history as HistoryPage;
function component(
  file: string,
  name: string,
  dependencies: Record<string, unknown> = presentation,
): ComponentType<Record<string, unknown>> {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(
    readFileSync(`src/features/investigation-coordinator/${file}.tsx`, "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    },
  ).outputText;
  runInNewContext(
    code,
    {
      exports,
      require(id: string) {
        if (id === "react/jsx-runtime") return jsxRuntime;
        if (id === "./chat-presentation") return dependencies;
        if (id === "./run-source-view")
          return { RunSourceView: () => createElement("span", null, "저장소·자료") };
        if (id.endsWith("/avatar")) return { Avatar: "div", AvatarFallback: "span" };
        if (id.endsWith("/badge")) return { Badge: "span" };
        if (id.endsWith("/button")) return { Button: "button" };
        throw new Error(`Unexpected presentation dependency ${id}`);
      },
    },
    { timeout: 1000 },
  );
  return exports[name] as ComponentType<Record<string, unknown>>;
}
function timeline(
  overrides: Record<string, unknown> = {},
  dependencies: Record<string, unknown> = presentation,
) {
  return renderToStaticMarkup(
    createElement(component("chat-timeline", "ChatTimeline", dependencies), {
      ...page,
      historicalRuns: [],
      labels: {},
      scrollRef: { current: null },
      onScroll() {},
      unread: false,
      onLatest() {},
      onAccessLost() {},
      observedAt: Date.parse(page.runs[0].updatedAt),
      now: Date.parse(page.runs[0].updatedAt),
      role: "participant",
      ...overrides,
    }),
  );
}
test("should render a system explanation inline without the duplicate human-input badge", () => {
  const required = {
    ...page.events[0],
    sequence: 13,
    eventId: "system-event",
    kind: "HUMAN_INPUT_REQUIRED",
    senderKind: "SYSTEM",
    senderAlias: "조정기",
    publicText: "",
    requestId: null,
    questionId: null,
    agentId: null,
    bindingEpoch: null,
    adoption: "HUMAN_INPUT_REQUIRED",
  };
  const html = timeline({ events: [required], runs: [] });
  assert.match(html, /시스템/);
  assert.match(html, /#13/);
  assert.match(html, /정확한 사유.*기록되지/);
  assert.match(html, /같은 질문.*상태/);
  assert.match(html, /소유자.*Mac.*터미널/);
  assert.equal((html.match(/사람 확인 필요/g) ?? []).length, 1);
});
test("should render a question recipient and unknown evidence without a loading indicator", () => {
  const html = timeline({ runs: [{ ...page.runs[0], state: "UNKNOWN" }] });
  assert.match(html, /소유자 · 공개 세션/);
  assert.match(html, /질문 #1/);
  assert.match(html, /실행 결과 확인 필요/);
  assert.match(html, /성공.*중단.*확인되지/);
  assert.doesNotMatch(html, /animate-spin/);
  assert.match(html, /저장소·자료/);
});
test("should render motion only for fresh active states and preserve known state during gaps", () => {
  const active = timeline();
  assert.match(active, /질문 접수 · AI 응답 대기/);
  assert.match(active, /motion-reduce:animate-none/);
  const stale = timeline({ gap: true });
  assert.match(stale, /상태 갱신 지연\/확인 불가/);
  assert.match(stale, /질문 접수 · AI 응답 대기/);
  assert.match(stale, /마지막 상태 보고/);
  assert.doesNotMatch(stale, /animate-spin/);
});
test("should render connection settings for the target owner and owner-check guidance for others", () => {
  for (const role of ["owner", "participant", "observer"]) {
    const html = timeline({
      role,
      bindings: [{ ...page.bindings[0], owned: true }],
      runs: [{ ...page.runs[0], state: "UNKNOWN" }],
    });
    assert.equal(html.includes('href="/app/connections"'), role !== "observer");
    assert.match(html, /터미널/);
    assert.doesNotMatch(html, /확인 완료|승인/);
  }
});

test("should render cancellation beside an archived agent question with no summary or answer", () => {
  const queued = {
    ...page.events[0],
    eventId: "peer-queued",
    sequence: 20,
    kind: "RUN_STATE",
    senderKind: "AGENT",
    senderAlias: "저장된 수신 세션",
    questionId: null,
    publicText: "",
    runState: "QUEUED",
    adoption: "NONE",
  };
  const question = {
    ...page.events[0],
    eventId: "origin-question",
    sequence: 21,
    senderKind: "AGENT",
    senderAlias: "원래 질문 세션",
    requestId: "origin-request",
    agentId: "origin-agent",
    bindingEpoch: 7,
    requestKind: "ORIGIN",
  };
  const cancelled = { ...queued, eventId: "peer-cancelled", sequence: 30, runState: "CANCELLED" };
  const html = timeline({ runs: [], events: [queued, question, cancelled], bindings: [] });
  assert.match(html, /질문 #21 답변 상태/);
  assert.match(html, /시작 전 취소/);
  assert.match(html, /저장된 수신 세션/);
  assert.doesNotMatch(html, /이 질문의 대상 실행 상태를 확인할 기록이 없습니다/);
});

test("should render the supplied shared projection without recalculating history", () => {
  const shared = presentation.answerStatuses({
    ...page,
    observedAt: Date.parse(page.runs[0].updatedAt),
    now: Date.parse(page.runs[0].updatedAt),
    role: "participant",
  });
  const html = timeline(
    { presentation: shared },
    {
      ...presentation,
      answerStatuses: () =>
        assert.fail("Shared room projection should not be recalculated by the timeline"),
    },
  );
  assert.match(html, /질문 접수 · AI 응답 대기/);
  assert.match(html, /마지막 상태 보고/);
  assert.ok(html.includes(page.runs[0].updatedAt));
});
