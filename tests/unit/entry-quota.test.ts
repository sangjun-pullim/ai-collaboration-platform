import test from "node:test";
import assert from "node:assert/strict";
import { waitForFixtureEntry } from "../helpers/entry-quota.js";

test("should enter immediately when the actual fixture quota has space", async () => {
  let waits = 0;
  await waitForFixtureEntry(
    async () => ({ active: 59, nextWaitMs: 5000 }),
    () => 0,
    async () => {
      waits++;
    },
  );
  assert.equal(waits, 0);
});
test("should wait for observed expiry without resetting the actual quota", async () => {
  let now = 0,
    reads = 0;
  const delays: number[] = [];
  await waitForFixtureEntry(
    async () => ({ active: ++reads < 3 ? 60 : 59, nextWaitMs: reads === 1 ? 3500 : 200 }),
    () => now,
    async (ms) => {
      delays.push(ms);
      now += ms;
    },
  );
  assert.deepEqual(delays, [1000, 225]);
  assert.equal(reads, 3);
});
test("should stop a continuously blocked owned fixture after a bounded wait", async () => {
  let now = 0;
  await assert.rejects(
    waitForFixtureEntry(
      async () => ({ active: 60, nextWaitMs: 1000 }),
      () => now,
      async (ms) => {
        now += ms;
      },
    ),
    /did not become available/,
  );
  assert.equal(now, 65000);
});
