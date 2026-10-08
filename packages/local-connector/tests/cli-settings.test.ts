import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { StateStore } from "../src/state-store.ts";
import { RuntimeError } from "../src/runtime-contracts.ts";
import { SettingsStore, type SettingsState } from "../src/settings/store.ts";
import { revokeConfiguredProfile } from "../src/cli/remove-local-profile.ts";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";
import { runtimeFixture, uuid } from "./runtime-fixture.ts";
import { runRuntimeCommand } from "../src/cli/runtime-command.ts";
import { policyFixture } from "./claude-policy-fixture.ts";
import { FakeTransport } from "./claude-runtime-fixture.ts";
import { ClaudeCatalogStore } from "../src/claude/catalog-store.ts";
import { NativeClaudePolicy } from "../src/claude/native-policy.ts";

test("should keep standalone Claude default admission closed under the device settings lock", async (t) => {
  const f = await runtimeFixture(),
    profile = new StateStore(f.stateDir, "one");
  try {
    const admission = t.mock.method(
      NativeClaudePolicy.prototype,
      "admit",
      async (root: string, check: () => void) => {
        assert.equal(root, f.root);
        check();
        throw new RuntimeError("POLICY_UNCONFIRMED");
      },
    );
    await assert.rejects(
      withSettingsDeviceLock(profile, "runtime-capabilities", async () =>
        runRuntimeCommand(
          "runtime-capabilities",
          { runtime: "claude", root: f.root },
          (key) => (key === "root" ? f.root : assert.fail("unexpected requirement")),
          async () => assert.fail("must not create a workflow runner"),
          { profile },
        ),
      ),
      { code: "POLICY_UNCONFIRMED" },
    );
    assert.equal(admission.mock.callCount(), 1);
    await assert.rejects(readFile(new ClaudeCatalogStore(profile).file), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});
test("should project standalone synthetic capabilities without exposing local configuration or acceptance", async () => {
  const f = await policyFixture(),
    native = new FakeTransport();
  try {
    const value = (await withSettingsDeviceLock(f.profile, "runtime-capabilities", async () =>
      runRuntimeCommand(
        "runtime-capabilities",
        { runtime: "claude", root: f.root },
        () => f.root,
        async () => assert.fail("must not create a workflow runner"),
        {
          profile: f.profile,
          claude: { evidence: f.evidence, environment: {}, transport: () => native },
        },
      ),
    )) as { provider: string; accountEligibility: string; finalInputIsolation: string };
    assert.equal(value.provider, "claude");
    assert.equal(value.accountEligibility, "UNVERIFIED");
    assert.equal(value.finalInputIsolation, "UNVERIFIED");
    assert.ok(!JSON.stringify(value).includes(f.directory));
    assert.equal(native.writes.length, 0);
    assert.equal(
      JSON.parse(await readFile(new ClaudeCatalogStore(f.profile).file, "utf8")).status,
      "CLOSED",
    );
  } finally {
    await f.close();
  }
});

test("should exclude legacy CLI mutations while the settings manager owns the device", async () => {
  const f = await runtimeFixture();
  try {
    const profile = new StateStore(f.stateDir, "one");
    const settings = new SettingsStore(profile);
    let calls = 0;
    await settings.locked(async () => {
      for (const command of [
        "register",
        "replace",
        "runtime-run",
        "runtime-prepare",
        "revoke-local",
      ]) {
        await assert.rejects(
          () =>
            withSettingsDeviceLock(profile, command, async () => {
              calls++;
            }),
          (e: unknown) => e instanceof RuntimeError && e.code === "RUNTIME_BUSY",
        );
      }
    });
    assert.equal(calls, 0);
    assert.equal(
      await withSettingsDeviceLock(profile, "pair", async () => "legacy works"),
      "legacy works",
    );
  } finally {
    await f.close();
  }
});

test("should preserve an unresolved setup journal when raw CLI tries to run or revoke", async () => {
  const f = await runtimeFixture();
  try {
    const profile = new StateStore(f.stateDir, "one");
    const settings = new SettingsStore(profile);
    const operationId = uuid();
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
          state: "REQUESTED",
          requested: {
            operationId,
            deviceId: f.scope.deviceId,
            expectedConfigRevision: 0,
            runtime: "codex",
          },
          receipt: null,
        },
        phase: "UNKNOWN",
        generation: uuid(),
        localRootReference: uuid(),
        root: null,
        settings: null,
        context: null,
        receipt: null,
        reason: "UNKNOWN",
      },
    };
    await settings.write(state);
    for (const command of ["runtime-run", "runtime-observe", "replace", "revoke-local"]) {
      await assert.rejects(
        () => withSettingsDeviceLock(profile, command, async () => assert.fail("must not mutate")),
        (e: unknown) => e instanceof RuntimeError && e.code === "RUNTIME_BUSY",
      );
    }
    assert.deepEqual(await settings.read(), state);
  } finally {
    await f.close();
  }
});

async function retainedLegacyFixture() {
  const f = await runtimeFixture();
  const profile = new StateStore(f.stateDir, "one");
  const settings = new SettingsStore(profile);
  const workspaceId = uuid();
  await profile.write({
    version: 1,
    server: f.scope.server,
    deviceId: f.scope.deviceId,
    status: "connected",
    scope: {
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
      ownerAlias: "Owner",
      organizationName: "Company",
      roomTitle: "Room",
      deviceAlias: "Mac",
    },
    mappings: [
      {
        agentId: f.scope.agentId,
        workspaceId,
        bindingEpoch: 1,
        root: f.root,
        nativeSessionId: f.context.threadId,
      },
    ],
  });
  await f.store.write(f.record);
  const operationId = uuid();
  const pointer = {
    generation: f.context.generation,
    agentId: f.scope.agentId,
    workspaceId,
    bindingEpoch: 1,
    configRevision: 0,
    provider: "codex" as const,
    localRootReference: uuid(),
    legacy: true,
  };
  const state: SettingsState = {
    version: 1,
    server: f.scope.server,
    deviceId: f.scope.deviceId,
    organizationId: f.scope.organizationId,
    roomId: f.scope.roomId,
    current: pointer,
    retained: [],
    journal: {
      operation: {
        operationId,
        deviceId: f.scope.deviceId,
        expectedConfigRevision: 0,
        state: "REQUESTED",
        requested: {
          operationId,
          deviceId: f.scope.deviceId,
          expectedConfigRevision: 0,
          runtime: "codex",
        },
        receipt: null,
      },
      phase: "CHOOSING",
      generation: uuid(),
      localRootReference: uuid(),
      previous: pointer,
      root: null,
      settings: null,
      context: null,
      receipt: null,
      reason: null,
    },
  };
  await settings.write(state);
  state.journal!.phase = "CANCELLED";
  state.journal!.receipt = {
    operationId,
    state: "CANCELLED",
    configRevision: 0,
    runtime: "codex",
    model: null,
    effort: null,
    snapshotHash: null,
    localRootReference: null,
    repositoryAlias: null,
    sessionAlias: null,
    catalog: null,
    bindingEpoch: null,
    agentId: null,
    workspaceId: null,
  };
  await settings.write(state);
  return { ...f, profile, settings, state };
}

test("should revoke a configured local credential while retaining exact owned histories", async () => {
  const f = await retainedLegacyFixture();
  try {
    const record = await readFile(f.store.file);
    const settings = await readFile(f.settings.file);
    assert.deepEqual(
      await withSettingsDeviceLock(f.profile, "revoke-local", (locked) =>
        revokeConfiguredProfile(f.profile, locked),
      ),
      { state: "removed", scope: "local profile", historyRetained: true },
    );
    assert.equal(await f.profile.read(), undefined);
    assert.deepEqual(await readFile(f.store.file), record);
    assert.deepEqual(await readFile(f.settings.file), settings);
  } finally {
    await f.close();
  }
});

test("should refuse revocation while the exact retained runtime lock is owned", async () => {
  const f = await retainedLegacyFixture();
  try {
    const before = await readFile(f.profile.file);
    await f.store.locked(async () => {
      await assert.rejects(
        () =>
          withSettingsDeviceLock(f.profile, "revoke-local", (locked) =>
            revokeConfiguredProfile(f.profile, locked),
          ),
        (e: unknown) => e instanceof RuntimeError && e.code === "RUNTIME_BUSY",
      );
    });
    assert.deepEqual(await readFile(f.profile.file), before);
  } finally {
    await f.close();
  }
});

test("should preserve the credential when the current generation mapping has changed", async () => {
  const f = await retainedLegacyFixture();
  try {
    const profile = (await f.profile.read())!;
    profile.mappings[0].nativeSessionId = uuid();
    await f.profile.write(profile);
    const before = await readFile(f.profile.file);
    await assert.rejects(
      () =>
        withSettingsDeviceLock(f.profile, "revoke-local", (locked) =>
          revokeConfiguredProfile(f.profile, locked),
        ),
      { code: "CONTEXT_UNCONFIRMED" },
    );
    assert.deepEqual(await readFile(f.profile.file), before);
  } finally {
    await f.close();
  }
});

test("should require a fresh profile before pairing over retained revoked histories", async () => {
  const f = await retainedLegacyFixture();
  try {
    await withSettingsDeviceLock(f.profile, "revoke-local", (settings) =>
      revokeConfiguredProfile(f.profile, settings),
    );
    const retained = await readFile(f.settings.file);
    for (const command of ["pair", "exchange", "connect"]) {
      await assert.rejects(
        withSettingsDeviceLock(f.profile, command, async () =>
          assert.fail("must not start enrollment"),
        ),
        { code: "CONTEXT_UNCONFIRMED" },
      );
    }
    assert.equal(await f.profile.read(), undefined);
    assert.deepEqual(await readFile(f.settings.file), retained);
    const fresh = new StateStore(f.stateDir, "fresh-connection");
    assert.equal(
      await withSettingsDeviceLock(fresh, "pair", async () => "new profile"),
      "new profile",
    );
  } finally {
    await f.close();
  }
});
