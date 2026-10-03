import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import { emptyHistory, mergeHistory } from "../../src/features/investigation-coordinator/history-state.ts";

const roomId = "00000000-0000-4000-8000-000000000001";
const actorA = "00000000-0000-4000-8000-000000000011";
const actorB = "00000000-0000-4000-8000-000000000012";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const view = ts.transpileModule(readFileSync("src/features/investigation-coordinator/investigation-view.tsx", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

async function restore(userId: string, entries: [string, string][]) {
  const storage = new Map(entries);
  const states: unknown[] = [];
  const effects: (() => unknown)[] = [];
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const react = {
    useState(initial: unknown) {
      const index = states.length;
      states.push(typeof initial === "function" ? initial() : initial);
      return [states[index], (value: unknown) => { states[index] = value; }];
    },
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => { effects.push(effect); },
  };
  const exports: Record<string, (props: unknown) => { type: (props: unknown) => unknown; props: unknown }> = {};
  runInNewContext(view, {
    exports, require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./contracts") return contracts;
      if (name === "./history-state") return { emptyHistory, mergeHistory };
      if (name === "./polling-policy") return { pollingDelay: () => 10_000 };
      throw new Error("Unexpected isolated UI dependency");
    },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => storage.delete(key),
    },
    queueMicrotask, AbortController, Date, TextEncoder,
  }, { timeout: 1000 });
  const component = exports.InvestigationView({ roomId, userId, role: "participant" });
  component.type(component.props);
  // Exercise only the real restoration effect, never polling or native execution.
  effects[0]();
  await new Promise<void>(resolve => setImmediate(resolve));
  const pending = states.find(value => !!value && typeof value === "object" && "action" in value);
  return { pending: pending ? JSON.parse(JSON.stringify(pending)) : null, storage };
}

test("should isolate unresolved direct intents across authenticated users", async () => {
  const legacyKey = `human-direct-question:${roomId}`;
  // Pre-SQL008 storage has neither an actor namespace nor an expectedUserId field.
  const { expectedUserId: omitted, ...legacyBody } = fixture.ask;
  void omitted;
  const legacy = { action: "ask", body: legacyBody };
  const result = await restore(actorB, [[legacyKey, JSON.stringify(legacy)]]);
  assert.equal(result.pending, null);
  assert.equal(result.storage.has(legacyKey), false);
  const aKey = `human-direct-question:${actorA}:${roomId}`;
  const intent = { action: "ask", body: { ...fixture.ask, expectedUserId: actorA } };
  const switched = await restore(actorB, [[aKey, JSON.stringify(intent)]]);
  assert.equal(switched.pending, null);
  assert.equal(switched.storage.get(aKey), JSON.stringify(intent));
});

test("should restore only the same actor's exact direct operation after reload", async () => {
  for (const action of ["ask", "cancel"] as const) {
    const key = `human-direct-question:${actorA}:${roomId}`;
    const intent = { action, body: { ...fixture[action], expectedUserId: actorA } };
    assert.deepEqual((await restore(actorA, [[key, JSON.stringify(intent)]])).pending, intent);
    const forged = await restore(actorB, [[`human-direct-question:${actorB}:${roomId}`, JSON.stringify(intent)]]);
    assert.equal(forged.pending, null);
    assert.equal(forged.storage.size, 0);
  }
  const key = `human-direct-question:${actorA}:${roomId}`;
  for (const saved of ["invalid JSON", JSON.stringify({ action: "ask", body: { ...fixture.ask,
    roomId: "00000000-0000-4000-8000-000000000099" } }),
    JSON.stringify({ action: "ask", body: fixture.ask, actor: actorA }),
    JSON.stringify({ action: "start", body: fixture.ask })]) {
    const refused = await restore(actorA, [[key, saved]]);
    assert.equal(refused.pending, null);
    assert.equal(refused.storage.has(key), false);
  }
});

test("should require an exact direct actor UUID without changing peer wire", () => {
  for (const action of ["ask", "cancel"] as const) {
    const body = { ...fixture[action], expectedUserId: actorA };
    assert.deepEqual(contracts.validateBody(action, body), body);
    const { expectedUserId: omitted, ...missing } = body;
    void omitted;
    for (const invalid of [missing, { ...body, expectedUserId: null }, { ...body, expectedUserId: [actorA] },
      { ...body, expectedUserId: "invalid" }, { ...body, actorId: actorA }]) {
      assert.throws(() => contracts.validateBody(action, invalid), { code: "INVALID_BODY" });
    }
  }
});
