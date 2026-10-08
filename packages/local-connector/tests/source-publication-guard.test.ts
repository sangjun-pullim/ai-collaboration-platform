import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeError, type RuntimeRecord } from "../src/runtime-contracts.ts";
import { ownRuntimeRecord } from "../src/workflow/record-snapshot.ts";
import { sourcePublicationGuard } from "../src/workflow/source-publication-guard.ts";
import { projectSourceManifest } from "../src/workflow/source-manifest.ts";
import { runnerFixture } from "./runner-fixture.ts";

async function guardFixture() {
  const f = await runnerFixture({
    sourceGitExecutor: async () => {
      throw new Error("Synthetic Git unavailable");
    },
  });
  try {
    f.queue();
    await f.runner().run({ once: true });
    const initial = ownRuntimeRecord((await f.store.read())!);
    let current = initial,
      checks = 0,
      reads = 0,
      projections = 0,
      liveError: RuntimeError | undefined,
      readError: RuntimeError | undefined;
    const source = projectSourceManifest(initial, initial.attempts[0])!;
    const guard = sourcePublicationGuard(
      { record: initial, journal: initial.attempts[0] },
      source,
      () => {
        checks++;
        if (liveError) throw liveError;
      },
      () => {
        reads++;
        if (readError) throw readError;
        return { record: current, journal: current.attempts[0] };
      },
      (record, journal) => {
        projections++;
        return projectSourceManifest(record, journal);
      },
    );
    return {
      initial,
      source,
      guard,
      close: f.close,
      counters: () => ({ checks, reads, projections }),
      replace: (record: RuntimeRecord, owned = true) => {
        current = owned ? ownRuntimeRecord(record) : record;
      },
      liveError: (error: RuntimeError) => {
        liveError = error;
      },
      readError: (error: RuntimeError) => {
        readError = error;
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test("should reuse source projection for an owned record while checking every transmission boundary", async () => {
  const f = await guardFixture();
  try {
    for (let i = 0; i < 2048; i++) f.guard();
    assert.deepEqual(f.counters(), { checks: 2048, reads: 2048, projections: 0 });
    const replacement = structuredClone(f.initial);
    replacement.ready = !replacement.ready;
    f.replace(replacement);
    for (let i = 0; i < 2048; i++) f.guard();
    assert.deepEqual(f.counters(), { checks: 4096, reads: 4096, projections: 1 });
  } finally {
    await f.close();
  }
});

test("should compare a replacement with original owned source bytes even if a caller retains the projection", async () => {
  const f = await guardFixture();
  try {
    f.source.bytes.fill(0);
    f.replace(structuredClone(f.initial));
    f.guard();
    assert.equal(f.counters().projections, 1);
  } finally {
    await f.close();
  }
});

test("should reject replaced source metadata and scope or fence changes without caching a failed record", async () => {
  const f = await guardFixture();
  try {
    for (const change of [
      (record: RuntimeRecord) => {
        record.scope.bindingEpoch++;
        record.attempts[0].scope.bindingEpoch++;
      },
      (record: RuntimeRecord) => {
        record.attempts[0].snapshot!.fence++;
      },
      (record: RuntimeRecord) => {
        delete record.attempts[0].sourceObservation;
      },
    ]) {
      const record = structuredClone(f.initial);
      change(record);
      f.replace(record);
      assert.throws(f.guard, { code: "AUTHORITY_LOST" });
      assert.throws(f.guard, { code: "AUTHORITY_LOST" });
    }
    assert.equal(f.counters().projections, 6);
    const invalid = structuredClone(f.initial);
    invalid.attempts[0].sourceObservation!.observationHash = "Invalid hash";
    f.replace(invalid);
    assert.throws(f.guard, { code: "INVALID_RUNTIME" });
  } finally {
    await f.close();
  }
});

test("should refuse mutable record cache keys and preserve live or missing-journal errors", async () => {
  const f = await guardFixture();
  try {
    f.replace(structuredClone(f.initial), false);
    assert.throws(f.guard, { code: "INVALID_RUNTIME" });
    assert.equal(f.counters().projections, 0);
    f.readError(new RuntimeError("UNKNOWN"));
    assert.throws(f.guard, { code: "UNKNOWN" });
    f.liveError(new RuntimeError("RUNTIME_CLOSED"));
    const reads = f.counters().reads;
    assert.throws(f.guard, { code: "RUNTIME_CLOSED" });
    assert.equal(f.counters().reads, reads);
  } finally {
    await f.close();
  }
});
