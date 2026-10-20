import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as diagnosticsContracts from "../../src/features/investigation-coordinator/run-diagnostics-contracts.ts";
import * as intents from "../../src/features/investigation-coordinator/direct-intents.ts";
import * as historyWindows from "../../src/features/investigation-coordinator/history-window-contracts.ts";
import {
  emptyHistory,
  mergeHistory,
  recordRetirements,
  recoverySnapshot,
} from "../../src/features/investigation-coordinator/history-state.ts";
import * as presentation from "../../src/features/investigation-coordinator/chat-presentation.ts";
import type { RoomChatController } from "../../src/features/investigation-coordinator/room-chat-controller.ts";
import { ChatMarkdown } from "../helpers/chat-markdown-renderer.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const retirementFixture = JSON.parse(
  readFileSync("tests/fixtures/retirement-contracts.json", "utf8"),
);
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function recoveryPage(
  page: contracts.HistoryPage | contracts.RecoveryHistoryPage,
): contracts.RecoveryHistoryPage {
  return "recovery" in page
    ? page
    : {
        ...page,
        recovery: {
          hasBlockingRuns: page.runs.some((run) =>
            ["QUEUED", "LEASED", "RUNNING", "UNKNOWN"].includes(run.state),
          ),
          candidate: null,
          retirements: [],
          nextRetirementCursor: 0,
          highWaterRetirementSequence: 0,
          hasMoreRetirements: false,
        },
      };
}
const source = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/investigation-view.tsx", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;
type Node = { type: unknown; props: Record<string, unknown> };
function find(node: unknown, type: string): Node | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, type);
      if (found) return found;
    }
    return;
  }
  const el = node as Node;
  if (el.type === type) return el;
  if (typeof el.type === "function") return find(el.type(el.props), type);
  return find(el.props?.children, type);
}
async function harness(
  t: TestContext,
  role: "owner" | "participant" | "observer" = "participant",
  bindings?: contracts.PublicBinding[],
) {
  let stateIndex = 0,
    refIndex = 0,
    memoIndex = 0;
  const states: unknown[] = [];
  const retirementStates: unknown[] = [];
  let retirementRendering = false;
  let retirementStateIndex = 0;
  const refs: { current: unknown }[] = [];
  const memos: unknown[] = [];
  let effects: (() => (() => void) | void)[] = [];
  let projectionCalls = 0;
  let reads = 0;
  const windowEvents = new EventTarget();
  const documentEvents = Object.assign(new EventTarget(), { hidden: false });
  const calls: { action: contracts.HumanAction; body: contracts.Body }[] = [];
  let responseFailure = false;
  let pollFailure = false;
  let cancelResult: unknown = fixture.cancelResult;
  let retireResult: unknown = retirementFixture.receipt;
  const storage = new Map<string, string>();
  const history: contracts.RecoveryHistoryPage = {
    ...fixture.history,
    events: [],
    runs: [],
    cycle: null,
    nextCursor: 0,
    highWaterSequence: 0,
    hasMore: false,
    recovery: {
      hasBlockingRuns: false,
      candidate: null,
      retirements: [],
      nextRetirementCursor: 0,
      highWaterRetirementSequence: 0,
      hasMoreRetirements: false,
    },
    bindings: bindings ?? [
      { ...fixture.history.bindings[0], validUntil: "2099-01-01T00:00:00.000Z" },
    ],
  };
  let currentPage = history;
  let controller!: RoomChatController;
  const rememberController = (value: RoomChatController) => {
    controller = value;
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const react = {
    useState(initial: unknown) {
      const index = retirementRendering ? retirementStateIndex++ : stateIndex++;
      const slots = retirementRendering ? retirementStates : states;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
      return [
        slots[index],
        (value: unknown) => {
          slots[index] = typeof value === "function" ? value(slots[index]) : value;
        },
      ];
    },
    useRef(current: unknown) {
      const index = refIndex++;
      return refs[index] ?? (refs[index] = { current });
    },
    memo: (component: unknown) => component,
    useMemo(create: () => unknown, deps: unknown[]) {
      const index = memoIndex++;
      const previous = memos[index] as { deps: unknown[]; value: unknown } | undefined;
      if (
        previous &&
        deps.length === previous.deps.length &&
        deps.every((value, i) => Object.is(value, previous.deps[i]))
      )
        return previous.value;
      const value = create();
      memos[index] = { deps, value };
      return value;
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown) {
      return getSnapshot();
    },
    useEffect(effect: () => (() => void) | void) {
      effects.push(effect);
    },
    useLayoutEffect() {},
  };
  const modules = new Map<string, Record<string, unknown>>();
  function load(name: string, path: string) {
    const known = modules.get(name);
    if (known) return known;
    const exports: Record<string, unknown> = {};
    modules.set(name, exports);
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    runInNewContext(code, { ...context, exports }, { timeout: 1000 });
    return exports;
  }
  const context = {
    require(name: string): unknown {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react") return react;
      if (name === "./room-realtime")
        return {
          RoomRealtime: class {
            start() {}
            stop() {}
          },
        };
      if (name === "./chat-session-cleanup") return { chatSessionEvent: "chat-session-cleared" };
      if (name === "./chat-outbox.ts" || name === "./chat-outbox")
        return {
          speechOutbox: null,
          outboxCleanupKey: "chat-outbox-cleanup-required",
          announceOutbox() {},
        };
      if (name === "./chat-history-cache.ts")
        return { clearChatHistory() {}, cacheChatHistory() {}, cachedChatHistory: () => null };
      if (name === "./use-virtual-history")
        return {
          useVirtualHistory: (ids: string[]) => ({
            virtualizer: { getTotalSize: () => ids.length * 220, measureElement() {} },
            items: ids.map((id, index) => ({ key: id, index, start: index * 220 })),
            jump: () => true,
          }),
        };
      if (name === "./chat-answer-status-panel")
        return {
          ChatAnswerStatusPanel: (props: {
            statuses: presentation.AnswerStatus[];
            children: unknown;
          }) =>
            jsx("section", {
              "aria-label": "AI 답변 상태",
              children: [
                props.statuses.map((status) =>
                  jsx(
                    load(
                      "./chat-timeline",
                      "src/features/investigation-coordinator/chat-timeline.tsx",
                    ).ChatAnswerStatus,
                    { status },
                  ),
                ),
                props.children,
              ],
            }),
        };
      if (["./contracts", "./contracts.ts"].includes(name)) return contracts;
      if (name === "./history-window-client")
        return {
          callHistoryWindow: () => {
            throw new Error("Unexpected history window request");
          },
        };
      if (name === "./run-diagnostics-client") return { callRunDiagnostics: undefined };
      if (name === "./run-diagnostics-contracts.ts") return diagnosticsContracts;
      if (["./history-window-contracts", "./history-window-contracts.ts"].includes(name))
        return historyWindows;
      if (["./direct-intents", "./direct-intents.ts"].includes(name)) return intents;
      if (["./history-state", "./history-state.ts"].includes(name))
        return { emptyHistory, mergeHistory, recordRetirements, recoverySnapshot };
      if (["./chat-presentation", "./chat-presentation.ts"].includes(name))
        return {
          ...presentation,
          answerStatuses: (context: presentation.AnswerStatusContext) => {
            projectionCalls++;
            return presentation.answerStatuses(context);
          },
        };
      if (["./polling-policy", "./polling-policy.ts"].includes(name))
        return { pollingDelay: () => 10_000 };
      if (name === "./investigation-client")
        return {
          callInvestigation: async (action: contracts.HumanAction, body: contracts.Body) => {
            if (action === "read-recovery") {
              reads++;
              if (pollFailure) throw new contracts.WorkflowError("UNAVAILABLE");
              const afterSequence = body.afterSequence as number;
              const events = currentPage.events.filter((event) => event.sequence > afterSequence);
              const nextCursor = events.at(-1)?.sequence ?? afterSequence;
              const highWaterSequence = Math.max(currentPage.highWaterSequence, afterSequence);
              const retirements = currentPage.recovery.retirements.filter(
                (entry) => entry.sequence > (body.afterRetirementSequence as number),
              );
              return {
                ...currentPage,
                events,
                nextCursor,
                highWaterSequence,
                hasMore: nextCursor < highWaterSequence,
                recovery: {
                  ...currentPage.recovery,
                  retirements,
                  nextRetirementCursor:
                    retirements.at(-1)?.sequence ?? body.afterRetirementSequence,
                },
              };
            }
            calls.push({ action, body });
            if (responseFailure) throw new contracts.WorkflowError("UNAVAILABLE");
            return action === "cancel"
              ? cancelResult
              : action === "retire"
                ? retireResult
                : action === "speak"
                  ? { eventId: fixture.ask.operationId, sequence: 1 }
                  : {};
          },
        };
      if (name === "./room-chat-controller") {
        const loaded = load(name, "src/features/investigation-coordinator/room-chat-controller.ts");
        const Original = loaded.RoomChatController as typeof RoomChatController;
        return {
          RoomChatController: class extends Original {
            constructor(...args: ConstructorParameters<typeof RoomChatController>) {
              super(args[0], args[1], {
                storage: () => context.sessionStorage as unknown as Storage,
                hidden: () => documentEvents.hidden,
                now: Date.now,
              });
              rememberController(this);
            }
          },
        };
      }
      if (name === "./use-room-chat")
        return load(name, "src/features/investigation-coordinator/use-room-chat.ts");
      if (name === "./request-retirement-controls") {
        const loaded = load(
          name,
          "src/features/investigation-coordinator/request-retirement-controls.tsx",
        );
        const component = loaded.RequestRetirementControls as (props: unknown) => Node;
        return {
          RequestRetirementControls: (props: unknown) => {
            retirementStateIndex = 0;
            retirementRendering = true;
            try {
              return component(props);
            } finally {
              retirementRendering = false;
            }
          },
        };
      }
      if (name === "../../components/ui/dialog")
        return {
          Dialog: (props: Record<string, unknown>) =>
            jsx("dialog", { ...props, children: props.open ? props.children : null }),
          DialogContent: "dialog-content",
          DialogTrigger: "dialog-trigger",
          DialogTitle: "h2",
          DialogDescription: "p",
        };
      if (name === "./chat-composer") return { ChatComposer: "composer" };
      if (name === "../chat-attachments/controller")
        return { useImageCapabilities: () => [], useVisibleAttachments: () => new Map() };
      if (name === "../chat-attachments/attachment-preview")
        return { AttachmentPreview: "attachment-preview" };
      if (name === "../chat-attachments/use-image-draft")
        return { useImageDraft: () => ({ draft: null, busy: false, error: null, reset() {} }) };
      if (name === "../chat-attachments/client")
        return {
          imageOnlyText: (mode: string, text: string) =>
            text.trim() ||
            (mode === "speak" ? "이미지를 첨부했습니다" : "첨부 이미지를 설명해주세요"),
        };
      if (name === "../chat-attachments/image-cache") return { clearImageCache() {} };
      if (name === "./chat-timeline")
        return {
          ...load(name, "src/features/investigation-coordinator/chat-timeline.tsx"),
          ChatTimeline: "timeline",
        };
      if (name === "./run-source-view") return { RunSourceView: "source-view" };
      if (name === "./chat-markdown") return { ChatMarkdown };
      if (name === "../../components/ui/avatar") return { Avatar: "div", AvatarFallback: "span" };
      if (name === "../../components/ui/badge") return { Badge: "span" };
      if (name === "./own-input-controls") return { OwnInputControls: "own-input-controls" };
      if (name === "./advanced-controls") return { AdvancedControls: "advanced" };
      if (name === "../room-access/chat-shell") return { ChatHeaderControls: "header-controls" };
      if (name === "../../components/ui/button") return { Button: "button" };
      throw new Error(`Unexpected UI dependency ${name}`);
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: documentEvents,
    window: windowEvents,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    AbortController,
    Date,
    FormData: class {
      constructor(private form: { text: string }) {}
      get() {
        return this.form.text;
      }
    },
  };
  const exports: { InvestigationView?: (props: unknown) => Node } = {};
  runInNewContext(source, { ...context, exports }, { timeout: 1000 });
  assert.ok(exports.InvestigationView);
  const outer = exports.InvestigationView({
    userId: fixture.ask.expectedUserId,
    roomId: fixture.ask.roomId,
    role,
  });
  function render() {
    stateIndex = 0;
    refIndex = 0;
    memoIndex = 0;
    effects = [];
    return (outer.type as (props: unknown) => Node)(outer.props);
  }
  render();
  const stop = effects[0]();
  t.after(() => stop?.());
  await controller.poll();
  return {
    render,
    renderTimeline: () => {
      const timeline = find(render(), "timeline")!;
      const component = load(
        "./chat-timeline",
        "src/features/investigation-coordinator/chat-timeline.tsx",
      ).ChatTimeline as (props: unknown) => Node;
      return component(timeline.props);
    },
    history,
    calls,
    projectionCalls: () => projectionCalls,
    reads: () => reads,
    windowEvents,
    documentEvents,
    stop: () => stop?.(),
    storage,
    controller,
    pollSucceed: () => {
      pollFailure = false;
    },
    pollFail: async () => {
      pollFailure = true;
      await controller.poll();
    },
    cancelResponse: (value: unknown) => {
      cancelResult = value;
    },
    retireResponse: (value: unknown) => {
      retireResult = value;
    },
    snapshot: async (next: contracts.HistoryPage | contracts.RecoveryHistoryPage) => {
      currentPage = recoveryPage(next);
      await controller.poll();
    },
    fail: () => {
      responseFailure = true;
    },
    succeed: () => {
      responseFailure = false;
    },
    submit: (text: string) => ({ preventDefault() {}, currentTarget: { text, reset() {} } }),
  };
}

test("should pass the current room and uncertain readiness without relaxing no-target or observer guards", async (t) => {
  const h = await harness(t, "participant", []);
  let composer = find(h.render(), "composer")!;
  assert.equal(composer.props.roomId, fixture.ask.roomId);
  assert.equal(composer.props.readinessUnconfirmed, false);
  assert.equal(composer.props.disabled, true);
  await h.pollFail();
  composer = find(h.render(), "composer")!;
  assert.equal(composer.props.readinessUnconfirmed, true);
  assert.equal(composer.props.disabled, true);
  assert.equal(h.calls.length, 0);
  const observer = await harness(t, "observer", []);
  assert.equal(find(observer.render(), "composer"), undefined);
});

test("should offer a ready owned AI and emit a shared question for its pinned epoch", async (t) => {
  const own = {
    ...fixture.history.bindings[0],
    owned: true,
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  const peer = { ...own, owned: false, agentId: uuid(99) };
  const h = await harness(t, "participant", [own, peer]);
  let composer = find(h.render(), "composer")!;
  assert.deepEqual(Array.from(composer.props.targets as contracts.PublicBinding[]), [own, peer]);
  assert.equal(composer.props.disabled, true);
  (composer.props.onTarget as (id: string) => void)(own.agentId);
  (composer.props.onDraft as (draft: string) => void)("내 AI에게 공유 질문");
  composer = find(h.render(), "composer")!;
  assert.equal(composer.props.disabled, false);
  assert.equal(
    await (composer.props.onSubmit as (event: unknown) => Promise<boolean>)(
      h.submit("내 AI에게 공유 질문"),
    ),
    true,
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "ask");
  assert.equal(h.calls[0].body.roomId, fixture.ask.roomId);
  assert.equal(h.calls[0].body.expectedUserId, fixture.ask.expectedUserId);
  assert.equal(h.calls[0].body.targetAgentId, own.agentId);
  assert.equal(h.calls[0].body.targetEpoch, own.bindingEpoch);
  assert.equal(h.calls[0].body.publicText, "내 AI에게 공유 질문");
  assert.equal(h.calls[0].body.confirmed, true);
});

test("should disable an owned target after readiness expiry or epoch replacement without sending", async (t) => {
  const own = {
    ...fixture.history.bindings[0],
    owned: true,
    validUntil: "2099-01-01T00:00:00.000Z",
  };
  const h = await harness(t, "participant", [own]);
  (find(h.render(), "composer")!.props.onDraft as (draft: string) => void)("미전송 질문");
  for (const binding of [
    { ...own, reportedReady: false },
    { ...own, validUntil: "2000-01-01T00:00:00.000Z" },
    { ...own, bindingEpoch: own.bindingEpoch + 1 },
  ]) {
    await h.snapshot({ ...h.history, bindings: [binding] });
    const composer = find(h.render(), "composer")!;
    assert.equal(composer.props.stale, true);
    assert.equal(composer.props.target, undefined);
    assert.equal(composer.props.disabled, true);
    assert.equal(composer.props.draft, "미전송 질문");
    assert.equal(
      await (composer.props.onSubmit as (event: unknown) => Promise<boolean>)(
        h.submit("미전송 질문"),
      ),
      false,
    );
  }
  assert.equal(h.calls.length, 0);
});

test("should pin the sole responder epoch and never replace an expired selection automatically", async (t) => {
  const h = await harness(t);
  let node = h.render();
  assert.ok(find(node, "composer"));
  await h.snapshot({ ...h.history, bindings: [{ ...h.history.bindings[0], bindingEpoch: 2 }] });
  node = h.render();
  assert.equal(find(node, "composer")?.props.stale, true);
  assert.equal(find(node, "composer")?.props.target, undefined);
  assert.equal(find(node, "composer")?.props.disabled, true);
  const select = find(node, "composer")!.props.onTarget as (id: string) => void;
  select(h.history.bindings[0].agentId);
  assert.equal(
    (find(h.render(), "composer")?.props.target as contracts.PublicBinding).bindingEpoch,
    2,
  );
});
test("should keep polling changes from clearing a draft or choosing another responder", async (t) => {
  const h = await harness(t);
  const composer = find(h.render(), "composer")!;
  (composer.props.onDraft as (value: string) => void)("미전송 본문");
  await h.snapshot({
    ...h.history,
    bindings: [
      { ...h.history.bindings[0], reportedReady: false },
      { ...h.history.bindings[0], agentId: "00000000-0000-4000-8000-000000000099" },
    ],
  });
  const next = find(h.render(), "composer")!;
  assert.equal(next.props.draft, "미전송 본문");
  assert.equal(next.props.stale, true);
  assert.equal(next.props.target, undefined);
});
test("should retain the unresolved exact ask and reject a fresh body until same-request confirmation", async (t) => {
  const h = await harness(t);
  let c = find(h.render(), "composer")!;
  (c.props.onDraft as (value: string) => void)(fixture.ask.publicText);
  h.fail();
  c = find(h.render(), "composer")!;
  const result = await (c.props.onSubmit as (event: unknown) => Promise<boolean>)(
    h.submit(fixture.ask.publicText),
  );
  assert.equal(result, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.confirmed, true);
  const pending = [...h.storage.values()].map((v) => JSON.parse(v)).find((v) => v.action === "ask");
  assert.ok(pending);
  assert.equal(pending.body.expectedUserId, fixture.ask.expectedUserId);
  assert.equal(pending.body.publicText, fixture.ask.publicText);
  assert.equal(pending.body.targetAgentId, fixture.ask.targetAgentId);
  assert.match(pending.body.operationId, /^[0-9a-f-]{36}$/);
  c = find(h.render(), "composer")!;
  assert.equal(c.props.pending, true);
  assert.equal(c.props.disabled, true);
  assert.equal(c.props.draft, fixture.ask.publicText);
  assert.equal(
    await (c.props.onSubmit as (event: unknown) => Promise<boolean>)(h.submit("다른 본문")),
    false,
  );
  assert.equal(h.calls.length, 1);
  function retry(node: unknown): Node | undefined {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = retry(item);
        if (found) return found;
      }
      return;
    }
    const item = node as Node;
    if (item.type === "button" && item.props.children === "같은 요청 확인") return item;
    return retry(item.props?.children);
  }
  h.succeed();
  const confirmation = retry(h.render());
  assert.ok(confirmation);
  await (confirmation.props.onClick as () => Promise<boolean>)();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body, h.calls[0].body);
  assert.equal(h.storage.size, 0);
});
test("should expose no composer or mutation controls for observers", async (t) => {
  const h = await harness(t, "observer");
  assert.equal(find(h.render(), "composer"), undefined);
  assert.equal(find(h.render(), "advanced"), undefined);
});

test("should honor an explicitly cleared selection when only one responder remains", async (t) => {
  const h = await harness(t);
  const composer = find(h.render(), "composer")!;
  (composer.props.onTarget as (id: string) => void)("");
  const cleared = find(h.render(), "composer")!;
  assert.equal(cleared.props.target, undefined);
  assert.equal(cleared.props.targetValue, "");
  assert.equal(cleared.props.disabled, true);
  await h.snapshot({ ...h.history, bindings: [{ ...h.history.bindings[0], bindingEpoch: 2 }] });
  assert.equal(find(h.render(), "composer")!.props.target, undefined);
});

test("should propagate source access loss to abort room work clear history and block further input", async (t) => {
  const h = await harness(t);
  (find(h.render(), "composer")!.props.onDraft as (value: string) => void)("차단 뒤 질문");
  const composer = find(h.render(), "composer")!;
  const timeline = find(h.render(), "timeline")!;
  await h.snapshot({ ...h.history, roomRevision: h.history.roomRevision + 1 });
  assert.equal(find(h.render(), "timeline")!.props.onAccessLost, timeline.props.onAccessLost);
  (timeline.props.onAccessLost as () => void)();
  // Owned poll and mutation aborts are verified through real requests in room-chat-controller.test.ts.
  const staleSubmit = composer.props.onSubmit as (event: unknown) => Promise<boolean>;
  assert.equal(await staleSubmit(h.submit("차단 뒤 질문")), false);
  const tree = h.render();
  assert.equal((find(tree, "timeline")!.props.events as unknown[]).length, 0);
  assert.equal(find(tree, "composer"), undefined);
  assert.equal(h.calls.length, 0);
});

function visibleText(node: unknown): string {
  if (Array.isArray(node)) return node.map(visibleText).join(" ");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  const element = node as Node;
  if (typeof element.type === "function") return visibleText(element.type(element.props));
  return visibleText(element.props?.children);
}
function labeled(node: unknown, label: string): Node | undefined {
  if (Array.isArray(node)) return node.map((child) => labeled(child, label)).find(Boolean);
  if (!node || typeof node !== "object") return;
  const element = node as Node;
  if (element.props?.["aria-label"] === label) return element;
  if (typeof element.type === "function") return labeled(element.type(element.props), label);
  return labeled(element.props?.children, label);
}
function buttonText(node: unknown, text: RegExp): Node | undefined {
  if (Array.isArray(node)) return node.map((child) => buttonText(child, text)).find(Boolean);
  if (!node || typeof node !== "object") return;
  const element = node as Node;
  if (element.type === "button" && text.test(visibleText(element))) return element;
  if (typeof element.type === "function") return buttonText(element.type(element.props), text);
  return buttonText(element.props?.children, text);
}
test("should disable an already requested UNKNOWN direct question after deadline with offline target", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  const requested = {
    ...page.events[0],
    eventId: uuid(101),
    sequence: 2,
    kind: "INTERRUPT_REQUESTED" as const,
    senderKind: "AGENT" as const,
    publicText: "",
    questionId: null,
    replyTo: null,
    adoption: "NONE" as const,
  };
  await h.snapshot({
    ...page,
    events: [...page.events, requested],
    runs: [{ ...page.runs[0], state: "UNKNOWN" }],
    nextCursor: 2,
    highWaterSequence: 2,
  });
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.match(visibleText(region), /중단.*종료 확인 대기/);
  assert.match(visibleText(region), /서버.*접수/);
  assert.match(visibleText(region), /실제 실행 종료를 뜻하지/);
  assert.match(visibleText(region), /소유자.*Mac.*기존.*터미널/);
  assert.match(visibleText(region), /기한이 지났/);
  assert.equal(buttonText(region, /중단 요청 접수/)?.props.disabled, true);
  assert.equal(h.calls.length, 0);
});
test("should show server receipt immediately before polling and keep it on poll failure", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "UNKNOWN" }] });
  await (
    buttonText(labeled(h.render(), "AI 답변 상태"), /이 직접 질문 중단 요청/)!.props
      .onClick as () => Promise<boolean>
  )();
  for (let i = 0; i < 2; i++) {
    const region = labeled(h.render(), "AI 답변 상태")!;
    assert.match(visibleText(region), /서버.*접수/);
    assert.match(visibleText(region), /종료 확인 대기/);
    assert.equal(buttonText(region, /중단 요청 접수/)?.props.disabled, true);
    assert.doesNotMatch(visibleText(region), /중단 확인되었습니다|중단 성공/);
    await h.pollFail();
  }
  assert.equal(h.calls.length, 1);
});
test("should distinguish a sending cancel from server acceptance until the response arrives", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "RUNNING" }] });
  let resolve!: (value: unknown) => void;
  h.cancelResponse(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const sending = (
    buttonText(h.render(), /이 직접 질문 중단 요청/)!.props.onClick as () => Promise<boolean>
  )();
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.equal(buttonText(region, /중단 요청 전송 중/)?.props.disabled, true);
  assert.doesNotMatch(visibleText(region), /서버.*접수|Mac.*수신 확인/);
  resolve(fixture.cancelResult);
  assert.equal(await sending, true);
  assert.match(visibleText(labeled(h.render(), "AI 답변 상태")), /서버.*접수/);
});
test("should keep uncertain cancel on the same operation without a fake receipt", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "RUNNING" }] });
  h.fail();
  await (
    buttonText(h.render(), /이 직접 질문 중단 요청/)!.props.onClick as () => Promise<boolean>
  )();
  const first = h.calls[0].body;
  assert.match(visibleText(labeled(h.render(), "AI 답변 상태")), /전송 결과 미확정/);
  assert.doesNotMatch(
    visibleText(labeled(h.render(), "AI 답변 상태")),
    /서버.*접수|Mac.*수신 확인/,
  );
  h.succeed();
  await (buttonText(h.render(), /같은 요청 확인/)!.props.onClick as () => Promise<boolean>)();
  assert.deepEqual(h.calls[1].body, first);
  assert.match(visibleText(labeled(h.render(), "AI 답변 상태")), /서버.*접수/);
});
test("should show authoritative no active run receipt without inventing terminal answer state", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "UNKNOWN" }] });
  h.cancelResponse({ state: "NO_ACTIVE_RUN", controlId: null, requestId: null });
  await (
    buttonText(h.render(), /이 직접 질문 중단 요청/)!.props.onClick as () => Promise<boolean>
  )();
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.match(visibleText(region), /서버.*중단할 활성 실행이 없/);
  assert.match(visibleText(region), /실행 결과 확인 필요/);
  assert.equal(buttonText(region, /활성 실행 없음/)?.props.disabled, true);
});
test("should show Mac acknowledgement as pending termination and never enable another cancel", async (t) => {
  const h = await harness(t, "owner");
  const page = fixture.history as contracts.HistoryPage;
  const ack = {
    ...page.events[0],
    eventId: uuid(102),
    sequence: 2,
    kind: "INTERRUPT_ACKNOWLEDGED" as const,
    senderKind: "AGENT" as const,
    publicText: "",
    questionId: null,
    replyTo: null,
    adoption: "NONE" as const,
  };
  await h.snapshot({
    ...page,
    events: [...page.events, ack],
    runs: [{ ...page.runs[0], state: "UNKNOWN" }],
    bindings: [{ ...page.bindings[0], owned: true }],
    nextCursor: 2,
    highWaterSequence: 2,
  });
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.match(visibleText(region), /대상 Mac.*수신.*확인/);
  assert.match(visibleText(region), /내 Mac.*기존.*터미널/);
  assert.match(visibleText(region), /종료 확인 대기/);
  assert.equal(buttonText(region, /중단 요청 수신 확인/)?.props.disabled, true);
  assert.equal(h.calls.length, 0);
});
test("should ignore another historical cycle interruption when controlling the current question", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  const ack = {
    ...page.events[0],
    eventId: uuid(102),
    sequence: 2,
    kind: "INTERRUPT_ACKNOWLEDGED" as const,
    senderKind: "AGENT" as const,
    publicText: "",
    questionId: null,
    replyTo: null,
    adoption: "NONE" as const,
    requestId: uuid(201),
    cycleId: uuid(202),
  };
  await h.snapshot({
    ...page,
    events: [...page.events, ack],
    runs: [{ ...page.runs[0], state: "UNKNOWN" }],
    nextCursor: 2,
    highWaterSequence: 2,
  });
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.equal(buttonText(region, /이 직접 질문 중단 요청/)?.props.disabled, false);
  assert.doesNotMatch(visibleText(region), /중단 요청.*접수|Mac.*수신 확인/);
});
test("should clear immediate receipt on source access loss", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "UNKNOWN" }] });
  await (
    buttonText(h.render(), /이 직접 질문 중단 요청/)!.props.onClick as () => Promise<boolean>
  )();
  (find(h.render(), "timeline")!.props.onAccessLost as () => void)();
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
  assert.equal(buttonText(h.render(), /중단/), undefined);
});
for (const role of ["owner", "participant", "observer"] as const) {
  test(`should show target progress and confirmed terminal guidance to ${role}`, async (t) => {
    const h = await harness(t, role);
    const page = fixture.history as contracts.HistoryPage;
    await h.snapshot({
      ...page,
      runs: [{ ...page.runs[0], state: "RUNNING" }],
      bindings: [{ ...page.bindings[0], owned: role === "owner" }],
    });
    const status = labeled(h.render(), "AI 답변 상태");
    assert.ok(status);
    assert.match(visibleText(status), /소유자 · 공개 세션/);
    assert.match(visibleText(status), /질문 #\s*1.*한글 직접 질문/);
    assert.match(visibleText(status), /답변 생성 중/);
    await h.snapshot({
      ...page,
      runs: [{ ...page.runs[0], state: "INTERRUPTED" }],
      bindings: [{ ...page.bindings[0], owned: role === "owner" }],
      cycle: { ...page.cycle!, canInterrupt: false } as contracts.DirectCycleSummary,
    });
    assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
    const terminal = labeled(h.renderTimeline(), "질문 #1 답변 상태")!;
    assert.match(visibleText(terminal), /중단 확인/);
    assert.match(visibleText(terminal), /터미널/);
    assert.match(visibleText(terminal), /새 질문/);
    assert.equal(
      find(terminal, "a")?.props.href,
      role === "owner" ? "/app/connections" : undefined,
    );
    if (role === "observer") assert.equal(find(h.render(), "button"), undefined);
    assert.equal(h.calls.length, 0);
  });
}
test("should keep the current answer visible despite an older terminal cycle and preserve cancel identity", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({
    ...page,
    runs: [
      { ...page.runs[0], requestId: uuid(301), cycleId: uuid(302), state: "COMPLETED" },
      { ...page.runs[0], state: "RUNNING" },
    ],
  });
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.match(visibleText(region), /답변 생성 중/);
  assert.doesNotMatch(visibleText(region), /답변 완료/);
  function cancel(node: unknown): Node | undefined {
    if (Array.isArray(node)) return node.map(cancel).find(Boolean);
    if (!node || typeof node !== "object") return;
    const el = node as Node;
    if (el.type === "button" && el.props.children === "이 직접 질문 중단 요청") return el;
    return cancel(el.props?.children);
  }
  const button = cancel(region)!;
  assert.ok(button);
  await (button.props.onClick as () => Promise<boolean>)();
  assert.equal(h.calls[0].action, "cancel");
  assert.equal(h.calls[0].body.requestId, page.runs[0].requestId);
});
test("should leave the conversation space available when observers have no current answer", async (t) => {
  const h = await harness(t, "observer");
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
  assert.equal(find(h.render(), "composer"), undefined);
});

test("should hide idle and terminal panels while preserving every terminal in its question history", async (t) => {
  const h = await harness(t);
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
  const page = fixture.history as contracts.HistoryPage;
  for (const [state, label] of [
    ["COMPLETED", "답변 완료"],
    ["FAILED", "답변 실패"],
    ["INTERRUPTED", "중단 확인"],
    ["CANCELLED", "시작 전 취소"],
  ] as const) {
    await h.snapshot({ ...page, runs: [{ ...page.runs[0], state }] });
    assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
    const question = labeled(h.renderTimeline(), "질문 #1 답변 상태");
    assert.ok(question);
    assert.match(visibleText(question), new RegExp(label));
  }
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "QUEUED" }] });
  assert.ok(labeled(h.render(), "AI 답변 상태"));
});

test("should keep exact request confirmation available without a current answer after a lost submission", async (t) => {
  const h = await harness(t);
  (find(h.render(), "composer")!.props.onDraft as (value: string) => void)("응답 유실 질문");
  h.fail();
  await (find(h.render(), "composer")!.props.onSubmit as (event: unknown) => Promise<boolean>)(
    h.submit("응답 유실 질문"),
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().pendingDirect?.action, "ask");
  const region = labeled(h.render(), "AI 답변 상태");
  assert.ok(region);
  const retry = buttonText(region, /^같은 요청 확인$/);
  assert.ok(retry);
  h.succeed();
  await (retry.props.onClick as () => Promise<boolean>)();
  assert.deepEqual(h.calls[1].body, h.calls[0].body);
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
});

test("should not append old terminal summaries whose questions are outside the loaded history", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({
    ...page,
    runs: ["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"].map((state, index) => ({
      ...page.runs[0],
      requestId: uuid(501 + index),
      cycleId: uuid(601 + index),
      state: state as contracts.RunState,
    })),
  });
  assert.doesNotMatch(visibleText(h.renderTimeline()), /실행 기록/);
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
});

test("should reuse status on unchanged room renders and pass the same result to the timeline", async (t) => {
  const h = await harness(t);
  const page = fixture.history as contracts.HistoryPage;
  await h.snapshot({ ...page, runs: [{ ...page.runs[0], state: "RUNNING" }] });
  h.render();
  const before = h.projectionCalls();
  const tree = h.render();
  assert.equal(h.projectionCalls(), before);
  const shared = find(tree, "timeline")!.props.presentation as ReturnType<
    typeof presentation.answerStatuses
  >;
  assert.equal(shared.statuses[0].label, "답변 생성 중");
  assert.equal(shared.byQuestion.get(page.events[0].eventId)?.[0], shared.statuses[0]);
  assert.match(visibleText(labeled(tree, "AI 답변 상태")), /답변 생성 중/);
  assert.equal(h.projectionCalls(), before);
});

const retirementPage = (): contracts.RecoveryHistoryPage => ({
  ...structuredClone(retirementFixture.history),
  bindings: [
    ...retirementFixture.history.bindings,
    {
      ...retirementFixture.history.bindings[0],
      agentId: uuid(99),
      owned: false,
      validUntil: "2099-01-01T00:00:00.000Z",
    },
  ],
});
const click = (node: Node) => (node.props.onClick as () => unknown)();
test("should place one room status and advanced form in the header slot", async (t) => {
  const h = await harness(t, "owner");
  const tree = h.render();
  const header = find(tree, "header-controls");
  assert.ok(header);
  assert.ok(find(header, "advanced"));
  assert.equal(labeled(header, "방 상태")?.props.role, "status");
  assert.ok(!String(header.props.className).includes("border-b"));
  await h.snapshot({ ...h.history, roomMode: "PAUSED" });
  assert.match(visibleText(find(h.render(), "header-controls")), /일시정지 확인/);
});
async function settleUI() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test("should open the actual retirement dialog and cancel without sending a request", async (t) => {
  const h = await harness(t, "owner");
  await h.snapshot(retirementPage());
  const button = buttonText(h.render(), /^이전 요청 정리$/)!;
  assert.equal(button.props.disabled, false);
  click(button);
  const dialog = find(h.render(), "dialog")!;
  assert.equal(dialog.props.open, true);
  assert.match(visibleText(dialog), /답변 미확인 상태로 이전 기록에 보관/);
  assert.match(visibleText(dialog), /실행 종료를 확인한 것으로 처리하지/);
  click(buttonText(dialog, /^취소$/)!);
  assert.equal(find(h.render(), "dialog")!.props.open, false);
  assert.equal(h.calls.length, 0);
  assert.match(visibleText(labeled(h.render(), "AI 답변 상태")), /실행 결과 확인 필요/);
});

test("should remove the current card on a pinned receipt and preserve archived details until fresh recovery enables asking", async (t) => {
  const h = await harness(t, "owner");
  const page = retirementPage();
  await h.snapshot(page);
  assert.equal(find(h.render(), "composer")!.props.disabled, true);
  await h.controller.mutate("cancel", {
    requestId: retirementFixture.retire.requestId,
    expectedRoomRevision: page.roomRevision,
  });
  click(buttonText(h.render(), /^이전 요청 정리$/)!);
  click(buttonText(find(h.render(), "dialog"), /^이전 기록에 보관$/)!);
  await settleUI();
  const request = h.calls.find((call) => call.action === "retire")!;
  assert.ok(request);
  const { operationId, ...expected } = retirementFixture.retire;
  void operationId;
  assert.deepEqual(request.body, { ...expected, operationId: request.body.operationId });
  assert.equal(h.storage.size, 0);
  assert.equal(find(h.render(), "dialog"), undefined);
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
  assert.equal(find(h.render(), "composer")!.props.disabled, true);
  const archived = find(h.renderTimeline(), "details")!;
  assert.match(visibleText(archived), /답변 미확인 · 이전 기록/);
  assert.match(visibleText(archived), /마지막 상태:\s*실행 결과 확인 필요/);
  assert.match(visibleText(archived), /중단 요청 접수.*종료 확인 대기/);
  assert.match(visibleText(archived), /정리 시각/);
  assert.equal(h.controller.getSnapshot().history.runs[0].state, "UNKNOWN");
  assert.equal(h.controller.getSnapshot().history.runs[0].terminal, null);
  await h.pollFail();
  assert.equal(find(h.render(), "composer")!.props.disabled, true);
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
  assert.match(visibleText(find(h.renderTimeline(), "details")), /답변 미확인 · 이전 기록/);
  h.succeed();
  h.pollSucceed();
  const { state, attemptId, fence, roomRevision, ...retirement } = retirementFixture.receipt;
  void state;
  void attemptId;
  void fence;
  await h.snapshot({
    ...page,
    roomRevision,
    cycle: null,
    runs: [],
    recovery: {
      ...page.recovery,
      candidate: null,
      hasBlockingRuns: false,
      retirements: [retirement],
      nextRetirementCursor: 1,
      highWaterRetirementSequence: 1,
    },
  });
  assert.equal(find(h.render(), "composer")!.props.disabled, false);
  assert.equal(h.calls.filter((call) => call.action === "ask").length, 0);
});

test("should require explicit reconfirmation when polling changes the pinned retirement revision", async (t) => {
  const h = await harness(t, "owner");
  const page = retirementPage();
  await h.snapshot(page);
  click(buttonText(h.render(), /^이전 요청 정리$/)!);
  await h.snapshot({
    ...page,
    roomRevision: 2,
    recovery: { ...page.recovery, candidate: { ...page.recovery.candidate!, roomRevision: 2 } },
  });
  let dialog = find(h.render(), "dialog")!;
  assert.match(visibleText(dialog), /대상 또는 방 상태가 바뀌었습니다/);
  const staleConfirmation = buttonText(dialog, /^이전 기록에 보관$/)!;
  assert.equal(staleConfirmation.props.disabled, true);
  click(staleConfirmation);
  await settleUI();
  assert.equal(h.calls.length, 0);
  click(buttonText(dialog, /^현재 요청 다시 확인$/)!);
  dialog = find(h.render(), "dialog")!;
  assert.equal(buttonText(dialog, /^이전 기록에 보관$/)!.props.disabled, false);
  h.retireResponse({ ...retirementFixture.receipt, roomRevision: 3 });
  click(buttonText(dialog, /^이전 기록에 보관$/)!);
  await settleUI();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.expectedRoomRevision, 2);
});

test("should retain access to exact retirement confirmation after an unavailable response closes the dialog", async (t) => {
  const h = await harness(t, "owner");
  await h.snapshot(retirementPage());
  click(buttonText(h.render(), /^이전 요청 정리$/)!);
  h.fail();
  click(buttonText(find(h.render(), "dialog"), /^이전 기록에 보관$/)!);
  await settleUI();
  assert.equal(find(h.render(), "dialog")!.props.open, false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().pendingDirect!.action, "retire");
  assert.match(visibleText(labeled(h.render(), "AI 답변 상태")), /실행 결과 확인 필요/);
  const retry = buttonText(h.render(), /^같은 요청 확인$/)!;
  assert.equal(retry.props.disabled, false);
  h.succeed();
  await click(retry);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body, h.calls[0].body);
  assert.equal(h.controller.getSnapshot().permissionDenied, false);
  assert.equal(labeled(h.render(), "AI 답변 상태"), undefined);
});

test("should require device revocation and expose no retirement controls to observers", async (t) => {
  const h = await harness(t, "owner");
  const page = retirementPage();
  await h.snapshot({
    ...page,
    recovery: {
      ...page.recovery,
      candidate: { ...page.recovery.candidate!, deviceRevoked: false, canRetire: false },
    },
  });
  const region = labeled(h.render(), "AI 답변 상태")!;
  assert.match(visibleText(region), /내 AI 연결에서 이전 기기를 해제하세요/);
  assert.equal(find(region, "a")!.props.href, "/app/connections");
  assert.equal(buttonText(region, /^이전 요청 정리$/)!.props.disabled, true);
  const observer = await harness(t, "observer");
  await observer.snapshot({ ...page, recovery: { ...page.recovery, candidate: null } });
  assert.equal(buttonText(observer.render(), /^이전 요청 정리$/), undefined);
  assert.equal(find(observer.render(), "dialog"), undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(observer.calls.length, 0);
});

function speechConfirmation(node: unknown): Node | undefined {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = speechConfirmation(child);
      if (result) return result;
    }
    return;
  }
  const item = node as Node;
  if (item.type === "button" && item.props.children === "같은 메시지 확인") return item;
  return speechConfirmation(item.props?.children);
}

test("should clear only the submitted speech draft after same-message confirmation", async (t) => {
  const h = await harness(t);
  let composer = find(h.render(), "composer")!;
  (composer.props.onMode as (mode: string) => void)("speak");
  (composer.props.onDraft as (text: string) => void)("보존할 발언");
  composer = find(h.render(), "composer")!;
  h.fail();
  assert.equal(
    await (composer.props.onSubmit as (event: unknown) => Promise<boolean>)(
      h.submit("보존할 발언"),
    ),
    false,
  );
  assert.equal(h.controller.getSnapshot().pendingDirect?.action, "speak");
  assert.equal(find(h.render(), "composer")!.props.disabled, true);
  h.succeed();
  const retry = speechConfirmation(h.render());
  assert.ok(retry);
  assert.equal(await (retry.props.onClick as () => Promise<boolean>)(), true);
  assert.deepEqual(h.calls[1].body, h.calls[0].body);
  assert.equal(find(h.render(), "composer")!.props.draft, "");
});

test("should retain edited drafts after retry acknowledgement", async (t) => {
  const h = await harness(t);
  let composer = find(h.render(), "composer")!;
  (composer.props.onMode as (mode: string) => void)("speak");
  (composer.props.onDraft as (text: string) => void)("원래 발언");
  composer = find(h.render(), "composer")!;
  h.fail();
  await (composer.props.onSubmit as (event: unknown) => Promise<boolean>)(h.submit("원래 발언"));
  h.succeed();
  const retry = speechConfirmation(h.render());
  assert.ok(retry);
  const confirming = (retry.props.onClick as () => Promise<boolean>)();
  (find(h.render(), "composer")!.props.onDraft as (text: string) => void)("수정한 초안");
  h.render();
  assert.equal(await confirming, true);
  assert.equal(find(h.render(), "composer")!.props.draft, "수정한 초안");
});

test("should subscribe only online and visible recovery and remove listeners on unmount", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await harness(t);
  assert.equal(h.reads(), 1);
  h.documentEvents.hidden = true;
  h.documentEvents.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(1000);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.reads(), 1);
  h.documentEvents.hidden = false;
  h.windowEvents.dispatchEvent(new Event("online"));
  h.documentEvents.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(1000);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.reads(), 2);
  h.stop();
  h.controller.start();
  await h.controller.poll();
  const reads = h.reads();
  h.windowEvents.dispatchEvent(new Event("online"));
  h.documentEvents.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(1000);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(h.reads(), reads);
  h.controller.stop();
});

test("should preserve whitespace edits to a speech draft during confirmation", async (t) => {
  const h = await harness(t);
  let composer = find(h.render(), "composer")!;
  (composer.props.onMode as (mode: string) => void)("speak");
  (composer.props.onDraft as (text: string) => void)("  원래 발언  ");
  composer = find(h.render(), "composer")!;
  h.fail();
  await (composer.props.onSubmit as (event: unknown) => Promise<boolean>)(
    h.submit("  원래 발언  "),
  );
  h.succeed();
  const retry = speechConfirmation(h.render());
  assert.ok(retry);
  const confirming = (retry.props.onClick as () => Promise<boolean>)();
  (find(h.render(), "composer")!.props.onDraft as (text: string) => void)("원래 발언");
  h.render();
  assert.equal(await confirming, true);
  assert.equal(find(h.render(), "composer")!.props.draft, "원래 발언");
});

test("should clear the exact untrimmed submitted speech draft on confirmation", async (t) => {
  const h = await harness(t);
  let composer = find(h.render(), "composer")!;
  (composer.props.onMode as (mode: string) => void)("speak");
  (composer.props.onDraft as (text: string) => void)("  제출 발언  ");
  composer = find(h.render(), "composer")!;
  h.fail();
  await (composer.props.onSubmit as (event: unknown) => Promise<boolean>)(
    h.submit("  제출 발언  "),
  );
  h.succeed();
  const retry = speechConfirmation(h.render());
  assert.ok(retry);
  assert.equal(await (retry.props.onClick as () => Promise<boolean>)(), true);
  assert.equal(find(h.render(), "composer")!.props.draft, "");
});
