import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AiReadinessController,
  readinessMessage,
  requestConnectionStatus,
  type SettingsBinding,
} from "../../src/features/device-binding/ai-readiness-controller.ts";
import {
  projectResponse,
  type RecoveryHistoryPage,
} from "../../src/features/investigation-coordinator/contracts.ts";
import { ConnectionError } from "../../src/features/device-binding/contracts.ts";
import {
  projectConnectionStatus,
  validateStatusRequest,
  type ConnectionStatus,
  type StatusRequest,
} from "../../src/features/device-binding/connection-status-contracts.ts";

const fixture = JSON.parse(readFileSync("tests/fixtures/retirement-contracts.json", "utf8"));
const target: StatusRequest = {
  expectedUserId: fixture.retire.expectedUserId,
  roomId: fixture.history.roomId,
  deviceId: fixture.retire.operationId,
};
const selected: SettingsBinding = {
  agentId: fixture.retire.agentId,
  bindingEpoch: fixture.retire.bindingEpoch,
  configRevision: 1,
  applied: true,
};
function history(): RecoveryHistoryPage {
  const page = structuredClone(fixture.history);
  page.recovery.candidate = null;
  page.recovery.hasBlockingRuns = false;
  page.runs = [];
  page.bindings = [
    {
      ...page.bindings[0],
      owned: true,
      agentId: selected.agentId,
      bindingEpoch: selected.bindingEpoch,
      reportedReady: true,
      validUntil: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
  return projectResponse("read-recovery", page) as RecoveryHistoryPage;
}
function status(t = target): ConnectionStatus {
  return {
    ...t,
    device: {
      deviceId: t.deviceId,
      roomId: t.roomId,
      organizationId: fixture.retire.cycleId,
      deviceAlias: "본인 Mac",
      state: "active",
      lastSeenAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    checkedAt: new Date().toISOString(),
    executionStatus: {
      agentId: selected.agentId,
      bindingEpoch: selected.bindingEpoch,
      failure: null,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(
  pc: ConstructorParameters<typeof AiReadinessController>[0] = async (t) => status(t),
  ai: ConstructorParameters<typeof AiReadinessController>[1] = async () => history(),
  timeoutMs = 10_000,
) {
  const controller = new AiReadinessController(pc, ai, timeoutMs);
  controller.start();
  controller.setBinding(selected);
  controller.select(target);
  controller.setBinding(selected);
  return controller;
}

test("should show checking then completed time and collapse repeated checks without polling", async () => {
  const waiting = deferred<ConnectionStatus>();
  let calls = 0;
  const c = setup(async () => {
    calls++;
    return waiting.promise;
  });
  try {
    assert.equal(c.getSnapshot().state, "checking");
    const check = c.check();
    assert.equal(c.check(), check);
    waiting.resolve(status());
    await check;
    assert.equal(calls, 1);
    assert.equal(c.getSnapshot().state, "complete");
    assert.equal(c.getSnapshot().ready, true);
    assert.ok(c.getSnapshot().checkedAt);
    await c.check();
    assert.equal(calls, 2);
    assert.equal(c.getSnapshot().ready, true);
  } finally {
    c.stop();
  }
});

for (const mismatch of [
  "epoch",
  "agent",
  "owner",
  "expired",
  "device",
  "account",
  "room",
  "revoked",
  "credential-expired",
  "not-applied",
] as const) {
  test(`should withhold readiness for ${mismatch} despite current APPLIED settings and recent PC traffic`, async () => {
    const page = history();
    const pc = status();
    if (mismatch === "epoch") page.bindings[0].bindingEpoch++;
    if (mismatch === "agent") page.bindings[0].agentId = target.deviceId;
    if (mismatch === "owner") page.bindings[0].owned = false;
    if (mismatch === "expired")
      page.bindings[0].validUntil = new Date(Date.now() - 1).toISOString();
    if (mismatch === "device") pc.device.deviceId = selected.agentId;
    if (mismatch === "account") pc.expectedUserId = target.deviceId;
    if (mismatch === "room") page.roomId = target.deviceId;
    if (mismatch === "revoked") pc.device.state = "revoked";
    if (mismatch === "credential-expired")
      pc.device.expiresAt = new Date(Date.now() - 1).toISOString();
    const c = setup(
      async () => pc,
      async () => page,
    );
    try {
      if (mismatch === "not-applied") c.setBinding({ ...selected, applied: false });
      await c.check();
      assert.equal(c.getSnapshot().ready, false);
    } finally {
      c.stop();
    }
  });
}

test("should separate a room blocker from selected device readiness and attribute only matching requests", async () => {
  const page = history();
  page.recovery.hasBlockingRuns = true;
  const c = setup(undefined, async () => page);
  try {
    await c.check();
    assert.equal(c.getSnapshot().selectedReady, true);
    assert.equal(c.getSnapshot().ready, false);
    assert.equal(c.getSnapshot().roomBlocked, true);
    assert.equal(c.getSnapshot().requestId, null);
    assert.match(readinessMessage(c.getSnapshot()), /이 방에 미확인 요청/);
    page.runs = [
      {
        ...fixture.history.runs[0],
        agentId: selected.agentId,
        bindingEpoch: selected.bindingEpoch,
        state: "UNKNOWN",
      },
    ];
    await c.check();
    assert.equal(c.getSnapshot().requestId, page.runs[0].requestId);
    assert.match(readinessMessage(c.getSnapshot()), /기록을 보존/);
    assert.doesNotMatch(readinessMessage(c.getSnapshot()), /SNAPSHOT_CHANGED|설정 검사 실패/);
    page.runs[0].bindingEpoch++;
    await c.check();
    assert.equal(c.getSnapshot().requestId, null);
  } finally {
    c.stop();
  }
});

test("should expose only a typed failure matching the current binding without inferring it from UNKNOWN", async () => {
  const pc = status();
  pc.executionStatus!.failure = { requestId: fixture.retire.requestId, reason: "SNAPSHOT_CHANGED" };
  const c = setup(async () => pc);
  try {
    await c.check();
    assert.equal(c.getSnapshot().ready, false);
    assert.match(readinessMessage(c.getSnapshot()), /AI에 전달되기 전 설정 검사 실패/);
    pc.executionStatus!.bindingEpoch++;
    await c.check();
    assert.equal(c.getSnapshot().failure, null);
    assert.equal(c.getSnapshot().selectedReady, false);
    assert.equal(c.getSnapshot().ready, false);
  } finally {
    c.stop();
  }
});

for (const race of ["newer epoch", "missing binding", "different agent"] as const) {
  test(`should withhold readiness for ${race} in current device status while settings and recovery still report epoch seven`, async () => {
    const page = history();
    page.bindings[0].bindingEpoch = 7;
    const pc = status();
    pc.executionStatus!.bindingEpoch = race === "newer epoch" ? 8 : 7;
    if (race === "missing binding") pc.executionStatus = null;
    if (race === "different agent") pc.executionStatus!.agentId = target.deviceId;
    const c = setup(
      async () => pc,
      async () => page,
    );
    try {
      c.setBinding({ ...selected, bindingEpoch: 7 });
      await c.check();
      assert.equal(c.getSnapshot().state, "complete");
      assert.equal(c.getSnapshot().selectedReady, false);
      assert.equal(c.getSnapshot().ready, false);
    } finally {
      c.stop();
    }
  });
}

test("should fail honestly when the migration is unavailable and discard a prior success", async () => {
  let unavailable = false;
  const c = setup(async () => {
    if (unavailable) throw new ConnectionError("UNAVAILABLE");
    return status();
  });
  try {
    await c.check();
    assert.equal(c.getSnapshot().ready, true);
    unavailable = true;
    await c.check();
    assert.equal(c.getSnapshot().ready, false);
    assert.equal(c.getSnapshot().state, "error");
    assert.equal(c.getSnapshot().device, null);
    assert.match(readinessMessage(c.getSnapshot()), /확인 실패/);
  } finally {
    c.stop();
  }
});

test("should retain PC evidence independently when only AI readiness fails", async () => {
  const c = setup(undefined, async () => {
    throw new ConnectionError("FORBIDDEN");
  });
  try {
    await c.check();
    assert.ok(c.getSnapshot().device);
    assert.equal(c.getSnapshot().ready, false);
    assert.equal(c.getSnapshot().error, "FORBIDDEN");
  } finally {
    c.stop();
  }
});

for (const change of ["selection", "binding", "unmount"] as const)
  test(`should abort and ignore late results on ${change}`, async () => {
    const late = deferred<ConnectionStatus>();
    let oldSignal: AbortSignal | undefined;
    const c = setup(async (_t, signal) => {
      oldSignal = signal;
      return late.promise;
    });
    const checking = c.check();
    await Promise.resolve();
    if (change === "selection") c.select({ ...target, deviceId: selected.agentId });
    if (change === "binding")
      c.setBinding({ ...selected, bindingEpoch: selected.bindingEpoch + 1 });
    if (change === "unmount") c.stop();
    assert.equal(oldSignal?.aborted, true);
    late.resolve(status());
    await checking;
    assert.equal(c.getSnapshot().ready, false);
    c.stop();
  });

test("should bound a stuck request at ten seconds even if the reader ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const c = setup(async () => new Promise(() => {}));
  try {
    const checking = c.check();
    await Promise.resolve();
    t.mock.timers.tick(10_000);
    await checking;
    assert.equal(c.getSnapshot().state, "error");
    assert.equal(c.getSnapshot().ready, false);
  } finally {
    c.stop();
  }
});

test("should invalidate expired readiness locally without another network request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const c = setup(async () => {
    calls++;
    return status();
  });
  try {
    await c.check();
    assert.equal(c.getSnapshot().ready, true);
    const checkedCalls = calls;
    t.mock.timers.tick(60_001);
    assert.equal(c.getSnapshot().state, "expired");
    assert.equal(c.getSnapshot().ready, false);
    assert.equal(calls, checkedCalls);
  } finally {
    c.stop();
  }
});

test("should strictly validate scope and strip private device and failure fields", () => {
  for (const input of [
    null,
    [],
    {},
    { ...target, secret: "hidden" },
    { ...target, expectedUserId: "unknown" },
  ])
    assert.throws(() => validateStatusRequest(input), { code: "INVALID_BODY" });
  assert.deepEqual(validateStatusRequest(target), target);
  const pc = status();
  const safe = projectConnectionStatus(
    {
      ...pc,
      credential: "hidden",
      device: { ...pc.device, credential: "hidden" },
      executionStatus: { ...pc.executionStatus, proofHash: "hidden" },
    },
    target,
  );
  assert.equal(JSON.stringify(safe).includes("hidden"), false);
  assert.throws(
    () =>
      projectConnectionStatus(
        {
          ...pc,
          executionStatus: {
            ...pc.executionStatus,
            failure: { requestId: fixture.retire.requestId, reason: "UNBOUNDED_REASON" },
          },
        },
        target,
      ),
    { code: "UNAVAILABLE" },
  );
});

test("should send the expected current user only through read-recovery without AI or mutation calls", async (t) => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true, data: history() });
    },
  );
  const c = new AiReadinessController(async (target) => status(target));
  c.start();
  c.select(target);
  c.setBinding(selected);
  try {
    await c.check();
    assert.deepEqual(requests, [
      {
        path: "/api/investigations/read-recovery",
        body: {
          protocol: 1,
          roomId: target.roomId,
          expectedUserId: target.expectedUserId,
          afterSequence: 0,
          afterRetirementSequence: 0,
        },
      },
    ]);
    assert.equal(c.getSnapshot().ready, true);
  } finally {
    c.stop();
  }
});

test("should not attribute a retired UNKNOWN run to a current room blocker", async () => {
  const page = history();
  page.runs = structuredClone(fixture.history.runs);
  page.recovery.hasBlockingRuns = true;
  page.recovery.retirements = [
    {
      sequence: 1,
      requestId: page.runs[0].requestId,
      cycleId: page.runs[0].cycleId,
      agentId: page.runs[0].agentId,
      bindingEpoch: page.runs[0].bindingEpoch,
      retiredAt: new Date().toISOString(),
    },
  ];
  const c = setup(undefined, async () => page);
  try {
    await c.check();
    assert.equal(c.getSnapshot().requestId, null);
    assert.match(readinessMessage(c.getSnapshot()), /이 방에 미확인 요청/);
  } finally {
    c.stop();
  }
});

test("should use a scoped no-store POST and reject invalid status responses", async (t) => {
  const expected = status();
  let response = Response.json({ ok: true, data: expected });
  const signal = new AbortController().signal;
  t.mock.method(
    globalThis,
    "fetch",
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(path, "/api/connections/status");
      assert.equal(init?.method, "POST");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.signal, signal);
      assert.deepEqual(JSON.parse(String(init?.body)), target);
      return response;
    },
  );
  assert.deepEqual(await requestConnectionStatus(target, signal), expected);
  response = Response.json({ ok: false, error: { code: "FORBIDDEN" } }, { status: 403 });
  await assert.rejects(() => requestConnectionStatus(target, signal), { code: "FORBIDDEN" });
  response = new Response("not JSON", { headers: { "Content-Type": "text/plain" } });
  await assert.rejects(() => requestConnectionStatus(target, signal), { code: "UNAVAILABLE" });
  response = Response.json({ ok: true, data: { ...status(), deviceId: selected.agentId } });
  await assert.rejects(() => requestConnectionStatus(target, signal), { code: "UNAVAILABLE" });
  response = Response.json({ ignored: "x".repeat(16_384) });
  await assert.rejects(() => requestConnectionStatus(target, signal), { code: "UNAVAILABLE" });
});

test("should expose recovery only for an owned candidate mapped to the exact selected device binding", async () => {
  const page = history();
  const pc = status();
  page.recovery.hasBlockingRuns = true;
  page.runs = structuredClone(fixture.history.runs);
  page.recovery.candidate = {
    ...fixture.history.recovery.candidate,
    canRetire: false,
    deviceRevoked: false,
  };
  const c = setup(
    async () => pc,
    async () => page,
  );
  try {
    await c.check();
    assert.equal(c.getSnapshot().candidate?.requestId, page.recovery.candidate!.requestId);
    pc.executionStatus!.bindingEpoch++;
    await c.check();
    assert.equal(c.getSnapshot().candidate, null);
    pc.executionStatus!.bindingEpoch--;
    page.bindings[0].owned = false;
    await c.check();
    assert.equal(c.getSnapshot().candidate, null);
  } finally {
    c.stop();
  }
});
