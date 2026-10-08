import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import { callInvestigation } from "../../src/features/investigation-coordinator/investigation-client.ts";
import {
  emptyHistory,
  mergeHistory,
} from "../../src/features/investigation-coordinator/history-state.ts";

const roomId = "00000000-0000-4000-8000-000000000001";
const actorA = "00000000-0000-4000-8000-000000000011";
const actorB = "00000000-0000-4000-8000-000000000012";
const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const view = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/investigation-view.tsx", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;

const directIntents = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/direct-intents.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

async function restore(
  userId: string,
  entries: [string, string][],
  failure?: "access" | "legacy" | "get" | "remove",
) {
  const storage = new Map(entries);
  const states: unknown[] = [];
  const effects: (() => unknown)[] = [];
  const jsx = (type: unknown, props: unknown) => ({ type, props });
  const react = {
    useState(initial: unknown) {
      const index = states.length;
      states.push(typeof initial === "function" ? initial() : initial);
      return [
        states[index],
        (value: unknown) => {
          states[index] = value;
        },
      ];
    },
    useRef: (current: unknown) => ({ current }),
    useEffect: (effect: () => unknown) => {
      effects.push(effect);
    },
  };
  const exports: Record<
    string,
    (props: unknown) => { type: (props: unknown) => unknown; props: unknown }
  > = {};
  const context = {
    exports,
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "./contracts") return contracts;
      if (name === "./direct-intents") return policies().module;
      if (name === "./investigation-client") return { callInvestigation };
      if (name === "./history-state") return { emptyHistory, mergeHistory };
      if (name === "./polling-policy") return { pollingDelay: () => 10_000 };
      throw new Error("Unexpected isolated UI dependency");
    },
    sessionStorage: {
      getItem: (key: string) => {
        if (failure === "get") throw new Error("Storage read denied");
        return storage.get(key) ?? null;
      },
      removeItem: (key: string) => {
        if (
          failure === "remove" ||
          (failure === "legacy" && key === `human-direct-question:${roomId}`)
        )
          throw new Error("Storage removal denied");
        return storage.delete(key);
      },
    },
    queueMicrotask,
    AbortController,
    Date,
    TextEncoder,
  };
  if (failure === "access")
    Object.defineProperty(context, "sessionStorage", {
      get() {
        throw new Error("Storage access denied");
      },
    });
  runInNewContext(view, context, { timeout: 1000 });
  const component = exports.InvestigationView({ roomId, userId, role: "participant" });
  component.type(component.props);
  // Exercise only the real restoration effect, never polling or native execution.
  const cleanup = effects[0]() as () => void;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const pending = states.find((value) => !!value && typeof value === "object" && "action" in value);
  cleanup();
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
    const forged = await restore(actorB, [
      [`human-direct-question:${actorB}:${roomId}`, JSON.stringify(intent)],
    ]);
    assert.equal(forged.pending, null);
    assert.equal(forged.storage.size, 0);
  }
  const key = `human-direct-question:${actorA}:${roomId}`;
  for (const saved of [
    "invalid JSON",
    JSON.stringify({
      action: "ask",
      body: { ...fixture.ask, roomId: "00000000-0000-4000-8000-000000000099" },
    }),
    JSON.stringify({ action: "ask", body: fixture.ask, actor: actorA }),
    JSON.stringify({ action: "start", body: fixture.ask }),
  ]) {
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
    for (const invalid of [
      missing,
      { ...body, expectedUserId: null },
      { ...body, expectedUserId: [actorA] },
      { ...body, expectedUserId: "invalid" },
      { ...body, actorId: actorA },
    ]) {
      assert.throws(() => contracts.validateBody(action, invalid), { code: "INVALID_BODY" });
    }
  }
});

type Intent = { action: "ask" | "cancel"; body: contracts.Body };
type IntentStorage = { getItem(key: string): string | null; removeItem(key: string): unknown };
function policies() {
  let uuids = 0;
  const exports: {
    directIntentKey?: (userId: string, roomId: string) => string;
    restoreDirectIntent?: (storage: IntentStorage, userId: string, roomId: string) => Intent | null;
    mutationBody?: (
      action: contracts.HumanAction,
      fields: contracts.Body,
      userId: string,
      roomId: string,
      retryBody?: contracts.Body,
    ) => contracts.Body;
  } = {};
  runInNewContext(
    directIntents,
    {
      exports,
      require(name: string) {
        if (name === "./contracts.ts") return contracts;
        throw new Error("Unexpected isolated policy dependency");
      },
      crypto: {
        randomUUID() {
          uuids++;
          return crypto.randomUUID();
        },
      },
    },
    { timeout: 1000 },
  );
  assert.ok(exports.directIntentKey);
  assert.ok(exports.restoreDirectIntent);
  assert.ok(exports.mutationBody);
  return {
    module: exports,
    key: exports.directIntentKey,
    restore: exports.restoreDirectIntent,
    mutation: exports.mutationBody,
    uuids: () => uuids,
  };
}

test("should retain exact direct mutation identity on retry", () => {
  const policy = policies();
  const workflow = JSON.parse(readFileSync("tests/fixtures/workflow-contracts.json", "utf8")) as {
    cases: { action: contracts.Action; body: contracts.Body }[];
    cycleResume: contracts.Body;
  };
  const human = workflow.cases.filter((entry) =>
    contracts.humanActions.includes(entry.action as contracts.HumanAction),
  );
  const cases = [
    ...human,
    { action: "ask", body: fixture.ask },
    { action: "cancel", body: fixture.cancel },
    { action: "resume", body: workflow.cycleResume },
  ];
  for (const entry of cases) {
    const action = entry.action as contracts.HumanAction;
    const {
      protocol: omittedProtocol,
      roomId: omittedRoom,
      operationId: omittedOperation,
      expectedUserId: omittedActor,
      ...fields
    } = entry.body;
    void omittedProtocol;
    void omittedRoom;
    void omittedOperation;
    void omittedActor;
    const before = policy.uuids();
    if (action === "read") {
      // The current mutation helper generates an operationId; read forbids it.
      assert.throws(() => policy.mutation(action, fields, actorA, roomId), {
        code: "INVALID_BODY",
      });
      assert.equal(policy.uuids(), before + 1);
      assert.deepEqual(
        policy.mutation(action, { ignored: true }, actorA, roomId, entry.body),
        entry.body,
      );
      assert.equal(policy.uuids(), before + 1);
      continue;
    }
    const directAction = action === "ask" || action === "cancel";
    const inputFields = directAction ? { ...fields, expectedUserId: actorB } : fields;
    const body = policy.mutation(action, inputFields, actorA, roomId);
    assert.equal(policy.uuids(), before + 1);
    assert.match(
      body.operationId as string,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(body, {
      protocol: 1,
      roomId,
      operationId: body.operationId,
      ...fields,
      ...(directAction ? { expectedUserId: actorA } : {}),
    });
    assert.deepEqual(policy.mutation(action, { ignored: true }, actorA, roomId, body), body);
    assert.equal(policy.uuids(), before + 1);
    // Spread preserves supplied fields, including an already supplied operationId.
    assert.deepEqual(policy.mutation(action, entry.body, actorA, roomId), entry.body);
    assert.equal(policy.uuids(), before + 2);
  }
  for (const action of ["ask", "cancel"] as const) {
    const before = policy.uuids();
    for (const body of [
      { ...fixture[action], expectedUserId: actorB },
      { ...fixture[action], roomId: "00000000-0000-4000-8000-000000000099" },
    ])
      assert.throws(
        () => policy.mutation(action, {}, actorA, roomId, body),
        (error: unknown) => {
          assert.ok(error instanceof contracts.WorkflowError);
          assert.equal(error.code, "FORBIDDEN");
          return true;
        },
      );
    assert.throws(
      () => policy.mutation(action, {}, actorA, roomId, { ...fixture[action], actor: actorB }),
      { code: "INVALID_BODY" },
    );
    assert.equal(policy.uuids(), before);
    assert.throws(
      () =>
        policy.mutation(
          action,
          { ...fixture[action], roomId: "00000000-0000-4000-8000-000000000099" },
          actorA,
          roomId,
        ),
      { code: "FORBIDDEN" },
    );
    assert.equal(policy.uuids(), before + 1);
  }
});

test("should refuse restoration when storage fails", async (t) => {
  const policy = policies();
  const key = policy.key(actorA, roomId);
  const otherKey = policy.key(actorB, roomId);
  const legacyKey = `human-direct-question:${roomId}`;
  assert.equal(key, `human-direct-question:${actorA}:${roomId}`);
  assert.equal(otherKey, `human-direct-question:${actorB}:${roomId}`);
  const intent = { action: "ask", body: fixture.ask };
  const other = JSON.stringify({ action: "ask", body: { ...fixture.ask, expectedUserId: actorB } });
  for (const failure of ["legacy", "get", "remove"] as const)
    await t.test(`private policy ${failure} failure`, () => {
      const saved = failure === "remove" ? "invalid JSON" : JSON.stringify(intent);
      const storage = new Map([
        [key, saved],
        [otherKey, other],
        [legacyKey, "legacy"],
      ]);
      const calls: string[] = [];
      const restored = policy.restore(
        {
          getItem(name) {
            calls.push(`get:${name}`);
            if (failure === "get") throw new Error("Storage read denied");
            return storage.get(name) ?? null;
          },
          removeItem(name) {
            calls.push(`remove:${name}`);
            if (
              (failure === "legacy" && name === legacyKey) ||
              (failure === "remove" && name === key)
            )
              throw new Error("Storage removal denied");
            storage.delete(name);
          },
        },
        actorA,
        roomId,
      );
      assert.equal(restored, null);
      assert.deepEqual(
        calls,
        failure === "legacy"
          ? [`remove:${legacyKey}`, `remove:${key}`]
          : [`remove:${legacyKey}`, `get:${key}`, `remove:${key}`],
      );
      assert.equal(storage.get(otherKey), other);
      assert.equal(storage.has(key), failure === "remove");
    });
  for (const failure of ["access", "legacy", "get", "remove"] as const)
    await t.test(`real restoration effect ${failure} failure`, async () => {
      const saved = failure === "remove" ? "invalid JSON" : JSON.stringify(intent);
      const result = await restore(
        actorA,
        [
          [key, saved],
          [otherKey, other],
        ],
        failure,
      );
      assert.equal(result.pending, null);
      assert.equal(result.storage.get(otherKey), other);
    });
  for (const action of ["ask", "cancel"] as const)
    await t.test(`private exact ${action} restoration`, () => {
      const intended = { action, body: fixture[action] };
      const storage = new Map([
        [key, JSON.stringify(intended)],
        [otherKey, other],
        [legacyKey, "legacy"],
      ]);
      const calls: string[] = [];
      const restored = policy.restore(
        {
          getItem(name) {
            calls.push(`get:${name}`);
            return storage.get(name) ?? null;
          },
          removeItem(name) {
            calls.push(`remove:${name}`);
            storage.delete(name);
          },
        },
        actorA,
        roomId,
      );
      assert.deepEqual(JSON.parse(JSON.stringify(restored)), intended);
      assert.deepEqual(calls, [`remove:${legacyKey}`, `get:${key}`]);
      assert.equal(storage.get(otherKey), other);
      assert.equal(storage.get(key), JSON.stringify(intended));
      assert.equal(storage.has(legacyKey), false);
    });
});
