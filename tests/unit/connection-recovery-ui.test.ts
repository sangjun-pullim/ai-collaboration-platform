import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as readiness from "../../src/features/device-binding/ai-readiness-controller.ts";
import * as recovery from "../../src/features/device-binding/connection-recovery-controller.ts";
import * as contracts from "../../src/features/device-binding/contracts.ts";
import * as intents from "../../src/features/investigation-coordinator/direct-intents.ts";
import { connectionSnapshot } from "../../src/features/device-binding/connection-presence.ts";

type Node = { type: unknown; props: Record<string, unknown> };
const nodes = (value: unknown): Node[] =>
  Array.isArray(value)
    ? value.flatMap(nodes)
    : value && typeof value === "object"
      ? [value as Node, ...nodes((value as Node).props?.children)]
      : [];
const text = (value: unknown): string =>
  Array.isArray(value)
    ? value.map(text).join(" ")
    : value && typeof value === "object"
      ? text((value as Node).props?.children)
      : String(value ?? "");
const fixture = JSON.parse(readFileSync("tests/fixtures/retirement-contracts.json", "utf8"));
const target: recovery.RecoveryTarget = {
  userId: fixture.retire.expectedUserId,
  roomId: fixture.history.roomId,
  deviceId: fixture.retire.operationId,
  deviceAlias: "원래 Mac",
  candidate: { ...fixture.history.recovery.candidate, canRetire: false, deviceRevoked: false },
};
function ui(path: string, name: string, replacements: Record<string, unknown>) {
  const slots: unknown[] = [];
  let cursor = 0;
  const effects: (() => (() => void) | void)[] = [];
  const exports: Record<string, (props: unknown) => Node> = {};
  const jsx = (type: unknown, props: Record<string, unknown>) => ({ type, props });
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  runInNewContext(source, {
    exports,
    Date,
    require: (dependency: string) => {
      if (dependency === "react/jsx-runtime") return { jsx, jsxs: jsx };
      if (dependency === "react")
        return {
          useState: (initial: unknown) => {
            const slot = cursor++;
            if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
            return [
              slots[slot],
              (value: unknown) => {
                slots[slot] = value;
              },
            ];
          },
          useRef: (current: unknown) => ({ current }),
          useEffect: (effect: () => (() => void) | void) => effects.push(effect),
        };
      if (dependency === "../../components/ui/button") return { Button: "button" };
      if (dependency in replacements) return replacements[dependency];
      throw new Error(`Unexpected recovery UI dependency ${dependency}`);
    },
  });
  return {
    render: (props: unknown) => {
      cursor = 0;
      effects.length = 0;
      return exports[name](props);
    },
    effects,
  };
}

test("should require device confirmation, reuse existing retirement controls and stop short of claiming recovery completion", () => {
  const actions: unknown[] = [];
  const controller = {
    revoke: (value: boolean) => {
      actions.push(value);
    },
    check() {},
    mutate() {},
    retryRetirement() {},
  };
  const f = ui(
    "src/features/device-binding/connection-recovery-panel.tsx",
    "ConnectionRecoveryPanel",
    {
      "../investigation-coordinator/request-retirement-controls": {
        RequestRetirementControls: "retirement-controls",
      },
    },
  );
  const props = {
    userId: target.userId,
    roomId: target.roomId,
    availableTarget: target,
    view: {
      ...new recovery.ConnectionRecoveryController().getSnapshot(),
      target,
      candidate: target.candidate,
      phase: "review",
      active: true,
    },
    controller,
    onOpen() {},
    onSelectTarget: (id: string) => actions.push(id),
    onPrepareApproval: () => actions.push("prepare"),
  };
  let tree = f.render(props);
  const confirm = () =>
    nodes(tree).find((node) => node.props.children === "확인한 기기만 연결 취소")!;
  assert.equal(confirm().props.disabled, true);
  const checkbox = nodes(tree).find((node) => node.props.type === "checkbox")!;
  (checkbox.props.onChange as (event: unknown) => void)({ target: { checked: true } });
  tree = f.render(props);
  assert.equal(confirm().props.disabled, false);
  (confirm().props.onClick as () => void)();
  assert.deepEqual(actions, [true]);
  props.view.phase = "retire-ready";
  props.view.candidate = { ...target.candidate, canRetire: true, deviceRevoked: true };
  tree = f.render(props);
  const controls = nodes(tree).find((node) => node.type === "retirement-controls")!;
  assert.equal(controls.props.candidate, props.view.candidate);
  assert.equal(controls.props.mutate, controller.mutate);
  assert.match(text(tree), /브라우저는 종료 여부를 확인할 수 없습니다/);
  props.view.phase = "retired";
  tree = f.render(props);
  assert.doesNotMatch(
    text(tree),
    /이전 결과를 확인할 수 없음|대상 방:|UNKNOWN 기록|연결 취소는 서버 인증/,
  );
  assert.ok(!nodes(tree).some((node) => String(node.props.className).includes("bg-amber-50")));
  assert.match(text(tree), /새 연결과 AI 설정·응답 준비 확인이 필요/);
  assert.doesNotMatch(text(tree), /복구 완료|실행 종료 확인 완료/);
  assert.ok(
    nodes(tree).find((node) => node.props.children === "원본을 보존하고 새 승인 명령 준비"),
  );
  props.view.active = false;
  tree = f.render(props);
  assert.equal(
    nodes(tree).find((node) => node.props.children === "원본을 보존하고 새 승인 명령 준비")!.props
      .disabled,
    true,
  );
  assert.equal(f.render({ ...props, userId: target.deviceId, availableTarget: null }), null);
});

test("should preserve the original target and block commands when revocation removes it from available devices", async () => {
  let revoked = false;
  const saved = new Map<string, string>();
  const controller = new recovery.ConnectionRecoveryController({
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => {
        saved.set(key, value);
      },
    },
    status: async (scope) => ({
      ...scope,
      device: {
        deviceId: target.deviceId,
        roomId: target.roomId,
        deviceAlias: target.deviceAlias,
        organizationId: target.userId,
        state: revoked ? "revoked" : "active",
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
      checkedAt: new Date().toISOString(),
      executionStatus: revoked
        ? null
        : {
            agentId: target.candidate.agentId,
            bindingEpoch: target.candidate.bindingEpoch,
            failure: null,
          },
    }),
    workflow: async () => {
      const page = structuredClone(fixture.history);
      page.recovery.candidate = { ...target.candidate, canRetire: revoked, deviceRevoked: revoked };
      return page;
    },
    revoke: async () => {
      revoked = true;
    },
  });
  const router = { refresh() {} };
  const f = ui("src/features/device-binding/connection-manager.tsx", "ConnectionManager", {
    "next/link": { default: "link" },
    "next/navigation": { useRouter: () => router },
    "./contracts": contracts,
    "../../components/ui/input": { Input: "input" },
    "../runtime-settings/runtime-settings-form": { RuntimeSettingsForm: "settings-form" },
    "./local-connection-guide": { LocalConnectionGuide: "guide" },
    "./connection-presence": { connectionSnapshot },
    "./local-connection-command": {},
    "../room-access/chat-shell": { ChatShell: "shell" },
    "./ai-readiness-controller": readiness,
    "./connection-recovery-controller": {
      ConnectionRecoveryController: class {
        constructor() {
          return controller;
        }
      },
    },
    "./connection-recovery-panel": { ConnectionRecoveryPanel: "recovery-panel" },
    "../room-access/access.module.css": { default: {} },
  });
  const props = {
    userId: target.userId,
    origin: "https://example.test",
    rooms: [
      {
        roomId: target.roomId,
        organizationId: target.userId,
        roomTitle: "원래 방",
        organizationName: "팀",
      },
    ],
    devices: [
      {
        deviceId: target.deviceId,
        deviceAlias: target.deviceAlias,
        roomId: target.roomId,
        organizationId: target.userId,
        state: "active",
        lastSeenAt: null,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    ],
  };
  let tree = f.render(props);
  const cleanup = f.effects[3]();
  try {
    (
      nodes(tree).find((node) => node.type === "recovery-panel")!.props.onOpen as (
        value: recovery.RecoveryTarget,
      ) => void
    )(target);
    await controller.revoke(true);
    props.devices[0].state = "revoked";
    props.devices.push({
      ...props.devices[0],
      deviceId: "00000000-0000-4000-8000-000000000020",
      deviceAlias: "새 Mac",
      state: "active",
    });
    tree = f.render(props);
    const panel = nodes(tree).find((node) => node.type === "recovery-panel")!;
    assert.equal((panel.props.view as recovery.RecoveryView).phase, "retire-ready");
    assert.equal((panel.props.view as recovery.RecoveryView).target?.deviceId, target.deviceId);
    assert.equal(
      nodes(tree).some((node) => node.type === "settings-form"),
      false,
    );
    assert.equal(nodes(tree).find((node) => node.type === "guide")!.props.disabled, true);
    const selector = nodes(tree).find((node) => node.props["aria-label"] === "설정할 본인 기기")!;
    assert.equal(selector.props.value, target.deviceId);
    assert.ok(
      nodes(selector).find(
        (node) => node.type === "option" && node.props.value === target.deviceId,
      ),
    );
  } finally {
    cleanup?.();
  }
});

for (const staleSelection of [false, true]) {
  test(`should reconcile the displayed new device before AI setup with a stale selection: ${staleSelection}`, async () => {
    const deviceId = "00000000-0000-4000-8000-000000000020";
    const device: contracts.OwnedDevice = {
      deviceId,
      deviceAlias: "새 Mac",
      roomId: target.roomId,
      organizationId: target.userId,
      state: "active",
      lastSeenAt: null,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const connected: readiness.ReadinessView = {
      ...new readiness.AiReadinessController().getSnapshot(),
      target: { expectedUserId: target.userId, roomId: target.roomId, deviceId },
      state: "complete",
      device,
    };
    const saved = new Map([
      [
        `connection-preserved-recovery:${target.userId}:${target.roomId}`,
        JSON.stringify({ target, retireIntent: fixture.retire, revokeAttempted: true }),
      ],
    ]);
    const reads: string[] = [];
    const selections: (string | null)[] = [];
    const reconciled: readiness.ReadinessView[] = [];
    const controller = new recovery.ConnectionRecoveryController({
      storage: {
        getItem: (key) => saved.get(key) ?? null,
        setItem: (key, value) => {
          saved.set(key, value);
        },
      },
      status: async (scope) => {
        reads.push(scope.deviceId);
        return {
          ...scope,
          device: { ...device, deviceId: target.deviceId, state: "revoked" },
          executionStatus: null,
          checkedAt: new Date().toISOString(),
        };
      },
      workflow: async (action) => {
        assert.equal(action, "read-recovery");
        const page = structuredClone(fixture.history);
        const { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt } = fixture.receipt;
        page.recovery.candidate = null;
        page.recovery.hasBlockingRuns = false;
        page.recovery.retirements = [
          { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt },
        ];
        page.recovery.nextRetirementCursor = sequence;
        page.recovery.highWaterRetirementSequence = sequence;
        return page;
      },
      revoke: async () => assert.fail("replacement reconciliation must only read"),
    });
    const originalReconcile = controller.reconcileReplacement.bind(controller);
    controller.reconcileReplacement = (view) => {
      reconciled.push(view);
      return originalReconcile(view);
    };
    const router = { refresh() {} };
    const f = ui("src/features/device-binding/connection-manager.tsx", "ConnectionManager", {
      "next/link": { default: "link" },
      "next/navigation": { useRouter: () => router },
      "./contracts": contracts,
      "../../components/ui/input": { Input: "input" },
      "../runtime-settings/runtime-settings-form": { RuntimeSettingsForm: "settings-form" },
      "./local-connection-guide": { LocalConnectionGuide: "guide" },
      "./connection-presence": { connectionSnapshot },
      "./local-connection-command": {},
      "../room-access/chat-shell": { ChatShell: "shell" },
      "./ai-readiness-controller": {
        ...readiness,
        AiReadinessController: class extends readiness.AiReadinessController {
          getSnapshot = () => connected;
          select(value: readiness.ReadinessView["target"]) {
            selections.push(value?.deviceId ?? null);
          }
        },
      },
      "./connection-recovery-controller": {
        ConnectionRecoveryController: class {
          constructor() {
            return controller;
          }
        },
      },
      "./connection-recovery-panel": { ConnectionRecoveryPanel: "recovery-panel" },
      "../room-access/access.module.css": { default: {} },
    });
    const props = {
      userId: staleSelection ? deviceId : target.userId,
      origin: "https://example.test",
      rooms: [
        {
          roomId: target.roomId,
          organizationId: target.userId,
          roomTitle: "방",
          organizationName: "팀",
        },
      ],
      devices: staleSelection ? [{ ...device, deviceId: target.deviceId }] : [device],
    };
    let tree = f.render(props);
    if (staleSelection) {
      const selector = nodes(tree).find((node) => node.props["aria-label"] === "설정할 본인 기기")!;
      (selector.props.onChange as (event: unknown) => void)({ target: { value: target.deviceId } });
      props.userId = target.userId;
      props.devices = [device];
      tree = f.render(props);
    }
    const selector = nodes(tree).find((node) => node.props["aria-label"] === "설정할 본인 기기")!;
    assert.equal(selector.props.value, deviceId);
    const readinessCleanup = f.effects[2]();
    const recoveryCleanup = f.effects[3]();
    try {
      f.effects[4]();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(selections.at(-1), deviceId);
      assert.equal(reconciled.length, 1);
      assert.equal(reconciled[0].target?.deviceId, deviceId);
      assert.equal(reconciled[0].ready, false);
      assert.equal(reconciled[0].binding, null);
      assert.equal(controller.getSnapshot().phase, "closed");
      assert.deepEqual(reads, [target.deviceId]);
      assert.equal(JSON.parse([...saved.values()][0]).replacementDeviceId, deviceId);
      tree = f.render(props);
      assert.doesNotMatch(text(tree), /AI 준비 완료/);
      assert.match(text(tree), /응답 준비 미확인/);
    } finally {
      readinessCleanup?.();
      recoveryCleanup?.();
    }
  });
}

test("should retain the original retirement dialog confirmation boundary and exact fields", async () => {
  const calls: unknown[] = [];
  const f = ui(
    "src/features/investigation-coordinator/request-retirement-controls.tsx",
    "RequestRetirementControls",
    {
      "./direct-intents": intents,
      "../../components/ui/dialog": {
        Dialog: "dialog",
        DialogContent: "dialog-content",
        DialogDescription: "dialog-description",
        DialogTitle: "dialog-title",
      },
    },
  );
  const props = {
    userId: target.userId,
    roomId: target.roomId,
    candidate: fixture.history.recovery.candidate,
    disabled: false,
    mutate: async (action: string, fields: unknown) => {
      calls.push({ action, fields });
      return true;
    },
  };
  let tree = f.render(props);
  const click = (label: string) =>
    (nodes(tree).find((node) => node.props.children === label)!.props.onClick as () => void)();
  click("이전 요청 정리");
  tree = f.render(props);
  assert.equal(calls.length, 0);
  click("이전 기록에 보관");
  await Promise.resolve();
  const { requestId, cycleId, attemptId, fence, agentId, bindingEpoch, roomRevision } =
    props.candidate;
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      {
        action: "retire",
        fields: {
          requestId,
          cycleId,
          attemptId,
          fence,
          agentId,
          bindingEpoch,
          expectedRoomRevision: roomRevision,
          confirmed: true,
        },
      },
    ]),
  );
  tree = f.render(props);
  click("이전 요청 정리");
  props.candidate = { ...props.candidate, fence: props.candidate.fence + 1 };
  tree = f.render(props);
  assert.equal(
    nodes(tree).find((node) => node.props.children === "이전 기록에 보관")!.props.disabled,
    true,
  );
});
