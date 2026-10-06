import test from "node:test";
import assert from "node:assert/strict";
import { InputAdmission } from "../src/workflow/input-admission.ts";
import type { InputState } from "../src/workflow-contracts.ts";
import { deferred } from "./runner-fixture.ts";
const id = "00000000-0000-4000-8000-000000000001";
const state = (revision = 1, paused = false): InputState => ({
  agentId: id,
  bindingEpoch: 1,
  revision,
  paused,
  appliedRevision: null,
  appliedEpoch: null,
  appliedAt: null,
});
const applied = (s: InputState) => ({
  ...s,
  appliedRevision: s.revision,
  appliedEpoch: s.bindingEpoch,
  appliedAt: new Date().toISOString(),
});
test("should start closed and require its exact current epoch ACK before opening", async () => {
  const gate = new InputAdmission(id, 1);
  assert.equal(gate.allowed, false);
  assert.equal(
    await gate.refresh(
      async () => state(),
      async (s) => applied(s),
    ),
    true,
  );
  assert.equal(
    await gate.refresh(
      async () => state(2, true),
      async (s) => applied(s),
    ),
    false,
  );
  assert.equal(
    await gate.refresh(
      async () => state(3),
      async (s) => applied(s),
    ),
    true,
  );
  assert.equal(
    await gate.refresh(
      async () => state(2, true),
      async (s) => applied(s),
    ),
    false,
  );
});
test("should coalesce read and ACK and reject a late response after closure", async () => {
  const gate = new InputAdmission(id, 1),
    pending = deferred<InputState>();
  let reads = 0,
    acks = 0;
  const read = () => {
    reads++;
    return pending.promise;
  };
  const ack = async (s: InputState) => {
    acks++;
    return applied(s);
  };
  const one = gate.refresh(read, ack),
    two = gate.refresh(read, ack);
  assert.equal(one, two);
  gate.close();
  pending.resolve(state());
  assert.equal(await one, false);
  assert.equal(reads, 1);
  assert.equal(acks, 0);
});
test("should close only input admission on failed or stale ACK and conflicting revisions", async () => {
  const gate = new InputAdmission(id, 1);
  assert.equal(
    await gate.refresh(
      async () => state(),
      async (s) => applied(s),
    ),
    true,
  );
  assert.equal(
    await gate.refresh(
      async () => state(),
      async () => {
        throw new Error("offline");
      },
    ),
    false,
  );
  assert.equal(
    await gate.refresh(
      async () => state(2),
      async () => applied(state(1)),
    ),
    false,
  );
  assert.equal(
    await gate.refresh(
      async () => state(2, true),
      async (s) => applied(s),
    ),
    false,
  );
  assert.equal(
    await gate.refresh(
      async () => ({ ...state(3), bindingEpoch: 2 }),
      async (s) => applied(s),
    ),
    false,
  );
});
test("should remain closed during an in-flight ACK and accept a later pause revision", async () => {
  const gate = new InputAdmission(id, 1),
    ack = deferred<InputState>();
  const work = gate.refresh(
    async () => state(),
    () => ack.promise,
  );
  await Promise.resolve();
  assert.equal(gate.allowed, false);
  ack.resolve(applied(state()));
  await work;
  assert.equal(
    await gate.refresh(
      async () => state(2, true),
      async (s) => applied(s),
    ),
    false,
  );
  assert.equal(
    await gate.refresh(
      async () => state(3),
      async (s) => applied(s),
    ),
    true,
  );
  assert.equal(
    await gate.refresh(
      async () => state(4, true),
      async (s) => applied(s),
    ),
    false,
  );
});
