import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as readiness from "../../src/features/device-binding/ai-readiness-controller.ts";
import * as recovery from "../../src/features/device-binding/connection-recovery-controller.ts";
import { connectionSnapshot } from "../../src/features/device-binding/connection-presence.ts";
import { consumeConnectionFragment } from "../../src/features/device-binding/local-connection-command.ts";
import {
  connectionSelectionKey,
  readConnectionSelection,
} from "../../src/features/device-binding/local-connection-command.ts";
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
  const jsx = (type: unknown, props: Record<string, unknown>) => ({
    type,
    props: type === "setup-progress" ? { ...props, children: props.fallback } : props,
  });
  runInNewContext(source, {
    exports: exported,
    Date,
    ...globals,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (name === "../connection-setup/setup-controller" && path.includes("runtime-settings-form"))
        return {};
      if (name === "../connection-setup/setup-status")
        return { SetupStatus: "setup-status", SetupProgress: "setup-progress" };
      if (name === "./connection-presence") return { connectionSnapshot };
      if (name === "./connection-recovery-controller") return recovery;
      if (name === "./connection-recovery-panel")
        return { ConnectionRecoveryPanel: "recovery-panel" };
      if (
        name === "./ai-readiness-controller" ||
        name === "../device-binding/ai-readiness-controller"
      )
        return readiness;
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

test("should discover a terminal registration and show the approved room AI settings without reloading", async () => {
  const states: unknown[] = [],
    refs: { current: unknown }[] = [],
    effects: (() => unknown)[] = [];
  const timers = new Map<number, () => void>();
  let cursor = 0,
    refCursor = 0,
    refreshed = 0,
    timerId = 0,
    time = Date.now();
  const document = { visibilityState: "visible" };
  const ui = loadUI(
    "src/features/device-binding/connection-manager.tsx",
    {
      react: {
        useEffect: (effect: () => unknown) => effects.push(effect),
        useRef(initial: unknown) {
          return (refs[refCursor++] ??= { current: initial });
        },
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
      "next/navigation": {
        useRouter: () => ({
          refresh() {
            refreshed++;
          },
        }),
      },
      "./contracts": { messages: {} },
      "../../components/ui/button": { Button: "button" },
      "../../components/ui/input": { Input: "input" },
      "../runtime-settings/runtime-settings-form": { RuntimeSettingsForm: "settings-form" },
      "./local-connection-guide": { LocalConnectionGuide: "connection-guide" },
      "./local-connection-command": { consumeConnectionFragment },
      "../room-access/access.module.css": { default: {} },
      "../room-access/chat-shell": { ChatShell: "shell" },
    },
    {
      Date: class extends Date {
        static now() {
          return time;
        }
      },
      document,
      FormData: class {
        get(key: string) {
          return key === "confirmed" ? "on" : "a".repeat(64);
        }
      },
      async fetch(url: string, init: { body: string }) {
        assert.equal(url, "/api/connections/approve");
        assert.equal(JSON.parse(init.body).roomId, rootId);
        assert.equal(JSON.parse(init.body).confirmed, true);
        return {
          ok: true,
          async json() {
            return { ok: true, data: { deviceAlias: "내 Mac" } };
          },
        };
      },
      setInterval(fn: () => void) {
        timers.set(++timerId, fn);
        return timerId;
      },
      clearInterval(id: number) {
        timers.delete(id);
      },
    },
  ).ConnectionManager as (props: unknown) => UINode;
  const props = {
    devices: [] as {
      deviceId: string;
      deviceAlias: string;
      organizationId: string;
      roomId: string;
      state: string;
      lastSeenAt: string | null;
      expiresAt: string;
    }[],
    rooms: [deviceId, rootId].map((roomId) => ({
      roomId,
      organizationId: agentId,
      roomTitle: roomId,
      organizationName: "조직",
    })),
    origin: "https://example.com",
    userId: secondOperationId,
  };
  const render = () => {
    cursor = 0;
    refCursor = 0;
    effects.length = 0;
    return ui(props);
  };
  let tree = render();
  (
    nodes(tree).find((node) => node.props.name === "roomId")!.props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: rootId } });
  tree = render();
  const submit = nodes(tree).find((node) => node.type === "form")!.props.onSubmit as (
    event: unknown,
  ) => Promise<void>;
  await submit({ preventDefault() {}, currentTarget: { reset() {} } });
  assert.equal(refreshed, 1);
  const cleanup = effects[1]() as () => void;
  for (const tick of timers.values()) tick();
  assert.equal(refreshed, 2);
  document.visibilityState = "hidden";
  for (const tick of timers.values()) tick();
  assert.equal(refreshed, 2);
  document.visibilityState = "visible";
  props.devices.push({
    deviceId: operationId,
    deviceAlias: "내 Mac",
    organizationId: agentId,
    roomId: rootId,
    state: "active",
    lastSeenAt: null,
    expiresAt: new Date(time + 3600000).toISOString(),
  });
  cleanup();
  tree = render();
  assert.equal(
    nodes(tree).find((node) => node.type === "settings-form")?.props.deviceId,
    operationId,
  );
  const settingsPanel = nodes(tree).find((node) => node.props.id === "ai-settings")!;
  assert.ok(settingsPanel);
  assert.ok(
    nodes(tree).indexOf(settingsPanel) >
      nodes(tree).findIndex((node) => node.type === "connection-guide"),
  );
  const nextCleanup = effects[1]() as () => void;
  for (const tick of timers.values()) tick();
  assert.equal(refreshed, 2);
  await (nodes(tree).find((node) => node.type === "form")!.props.onSubmit as typeof submit)({
    preventDefault() {},
    currentTarget: { reset() {} },
  });
  assert.equal(refreshed, 3);
  time += 300001;
  for (const tick of timers.values()) tick();
  assert.equal(refreshed, 3);
  nextCleanup();
  tree = render();
  (nodes(tree).find((node) => node.type === "connection-guide")!.props.onLaunch as () => void)();
  const reconnectCleanup = effects[1]() as () => void;
  time += 300001;
  for (const tick of timers.values()) tick();
  tree = render();
  assert.doesNotMatch(textContent(tree), /기기 등록을 확인하지 못했습니다/);
  assert.equal(
    nodes(tree).find((node) => node.type === "settings-form")?.props.deviceId,
    operationId,
  );
  reconnectCleanup();
  tree = render();
  (nodes(tree).find((node) => node.type === "connection-guide")!.props.onLaunch as () => void)();
  const heartbeatCleanup = effects[1]() as () => void;
  props.devices.push({ ...props.devices[0], deviceId: secondOperationId, lastSeenAt: null });
  tree = render();
  (nodes(tree).find((node) => node.type === "connection-guide")!.props.onLaunch as () => void)();
  const beforeOtherHeartbeat = refreshed;
  props.devices[1].lastSeenAt = new Date(time + 1).toISOString();
  for (const tick of timers.values()) tick();
  assert.equal(
    refreshed,
    beforeOtherHeartbeat + 1,
    "another device must not end selected-device recheck",
  );
  const beforeHeartbeat = refreshed;
  props.devices[0].lastSeenAt = new Date(time + 1).toISOString();
  for (const tick of timers.values()) tick();
  assert.equal(refreshed, beforeHeartbeat, "same-ID heartbeat should end the independent recheck");
  assert.match(textContent(render()), /최근 Mac 통신 기록이 있습니다/);
  time += 300001;
  for (const tick of timers.values()) tick();
  assert.equal(refreshed, beforeHeartbeat);
  assert.doesNotMatch(textContent(render()), /기기 등록을 확인하지 못했습니다/);
  heartbeatCleanup();
  tree = render();
  (
    nodes(tree).find((node) => node.props["aria-label"] === "설정할 본인 기기")!.props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: "" } });
  tree = render();
  (nodes(tree).find((node) => node.type === "connection-guide")!.props.onLaunch as () => void)();
  const unselectedCleanup = effects[1]() as () => void;
  const beforeUnselectedHeartbeat = refreshed;
  props.devices[1].lastSeenAt = new Date(time + 1).toISOString();
  for (const tick of timers.values()) tick();
  assert.equal(
    refreshed,
    beforeUnselectedHeartbeat + 1,
    "an unselected device must not end communication recheck",
  );
  unselectedCleanup();
  assert.equal(timers.size, 0);
});
function formTree(
  view: SettingsView,
  onModel: (model: string) => void = () => {},
  props: Record<string, unknown> = {},
  onPoll: () => Promise<void> = async () => {},
  hooks?: {
    useState: (initial: unknown) => [unknown, (value: unknown) => void];
    selectFolder: () => void;
  },
) {
  const component = loadUI("src/features/runtime-settings/runtime-settings-form.tsx", {
    react: {
      useState: hooks?.useState ?? ((initial: unknown) => [initial, () => {}]),
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
        setModel = onModel;
        selectFolder = hooks?.selectFolder ?? (() => {});
        poll = onPoll;
        getSnapshot = () => view;
        subscribe() {}
      },
    },
  }).RuntimeSettingsForm as (props: unknown) => UINode;
  return component({ deviceId, deviceAlias: "본인 Mac", ...props });
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
    (node) => node.type === "button" && node.props["aria-label"] === "설정 저장",
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
    nodes(tree).some((node) => node.type === "button" && node.props["aria-label"] === "설정 저장"),
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
    "../room-access/chat-shell": { ChatShell: "shell" },
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
  assert.equal(
    nodes(first).find((node) => node.props.id === "mac-connection")!.props.hidden,
    false,
  );
  assert.equal(
    nodes(first).find((node) => node.type === "settings-form")!.props.connectionRecent,
    false,
  );
  const guide = nodes(first).find((node) => node.type === "connection-guide")!;
  assert.equal(guide.props.prominent, true);
  props.devices[0].lastSeenAt = new Date().toISOString() as unknown as null;
  const connected = render();
  assert.equal(
    nodes(connected).find((node) => node.props.id === "mac-connection")!.props.hidden,
    true,
  );
  assert.equal(
    nodes(connected).find((node) => node.type === "settings-form")!.props.connectionRecent,
    true,
  );
  assert.equal(
    nodes(connected).find((node) => node.type === "connection-guide")!.props.roomId,
    guide.props.roomId,
  );
  props.devices[0].lastSeenAt = null;
  // Expand pure local cards; imported components remain mocked by this harness.
  const renderedCards = nodes(first)
    .filter((node) => typeof node.type === "function")
    .map((node) => (node.type as (props: unknown) => UINode)(node.props));
  assert.deepEqual(
    nodes(renderedCards)
      .filter((node) => node.props["aria-label"] === "공개 연결 ID")
      .map(textContent),
    [deviceId, operationId, agentId, secondOperationId].map((id) => `연결 ID: ${id}`),
  );
  assert.equal(nodes(first).filter((node) => node.type === "settings-form").length, 1);
  assert.equal(
    nodes(first).find((node) => node.type === "settings-form")!.props.deviceId,
    deviceId,
  );
  const panel = nodes(first).find((node) => node.props["aria-label"] === "본인 기기 AI 설정")!;
  assert.equal(panel.props.id, "ai-settings");
  assert.ok(
    nodes(first).indexOf(panel) >
      nodes(first).findIndex((node) => node.type === "connection-guide"),
  );
  const selects = nodes(first).filter((node) => node.type === "select");
  assert.deepEqual(
    nodes(selects[1])
      .filter((node) => node.type === "option")
      .map((node) => node.props.value),
    [deviceId],
  );
  (selects[0].props.onChange as (event: unknown) => void)({ target: { value: "second-room" } });
  const second = render();
  assert.equal(
    nodes(second).find((node) => node.type === "connection-guide")!.props.roomId,
    "second-room",
  );
  assert.equal(
    nodes(second).find((node) => node.props.name === "roomId")!.props.value,
    "second-room",
  );
  assert.equal(nodes(second).filter((node) => node.props.name === "roomId").length, 1);
  assert.equal(
    nodes(second).find((node) => node.type === "settings-form")!.props.deviceId,
    secondOperationId,
  );
  assert.equal(
    nodes(second).some(
      (node) =>
        node.type === "link" &&
        node.props.href === "/app/rooms/second-room" &&
        textContent(node) === "연결 없이 질문만 하기",
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
      node.props.hidden === true &&
      nodes(node).some(
        (child) => child.type === "code" && textContent(child).includes("manage --profile"),
      ),
  )!;
  assert.ok(manual);
  assert.equal(manual.props.hidden, true);
  const outside = nodes(tree).filter((node) => node.type === "p" && !nodes(manual).includes(node));
  assert.ok(textContent(manual).includes("터미널을 계속 열어"));
  assert.ok(outside.every((node) => !textContent(node).includes("manage --profile")));
});

test("should consume pairing fragments without auto-approval and preserve successful approval after refresh", async () => {
  const states: unknown[] = [],
    effects: (() => unknown)[] = [];
  let cursor = 0,
    replaced = "",
    requests = 0;
  let explicitApproval = false;
  const roomId = deviceId,
    code = "a".repeat(64);
  const refs: { current: unknown }[] = [];
  let refCursor = 0;
  const listeners = new Set<() => void>();
  const confirmation = { checked: true };
  const window = {
    location: { hash: `#code=${code}&room=${roomId}`, pathname: "/app/connections", search: "" },
    addEventListener(name: string, listener: () => void) {
      assert.equal(name, "hashchange");
      listeners.add(listener);
    },
    removeEventListener(name: string, listener: () => void) {
      assert.equal(name, "hashchange");
      listeners.delete(listener);
    },
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
        useRef(initial: unknown) {
          const slot = refCursor++;
          return (refs[slot] ??= { current: initial });
        },
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
      "./local-connection-command": { consumeConnectionFragment },
      "../room-access/access.module.css": { default: {} },
      "../room-access/chat-shell": { ChatShell: "shell" },
    },
    {
      window,
      queueMicrotask,
      FormData: class {
        constructor(private form: { values: Record<string, string> }) {}
        get(name: string) {
          return this.form.values[name];
        }
      },
      fetch() {
        requests++;
        if (!explicitApproval) throw Error("must not approve automatically");
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, data: { deviceAlias: "내 Mac" } }),
        });
      },
    },
  ).ConnectionManager as (props: unknown) => UINode;
  const props = {
    devices: [],
    rooms: [roomId, rootId].map((roomId) => ({
      roomId,
      organizationId: rootId,
      roomTitle: "방",
      organizationName: "조직",
    })),
    origin: "https://example.com",
    userId: rootId,
    navigationRooms: [{ id: rootId }],
    returnRoomId: rootId,
  };
  window.location.hash = "#ai-settings";
  window.location.search = `?room=${rootId}`;
  const entry = ui(props);
  const entryPanel = nodes(entry).find((node) => node.props.id === "ai-settings")!;
  assert.ok(entryPanel);
  let entryFocus = 0,
    entryScroll = 0;
  (entryPanel.props.ref as { current: unknown }).current = {
    focus() {
      entryFocus++;
    },
    scrollIntoView() {
      entryScroll++;
    },
  };
  const entryCleanup = effects[0]() as () => void;
  assert.equal(window.location.hash, "#ai-settings");
  assert.equal(replaced, "");
  assert.equal(entryFocus, 1);
  assert.equal(entryScroll, 1);
  assert.equal(nodes(entry).find((node) => node.props.name === "roomId")!.props.value, rootId);
  entryCleanup();
  const repeatedEntryCleanup = effects[0]() as () => void;
  assert.equal(entryFocus, 1, "StrictMode must not take settings focus again");
  assert.equal(entryScroll, 1, "StrictMode must not reset settings scroll again");
  repeatedEntryCleanup();
  props.rooms = props.rooms.map((room) => ({ ...room }));
  cursor = 0;
  refCursor = 0;
  effects.length = 0;
  ui(props);
  const refreshedEntryCleanup = effects[0]() as () => void;
  assert.equal(entryFocus, 1, "a rooms refresh must retain the user's input focus");
  assert.equal(entryScroll, 1, "a rooms refresh must retain the user's scroll position");
  window.location.hash = "";
  for (const listener of listeners) listener();
  window.location.hash = "#ai-settings";
  for (const listener of listeners) listener();
  assert.equal(entryFocus, 2, "an actual settings hash change must still move focus");
  assert.equal(entryScroll, 2);
  refreshedEntryCleanup();
  window.location.hash = `#code=${code}&room=${roomId}`;
  window.location.search = "";
  cursor = 0;
  refCursor = 0;
  effects.length = 0;
  ui(props);
  refs[1].current = confirmation;
  const firstCleanup = effects[0]();
  assert.equal(typeof firstCleanup, "function");
  (firstCleanup as () => void)();
  const cleanup = effects[0]();
  await Promise.resolve();
  cursor = 0;
  refCursor = 0;
  const tree = ui(props);
  assert.equal(replaced, "/app/connections");
  assert.equal(window.location.hash, "");
  assert.equal(nodes(tree).find((node) => node.props.name === "code")?.props.value, code);
  const checkbox = nodes(tree).find((node) => node.props.type === "checkbox")!;
  assert.ok(checkbox);
  assert.equal(checkbox.props.checked, undefined);
  assert.equal(checkbox.props.defaultChecked, undefined);
  assert.equal(listeners.size, 1);
  assert.equal(confirmation.checked, false);
  assert.equal(nodes(tree).find((node) => node.type === "connection-guide")!.props.roomId, roomId);
  assert.equal(
    nodes(tree).find((node) => node.props["aria-label"] === "기기 승인 안내")!.props.hidden,
    false,
  );
  assert.equal(
    nodes(tree).find((node) => node.props["aria-label"] === "기기 승인")!.props.variant,
    "default",
  );
  const approval = nodes(tree).find((node) => node.props.id === "connection-approval")!;
  let approvalFocus = 0;
  (approval.props.ref as { current: unknown }).current = {
    focus() {
      approvalFocus++;
    },
    scrollIntoView() {},
  };
  effects[effects.length - 1]();
  assert.equal(approvalFocus, 1);

  const render = () => {
    cursor = 0;
    refCursor = 0;
    return ui(props);
  };
  const codeField = () => nodes(render()).find((node) => node.props.name === "code")!;
  const navigate = (hash: string) => {
    window.location.hash = hash;
    for (const listener of listeners) listener();
  };
  const settingsPanel = nodes(render()).find((node) => node.props.id === "ai-settings")!;
  assert.ok(settingsPanel);
  assert.equal(settingsPanel.props.tabIndex, -1);
  let focused = 0,
    scrolled = 0;
  (settingsPanel.props.ref as { current: unknown }).current = {
    focus() {
      focused++;
    },
    scrollIntoView() {
      scrolled++;
    },
  };
  confirmation.checked = true;
  const beforeAnchor = replaced;
  navigate("#ai-settings");
  await Promise.resolve();
  assert.equal(window.location.hash, "#ai-settings");
  assert.equal(replaced, beforeAnchor);
  assert.equal(focused, 1);
  assert.equal(scrolled, 1);
  assert.equal(codeField().props.value, code);
  assert.equal(confirmation.checked, true);
  const nextCode = "b".repeat(64);
  confirmation.checked = true;
  navigate(`#code=${nextCode}&room=${rootId}`);
  await Promise.resolve();
  assert.equal(window.location.hash, "");
  assert.equal(codeField().props.value, nextCode);
  assert.equal(nodes(render()).find((node) => node.props.name === "roomId")?.props.value, rootId);
  assert.equal(confirmation.checked, false);
  for (const hash of [
    `#code=${code}&room=${secondOperationId}`,
    `#code=malformed&room=${roomId}`,
    `#code=${code}&code=${code}&room=${roomId}`,
  ]) {
    confirmation.checked = true;
    navigate(hash);
    await Promise.resolve();
    assert.equal(window.location.hash, "");
    assert.equal(codeField().props.value, "");
    assert.equal(confirmation.checked, false);
  }
  navigate(`#code=${code}&room=${roomId}`);
  navigate(`#code=${nextCode}&room=${rootId}`);
  await Promise.resolve();
  assert.equal(codeField().props.value, nextCode);
  assert.equal(nodes(render()).find((node) => node.props.name === "roomId")?.props.value, rootId);
  (codeField().props.onChange as (event: unknown) => void)({ target: { value: nextCode } });
  navigate("");
  await Promise.resolve();
  assert.equal(codeField().props.value, nextCode);
  (codeField().props.onChange as (event: unknown) => void)({ target: { value: "" } });
  confirmation.checked = true;
  navigate(`#code=${nextCode}&room=${rootId}`);
  await Promise.resolve();
  assert.equal(window.location.hash, "");
  assert.equal(
    codeField().props.value,
    nextCode,
    "an unapproved link remains usable after editing",
  );
  assert.equal(confirmation.checked, false);
  (
    nodes(render()).find((node) => node.props.name === "roomId")!.props.onChange as (
      event: unknown,
    ) => void
  )({ target: { value: roomId } });
  navigate(`#code=${nextCode}&room=${rootId}`);
  await Promise.resolve();
  assert.equal(nodes(render()).find((node) => node.props.name === "roomId")!.props.value, rootId);
  assert.equal(codeField().props.value, nextCode);
  (codeField().props.onChange as (event: unknown) => void)({ target: { value: nextCode } });
  assert.equal(requests, 0);
  explicitApproval = true;
  const formNode = nodes(render()).find((node) => node.type === "form")!;
  await (formNode.props.onSubmit as (event: unknown) => Promise<void>)({
    preventDefault() {},
    currentTarget: { values: { code: nextCode, confirmed: "on" }, reset() {} },
  });
  assert.equal(codeField().props.value, "");
  navigate("#mac-connection");
  await Promise.resolve();
  navigate(`#code=${nextCode}&room=${rootId}`);
  await Promise.resolve();
  assert.equal(window.location.hash, "");
  assert.equal(
    codeField().props.value,
    "",
    "completed approval must survive intermediate navigation",
  );
  assert.match(
    textContent(nodes(render()).find((node) => node.props["aria-label"] === "Mac 연결 상태")),
    /yes/,
  );
  assert.equal(requests, 1);
  (codeField().props.onChange as (event: unknown) => void)({ target: { value: nextCode } });
  navigate(`#code=${code}&room=${roomId}`);
  assert.equal(typeof cleanup, "function");
  (cleanup as () => void)();
  await Promise.resolve();
  assert.equal(codeField().props.value, nextCode);
  assert.equal(listeners.size, 0);
  assert.equal(requests, 1);
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
    closest: () => ({
      set hidden(_value: boolean) {
        calls.push("reveal");
      },
    }),
    focus: () => calls.push("focus"),
    select: () => calls.push("select"),
  };
  const ui = loadUI(
    "src/features/device-binding/local-connection-guide.tsx",
    {
      react: {
        useEffect: (f: () => unknown) => effects.push(f),
        useRef(value: unknown) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = { current: value === null ? field : value };
          return states[slot];
        },
        useState(initial: unknown) {
          const slot = cursor++;
          if (!(slot in states)) states[slot] = initial;
          return [states[slot], (next: unknown) => (states[slot] = next)];
        },
      },
      "../connection-setup/setup-controller": {
        requestSetup: async () => ({
          created: true,
          key: "a".repeat(64),
          payloadHash: "b".repeat(64),
          expiresAt: new Date(Date.now() + 1800000).toISOString(),
        }),
      },
      "../../components/ui/button": { Button: "button" },
      "../../components/ui/input": { Input: "input" },
      "./local-connection-command": {
        connectionSelectionKey,
        readConnectionSelection,
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
      AbortSignal,
      crypto,
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
      window: {
        localStorage: { getItem: () => null },
        addEventListener() {},
        removeEventListener() {},
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
  const cleanup = effects[1]() as () => void;
  effects[0]();
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
  cursor = 0;
  effects.length = 0;
  ui(props);
  for (const effect of effects.slice(2)) effect();

  await new Promise((resolve) => setImmediate(resolve));
  cursor = 0;
  const tree = ui(props),
    button = nodes(tree).find((node) => node.type === "button")!;
  assert.equal(button.props.disabled, false);
  await (button.props.onClick as () => Promise<void>)();
  assert.equal(options.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(options[0])), {
    origin: props.origin,
    userId: rootId,
    roomId: deviceId,
    organizationId: rootId,
    deviceAlias: "내 Mac",
    manifest,
    selection: await readConnectionSelection(null, props.origin, rootId, deviceId),
    launch: { key: "a".repeat(64), payloadHash: "b".repeat(64) },
  });
  assert.equal(
    nodes(((cursor = 0), ui(props))).find((node) => node.type === "textarea")?.props.value,
    "verified-connection-command",
  );
  assert.deepEqual(calls, ["reveal", "focus", "select"]);
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

test("should render the native display name and retain the executable option value", () => {
  const named = catalog();
  Object.assign(named.models[0], { displayName: "Claude Native (context)" });
  let selected = "";
  const tree = formTree(formView({ response: confirmed(named) }), (model) => {
    selected = model;
  });
  const option = nodes(tree).find(
    (node) => node.type === "option" && node.props.value === "model-one",
  )!;
  assert.equal(textContent(option), "Claude Native (context) (model-one)");
  assert.equal(option.props.value, "model-one");
  const select = nodes(tree).find((n) => n.type === "select" && nodes(n).includes(option))!;
  (select.props.onChange as (event: unknown) => void)({ target: { value: option.props.value } });
  assert.equal(selected, "model-one");
  Object.assign(named.models[0], { displayName: "model-one" });
  const sameTree = formTree(formView({ response: confirmed(named) }));
  assert.equal(
    textContent(nodes(sameTree).find((n) => n.type === "option" && n.props.value === "model-one")!),
    "model-one",
  );
});

test("should use a native label for matching requested and applied settings identities only", () => {
  const c = catalog();
  c.models[0].displayName = "Native Claude";
  const selection = { model: "model-one", effort: null, snapshotHash: c.snapshotHash };
  const current = confirmed(c, selection);
  current.applied = {
    ...localReceipt("APPLIED"),
    runtime: "claude",
    ...selection,
    agentId,
    workspaceId: rootId,
    bindingEpoch: 7,
  };
  const tree = formTree(formView({ response: current }));
  for (const label of ["요청한 설정", "PC에 적용된 설정"])
    assert.match(
      textContent(nodes(tree).find((n) => n.props["aria-label"] === label)),
      /Native Claude \(model-one\)/,
    );
  current.applied.snapshotHash = "b".repeat(64);
  current.operation!.requested.snapshotHash = "b".repeat(64);
  const stale = formTree(formView({ response: current }));
  for (const label of ["요청한 설정", "PC에 적용된 설정"])
    assert.doesNotMatch(
      textContent(nodes(stale).find((n) => n.props["aria-label"] === label)),
      /Native Claude/,
    );
});

test("should provide executable reconnect navigation and keep cancellation locked while offline", () => {
  const pending = response({ operation: { ...operation("CANCELLED"), receipt: localReceipt() } });
  const tree = formTree(formView({ response: pending, draft: null }), undefined, {
    connectionRecent: false,
  });
  const reconnect = nodes(tree).find(
    (node) => node.props["aria-label"] === "Mac 연결 명령으로 이동",
  );
  assert.ok(reconnect);
  assert.equal(reconnect.props.href, "#mac-connection");
  assert.equal(nodes(tree).find((node) => node.type === "select")!.props.disabled, true);
  assert.equal(
    nodes(tree).find((node) => textContent(node) === "Mac에서 폴더 선택")!.props.disabled,
    true,
  );
  assert.match(textContent(tree), /기기를 제거할 필요/);
});

test("should use terminal inspection instead of another launch for recent cancellation", () => {
  const pending = response({ operation: { ...operation("CANCELLED"), receipt: localReceipt() } });
  const tree = formTree(formView({ response: pending, draft: null }), undefined, {
    connectionRecent: true,
  });
  assert.equal(
    nodes(tree).some((node) => node.props["aria-label"] === "Mac 연결 명령으로 이동"),
    false,
  );
  assert.equal(
    nodes(tree).find((node) => node.props.id === "settings-next-action")!.props["data-phase"],
    "cancellation",
  );
  assert.match(textContent(tree), /실행 중인 연결 터미널/);
  assert.equal(nodes(tree).find((node) => node.type === "select")!.props.disabled, true);
});

test("should keep applied settings separate from expired AI readiness and preserve regular chat navigation", () => {
  const applied = { ...localReceipt("APPLIED"), ...binding };
  const tree = formTree(
    formView({ response: response({ applied }), reservedOperationId: null, draft: null }),
    undefined,
    { roomHref: `/app/rooms/${rootId}`, aiReadiness: { state: "expired", ready: false } },
  );
  assert.equal(
    nodes(tree).some((node) => node.props["aria-label"] === "채팅 시작"),
    false,
  );
  assert.match(textContent(tree), /설정 저장됨/);
  assert.ok(nodes(tree).find((node) => node.props["aria-label"] === "일반 채팅으로 이동"));
});

test("should start AI chat only for the current applied binding and invalidate readiness at display time", () => {
  const applied = { ...localReceipt("APPLIED"), ...binding };
  const displayTime = Date.now();
  const aiReadiness = {
    ...new readiness.AiReadinessController().getSnapshot(),
    target: { expectedUserId: operationId, roomId: rootId, deviceId },
    binding: { agentId, bindingEpoch: 7, configRevision: 0, applied: true },
    state: "complete",
    ready: true,
    selectedReady: true,
    validUntil: new Date(displayTime + 1000).toISOString(),
  };
  const view = formView({
    response: response({ applied }),
    reservedOperationId: null,
    draft: null,
  });
  for (const [value, time, enabled] of [
    [aiReadiness, displayTime, true],
    [aiReadiness, displayTime + 1000, false],
    [{ ...aiReadiness, binding: { ...aiReadiness.binding, bindingEpoch: 8 } }, displayTime, false],
    [
      { ...aiReadiness, binding: { ...aiReadiness.binding, configRevision: 1 } },
      displayTime,
      false,
    ],
    [{ ...aiReadiness, target: { ...aiReadiness.target, deviceId: rootId } }, displayTime, false],
    [{ ...aiReadiness, roomBlocked: true, ready: false }, displayTime, false],
  ] as const) {
    const tree = formTree(view, undefined, {
      roomHref: `/app/rooms/${rootId}`,
      aiReadiness: value,
      displayTime: time,
    });
    assert.equal(
      nodes(tree).some((node) => node.props["aria-label"] === "채팅 시작"),
      enabled,
    );
    assert.ok(nodes(tree).some((node) => node.props["aria-label"] === "일반 채팅으로 이동"));
  }
});

test("should promote model confirmation then apply and keep applied settings separate", () => {
  const modelTree = formTree(formView());
  const modelButton = nodes(modelTree).find((node) => node.props["aria-label"] === "설정 저장")!;
  assert.ok(modelButton);
  assert.equal(modelButton.props.variant, "default");
  const c = catalog();
  const saved = confirmed(c, { model: "model-one", effort: null, snapshotHash: c.snapshotHash });
  const applyTree = formTree(formView({ response: saved }));
  const applyButton = nodes(applyTree).find((node) => node.props["aria-label"] === "설정 저장")!;
  assert.equal(applyButton.props.variant, "default");
  assert.equal(applyButton.props.disabled, false);
  const applied = {
    ...localReceipt("APPLIED"),
    ...binding,
    model: "model-one",
    sessionAlias: "내 AI",
    snapshotHash: c.snapshotHash,
  };
  const appliedTree = formTree(
    formView({ response: response({ applied }), reservedOperationId: null, draft: null }),
  );
  assert.equal(
    nodes(appliedTree).find((node) => node.props.id === "settings-next-action")!.props[
      "data-phase"
    ],
    "applied",
  );
  assert.ok(nodes(appliedTree).find((node) => node.props["aria-label"] === "PC에 적용된 설정"));
  assert.equal(
    nodes(appliedTree).some((node) => node.props["aria-label"] === "설정 저장"),
    false,
  );
});

test("should save one explicit intent with exactly select then apply", async () => {
  let current = confirmed();
  const calls: string[] = [];
  const c = controller(async (action, body) => {
    if (action !== "list") calls.push(action);
    if (action === "select-runtime") current = confirmed(catalog(), body);
    if (action === "apply") current = response({ operation: operation("APPLYING", body) });
    return current;
  });
  try {
    await c.poll();
    c.setSessionAlias("내 AI");
    await c.save();
    assert.deepEqual(calls, ["select-runtime", "apply"]);
  } finally {
    c.stop();
  }
});

for (const fault of ["lost-select", "binding", "lost-apply", "navigation", "double"] as const)
  test(`should stop or serialize an explicit save for ${fault}`, async () => {
    let current = confirmed();
    const calls: string[] = [];
    const selected = deferred<Response>();
    const c = controller(async (action, body) => {
      if (action !== "list") calls.push(action);
      if (action === "select-runtime") {
        current = confirmed(catalog(), body);
        if (fault === "lost-select") throw new SettingsError("UNAVAILABLE");
        if (fault === "binding")
          current = { ...current, currentBinding: { ...binding, bindingEpoch: 8 } };
        if (fault === "navigation" || fault === "double") return selected.promise;
      }
      if (action === "apply" && fault === "lost-apply") throw new SettingsError("UNAVAILABLE");
      return current;
    });
    try {
      await c.poll();
      c.setSessionAlias("내 AI");
      const saving = c.save();
      if (fault === "navigation") c.stop();
      if (fault === "double") await c.save();
      selected.resolve(current);
      await saving;
      if (fault === "lost-apply") {
        await c.poll();
        await c.save();
        assert.equal(calls.filter((x) => x === "apply").length, 1);
      } else assert.equal(calls.filter((x) => x === "apply").length, fault === "double" ? 1 : 0);
      assert.equal(calls.filter((x) => x === "select-runtime").length, 1);
    } finally {
      c.stop();
    }
  });
test("should resume confirmed selection only after a second explicit save", async () => {
  let current = confirmed(),
    lost = true;
  const calls: string[] = [];
  const c = controller(async (action, body) => {
    if (action !== "list") calls.push(action);
    if (action === "select-runtime") {
      current = confirmed(catalog(), body);
      if (lost) {
        lost = false;
        throw new SettingsError("UNAVAILABLE");
      }
    }
    if (action === "apply") current = response({ operation: operation("APPLYING", body) });
    return current;
  });
  try {
    await c.poll();
    c.setSessionAlias("내 AI");
    await c.save();
    assert.deepEqual(calls, ["select-runtime"]);
    await c.poll();
    assert.deepEqual(calls, ["select-runtime"]);
    await c.save();
    assert.deepEqual(calls, ["select-runtime", "apply"]);
  } finally {
    c.stop();
  }
});

test("should keep cancellation outside an in-flight save intent", async () => {
  let current = confirmed();
  const calls: string[] = [];
  const c = controller(async (action, body) => {
    if (action !== "list") calls.push(action);
    if (action === "select-runtime") current = confirmed(catalog(), body);
    if (action === "apply") current = response({ operation: operation("APPLYING", body) });
    return current;
  });
  try {
    await c.poll();
    c.setSessionAlias("내 AI");
    const remove = c.subscribe(() => {
      if (c.getSnapshot().busy === null) void c.cancel();
    });
    await c.save();
    remove();
    assert.deepEqual(calls, ["select-runtime", "apply"]);
  } finally {
    c.stop();
  }
});

test("should render actual observations only in the upper current phase", () => {
  const tree = formTree(
    formView({
      setupInspection: {
        requestId: null,
        expiresAt: null,
        startup: null,
        settings: {
          deviceId,
          operationId,
          configRevision: 0,
          sequence: 1,
          stage: "MODEL_DISCOVERY",
          reason: null,
          receivedAt: new Date().toISOString(),
        },
        runtime: confirmed(),
        device: { deviceId, state: "active", authenticated: true },
      },
    }),
  );
  const upper = nodes(tree).find((node) => node.props.id === "settings-next-action")!;
  const progress = nodes(tree).filter((node) => node.type === "setup-progress");
  assert.equal(progress.length, 1);
  assert.ok(nodes(upper).includes(progress[0]));
  assert.equal(progress[0].props.embedded, true);
  assert.equal(nodes(tree).filter((node) => node.props.role === "status").length, 1);
});

for (const terminal of ["APPLIED", "CANCELLED"] as const)
  test(`should clear lost apply only after proven ${terminal} and save a new folder operation`, async () => {
    let current = confirmed();
    const calls: string[] = [];
    const c = controller(
      async (action, body) => {
        if (action !== "list") calls.push(action);
        if (action === "select-runtime")
          current = { ...current, operation: { ...current.operation!, requested: body } };
        if (action === "apply" && body.operationId === operationId)
          throw new SettingsError("UNAVAILABLE");
        if (action === "select-folder")
          current = response({
            configRevision: terminal === "APPLIED" ? 1 : 0,
            operation: {
              ...operation("REQUESTED", body),
              operationId: secondOperationId,
              expectedConfigRevision: terminal === "APPLIED" ? 1 : 0,
              receipt: null,
            },
          });
        if (action === "apply" && body.operationId === secondOperationId)
          current = {
            ...current,
            operation: { ...current.operation!, state: "APPLYING", requested: body },
          };
        return current;
      },
      () => secondOperationId,
    );
    try {
      await c.poll();
      c.setSessionAlias("내 AI");
      await c.save();
      assert.equal(c.getSnapshot().applyUnconfirmed, true);
      const unproven = operation(terminal);
      unproven.receipt = localReceipt();
      current = response({ operation: unproven });
      await c.poll();
      assert.equal(c.getSnapshot().applyUnconfirmed, true);
      const receipt =
        terminal === "APPLIED"
          ? {
              ...localReceipt(terminal),
              ...binding,
              configRevision: 1,
              bindingEpoch: 8,
              model: "model-one",
              sessionAlias: "내 AI",
              snapshotHash: catalog().snapshotHash,
            }
          : localReceipt(terminal);
      current = response({
        configRevision: terminal === "APPLIED" ? 1 : 0,
        currentBinding: terminal === "APPLIED" ? { ...binding, bindingEpoch: 8 } : binding,
        operation: { ...operation(terminal), receipt },
        applied: terminal === "APPLIED" ? receipt : null,
      });
      await c.poll();
      assert.equal(c.getSnapshot().applyUnconfirmed, false);
      assert.equal(c.getSnapshot().saveError, null);
      await c.selectFolder();
      const next = current.operation!;
      current = {
        ...current,
        catalog: catalog(),
        operation: {
          ...next,
          state: "LOCAL_CONFIRMATION",
          receipt: {
            ...localReceipt(),
            operationId: secondOperationId,
            configRevision: current.configRevision,
          },
        },
      };
      await c.poll();
      const tree = formTree(c.getSnapshot());
      assert.equal(
        nodes(tree).find((node) => node.props["aria-label"] === "설정 저장")!.props.disabled,
        false,
      );
      await c.save();
      assert.equal(calls.filter((action) => action === "apply").length, 2);
    } finally {
      c.stop();
    }
  });

test("should expose and execute manual status recovery after an initial list failure", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let unavailable = true;
  const c = controller(async () => {
    if (unavailable) throw new SettingsError("UNAVAILABLE");
    return response();
  });
  try {
    await c.poll();
    t.mock.timers.setTime(301001);
    await c.poll();
    assert.equal(c.getSnapshot().pollManual, true);
    const tree = formTree(c.getSnapshot(), undefined, {}, () => c.poll());
    const button = nodes(tree).find(
      (node) => node.type === "button" && textContent(node) === "상태 다시 확인",
    );
    assert.ok(button);
    assert.equal(button.props.disabled, undefined);
    unavailable = false;
    await (button.props.onClick as () => Promise<void>)();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.getSnapshot().response?.current, true);
    assert.equal(c.getSnapshot().error, null);
  } finally {
    c.stop();
  }
});

test("should label ticket-only execution separately without turning a valid device into a failure", () => {
  const startup = {
    attemptId: operationId,
    sequence: 1,
    stage: "FAILED",
    reason: "RUNTIME_BUSY",
    receivedAt: new Date().toISOString(),
    authenticated: false,
  };
  const snapshot = {
    inspection: {
      requestId: operationId,
      expiresAt: new Date(Date.now() + 1800000).toISOString(),
      startup,
      settings: null,
      runtime: null,
      device: null,
    },
    checkedAt: Date.now(),
    error: false,
    manual: false,
  };
  let requested: unknown;
  const exports = loadUI("src/features/connection-setup/setup-status.tsx", {
    react: {
      useState: (initial: unknown) => [initial, () => {}],
      useMemo: (factory: () => unknown) => factory(),
      useEffect() {},
      useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
    },
    "../../components/ui/button": { Button: "button" },
    "./setup-controller": {
      SetupController: class {
        constructor(body: unknown) {
          requested = body;
        }
        subscribe() {}
        getSnapshot = () => snapshot;
      },
      setupSummary: () => "연결 시작에 실패했습니다",
    },
  });
  const component = exports.SetupStatus as (props: unknown) => UINode;
  const progress = component({ roomId: rootId, requestId: operationId });
  const renderProgress = exports.SetupProgress as (props: unknown) => UINode;
  const command = renderProgress(progress.props);
  assert.equal(command.props["aria-label"], "복사한 명령의 실행 상태");
  assert.match(textContent(command), /이번 명령 실행을 시작하지 못했습니다/);
  assert.match(textContent(command), /기기 연결 확인과 별도/);
  assert.doesNotMatch(textContent(command), /연결 시작에 실패했습니다/);
  assert.deepEqual(JSON.parse(JSON.stringify(requested)), {
    roomId: rootId,
    requestId: operationId,
    deviceId: null,
  });
  const valid = formTree(
    formView({ response: response(), reservedOperationId: null, draft: null }),
    undefined,
    { connectionRecent: true },
  );
  assert.doesNotMatch(textContent(valid), /연결 시작에 실패|RUNTIME_BUSY/);
});

test("should return to the applied summary after explicitly changing and reapplying a folder", () => {
  const applied = {
    ...localReceipt("APPLIED"),
    ...binding,
    model: "model-one",
    sessionAlias: "내 AI",
    snapshotHash: catalog().snapshotHash,
  };
  let view = formView({ response: response({ applied }), reservedOperationId: null, draft: null });
  const states: unknown[] = [];
  let cursor = 0,
    requests = 0;
  const hooks = {
    useState(initial: unknown): [unknown, (value: unknown) => void] {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [
        states[index],
        (value) => {
          states[index] = value;
        },
      ];
    },
    selectFolder() {
      requests++;
      view = formView({
        response: response({ applied, operation: operation("REQUESTED") }),
        draft: null,
      });
    },
  };
  const render = () => {
    cursor = 0;
    return formTree(view, undefined, {}, undefined, hooks);
  };
  const panel = (tree: UINode) =>
    nodes(tree).find((n) => n.props["aria-label"] === "AI와 폴더 선택")!;
  const click = (tree: UINode, label: string) => {
    const button = nodes(tree).find((n) => n.type === "button" && textContent(n) === label)!;
    assert.ok(button);
    assert.ok(!button.props.disabled);
    (button.props.onClick as () => void)();
  };
  assert.equal(panel(render()).props.hidden, true);
  click(render(), "AI·폴더 변경");
  assert.equal(panel(render()).props.hidden, false);
  click(render(), "Mac에서 폴더 선택");
  assert.equal(requests, 1);
  assert.equal(panel(render()).props.hidden, true);
  view = formView({ response: confirmed(), draft: null });
  assert.equal(panel(render()).props.hidden, true);
  view = formView({
    response: response({ applied: { ...applied, configRevision: 1 }, configRevision: 1 }),
    reservedOperationId: null,
    draft: null,
  });
  assert.equal(panel(render()).props.hidden, true);
  assert.ok(nodes(render()).some((n) => n.type === "button" && textContent(n) === "AI·폴더 변경"));
  assert.equal(requests, 1);
});

test("should offer explicit fresh approval only for the failed unauthenticated command", () => {
  const exports = loadUI("src/features/connection-setup/setup-status.tsx", {
    react: {},
    "../../components/ui/button": { Button: "button" },
    "./setup-controller": { setupSummary: () => "status" },
  });
  const render = exports.SetupProgress as (props: unknown) => UINode;
  let approvals = 0,
    retries = 0;
  const props = {
    commandOnly: true,
    onCheck() {},
    onFreshApproval() {
      approvals++;
    },
    onRetry() {
      retries++;
    },
    inspection: {
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      startup: { stage: "FAILED", reason: "UNAUTHENTICATED", receivedAt: new Date().toISOString() },
      device: null,
      settings: null,
    },
  };
  const tree = render(props);
  const buttons = nodes(tree).filter((n) => n.type === "button");
  const recovery = buttons.find((n) => textContent(n) === "새 승인으로 다시 연결");
  assert.ok(recovery);
  assert.ok(!buttons.some((n) => textContent(n) === "새 명령 복사"));
  assert.equal(approvals, 0);
  (recovery.props.onClick as () => void)();
  assert.equal(approvals, 1);
  assert.equal(retries, 0);
  for (const changed of [
    { commandOnly: false },
    {
      inspection: {
        ...props.inspection,
        startup: { ...props.inspection.startup, reason: "RUNTIME_BUSY" },
      },
    },
  ]) {
    assert.ok(
      !nodes(render({ ...props, ...changed })).some(
        (n) => n.type === "button" && textContent(n) === "새 승인으로 다시 연결",
      ),
    );
  }
});
