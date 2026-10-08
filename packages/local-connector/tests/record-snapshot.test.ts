import test from "node:test";
import assert from "node:assert/strict";
import { ownRuntimeRecord, isOwnedRuntimeRecord } from "../src/workflow/record-snapshot.ts";
import { runtimeFixture } from "./runtime-fixture.ts";

test("should own a recursively frozen record without retaining external nested aliases", async () => {
  const f = await runtimeFixture();
  try {
    const original = structuredClone(f.record),
      snapshot = ownRuntimeRecord(f.record);
    assert.deepEqual(snapshot, original);
    assert.notEqual(snapshot, f.record);
    assert.notEqual(snapshot.settings, f.record.settings);
    assert.notEqual(snapshot.settings!.requested, f.record.settings.requested);
    assert.equal(isOwnedRuntimeRecord(snapshot), true);
    assert.equal(isOwnedRuntimeRecord(f.record), false);
    assert.equal(ownRuntimeRecord(snapshot), snapshot);
    f.record.settings.requested.model = "External replacement";
    f.record.context.ownedTurns.push({
      turnId: "External turn",
      terminal: "COMPLETED",
    });
    assert.deepEqual(snapshot, original);
    assert.throws(() => {
      snapshot.settings!.requested.model = "In-place replacement";
    }, TypeError);
    assert.throws(() => {
      snapshot.context!.ownedTurns.push({
        turnId: "In-place turn",
        terminal: "COMPLETED",
      });
    }, TypeError);
    assert.equal(Object.isFrozen(snapshot.scope), true);
    assert.equal(Object.isFrozen(snapshot.settings!.capabilities.models), true);
    assert.equal(Object.isFrozen(snapshot.settings!.capabilities.models[0]), true);
    const work = structuredClone(snapshot);
    work.ready = true;
    assert.equal(work.ready, true);
    assert.equal(snapshot.ready, original.ready);
  } finally {
    await f.close();
  }
});

test("should reject a shallow frozen record as a cache key and freeze all children of its owned copy", async () => {
  const f = await runtimeFixture();
  try {
    const shallow = Object.freeze(f.record),
      snapshot = ownRuntimeRecord(shallow);
    assert.equal(isOwnedRuntimeRecord(shallow), false);
    assert.equal(isOwnedRuntimeRecord(structuredClone(snapshot)), false);
    assert.equal(Object.isFrozen(shallow.settings.requested), false);
    assert.equal(Object.isFrozen(snapshot.settings!.requested), true);
    const pending = f.store.write(snapshot);
    shallow.settings.requested.model = "Changed while persistence is pending";
    await pending;
    assert.equal(
      (await f.store.read())!.settings!.requested.model,
      snapshot.settings!.requested.model,
    );
    assert.equal(snapshot.settings!.requested.model, "test-a");
  } finally {
    await f.close();
  }
});
