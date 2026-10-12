import test from "node:test";
import assert from "node:assert/strict";
import { reportConnectionHeartbeat } from "../src/settings/connection-heartbeat.ts";

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("should report connection presence without creating an AI input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  let calls = 0;
  const job = reportConnectionHeartbeat(async (signal) => {
    assert.equal(signal, abort.signal);
    calls++;
  }, abort.signal);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  abort.abort();
  await job;
  t.mock.timers.tick(90_000);
  await flush();
  assert.equal(calls, 2);
});

test("should serialize reports and wait for the owned request after abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  let release!: () => void;
  let calls = 0;
  let settled = false;
  const job = reportConnectionHeartbeat(async () => {
    calls++;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }, abort.signal).then(() => {
    settled = true;
  });
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(calls, 1);
  abort.abort();
  await flush();
  assert.equal(settled, false);
  release();
  await job;
  assert.equal(settled, true);
  assert.equal(calls, 1);
});

test("should wait after a failed report and skip an already aborted signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  let calls = 0;
  const job = reportConnectionHeartbeat(async () => {
    calls++;
    throw new Error("private credential and provider details");
  }, abort.signal);
  await flush();
  t.mock.timers.tick(29_999);
  await flush();
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls, 2);
  abort.abort();
  await job;
  await reportConnectionHeartbeat(async () => {
    calls++;
  }, abort.signal);
  assert.equal(calls, 2);
});
