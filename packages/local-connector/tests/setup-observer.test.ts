import test from "node:test";
import assert from "node:assert/strict";
import { SetupObserver, type SetupTransport } from "../src/settings/setup-observer.ts";
import { SettingsClient } from "../src/settings/client.ts";
import {
  validateObservation,
  type SetupReport,
  type ObservationResponse,
} from "../src/settings/setup-contracts.ts";
const identity = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  configRevision: 0,
};
const result = (body: SetupReport): ObservationResponse => ({
  sequence: body.sequence,
  observation: { ...body, receivedAt: new Date().toISOString() },
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
test("should resume sequence and coalesce only the newest actual stage", async () => {
  const stages: string[] = [],
    seq: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const send: SetupTransport = async (action, body) => {
    if (action === "settings-inspect") {
      await barrier;
      return result({ ...identity, stage: "FOLDER_SELECTION", reason: null, sequence: 4 });
    }
    const report = body as SetupReport;
    stages.push(report.stage);
    seq.push(report.sequence);
    return result(report);
  };
  const observer = new SetupObserver(identity, send);
  observer.report("SHARING_CONFIRMATION");
  observer.report("MODEL_DISCOVERY");
  observer.report("CANCELLING");
  release();
  await tick();
  await observer.stop();
  assert.deepEqual(stages, ["SHARING_CONFIRMATION", "CANCELLING"]);
  assert.deepEqual(seq, [5, 6]);
});
test("should skip failures and reread ambiguous sequence on a later real change", async () => {
  let reads = 0,
    writes = 0;
  const observer = new SetupObserver(identity, async (action, body) => {
    if (action === "settings-inspect") {
      reads++;
      return { sequence: 0, observation: null };
    }
    writes++;
    if (writes === 1) throw Error("private log");
    return result(body as SetupReport);
  });
  observer.report("MODEL_DISCOVERY");
  await tick();
  assert.equal(reads, 1);
  assert.equal(writes, 1);
  observer.report("FAILED", "PROVIDER_UNAVAILABLE");
  await tick();
  await observer.stop();
  assert.equal(reads, 2);
  assert.equal(writes, 2);
});
test("should stop pending work without permitting a new report", async () => {
  let release!: (value: ObservationResponse) => void,
    calls = 0;
  const observer = new SetupObserver(identity, async () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  observer.report("FOLDER_SELECTION");
  const stopping = observer.stop();
  observer.report("CANCELLING");
  release({ sequence: 0, observation: null });
  await stopping;
  assert.equal(calls, 1);
});
test("should reject private metadata and nonmonotonic sequence input", () => {
  for (const sequence of [0, -1, Infinity])
    assert.throws(() =>
      validateObservation("settings-report", {
        ...identity,
        stage: "APPLYING",
        reason: null,
        sequence,
      }),
    );
  assert.throws(() =>
    validateObservation("settings-report", {
      ...identity,
      stage: "FAILED",
      reason: "/Users/private",
      sequence: 1,
    }),
  );
});
test("should use bounded separate authenticated transport with redirects rejected", async () => {
  const calls: RequestInit[] = [];
  const client = new SettingsClient("https://example.com", async (input, init) => {
    assert.equal(input, "https://example.com/api/connection-setup/settings-inspect");
    calls.push(init!);
    return Response.json({ ok: true, data: { sequence: 0, observation: null } });
  });
  assert.deepEqual(await client.observe("settings-inspect", identity, "a".repeat(64)), {
    sequence: 0,
    observation: null,
  });
  assert.equal(calls[0].redirect, "error");
  assert.equal(
    (calls[0].headers as Record<string, string>).Authorization,
    "Bearer " + "a".repeat(64),
  );
});

test("should serialize a reentrant actual stage change and freeze operation identity", async () => {
  const mutable = { ...identity },
    calls: string[] = [];
  const observer: SetupObserver = new SetupObserver(mutable, async (action, body) => {
    assert.equal(body.deviceId, identity.deviceId);
    if (action === "settings-inspect") {
      observer.report("CANCELLING");
      return { sequence: 0, observation: null };
    }
    calls.push((body as SetupReport).stage);
    return result(body as SetupReport);
  });
  mutable.deviceId = "33333333-3333-4333-8333-333333333333";
  observer.report("FOLDER_SELECTION");
  await tick();
  await observer.stop();
  assert.deepEqual(calls, ["FOLDER_SELECTION", "CANCELLING"]);
});
