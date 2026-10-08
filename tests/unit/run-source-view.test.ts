import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  WorkflowError,
  type Body,
  type PublicBinding,
} from "../../src/features/investigation-coordinator/contracts.ts";
import * as sourceContracts from "../../src/features/investigation-coordinator/source-contracts.ts";
import {
  SourceViewController,
  type SourceRequest,
} from "../../src/features/investigation-coordinator/source-view-controller.ts";

import { callInvestigation } from "../../src/features/investigation-coordinator/investigation-client.ts";

import * as presentation from "../../src/features/investigation-coordinator/chat-presentation.ts";

const roomId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const otherId = "00000000-0000-4000-8000-000000000003";
const hash = "a".repeat(64);
const at = "2026-10-06T00:00:00.000Z";
const target: sourceContracts.SourceTarget = {
  requestId: otherId,
  agentId: otherId,
  bindingEpoch: 1,
  ownerAlias: "예약 당시 사람",
  sessionAlias: "예약 당시 세션",
  repositoryAlias: "예약 당시 저장소",
  runtime: "claude",
  reservedAt: at,
};
function row(index: number): sourceContracts.SourceFileRow {
  return {
    index,
    phase: "REPOSITORY",
    callIndex: 0,
    excerptIndex: index,
    tool: "search_workspace",
    resultHash: hash,
    questionOperationId: null,
    pathJson: JSON.stringify("src/repeated.ts"),
    hash,
    readAt: at,
    byteStart: index * 8,
    byteEnd: index * 8 + 8,
    excerptHash: hash,
    lineCount: null,
    requestedStartLine: null,
    requestedEndLine: null,
  };
}
function page(start = 0, count = 2, total = 5): sourceContracts.SourceReadPage {
  return {
    version: 2,
    roomId,
    eventId,
    state: "CONFIRMED",
    target: { ...target },
    manifestHash: hash,
    summary: {
      readMode: "AUTO_CODE",
      input: {
        version: 1,
        kind: "INPUT_SOURCE_OBSERVATION",
        git: {
          observedAt: at,
          commit: null,
          refJson: JSON.stringify("branch/main"),
          dirty: "unknown",
        },
        files: { validatedAt: at, pathBase: "SELECTED_ROOT", entryCount: 0, manifestHash: hash },
        observationHash: hash,
      },
      callCount: 2,
      repositoryCallCount: 2,
      peerCallCount: 0,
      listCallCount: 1,
      fileCount: total,
    },
    files: Array.from({ length: count }, (_, index) => row(start + index)),
    nextIndex: start + count < total ? start + count - 1 : null,
  };
}
function absent(state: "NO_SOURCE" | "NO_TARGET_SNAPSHOT"): sourceContracts.SourceReadPage {
  return {
    version: 2,
    roomId,
    eventId,
    state,
    target: state === "NO_SOURCE" ? target : null,
    manifestHash: null,
    summary: null,
    files: [],
    nextIndex: null,
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("should read only the opened immutable event and explicit next pages shorter than four rows", async () => {
  const calls: Body[] = [];
  const controller = new SourceViewController(
    roomId,
    eventId,
    async (action, body) => {
      assert.equal(action, "source-read");
      calls.push(body);
      return body.afterIndex === null ? page() : body.afterIndex === 1 ? page(2) : page(4, 1);
    },
    () => assert.fail("Unexpected access loss"),
  );
  assert.equal(calls.length, 0);
  await controller.open();
  await controller.open();
  assert.equal(calls.length, 1);
  assert.equal(controller.getSnapshot().page!.files.length, 2);
  await controller.next();
  await controller.next();
  await controller.next();
  assert.deepEqual(
    calls.map((call) => call.afterIndex),
    [null, 1, 3],
  );
  assert.ok(calls.every((call) => call.roomId === roomId && call.eventId === eventId));
  assert.equal(controller.getSnapshot().page!.files.length, 5);
  assert.equal(new Set(controller.getSnapshot().page!.files.map((file) => file.pathJson)).size, 1);
  assert.deepEqual(
    controller.getSnapshot().page!.files.map((file) => file.byteStart),
    [0, 8, 16, 24, 32],
  );
  controller.close();
  await controller.open();
  assert.equal(calls.length, 3);
  controller.stop();
});

test("should reject changed page identity metadata and cursor without adopting any new rows", async (t) => {
  const changes: [string, (value: sourceContracts.SourceReadPage) => unknown][] = [
    ["room", (value) => ({ ...value, roomId: otherId })],
    ["event", (value) => ({ ...value, eventId: otherId })],
    ["hash", (value) => ({ ...value, manifestHash: "b".repeat(64) })],
    ["target", (value) => ({ ...value, target: { ...target, repositoryAlias: "변경된 저장소" } })],
    ["summary", (value) => ({ ...value, summary: { ...value.summary!, listCallCount: 0 } })],
    ["cursor skip", () => page(3, 1)],
    ["cursor replay", () => page(0, 2)],
    ["empty intermediate", () => page(2, 0)],
    ["cursor not last index", (value) => ({ ...value, nextIndex: 2 })],
    ["over four rows", () => page(0, 5)],
    ["state", () => absent("NO_SOURCE")],
  ];
  for (const [name, change] of changes)
    await t.test(name, async () => {
      let count = 0;
      const controller = new SourceViewController(
        roomId,
        eventId,
        async () => (count++ === 0 ? page() : change(page(2))),
        () => assert.fail(),
      );
      await controller.open();
      await controller.next();
      assert.equal(controller.getSnapshot().error, "UNAVAILABLE");
      assert.deepEqual(
        controller.getSnapshot().page!.files.map((file) => file.index),
        [0, 1],
      );
      controller.stop();
    });
  for (const invalid of [page(1), page(0, 0)]) {
    const controller = new SourceViewController(
      roomId,
      eventId,
      async () => invalid,
      () => assert.fail(),
    );
    await controller.open();
    assert.equal(controller.getSnapshot().page, null);
    assert.equal(controller.getSnapshot().error, "UNAVAILABLE");
    controller.stop();
  }
});

test("should cancel closed stopped and replaced-room responses even when the request ignores abort", async (t) => {
  for (const operation of ["close", "stop"] as const)
    await t.test(operation, async () => {
      const pending = deferred();
      let signal!: AbortSignal;
      let lost = 0;
      const controller = new SourceViewController(
        roomId,
        eventId,
        async (_action, _body, input) => {
          signal = input;
          return pending.promise;
        },
        () => lost++,
      );
      const opened = controller.open();
      controller[operation]();
      assert.equal(signal.aborted, true);
      pending.resolve(page());
      await opened;
      assert.equal(controller.getSnapshot().page, null);
      assert.equal(controller.getSnapshot().open, false);
      assert.equal(lost, 0);
    });
  const pending = deferred();
  let calls = 0;
  const oldRoom = new SourceViewController(
    roomId,
    eventId,
    async () => pending.promise,
    () => assert.fail(),
  );
  const opened = oldRoom.open();
  oldRoom.stop();
  const newRoom = new SourceViewController(
    otherId,
    eventId,
    async () => {
      calls++;
      return { ...absent("NO_TARGET_SNAPSHOT"), roomId: otherId };
    },
    () => assert.fail(),
  );
  await newRoom.open();
  pending.reject(new WorkflowError("FORBIDDEN"));
  await opened;
  assert.equal(calls, 1);
  assert.equal(newRoom.getSnapshot().page!.roomId, otherId);
  newRoom.stop();
});

test("should preserve partial data on transient failure and clear it on definite access loss", async (t) => {
  for (const code of ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND", "UNAVAILABLE"] as const)
    await t.test(code, async () => {
      let calls = 0,
        lost = 0;
      const controller = new SourceViewController(
        roomId,
        eventId,
        async () => {
          if (calls++ === 0) return page();
          throw new WorkflowError(code);
        },
        () => lost++,
      );
      await controller.open();
      await controller.next();
      assert.equal(lost, code === "UNAVAILABLE" ? 0 : 1);
      assert.equal(
        controller.getSnapshot().page?.files.length ?? 0,
        code === "UNAVAILABLE" ? 2 : 0,
      );
      await controller.retry();
      assert.equal(calls, code === "UNAVAILABLE" ? 3 : 2);
      controller.stop();
    });
});

test("should distinguish no historical target no source and confirmed zero-file observations", async () => {
  for (const value of [absent("NO_TARGET_SNAPSHOT"), absent("NO_SOURCE"), page(0, 0, 0)]) {
    const controller = new SourceViewController(
      roomId,
      eventId,
      async () => value,
      () => assert.fail(),
    );
    await controller.open();
    assert.equal(controller.getSnapshot().error, null);
    assert.equal(controller.getSnapshot().page!.state, value.state);
    controller.stop();
  }
});

type Element = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>): Element => ({ type, props });
function text(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node !== "object") return String(node);
  const element = node as Element;
  if (typeof element.type === "function")
    return text((element.type as (props: unknown) => unknown)(element.props));
  return text(element.props?.children);
}
function nodes(node: unknown, type: string): Element[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap((item) => nodes(item, type));
  const element = node as Element;
  return [...(element.type === type ? [element] : []), ...nodes(element.props?.children, type)];
}
function viewModule(react: unknown = {}) {
  const exports: {
    RunSourceView?: (props: unknown) => Element;
    SourceDetails?: (props: unknown) => Element;
    safeSourceText?: (value: string) => string;
  } = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/investigation-coordinator/run-source-view.tsx", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    {
      exports,
      require(name: string) {
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "react") return react;
        if (name === "./source-contracts") return sourceContracts;
        if (name === "./source-view-controller") return { SourceViewController };
        if (name === "./investigation-client")
          return { callInvestigation: () => assert.fail("Unexpected real request") };
        if (name === "../../components/ui/button") return { Button: "button" };
        throw new Error(`Unexpected source UI import ${name}`);
      },
    },
    { timeout: 1000 },
  );
  return exports;
}

test("should safely display decoded paths refs repeated excerpts and separate proof meanings", () => {
  const renderedModule = viewModule();
  const value = page();
  value.summary!.input.git.refJson = JSON.stringify("branch\t\ud800");
  value.files[0].pathJson = JSON.stringify("src/a\t\ud800.ts");
  value.files[1] = {
    ...value.files[1],
    phase: "PEER",
    callIndex: 1,
    excerptIndex: 0,
    tool: null,
    resultHash: null,
    questionOperationId: otherId,
    lineCount: 40,
    requestedStartLine: 10,
    requestedEndLine: 12,
  };
  value.summary!.peerCallCount = 1;
  value.summary!.repositoryCallCount = 1;
  const rendered = text(renderedModule.SourceDetails!({ page: value, bindings: [] }));
  for (const expected of [
    "예약 당시 저장소",
    "Claude",
    "현재 같은 연결 없음",
    "src/a\\u0009\\ud800.ts",
    "branch\\u0009\\ud800",
    "실제 도구 반환 발췌",
    "공동 질문 전 파일 검증",
    "8 이상 16 미만",
    "질문 전 확인한 바이트 범위",
    "실제 도구 반환 바이트 범위",
    "10–12",
    "미확인",
    "모델 사용",
    "질문 수락·전달",
    "빈 선택 집합",
    "목록 반환",
  ])
    assert.ok(rendered.includes(expected), expected);
  assert.equal(rendered.includes("\t"), false);
  assert.equal(rendered.includes(target.agentId), false);
  assert.equal(rendered.includes("epoch"), false);
  assert.equal(renderedModule.safeSourceText!("😀\udc00\u0000"), "😀\\udc00\\u0000");
  for (const state of ["NO_SOURCE", "NO_TARGET_SNAPSHOT"] as const) {
    const missing = text(
      renderedModule.SourceDetails!({
        page: absent(state),
        bindings: [{ repositoryAlias: "현재 값" } as PublicBinding],
      }),
    );
    assert.equal(missing.includes("현재 값"), false);
    assert.ok(
      missing.includes(
        state === "NO_SOURCE" ? "파일 관찰 자료는 없습니다" : "당시 대상이 저장되지 않은",
      ),
    );
  }
});

test("should retain one controller across parent rerenders and abort its actual request on unmount", async () => {
  const states: unknown[] = [],
    refs: { current: unknown }[] = [];
  let stateIndex = 0,
    refIndex = 0;
  let effect: (() => () => void) | undefined;
  let dependencies: unknown[] | undefined;
  let cleanup: (() => void) | undefined;
  const renderedModule = viewModule({
    useLayoutEffect(callback: () => void) {
      callback();
    },
    useRef(current: unknown) {
      const index = refIndex++;
      return refs[index] ?? (refs[index] = { current });
    },
    useState(initial: unknown) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [
        states[index],
        (value: unknown) => {
          states[index] = value;
        },
      ];
    },
    useEffect(callback: () => () => void, deps: unknown[]) {
      if (!dependencies || deps.some((value, index) => value !== dependencies![index])) {
        dependencies = deps;
        effect = callback;
      }
    },
  });
  let requests = 0,
    lost = 0;
  let signal!: AbortSignal;
  const pending = deferred();
  const render = (call: SourceRequest) => {
    stateIndex = 0;
    refIndex = 0;
    const result = renderedModule.RunSourceView!({
      roomId,
      eventId,
      bindings: [],
      onAccessLost: () => lost++,
      call,
    });
    if (effect) {
      cleanup?.();
      cleanup = effect();
      effect = undefined;
    }
    return result;
  };
  const request: SourceRequest = async (_action, _body, input) => {
    requests++;
    signal = input;
    return pending.promise;
  };
  let tree = render(request);
  assert.equal(requests, 0);
  const opened = (nodes(tree, "button")[0].props.onClick as () => Promise<void>)();
  tree = render((...args) => request(...args));
  assert.equal(requests, 1);
  assert.equal(nodes(tree, "button")[0].props["aria-expanded"], true);
  cleanup!();
  assert.equal(signal.aborted, true);
  pending.resolve(page());
  await opened;
  assert.equal((states[0] as SourceViewController).getSnapshot().page, null);
  assert.equal(lost, 0);
});

test("should compose the controller with the actual human RPC client using only mocked HTTP", async (t) => {
  let fetched = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    fetched++;
    assert.equal(url, "/api/investigations/source-read");
    assert.deepEqual(JSON.parse(options.body as string), {
      protocol: 1,
      roomId,
      eventId,
      afterIndex: null,
    });
    return new Response(JSON.stringify({ ok: true, data: page() }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const controller = new SourceViewController(roomId, eventId, callInvestigation, () =>
    assert.fail(),
  );
  await controller.open();
  assert.equal(fetched, 1);
  assert.equal(controller.getSnapshot().page!.manifestHash, hash);
  controller.stop();
});

test("should keep the last accepted cursor when a delayed next page arrives after closing", async () => {
  let requests = 0;
  let signal!: AbortSignal;
  const pending = deferred();
  const controller = new SourceViewController(
    roomId,
    eventId,
    async (_action, _body, input) => {
      signal = input;
      return requests++ === 0 ? page(0, 1, 2) : pending.promise;
    },
    () => assert.fail(),
  );
  await controller.open();
  assert.equal(controller.getSnapshot().page!.nextIndex, 0);
  const next = controller.next();
  controller.close();
  assert.equal(signal.aborted, true);
  pending.resolve(page(1, 1, 2));
  await next;
  await controller.open();
  assert.equal(requests, 2);
  assert.equal(controller.getSnapshot().page!.nextIndex, 0);
  assert.equal(controller.getSnapshot().page!.files.length, 1);
  controller.setCallbacks(
    async (_action, body) => {
      assert.equal(body.afterIndex, 0);
      return page(1, 1, 2);
    },
    () => assert.fail(),
  );
  await controller.next();
  assert.equal(controller.getSnapshot().page!.files.length, 2);
  controller.stop();
});

test("should attach historical event addresses even outside thirty-two current run summaries", () => {
  const direct = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
  const historical = {
    ...direct.history.events[0],
    roomId,
    eventId,
    kind: "ANSWER",
    senderKind: "AGENT",
    publicText: "오래된 확정 답변",
  };
  const exports: { ChatTimeline?: (props: unknown) => Element } = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/investigation-coordinator/chat-timeline.tsx", "utf8"),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
    {
      exports,
      require(name: string) {
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
        if (name === "./chat-presentation") return presentation;
        if (name === "./run-source-view") return { RunSourceView: "source-view" };
        if (name.startsWith("../../components/ui/"))
          return {
            Avatar: "avatar",
            AvatarFallback: "avatar-fallback",
            Badge: "badge",
            Button: "button",
          };
        throw new Error(`Unexpected timeline dependency ${name}`);
      },
    },
    { timeout: 1000 },
  );
  const lost = () => {};
  const rendered = exports.ChatTimeline!({
    events: [historical],
    runs: Array.from({ length: 32 }, (_, index) => ({
      ...direct.history.runs[0],
      requestId: `recent-${index}`,
    })),
    historicalRuns: [],
    bindings: [],
    labels: {},
    scrollRef: { current: null },
    unread: false,
    onLatest: () => {},
    onScroll: () => {},
    onAccessLost: lost,
  });
  const source = nodes(rendered, "source-view");
  assert.equal(source.length, 1);
  assert.equal(source[0].props.roomId, roomId);
  assert.equal(source[0].props.eventId, eventId);
  assert.equal(source[0].props.onAccessLost, lost);
  assert.equal(text(rendered).includes("저장된 대상:"), false);
});
