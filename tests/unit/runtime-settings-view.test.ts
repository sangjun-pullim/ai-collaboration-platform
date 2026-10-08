import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  capabilityHash,
  SettingsError,
  validateSelection,
  type Body,
  type Capability,
  type Receipt,
  type SettingsResponse,
} from "../../src/features/runtime-settings/contracts.ts";
import {
  SettingsController,
  confirmedCatalog,
  selectionSaved,
  type SettingsRequest,
  type SettingsView,
} from "../../src/features/runtime-settings/settings-controller.ts";

const deviceId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000002";
const secondOperationId = "00000000-0000-4000-8000-000000000003";
const agentId = "00000000-0000-4000-8000-000000000004";
const rootId = "00000000-0000-4000-8000-000000000005";
const binding = { agentId, workspaceId: rootId, bindingEpoch: 7, runtime: "claude" as const };
type Response = SettingsResponse & { currentBinding?: typeof binding | null };

function catalog(version = "synthetic-1", efforts: string[] = []): Capability {
  const contents = {
    runtime: "claude" as const,
    version,
    models: [
      {
        id: "model-one",
        model: "model-one",
        efforts,
        defaultEffort: efforts[0] ?? null,
        isDefault: true,
      },
    ],
    defaultSettings: { model: "model-one", effort: efforts[0] ?? null },
    policy: "verified" as const,
  };
  return { ...contents, snapshotHash: capabilityHash(contents) };
}
function response(change: Partial<Response> = {}): Response {
  return {
    protocol: 1,
    deviceId,
    configRevision: 0,
    catalog: null,
    operation: null,
    applied: null,
    current: true,
    currentBinding: binding,
    ...change,
  };
}
function localReceipt(state: Receipt["state"] = "LOCAL_CONFIRMATION"): Receipt {
  return {
    operationId,
    state,
    configRevision: 0,
    runtime: "claude",
    model: null,
    effort: null,
    snapshotHash: null,
    localRootReference: rootId,
    repositoryAlias: "공유 저장소",
    sessionAlias: null,
    catalog: null,
    bindingEpoch: null,
    agentId: null,
    workspaceId: null,
  };
}
function operation(state: Receipt["state"] = "LOCAL_CONFIRMATION", requested: Body = {}) {
  return {
    operationId,
    deviceId,
    expectedConfigRevision: 0,
    state,
    requested: {
      operationId,
      deviceId,
      expectedConfigRevision: 0,
      runtime: "claude",
      ...requested,
    },
    receipt: state === "REQUESTED" ? null : localReceipt(state),
  };
}
function confirmed(c = catalog(), requested: Body = {}): Response {
  return response({ catalog: c, operation: operation("LOCAL_CONFIRMATION", requested) });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function controller(request: SettingsRequest, uuid = () => operationId) {
  const c = new SettingsController(deviceId, request, 60000, uuid);
  c.start();
  return c;
}

test("should preserve null effort and bind apply to the exact owned current epoch", async () => {
  const calls: { action: string; body: Body }[] = [];
  let current = response();
  const c = controller(async (action, body) => {
    calls.push({ action, body });
    if (action === "select-folder") current = response({ operation: operation("REQUESTED") });
    if (action === "select-runtime") current = confirmed(catalog(), body);
    if (action === "apply")
      current = response({ catalog: catalog(), operation: operation("APPLYING", body) });
    return current;
  });
  try {
    await c.poll();
    c.setProvider("claude");
    await c.selectFolder();
    current = confirmed();
    await c.poll();
    assert.equal(c.getSnapshot().draft?.effort, null);
    await c.selectRuntime();
    c.setSessionAlias("내 AI");
    await c.apply();
    const selected = calls.find((item) => item.action === "select-runtime")!;
    const applied = calls.find((item) => item.action === "apply")!;
    assert.equal(selected.body.effort, null);
    assert.equal(applied.body.effort, null);
    assert.equal(applied.body.expectedEpoch, 7);
    assert.equal(applied.body.localRootReference, rootId);
    assert.equal(applied.body.repositoryAlias, "공유 저장소");
    assert.equal(c.getSnapshot().response?.operation?.state, "APPLYING");
    assert.equal(c.getSnapshot().response?.applied, null);
  } finally {
    c.stop();
  }
});

test("should invalidate a late list during a mutation and keep a single poll in flight", async () => {
  const oldList = deferred<Response>();
  let lists = 0;
  let oldSignal: AbortSignal | undefined;
  const c = controller(async (action, _body, signal) => {
    if (action === "list") {
      lists++;
      if (lists === 1) return response();
      oldSignal = signal;
      return oldList.promise;
    }
    return response({ operation: operation("REQUESTED") });
  });
  try {
    await c.poll();
    c.setProvider("claude");
    const stale = c.poll();
    await c.poll();
    assert.equal(lists, 2);
    await c.selectFolder();
    assert.equal(oldSignal?.aborted, true);
    oldList.resolve(response());
    await stale;
    assert.equal(c.getSnapshot().response?.operation?.state, "REQUESTED");
    assert.equal(c.getSnapshot().reservedOperationId, operationId);
  } finally {
    c.stop();
  }
});

test("should abort unmounted requests and reject a response for another device", async () => {
  const late = deferred<Response>();
  let signal: AbortSignal | undefined;
  const c = controller(async (_action, _body, incoming) => {
    signal = incoming;
    return late.promise;
  });
  const pending = c.poll();
  c.stop();
  assert.equal(signal?.aborted, true);
  late.resolve(confirmed());
  await pending;
  assert.equal(c.getSnapshot().response, null);
  const other = controller(async () => response({ deviceId: secondOperationId }));
  try {
    await other.poll();
    assert.equal(other.getSnapshot().response, null);
    assert.equal(other.getSnapshot().error, "CONFLICT");
  } finally {
    other.stop();
  }
});

test("should retain the same operation after a lost folder response without retrying or choosing another provider", async () => {
  const calls: string[] = [];
  let uuids = 0;
  const c = controller(
    async (action) => {
      calls.push(action);
      if (action === "select-folder") throw new SettingsError("UNAVAILABLE");
      return response();
    },
    () => {
      uuids++;
      return operationId;
    },
  );
  try {
    await c.poll();
    c.setProvider("claude");
    await c.selectFolder();
    await c.poll();
    c.setProvider("codex");
    await c.selectFolder();
    assert.equal(c.getSnapshot().reservedOperationId, operationId);
    assert.equal(c.getSnapshot().provider, "claude");
    assert.equal(uuids, 1);
    assert.equal(calls.filter((action) => action === "select-folder").length, 1);
  } finally {
    c.stop();
  }
});

test("should wait for the exact cancellation cleanup receipt before a new provider operation", async () => {
  let current = confirmed();
  let folders = 0;
  let uuids = 0;
  const c = controller(
    async (action) => {
      if (action === "cancel")
        current = response({ operation: { ...operation("CANCELLED"), receipt: localReceipt() } });
      if (action === "select-folder") {
        folders++;
        current = response({
          operation: {
            ...operation("REQUESTED"),
            operationId: secondOperationId,
            requested: {
              ...operation().requested,
              operationId: secondOperationId,
              runtime: "codex",
            },
          },
        });
      }
      return current;
    },
    () => {
      uuids++;
      return secondOperationId;
    },
  );
  try {
    await c.poll();
    c.setProvider("codex");
    assert.equal(c.getSnapshot().provider, "claude");
    await c.cancel();
    current = response();
    await c.poll();
    await c.selectFolder();
    assert.equal(c.getSnapshot().response?.operation?.state, "CANCELLED");
    assert.equal(c.getSnapshot().reservedOperationId, operationId);
    assert.equal(uuids, 0);
    current = response({ operation: operation("CANCELLED") });
    await c.poll();
    assert.equal(c.getSnapshot().reservedOperationId, null);
    c.setProvider("codex");
    await c.selectFolder();
    assert.equal(folders, 1);
    assert.equal(uuids, 1);
    assert.equal(c.getSnapshot().reservedOperationId, secondOperationId);
  } finally {
    c.stop();
  }
});

test("should reject stale capability, revision and unrelated binding epoch before applying", async () => {
  const original = catalog();
  const selected = {
    runtime: "claude",
    model: "model-one",
    effort: null,
    snapshotHash: original.snapshotHash,
  };
  for (const changed of [
    confirmed(catalog("synthetic-2"), selected),
    { ...confirmed(original, selected), configRevision: 1 },
    { ...confirmed(original, selected), currentBinding: { ...binding, bindingEpoch: 8 } },
  ]) {
    let current = confirmed(original, selected);
    let mutations = 0;
    const c = controller(async (action) => {
      if (action !== "list") mutations++;
      return current;
    });
    try {
      await c.poll();
      assert.equal(selectionSaved(c.getSnapshot()), true);
      c.setSessionAlias("내 AI");
      current = changed;
      await c.poll();
      assert.equal(confirmedCatalog(c.getSnapshot().response), null);
      assert.equal(selectionSaved(c.getSnapshot()), false);
      await c.apply();
      await c.selectRuntime();
      assert.equal(mutations, 0);
    } finally {
      c.stop();
    }
  }
});

test("should keep failed apply reserved and observe it without repeating apply or starting native setup", async () => {
  let current = confirmed(catalog(), {
    runtime: "claude",
    model: "model-one",
    effort: null,
    snapshotHash: catalog().snapshotHash,
  });
  const mutations: string[] = [];
  const c = controller(async (action, body) => {
    if (action !== "list") mutations.push(action);
    if (action === "apply") current = response({ operation: operation("UNKNOWN", body) });
    return current;
  });
  try {
    await c.poll();
    c.setSessionAlias("내 AI");
    await c.apply();
    await c.poll();
    await c.apply();
    await c.selectFolder();
    await c.cancel();
    assert.deepEqual(mutations, ["apply"]);
    assert.equal(c.getSnapshot().reservedOperationId, operationId);
    assert.equal(c.getSnapshot().response?.operation?.state, "UNKNOWN");
  } finally {
    c.stop();
  }
});

test("should distinguish an owned commit epoch from PC application and reject missing epoch evidence", async () => {
  let current = confirmed(catalog(), {
    runtime: "claude",
    model: "model-one",
    effort: null,
    snapshotHash: catalog().snapshotHash,
  });
  let applies = 0;
  const c = controller(async (action) => {
    if (action === "apply") applies++;
    return current;
  });
  try {
    await c.poll();
    const receipt: Receipt = {
      ...localReceipt("COMMITTED"),
      configRevision: 1,
      agentId,
      workspaceId: rootId,
      bindingEpoch: 8,
      model: "model-one",
      sessionAlias: "내 AI",
      snapshotHash: catalog().snapshotHash,
    };
    current = response({
      configRevision: 1,
      operation: { ...operation("COMMITTED"), receipt },
      currentBinding: { ...binding, bindingEpoch: 8 },
    });
    await c.poll();
    assert.equal(c.getSnapshot().response?.current, true);
    assert.equal(c.getSnapshot().response?.applied, null);
    assert.equal(c.getSnapshot().reservedOperationId, operationId);
    current = {
      ...current,
      applied: { ...receipt, state: "APPLIED" },
      operation: {
        ...current.operation!,
        state: "APPLIED",
        receipt: { ...receipt, state: "APPLIED" },
      },
    };
    await c.poll();
    assert.equal(c.getSnapshot().reservedOperationId, null);
    assert.equal(c.getSnapshot().response?.applied?.state, "APPLIED");
    assert.equal(applies, 0);
  } finally {
    c.stop();
  }
  const unproven = controller(
    async () =>
      ({
        ...confirmed(catalog(), {
          model: "model-one",
          effort: null,
          snapshotHash: catalog().snapshotHash,
        }),
        currentBinding: undefined,
      }) as unknown as Response,
  );
  try {
    await unproven.poll();
    unproven.setSessionAlias("내 AI");
    await unproven.apply();
    assert.equal(unproven.getSnapshot().busy, null);
  } finally {
    unproven.stop();
  }
});

type UINode = { type: unknown; props: Record<string, unknown> };
function nodes(node: unknown): UINode[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  const value = node as UINode;
  return [value, ...nodes(value.props?.children)];
}
function textContent(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  return node && typeof node === "object" ? textContent((node as UINode).props?.children) : "";
}
function loadUI(
  path: string,
  replacements: Record<string, unknown>,
  globals: Record<string, unknown> = {},
) {
  const exported: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  runInNewContext(source, {
    exports: exported,
    Date,
    ...globals,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (Object.hasOwn(replacements, name)) return replacements[name];
      throw new Error(`Unexpected settings UI dependency ${name}`);
    },
  });
  return exported;
}
function formView(change: Partial<SettingsView> = {}): SettingsView {
  return {
    response: confirmed(),
    provider: "claude",
    draft: {
      runtime: "claude",
      model: "model-one",
      effort: null,
      snapshotHash: catalog().snapshotHash,
    },
    sessionAlias: "내 AI",
    busy: null,
    error: null,
    reservedOperationId: operationId,
    ...change,
  };
}
function formTree(view: SettingsView) {
  const component = loadUI("src/features/runtime-settings/runtime-settings-form.tsx", {
    react: {
      useMemo: (factory: () => unknown) => factory(),
      useEffect() {},
      useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    },
    "../../components/ui/button": { Button: "button" },
    "../../components/ui/input": { Input: "input" },
    "../../components/ui/badge": { Badge: "badge" },
    "./settings-client": { requestSettings() {} },
    "./contracts": { validateSelection },
    "./settings-controller": {
      confirmedCatalog,
      selectionSaved,
      SettingsController: class {
        getSnapshot = () => view;
        subscribe() {}
      },
    },
  }).RuntimeSettingsForm as (props: unknown) => UINode;
  return component({ deviceId, deviceAlias: "본인 Mac" });
}

test("should render only actual capability choices and disable changes after the model is saved", () => {
  const initial = formTree(formView());
  const selects = nodes(initial).filter((node) => node.type === "select");
  assert.equal(selects.length, 2);
  assert.equal(selects[0].props.disabled, true);
  assert.equal(selects[1].props.disabled, false);
  assert.deepEqual(
    nodes(selects[1])
      .filter((node) => node.type === "option")
      .map((node) => node.props.value),
    ["", "model-one"],
  );
  const requested = { model: "model-one", effort: null, snapshotHash: catalog().snapshotHash };
  const saved = formTree(formView({ response: confirmed(catalog(), requested) }));
  assert.equal(nodes(saved).filter((node) => node.type === "select")[1].props.disabled, true);
  const missingBinding = formTree(
    formView({
      response: {
        ...confirmed(catalog(), requested),
        currentBinding: undefined,
      } as unknown as Response,
    }),
  );
  const applyButton = nodes(missingBinding).find(
    (node) => node.type === "button" && textContent(node) === "PC에 설정 적용",
  )!;
  assert.equal(applyButton.props.disabled, true);
});

test("should display the prior PC settings separately from the newly committed server settings", () => {
  const oldApplied: Receipt = {
    ...localReceipt("APPLIED"),
    agentId,
    workspaceId: rootId,
    bindingEpoch: 7,
    model: "old-model",
    sessionAlias: "이전 AI",
    snapshotHash: catalog().snapshotHash,
  };
  const commit: Receipt = {
    ...oldApplied,
    state: "COMMITTED",
    configRevision: 1,
    bindingEpoch: 8,
    model: "new-model",
    sessionAlias: "새 AI",
  };
  const current = response({
    configRevision: 1,
    currentBinding: { ...binding, bindingEpoch: 8 },
    applied: oldApplied,
    operation: {
      ...operation("COMMITTED", {
        model: "new-model",
        effort: null,
        sessionAlias: "새 AI",
        snapshotHash: catalog().snapshotHash,
      }),
      receipt: commit,
    },
  });
  const tree = formTree(formView({ response: current, draft: null }));
  const requested = nodes(tree).find((node) => node.props["aria-label"] === "요청한 설정")!;
  const applied = nodes(tree).find((node) => node.props["aria-label"] === "PC에 적용된 설정")!;
  assert.match(textContent(requested), /new-model/);
  assert.doesNotMatch(textContent(requested), /old-model/);
  assert.match(textContent(applied), /old-model/);
  assert.doesNotMatch(textContent(applied), /new-model/);
  assert.match(textContent(applied), /이전 연결/);
  assert.doesNotMatch(textContent(applied), /준비 완료/);
  assert.equal(
    nodes(tree).some((node) => node.type === "button" && textContent(node) === "PC에 설정 적용"),
    false,
  );
});

test("should restrict setup to a live owned device in the selected room and preserve question-only navigation", () => {
  const states: unknown[] = [];
  let cursor = 0;
  const ui = loadUI("src/features/device-binding/connection-manager.tsx", {
    react: {
      useEffect() {},
      useRef: () => ({ current: null }),
      useState(initial: unknown) {
        const slot = cursor++;
        if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
        return [
          states[slot],
          (next: unknown) => {
            states[slot] = next;
          },
        ];
      },
    },
    "next/link": { default: "link" },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "./contracts": { messages: {} },
    "../../components/ui/button": { Button: "button" },
    "../../components/ui/input": { Input: "input" },
    "../runtime-settings/runtime-settings-form": { RuntimeSettingsForm: "settings-form" },
    "./local-connection-guide": { LocalConnectionGuide: "connection-guide" },
    "./local-connection-command": {
      consumeConnectionFragment() {
        return null;
      },
    },
    "../room-access/access.module.css": { default: {} },
  }).ConnectionManager as (props: unknown) => UINode;
  const future = new Date(Date.now() + 60000).toISOString();
  const past = new Date(Date.now() - 60000).toISOString();
  const owned = {
    deviceId,
    deviceAlias: "첫 Mac",
    organizationId: rootId,
    roomId: "first-room",
    state: "active",
    lastSeenAt: null,
    expiresAt: future,
  };
  const props = {
    origin: "https://example.com",
    userId: rootId,
    checkedAt: Date.now(),
    devices: [
      owned,
      { ...owned, deviceId: operationId, expiresAt: past },
      { ...owned, deviceId: agentId, state: "revoked" },
      { ...owned, deviceId: secondOperationId, deviceAlias: "다른 방 Mac", roomId: "second-room" },
    ],
    rooms: ["first-room", "second-room"].map((roomId) => ({
      roomId,
      organizationId: rootId,
      roomTitle: roomId,
      organizationName: "조직",
    })),
  };
  function render() {
    cursor = 0;
    return ui(props);
  }
  const first = render();
  assert.equal(nodes(first).filter((node) => node.type === "settings-form").length, 1);
  assert.equal(
    nodes(first).find((node) => node.type === "settings-form")!.props.deviceId,
    deviceId,
  );
  const panel = nodes(first).find((node) => node.props["aria-label"] === "본인 기기 AI 설정")!;
  const selects = nodes(panel).filter((node) => node.type === "select");
  assert.deepEqual(
    nodes(selects[1])
      .filter((node) => node.type === "option")
      .map((node) => node.props.value),
    [deviceId],
  );
  (selects[0].props.onChange as (event: unknown) => void)({ target: { value: "second-room" } });
  const second = render();
  assert.equal(
    nodes(second).find((node) => node.type === "settings-form")!.props.deviceId,
    secondOperationId,
  );
  assert.equal(
    nodes(second).some(
      (node) =>
        node.type === "link" && node.props.href === "/app" && textContent(node) === "질문만 하기",
    ),
    true,
  );
  assert.equal(
    nodes(second).some(
      (node) => node.type === "link" && node.props.href === "/app/rooms/second-room",
    ),
    true,
  );
});

test("should release a definitively rejected folder request and start with the refreshed revision", async () => {
  let selected = 0;
  let revision = 0;
  const requests: { action: string; body: Body }[] = [];
  const c = controller(
    async (action, body) => {
      requests.push({ action, body });
      if (action === "list") return response({ configRevision: revision });
      selected++;
      if (selected === 1) {
        revision = 1;
        throw new SettingsError("CONFLICT");
      }
      return response({
        configRevision: revision,
        operation: {
          ...operation("REQUESTED"),
          operationId: body.operationId as string,
          expectedConfigRevision: revision,
          requested: body,
        },
      });
    },
    (() => {
      let n = 0;
      return () => (n++ === 0 ? operationId : secondOperationId);
    })(),
  );
  try {
    await c.poll();
    c.setProvider("claude");
    await c.selectFolder();
    assert.equal(c.getSnapshot().reservedOperationId, null);
    await c.poll();
    await c.selectFolder();
    const second = requests.filter((item) => item.action === "select-folder")[1];
    assert.equal(second.body.expectedConfigRevision, 1);
    assert.equal(second.body.operationId, secondOperationId);
  } finally {
    c.stop();
  }
});

test("should observe the exact cleanup receipt hidden from a general list", async () => {
  let cleaned = false;
  const c = controller(async (action, body) => {
    if (action === "select-folder") return response({ operation: operation("REQUESTED") });
    if (!cleaned) return response();
    return body.operationId === operationId
      ? response({ operation: operation("CANCELLED") })
      : response();
  });
  try {
    await c.poll();
    c.setProvider("claude");
    await c.selectFolder();
    cleaned = true;
    await c.poll();
    assert.equal(c.getSnapshot().reservedOperationId, null);
    assert.equal(c.getSnapshot().response!.operation!.receipt!.state, "CANCELLED");
  } finally {
    c.stop();
  }
});

test("should echo owner receipt mode on apply while keeping the catalog selection unchanged", async () => {
  const calls: { action: string; body: Body }[] = [];
  let current = confirmed();
  current.operation!.receipt!.readMode = "AUTO_CODE";
  const c = controller(async (action, body) => {
    calls.push({ action, body });
    if (action === "select-runtime") {
      current = confirmed(catalog(), body);
      current.operation!.receipt!.readMode = "AUTO_CODE";
    }
    return current;
  });
  try {
    await c.poll();
    await c.selectRuntime();
    c.setSessionAlias("Session");
    await c.apply();
    assert.equal(
      Object.hasOwn(calls.find((call) => call.action === "select-runtime")!.body, "readMode"),
      false,
    );
    const apply = calls.find((call) => call.action === "apply")!.body;
    assert.equal(apply.readMode, "AUTO_CODE");
    assert.equal(apply.localRootReference, rootId);
    assert.equal(Object.hasOwn(apply, "rootIdentityHash"), false);
  } finally {
    c.stop();
  }
});

test("should label automatic code exploration only for an approved owner receipt", () => {
  const legacy = formTree(formView());
  assert.equal(textContent(legacy).includes("자동 탐색 · 답과 근거"), false);
  const automatic = confirmed();
  automatic.operation!.receipt!.readMode = "AUTO_CODE";
  assert.equal(
    textContent(formTree(formView({ response: automatic }))).includes("자동 탐색 · 답과 근거"),
    true,
  );
});

test("should keep the active connector and put manage only inside closed manual guidance", () => {
  const tree = formTree(formView());
  const manual = nodes(tree).find(
    (node) =>
      node.type === "details" &&
      nodes(node).some(
        (child) => child.type === "code" && textContent(child).includes("manage --profile"),
      ),
  )!;
  assert.ok(manual);
  assert.equal(manual.props.open, undefined);
  const outside = nodes(tree).filter((node) => node.type === "p" && !nodes(manual).includes(node));
  assert.ok(outside.some((node) => textContent(node).includes("터미널을 계속 열어")));
  assert.ok(outside.every((node) => !textContent(node).includes("manage --profile")));
});

test("should consume a known pairing fragment once without selecting approval", async () => {
  const states: unknown[] = [],
    effects: (() => unknown)[] = [];
  let cursor = 0,
    replaced = "",
    requests = 0;
  const roomId = deviceId,
    code = "a".repeat(64);
  const window = {
    location: { hash: `#code=${code}&room=${roomId}`, pathname: "/app/connections", search: "" },
    history: {
      state: null,
      replaceState(_a: unknown, _b: unknown, path: string) {
        replaced = path;
        window.location.hash = "";
      },
    },
  };
  const ui = loadUI(
    "src/features/device-binding/connection-manager.tsx",
    {
      react: {
        useEffect: (f: () => unknown) => effects.push(f),
        useRef: () => ({ current: null }),
        useState(initial: unknown) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = typeof initial === "function" ? initial() : initial;
          return [states[slot], (next: unknown) => (states[slot] = next)];
        },
      },
      "next/link": { default: "link" },
      "next/navigation": { useRouter: () => ({ refresh() {} }) },
      "./contracts": { messages: {} },
      "../../components/ui/button": { Button: "button" },
      "../../components/ui/input": { Input: "input" },
      "../runtime-settings/runtime-settings-form": { RuntimeSettingsForm: "settings-form" },
      "./local-connection-guide": { LocalConnectionGuide: "connection-guide" },
      "./local-connection-command": {
        consumeConnectionFragment: (hash: string) =>
          hash.includes(code) ? { roomId, code } : null,
      },
      "../room-access/access.module.css": { default: {} },
    },
    {
      window,
      queueMicrotask,
      fetch() {
        requests++;
        throw Error("must not approve automatically");
      },
    },
  ).ConnectionManager as (props: unknown) => UINode;
  const props = {
    devices: [],
    rooms: [{ roomId, organizationId: rootId, roomTitle: "방", organizationName: "조직" }],
    origin: "https://example.com",
    userId: rootId,
  };
  ui(props);
  effects[0]();
  await Promise.resolve();
  cursor = 0;
  const tree = ui(props);
  assert.equal(replaced, "/app/connections");
  assert.equal(window.location.hash, "");
  assert.equal(nodes(tree).find((node) => node.props.name === "code")?.props.value, code);
  const checkbox = nodes(tree).find((node) => node.props.type === "checkbox")!;
  assert.ok(checkbox);
  assert.equal(checkbox.props.checked, undefined);
  assert.equal(checkbox.props.defaultChecked, undefined);
  effects[0]();
  assert.equal(requests, 0);
});

test("should prepare a room-specific command and expose it when clipboard permission is denied", async () => {
  const states: unknown[] = [],
    effects: (() => unknown)[] = [],
    calls: string[] = [];
  let cursor = 0;
  const room = {
    roomId: deviceId,
    organizationId: rootId,
    roomTitle: "공유 방",
    organizationName: "조직",
  };
  const manifest = { version: 1, bootstrap: { sha256: "verified-digest" } },
    options: unknown[] = [];
  const field = {
    closest: () => ({ setAttribute: (name: string) => calls.push(name) }),
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
  };
  const ui = loadUI(
    "src/features/device-binding/local-connection-guide.tsx",
    {
      react: {
        useEffect: (f: () => unknown) => effects.push(f),
        useRef: () => ({ current: field }),
        useState(initial: unknown) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = initial;
          return [states[slot], (next: unknown) => (states[slot] = next)];
        },
      },
      "../../components/ui/button": { Button: "button" },
      "../../components/ui/input": { Input: "input" },
      "./local-connection-command": {
        connectionOrigin: (value: string) => value,
        parseConnectionManifest: () => manifest,
        localConnectionCommand: async (value: unknown) => {
          options.push(value);
          return "verified-connection-command";
        },
      },
    },
    {
      AbortController,
      setTimeout,
      clearTimeout,
      TextDecoder,
      Uint8Array,
      fetch: async () =>
        new Response(JSON.stringify(manifest), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      navigator: {
        clipboard: {
          writeText: async () => {
            throw Error("denied");
          },
        },
      },
    },
  ).LocalConnectionGuide as (props: unknown) => UINode;
  const props = {
    origin: "https://example.com",
    userId: rootId,
    rooms: [room],
    roomId: deviceId,
    onRoomChange() {},
  };
  ui(props);
  const cleanup = effects[0]() as () => void;
  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0;
  effects.length = 0;
  ui(props);
  effects[1]();
  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0;
  const tree = ui(props),
    button = nodes(tree).find((node) => node.type === "button")!;
  assert.equal(button.props.disabled, false);
  assert.equal(options.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(options[0])), {
    origin: props.origin,
    userId: rootId,
    roomId: deviceId,
    organizationId: rootId,
    deviceAlias: "내 Mac",
    manifest,
  });
  assert.equal(
    nodes(tree).find((node) => node.type === "textarea")?.props.value,
    "verified-connection-command",
  );
  await (button.props.onClick as () => Promise<void>)();
  assert.deepEqual(calls, ["open", "focus", "select"]);
  cursor = 0;
  assert.ok(
    nodes(ui(props)).some(
      (node) => node.props.role === "status" && node.props["aria-label"] === "연결 명령 복사 결과",
    ),
  );
  assert.ok(!nodes(tree).some((node) => node.props.type === "checkbox"));
  cursor = 0;
  const changed = ui({
    ...props,
    roomId: secondOperationId,
    rooms: [room, { ...room, roomId: secondOperationId }],
  });
  assert.equal(nodes(changed).find((node) => node.type === "button")?.props.disabled, true);
  assert.equal(nodes(changed).find((node) => node.type === "textarea")?.props.value, "");
  cleanup();
});
