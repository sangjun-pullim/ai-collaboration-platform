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
import { ChatMarkdown } from "../helpers/chat-markdown-renderer.ts";
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
        if (id === "./chat-markdown") return { ChatMarkdown };
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

test("should retain terminal execution evidence without a question as a collapsible conversation record", () => {
  const paired = JSON.parse(
    readFileSync("tests/fixtures/workflow-contracts.json", "utf8"),
  ).cases.find((entry: { action: string }) => entry.action === "read").response as HistoryPage;
  for (const [state, label] of [
    ["COMPLETED", "답변 완료"],
    ["FAILED", "답변 실패"],
    ["INTERRUPTED", "중단 확인"],
    ["CANCELLED", "시작 전 취소"],
  ] as const) {
    const html = timeline({
      ...paired,
      events: [],
      runs: [{ ...paired.runs[0], state }],
    });
    assert.match(html, new RegExp(`${label} · 실행 기록`));
    assert.match(html, /<details/);
    assert.match(html, /마지막 상태 보고/);
    assert.ok(html.includes(paired.runs[0].updatedAt));
    assert.doesNotMatch(html, /animate-spin/);
  }
  assert.doesNotMatch(
    timeline({ ...paired, events: [], runs: [{ ...paired.runs[0], state: "RUNNING" }] }),
    /실행 기록/,
  );
});

for (const senderKind of ["HUMAN", "AGENT"] as const) {
  test(`should render Markdown in ordinary ${senderKind} messages while retaining metadata and sources`, () => {
    const html = timeline({
      events: [
        {
          ...page.events[0],
          kind: "SPEECH",
          senderKind,
          publicText: "## 결과\n\n**확인됨**\n\n- 첫 항목\n- 둘째 항목",
        },
      ],
      runs: [],
    });
    assert.match(html, /<h2[^>]*>결과<\/h2>/);
    assert.match(html, /<strong>확인됨<\/strong>/);
    assert.match(html, /<ul[^>]*>/);
    assert.match(html, /<li[^>]*>첫 항목<\/li>/);
    assert.match(html, /#1/);
    if (senderKind === "AGENT") assert.match(html, /저장소·자료/);
  });
}

function markdown(text: string) {
  return renderToStaticMarkup(createElement(ChatMarkdown, { text, messageId: "test-message" }));
}

test("should render headings lists quotes code and GFM using the actual Markdown renderer", () => {
  const html = markdown(
    [
      "# 제목",
      "",
      "## 둘째 제목",
      "",
      "### 셋째 제목",
      "",
      "#### 넷째 제목",
      "",
      "##### 다섯째 제목",
      "",
      "###### 여섯째 제목",
      "",
      "**굵게**와 *기울임* 및 ~~삭제~~, `inlineCode`",
      "",
      "> 인용",
      "",
      "1. 번호 항목",
      "2. 다음 항목",
      "",
      "- 일반 항목",
      "- [x] 완료",
      "- [ ] 대기",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "| 이름 | 값 |",
      "| --- | --- |",
      "| 항목 | 1 |",
    ].join("\n"),
  );
  for (let level = 1; level <= 6; level++) assert.match(html, new RegExp(`<h${level}[^>]*>`));
  assert.match(html, /<strong>굵게<\/strong>/);
  assert.match(html, /<em>기울임<\/em>/);
  assert.match(html, /<del>삭제<\/del>/);
  assert.match(html, /<code>inlineCode<\/code>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<ul/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);
  assert.match(html, /disabled=""/);
  assert.match(html, /checked=""/);
  assert.match(html, /<pre[^>]*><code class="language-ts">const value = 1;\n<\/code><\/pre>/);
  assert.match(html, /<table[^>]*>/);
  assert.match(html, /<th>이름<\/th>/);
  assert.match(html, /<td>항목<\/td>/);
});

test("should preserve ordinary line breaks and escape literal code", () => {
  const html = markdown("첫 줄\n둘째 줄\n\n`<img src=x onerror=alert(1)>`");
  assert.match(html, /<p>첫 줄\n둘째 줄<\/p>/);
  assert.match(html, /whitespace-pre-wrap/);
  assert.match(html, /<code>&lt;img src=x onerror=alert\(1\)&gt;<\/code>/);
  assert.doesNotMatch(html, /<img/);
});

for (const url of [
  "https://example.com/path?q=1#evidence",
  "http://example.com",
  "HTTPS://example.com",
  "mailto:team@example.com",
]) {
  test(`should allow ${url} with a protected new tab`, () => {
    const html = markdown(`[근거](${url})`);
    assert.ok(html.includes(`href="${url}"`));
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });
}

test("should navigate a same-page fragment without opening a new tab", () => {
  const html = markdown("[각주](#evidence)");
  assert.match(html, /href="#evidence"/);
  assert.doesNotMatch(html, /target=|rel=/);
});

for (const url of [
  "javascript:alert%281%29",
  "JaVaScRiPt:alert%281%29",
  "data:text/html,payload",
  "file:///etc/passwd",
  "vscode://file/repo",
  "ftp://example.com",
  "src/main.ts",
  "./src/main.ts",
  "../secret",
  "/app/admin",
  "//example.com",
  "%6aavascript:alert%281%29",
  "http://",
  "https:example.com",
]) {
  test(`should keep the label without navigation for ${url}`, () => {
    const html = markdown(`[차단 링크](${url})`);
    assert.match(html, /차단 링크/);
    assert.doesNotMatch(html, /<a\b|href=/);
  });
}

test("should skip raw HTML and render images as labels without network resources", () => {
  const html = markdown(
    [
      '<script>alert("unsafe")</script>',
      "",
      '<img src="https://example.com/pixel" onerror="alert(1)">',
      "",
      '<iframe src="https://example.com"></iframe>',
      "",
      'safe <b onclick="alert(1)">label</b>',
      "",
      "![설명](https://example.com/image.png)",
      "",
      "![](data:image/png;base64,AAAA)",
      "",
      "![추적](//example.com/pixel)",
    ].join("\n"),
  );
  assert.match(html, /safe label/);
  assert.match(html, /\[이미지: 설명\]/);
  assert.match(html, /\[이미지: 이미지\]/);
  assert.match(html, /\[이미지: 추적\]/);
  assert.doesNotMatch(html, /<script|<img|<iframe|<b\b|onerror=|onclick=|src=|<link/);
  assert.doesNotMatch(html, /example\.com|base64/);
});

test("should contain long fenced code and tables in message-local scroll containers", () => {
  const long = "x".repeat(1000);
  const html = markdown(`\`\`\`\n${long}\n\`\`\`\n\n| value |\n| --- |\n| ${long} |`);
  assert.match(html, /<pre class="[^"]*max-w-full[^"]*overflow-x-auto[^"]*whitespace-pre/);
  assert.match(html, /<div class="min-w-0 max-w-full overflow-x-auto"><table/);
  assert.equal((html.match(new RegExp(long, "g")) ?? []).length, 2);
});

function footnoteMarkup(html: string) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const anchors = [...html.matchAll(/<a\b([^>]*)>/g)].map((match) => {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attribute) => [
        attribute[1],
        attribute[2],
      ]),
    );
    return attributes;
  });
  return { ids, anchors };
}

function assertFootnoteRoundTrip(html: string) {
  const { ids, anchors } = footnoteMarkup(html);
  const references = anchors.filter((anchor) => "data-footnote-ref" in anchor);
  const returns = anchors.filter((anchor) => "data-footnote-backref" in anchor);
  assert.equal(references.length, 2);
  assert.equal(returns.length, 2);
  assert.equal(new Set(ids).size, ids.length);
  for (const anchor of [...references, ...returns]) {
    assert.ok(anchor.href.startsWith("#"));
    assert.ok(ids.includes(anchor.href.slice(1)), `Missing footnote target ${anchor.href}`);
    assert.equal(anchor.target, undefined);
  }
  for (const reference of references) {
    assert.ok(reference.id, "A footnote reference must preserve its generated anchor ID");
    assert.ok(returns.some((back) => back.href === `#${reference.id}`));
    assert.ok(ids.includes(reference["aria-describedby"]));
    assert.match(html, new RegExp(`<h2[^>]*id="${reference["aria-describedby"]}"`));
  }
  for (const back of returns) assert.ok(back["aria-label"]);
  return { ids, anchors };
}

const repeatedFootnote = "첫 근거[^note]와 다시 참조[^note]\n\n[^note]: 각주 내용";

test("should retain generated footnote IDs and accessible round-trip links within one message", () => {
  assertFootnoteRoundTrip(markdown(repeatedFootnote));
});

test("should isolate every footnote ID and accessible label between two messages", () => {
  const html = timeline({
    events: ["message-one", "message-two"].map((eventId, index) => ({
      ...page.events[0],
      eventId,
      sequence: index + 1,
      kind: "SPEECH",
      senderKind: "HUMAN",
      publicText: repeatedFootnote,
    })),
    runs: [],
  });
  const bodies = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map(
    (match) => match[1],
  );
  assert.equal(bodies.length, 2);
  const allIds = bodies.flatMap((body) => footnoteMarkup(body).ids);
  assert.equal(
    new Set(allIds).size,
    allIds.length,
    "Messages must not share any footnote or label ID",
  );
  const messages = bodies.map(assertFootnoteRoundTrip);
  for (const [index, message] of messages.entries()) {
    const otherIds = messages[1 - index].ids;
    for (const anchor of message.anchors) {
      assert.ok(!otherIds.includes(anchor.href.slice(1)));
      if (anchor["aria-describedby"]) assert.ok(!otherIds.includes(anchor["aria-describedby"]));
    }
  }
});

test("should retain stable footnote IDs when the same message is rendered again", () => {
  const first = footnoteMarkup(markdown(repeatedFootnote));
  const again = footnoteMarkup(markdown(repeatedFootnote));
  assert.deepEqual(again, first);
});
