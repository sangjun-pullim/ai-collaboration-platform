import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseDescription,
  validateSetupBody,
} from "../../src/features/connection-setup/contracts.ts";
import {
  SetupController,
  parseInspection,
} from "../../src/features/connection-setup/setup-controller.ts";
import { readConnectionSelection } from "../../src/features/device-binding/local-connection-command.ts";
const owner = "11111111-1111-4111-8111-111111111111",
  room = "22222222-2222-4222-8222-222222222222";
const inspection = {
  requestId: null,
  expiresAt: null,
  startup: null,
  settings: null,
  runtime: null,
  device: null,
};
test("should enforce a public description and reject secrets or forged lineage", async () => {
  const origin = "https://example.com";
  const description = {
    version: 1,
    origin,
    ownerUserId: owner,
    organizationId: owner,
    roomId: room,
    deviceAlias: "내 Mac",
    selection: await readConnectionSelection(null, origin, owner, room),
  };
  assert.deepEqual(await parseDescription(description), description);
  await assert.rejects(parseDescription({ ...description, token: "secret" }));
  await assert.rejects(
    parseDescription({
      ...description,
      selection: { ...description.selection, baseProfile: "web-" + "0".repeat(32) },
    }),
  );
});
test("should reject raw logs paths unknown stages and unsafe sequence values", () => {
  const report = {
    deviceId: owner,
    operationId: room,
    configRevision: 0,
    stage: "MODEL_DISCOVERY",
    reason: null,
    sequence: 1,
  };
  assert.deepEqual(validateSetupBody("settings-report", report), report);
  for (const body of [
    { ...report, stderr: "private" },
    { ...report, reason: "/Users/private" },
    { ...report, stage: "APPLIED" },
    { ...report, sequence: 0 },
  ])
    assert.throws(() => validateSetupBody("settings-report", body));
  assert.throws(() =>
    validateSetupBody("startup-report", {
      attemptId: owner,
      sequence: 1,
      stage: "APPLIED",
      reason: null,
    }),
  );
});
test("should keep public observation contract copies byte identical", () => {
  assert.equal(
    readFileSync("src/features/connection-setup/setup-contracts.ts", "utf8"),
    readFileSync("packages/local-connector/src/settings/setup-contracts.ts", "utf8"),
  );
});
test("should bound active observation to five minutes and permit manual checking", async () => {
  let time = 0,
    calls = 0;
  const c = new SetupController(
    { roomId: room, requestId: null, deviceId: null },
    async () => {
      calls++;
      return inspection;
    },
    () => time,
  );
  try {
    c.setVisible(false);
    c.start();
    await c.poll();
    assert.equal(calls, 0);
    time = 300001;
    c.setVisible(true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(c.getSnapshot().manual, true);
    assert.equal(calls, 0);
    await c.poll();
    assert.equal(calls, 1);
  } finally {
    c.stop();
  }
});
test("should serialize requests and discard a late response after stop", async () => {
  let release!: (value: unknown) => void,
    calls = 0;
  const c = new SetupController({ roomId: room, requestId: null, deviceId: null }, async () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  c.start();
  await c.poll();
  assert.equal(calls, 1);
  c.stop();
  release(inspection);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.getSnapshot().inspection, null);
});
test("should distinguish unavailable server from a legacy connector with no report", async () => {
  assert.deepEqual(parseInspection(inspection), inspection);
  const c = new SetupController({ roomId: room, requestId: null, deviceId: null }, async () => {
    throw Error("offline");
  });
  c.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.getSnapshot().error, true);
  c.stop();
});

test("should keep unauthenticated startup failure below current device authority", async () => {
  const { setupSummary } = await import("../../src/features/connection-setup/setup-controller.ts");
  const value = {
    ...inspection,
    startup: {
      attemptId: owner,
      sequence: 1,
      stage: "FAILED" as const,
      reason: "RUNTIME_BUSY" as const,
      receivedAt: new Date().toISOString(),
      authenticated: false as const,
    },
  };
  assert.match(setupSummary(value), /연결 시작에 실패/);
  assert.match(
    setupSummary({ ...value, device: { deviceId: owner, state: "active", authenticated: true } }),
    /기기 인증 확인/,
  );
  assert.match(setupSummary({ ...inspection, expiresAt: new Date(0).toISOString() }), /만료/);
});

test("should bound both issue and inspect fetches to ten seconds and preserve caller abort", async () => {
  const { requestSetup } = await import("../../src/features/connection-setup/setup-controller.ts");
  const originalFetch = globalThis.fetch,
    originalTimeout = AbortSignal.timeout;
  const requested: number[] = [];
  try {
    AbortSignal.timeout = (milliseconds: number) => {
      requested.push(milliseconds);
      return originalTimeout(5);
    };
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    for (const action of ["issue", "inspect"] as const) {
      const request = assert.rejects(requestSetup(action, {}));
      await Promise.all([request, new Promise((resolve) => setTimeout(resolve, 20))]);
    }
    const abort = new AbortController();
    const request = assert.rejects(requestSetup("inspect", {}, abort.signal));
    abort.abort();
    await request;
    assert.deepEqual(requested, [10000, 10000, 10000]);
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
});
test("should abort hidden inspection and ignore its late response", async () => {
  let signal: AbortSignal | undefined, release!: (value: unknown) => void;
  const c = new SetupController(
    { roomId: room, requestId: null, deviceId: null },
    async (_action, _body, incoming) => {
      signal = incoming;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  );
  c.start();
  c.setVisible(false);
  assert.equal(signal?.aborted, true);
  release(inspection);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.getSnapshot().inspection, null);
  c.stop();
});
