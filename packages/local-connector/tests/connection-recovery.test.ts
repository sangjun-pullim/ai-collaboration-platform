import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, unlink, rename, mkdir, chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { Interface } from "node:readline/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { StateStore } from "../src/state-store.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { Connector, main } from "../src/cli.ts";
import { CentralClient } from "../src/central-client.ts";
import { ConnectionError } from "../src/contracts.ts";
import { WorkflowClient } from "../src/workflow-client.ts";
import { WorkflowRunner } from "../src/workflow-runner.ts";
import { prepareConnection, type ConnectInteraction } from "../src/cli/connect-command.ts";
import { SyntheticAdapter } from "./runner-fixture.ts";
import { runtimeFixture, uuid, appendFixtureCompletion } from "./runtime-fixture.ts";
import { capabilityHash, type Receipt, type SettingsResponse } from "../src/settings/contracts.ts";
import { SettingsManager } from "../src/settings/manager.ts";
import { SettingsClient } from "../src/settings/client.ts";
import { revokeConfiguredProfile } from "../src/cli/remove-local-profile.ts";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { digest, stableJson, RuntimeError } from "../src/runtime-contracts.ts";

async function fixture(intermediate = false) {
  const f = await runtimeFixture();
  const baseProfile = `web-${"a".repeat(32)}`,
    intermediateId = uuid();
  const previousProfile = intermediate
      ? `web-${createHash("sha256")
          .update(JSON.stringify(["connection-recovery", baseProfile, intermediateId]))
          .digest("hex")
          .slice(0, 32)}`
      : baseProfile,
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
  const interaction: ConnectInteraction = {
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
        ...(intermediate
          ? {
              recoveryChain: JSON.stringify({
                version: 1,
                baseProfile,
                chain: [
                  {
                    previousProfile: baseProfile,
                    recoveryId: intermediateId,
                    profile: previousProfile,
                  },
                  { previousProfile, recoveryId, profile },
                ],
              }),
            }
          : {}),
      },
      interaction,
      runner,
    );
  return {
    ...f,
    previous,
    runtime,
    next,
    connector,
    calls,
    notices,
    adapter,
    interaction,
    run,
    approvalScope: scope,
    recoveryId,
    intermediateId,
    baseProfile,
    runner,
  };
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

/** Fail the real manager before its durable PREPARE_INTENT, then remove the device. */
async function unappliedSetup(
  f: Awaited<ReturnType<typeof fixture>>,
  apply = true,
  prepareAt?: "intent" | "context" | "commit",
  discoveryFailure = false,
) {
  await unlink(f.runtime.file);
  const owner = (await f.previous.read())!;
  owner.status = "connected";
  owner.credentialExpiresAt = new Date(Date.now() + 3600000).toISOString();
  owner.mappings = [];
  await f.previous.write(owner);
  const settings = new SettingsStore(f.previous),
    operationId = uuid(),
    capabilities = claudeRecord(f.record).settings!.capabilities;
  let response: SettingsResponse = {
    protocol: 1,
    deviceId: owner.deviceId!,
    configRevision: 0,
    catalog: null,
    applied: null,
    current: true,
    currentBinding: null,
    operation: {
      operationId,
      deviceId: owner.deviceId!,
      expectedConfigRevision: 0,
      state: "REQUESTED",
      requested: {
        operationId,
        deviceId: owner.deviceId!,
        expectedConfigRevision: 0,
        runtime: "claude",
      },
      receipt: null,
    },
  };
  const requests: string[] = [];
  let revoked = false,
    catalogs = 0;
  const client = new SettingsClient(owner.server, async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    requests.push(action);
    if (revoked)
      return Response.json({ ok: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
    if (action === "receipt") {
      const receipt = JSON.parse(String(init?.body)) as Receipt;
      assert.equal(receipt.state, discoveryFailure ? "FAILED" : "LOCAL_CONFIRMATION");
      response = {
        ...response,
        catalog: receipt.catalog,
        operation: {
          ...response.operation!,
          state: receipt.state,
          receipt: { ...receipt, catalog: null },
        },
      };
    }
    return Response.json({ ok: true, data: response });
  });
  const manager = new SettingsManager(f.previous, settings, client, {
    folder: async () => ({ status: "SELECTED", root: f.policy.root }),
    confirm: async () => ({
      confirmed: true,
      repositoryAlias: "Repository",
      files: [...f.policy.files],
      handoff: "Shared evidence.",
    }),
    adapter: (_provider, reserve) => ({
      capabilities: async (root, check) => {
        check();
        catalogs++;
        if (discoveryFailure) throw new RuntimeError("PROVIDER_UNAVAILABLE");
        await reserve(root, capabilities.version, digest("verified-policy-fixture"));
        if (catalogs === 2 && !prepareAt) {
          // The second metadata lookup outcome never reached durable settings.
          revoked = true;
          throw new RuntimeError("UNKNOWN");
        }
        return structuredClone(capabilities);
      },
      prepare: async (root, runtimeSettings, generation, epoch, check, onCreated) => {
        assert.ok(prepareAt, "initial setup must not prepare a runtime");
        check();
        if (prepareAt === "intent") throw new RuntimeError("UNKNOWN");
        const context = {
          ...structuredClone((await settings.read())!.journal!.catalogContext!),
          root,
          generation,
          epoch,
          threadId: uuid(),
        };
        assert.equal(context.materialization!.version, runtimeSettings.capabilities.version);
        await onCreated!(context);
        if (prepareAt === "context") throw new RuntimeError("UNKNOWN");
        return context;
      },
      execute: async () => assert.fail("metadata lookup must not execute a question"),
      validate: async () => assert.fail("initial setup must not validate a runtime"),
      observe: async () => null,
      interrupt: async () => false,
      close: async () => {},
    }),
    runner: () => assert.fail("initial setup must not start a runner"),
  });
  assert.equal(
    (await manager.run({ once: true })).state,
    discoveryFailure ? "FAILED" : "LOCAL_CONFIRMATION",
  );
  const confirmed = (await settings.read())!.journal!;
  if (apply)
    response.operation = {
      ...response.operation!,
      state: "APPLYING",
      requested: {
        ...response.operation!.requested,
        localRootReference: confirmed.localRootReference,
        repositoryAlias: "Repository",
        sessionAlias: "Session",
        expectedEpoch: null,
        model: capabilities.defaultSettings!.model,
        effort: capabilities.defaultSettings!.effort,
        snapshotHash: confirmed.receipt!.catalog!.snapshotHash,
      },
    };
  else revoked = true;
  assert.equal((await manager.run({ once: true })).state, "UNKNOWN");
  owner.status = "disconnected";
  await f.previous.write(owner);
  const state = (await settings.read())!;
  assert.equal(state.journal!.receipt!.state, discoveryFailure ? "FAILED" : "LOCAL_CONFIRMATION");
  assert.equal(!!state.journal!.applyBody, apply);
  if (!prepareAt) {
    assert.equal(state.journal!.settings, null);
    assert.equal(state.journal!.context, null);
  }
  assert.equal(f.adapter.prepares, 0);
  return { settings, state, initialJournal: confirmed, requests, catalogs: () => catalogs };
}

for (const apply of [true, false])
  test(`should preserve a real UNKNOWN initial setup ${apply ? "with" : "without"} apply intent through fresh approval`, async () => {
    const f = await fixture();
    try {
      const c = await unappliedSetup(f, apply),
        files = [f.previous.file, c.settings.file],
        before = await Promise.all(files.map((file) => readFile(file))),
        requests = [...c.requests],
        catalogs = c.catalogs();
      await f.run();
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
      assert.deepEqual(c.requests, requests);
      assert.equal(c.catalogs(), catalogs);
      assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
      assert.equal(f.adapter.starts, 0);
      assert.equal(f.adapter.prepares, 0);
      assert.equal((await c.settings.read())!.journal!.phase, "UNKNOWN");
      assert.match(f.notices.join(""), /미완료 AI 설정과 목록 조회 결과는 확인 불가/);
      assert.ok(!f.notices.join("").includes("이전 답변"));
      // The latest lineage command reuses its newly approved device, preserving the old setup.
      f.interaction.confirmPreviousRevoked = async () =>
        assert.fail("new device is already approved");
      await f.run();
      assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange", "bindings"]);
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
      assert.deepEqual(c.requests, requests);
      assert.equal(c.catalogs(), catalogs);
    } finally {
      await f.close();
    }
  });

for (const phase of ["FAILED", "UNKNOWN"] as const)
  test(`should preserve failed discovery in ${phase} and complete fresh approval`, async () => {
    const f = await fixture();
    try {
      const c = await unappliedSetup(f, false, undefined, true);
      assert.equal(c.state.journal!.phase, "UNKNOWN");
      if (phase === "FAILED")
        await writeFile(
          c.settings.file,
          JSON.stringify({ ...c.state, journal: c.initialJournal }),
          { mode: 0o600 },
        );
      assert.equal((await c.settings.read())!.journal!.phase, phase);
      assert.equal(c.state.journal!.receipt!.state, "FAILED");
      assert.equal(c.state.journal!.catalogContext, undefined);
      assert.equal(c.state.journal!.context, null);
      assert.equal(c.state.journal!.settings, null);
      const files = [f.previous.file, c.settings.file];
      const before = await Promise.all(files.map((file) => readFile(file)));
      const requests = [...c.requests];
      await f.run();
      assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
      assert.deepEqual(c.requests, requests);
      assert.equal(c.catalogs(), 1);
      assert.equal(f.adapter.prepares, 0);
      assert.equal(f.adapter.starts, 0);
      await f.run();
      assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange", "bindings"]);
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    } finally {
      await f.close();
    }
  });

for (const fault of [
  "declined",
  "live-owner",
  "live-lock",
  "scope",
  "generation",
  "legacy-record",
  "ordinary-removal",
] as const)
  test(`should preserve failed discovery protection for ${fault}`, async () => {
    const f = await fixture();
    try {
      const c = await unappliedSetup(f, false, undefined, true);
      if (fault === "declined") f.interaction.confirmPreviousRevoked = async () => false;
      if (fault === "live-owner" || fault === "scope") {
        const owner = (await f.previous.read())!;
        if (fault === "live-owner") owner.status = "connected";
        else owner.scope!.roomId = uuid();
        await f.previous.write(owner);
      }
      if (fault === "generation")
        await mkdir(join(c.settings.dir, "generations", c.state.journal!.generation), {
          recursive: true,
          mode: 0o700,
        });
      if (fault === "legacy-record") await f.runtime.write(f.record);
      const files = [f.previous.file, c.settings.file];
      const before = await Promise.all(files.map((file) => readFile(file)));
      const run =
        fault === "live-lock"
          ? () => c.settings.locked(() => f.run())
          : fault === "ordinary-removal"
            ? () => c.settings.locked(() => revokeConfiguredProfile(f.previous, c.settings))
            : () => f.run();
      await assert.rejects(run());
      assert.equal(await f.next.read(), undefined);
      assert.deepEqual(f.calls, []);
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    } finally {
      await f.close();
    }
  });

for (const stage of ["intent", "context", "commit"] as const)
  test(`should refuse a real UNKNOWN setup after runtime preparation ${stage}`, async () => {
    const f = await fixture();
    try {
      const c = await unappliedSetup(f, true, stage);
      assert.ok(c.state.journal!.settings);
      assert.equal(!!c.state.journal!.context, stage !== "intent");
      assert.equal(!!c.state.journal!.commitBody, stage === "commit");
      const before = await readFile(c.settings.file);
      await assert.rejects(f.run(), { code: "RUNTIME_BUSY" });
      assert.deepEqual(await readFile(c.settings.file), before);
      assert.deepEqual(f.calls, []);
      assert.equal(await f.next.read(), undefined);
    } finally {
      await f.close();
    }
  });

for (const fault of [
  "declined",
  "missing-confirmation",
  "scope",
  "web-scope",
  "yes-declined",
  "live-lock",
  "live-owner",
  "prepare-phase",
  "previous",
  "apply-epoch",
  "local-receipt",
  "applied-receipt",
  "current",
  "retained",
  "mapping",
  "generation",
  "legacy-record",
  "materialized",
  "owned-turn",
  "catalog-epoch",
  "catalog-root",
  "catalog-generation",
  "catalog-provider",
  "catalog-ownership",
  "drift",
  "replacement",
  "revoked-drift",
  "new-approval-drift",
] as const)
  test(`should refuse fresh initial setup recovery with ${fault}`, async () => {
    const f = await fixture();
    try {
      const c = await unappliedSetup(f),
        journal = c.state.journal!,
        catalog = journal.catalogContext!,
        pointer = {
          generation: journal.generation,
          agentId: f.scope.agentId,
          workspaceId: uuid(),
          bindingEpoch: 1,
          configRevision: 1,
          provider: "claude" as const,
          localRootReference: journal.localRootReference,
        };
      let changesSettings = false;
      if (fault === "declined") f.interaction.confirmPreviousRevoked = async () => false;
      if (fault === "missing-confirmation") delete f.interaction.confirmPreviousRevoked;
      if (fault === "web-scope") f.approvalScope.roomId = uuid();
      if (fault === "yes-declined") f.interaction.confirm = async () => false;
      if (fault === "scope" || fault === "live-owner") {
        const owner = (await f.previous.read())!;
        if (fault === "scope") owner.scope!.roomId = uuid();
        else owner.status = "connected";
        await f.previous.write(owner);
      }
      if (fault === "prepare-phase") {
        journal.phase = "PREPARE_INTENT";
        changesSettings = true;
      }
      if (fault === "previous") {
        journal.previous = pointer;
        journal.applyBody!.expectedEpoch = pointer.bindingEpoch;
        journal.applyHash = digest(stableJson(journal.applyBody));
        changesSettings = true;
      }
      if (fault === "apply-epoch") {
        journal.applyBody!.expectedEpoch = 1;
        journal.applyHash = digest(stableJson(journal.applyBody));
        changesSettings = true;
      }
      if (fault === "local-receipt") {
        Object.assign(journal, { localReceipt: journal.receipt });
        changesSettings = true;
      }
      if (fault === "applied-receipt") {
        journal.operation.receipt = { ...journal.receipt!, state: "APPLIED" };
        changesSettings = true;
      }
      if (fault === "current") {
        c.state.current = pointer;
        changesSettings = true;
      }
      if (fault === "retained") {
        c.state.retained.push(pointer);
        changesSettings = true;
      }
      if (fault === "mapping") {
        const owner = (await f.previous.read())!;
        owner.mappings.push({
          agentId: f.scope.agentId,
          workspaceId: pointer.workspaceId,
          bindingEpoch: 1,
          root: f.root,
          nativeSessionId: uuid(),
        });
        await f.previous.write(owner);
      }
      if (fault === "generation")
        await mkdir(join(c.settings.dir, "generations", journal.generation), {
          recursive: true,
          mode: 0o700,
        });
      if (fault === "legacy-record") await f.runtime.write(f.record);
      if (fault === "materialized") {
        catalog.materialization!.state = "MATERIALIZED";
        catalog.materialization!.initHash = digest("unproven-init");
        changesSettings = true;
      }
      if (fault === "owned-turn") {
        catalog.ownedTurns.push({ turnId: uuid(), terminal: "COMPLETED" });
        changesSettings = true;
      }
      if (fault === "catalog-epoch") {
        catalog.epoch++;
        changesSettings = true;
      }
      if (fault === "catalog-root") {
        catalog.root = { ...catalog.root, ino: catalog.root.ino + 1 };
        changesSettings = true;
      }
      if (fault === "catalog-generation") {
        catalog.generation = uuid();
        changesSettings = true;
      }
      if (fault === "catalog-provider") {
        catalog.provider = "codex";
        changesSettings = true;
      }
      if (fault === "catalog-ownership") {
        Object.assign(catalog, { ownership: "IMPORTED" });
        changesSettings = true;
      }
      if (changesSettings)
        await writeFile(c.settings.file, JSON.stringify(c.state), { mode: 0o600 });
      const drift = async () => {
        journal.reason = "CHANGED";
        await c.settings.write(c.state);
        return true;
      };
      if (fault === "drift") f.interaction.confirmPreviousRevoked = drift;
      if (fault === "replacement")
        f.interaction.confirmPreviousRevoked = async () => {
          const replacement = `${c.settings.file}.replacement`;
          await writeFile(replacement, await readFile(c.settings.file), { mode: 0o600 });
          await rename(replacement, c.settings.file);
          return true;
        };
      if (fault === "revoked-drift")
        f.interaction.confirmPreviousRevoked = async () => {
          const owner = (await f.previous.read())!;
          owner.status = "connected";
          await f.previous.write(owner);
          return true;
        };
      if (fault === "new-approval-drift") f.interaction.confirm = drift;
      const files = [f.previous.file, c.settings.file],
        before = await Promise.all(files.map((file) => readFile(file)));
      if (fault === "live-lock")
        await c.settings.locked(async () => assert.rejects(f.run(), { code: "RUNTIME_BUSY" }));
      else await assert.rejects(f.run());
      assert.deepEqual(
        f.calls,
        ["new-approval-drift", "web-scope", "yes-declined"].includes(fault)
          ? ["begin", "pairing-status"]
          : [],
      );
      assert.equal((await f.next.read())?.credential, undefined);
      assert.equal(f.adapter.starts, 0);
      assert.equal(f.adapter.prepares, 0);
      if (!["drift", "revoked-drift", "new-approval-drift"].includes(fault))
        assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    } finally {
      await f.close();
    }
  });

test("should keep ordinary connect and local removal blocked for an UNKNOWN initial setup", async () => {
  const f = await fixture();
  try {
    const c = await unappliedSetup(f),
      before = await readFile(c.settings.file);
    for (const command of ["connect", "revoke-local"])
      await assert.rejects(
        withSettingsDeviceLock(f.previous, command, async () =>
          assert.fail("must remain idle-only"),
        ),
        { code: "RUNTIME_BUSY" },
      );
    await c.settings.locked(async () =>
      assert.rejects(revokeConfiguredProfile(f.previous, c.settings), { code: "RUNTIME_BUSY" }),
    );
    assert.deepEqual(await readFile(c.settings.file), before);
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

for (const outcome of [
  "401",
  "403",
  "404",
  "network",
  "revoked-declined",
  "web-scope",
  "ordinary",
  "abort",
] as const)
  test(`should handle initially connected UNKNOWN setup and ${outcome} through the real CLI`, async (t) => {
    const f = await fixture(true);
    const originalExecFile = childProcess.execFile;
    let opened = 0;
    // A mock proxy retains execFile's custom promisifier, which launches the real browser.
    // Replace the export with a plain function so promisify also uses the isolated stub.
    childProcess.execFile = ((...args: unknown[]) => {
      assert.equal(args[0], "/usr/bin/open");
      opened++;
      (args.at(-1) as (error: Error | null) => void)(null);
      return {};
    }) as typeof childProcess.execFile;
    syncBuiltinESMExports();
    try {
      const c = await unappliedSetup(f),
        owner = (await f.previous.read())!;
      owner.status = "connected";
      await f.previous.write(owner);
      const profileBytes = await readFile(f.previous.file),
        settingsBytes = await readFile(c.settings.file),
        oldRequests = [...c.requests],
        output: string[] = [],
        calls: string[] = [],
        confirmations: string[] = [];
      for (const stream of [process.stdin, process.stdout]) {
        const descriptor = Object.getOwnPropertyDescriptor(stream, "isTTY");
        Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
        t.after(() => {
          if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
          else delete (stream as { isTTY?: boolean }).isTTY;
        });
      }
      t.mock.method(process.stdout, "write", (message: string | Uint8Array) => {
        output.push(String(message));
        return true;
      });
      t.mock.method(Interface.prototype, "question", async (question: string) => {
        confirmations.push(question);
        if (question.includes("revoked")) {
          await assert.rejects(
            c.settings.locked(async () => {}),
            { code: "RUNTIME_BUSY" },
          );
          return outcome === "revoked-declined" ? "cancel" : "revoked";
        }
        return "yes";
      });
      if (outcome === "web-scope") f.approvalScope.roomId = uuid();
      t.mock.method(
        globalThis,
        "fetch",
        async (url: string | URL | Request, init?: RequestInit) => {
          const path = new URL(String(url)).pathname,
            action = path.split("/").at(-1)!;
          calls.push(path);
          if (
            action === "bindings" &&
            new Headers(init?.headers).get("authorization") === `Bearer ${owner.credential}`
          ) {
            if (outcome === "abort") process.emit("SIGINT");
            if (outcome === "network") throw new Error("fixture network unavailable");
            return Response.json(
              {
                ok: false,
                error: {
                  code:
                    outcome === "403"
                      ? "FORBIDDEN"
                      : outcome === "404"
                        ? "NOT_FOUND"
                        : "UNAUTHENTICATED",
                },
              },
              { status: outcome === "403" ? 403 : outcome === "404" ? 404 : 401 },
            );
          }
          if (path === "/api/runtime-settings/poll") {
            queueMicrotask(() => process.emit("SIGINT"));
            return Response.json({
              ok: true,
              data: {
                protocol: 1,
                deviceId: (await f.next.read())!.deviceId,
                configRevision: 0,
                catalog: null,
                operation: null,
                applied: null,
                current: false,
                currentBinding: null,
              },
            });
          }
          if (action === "heartbeat")
            return Response.json({
              ok: true,
              data: {
                protocol: 1,
                state: "registered",
                verification: "unverified",
                lastSeenAt: new Date().toISOString(),
              },
            });
          const data = await f.connector.client.call(
            action as "begin",
            JSON.parse(String(init?.body ?? "{}")),
            new Headers(init?.headers).get("authorization")?.replace("Bearer ", ""),
          );
          return Response.json({ ok: true, data });
        },
      );
      const command = [
        "connect",
        "--server",
        f.scope.server,
        "--state-dir",
        f.stateDir,
        "--profile",
        outcome === "ordinary" ? f.previous.profile : f.next.profile,
        "--organization-id",
        f.scope.organizationId,
        "--room-id",
        f.scope.roomId,
        "--device-alias",
        "New Mac",
      ];
      if (outcome !== "ordinary")
        command.push(
          "--previous-profile",
          f.previous.profile,
          "--recovery-id",
          f.recoveryId,
          "--recovery-chain",
          JSON.stringify({
            version: 1,
            baseProfile: f.baseProfile,
            chain: [
              {
                previousProfile: f.baseProfile,
                recoveryId: f.intermediateId,
                profile: f.previous.profile,
              },
              {
                previousProfile: f.previous.profile,
                recoveryId: f.recoveryId,
                profile: f.next.profile,
              },
            ],
          }),
        );
      const timeout = setTimeout(() => process.emit("SIGINT"), 3000);
      try {
        if (outcome === "401" || outcome === "403") await main(command);
        else await assert.rejects(main(command));
      } finally {
        clearTimeout(timeout);
      }
      assert.deepEqual(await readFile(c.settings.file), settingsBytes);
      assert.deepEqual(c.requests, oldRequests);
      if (outcome === "network") {
        assert.deepEqual(await readFile(f.previous.file), profileBytes);
        assert.deepEqual(calls, ["/api/connector/bindings"]);
      } else assert.deepEqual(await f.previous.read(), { ...owner, status: "disconnected" });
      if (outcome === "401" || outcome === "403") {
        assert.equal(f.calls.filter((call) => call === "begin").length, 1);
        assert.equal(f.calls.filter((call) => call === "exchange").length, 1);
        assert.equal(confirmations.filter((question) => question.includes("revoked")).length, 1);
        assert.equal(confirmations.filter((question) => question.includes("yes")).length, 1);
        assert.match(output.join(""), /미완료 AI 설정과 목록 조회 결과는 확인 불가/);
        assert.equal((await f.next.read())!.status, "connected");
        assert.equal(opened, 1);
      } else {
        assert.ok(!f.calls.includes("exchange"));
        if (outcome !== "web-scope") assert.ok(!f.calls.includes("begin"));
      }
      assert.equal(f.adapter.starts, 0);
      assert.equal(f.adapter.prepares, 0);
    } finally {
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
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
      owner.credentialExpiresAt = new Date(Date.now() + 604800000).toISOString();
      if (fault === "live") {
        owner.status = "connected";
      }
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
      const owner = (await f.previous.read())!;
      owner.credentialExpiresAt = new Date(Date.now() + 604800000).toISOString();
      await f.previous.write(owner);
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

for (const intermediate of [false, true])
  test(`should resume unfinished settings on an already approved recovery target with ${intermediate ? "multiple" : "one"} recovery generation`, async () => {
    const f = await fixture(intermediate);
    try {
      await f.run();
      const targetRuntime = new RuntimeStore(f.stateDir, f.next.profile, f.scope.agentId);
      await targetRuntime.write(f.record);
      const c = await unappliedSetup({ ...f, previous: f.next, runtime: targetRuntime }, false);
      const owner = (await f.next.read())!;
      owner.status = "connected";
      await f.next.write(owner);
      const before = await readFile(c.settings.file),
        previous = await readFile(f.previous.file),
        target = await readFile(f.next.file);
      f.calls.length = 0;
      f.interaction.confirmPreviousRevoked = async () =>
        assert.fail("existing target must not approve a new device");
      await f.run();
      assert.deepEqual(await readFile(c.settings.file), before);
      assert.deepEqual(await readFile(f.previous.file), previous);
      assert.deepEqual(await readFile(f.next.file), target);
      assert.equal(f.calls.filter((action) => ["begin", "exchange"].includes(action)).length, 0);
      assert.equal(f.adapter.starts, 0);
    } finally {
      await f.close();
    }
  });

test("should require fresh approval consistently after server rejection and preserve unfinished settings through new approval", async () => {
  const f = await fixture();
  try {
    await f.run();
    const runtime = new RuntimeStore(f.stateDir, f.next.profile, f.scope.agentId);
    await runtime.write(f.record);
    const c = await unappliedSetup({ ...f, previous: f.next, runtime }, false);
    const owner = (await f.next.read())!;
    owner.status = "connected";
    await f.next.write(owner);
    const journal = await readFile(c.settings.file);
    const originalCall = f.connector.client.call.bind(f.connector.client);
    f.connector.client.call = async (...args) => {
      if (args[0] === "bindings") throw new ConnectionError("UNAUTHENTICATED");
      return originalCall(...args);
    };
    await assert.rejects(f.run(), { code: "UNAUTHENTICATED" });
    assert.equal((await f.next.read())!.status, "disconnected");
    const rejected = await readFile(f.next.file);
    await assert.rejects(f.run(), { code: "UNAUTHENTICATED" });
    assert.deepEqual(await readFile(c.settings.file), journal);
    assert.deepEqual(await readFile(f.next.file), rejected);
    f.connector.client.call = originalCall;
    const recoveryId = uuid();
    const profile = `web-${createHash("sha256")
      .update(JSON.stringify(["connection-recovery", f.next.profile, recoveryId]))
      .digest("hex")
      .slice(0, 32)}`;
    const next = new StateStore(f.stateDir, profile);
    f.calls.length = 0;
    await prepareConnection(
      new Connector(next, f.connector.client),
      {
        organizationId: f.scope.organizationId,
        roomId: f.scope.roomId,
        deviceAlias: "New Mac",
        previousProfile: f.next.profile,
        recoveryId,
      },
      f.interaction,
      f.runner,
    );
    assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
    assert.equal((await next.read())!.status, "connected");
    assert.deepEqual(await readFile(c.settings.file), journal);
    assert.deepEqual(await readFile(f.next.file), rejected);
    assert.equal(f.adapter.starts, 0);
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

for (const kind of ["legacy", "configured"] as const)
  test(`should recover a disconnected future-expiry intermediate ancestor with ${kind} histories and repeat the same command`, async () => {
    const f = await fixture(true);
    try {
      const c = kind === "configured" ? await configured(f) : undefined;
      const history = c?.current ?? f.runtime;
      const record = (await history.read())!;
      appendFixtureCompletion(record);
      // Seed a completed history directly; this is not a runtime transition under test.
      await writeFile(history.file, JSON.stringify(record), { mode: 0o600 });
      const owner = (await f.previous.read())!;
      owner.credentialExpiresAt = new Date(Date.now() + 604800000).toISOString();
      await f.previous.write(owner);
      const files = [
        f.previous.file,
        f.runtime.file,
        ...(c ? [c.settings.file, c.current.file] : []),
      ];
      const before = await Promise.all(files.map((file) => readFile(file)));
      let cancellations = 0;
      f.interaction.confirmPreviousRevoked = async () => {
        assert.equal(f.calls.length, 0);
        cancellations++;
        return true;
      };
      await f.run();
      assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
      assert.equal(cancellations, 1);
      assert.equal((await f.next.read())!.status, "connected");
      assert.deepEqual((await f.next.read())!.mappings, []);
      assert.equal(await new SettingsStore(f.next).read(), undefined);
      const nextBytes = await readFile(f.next.file);
      f.calls.length = 0;
      await f.run();
      assert.deepEqual(f.calls, ["bindings"]);
      assert.equal(cancellations, 1);
      assert.deepEqual(await readFile(f.next.file), nextBytes);
      assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
      assert.equal((await history.read())!.attempts[0].state, "UPLOADED");
      assert.equal(f.adapter.starts, 0);
      assert.equal(f.adapter.prepares, 0);
    } finally {
      await f.close();
    }
  });

async function configuredClaude(f: Awaited<ReturnType<typeof fixture>>, materialized = true) {
  const c = await configured(f);
  const record = claudeRecord(c.record);
  record.context!.materialization = {
    ...record.context!.materialization!,
    state: materialized ? "MATERIALIZED" : "RESERVED",
    initHash: materialized ? digest("synthetic-initialization") : null,
  };
  // Establish a Claude fixture directly rather than changing an existing Codex generation.
  await writeFile(c.current.file, JSON.stringify(record), { mode: 0o600 });
  const state = (await c.settings.read())!;
  state.current!.provider = "claude";
  const pointer = state.current!,
    operationId = uuid();
  const receipt = {
    operationId,
    state: "APPLIED" as const,
    configRevision: pointer.configRevision,
    runtime: "claude" as const,
    ...record.settings!.requested,
    snapshotHash: record.settings!.capabilities.snapshotHash,
    localRootReference: pointer.localRootReference,
    repositoryAlias: "Repository",
    sessionAlias: "Session",
    catalog: null,
    bindingEpoch: pointer.bindingEpoch,
    agentId: pointer.agentId,
    workspaceId: pointer.workspaceId,
  };
  state.journal = {
    operation: {
      operationId,
      deviceId: state.deviceId,
      expectedConfigRevision: 0,
      state: "REQUESTED",
      requested: {
        operationId,
        deviceId: state.deviceId,
        expectedConfigRevision: 0,
        runtime: "claude",
      },
      receipt: null,
    },
    phase: "APPLIED",
    generation: pointer.generation,
    localRootReference: pointer.localRootReference,
    root: record.context!.root,
    settings: record.settings!,
    context: structuredClone(record.context!),
    receipt,
    reason: null,
    catalogContext: {
      ...structuredClone(record.context!),
      threadId: uuid(),
      ownedTurns: [],
      materialization: { ...record.context!.materialization!, state: "RESERVED", initHash: null },
    },
  };
  await writeFile(c.settings.file, JSON.stringify(state), { mode: 0o600 });
  assert.ok(await c.settings.read());
  const owner = (await f.previous.read())!;
  owner.mappings[0].runtime = "claude";
  owner.mappings[0].materialization = materialized ? "MATERIALIZED" : "RESERVED";
  await f.previous.write(owner);
  return { ...c, record, state };
}

test("should recover a materialized Claude session whose closed catalog reservation has a different thread", async () => {
  const f = await fixture();
  try {
    const c = await configuredClaude(f);
    assert.notEqual(c.state.journal!.catalogContext!.threadId, c.record.context!.threadId);
    const files = [f.previous.file, c.settings.file, c.current.file];
    const before = await Promise.all(files.map((file) => readFile(file)));
    await f.run();
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
    assert.equal(f.adapter.starts, 0);
  } finally {
    await f.close();
  }
});

test("should recover a valid Claude reservation that expired before its first question", async () => {
  const f = await fixture();
  try {
    const c = await configuredClaude(f, false);
    const files = [f.previous.file, c.settings.file, c.current.file];
    const before = await Promise.all(files.map((file) => readFile(file)));
    await f.run();
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
    assert.equal(f.adapter.starts, 0);
  } finally {
    await f.close();
  }
});

for (const fault of ["policy", "version", "epoch", "materialized"] as const)
  test(`should refuse an inconsistent Claude catalog ${fault} before fresh approval`, async () => {
    const f = await fixture();
    try {
      const c = await configuredClaude(f),
        catalog = c.state.journal!.catalogContext!;
      if (fault === "policy") catalog.materialization!.policyFingerprint = digest("other-policy");
      if (fault === "version") catalog.materialization!.version = "2.1.286";
      if (fault === "epoch") catalog.epoch++;
      if (fault === "materialized")
        catalog.materialization = {
          ...catalog.materialization!,
          state: "MATERIALIZED",
          initHash: digest("other-init"),
        };
      await writeFile(c.settings.file, JSON.stringify(c.state), { mode: 0o600 });
      await assert.rejects(f.run(), { code: "CONTEXT_UNCONFIRMED" });
      assert.equal(f.calls.length, 0);
      assert.equal(await f.next.read(), undefined);
    } finally {
      await f.close();
    }
  });

test("should preserve a completed answer without a server receipt through explicit fresh approval", async () => {
  const f = await fixture();
  try {
    const c = await configuredClaude(f);
    const attempt = appendFixtureCompletion(c.record, 0);
    attempt.state = "TERMINAL";
    attempt.receipt = null;
    attempt.nativeIntent = {
      provider: "claude",
      sessionId: c.record.context!.threadId,
      inputId: attempt.native!.turnId,
      promptHash: digest("synthetic-question"),
      generation: attempt.generation,
      scope: attempt.scope,
      attemptId: attempt.snapshot!.attemptId,
      fence: attempt.snapshot!.fence,
      policyFingerprint: c.record.context!.materialization!.policyFingerprint,
    };
    Object.assign(c.record.context!.ownedTurns[0], {
      promptHash: digest("synthetic-question"),
      resultHash: digest("synthetic-result"),
      toolReceipts: [],
    });
    c.record.operations = c.record.operations.filter(
      (operation) => operation.action !== "complete",
    );
    await writeFile(c.current.file, JSON.stringify(c.record), { mode: 0o600 });
    assert.equal((await c.current.read())!.attempts[0].state, "TERMINAL");
    const files = [f.previous.file, c.settings.file, c.current.file];
    const before = await Promise.all(files.map((file) => readFile(file)));
    let confirmations = 0;
    f.interaction.confirmUnresolved = async (count) => {
      assert.equal(count, 1);
      confirmations++;
      return true;
    };
    await f.run();
    assert.equal(confirmations, 1);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    assert.equal((await c.current.read())!.attempts[0].receipt, null);
    assert.equal(f.adapter.starts, 0);
    assert.deepEqual((await f.next.read())!.mappings, []);
    await assert.rejects(
      withSettingsDeviceLock(f.previous, "revoke-local", (settings) =>
        revokeConfiguredProfile(f.previous, settings),
      ),
      { code: "RUNTIME_BUSY" },
    );
  } finally {
    await f.close();
  }
});

async function unresolvedClaude(f: Awaited<ReturnType<typeof fixture>>) {
  const c = await configuredClaude(f),
    attempt = appendFixtureCompletion(c.record, 0);
  attempt.state = "UNKNOWN";
  attempt.reason = "RUNTIME_CAPACITY";
  attempt.terminal = null;
  attempt.receipt = null;
  attempt.nativeIntent = {
    provider: "claude",
    sessionId: c.record.context!.threadId,
    inputId: attempt.native!.turnId,
    promptHash: digest("synthetic-question"),
    generation: attempt.generation,
    scope: attempt.scope,
    attemptId: attempt.snapshot!.attemptId,
    fence: attempt.snapshot!.fence,
    policyFingerprint: c.record.context!.materialization!.policyFingerprint,
  };
  attempt.toolCalls.push({
    callId: uuid(),
    payloadHash: digest("pending-tool"),
    operationId: null,
    result: null,
  });
  c.record.context!.ownedTurns = [];
  c.record.context!.level = "L1";
  c.record.operations = c.record.operations.filter((operation) => operation.action !== "complete");
  await writeFile(c.current.file, JSON.stringify(c.record), { mode: 0o600 });
  const owner = (await f.previous.read())!;
  owner.credentialExpiresAt = new Date(Date.now() + 604800000).toISOString();
  await f.previous.write(owner);
  assert.equal((await c.current.read())!.attempts[0].state, "UNKNOWN");
  return c;
}

test("should preserve an unknown Claude answer and pending tool bytes after explicit fresh-conversation approval", async () => {
  const f = await fixture();
  try {
    const c = await unresolvedClaude(f);
    const files = [f.previous.file, c.settings.file, c.current.file],
      before = await Promise.all(files.map((file) => readFile(file)));
    let confirmations = 0;
    f.interaction.confirmUnresolved = async (count) => {
      assert.equal(count, 1);
      assert.equal(f.calls.length, 0);
      confirmations++;
      return true;
    };
    await f.run();
    assert.equal(confirmations, 1);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
    assert.equal((await c.current.read())!.attempts[0].state, "UNKNOWN");
    assert.equal(await new SettingsStore(f.next).read(), undefined);
    assert.deepEqual((await f.next.read())!.mappings, []);
    assert.equal(f.adapter.starts, 0);
    assert.ok(f.notices.join("").includes("결과 확인 불가"));
    await assert.rejects(
      withSettingsDeviceLock(f.previous, "revoke-local", (settings) =>
        revokeConfiguredProfile(f.previous, settings),
      ),
      { code: "RUNTIME_BUSY" },
    );
    f.calls.length = 0;
    await f.run();
    assert.equal(confirmations, 2);
    assert.equal(f.calls.includes("begin"), false);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file))), before);
  } finally {
    await f.close();
  }
});

for (const fault of [
  "declined",
  "missing-consent",
  "running",
  "pending-operation",
  "terminal",
  "native-lock",
] as const)
  test(`should reject unresolved recovery with ${fault} before fresh pairing`, async () => {
    const f = await fixture();
    try {
      const c = await unresolvedClaude(f);
      f.interaction.confirmUnresolved = async () => fault !== "declined";
      if (fault === "missing-consent") delete f.interaction.confirmUnresolved;
      if (fault === "running") {
        const attempt = c.record.attempts[0],
          operationId = uuid();
        attempt.state = "RUNNING";
        attempt.reason = null;
        const body = {
          protocol: 1,
          agentId: c.record.scope.agentId,
          bindingEpoch: c.record.scope.bindingEpoch,
          operationId,
          requestId: attempt.requestId,
          attemptId: attempt.snapshot!.attemptId,
          fence: attempt.snapshot!.fence,
        };
        c.record.operations.push({
          operationId,
          action: "start-intent",
          body,
          payloadHash: digest(stableJson({ action: "start-intent", body })),
          state: "CONFIRMED",
          result: structuredClone(attempt.snapshot),
        });
      }
      if (fault === "pending-operation") {
        const attempt = c.record.attempts[0],
          operationId = uuid();
        const body = {
          protocol: 1,
          agentId: c.record.scope.agentId,
          bindingEpoch: c.record.scope.bindingEpoch,
          operationId,
          requestId: attempt.requestId,
          attemptId: attempt.snapshot!.attemptId,
          fence: attempt.snapshot!.fence,
        };
        c.record.operations.push({
          operationId,
          action: "lease",
          body,
          payloadHash: digest(stableJson({ action: "lease", body })),
          state: "PENDING",
          result: null,
        });
      }
      if (fault === "terminal") {
        const completed = appendFixtureCompletion(c.record, 0);
        c.record.attempts[0].terminal = completed.terminal;
        c.record.attempts[0].terminal!.turnId = c.record.attempts[0].native!.turnId;
        c.record.attempts.pop();
        c.record.context!.ownedTurns = [];
        c.record.context!.level = "L1";
        c.record.operations = c.record.operations.filter(
          (operation) => operation.body.requestId === c.record.attempts[0].requestId,
        );
      }
      await writeFile(c.current.file, JSON.stringify(c.record), { mode: 0o600 });
      assert.ok(await c.current.read());
      const bytes = await readFile(c.current.file);
      const check = async () => {
        await assert.rejects(f.run());
        assert.equal(f.calls.length, 0);
        assert.equal(await f.next.read(), undefined);
        assert.deepEqual(await readFile(c.current.file), bytes);
        assert.equal(f.adapter.starts, 0);
      };
      if (fault === "native-lock") await c.current.sessionLocked(c.record.context!.threadId, check);
      else await check();
    } finally {
      await f.close();
    }
  });

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
      const futureOwner = (await f.previous.read())!;
      futureOwner.credentialExpiresAt = new Date(Date.now() + 604800000).toISOString();
      await f.previous.write(futureOwner);
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
      const owner = (await f.previous.read())!;
      owner.credentialExpiresAt = new Date(Date.now() + 604800000).toISOString();
      await f.previous.write(owner);
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
