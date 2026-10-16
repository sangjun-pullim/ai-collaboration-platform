import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ConnectionRecoveryController,
  type RecoveryTarget,
} from "../../src/features/device-binding/connection-recovery-controller.ts";
import {
  projectResponse,
  WorkflowError,
  type RecoveryHistoryPage,
} from "../../src/features/investigation-coordinator/contracts.ts";
import type { ConnectionStatus } from "../../src/features/device-binding/connection-status-contracts.ts";
import {
  AiReadinessController,
  type ReadinessView,
} from "../../src/features/device-binding/ai-readiness-controller.ts";

const fixture = JSON.parse(readFileSync("tests/fixtures/retirement-contracts.json", "utf8"));
const target: RecoveryTarget = {
  userId: fixture.retire.expectedUserId,
  roomId: fixture.history.roomId,
  deviceId: fixture.retire.operationId,
  deviceAlias: "원래 Mac",
  candidate: { ...fixture.history.recovery.candidate, canRetire: false, deviceRevoked: false },
};
function harness() {
  let revoked = false;
  let retired = false;
  let revision = 1;
  const calls: { action: string; body: unknown }[] = [];
  const saved = new Map<string, string>();
  const faults = {
    revoke: false,
    retire: false,
    read: false,
    write: false,
    revokeApply: true,
    retireApply: true,
    retireConflict: false,
    waitStatus: undefined as Promise<void> | undefined,
    waitRetire: undefined as Promise<void> | undefined,
  };
  const overrides: { status?: ConnectionStatus; history?: RecoveryHistoryPage; receipt?: unknown } =
    {};
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (faults.write) throw new Error("storage unavailable");
      saved.set(key, value);
    },
  };
  const current = (): ConnectionStatus => ({
    expectedUserId: target.userId,
    roomId: target.roomId,
    deviceId: target.deviceId,
    device: {
      deviceId: target.deviceId,
      roomId: target.roomId,
      organizationId: target.userId,
      deviceAlias: target.deviceAlias,
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
  });
  const page = (): RecoveryHistoryPage => {
    const history = structuredClone(fixture.history);
    history.roomRevision = revision;
    history.cycle.roomRevision = revision;
    history.recovery.candidate = retired
      ? null
      : { ...target.candidate, roomRevision: revision, canRetire: revoked, deviceRevoked: revoked };
    if (retired) {
      const { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt } = fixture.receipt;
      history.recovery.retirements = [
        { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt },
      ];
      history.recovery.hasBlockingRuns = false;
      history.recovery.nextRetirementCursor = 1;
      history.recovery.highWaterRetirementSequence = 1;
    }
    return projectResponse("read-recovery", history) as RecoveryHistoryPage;
  };
  const dependencies = {
    status: async () => {
      await faults.waitStatus;
      if (faults.read) throw new Error("offline");
      return overrides.status ?? current();
    },
    workflow: async (action: string, body: unknown) => {
      calls.push({ action, body });
      if (faults.read) throw new Error("offline");
      if (action === "retire") {
        await faults.waitRetire;
        if (faults.retireConflict) {
          revision++;
          throw new WorkflowError("CONFLICT");
        }
        if (faults.retireApply) retired = true;
        if (faults.retire) throw new Error("response lost");
        return overrides.receipt ?? fixture.receipt;
      }
      return overrides.history ?? page();
    },
    revoke: async (body: unknown) => {
      calls.push({ action: "revoke", body });
      if (faults.revokeApply) revoked = true;
      if (faults.revoke) throw new Error("response lost");
    },
    storage,
    uuid: () => fixture.retire.operationId,
  };
  const controller = new ConnectionRecoveryController(dependencies);
  controller.setContext(target.userId, target.roomId, target.deviceId);
  controller.open(target);
  return {
    controller,
    calls,
    saved,
    faults,
    overrides,
    dependencies,
    current,
    page,
    setRevoked: (value: boolean) => {
      revoked = value;
    },
  };
}

test("should require explicit confirmation and preserve the exact original target across device disappearance", async () => {
  const h = harness();
  try {
    await h.controller.revoke(false);
    assert.equal(h.calls.length, 0);
    await h.controller.revoke(true);
    assert.equal(h.controller.getSnapshot().phase, "retire-ready");
    assert.equal(h.controller.getSnapshot().target?.deviceId, target.deviceId);
    assert.deepEqual(h.calls.find((call) => call.action === "revoke")?.body, {
      deviceId: target.deviceId,
    });
    assert.equal(h.controller.getSnapshot().candidate?.canRetire, true);
  } finally {
    h.controller.stop();
  }
});

test("should reconcile a lost revoke response without automatically revoking again", async () => {
  const h = harness();
  h.faults.revoke = true;
  try {
    await h.controller.revoke(true);
    assert.equal(h.controller.getSnapshot().phase, "retire-ready");
    await h.controller.check();
    assert.equal(h.calls.filter((call) => call.action === "revoke").length, 1);
  } finally {
    h.controller.stop();
  }
});

test("should use existing retire fields and recover a lost response from preserved retirement history", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    h.faults.retire = true;
    assert.equal(
      await h.controller.mutate("retire", { ...fixture.retire, operationId: undefined } as never),
      false,
    );
    const { protocol, roomId, operationId, expectedUserId, ...fields } = fixture.retire;
    void protocol;
    void roomId;
    void operationId;
    void expectedUserId;
    assert.equal(await h.controller.mutate("retire", fields), true);
    assert.equal(h.controller.getSnapshot().phase, "retired");
    assert.equal(h.calls.filter((call) => call.action === "retire").length, 1);
    assert.equal(
      h.controller.getSnapshot().target?.candidate.requestId,
      target.candidate.requestId,
    );
    assert.equal(
      h.calls.some((call) => ["ask", "start", "remove"].includes(call.action)),
      false,
    );
  } finally {
    h.controller.stop();
  }
});

function retirementFields() {
  const {
    requestId,
    cycleId,
    attemptId,
    fence,
    agentId,
    bindingEpoch,
    expectedRoomRevision,
    confirmed,
  } = fixture.retire;
  return {
    requestId,
    cycleId,
    attemptId,
    fence,
    agentId,
    bindingEpoch,
    expectedRoomRevision,
    confirmed,
  };
}

for (const field of [
  "requestId",
  "cycleId",
  "attemptId",
  "fence",
  "agentId",
  "bindingEpoch",
] as const)
  test(`should reject a changed ${field} before revoking any device`, async () => {
    const h = harness();
    const page = h.page();
    const candidate = page.recovery.candidate!;
    if (field === "fence" || field === "bindingEpoch") candidate[field]++;
    else candidate[field] = target.deviceId;
    h.overrides.history = page;
    try {
      assert.equal(await h.controller.revoke(true), false);
      assert.equal(h.calls.filter((call) => call.action === "revoke").length, 0);
      assert.equal(h.controller.getSnapshot().phase, "needs-check");
    } finally {
      h.controller.stop();
    }
  });

for (const mismatch of ["device", "user", "room", "binding", "owned"] as const)
  test(`should fail closed on ${mismatch} ownership or scope changes`, async () => {
    const h = harness();
    const status = h.current();
    const page = h.page();
    if (mismatch === "device") status.device.deviceId = target.candidate.agentId;
    if (mismatch === "user") status.expectedUserId = target.deviceId;
    if (mismatch === "room") page.roomId = target.deviceId;
    if (mismatch === "binding") status.executionStatus!.bindingEpoch++;
    if (mismatch === "owned") page.bindings[0].owned = false;
    h.overrides.status = status;
    h.overrides.history = page;
    try {
      await h.controller.revoke(true);
      assert.equal(
        h.calls.some((call) => call.action === "revoke"),
        false,
      );
    } finally {
      h.controller.stop();
    }
  });

test("should recheck an unapplied revoke without resending and require another explicit confirmation", async () => {
  const h = harness();
  h.faults.revokeApply = false;
  h.faults.revoke = true;
  try {
    assert.equal(await h.controller.revoke(true), false);
    assert.equal(h.controller.getSnapshot().phase, "needs-check");
    await h.controller.check();
    assert.equal(h.controller.getSnapshot().phase, "review");
    await h.controller.revoke(false);
    assert.equal(h.calls.filter((call) => call.action === "revoke").length, 1);
    h.faults.revokeApply = true;
    await h.controller.revoke(true);
    assert.equal(h.controller.getSnapshot().phase, "retire-ready");
  } finally {
    h.controller.stop();
  }
});

test("should preserve and explicitly retry the exact retirement operation after a lost unapplied response", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    h.faults.retire = true;
    h.faults.retireApply = false;
    assert.equal(await h.controller.mutate("retire", retirementFields()), false);
    assert.equal(h.controller.getSnapshot().phase, "retire-unconfirmed");
    await h.controller.check();
    assert.equal(h.calls.filter((call) => call.action === "retire").length, 1);
    h.faults.retireApply = true;
    assert.equal(await h.controller.retryRetirement(), true);
    const sent = h.calls.filter((call) => call.action === "retire");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(h.controller.getSnapshot().phase, "retired");
  } finally {
    h.controller.stop();
  }
});

test("should restore a revoked target from its journal without automatically reading or mutating", async () => {
  const h = harness();
  await h.controller.revoke(true);
  h.controller.stop();
  const restored = new ConnectionRecoveryController(h.dependencies);
  try {
    const before = h.calls.length;
    restored.setContext(target.userId, target.roomId, null);
    assert.equal(restored.getSnapshot().target?.deviceId, target.deviceId);
    assert.equal(restored.getSnapshot().phase, "needs-check");
    assert.equal(restored.getSnapshot().active, false);
    assert.equal(h.calls.length, before);
    restored.setContext(target.userId, target.roomId, target.deviceId);
    await restored.check();
    assert.equal(restored.getSnapshot().phase, "retire-ready");
    assert.equal(h.calls.filter((call) => call.action === "revoke").length, 1);
    assert.ok(
      h.calls
        .filter((call) => call.action === "read-recovery")
        .every(
          (call) => (call.body as { expectedUserId: string }).expectedUserId === target.userId,
        ),
    );
  } finally {
    restored.stop();
  }
});

test("should restore a pending retirement with its original operation and scope", async () => {
  const h = harness();
  await h.controller.revoke(true);
  h.faults.retire = true;
  h.faults.retireApply = false;
  await h.controller.mutate("retire", retirementFields());
  const original = h.calls.find((call) => call.action === "retire")!.body;
  h.controller.stop();
  const restored = new ConnectionRecoveryController(h.dependencies);
  try {
    restored.setContext(target.userId, target.roomId, target.deviceId);
    await restored.check();
    assert.equal(restored.getSnapshot().phase, "retire-unconfirmed");
    h.faults.retireApply = true;
    await restored.retryRetirement();
    assert.deepEqual(h.calls.filter((call) => call.action === "retire").at(-1)?.body, original);
  } finally {
    restored.stop();
  }
});

for (const change of ["user", "room", "device", "unmount"] as const)
  test(`should abort and discard late recovery reads after ${change} changes`, async () => {
    const h = harness();
    let release!: () => void;
    h.faults.waitStatus = new Promise<void>((resolve) => {
      release = resolve;
    });
    const revoke = h.controller.revoke(true);
    await Promise.resolve();
    if (change === "unmount") h.controller.stop();
    else
      h.controller.setContext(
        change === "user" ? target.deviceId : target.userId,
        change === "room" ? target.deviceId : target.roomId,
        change === "device" ? target.candidate.agentId : target.deviceId,
      );
    release();
    assert.equal(await revoke, false);
    assert.equal(
      h.calls.some((call) => call.action === "revoke"),
      false,
    );
    assert.equal(h.controller.getSnapshot().active, false);
    h.controller.stop();
  });

test("should bound requests, collapse duplicates and leave a clear result to recheck", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = harness();
  h.faults.waitStatus = new Promise(() => {});
  try {
    const first = h.controller.revoke(true);
    assert.equal(h.controller.revoke(true), first);
    await Promise.resolve();
    t.mock.timers.tick(10000);
    assert.equal(await first, false);
    assert.equal(h.controller.getSnapshot().phase, "needs-check");
    assert.equal(h.controller.getSnapshot().busy, false);
    assert.equal(
      h.calls.some((call) => call.action === "revoke"),
      false,
    );
  } finally {
    h.controller.stop();
  }
});

test("should persist before mutations and refuse a changed journal in another tab", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    const storageKey = [...h.saved.keys()][0];
    h.saved.set(storageKey, "changed by another tab");
    assert.equal(await h.controller.mutate("retire", retirementFields()), false);
    assert.equal(h.calls.filter((call) => call.action === "retire").length, 0);
    assert.equal(h.saved.get(storageKey), "changed by another tab");
  } finally {
    h.controller.stop();
  }
});

test("should keep revocation confirmation separate from permission to retire", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    const page = h.page();
    page.recovery.candidate!.canRetire = false;
    h.overrides.history = page;
    await h.controller.check();
    assert.equal(h.controller.getSnapshot().phase, "needs-check");
    assert.match(h.controller.getSnapshot().error!, /취소.*확인/);
    assert.equal(await h.controller.mutate("retire", retirementFields()), false);
    assert.equal(
      h.calls.some((call) => call.action === "retire"),
      false,
    );
  } finally {
    h.controller.stop();
  }
});

test("should never submit an unpersisted retirement even when the user retries", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    h.faults.write = true;
    assert.equal(await h.controller.mutate("retire", retirementFields()), false);
    assert.equal(await h.controller.retryRetirement(), false);
    assert.equal(h.calls.filter((call) => call.action === "retire").length, 0);
  } finally {
    h.controller.stop();
  }
});

test("should require fresh confirmation after a definitive retirement conflict and fresh server read", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    h.faults.retireConflict = true;
    assert.equal(await h.controller.mutate("retire", retirementFields()), false);
    assert.equal(h.controller.getSnapshot().phase, "retire-ready");
    assert.equal(h.controller.getSnapshot().candidate?.roomRevision, 2);
    assert.match(h.controller.getSnapshot().error!, /다시 확인한 뒤 정리를 승인/);
    assert.equal(await h.controller.retryRetirement(), false);
    assert.equal(h.calls.filter((call) => call.action === "retire").length, 1);
    h.faults.retireConflict = false;
    h.overrides.receipt = { ...fixture.receipt, roomRevision: 3 };
    assert.equal(
      await h.controller.mutate("retire", { ...retirementFields(), expectedRoomRevision: 2 }),
      true,
    );
  } finally {
    h.controller.stop();
  }
});

test("should never accept a retirement receipt for a different execution attempt", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    h.faults.retireApply = false;
    h.overrides.receipt = { ...fixture.receipt, attemptId: target.deviceId };
    assert.equal(await h.controller.mutate("retire", retirementFields()), false);
    assert.equal(h.controller.getSnapshot().phase, "retire-unconfirmed");
    assert.equal(
      h.controller.getSnapshot().target?.candidate.attemptId,
      target.candidate.attemptId,
    );
  } finally {
    h.controller.stop();
  }
});

test("should read later retirement pages before concluding that a preserved request is still unresolved", async () => {
  const h = harness();
  await h.controller.revoke(true);
  h.controller.stop();
  const cursors: unknown[] = [];
  const c = new ConnectionRecoveryController({
    ...h.dependencies,
    workflow: async (action, body) => {
      assert.equal(action, "read-recovery");
      assert.equal(body.expectedUserId, target.userId);
      cursors.push(body.afterRetirementSequence);
      const page = h.page();
      page.recovery.candidate = null;
      page.recovery.hasBlockingRuns = false;
      page.recovery.highWaterRetirementSequence = 33;
      const { requestId, cycleId, agentId, bindingEpoch, retiredAt } = fixture.receipt;
      page.recovery.retirements =
        body.afterRetirementSequence === 0
          ? Array.from({ length: 32 }, (_, index) => ({
              sequence: index + 1,
              requestId: `00000000-0000-4000-8000-${(100 + index).toString(16).padStart(12, "0")}`,
              cycleId,
              agentId,
              bindingEpoch,
              retiredAt,
            }))
          : [{ sequence: 33, requestId, cycleId, agentId, bindingEpoch, retiredAt }];
      page.recovery.nextRetirementCursor = body.afterRetirementSequence === 0 ? 32 : 33;
      page.recovery.hasMoreRetirements = body.afterRetirementSequence === 0;
      return page;
    },
  });
  try {
    c.setContext(target.userId, target.roomId, target.deviceId);
    assert.equal(await c.check(), true);
    assert.deepEqual(cursors, [0, 32]);
    assert.equal(c.getSnapshot().phase, "retired");
  } finally {
    c.stop();
  }
});

test("should finish the browser recovery only after a different owned device has current applied readiness", async () => {
  const h = harness();
  try {
    await h.controller.revoke(true);
    await h.controller.mutate("retire", retirementFields());
    const deviceId = "00000000-0000-4000-8000-000000000020";
    const ready: ReadinessView = {
      ...new AiReadinessController().getSnapshot(),
      target: { expectedUserId: target.userId, roomId: target.roomId, deviceId },
      binding: { agentId: deviceId, bindingEpoch: 1, configRevision: 1, applied: true },
      state: "complete",
      ready: true,
      selectedReady: true,
      device: { ...h.current().device, deviceId, state: "active" },
      validUntil: new Date(Date.now() + 60000).toISOString(),
    };
    h.controller.setContext(target.userId, target.roomId, deviceId);
    assert.equal(h.controller.completeReplacement({ ...ready, ready: false }), false);
    assert.equal(h.controller.completeReplacement({ ...ready, validUntil: null }), false);
    assert.equal(
      h.controller.completeReplacement({
        ...ready,
        binding: { ...ready.binding!, applied: false },
      }),
      false,
    );
    assert.equal(
      h.controller.completeReplacement({
        ...ready,
        validUntil: new Date(Date.now() - 1).toISOString(),
      }),
      false,
    );
    assert.equal(h.controller.completeReplacement(ready), true);
    assert.equal(h.controller.getSnapshot().phase, "closed");
    const journal = JSON.parse([...h.saved.values()][0]);
    assert.equal(journal.replacementDeviceId, deviceId);
    assert.equal(journal.target.candidate.requestId, target.candidate.requestId);
    const restored = new ConnectionRecoveryController(h.dependencies);
    try {
      restored.setContext(target.userId, target.roomId, deviceId);
      assert.equal(restored.getSnapshot().phase, "closed");
      assert.equal(restored.getSnapshot().target, null);
    } finally {
      restored.stop();
    }
    assert.equal(h.calls.filter((call) => call.action === "retire").length, 1);
  } finally {
    h.controller.stop();
  }
});
