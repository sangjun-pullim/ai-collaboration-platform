import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeFixture, appendFixtureCompletion, uuid } from "./runtime-fixture.ts";
import { capabilityHash } from "../src/settings/contracts.ts";
import { digest, stableJson, type RuntimeRecord } from "../src/runtime-contracts.ts";
import { collectSourceObservation } from "../src/workflow/source-snapshot.ts";

async function fixture(version: 1 | 2 = 1) {
  const f = await runtimeFixture();
  f.record.version = version;
  if (version === 2) {
    const cap = { ...f.settings.capabilities, runtime: "codex" as const };
    cap.snapshotHash = capabilityHash({
      runtime: "codex",
      version: cap.version,
      models: cap.models,
      defaultSettings: cap.defaultSettings,
      policy: "verified",
    });
    f.settings.capabilities = cap;
  }
  const a = appendFixtureCompletion(f.record);
  a.state = "SERVER_INTENT_CONFIRMED";
  a.native = null;
  a.terminal = null;
  a.receipt = null;
  f.record.context!.ownedTurns = [];
  f.record.context!.level = "L1";
  f.record.operations.pop();
  const operationId = uuid(),
    body = {
      protocol: 1,
      agentId: f.scope.agentId,
      bindingEpoch: 1,
      operationId,
      requestId: a.requestId,
      attemptId: a.snapshot!.attemptId,
      fence: 1,
    };
  f.record.operations.push({
    operationId,
    action: "start-intent",
    body,
    payloadHash: digest(stableJson({ action: "start-intent", body })),
    state: "CONFIRMED",
    result: structuredClone(a.snapshot),
  });
  const source = await collectSourceObservation(
    f.context.root,
    f.settings.files,
    () => {},
    new AbortController().signal,
    async () => {
      throw new Error("unavailable");
    },
  );
  return { ...f, a, source };
}
const invalid = (f: Awaited<ReturnType<typeof fixture>>, modify: (r: RuntimeRecord) => void) => {
  const bad = structuredClone(f.record);
  modify(bad);
  return assert.rejects(async () => f.store.write(bad), { code: "UNSAFE_STORAGE" });
};

test("should reject first-write observation insertion for both versions and preserve optional legacy bytes", async () => {
  for (const version of [1, 2] as const) {
    const f = await fixture(version);
    try {
      const forged = structuredClone(f.record);
      forged.attempts[0].state = "PROVIDER_INTENT";
      forged.attempts[0].sourceObservation = f.source;
      await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
      assert.equal(await f.store.read(), undefined);
      await f.store.write(f.record);
      assert.equal((await f.store.read())!.attempts[0].sourceObservation, undefined);
      f.a.state = "PROVIDER_INTENT";
      f.a.sourceObservation = f.source;
      await f.store.write(f.record);
      assert.deepEqual((await f.store.read())!.attempts[0].sourceObservation, f.source);
    } finally {
      await f.close();
    }
  }
});

test("should add once only at confirmed provider intent and reject forged generation epoch selection or start proof", async () => {
  for (const version of [1, 2] as const) {
    const f = await fixture(version);
    try {
      await f.store.write(f.record);
      await invalid(f, (r) => {
        r.attempts[0].sourceObservation = f.source;
      });
      await invalid(f, (r) => {
        r.attempts[0].state = "UNKNOWN";
        r.attempts[0].sourceObservation = f.source;
      });
      await invalid(f, (r) => {
        r.attempts[0].state = "PROVIDER_INTENT";
        r.attempts[0].generation = uuid();
        r.attempts[0].sourceObservation = f.source;
      });
      await invalid(f, (r) => {
        r.attempts[0].state = "PROVIDER_INTENT";
        r.attempts[0].scope.bindingEpoch++;
        r.attempts[0].sourceObservation = f.source;
      });
      await invalid(f, (r) => {
        r.attempts[0].state = "PROVIDER_INTENT";
        r.attempts[0].snapshot!.startIntentAt = null;
        r.attempts[0].sourceObservation = f.source;
      });
      await invalid(f, (r) => {
        r.attempts[0].state = "PROVIDER_INTENT";
        r.settings!.files = [];
        r.attempts[0].sourceObservation = f.source;
      });
      await invalid(f, (r) => {
        r.attempts[0].state = "PROVIDER_INTENT";
        r.attempts[0].sourceObservation = { ...f.source, observationHash: digest("forged") };
      });
      f.a.state = "PROVIDER_INTENT";
      f.a.sourceObservation = f.source;
      await f.store.write(f.record);
      await invalid(f, (r) => {
        delete r.attempts[0].sourceObservation;
      });
      await invalid(f, (r) => {
        r.attempts[0].sourceObservation!.git.ref = "changed";
      });
      await invalid(f, (r) => {
        r.attempts.push({
          ...structuredClone(f.a),
          requestId: uuid(),
          claimOperationId: uuid(),
          state: "CLAIM_PENDING",
          snapshot: null,
        });
      });
      f.a.state = "UNKNOWN";
      await f.store.write(f.record);
      assert.deepEqual((await f.store.read())!.attempts[0].sourceObservation, f.source);
    } finally {
      await f.close();
    }
  }
});

test("should reject unknown observation fields hashes order and size when reading retained journal bytes", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.record);
    f.a.state = "PROVIDER_INTENT";
    f.a.sourceObservation = f.source;
    await f.store.write(f.record);
    const original = await readFile(f.store.file);
    for (const mutate of [
      (r: RuntimeRecord) => Object.assign(r.attempts[0].sourceObservation!, { extra: true }),
      (r: RuntimeRecord) => Object.assign(r.attempts[0].sourceObservation!.files, { root: f.root }),
      (r: RuntimeRecord) => {
        r.attempts[0].sourceObservation!.files.entries.push({ ...f.source.files.entries[0] });
      },
      (r: RuntimeRecord) => {
        r.attempts[0].sourceObservation!.files.entries[0].hash = "b".repeat(64);
      },
    ]) {
      const bad = structuredClone(f.record);
      mutate(bad);
      await writeFile(f.store.file, JSON.stringify(bad));
      await assert.rejects(f.store.read(), { code: "UNSAFE_STORAGE" });
    }
    await writeFile(f.store.file, original);
    assert.deepEqual((await f.store.read())!.attempts[0].sourceObservation, f.source);
  } finally {
    await f.close();
  }
});

test("should preserve old generation observation without validating it against new selected files", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.record);
    f.a.state = "PROVIDER_INTENT";
    f.a.sourceObservation = f.source;
    await f.store.write(f.record);
    const old = structuredClone(f.record);
    old.context!.generation = uuid();
    old.context!.epoch = 2;
    old.scope.bindingEpoch = 2;
    old.settings!.files = [];
    // Existing bytes are historical read evidence, not a new observation creation.
    await writeFile(f.store.file, JSON.stringify(old));
    assert.deepEqual((await f.store.read())!.attempts[0].sourceObservation, f.source);
    await f.store.write(old);
  } finally {
    await f.close();
  }
});

test("should archive exact observation bytes and leave legacy completion observations absent", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.record);
    f.a.state = "PROVIDER_INTENT";
    f.a.sourceObservation = f.source;
    await f.store.write(f.record);
    const completed = structuredClone(f.record);
    completed.attempts = [];
    completed.operations = [];
    completed.context!.ownedTurns = [];
    const terminal = appendFixtureCompletion(completed);
    const source = structuredClone(f.source);
    terminal.sourceObservation = source;
    // A persisted archival fixture is accepted for read; first-write cannot create it.
    await writeFile(f.store.file, JSON.stringify(completed));
    const original = await readFile(f.store.file);
    const compact = await f.store.compact(completed);
    assert.deepEqual(
      await readFile(join(f.store.dir, "archives", f.scope.agentId, `${digest(original)}.json`)),
      original,
    );
    assert.deepEqual((await f.store.lastAttempt(compact))!.sourceObservation, source);
    assert.equal(JSON.stringify(compact.archives).includes("sourceObservation"), false);
    assert.equal(JSON.stringify(completed.operations).includes("sourceObservation"), false);
  } finally {
    await f.close();
  }
  const legacy = await runtimeFixture();
  try {
    appendFixtureCompletion(legacy.record);
    await legacy.store.write(legacy.record);
    const compact = await legacy.store.compact(legacy.record);
    assert.equal((await legacy.store.lastAttempt(compact))!.sourceObservation, undefined);
  } finally {
    await legacy.close();
  }
});
