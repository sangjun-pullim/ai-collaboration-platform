import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as intents from "../../src/features/investigation-coordinator/direct-intents.ts";
import {
  emptyHistory,
  mergeHistory,
} from "../../src/features/investigation-coordinator/history-state.ts";
import { nearTimelineBottom } from "../../src/features/investigation-coordinator/chat-presentation.ts";
import type { RoomChatController } from "../../src/features/investigation-coordinator/room-chat-controller.ts";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
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
  return find(el.props?.children, type);
}
async function harness(t: TestContext, role: "owner" | "participant" | "observer" = "participant") {
  let stateIndex = 0,
    refIndex = 0,
    memoIndex = 0;
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const memos: unknown[] = [];
  let effects: (() => (() => void) | void)[] = [];
  const calls: { action: contracts.HumanAction; body: contracts.Body }[] = [];
  let responseFailure = false;
  const storage = new Map<string, string>();
  const history: contracts.HistoryPage = {
    ...fixture.history,
    events: [],
    runs: [],
    cycle: null,
    bindings: [{ ...fixture.history.bindings[0], validUntil: "2099-01-01T00:00:00.000Z" }],
  };
  let currentPage = history;
  let controller!: RoomChatController;
  const rememberController = (value: RoomChatController) => {
    controller = value;
  };
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const react = {
    useState(initial: unknown) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === "function" ? initial() : initial;
      return [
        states[index],
        (value: unknown) => {
          states[index] = typeof value === "function" ? value(states[index]) : value;
        },
      ];
    },
    useRef(current: unknown) {
      const index = refIndex++;
      return refs[index] ?? (refs[index] = { current });
    },
    useMemo(create: () => unknown) {
      const index = memoIndex++;
      return memos[index] ?? (memos[index] = create());
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
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, { ...context, exports }, { timeout: 1000 });
    return exports;
  }
  const context = {
    require(name: string): unknown {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react") return react;
      if (["./contracts", "./contracts.ts"].includes(name)) return contracts;
      if (["./direct-intents", "./direct-intents.ts"].includes(name)) return intents;
      if (["./history-state", "./history-state.ts"].includes(name))
        return { emptyHistory, mergeHistory };
      if (name === "./chat-presentation") return { nearTimelineBottom };
      if (["./polling-policy", "./polling-policy.ts"].includes(name))
        return { pollingDelay: () => 10_000 };
      if (name === "./investigation-client")
        return {
          callInvestigation: async (action: contracts.HumanAction, body: contracts.Body) => {
            if (action === "read") return currentPage;
            calls.push({ action, body });
            if (responseFailure) throw new contracts.WorkflowError("UNAVAILABLE");
            return {};
          },
        };
      if (name === "./room-chat-controller") {
        const loaded = load(name, "src/features/investigation-coordinator/room-chat-controller.ts");
        const Original = loaded.RoomChatController as typeof RoomChatController;
        return {
          RoomChatController: class extends Original {
            constructor(...args: ConstructorParameters<typeof RoomChatController>) {
              super(...args);
              rememberController(this);
            }
          },
        };
      }
      if (name === "./use-room-chat")
        return load(name, "src/features/investigation-coordinator/use-room-chat.ts");
      if (name === "./chat-composer") return { ChatComposer: "composer" };
      if (name === "./chat-timeline") return { ChatTimeline: "timeline" };
      if (name === "./own-input-controls") return { OwnInputControls: "own-input-controls" };
      if (name === "./advanced-controls") return { AdvancedControls: "advanced" };
      if (name === "../../components/ui/button") return { Button: "button" };
      throw new Error(`Unexpected UI dependency ${name}`);
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: { hidden: false },
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
    history,
    calls,
    storage,
    snapshot: async (next: contracts.HistoryPage) => {
      currentPage = next;
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
