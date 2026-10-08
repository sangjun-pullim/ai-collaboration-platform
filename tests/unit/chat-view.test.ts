import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as intents from "../../src/features/investigation-coordinator/direct-intents.ts";
import {
  emptyHistory,
  mergeHistory,
  type HistoryState,
} from "../../src/features/investigation-coordinator/history-state.ts";
import { nearTimelineBottom } from "../../src/features/investigation-coordinator/chat-presentation.ts";
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
function harness(role: "owner" | "participant" | "observer" = "participant") {
  let stateIndex = 0,
    refIndex = 0;
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let effects: (() => void)[] = [];
  const calls: { action: contracts.HumanAction; body: contracts.Body }[] = [];
  let responseFailure = false;
  const storage = new Map<string, string>();
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const exports: { InvestigationView?: (props: unknown) => Node } = {};
  runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "react")
        return {
          useState(initial: unknown) {
            const index = stateIndex++;
            if (!(index in states))
              states[index] = typeof initial === "function" ? initial() : initial;
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
          useEffect(effect: () => void) {
            effects.push(effect);
          },
          useLayoutEffect() {},
        };
      if (name === "./contracts") return contracts;
      if (name === "./direct-intents") return intents;
      if (name === "./history-state") return { emptyHistory, mergeHistory };
      if (name === "./chat-presentation") return { nearTimelineBottom };
      if (name === "./polling-policy") return { pollingDelay: () => 10000 };
      if (name === "./investigation-client")
        return {
          callInvestigation: async (action: contracts.HumanAction, body: contracts.Body) => {
            calls.push({ action, body });
            if (responseFailure) throw new contracts.WorkflowError("UNAVAILABLE");
          },
        };
      if (name === "./chat-composer") return { ChatComposer: "composer" };
      if (name === "./chat-timeline") return { ChatTimeline: "timeline" };
      if (name === "./advanced-controls") return { AdvancedControls: "advanced" };
      if (name === "../../components/ui/button") return { Button: "button" };
      throw new Error(`Unexpected UI dependency ${name}`);
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    queueMicrotask,
    AbortController,
    Date,
    FormData: class {
      constructor(private form: { text: string }) {}
      get() {
        return this.form.text;
      }
    },
  });
  assert.ok(exports.InvestigationView);
  const outer = exports.InvestigationView({
    userId: fixture.ask.expectedUserId,
    roomId: fixture.ask.roomId,
    role,
  });
  function render() {
    stateIndex = 0;
    refIndex = 0;
    effects = [];
    return (outer.type as (props: unknown) => Node)(outer.props);
  }
  render();
  effects[0]();
  const history: contracts.HistoryPage = {
    ...fixture.history,
    events: [],
    runs: [],
    cycle: null,
    bindings: [{ ...fixture.history.bindings[0], validUntil: "2099-01-01T00:00:00.000Z" }],
  };
  function snapshot(page: contracts.HistoryPage) {
    states[0] = mergeHistory(emptyHistory(page.roomId), page);
    refs[0].current = states[0] as HistoryState;
  }
  snapshot(history);
  return {
    render,
    states,
    history,
    snapshot,
    calls,
    storage,
    fail: () => {
      responseFailure = true;
    },
    succeed: () => {
      responseFailure = false;
    },
    submit: (text: string) => ({ preventDefault() {}, currentTarget: { text, reset() {} } }),
  };
}

test("should pin the sole responder epoch and never replace an expired selection automatically", () => {
  const h = harness();
  let node = h.render();
  assert.ok(find(node, "composer"));
  h.snapshot({ ...h.history, bindings: [{ ...h.history.bindings[0], bindingEpoch: 2 }] });
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
test("should keep polling changes from clearing a draft or choosing another responder", () => {
  const h = harness();
  const composer = find(h.render(), "composer")!;
  (composer.props.onDraft as (value: string) => void)("미전송 본문");
  h.snapshot({
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
test("should retain the unresolved exact ask and reject a fresh body until same-request confirmation", async () => {
  const h = harness();
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
test("should expose no composer or mutation controls for observers", () => {
  const h = harness("observer");
  assert.equal(find(h.render(), "composer"), undefined);
  assert.equal(find(h.render(), "advanced"), undefined);
});

test("should honor an explicitly cleared selection when only one responder remains", () => {
  const h = harness();
  const composer = find(h.render(), "composer")!;
  (composer.props.onTarget as (id: string) => void)("");
  const cleared = find(h.render(), "composer")!;
  assert.equal(cleared.props.target, undefined);
  assert.equal(cleared.props.targetValue, "");
  assert.equal(cleared.props.disabled, true);
  h.snapshot({ ...h.history, bindings: [{ ...h.history.bindings[0], bindingEpoch: 2 }] });
  assert.equal(find(h.render(), "composer")!.props.target, undefined);
});
