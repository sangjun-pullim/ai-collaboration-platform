import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../src/state-store.ts";
import { RuntimeError, digest, stableJson } from "../src/runtime-contracts.ts";
import { capabilityHash, type Receipt } from "../src/settings/contracts.ts";
import {
  SettingsStore,
  type GenerationPointer,
  type SettingsState,
} from "../src/settings/store.ts";
import { runtimeFixture, uuid } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";

const unsafe = (e: unknown) => e instanceof RuntimeError && e.code === "UNSAFE_STORAGE";
const busy = (e: unknown) => e instanceof RuntimeError && e.code === "RUNTIME_BUSY";
async function fixture() {
  const f = await runtimeFixture();
  const profile = new StateStore(f.stateDir, "one");
  const store = new SettingsStore(profile);
  const settings = structuredClone(f.settings);
  settings.capabilities.runtime = "codex";
  const { snapshotHash: _hash, ...catalog } = settings.capabilities;
  void _hash;
  settings.capabilities.snapshotHash = capabilityHash({
    ...catalog,
    runtime: "codex",
    policy: "verified",
  });
  const operationId = uuid(),
    localRootReference = uuid();
  const state: SettingsState = {
    version: 1,
    server: f.scope.server,
    deviceId: f.scope.deviceId,
    organizationId: f.scope.organizationId,
    roomId: f.scope.roomId,
    current: null,
    retained: [],
    journal: {
      operation: {
        operationId,
        deviceId: f.scope.deviceId,
        expectedConfigRevision: 0,
        state: "APPLYING",
        requested: {
          operationId,
          deviceId: f.scope.deviceId,
          expectedConfigRevision: 0,
          runtime: "codex",
          ...settings.requested,
          snapshotHash: settings.capabilities.snapshotHash,
          localRootReference,
          repositoryAlias: "Repository",
          sessionAlias: "Session",
          expectedEpoch: null,
        },
        receipt: null,
      },
      phase: "PREPARE_INTENT",
      generation: f.context.generation,
      localRootReference,
      root: f.policy.root,
      settings,
      context: null,
      receipt: null,
      reason: null,
    },
  };
  const receipt = (status: Receipt["state"]): Receipt => ({
    operationId,
    state: status,
    configRevision: 1,
    runtime: settings.provider,
    ...settings.requested,
    snapshotHash: settings.capabilities.snapshotHash,
    localRootReference,
    repositoryAlias: "Repository",
    sessionAlias: "Session",
    catalog: null,
    bindingEpoch: 1,
    agentId: f.scope.agentId,
    workspaceId: uuid(),
  });
  return { ...f, profile, store, state, receipt };
}
function adopt(state: SettingsState, receipt: Receipt): GenerationPointer {
  return {
    generation: state.journal!.generation,
    agentId: receipt.agentId!,
    workspaceId: receipt.workspaceId!,
    bindingEpoch: receipt.bindingEpoch!,
    configRevision: receipt.configRevision,
    provider: receipt.runtime!,
    localRootReference: receipt.localRootReference!,
  };
}

test("should hold one settings device lock across the complete callback", async () => {
  const f = await fixture();
  try {
    await f.store.locked(async () => {
      await assert.rejects(
        new SettingsStore(f.profile).locked(async () => {}),
        busy,
      );
      await f.store.write(f.state);
      await assert.rejects(f.store.assertIdle(), busy);
    });
    await f.store.locked(async () => {});
    await assert.rejects(lstat(f.store.lockPath), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("should recover only a dead owned PID with the same lock identity", async () => {
  const f = await fixture();
  try {
    await f.store.read();
    await writeFile(
      f.store.lockPath,
      JSON.stringify({ pid: 2147483647, token: uuid(), identity: digest(f.store.file) }),
      { mode: 0o600 },
    );
    await f.store.locked(async () => {});
    for (const identity of [digest("foreign profile"), digest(f.store.file)]) {
      await writeFile(
        f.store.lockPath,
        JSON.stringify({ pid: process.pid, token: uuid(), identity }),
        { mode: 0o600 },
      );
      await assert.rejects(
        f.store.locked(async () => {}),
        identity === digest(f.store.file) ? busy : unsafe,
      );
      await unlink(f.store.lockPath);
    }
  } finally {
    await f.close();
  }
});

test("should refuse changed lock inode or token before releasing ownership", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.locked(async () => {
        await unlink(f.store.lockPath);
        await writeFile(
          f.store.lockPath,
          JSON.stringify({ pid: process.pid, token: uuid(), identity: digest(f.store.file) }),
          { mode: 0o600 },
        );
      }),
      unsafe,
    );
    assert.ok(await lstat(f.store.lockPath));
  } finally {
    await f.close();
  }
});

test("should refuse unsafe settings files and private directories", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.state);
    assert.equal((await lstat(f.store.file)).mode & 0o777, 0o600);
    assert.equal((await lstat(f.store.dir)).mode & 0o777, 0o700);
    await chmod(f.store.file, 0o644);
    await assert.rejects(f.store.read(), unsafe);
    await chmod(f.store.file, 0o600);
    const other = join(f.store.dir, "other.json");
    await link(f.store.file, other);
    await assert.rejects(f.store.read(), unsafe);
    await unlink(other);
    await unlink(f.store.file);
    await writeFile(other, JSON.stringify(f.state), { mode: 0o600 });
    await symlink(other, f.store.file);
    await assert.rejects(f.store.read(), unsafe);
    await unlink(f.store.file);
    await chmod(f.store.dir, 0o755);
    await assert.rejects(f.store.read(), unsafe);
  } finally {
    await f.close();
  }
});

test("should reject oversized malformed duplicate-key and non-UTF8 durable JSON", async () => {
  const f = await fixture();
  try {
    await f.store.read();
    for (const value of [
      " ".repeat(256 * 1024 + 1),
      "{",
      JSON.stringify({ ...f.state, credential: "private" }),
      JSON.stringify(f.state).replace('"version":1', '"version":1,"version":1'),
      JSON.stringify(f.state).replace('"version":1', '"version":1,'),
      Buffer.from([0xff]),
    ]) {
      await writeFile(f.store.file, value, { mode: 0o600 });
      await assert.rejects(f.store.read(), unsafe);
    }
  } finally {
    await f.close();
  }
});

test("should keep old settings and clean temporary files on cancellation or file sync failure", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.state);
    const before = await readFile(f.store.file);
    const next = structuredClone(f.state);
    next.journal!.phase = "PREPARED";
    next.journal!.context = f.context;
    const failure = new Error("sync failed");
    const faulty = new SettingsStore(f.profile, {
      beforeSync: async (stage) => {
        if (stage === "file") throw failure;
      },
    });
    await assert.rejects(faulty.write(next), (e) => e === failure);
    assert.deepEqual(await readFile(f.store.file), before);
    let cancelled = false;
    const cancellation = new SettingsStore(f.profile, {
      beforeSync: async () => {
        cancelled = true;
      },
    });
    await assert.rejects(
      cancellation.write(next, () => {
        if (cancelled) throw failure;
      }),
      (e) => e === failure,
    );
    assert.deepEqual(await readFile(f.store.file), before);
    assert.deepEqual(await readdir(f.store.dir), ["settings.json"]);
  } finally {
    await f.close();
  }
});

test("should report directory sync uncertainty while retaining the same durable candidate", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.state);
    const next = structuredClone(f.state);
    next.journal!.phase = "PREPARED";
    next.journal!.context = f.context;
    const faulty = new SettingsStore(f.profile, {
      beforeSync: async (stage) => {
        if (stage === "directory") throw new Error("directory sync failed");
      },
    });
    await assert.rejects(faulty.write(next), /directory sync failed/);
    assert.deepEqual(await f.store.read(), next);
    await assert.rejects(f.store.assertIdle(), busy);
    await f.store.write(next);
  } finally {
    await f.close();
  }
});

test("should freeze candidate root settings generation and context after their durable reservation", async () => {
  const f = await fixture();
  try {
    f.state.journal!.phase = "PREPARED";
    f.state.journal!.context = f.context;
    await f.store.write(f.state);
    for (const change of [
      (v: SettingsState) => {
        v.journal!.root!.ino++;
        v.journal!.context!.root.ino++;
      },
      (v: SettingsState) => {
        v.journal!.context!.threadId = uuid();
      },
      (v: SettingsState) => {
        v.journal!.context = null;
        v.journal!.phase = "PREPARE_INTENT";
      },
      (v: SettingsState) => {
        v.journal!.generation = uuid();
        v.journal!.context!.generation = v.journal!.generation;
      },
      (v: SettingsState) => {
        v.journal!.settings!.handoff = "Changed scope";
      },
      (v: SettingsState) => {
        v.journal!.settings!.files[0].path = ".env";
      },
    ]) {
      const next = structuredClone(f.state);
      change(next);
      await assert.rejects(async () => f.store.write(next), unsafe);
    }
  } finally {
    await f.close();
  }
});

test("should verify normalized capabilities and preserve a nullable Claude host reservation", async () => {
  const f = await fixture();
  try {
    const claude = claudeRecord(f.record);
    f.state.journal!.settings = claude.settings;
    f.state.journal!.context = claude.context;
    f.state.journal!.phase = "PREPARED";
    const caps = claude.settings!.capabilities;
    const { snapshotHash: _hash, ...catalog } = caps;
    void _hash;
    caps.snapshotHash = capabilityHash({ ...catalog, runtime: "claude", policy: "verified" });
    Object.assign(f.state.journal!.operation.requested, {
      runtime: "claude",
      ...claude.settings!.requested,
      snapshotHash: caps.snapshotHash,
    });
    await f.store.write(f.state);
    assert.equal((await f.store.read())!.journal!.context!.materialization!.initHash, null);
    const changed = structuredClone(f.state);
    changed.journal!.context!.threadId = uuid();
    await assert.rejects(async () => f.store.write(changed), unsafe);
    const invalid = structuredClone(f.state);
    invalid.journal!.settings!.capabilities.snapshotHash = digest("changed");
    await assert.rejects(async () => f.store.write(invalid), unsafe);
  } finally {
    await f.close();
  }
});

test("should keep UNKNOWN and commit intents unresolved until the same operation has closure proof", async () => {
  const f = await fixture();
  try {
    f.state.journal!.phase = "UNKNOWN";
    await f.store.write(f.state);
    const missing = structuredClone(f.state);
    missing.journal = null;
    await assert.rejects(async () => f.store.write(missing), unsafe);
    const foreign = structuredClone(f.state);
    foreign.journal!.operation.operationId = uuid();
    foreign.journal!.operation.requested.operationId = foreign.journal!.operation.operationId;
    await assert.rejects(async () => f.store.write(foreign), unsafe);
    f.state.journal!.phase = "CANCELLED";
    f.state.journal!.receipt = f.receipt("CANCELLED");
    await f.store.write(f.state);
    await f.store.assertIdle();
    await f.store.write(missing);
    f.state.journal!.phase = "COMMIT_INTENT";
    f.state.journal!.context = f.context;
    f.state.journal!.receipt = null;
    await f.store.write(f.state);
    await assert.rejects(f.store.assertIdle(), busy);
    await assert.rejects(async () => f.store.write(missing), unsafe);
  } finally {
    await f.close();
  }
});

test("should switch current pointers only with committed proof and append prior generations immutably", async () => {
  const f = await fixture();
  try {
    f.state.journal!.context = f.context;
    f.state.journal!.phase = "PREPARED";
    await f.store.write(f.state);
    const committed = f.receipt("COMMITTED");
    f.state.journal!.receipt = committed;
    f.state.journal!.phase = "LOCAL_COMMITTED";
    f.state.current = adopt(f.state, committed);
    await f.store.write(f.state);
    f.state.journal!.receipt = { ...committed, state: "APPLIED" };
    f.state.journal!.phase = "APPLIED";
    await f.store.write(f.state);
    await f.store.assertIdle();
    const oldPointer = structuredClone(f.state.current);
    const next = structuredClone(f.state);
    next.journal!.operation.operationId = uuid();
    next.journal!.operation.requested.operationId = next.journal!.operation.operationId;
    next.journal!.operation.receipt = null;
    next.journal!.receipt = null;
    next.journal!.phase = "PREPARED";
    next.journal!.generation = uuid();
    next.journal!.context!.generation = next.journal!.generation;
    await f.store.write(next);
    const second = {
      ...committed,
      operationId: next.journal!.operation.operationId,
      bindingEpoch: 2,
      configRevision: 2,
    };
    next.journal!.context!.epoch = 2;
    await assert.rejects(async () => f.store.write(next), unsafe);
    next.journal!.context!.epoch = 1;
    const sameEpoch = { ...second, bindingEpoch: 1, agentId: uuid() };
    next.journal!.receipt = sameEpoch;
    next.journal!.phase = "LOCAL_COMMITTED";
    next.current = adopt(next, sameEpoch);
    await assert.rejects(async () => f.store.write(next), unsafe);
    next.retained.push(oldPointer!);
    await f.store.write(next);
    const erased = structuredClone(next);
    erased.retained = [];
    await assert.rejects(async () => f.store.write(erased), unsafe);
    const rewritten = structuredClone(next);
    rewritten.retained[0].bindingEpoch++;
    await assert.rejects(async () => f.store.write(rewritten), unsafe);
  } finally {
    await f.close();
  }
});

test("should isolate generation records while leaving legacy runtime bytes untouched", async () => {
  const f = await fixture();
  try {
    await f.store.read();
    await f.store.locked(async () => {});
    const legacy = f.record;
    const oldStore = new (await import("../src/runtime-store.ts")).RuntimeStore(
      f.stateDir,
      "one",
      f.scope.agentId,
    );
    await oldStore.write(legacy);
    const bytes = await readFile(oldStore.file);
    const generated = f.store.generationStore(f.scope.agentId, f.context.generation);
    await generated.write(legacy);
    assert.ok(generated.file.startsWith(join(f.store.dir, "generations", f.context.generation)));
    assert.deepEqual(await readFile(oldStore.file), bytes);
    assert.deepEqual(await generated.read(), legacy);
    await assert.rejects(
      async () => f.store.generationStore(f.scope.agentId, "../../legacy"),
      unsafe,
    );
  } finally {
    await f.close();
  }
});

test("should retain the settings lock when owned provider cleanup is incomplete", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.store.locked(async () => {
        throw new RuntimeError("CLEANUP_INCOMPLETE");
      }),
      (e: unknown) => e instanceof RuntimeError && e.code === "CLEANUP_INCOMPLETE",
    );
    await assert.rejects(
      f.store.locked(async () => {}),
      busy,
    );
  } finally {
    await f.close();
  }
});

test("should preserve a separate immutable Claude catalog reservation before settings selection", async () => {
  const f = await fixture();
  try {
    const catalogContext = claudeRecord(f.record).context!;
    f.state.journal!.phase = "CATALOG_INTENT";
    f.state.journal!.settings = null;
    f.state.journal!.catalogContext = catalogContext;
    await f.store.write(f.state);
    const changed = structuredClone(f.state);
    changed.journal!.catalogContext!.threadId = uuid();
    await assert.rejects(async () => f.store.write(changed), unsafe);
    const materialized = structuredClone(f.state);
    materialized.journal!.catalogContext!.materialization!.state = "MATERIALIZED";
    materialized.journal!.catalogContext!.materialization!.initHash = digest("catalog init");
    await f.store.write(materialized);
    const reReserved = structuredClone(materialized);
    reReserved.journal!.catalogContext = catalogContext;
    await assert.rejects(async () => f.store.write(reReserved), unsafe);
  } finally {
    await f.close();
  }
});

test("should bootstrap a legacy pointer only against its exact runtime and profile mapping", async () => {
  const f = await fixture();
  try {
    const oldStore = new (await import("../src/runtime-store.ts")).RuntimeStore(
      f.stateDir,
      "one",
      f.scope.agentId,
    );
    await oldStore.write(f.record);
    const bytes = await readFile(oldStore.file);
    const workspaceId = uuid();
    const pointer: GenerationPointer = {
      generation: f.context.generation,
      agentId: f.scope.agentId,
      workspaceId,
      bindingEpoch: f.scope.bindingEpoch,
      configRevision: 0,
      provider: "codex",
      localRootReference: uuid(),
      legacy: true,
    };
    f.state.current = pointer;
    f.state.journal!.previous = pointer;
    await f.profile.write({
      version: 1,
      server: f.scope.server,
      status: "connected",
      deviceId: f.scope.deviceId,
      scope: {
        organizationId: f.scope.organizationId,
        roomId: f.scope.roomId,
        ownerAlias: "Owner",
        organizationName: "Organization",
        roomTitle: "Room",
        deviceAlias: "Device",
      },
      mappings: [
        {
          root: f.root,
          nativeSessionId: f.context.threadId,
          workspaceId,
          agentId: f.scope.agentId,
          bindingEpoch: f.scope.bindingEpoch,
        },
      ],
    });
    const changed = structuredClone(f.state);
    changed.current!.workspaceId = uuid();
    await assert.rejects(async () => f.store.write(changed), unsafe);
    await f.store.write(f.state);
    assert.deepEqual(await readFile(oldStore.file), bytes);
    assert.deepEqual((await f.store.read())!.current, pointer);
  } finally {
    await f.close();
  }
});

test("should preserve confirmed public file scope and handoff before model selection", async () => {
  const f = await fixture();
  try {
    f.state.journal!.phase = "LOCAL_CONFIRMATION";
    f.state.journal!.files = structuredClone(f.settings.files);
    f.state.journal!.handoff = "Use the confirmed public evidence.";
    f.state.journal!.settings = null;
    await f.store.write(f.state);
    for (const change of [
      (state: SettingsState) => {
        state.journal!.files![0].hash = digest("replacement");
      },
      (state: SettingsState) => {
        state.journal!.files!.push(state.journal!.files![0]);
      },
      (state: SettingsState) => {
        state.journal!.handoff = "Scope changed";
      },
      (state: SettingsState) => {
        state.journal!.handoff = "x".repeat(8193);
      },
      (state: SettingsState) => {
        state.journal!.handoff = "api_key=private-secret-material";
      },
    ]) {
      const changed = structuredClone(f.state);
      change(changed);
      await assert.rejects(async () => f.store.write(changed), unsafe);
    }
    const selected = structuredClone(f.state);
    selected.journal!.settings = {
      ...f.settings,
      capabilities: {
        ...f.settings.capabilities,
        runtime: "codex",
        snapshotHash: String(selected.journal!.operation.requested.snapshotHash),
      },
      handoff: selected.journal!.handoff!,
    };
    await f.store.write(selected);
  } finally {
    await f.close();
  }
});
test("should persist an exact immutable apply body and hash separately from the first command", async () => {
  const f = await fixture();
  try {
    const body = structuredClone(f.state.journal!.operation.requested);
    Object.assign(f.state.journal!, { applyBody: body, applyHash: digest(stableJson(body)) });
    await f.store.write(f.state);
    assert.deepEqual((await f.store.read())!.journal!.operation.requested, body);
    const changed = structuredClone(f.state);
    const updatedBody = { ...body, sessionAlias: "Other session" };
    Object.assign(changed.journal!, {
      applyBody: updatedBody,
      applyHash: digest(stableJson(updatedBody)),
    });
    await assert.rejects(async () => f.store.write(changed), unsafe);
  } finally {
    await f.close();
  }
});
test("should retain an explicitly empty optional public handoff", async () => {
  const f = await fixture();
  try {
    f.state.journal!.settings!.handoff = "";
    f.state.journal!.handoff = "";
    await f.store.write(f.state);
    assert.equal((await f.store.read())!.journal!.handoff, "");
  } finally {
    await f.close();
  }
});

test("should fsync the first binding commit request before the server issues its identities", async () => {
  const f = await fixture();
  try {
    f.state.journal!.context = structuredClone(f.context);
    f.state.journal!.phase = "COMMIT_INTENT";
    f.state.journal!.receipt = { ...f.receipt("COMMITTED"), agentId: null, workspaceId: null };
    await f.store.write(f.state);
    const disk = (await f.store.read())!;
    assert.equal(disk.journal!.receipt!.agentId, null);
    const forgedProof = structuredClone(f.state);
    forgedProof.journal!.phase = "COMMITTED";
    await assert.rejects(async () => f.store.write(forgedProof), unsafe);
  } finally {
    await f.close();
  }
});

test("should retain the exact commit request when adopting the server-issued binding", async () => {
  const f = await fixture();
  try {
    const j = f.state.journal!;
    j.context = structuredClone(f.context);
    j.phase = "PREPARED";
    j.receipt = null;
    j.commitBody = { ...f.receipt("COMMITTED"), agentId: null, workspaceId: null };
    await f.store.write(f.state);
    j.phase = "COMMIT_INTENT";
    await f.store.write(f.state);
    j.phase = "COMMITTED";
    j.receipt = f.receipt("COMMITTED");
    await f.store.write(f.state);
    assert.equal((await f.store.read())!.journal!.commitBody!.agentId, null);
    const changed = structuredClone(f.state);
    changed.journal!.commitBody!.sessionAlias = "Changed after sending";
    await assert.rejects(async () => f.store.write(changed), unsafe);
    const mismatch = structuredClone(f.state);
    mismatch.journal!.receipt!.configRevision = 2;
    await assert.rejects(async () => f.store.write(mismatch), unsafe);
  } finally {
    await f.close();
  }
});

import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
test("should preserve exact local automatic consent and reject saved legacy scope insertion", async () => {
  const f = await fixture();
  try {
    await f.store.write(f.state);
    const widened = structuredClone(f.state);
    const journal = widened.journal!;
    journal.files = [];
    journal.settings!.files = [];
    journal.repositoryAccess = createRepositoryAccess(
      journal.generation,
      journal.root!,
      journal.localRootReference,
      journal.operation.operationId,
    );
    journal.settings!.repositoryAccess = structuredClone(journal.repositoryAccess);
    journal.operation.requested.readMode = "AUTO_CODE";
    await assert.rejects(async () => f.store.write(widened), unsafe);
  } finally {
    await f.close();
  }
});
