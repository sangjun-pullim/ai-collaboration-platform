import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, rename, mkdir, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../src/state-store.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { Connector } from "../src/cli.ts";
import { CentralClient } from "../src/central-client.ts";
import { WorkflowClient } from "../src/workflow-client.ts";
import { WorkflowRunner } from "../src/workflow-runner.ts";
import { prepareConnection } from "../src/cli/connect-command.ts";
import { SyntheticAdapter } from "./runner-fixture.ts";
import { runtimeFixture, uuid, appendFixtureCompletion } from "./runtime-fixture.ts";
import { capabilityHash } from "../src/settings/contracts.ts";
import { revokeConfiguredProfile } from "../src/cli/remove-local-profile.ts";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";

async function fixture() {
  const f = await runtimeFixture();
  const previousProfile = `web-${"a".repeat(32)}`,
    recoveryId = uuid();
  const profile = `web-${createHash("sha256")
    .update(JSON.stringify(["connection-recovery", previousProfile, recoveryId]))
    .digest("hex")
    .slice(0, 32)}`;
  const previous = new StateStore(f.stateDir, previousProfile);
  const runtime = new RuntimeStore(f.stateDir, previousProfile, f.scope.agentId);
  await runtime.write(f.record);
  await previous.write({
    version: 1,
    server: f.scope.server,
    deviceId: f.scope.deviceId,
    credential: "a".repeat(64),
    credentialExpiresAt: new Date(Date.now() - 1).toISOString(),
    status: "disconnected",
    scope: {
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
      ownerAlias: "Owner",
      organizationName: "Org",
      roomTitle: "Room",
      deviceAlias: "Old Mac",
    },
    mappings: [
      {
        agentId: f.scope.agentId,
        workspaceId: uuid(),
        bindingEpoch: 1,
        root: f.root,
        nativeSessionId: f.context.threadId,
      },
    ],
  });
  const next = new StateStore(f.stateDir, profile),
    adapter = new SyntheticAdapter();
  const calls: string[] = [],
    notices: string[] = [];
  const scope = { ...(await previous.read())!.scope!, deviceAlias: "New Mac" };
  const connector = new Connector(
    next,
    new CentralClient(f.scope.server, async (url) => {
      const action = String(url).split("/").at(-1)!;
      calls.push(action);
      if (action === "bindings")
        return Response.json({ ok: true, data: { protocol: 1, bindings: [] } });
      return Response.json({
        ok: true,
        data:
          action === "begin"
            ? {
                protocol: 1,
                pairingId: f.scope.agentId,
                expiresAt: new Date(Date.now() + 300000).toISOString(),
              }
            : action === "pairing-status"
              ? {
                  protocol: 1,
                  pairingId: f.scope.agentId,
                  state: "approved",
                  expiresAt: new Date(Date.now() + 300000).toISOString(),
                  scope,
                }
              : {
                  protocol: 1,
                  deviceId: uuid(),
                  expiresAt: new Date(Date.now() + 604800000).toISOString(),
                },
      });
    }),
  );
  const interaction = {
    interactive: true,
    signal: new AbortController().signal,
    write: (s: string) => {
      notices.push(s);
    },
    open: async () => {},
    confirm: async () => true,
    confirmPreviousRevoked: async () => {
      assert.equal(calls.length, 0);
      return true;
    },
  };
  const runner = (p: StateStore, agentId: string) =>
    new WorkflowRunner(
      p,
      new RuntimeStore(p.dir, p.profile, agentId),
      new WorkflowClient(f.scope.server),
      adapter,
      { rotate: async () => {}, bindings: async () => [], replace: async () => {} },
    );
  const run = () =>
    (prepareConnection as (...args: unknown[]) => Promise<void>)(
      connector,
      {
        organizationId: f.scope.organizationId,
        roomId: f.scope.roomId,
        deviceAlias: "New Mac",
        previousProfile,
        recoveryId,
      },
      interaction,
      runner,
    );
  return { ...f, previous, runtime, next, connector, calls, notices, adapter, interaction, run };
}

test("should inspect a real no-settings legacy profile and retain its bytes before fresh approval", async () => {
  const f = await fixture();
  let revoked = false;
  try {
    const profile = await readFile(f.previous.file),
      record = await readFile(f.runtime.file);
    f.interaction.confirmPreviousRevoked = async () => {
      revoked = true;
      assert.equal(f.calls.length, 0);
      return true;
    };
    await f.run();
    assert.equal(revoked, true);
    assert.deepEqual(await readFile(f.previous.file), profile);
    assert.deepEqual(await readFile(f.runtime.file), record);
    assert.equal(await new SettingsStore(f.previous).read(), undefined);
    assert.equal(f.adapter.starts, 0);
    assert.equal(f.adapter.prepares, 0);
    assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
    assert.ok(f.notices.join("").includes(f.scope.deviceId));
    assert.ok(!f.notices.join("").includes(f.context.threadId));
    assert.ok(!f.notices.join("").includes(f.root));
  } finally {
    await f.close();
  }
});

for (const fault of [
  "live",
  "missing",
  "unknown",
  "pending",
  "foreign",
  "orphan",
  "symlink",
  "mode",
  "native",
  "declined",
  "replacement",
] as const)
  test(`should refuse legacy recovery with ${fault} before any fresh pairing`, async () => {
    const f = await fixture();
    try {
      const owner = (await f.previous.read())!;
      if (fault === "live") owner.credentialExpiresAt = new Date(Date.now() + 60000).toISOString();
      if (fault === "pending")
        owner.pending = {
          action: "rotate",
          body: { operationId: uuid() },
          payloadHash: "a".repeat(64),
        };
      if (fault === "foreign") owner.scope!.roomId = uuid();
      if (fault === "native") owner.mappings[0].nativeSessionId = uuid();
      await f.previous.write(owner);
      if (fault === "missing") await unlink(f.runtime.file);
      if (fault === "unknown") {
        const record = (await f.runtime.read())!;
        appendFixtureCompletion(record);
        record.attempts[0].state = "UNKNOWN";
        record.attempts[0].reason = "UNKNOWN";
        record.attempts[0].receipt = null;
        await writeFile(f.runtime.file, JSON.stringify(record), { mode: 0o600 });
        assert.equal((await f.runtime.read())!.attempts[0].state, "UNKNOWN");
      }
      if (fault === "orphan") {
        const agent = uuid(),
          record = structuredClone(f.record);
        record.scope.agentId = agent;
        await new RuntimeStore(f.previous.dir, f.previous.profile, agent).write(record);
      }
      if (fault === "symlink") {
        const settings = new SettingsStore(f.previous);
        await settings.read();
        const external = join(f.directory, "unowned");
        await mkdir(external, { mode: 0o700 });
        await symlink(external, join(settings.dir, "generations"));
      }
      if (fault === "mode") await chmod(f.runtime.file, 0o644);
      if (fault === "declined") f.interaction.confirmPreviousRevoked = async () => false;
      if (fault === "replacement")
        f.interaction.confirmPreviousRevoked = async () => {
          const copy = `${f.previous.file}.replacement`;
          await writeFile(copy, await readFile(f.previous.file), { mode: 0o600 });
          await rename(copy, f.previous.file);
          return true;
        };
      const profile = await readFile(f.previous.file);
      await assert.rejects(f.run());
      assert.equal(f.calls.length, 0);
      assert.equal(f.adapter.starts, 0);
      assert.deepEqual(await readFile(f.previous.file), profile);
    } finally {
      await f.close();
    }
  });

test("should refuse an orphan runtime lock whose execution record is missing", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.runtime.dir, `${uuid()}.lock`), JSON.stringify({ pid: process.pid }), {
      mode: 0o600,
    });
    await assert.rejects(f.run(), { code: "RUNTIME_BUSY" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.adapter.starts, 0);
  } finally {
    await f.close();
  }
});

for (const lock of ["manager", "native", "runtime"] as const)
  test(`should reject a live ${lock} owner before recovery pairing`, async () => {
    const f = await fixture();
    try {
      const check = async () => {
        await assert.rejects(f.run(), { code: "RUNTIME_BUSY" });
      };
      if (lock === "manager") await new SettingsStore(f.previous).locked(check);
      if (lock === "runtime") await f.runtime.locked(check);
      if (lock === "native") await f.runtime.sessionLocked(f.context.threadId, check);
      assert.equal(f.calls.length, 0);
      assert.equal(f.adapter.starts, 0);
    } finally {
      await f.close();
    }
  });

test("should keep the old device owned through approval without holding its runtime or profile locks", async () => {
  const f = await fixture();
  try {
    f.interaction.confirmPreviousRevoked = async () => {
      await assert.rejects(
        new SettingsStore(f.previous).locked(async () => {}),
        { code: "RUNTIME_BUSY" },
      );
      await f.runtime.locked(async () =>
        f.runtime.sessionLocked(f.context.threadId, async () =>
          f.previous.transaction(async () => {}),
        ),
      );
      return true;
    };
    await f.run();
    const after = await readFile(f.next.file);
    f.calls.length = 0;
    f.interaction.confirmPreviousRevoked = async () =>
      assert.fail("same registered device must resume");
    await f.run();
    assert.deepEqual(await readFile(f.next.file), after);
    assert.equal(f.calls.filter((action) => action === "begin").length, 0);
  } finally {
    await f.close();
  }
});

async function configured(f: Awaited<ReturnType<typeof fixture>>) {
  const owner = (await f.previous.read())!,
    settings = new SettingsStore(f.previous);
  await settings.read();
  const generation = uuid(),
    agentId = uuid(),
    workspaceId = uuid();
  const record = structuredClone(f.record);
  record.version = 2;
  record.settings!.capabilities.runtime = "codex";
  const { snapshotHash: previousHash, ...capabilities } = record.settings!.capabilities;
  void previousHash;
  record.settings!.capabilities.snapshotHash = capabilityHash({
    ...capabilities,
    runtime: "codex",
    policy: "verified",
  });
  record.scope.agentId = agentId;
  record.context!.generation = generation;
  record.context!.threadId = uuid();
  const current = settings.generationStore(agentId, generation);
  await current.write(record);
  const old = owner.mappings[0];
  const state = {
    version: 1,
    server: owner.server,
    deviceId: owner.deviceId!,
    organizationId: owner.scope!.organizationId,
    roomId: owner.scope!.roomId,
    journal: null,
    retained: [
      {
        generation: f.context.generation,
        agentId: old.agentId!,
        workspaceId: old.workspaceId!,
        bindingEpoch: 1,
        configRevision: 0,
        provider: "codex",
        localRootReference: uuid(),
        legacy: true,
      },
    ],
    current: {
      generation,
      agentId,
      workspaceId,
      bindingEpoch: 1,
      configRevision: 1,
      provider: "codex",
      localRootReference: uuid(),
    },
  };
  await writeFile(settings.file, JSON.stringify(state), { mode: 0o600 });
  assert.ok(await settings.read());
  owner.mappings = [
    {
      agentId,
      workspaceId,
      bindingEpoch: 1,
      root: f.root,
      nativeSessionId: record.context!.threadId,
      formatVersion: 2,
      runtime: "codex",
      generation,
      materialization: "MATERIALIZED",
    },
  ];
  await f.previous.write(owner);
  return { settings, current, record };
}

test("should protect current and retained legacy generations without copying settings into the new profile", async () => {
  const f = await fixture();
  try {
    const c = await configured(f);
    const files = [f.previous.file, f.runtime.file, c.settings.file, c.current.file];
    const before = await Promise.all(files.map((file) => readFile(file)));
    await f.run();
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    assert.equal(await new SettingsStore(f.next).read(), undefined);
    assert.deepEqual((await f.next.read())!.mappings, []);
    assert.equal(f.adapter.starts, 0);
    assert.equal(f.adapter.prepares, 0);
  } finally {
    await f.close();
  }
});

for (const fault of ["empty-pointers", "extra", "duplicate", "epoch", "root", "native"] as const)
  test(`should reject configured mapping ${fault} without protected runtime evidence before pairing`, async () => {
    const f = await fixture();
    try {
      if (fault === "empty-pointers") {
        await unlink(f.runtime.file);
        const settings = new SettingsStore(f.previous),
          owner = (await f.previous.read())!;
        await settings.read();
        await writeFile(
          settings.file,
          JSON.stringify({
            version: 1,
            server: owner.server,
            deviceId: owner.deviceId,
            organizationId: owner.scope!.organizationId,
            roomId: owner.scope!.roomId,
            current: null,
            retained: [],
            journal: null,
          }),
          { mode: 0o600 },
        );
        assert.ok(await settings.read());
      } else {
        const c = await configured(f),
          owner = (await f.previous.read())!;
        const pointer = (await c.settings.read())!.retained[0];
        const retained = {
          agentId: pointer.agentId,
          workspaceId: pointer.workspaceId,
          bindingEpoch: pointer.bindingEpoch,
          root: f.root,
          nativeSessionId: f.context.threadId,
        };
        if (fault === "extra")
          owner.mappings.push({
            ...retained,
            agentId: uuid(),
            workspaceId: uuid(),
            nativeSessionId: uuid(),
          });
        if (fault === "duplicate") owner.mappings.push(retained, { ...retained });
        if (fault === "epoch")
          owner.mappings.push({ ...retained, bindingEpoch: pointer.bindingEpoch + 1 });
        if (fault === "root") owner.mappings.push({ ...retained, root: f.directory });
        if (fault === "native") owner.mappings.push({ ...retained, nativeSessionId: uuid() });
        await f.previous.write(owner);
      }
      const before = await readFile(f.previous.file);
      await assert.rejects(f.run(), { code: "CONTEXT_UNCONFIRMED" });
      assert.equal(f.calls.length, 0);
      assert.equal(await f.next.read(), undefined);
      assert.deepEqual(await readFile(f.previous.file), before);
      assert.equal(f.adapter.starts, 0);
    } finally {
      await f.close();
    }
  });

for (const action of ["recover", "remove"] as const)
  test(`should ${action} with exact current and retained mapping evidence while retaining owned histories`, async () => {
    const f = await fixture();
    try {
      const c = await configured(f),
        owner = (await f.previous.read())!;
      const pointer = (await c.settings.read())!.retained[0];
      owner.mappings.push({
        agentId: pointer.agentId,
        workspaceId: pointer.workspaceId,
        bindingEpoch: pointer.bindingEpoch,
        root: f.root,
        nativeSessionId: f.context.threadId,
      });
      await f.previous.write(owner);
      const files = [f.runtime.file, c.current.file, c.settings.file];
      const before = await Promise.all(files.map((file) => readFile(file)));
      if (action === "recover") await f.run();
      else {
        assert.deepEqual(
          await withSettingsDeviceLock(f.previous, "revoke-local", (settings) =>
            revokeConfiguredProfile(f.previous, settings),
          ),
          { state: "removed", scope: "local profile", historyRetained: true },
        );
        assert.equal(await f.previous.read(), undefined);
      }
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
      assert.equal(f.adapter.starts, 0);
    } finally {
      await f.close();
    }
  });

for (const kind of [
  "orphan",
  "unknown",
  "foreign",
  "unlisted-runtime",
  "settings-replacement",
] as const)
  test(`should refuse configured ${kind} evidence before fresh pairing`, async () => {
    const f = await fixture();
    try {
      const c = await configured(f);
      if (kind === "orphan")
        await mkdir(join(c.settings.dir, "generations", uuid()), { mode: 0o700 });
      if (kind === "unknown") {
        appendFixtureCompletion(c.record);
        c.record.attempts[0].state = "UNKNOWN";
        c.record.attempts[0].receipt = null;
        c.record.attempts[0].reason = "UNKNOWN";
        await writeFile(c.current.file, JSON.stringify(c.record), { mode: 0o600 });
        assert.ok(await c.current.read());
      }
      if (kind === "foreign") {
        c.record.scope.deviceId = uuid();
        await writeFile(c.current.file, JSON.stringify(c.record), { mode: 0o600 });
      }
      if (kind === "unlisted-runtime") {
        await mkdir(join(c.current.stateDir, "runtime", "foreign"), { mode: 0o700 });
        await writeFile(join(c.current.stateDir, "runtime", "foreign", `${uuid()}.json`), "{}", {
          mode: 0o600,
        });
      }
      if (kind === "settings-replacement")
        f.interaction.confirmPreviousRevoked = async () => {
          const copy = `${c.settings.file}.replacement`;
          await writeFile(copy, await readFile(c.settings.file), { mode: 0o600 });
          await rename(copy, c.settings.file);
          return true;
        };
      await assert.rejects(f.run());
      assert.equal(f.calls.length, 0);
      assert.ok(await f.previous.read());
    } finally {
      await f.close();
    }
  });
