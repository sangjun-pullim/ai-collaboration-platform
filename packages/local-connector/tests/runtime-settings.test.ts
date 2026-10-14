import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { ClaudeCatalogStore } from "../src/claude/catalog-store.ts";
import { NativeClaudePolicy } from "../src/claude/native-policy.ts";
import { join } from "node:path";
import { StateStore } from "../src/state-store.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type Capabilities,
  type OwnedContext,
  type RuntimeAdapter,
} from "../src/runtime-contracts.ts";
import {
  SettingsManager,
  type SettingsManagerOptions,
  type SettingsManagerStatus,
} from "../src/settings/manager.ts";
import { SettingsClient } from "../src/settings/client.ts";
import { SettingsStore } from "../src/settings/store.ts";
import type { RuntimeStore } from "../src/runtime-store.ts";
import {
  capabilityHash,
  jsonbTextBytes,
  type Body,
  type Receipt,
  type SettingsResponse,
  SettingsError,
} from "../src/settings/contracts.ts";
import { runtimeFixture, uuid, observation } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { runnerFixture, deferred, SyntheticAdapter } from "./runner-fixture.ts";
import { WorkflowRunner } from "../src/workflow-runner.ts";
import { WorkflowClient } from "../src/workflow-client.ts";
import { ConnectionError } from "../src/contracts.ts";
import { ConnectionRenewal } from "../src/connection-renewal.ts";
import { Connector } from "../src/cli.ts";
import { CentralClient } from "../src/central-client.ts";
import { createHash } from "node:crypto";
import { prepareConnection, type ConnectInput } from "../src/cli/connect-command.ts";
import {
  prepareSelectedConnection,
  selectConnectionProfile,
} from "../src/cli/connection-recovery.ts";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";

/** This HTTP fixture exercises the real client's projection, not an actual DB transaction. */
async function fixture(provider: "codex" | "claude" = "codex", profileName = "one") {
  const f = await runtimeFixture();
  const profile = new StateStore(f.stateDir, profileName);
  const store = new SettingsStore(profile);
  const operationId = uuid();
  let response: SettingsResponse = {
    protocol: 1,
    deviceId: f.scope.deviceId,
    configRevision: 0,
    catalog: null,
    operation: {
      operationId,
      deviceId: f.scope.deviceId,
      expectedConfigRevision: 0,
      state: "REQUESTED",
      requested: {
        operationId,
        deviceId: f.scope.deviceId,
        expectedConfigRevision: 0,
        runtime: provider,
      },
      receipt: null,
    },
    applied: null,
    current: true,
    currentBinding: null,
  };
  await profile.write({
    version: 1,
    server: f.scope.server,
    status: "connected",
    deviceId: f.scope.deviceId,
    credential: "a".repeat(64),
    credentialExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    scope: {
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
      ownerAlias: "Owner",
      organizationName: "Org",
      roomTitle: "Room",
      deviceAlias: "Device",
    },
    mappings: [],
  });
  const requests: { action: string; body: Body; secret: string | null }[] = [];
  let failCommittedResponse = false;
  let failBeforeCommit = false;
  let receiptHook: ((receipt: Receipt) => void) | undefined;
  let refusePoll = false;
  let unauthenticatedPoll = false;
  let pollHook: (() => Promise<void> | void) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push({ action, body, secret: new Headers(init?.headers).get("authorization") });
    if (action === "poll") {
      await pollHook?.();
      if (unauthenticatedPoll)
        return Response.json({ ok: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
      if (refusePoll)
        return Response.json({ ok: false, error: { code: "FORBIDDEN" } }, { status: 403 });
    } else {
      const receipt = body as unknown as Receipt;
      if (receipt.state === "COMMITTED") {
        if (failBeforeCommit) {
          failBeforeCommit = false;
          throw new Error("commit was not received");
        }
        assert.equal(
          response.operation!.state === "APPLYING" || response.operation!.state === "COMMITTED",
          true,
        );
        const confirmed = {
          ...receipt,
          agentId: receipt.agentId ?? f.scope.agentId,
          workspaceId: receipt.workspaceId ?? uuid(),
        };
        if (response.operation!.state === "COMMITTED")
          assert.deepEqual(
            receipt,
            requests.filter((r) => r.action === "receipt" && r.body.state === "COMMITTED")[0].body,
          );
        else {
          response = {
            ...response,
            configRevision: confirmed.configRevision,
            currentBinding: {
              agentId: confirmed.agentId,
              workspaceId: confirmed.workspaceId,
              bindingEpoch: confirmed.bindingEpoch!,
              runtime: confirmed.runtime!,
            },
            operation: { ...response.operation!, state: "COMMITTED", receipt: confirmed },
          };
        }
        if (failCommittedResponse) {
          failCommittedResponse = false;
          throw new Error("lost exact commit response");
        }
      } else {
        response = {
          ...response,
          catalog: receipt.catalog ?? response.catalog,
          applied: receipt.state === "APPLIED" ? receipt : response.applied,
          operation: {
            ...response.operation!,
            state: receipt.state,
            receipt: { ...receipt, catalog: null },
          },
        };
      }
    }
    if (action === "receipt") receiptHook?.(body as unknown as Receipt);
    const hiddenTerminal =
      action === "poll" &&
      (response.operation?.state === "APPLIED" ||
        (response.operation?.state === "CANCELLED" &&
          response.operation.receipt?.state === "CANCELLED")) &&
      body.operationId !== response.operation?.operationId;
    return Response.json({
      ok: true,
      data: hiddenTerminal ? { ...response, operation: null } : response,
    });
  };
  const client = new SettingsClient(f.scope.server, fetcher);
  let prepares = 0,
    catalogs = 0,
    closes = 0;
  let observedCaps: Capabilities =
    provider === "claude" ? claudeRecord(f.record).settings!.capabilities : f.settings.capabilities;
  const adapters: RuntimeAdapter[] = [];
  const options: SettingsManagerOptions = {
    pollIntervalMs: 2,
    folder: async () => ({ status: "SELECTED", root: f.policy.root }),
    confirm: async () => ({
      confirmed: true,
      repositoryAlias: "Repository",
      files: [...f.policy.files],
      handoff: "Shared evidence.",
    }),
    adapter: (runtime, reserveCatalog) => {
      const adapter: RuntimeAdapter = {
        capabilities: async (root, check) => {
          check();
          catalogs++;
          if (runtime === "claude") {
            const reserved = await reserveCatalog(
              root,
              observedCaps.version,
              digest("verified-policy-fixture"),
            );
            const durable = (await store.read())!.journal!.catalogContext;
            assert.deepEqual(durable, reserved);
          }
          return structuredClone(observedCaps);
        },
        prepare: async (root, settings, generation, epoch, check, onCreated) => {
          check();
          prepares++;
          assert.equal((await store.read())!.journal!.phase, "PREPARE_INTENT");
          const context: OwnedContext = {
            ownership: "CONNECTOR_CREATED",
            generation,
            threadId: uuid(),
            root,
            epoch,
            level: "L1",
            ownedTurns: [],
            ...(runtime === "claude"
              ? {
                  provider: runtime,
                  materialization: {
                    state: "RESERVED" as const,
                    version: settings.capabilities.version,
                    policyFingerprint: digest("verified-policy-fixture"),
                    initHash: null,
                  },
                }
              : {}),
          };
          await onCreated!(context);
          assert.deepEqual((await store.read())!.journal!.context, context);
          return context;
        },
        validate: async (_context, settings) => observation(settings),
        execute: async () => {
          throw new Error("no input authorized in settings fixture");
        },
        observe: async () => null,
        interrupt: async () => false,
        close: async () => {
          closes++;
        },
      };
      adapters.push(adapter);
      return adapter;
    },
  };
  const manager = (changes: SettingsManagerOptions = {}) =>
    new SettingsManager(profile, store, client, { ...options, ...changes });
  const applying = () => {
    const local = response.operation!.receipt!;
    const selection = response.catalog!.defaultSettings!;
    response.operation = {
      ...response.operation!,
      state: "APPLYING",
      requested: {
        operationId: response.operation!.operationId,
        deviceId: response.deviceId,
        expectedConfigRevision: response.configRevision,
        runtime: local.runtime,
        ...selection,
        snapshotHash: response.catalog!.snapshotHash,
        localRootReference: local.localRootReference,
        repositoryAlias: local.repositoryAlias,
        sessionAlias: "Session",
        expectedEpoch: response.currentBinding?.bindingEpoch ?? null,
      },
    };
  };
  return {
    ...f,
    profile,
    store,
    client,
    manager,
    applying,
    requests,
    options,
    adapters,
    get response() {
      return response;
    },
    set response(value) {
      response = value;
    },
    get pollHook(): (() => Promise<void> | void) | undefined {
      return pollHook;
    },
    set pollHook(value: (() => Promise<void> | void) | undefined) {
      pollHook = value;
    },
    get failCommittedResponse() {
      return failCommittedResponse;
    },
    set failCommittedResponse(value: boolean) {
      failCommittedResponse = value;
    },
    get refusePoll() {
      return refusePoll;
    },
    set refusePoll(value: boolean) {
      refusePoll = value;
    },
    get unauthenticatedPoll() {
      return unauthenticatedPoll;
    },
    set unauthenticatedPoll(value: boolean) {
      unauthenticatedPoll = value;
    },
    get receiptHook() {
      return receiptHook;
    },
    set receiptHook(value: ((receipt: Receipt) => void) | undefined) {
      receiptHook = value;
    },
    get failBeforeCommit() {
      return failBeforeCommit;
    },
    set failBeforeCommit(value: boolean) {
      failBeforeCommit = value;
    },
    get prepares() {
      return prepares;
    },
    get catalogs() {
      return catalogs;
    },
    get closes() {
      return closes;
    },
    get observedCaps() {
      return observedCaps;
    },
    set observedCaps(value: Capabilities) {
      observedCaps = value;
    },
  };
}
type ObservedManagerOptions = SettingsManagerOptions & {
  onStatus: (status: SettingsManagerStatus) => void;
};

for (const code of ["UNAUTHENTICATED", "FORBIDDEN"] as const) {
  test(`should report ${code} while persistent settings polling is still running`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 250);
    try {
      f.response = { ...f.response, operation: null };
      f.unauthenticatedPoll = code === "UNAUTHENTICATED";
      f.refusePoll = code === "FORBIDDEN";
      let settled = false;
      const observed: SettingsManagerStatus[] = [];
      const options: ObservedManagerOptions = {
        onStatus: (status) => {
          assert.equal(settled, false);
          observed.push(status);
          if (observed.length === 2) abort.abort();
        },
      };
      await f
        .manager(options)
        .run({ signal: abort.signal })
        .finally(() => {
          settled = true;
        });
      assert.equal(observed.length, 2, "failures must be visible before run returns");
      assert.deepEqual(
        observed.map((status) => status.reason),
        [code, code],
      );
      assert.ok(observed.every((status) => !status.ready));
      assert.equal(f.requests.length, 2);
      assert.ok(f.requests.every((request) => request.action === "poll"));
      assert.equal(f.catalogs, 0);
      assert.equal(f.prepares, 0);
      assert.equal(await f.store.read(), undefined);
      assert.equal((await f.profile.read())!.status, "connected");
    } finally {
      clearTimeout(timer);
      abort.abort();
      await f.close();
    }
  });
}

test("should report the existing UNKNOWN authentication journal without repairing it", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 250);
  try {
    await f.manager().run({ once: true });
    const state = (await f.store.read())!;
    state.journal!.phase = "UNKNOWN";
    state.journal!.reason = "UNAUTHENTICATED";
    await f.store.write(state);
    f.unauthenticatedPoll = true;
    const profile = await readFile(f.profile.file);
    const observed: SettingsManagerStatus[] = [];
    const options: ObservedManagerOptions = {
      onStatus: (status) => {
        observed.push(status);
        if (status.reason === "UNAUTHENTICATED") abort.abort();
      },
    };
    await f.manager(options).run({ signal: abort.signal });
    assert.ok(
      observed.some(
        (status) =>
          status.state === "UNKNOWN" && status.reason === "UNAUTHENTICATED" && !status.ready,
      ),
    );
    assert.equal((await f.store.read())!.current, null);
    assert.equal((await f.store.read())!.journal!.phase, "UNKNOWN");
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.prepares, 0);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await f.close();
  }
});

test("should isolate observer mutations and exceptions from settings and persistent control flow", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 250);
  try {
    f.response = { ...f.response, operation: null };
    const profile = await readFile(f.profile.file);
    let calls = 0;
    const options: ObservedManagerOptions = {
      onStatus: (status) => {
        calls++;
        status.ready = true;
        status.state = "APPLIED";
        status.reason = "UNAUTHENTICATED";
        if (calls === 3) abort.abort();
        throw new Error("observer is not manager control flow");
      },
    };
    const result = await f.manager(options).run({ signal: abort.signal });
    assert.equal(calls, 3);
    assert.equal(result.state, "UNCONFIGURED");
    assert.equal(result.ready, false);
    assert.equal(result.reason, null);
    assert.equal(f.requests.length, 3);
    assert.equal(await f.store.read(), undefined);
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.catalogs, 0);
    assert.equal(f.prepares, 0);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await f.close();
  }
});

test("should deduplicate displayed authentication failures and show recovery then recurrence during polling", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 250);
  try {
    const helper = new URL("../src/cli/settings-status.js", import.meta.url).href;
    const { createSettingsStatusSink } = await import(helper);
    const messages: string[] = [];
    const sink = createSettingsStatusSink({
      origin: f.client.origin,
      roomId: f.scope.roomId,
      write: (message: string) => messages.push(message),
    });
    f.response = { ...f.response, operation: null };
    let polls = 0;
    f.pollHook = () => {
      polls++;
      f.unauthenticatedPoll = polls !== 3;
    };
    const options: ObservedManagerOptions = {
      onStatus: (status) => {
        sink(status);
        if (polls === 4) abort.abort();
      },
    };
    await f.manager(options).run({ signal: abort.signal });
    assert.equal(polls, 4);
    assert.equal(messages.length, 3);
    assert.match(messages[0], /서버.*인증.*거부/);
    assert.match(messages[1], /AI.*폴더/);
    assert.equal(messages[2], messages[0]);
    assert.equal(f.requests.length, 4);
    assert.equal(f.prepares, 0);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await f.close();
  }
});

test("should display setup completion while the actual runner remains active without claiming live readiness", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const entered = deferred(),
    release = deferred();
  const timer = setTimeout(() => {
    abort.abort();
    entered.resolve();
    release.resolve();
  }, 3000);
  let job: ReturnType<SettingsManager["run"]> | undefined;
  try {
    await local(f);
    const helper = new URL("../src/cli/settings-status.js", import.meta.url).href;
    const { createSettingsStatusSink } = await import(helper);
    const messages: string[] = [];
    const sink = createSettingsStatusSink({
      origin: f.client.origin,
      write: (message: string) => messages.push(message),
    });
    const adapter = new SyntheticAdapter();
    adapter.validateHook = async () => {
      entered.resolve();
      await release.promise;
    };
    const observed: SettingsManagerStatus[] = [];
    let runtimeStore: RuntimeStore | undefined;
    let runtimeReadyWhileRunning = false,
      settled = false;
    const workflowActions: string[] = [];
    f.pollHook = async () => {
      if (!runtimeStore) return;
      const record = await runtimeStore.read();
      if (record?.ready && workflowActions.filter((action) => action === "poll").length >= 3) {
        runtimeReadyWhileRunning = !settled;
        abort.abort();
      }
    };
    const options: ObservedManagerOptions = {
      onStatus: (status) => {
        observed.push(status);
        sink(status);
      },
      runner: (pointer, store) => {
        runtimeStore = store;
        const fetcher: typeof fetch = async (url, init) => {
          const action = String(url).split("/").at(-1)!;
          const body = JSON.parse(String(init?.body));
          workflowActions.push(action);
          const identity = { agentId: pointer.agentId, bindingEpoch: pointer.bindingEpoch };
          let data: unknown;
          if (action === "source-support") data = { version: 2, ...identity };
          else if (action === "poll")
            data = {
              ...identity,
              roomId: f.scope.roomId,
              roomRevision: 1,
              roomMode: "ACTIVE",
              reportedReady: true,
              validUntil: new Date(Date.now() + 60000).toISOString(),
              queuedRequest: null,
              attempt: null,
              control: null,
            };
          else if (action === "admission" || action === "admission-ack")
            data = {
              ...identity,
              revision: 1,
              paused: false,
              appliedRevision: 1,
              appliedEpoch: pointer.bindingEpoch,
              appliedAt: new Date().toISOString(),
            };
          else if (action === "ready")
            data = {
              ...identity,
              reportedReady: body.reportedReady,
              verification: "reported",
              validUntil: body.reportedReady ? new Date(Date.now() + 60000).toISOString() : null,
            };
          else assert.fail(`unexpected workflow action: ${action}`);
          return Response.json({ ok: true, data });
        };
        return new WorkflowRunner(
          f.profile,
          store,
          new WorkflowClient(f.client.origin, fetcher),
          adapter,
          {
            rotate: async () => assert.fail("no credential rotation expected"),
            bindings: async () => assert.fail("no new binding request expected"),
            replace: async () => assert.fail("no replacement expected"),
          },
          { pollIntervalMs: 2 },
        );
      },
    };
    job = f
      .manager(options)
      .run({ signal: abort.signal })
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    assert.equal(settled, false);
    assert.match(messages.at(-1)!, /설정 적용 완료.*질문 가능한 상태.*웹 채팅방.*확인/);
    assert.equal((await runtimeStore!.read())!.ready, false);
    release.resolve();
    await job;
    const preparing = observed.findIndex((status) => status.state === "PREPARE_INTENT");
    assert.ok(preparing >= 0, "preparation must be visible before the poll finishes");
    assert.ok(observed.findIndex((status) => status.state === "APPLIED") > preparing);
    assert.equal(observed[preparing].ready, false);
    assert.equal(runtimeReadyWhileRunning, true);
    assert.ok(observed.every((status) => !status.ready));
    assert.match(messages.at(-1)!, /설정 적용 완료.*웹 채팅방.*확인/);
    assert.ok(!messages.join("").includes("준비 완료"));
    assert.equal(adapter.starts, 0);
    assert.equal(adapter.prepares, 0);
    assert.equal(adapter.closed, true);
    assert.equal(f.prepares, 1);
    assert.equal(f.catalogs, 2);
    assert.equal(f.closes, 2);
    assert.equal((await f.store.read())!.journal!.phase, "APPLIED");
  } finally {
    clearTimeout(timer);
    abort.abort();
    release.resolve();
    await job;
    await f.close();
  }
});

test("should display restored local confirmation without retaining a previous authentication error", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 250);
  try {
    await f.manager().run({ once: true });
    let polls = 0;
    f.pollHook = () => {
      f.unauthenticatedPoll = ++polls === 1;
    };
    const observed: SettingsManagerStatus[] = [];
    const options: ObservedManagerOptions = {
      onStatus: (status) => {
        observed.push(status);
        if (polls >= 2 && status.state === "LOCAL_CONFIRMATION" && status.reason === null)
          abort.abort();
      },
    };
    await f.manager(options).run({ signal: abort.signal });
    assert.ok(observed.some((status) => status.reason === "UNAUTHENTICATED"));
    assert.equal(observed.at(-1)!.state, "LOCAL_CONFIRMATION");
    assert.equal(observed.at(-1)!.reason, null);
    assert.equal((await f.store.read())!.journal!.phase, "LOCAL_CONFIRMATION");
    assert.equal(f.catalogs, 1);
    assert.equal(f.prepares, 0);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await f.close();
  }
});

test("should replace an old authentication error before the recovered folder chooser settles", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const entered = deferred(),
    release = deferred();
  const timer = setTimeout(() => {
    abort.abort();
    entered.resolve();
    release.resolve();
  }, 3000);
  let job: ReturnType<SettingsManager["run"]> | undefined;
  try {
    const profile = await readFile(f.profile.file);
    const observed: SettingsManagerStatus[] = [];
    let polls = 0,
      settled = false;
    f.pollHook = () => {
      f.unauthenticatedPoll = ++polls === 1;
    };
    job = f
      .manager({
        onStatus: (status) => observed.push(status),
        folder: async () => {
          entered.resolve();
          await release.promise;
          return { status: "SELECTED", root: f.policy.root };
        },
      })
      .run({ signal: abort.signal })
      .finally(() => {
        settled = true;
      });
    await entered.promise;
    assert.equal(settled, false);
    assert.ok(observed.some((status) => status.reason === "UNAUTHENTICATED"));
    assert.equal(observed.at(-1)!.state, "CHOOSING");
    assert.equal(
      observed.at(-1)!.reason,
      null,
      "authenticated recovery must be visible while the chooser is pending",
    );
    assert.equal((await f.store.read())!.journal!.reason, null);
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.catalogs, 0);
    assert.equal(f.prepares, 0);
  } finally {
    clearTimeout(timer);
    abort.abort();
    release.resolve();
    await job;
    await f.close();
  }
});

test("should report the preserved UNKNOWN journal error after successful authentication without changing the run result", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  try {
    await local(f);
    await f
      .manager({
        adapter: () => {
          throw new RuntimeError("UNKNOWN");
        },
      })
      .run({ once: true });
    const before = (await f.store.read())!;
    assert.ok(before.journal!.applyBody);
    assert.equal(before.journal!.phase, "UNKNOWN");
    const settings = await readFile(f.store.file),
      profile = await readFile(f.profile.file);
    const helper = new URL("../src/cli/settings-status.js", import.meta.url).href;
    const { createSettingsStatusSink } = await import(helper);
    const messages: string[] = [];
    const sink = createSettingsStatusSink({
      origin: f.client.origin,
      write: (message: string) => messages.push(message),
    });
    let polls = 0;
    const observed: SettingsManagerStatus[] = [];
    f.pollHook = () => {
      f.unauthenticatedPoll = ++polls === 1;
    };
    const result = await f
      .manager({
        onStatus: (status) => {
          observed.push(status);
          sink(status);
          if (polls >= 2 && status.reason === "UNKNOWN") abort.abort();
        },
      })
      .run({ signal: abort.signal });
    assert.ok(observed.some((status) => status.reason === "UNAUTHENTICATED"));
    assert.equal(observed.at(-1)!.state, "UNKNOWN");
    assert.equal(observed.at(-1)!.reason, "UNKNOWN");
    assert.equal(
      result.reason,
      "UNAUTHENTICATED",
      "display correction must not change the run result",
    );
    assert.match(messages[0], /서버.*인증.*거부/);
    assert.match(messages.at(-1)!, /설정 상태.*확인하지 못/);
    assert.deepEqual(await readFile(f.store.file), settings);
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.prepares, 0);
    assert.equal(f.catalogs, 1);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await f.close();
  }
});

test("should contain asynchronous observer rejection without changing settings, polls or cleanup", async () => {
  const f = await fixture();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 1000);
  try {
    f.response = { ...f.response, operation: null };
    await f.store.write({
      version: 1,
      server: f.scope.server,
      deviceId: f.scope.deviceId,
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
      current: null,
      retained: [],
      journal: null,
    });
    const settings = await readFile(f.store.file),
      profile = await readFile(f.profile.file);
    let callbacks = 0,
      rejections = 0;
    const result = await f
      .manager({
        onStatus: async (status) => {
          callbacks++;
          await Promise.resolve();
          status.state = "APPLIED";
          status.ready = true;
          status.reason = "UNAUTHENTICATED";
          if (callbacks === 3) abort.abort();
          rejections++;
          throw new Error("asynchronous display failure");
        },
      })
      .run({ signal: abort.signal });
    assert.equal(callbacks, 3);
    assert.equal(rejections, 3);
    assert.equal(result.state, "UNCONFIGURED");
    assert.equal(result.ready, false);
    assert.equal(result.reason, null);
    assert.deepEqual(await readFile(f.store.file), settings);
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.requests.length, 3);
    assert.ok(f.requests.every((request) => request.action === "poll"));
    assert.equal(f.catalogs, 0);
    assert.equal(f.prepares, 0);
    assert.equal(f.closes, 0);
  } finally {
    clearTimeout(timer);
    abort.abort();
    await f.close();
  }
});
async function local(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.manager().run({ once: true })).state, "LOCAL_CONFIRMATION");
  assert.equal(f.prepares, 0);
  f.applying();
}

async function reconnectFixture(kind: "plain" | "lineage", provider: "codex" | "claude" = "codex") {
  const f = await fixture(provider, `web-${"a".repeat(32)}`);
  assert.equal((await f.manager().run({ once: true })).state, "LOCAL_CONFIRMATION");
  const input: ConnectInput = {
    organizationId: f.scope.organizationId,
    roomId: f.scope.roomId,
    deviceAlias: "Device",
  };
  let target = f.profile;
  if (kind === "lineage") {
    const recoveryId = uuid(),
      profile = `web-${createHash("sha256")
        .update(JSON.stringify(["connection-recovery", f.profile.profile, recoveryId]))
        .digest("hex")
        .slice(0, 32)}`;
    target = new StateStore(f.stateDir, profile);
    input.previousProfile = f.profile.profile;
    input.recoveryId = recoveryId;
    input.recoveryChain = JSON.stringify({
      version: 1,
      baseProfile: f.profile.profile,
      chain: [{ previousProfile: f.profile.profile, recoveryId, profile }],
    });
  }
  const calls: string[] = [];
  const run = async () => {
    const selection = await selectConnectionProfile(target, input, f.scope.server);
    assert.equal(selection.mode, "normal");
    const client = new CentralClient(f.scope.server, async (url) => {
      const action = String(url).split("/").at(-1)!;
      calls.push(action);
      assert.equal(action, "bindings", "reconnect must not register or create a session");
      return Response.json({ ok: true, data: { protocol: 1, bindings: [] } });
    });
    await prepareSelectedConnection(
      selection,
      () => {},
      (verify) =>
        prepareConnection(
          new Connector(selection.store, client),
          {
            organizationId: input.organizationId,
            roomId: input.roomId,
            deviceAlias: input.deviceAlias,
          },
          {
            interactive: true,
            signal: new AbortController().signal,
            write: () => {},
            confirm: async () => true,
            open: async () => assert.fail("reconnect must not open pairing approval"),
            verifyPreparation: verify,
          },
        ),
    );
  };
  return Object.assign(f, { target, input, calls, reconnect: run });
}

for (const provider of ["codex", "claude"] as const)
  for (const kind of ["plain", "lineage"] as const)
    test(`should resume ${provider} ${kind} reconnect through existing LOCAL_CONFIRMATION recovery without another AI session`, async () => {
      const f = await reconnectFixture(kind, provider);
      try {
        const profile = await readFile(f.profile.file),
          journal = await readFile(f.store.file),
          start = f.requests.length;
        f.response.operation!.state = "REQUESTED";
        f.response.operation!.receipt = null;
        await f.reconnect();
        assert.deepEqual(await readFile(f.store.file), journal);
        const status = await f
          .manager({
            folder: async () => assert.fail("recovery must not reopen setup"),
            adapter: () => assert.fail("recovery must not create another AI session"),
            runner: () => assert.fail("unfinished setup must not run AI inputs"),
          })
          .run({ once: true });
        assert.equal(status.state, "LOCAL_CONFIRMATION");
        assert.deepEqual(f.calls, ["bindings"]);
        assert.deepEqual(
          f.requests.slice(start).map((r) => r.action),
          ["poll", "receipt"],
        );
        assert.deepEqual(f.requests.at(-1)!.body, (await f.store.read())!.journal!.receipt);
        assert.deepEqual(await readFile(f.profile.file), profile);
        assert.deepEqual(await readFile(f.store.file), journal);
        assert.equal(f.prepares, 0);
        assert.equal(f.catalogs, 1);
        if (kind === "lineage") assert.equal(await f.target.read(), undefined);
      } finally {
        await f.close();
      }
    });

for (const applied of [false, true])
  test(`should ${applied ? "preserve UNKNOWN with an apply body" : "replay local confirmation after an uncertain receipt without preparing another context"} through normal connection handoff`, async (t) => {
    const f = await reconnectFixture("lineage");
    try {
      if (applied) {
        f.applying();
        await f
          .manager({
            adapter: () => {
              throw new Error("interrupted after durable apply intent");
            },
          })
          .run({ once: true });
      } else {
        const state = (await f.store.read())!;
        state.journal!.phase = "UNKNOWN";
        state.journal!.reason = "UNKNOWN";
        await f.store.write(state);
      }
      const pending = (await f.store.read())!;
      assert.equal(pending.journal!.phase, "UNKNOWN");
      assert.equal(!!pending.journal!.applyBody, applied);
      assert.ok(pending.journal!.receipt!.catalog);
      const bytes = await readFile(f.store.file),
        start = f.requests.length;
      const events: string[] = [];
      const write = f.store.write.bind(f.store);
      t.mock.method(f.store, "write", async (...args: Parameters<typeof write>) => {
        events.push(`save:${args[0].journal!.phase}`);
        return write(...args);
      });
      f.receiptHook = () => events.push("receipt");
      await f.reconnect();
      assert.deepEqual(await readFile(f.store.file), bytes);
      assert.deepEqual(events, []);
      const status = await f
        .manager({
          folder: async () => assert.fail("recovery must not reopen setup"),
          adapter: () => assert.fail("recovery must not create a provider"),
        })
        .run({ once: true });
      assert.equal(status.state, applied ? "UNKNOWN" : "LOCAL_CONFIRMATION");
      assert.deepEqual(events, applied ? ["save:UNKNOWN"] : ["receipt", "save:LOCAL_CONFIRMATION"]);
      assert.deepEqual(
        f.requests.slice(start).map((r) => r.action),
        applied ? ["poll"] : ["poll", "receipt"],
      );
      if (applied) assert.deepEqual(await readFile(f.store.file), bytes);
      else assert.deepEqual(f.requests.at(-1)!.body, pending.journal!.receipt);
      assert.deepEqual(f.calls, ["bindings"]);
      assert.equal(f.prepares, 0);
      assert.equal(f.catalogs, 1);
      assert.equal(await f.target.read(), undefined);
    } finally {
      await f.close();
    }
  });

for (const server of ["REQUESTED", "APPLYING"] as const)
  for (const confirmationReceipt of [false, true])
    test(`should keep a cancellation intent without a durable cancellation receipt unresolved for ${server} with ${confirmationReceipt ? "confirmation" : "no"} receipt`, async (t) => {
      const f = await reconnectFixture("plain");
      try {
        const state = (await f.store.read())!;
        state.journal!.phase = "CANCEL_INTENT";
        if (!confirmationReceipt) state.journal!.receipt = null;
        await f.store.write(state);
        if (server === "APPLYING") f.applying();
        else {
          f.response.operation!.state = server;
          f.response.operation!.receipt = null;
        }
        const bytes = await readFile(f.store.file),
          start = f.requests.length;
        let writes = 0;
        const write = f.store.write.bind(f.store);
        t.mock.method(f.store, "write", async (...args: Parameters<typeof write>) => {
          writes++;
          return write(...args);
        });
        await f.reconnect();
        for (let attempt = 0; attempt < 2; attempt++) {
          const status = await f
            .manager({
              folder: async () => assert.fail("cancellation must not choose again"),
              adapter: () => assert.fail("cancellation must not prepare again"),
            })
            .run({ once: true });
          assert.equal(status.state, "CANCEL_INTENT");
          assert.deepEqual(await readFile(f.store.file), bytes);
        }
        assert.equal(writes, 0);
        assert.deepEqual(
          f.requests.slice(start).map((r) => r.action),
          ["poll", "poll"],
        );
        assert.ok(
          f.requests
            .slice(start)
            .every((r) => r.body.operationId === state.journal!.operation.operationId),
        );
        assert.deepEqual(f.calls, ["bindings"]);
        assert.equal(f.prepares, 0);
        assert.equal(f.catalogs, 1);
      } finally {
        await f.close();
      }
    });

test("should replay only a durable cancellation receipt and save closure after server acknowledgement through normal connection handoff", async (t) => {
  const f = await reconnectFixture("plain");
  try {
    const write = f.store.write.bind(f.store),
      call = f.client.call.bind(f.client);
    const stopWrite = t.mock.method(f.store, "write", async (...args: Parameters<typeof write>) => {
      if (args[0].journal?.phase === "UNKNOWN")
        throw new Error("process stopped before failure persistence");
      return write(...args);
    });
    const stopCall = t.mock.method(f.client, "call", async (...args: Parameters<typeof call>) => {
      if (args[0] === "receipt" && args[1].state === "CANCELLED")
        throw new Error("process stopped before cancellation delivery");
      return call(...args);
    });
    f.response.operation!.state = "CANCELLED";
    await assert.rejects(f.manager().run({ once: true }), /process stopped/);
    stopWrite.mock.restore();
    stopCall.mock.restore();
    const pending = (await f.store.read())!;
    assert.equal(pending.journal!.phase, "CANCEL_INTENT");
    assert.equal(pending.journal!.receipt!.state, "CANCELLED");
    f.response.operation!.state = "REQUESTED";
    f.response.operation!.receipt = null;
    const start = f.requests.length,
      events: string[] = [];
    t.mock.method(f.store, "write", async (...args: Parameters<typeof write>) => {
      events.push(`save:${args[0].journal!.phase}`);
      return write(...args);
    });
    f.receiptHook = () => events.push("acknowledgement");
    await f.reconnect();
    const status = await f
      .manager({ adapter: () => assert.fail("receipt replay cannot create a provider") })
      .run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.deepEqual(events, ["acknowledgement", "save:CANCELLED"]);
    assert.deepEqual(
      f.requests.slice(start).map((r) => r.action),
      ["poll", "receipt"],
    );
    assert.deepEqual(f.requests.at(-1)!.body, pending.journal!.receipt);
    assert.equal(f.prepares, 0);
    assert.equal(f.catalogs, 1);
  } finally {
    await f.close();
  }
});

for (const server of ["APPLYING", "CANCELLED", "COMMITTED"] as const)
  test(`should preserve cancellation and committed recovery precedence for ${server} through normal COMMIT_INTENT handoff`, async (t) => {
    const f = await reconnectFixture("plain");
    try {
      f.applying();
      if (server === "COMMITTED") f.failCommittedResponse = true;
      else f.failBeforeCommit = true;
      const write = f.store.write.bind(f.store);
      const stopped = t.mock.method(f.store, "write", async (...args: Parameters<typeof write>) => {
        if (args[0].journal?.phase === "UNKNOWN")
          throw new Error("process stopped before failure persistence");
        return write(...args);
      });
      await assert.rejects(f.manager().run({ once: true }), /process stopped/);
      stopped.mock.restore();
      const pending = (await f.store.read())!;
      assert.equal(pending.journal!.phase, "COMMIT_INTENT");
      assert.ok(pending.journal!.commitBody);
      if (server === "CANCELLED") f.response.operation!.state = server;
      if (server === "COMMITTED") {
        // A cancellation intent must still yield to the server's completed commit.
        pending.journal!.phase = "CANCEL_INTENT";
        await f.store.write(pending);
      }
      const bytes = await readFile(f.store.file),
        start = f.requests.length;
      await f.reconnect();
      assert.deepEqual(await readFile(f.store.file), bytes);
      const status = await f
        .manager({ adapter: () => assert.fail("recovery cannot create a provider") })
        .run({ once: true });
      assert.equal(status.state, server === "CANCELLED" ? "CANCELLED" : "APPLIED");
      assert.deepEqual(
        f.requests.slice(start).map((r) => r.action),
        server === "APPLYING" ? ["poll", "receipt", "receipt"] : ["poll", "receipt"],
      );
      assert.deepEqual(
        f.requests
          .slice(start)
          .filter((r) => r.action === "receipt")
          .map((r) => r.body.state),
        server === "APPLYING"
          ? ["COMMITTED", "APPLIED"]
          : [server === "CANCELLED" ? "CANCELLED" : "APPLIED"],
      );
      if (server === "APPLYING")
        assert.deepEqual(f.requests[start + 1].body, pending.journal!.commitBody);
      assert.equal((await f.store.read())!.current === null, server === "CANCELLED");
      assert.equal(f.prepares, 1);
      assert.equal(f.catalogs, 2);
      assert.deepEqual(f.calls, ["bindings"]);
    } finally {
      await f.close();
    }
  });

test("should recover LOCAL_COMMITTED through normal connection handoff without replaying commit or preparing another context", async (t) => {
  const f = await reconnectFixture("lineage");
  try {
    f.applying();
    const call = f.client.call.bind(f.client);
    const stopped = t.mock.method(f.client, "call", async (...args: Parameters<typeof call>) => {
      if (args[0] === "receipt" && args[1].state === "APPLIED")
        throw new Error("interrupted local commit acknowledgement");
      return call(...args);
    });
    assert.equal((await f.manager().run({ once: true })).state, "LOCAL_COMMITTED");
    stopped.mock.restore();
    const pending = (await f.store.read())!,
      bytes = await readFile(f.store.file),
      start = f.requests.length;
    await f.reconnect();
    assert.deepEqual(await readFile(f.store.file), bytes);
    const status = await f
      .manager({ adapter: () => assert.fail("local commit cannot prepare again") })
      .run({ once: true });
    assert.equal(status.state, "APPLIED");
    assert.deepEqual((await f.store.read())!.current, pending.current);
    assert.deepEqual(
      f.requests.slice(start).map((r) => r.action),
      ["poll", "receipt"],
    );
    assert.deepEqual(f.requests.at(-1)!.body, { ...pending.journal!.receipt, state: "APPLIED" });
    assert.equal(f.prepares, 1);
    assert.equal(f.catalogs, 2);
    assert.equal(await f.target.read(), undefined);
  } finally {
    await f.close();
  }
});

for (const mismatch of [
  "server",
  "device",
  "organization",
  "room",
  "requested-organization",
  "requested-room",
  "absent",
  "disconnected",
  "expired",
  "missing-credential",
  "missing-device",
  "pending",
  "registration",
  "live-lock",
] as const)
  test(`should block unfinished settings reconnect with ${mismatch} before connection or recovery calls`, async () => {
    const f = await reconnectFixture("plain");
    try {
      const owner = (await f.profile.read())!;
      if (mismatch === "server") owner.server = "http://127.0.0.1:4320";
      if (mismatch === "device") owner.deviceId = uuid();
      if (mismatch === "organization") owner.scope!.organizationId = uuid();
      if (mismatch === "room") owner.scope!.roomId = uuid();
      if (mismatch === "requested-organization") f.input.organizationId = uuid();
      if (mismatch === "requested-room") f.input.roomId = uuid();
      if (mismatch === "disconnected") owner.status = "disconnected";
      if (mismatch === "expired") owner.credentialExpiresAt = new Date(0).toISOString();
      if (mismatch === "missing-credential") delete owner.credential;
      if (mismatch === "missing-device") delete owner.deviceId;
      if (mismatch === "pending")
        owner.pending = {
          action: "rotate",
          body: { operationId: uuid(), credentialHash: "b".repeat(64) },
          payloadHash: "c".repeat(64),
          candidateCredential: "b".repeat(64),
        };
      if (mismatch === "registration")
        owner.registration = {
          mapping: { root: f.root, nativeSessionId: uuid() },
          sessionAlias: "Session",
        };
      await f.profile.write(owner);
      if (mismatch === "absent") await f.profile.remove();
      const state = await readFile(f.store.file),
        profile = await f.profile.read(),
        start = f.requests.length;
      if (mismatch === "live-lock")
        await f.store.locked(async () => {
          await assert.rejects(f.reconnect(), { code: "RUNTIME_BUSY" });
        });
      else await assert.rejects(f.reconnect());
      assert.deepEqual(f.calls, []);
      assert.equal(f.requests.length, start);
      assert.deepEqual(await readFile(f.store.file), state);
      assert.deepEqual(await f.profile.read(), profile);
    } finally {
      await f.close();
    }
  });

for (const kind of ["plain", "lineage"] as const)
  test(`should block ${kind} reconnect of a retired owner with completed settings history`, async () => {
    const f = await reconnectFixture(kind);
    try {
      f.response.operation!.state = "CANCELLED";
      assert.equal((await f.manager().run({ once: true })).state, "CANCELLED");
      await f.profile.remove();
      const before = await readFile(f.store.file);
      await assert.rejects(f.reconnect(), { code: "CONTEXT_UNCONFIRMED" });
      assert.deepEqual(f.calls, []);
      assert.deepEqual(await readFile(f.store.file), before);
    } finally {
      await f.close();
    }
  });

test("should refuse fresh recovery mode at the normal reconnect preparation boundary", async () => {
  const f = await reconnectFixture("lineage");
  try {
    await f.target.write((await f.profile.read())!);
    const selection = await selectConnectionProfile(f.target, f.input, f.scope.server);
    assert.equal(selection.mode, "recovery");
    const before = await readFile(f.store.file);
    await assert.rejects(
      prepareSelectedConnection(
        selection,
        () => {},
        async () => assert.fail("fresh recovery must retain its own guards"),
      ),
      { code: "INVALID_BODY" },
    );
    assert.deepEqual(f.calls, []);
    assert.deepEqual(await readFile(f.store.file), before);
  } finally {
    await f.close();
  }
});

test("should retain standalone and legacy idle checks with a matching unfinished settings owner", async () => {
  const f = await reconnectFixture("plain");
  try {
    const before = await readFile(f.store.file);
    for (const command of [
      "pair",
      "exchange",
      "connect",
      "status",
      "rotate",
      "heartbeat",
      "register",
      "replace",
      "runtime-capabilities",
      "runtime-prepare",
      "runtime-run",
      "runtime-observe",
      "revoke-local",
    ])
      await assert.rejects(
        withSettingsDeviceLock(f.profile, command, async () =>
          assert.fail("legacy command must remain blocked"),
        ),
        { code: "RUNTIME_BUSY" },
      );
    assert.deepEqual(await readFile(f.store.file), before);
  } finally {
    await f.close();
  }
});

test("should commit the first context only after durable candidate and server receipt", async () => {
  const f = await fixture();
  try {
    await local(f);
    assert.equal((await f.store.read())!.journal!.settings, null);
    const status = await f.manager().run({ once: true });
    assert.equal(status.state, "APPLIED", JSON.stringify(status));
    assert.equal(status.ready, false);
    assert.equal(f.prepares, 1);
    const state = (await f.store.read())!,
      j = state.journal!;
    assert.equal(j.applyHash, digest(stableJson(j.applyBody)));
    assert.equal(j.operation.requested.model, undefined);
    const record = await f.store
      .generationStore(state.current!.agentId, state.current!.generation)
      .read();
    assert.equal(record!.version, 2);
    assert.equal(record!.ready, false);
    assert.deepEqual(record!.context, j.context);
    assert.equal((await f.profile.read())!.mappings[0].generation, j.generation);
    assert.equal(JSON.stringify(status).includes(f.root), false);
    for (const request of f.requests) {
      assert.equal(JSON.stringify(request.body).includes(f.root), false);
      assert.equal(JSON.stringify(request.body).includes(j.context!.threadId), false);
    }
  } finally {
    await f.close();
  }
});

test("should preserve nullable Claude effort and separate durable catalog and prepare reservations", async () => {
  const f = await fixture("claude");
  try {
    await local(f);
    const catalogId = (await f.store.read())!.journal!.catalogContext!.threadId;
    const status = await f.manager().run({ once: true });
    assert.equal(status.state, "APPLIED");
    const j = (await f.store.read())!.journal!;
    assert.equal(j.settings!.requested.effort, null);
    assert.notEqual(j.context!.threadId, catalogId);
    assert.equal(j.context!.materialization!.state, "RESERVED");
    assert.equal((await f.profile.read())!.mappings[0].materialization, "RESERVED");
    assert.equal(status.ready, false);
  } finally {
    await f.close();
  }
});

test("should preserve legacy bytes when the selected root and provider change", async () => {
  const f = await fixture("claude");
  try {
    await f.store.read();
    await f.store.write({
      version: 1,
      server: f.scope.server,
      deviceId: f.scope.deviceId,
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
      current: null,
      retained: [],
      journal: null,
    });
    // Bootstrap must occur on the first settings write, so use a fresh settings directory.
    const alternate = new StateStore(f.stateDir, "two");
    const settings = new SettingsStore(alternate);
    const previous = new (await import("../src/runtime-store.ts")).RuntimeStore(
      f.stateDir,
      "two",
      f.scope.agentId,
    );
    await previous.write(f.record);
    const bytes = await readFile(previous.file),
      workspaceId = uuid();
    await alternate.write({
      ...(await f.profile.read())!,
      mappings: [
        {
          root: f.root,
          nativeSessionId: f.context.threadId,
          agentId: f.scope.agentId,
          workspaceId,
          bindingEpoch: 1,
        },
      ],
    });
    f.response = {
      ...f.response,
      currentBinding: { agentId: f.scope.agentId, workspaceId, bindingEpoch: 1, runtime: "codex" },
    };
    const newRoot = join(f.directory, "new-project");
    await mkdir(newRoot);
    await writeFile(join(newRoot, "public.txt"), "New public evidence.");
    const policy = await RuntimeFilePolicy.select(newRoot, ["public.txt"]);
    const adapter: SettingsManagerOptions["adapter"] = (runtime, reserve) => {
      const original = f.options.adapter!(runtime, async (path, version, fingerprint) =>
        reserve(path, version, fingerprint),
      );
      return {
        ...original,
        capabilities: async () => claudeRecord(f.record).settings!.capabilities,
        prepare: async (root, settings, generation, epoch, check, onCreated) => {
          check();
          const context = {
            ...claudeRecord(f.record).context!,
            root,
            generation,
            epoch,
            threadId: uuid(),
          };
          await onCreated!(context);
          return context;
        },
      };
    };
    const options = {
      ...f.options,
      adapter,
      folder: async () => ({ status: "SELECTED" as const, root: policy.root }),
      confirm: async () => ({
        confirmed: true as const,
        repositoryAlias: "Repository",
        files: [...policy.files],
        handoff: "New public evidence.",
      }),
    };
    assert.equal(
      (await new SettingsManager(alternate, settings, f.client, options).run({ once: true })).state,
      "LOCAL_CONFIRMATION",
    );
    f.applying();
    assert.equal(
      (await new SettingsManager(alternate, settings, f.client, options).run({ once: true })).state,
      "APPLIED",
    );
    assert.deepEqual(await readFile(previous.file), bytes);
    assert.equal((await settings.read())!.retained[0].legacy, true);
    assert.equal((await alternate.read())!.mappings[0].root, newRoot);
  } finally {
    await f.close();
  }
});

test("should reject a second manager before any outbound poll", async () => {
  const f = await fixture();
  try {
    await f.store.locked(async () => {
      await assert.rejects(
        f.manager().run({ once: true }),
        (e: unknown) => e instanceof RuntimeError && e.code === "RUNTIME_BUSY",
      );
      assert.equal(f.requests.length, 0);
    });
  } finally {
    await f.close();
  }
});

test("should recover an exact committed receipt after 121 seconds and credential rotation", async (t) => {
  const f = await fixture();
  try {
    await local(f);
    f.failCommittedResponse = true;
    const lost = await f.manager().run({ once: true });
    assert.equal(lost.state, "UNKNOWN");
    assert.equal(f.prepares, 1);
    const journal = (await f.store.read())!.journal!;
    const before = f.requests.find(
      (r) => r.action === "receipt" && r.body.state === "COMMITTED",
    )!.body;
    const originalNow = Date.now();
    t.mock.method(Date, "now", () => originalNow + 121001);
    // Fake HTTP retains the exact settings receipt beyond the legacy replace window.
    f.response = structuredClone(f.response);
    const p = (await f.profile.read())!;
    await f.profile.write({
      ...p,
      credential: "b".repeat(64),
      credentialExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    const restored = await f
      .manager({
        adapter: () => {
          throw new Error("recovery cannot create another provider");
        },
      })
      .run({ once: true });
    assert.equal(restored.state, "APPLIED");
    assert.equal(f.prepares, 1);
    assert.equal((await f.store.read())!.journal!.context!.threadId, journal.context!.threadId);
    assert.deepEqual(
      f.requests.find((r) => r.action === "receipt" && r.body.state === "COMMITTED")!.body,
      before,
    );
    assert.equal(f.requests.at(-1)!.secret, `Bearer ${"b".repeat(64)}`);
  } finally {
    await f.close();
  }
});

for (const stale of ["current", "epoch", "revision"] as const)
  test(`should refuse committed adoption when ${stale} is stale`, async () => {
    const f = await fixture();
    try {
      await local(f);
      f.failCommittedResponse = true;
      await f.manager().run({ once: true });
      if (stale === "current") f.response = { ...f.response, current: false };
      if (stale === "epoch")
        f.response = {
          ...f.response,
          currentBinding: { ...f.response.currentBinding!, bindingEpoch: 2 },
        };
      if (stale === "revision") f.response = { ...f.response, configRevision: 2 };
      const status = await f.manager().run({ once: true });
      assert.equal(status.state, "UNKNOWN");
      assert.equal(status.ready, false);
      assert.equal(f.prepares, 1);
      assert.equal((await f.store.read())!.current, null);
      assert.equal((await f.profile.read())!.mappings.length, 0);
    } finally {
      await f.close();
    }
  });

for (const phase of ["CHOOSING", "CATALOG_INTENT", "PREPARE_INTENT", "UNKNOWN"] as const)
  test(`should never repeat chooser or preparation after a ${phase} crash`, async () => {
    const f = await fixture();
    try {
      await local(f);
      const original = (await f.store.read())!;
      // A fresh owned store models a crash snapshot without rewinding the real durable journal.
      const p = new StateStore(f.stateDir, "crash");
      await p.write((await f.profile.read())!);
      const store = new SettingsStore(p);
      const state = structuredClone(original);
      state.journal!.phase = phase;
      state.journal!.receipt = null;
      await store.write(state);
      f.response.operation!.state = "REQUESTED";
      const options: SettingsManagerOptions = {
        folder: async () => {
          throw new Error("reopened chooser");
        },
        adapter: () => {
          throw new Error("new provider context");
        },
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const status = await new SettingsManager(p, store, f.client, options).run({ once: true });
        assert.equal(status.state, "UNKNOWN");
      }
      assert.equal(f.prepares, 0);
      assert.equal((await store.read())!.journal!.generation, original.journal!.generation);
    } finally {
      await f.close();
    }
  });

test("should refuse capability drift before preparing a new context", async () => {
  const f = await fixture();
  try {
    await local(f);
    f.observedCaps = {
      ...f.settings.capabilities,
      models: f.settings.capabilities.models.slice(1),
      defaultSettings: { model: "test-b", effort: "medium" },
    };
    const status = await f.manager().run({ once: true });
    assert.equal(status.state, "FAILED");
    assert.equal(status.reason, "SNAPSHOT_CHANGED");
    assert.equal(f.prepares, 0);
  } finally {
    await f.close();
  }
});

for (const configured of [false, true])
  test(`should acknowledge an unreceived cancelled folder request with ${configured ? "an existing" : "no"} AI configuration`, async () => {
    const f = await fixture();
    try {
      if (configured) {
        await local(f);
        await f.manager().run({ once: true });
      }
      const before = await f.store.read();
      const operationId = uuid();
      f.response.operation = {
        operationId,
        deviceId: f.response.deviceId,
        expectedConfigRevision: f.response.configRevision,
        state: "CANCELLED",
        requested: {
          operationId,
          deviceId: f.response.deviceId,
          expectedConfigRevision: f.response.configRevision,
          runtime: "codex",
        },
        receipt: null,
      };
      const start = f.requests.length;
      const status = await f
        .manager({
          folder: async () => assert.fail("cancelled request must not open a picker"),
          adapter: () => assert.fail("cancelled request must not start AI"),
          runner: () => ({ run: async () => ({ ready: true }) }),
        })
        .run({ once: true });
      assert.equal(status.state, "CANCELLED");
      const receipts = f.requests.slice(start).filter((r) => r.action === "receipt");
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].body.state, "CANCELLED");
      assert.equal(receipts[0].body.operationId, operationId);
      assert.equal(receipts[0].body.localRootReference, null);
      assert.equal(receipts[0].body.repositoryAlias, null);
      assert.deepEqual((await f.store.read())!.current, before?.current ?? null);
      assert.deepEqual((await f.store.read())!.retained, before?.retained ?? []);
      await f.store.assertIdle();
    } finally {
      await f.close();
    }
  });

test("should acknowledge an unreceived cancellation while preserving the initial legacy binding", async () => {
  const f = await fixture();
  try {
    const previous = new (await import("../src/runtime-store.ts")).RuntimeStore(
      f.stateDir,
      "one",
      f.scope.agentId,
    );
    await previous.write(f.record);
    const bytes = await readFile(previous.file);
    const workspaceId = uuid();
    await f.profile.write({
      ...(await f.profile.read())!,
      mappings: [
        {
          root: f.root,
          nativeSessionId: f.context.threadId,
          agentId: f.scope.agentId,
          workspaceId,
          bindingEpoch: f.scope.bindingEpoch,
        },
      ],
    });
    const profileBytes = await readFile(f.profile.file);
    f.response.currentBinding = {
      agentId: f.scope.agentId,
      workspaceId,
      bindingEpoch: f.scope.bindingEpoch,
      runtime: "codex",
    };
    f.response.operation!.state = "CANCELLED";
    const status = await f
      .manager({
        folder: async () => assert.fail("cancelled legacy request must not open a picker"),
        adapter: () => assert.fail("cancelled legacy request must not start AI"),
        runner: () => ({ run: async () => ({ ready: true }) }),
      })
      .run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.equal((await f.store.read())!.current!.legacy, true);
    assert.equal((await f.store.read())!.current!.workspaceId, workspaceId);
    assert.deepEqual(await readFile(previous.file), bytes);
    assert.deepEqual(await readFile(f.profile.file), profileBytes);
    assert.equal(f.requests.filter((r) => r.action === "receipt").length, 1);
  } finally {
    await f.close();
  }
});

test("should replay an unreceived cancellation after a lost acknowledgement without opening a picker", async () => {
  const f = await fixture();
  try {
    f.response.operation!.state = "CANCELLED";
    let lost = false;
    f.receiptHook = (value) => {
      if (value.state === "CANCELLED" && !lost) {
        lost = true;
        throw new Error("lost cancellation acknowledgement");
      }
    };
    const manager = () =>
      f.manager({
        folder: async () => assert.fail("cancelled request must not open a picker"),
        adapter: () => assert.fail("cancelled request must not start AI"),
      });
    assert.equal((await manager().run({ once: true })).state, "UNKNOWN");
    const pending = (await f.store.read())!;
    assert.equal(pending.journal!.receipt!.state, "CANCELLED");
    assert.equal((await manager().run({ once: true })).state, "CANCELLED");
    const receipts = f.requests.filter((r) => r.action === "receipt");
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[0].body, receipts[1].body);
    assert.equal((await f.store.read())!.journal!.generation, pending.journal!.generation);
  } finally {
    await f.close();
  }
});

for (const mismatch of ["receipt", "selected-model", "revision", "binding"] as const)
  test(`should refuse unreceived cancellation with ${mismatch} evidence`, async () => {
    const f = await fixture();
    try {
      if (mismatch === "receipt" || mismatch === "selected-model") {
        await local(f);
        if (mismatch === "selected-model") f.response.operation!.receipt = null;
      }
      const profile = new StateStore(f.stateDir, "unreceived");
      await profile.write((await f.profile.read())!);
      const store = new SettingsStore(profile);
      f.response.operation!.state = "CANCELLED";
      if (mismatch === "revision") f.response.configRevision++;
      if (mismatch === "binding") f.response.current = false;
      const start = f.requests.length;
      await new SettingsManager(profile, store, f.client, {
        folder: async () => assert.fail("no picker before identity verification"),
        adapter: () => assert.fail("no AI before identity verification"),
      }).run({ once: true });
      assert.equal(await store.read(), undefined);
      assert.equal(f.requests.slice(start).filter((r) => r.action === "receipt").length, 0);
    } finally {
      await f.close();
    }
  });

test("should send exact cleanup receipt when the native folder chooser is cancelled", async () => {
  const f = await fixture();
  try {
    const status = await f
      .manager({ folder: async () => ({ status: "CANCELLED" }) })
      .run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.deepEqual(
      f.requests.filter((r) => r.action === "receipt").map((r) => r.body.state),
      ["FAILED", "CANCELLED"],
    );
    assert.equal(f.prepares, 0);
    await f.store.assertIdle();
  } finally {
    await f.close();
  }
});

test("should poll human cancellation and await dialog cleanup before releasing the slot", async () => {
  const f = await fixture();
  try {
    let finished = false;
    f.pollHook = () => {
      if (f.requests.filter((r) => r.action === "poll").length > 1)
        f.response.operation!.state = "CANCELLED";
    };
    const status = await f
      .manager({
        folder: (signal) =>
          new Promise((resolve) =>
            signal.addEventListener(
              "abort",
              () =>
                setTimeout(() => {
                  finished = true;
                  resolve({ status: "CANCELLED" });
                }, 5),
              { once: true },
            ),
          ),
      })
      .run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.equal(finished, true);
    assert.equal(f.requests.filter((r) => r.action === "receipt").at(-1)!.body.state, "CANCELLED");
    await f.store.assertIdle();
  } finally {
    await f.close();
  }
});

test("should retain ownership when provider cleanup cannot be proved", async () => {
  const f = await fixture();
  try {
    const adapter = f.options.adapter!("codex", async () => {
      throw new Error();
    });
    adapter.close = async () => {
      throw new Error("private provider cleanup error");
    };
    await assert.rejects(
      f.manager({ adapter: () => adapter }).run({ once: true }),
      (e: unknown) => e instanceof RuntimeError && e.code === "CLEANUP_INCOMPLETE",
    );
    assert.equal((await f.store.read())!.journal!.phase, "UNKNOWN");
    await assert.rejects(
      f.manager().run({ once: true }),
      (e: unknown) => e instanceof RuntimeError && e.code === "RUNTIME_BUSY",
    );
    assert.equal(
      f.requests.some((r) => r.body.state === "CANCELLED"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("should refuse expired credential before any HTTP or provider admission", async () => {
  const f = await fixture();
  try {
    await f.profile.write({
      ...(await f.profile.read())!,
      credentialExpiresAt: new Date(Date.now() - 1).toISOString(),
    });
    await assert.rejects(f.manager().run({ once: true }));
    assert.equal(f.requests.length, 0);
    assert.equal(f.catalogs, 0);
  } finally {
    await f.close();
  }
});

test("should replay only the durable COMMIT_INTENT body without preparing again", async () => {
  const f = await fixture();
  try {
    await local(f);
    f.failBeforeCommit = true;
    assert.equal((await f.manager().run({ once: true })).state, "UNKNOWN");
    const pending = (await f.store.read())!.journal!;
    assert.ok(pending.commitBody);
    const status = await f
      .manager({
        adapter: () => {
          throw new Error("recovery preparation");
        },
      })
      .run({ once: true });
    assert.equal(status.state, "APPLIED");
    assert.equal(f.prepares, 1);
    const commits = f.requests.filter(
      (r) => r.action === "receipt" && r.body.state === "COMMITTED",
    );
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[0].body, commits[1].body);
    assert.deepEqual(commits[0].body, pending.commitBody);
  } finally {
    await f.close();
  }
});

test("should close an active catalog child before acknowledging human cancellation", async () => {
  const f = await fixture();
  try {
    let catalogStarted = false,
      cleaned = false;
    let complete!: (capabilities: Capabilities) => void;
    const original = f.options.adapter!("codex", async () => {
      throw new Error();
    });
    original.capabilities = async () => {
      catalogStarted = true;
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    original.close = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleaned = true;
      complete(f.settings.capabilities);
    };
    f.pollHook = () => {
      if (catalogStarted) f.response.operation!.state = "CANCELLED";
    };
    f.receiptHook = (receipt) => {
      if (receipt.state === "CANCELLED") assert.equal(cleaned, true);
    };
    const status = await f.manager({ adapter: () => original }).run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.equal(cleaned, true);
    assert.equal(f.prepares, 0);
  } finally {
    await f.close();
  }
});

test("should bind APPLYING cleanup to the selected model even before preparation starts", async () => {
  const f = await fixture();
  try {
    await local(f);
    let started = false;
    let complete!: (capabilities: Capabilities) => void;
    const adapter = f.options.adapter!("codex", async () => {
      throw new Error();
    });
    adapter.capabilities = async () => {
      started = true;
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    adapter.close = async () => {
      complete(f.settings.capabilities);
    };
    const apply = structuredClone(f.response.operation!.requested);
    f.pollHook = () => {
      if (started) f.response.operation!.state = "CANCELLED";
    };
    const status = await f.manager({ adapter: () => adapter }).run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.equal(f.prepares, 0);
    const cleanup = f.requests.filter((r) => r.body.state === "CANCELLED").at(-1)!.body;
    for (const key of [
      "runtime",
      "model",
      "effort",
      "snapshotHash",
      "localRootReference",
      "repositoryAlias",
      "sessionAlias",
    ])
      assert.equal(cleanup[key], apply[key]);
  } finally {
    await f.close();
  }
});

test("should cancel local scope confirmation without publishing an unconfirmed alias or root reference", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.manager({ confirm: async () => ({ confirmed: false }) }).run({ once: true })).state,
      "CANCELLED",
    );
    const cleanup = f.requests.filter((r) => r.body.state === "CANCELLED")[0].body;
    assert.equal(cleanup.localRootReference, null);
    assert.equal(cleanup.repositoryAlias, null);
    assert.equal(cleanup.model, null);
    assert.ok((await f.store.read())!.journal!.root);
  } finally {
    await f.close();
  }
});

test("should retain UNKNOWN when a crashed catalog has no exact cleanup proof", async () => {
  const f = await fixture();
  try {
    await local(f);
    const crash = new StateStore(f.stateDir, "crash");
    await crash.write((await f.profile.read())!);
    const store = new SettingsStore(crash),
      state = (await f.store.read())!;
    state.journal!.phase = "CATALOG_INTENT";
    state.journal!.receipt!.catalog = null;
    await store.write(state);
    f.response.operation!.state = "CANCELLED";
    const count = f.requests.filter((r) => r.body.state === "CANCELLED").length;
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal(
        (
          await new SettingsManager(crash, store, f.client, {
            adapter: () => {
              throw new Error("new provider");
            },
          }).run({ once: true })
        ).state,
        "UNKNOWN",
      );
    assert.equal(f.requests.filter((r) => r.body.state === "CANCELLED").length, count);
    await assert.rejects(store.assertIdle());
  } finally {
    await f.close();
  }
});

test("should keep default Claude admission closed without a verified policy", async (t) => {
  const f = await fixture("claude");
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
    const status = await f.manager({ adapter: undefined }).run({ once: true });
    assert.equal(status.state, "FAILED");
    assert.equal(status.reason, "POLICY_UNCONFIRMED");
    const journal = (await f.store.read())!.journal!;
    assert.equal(journal.catalogContext, undefined);
    assert.equal(journal.context, null);
    assert.equal(f.prepares, 0);
    assert.equal(f.adapters.length, 0);
    assert.equal(admission.mock.callCount(), 1);
    await assert.rejects(lstat(new ClaudeCatalogStore(f.profile).file), { code: "ENOENT" });
  } finally {
    await f.close();
  }
});

test("should keep settings polling serial while one runner waits for a native result", async () => {
  const f = await fixture();
  try {
    await local(f);
    await f.manager().run({ once: true });
    let runnerStarted = false,
      runnerCalls = 0,
      activePolls = 0,
      maxPolls = 0,
      pollsWhileWaiting = 0;
    let complete!: (result: { ready: boolean }) => void;
    f.pollHook = async () => {
      activePolls++;
      maxPolls = Math.max(maxPolls, activePolls);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (runnerStarted && ++pollsWhileWaiting === 3) complete({ ready: true });
      activePolls--;
    };
    const status = await f
      .manager({
        runner: () => ({
          run: async () => {
            runnerCalls++;
            runnerStarted = true;
            return new Promise((resolve) => {
              complete = resolve;
            });
          },
        }),
      })
      .run({ once: true });
    assert.equal(status.state, "APPLIED");
    assert.equal(status.ready, true);
    assert.equal(runnerCalls, 1);
    assert.equal(maxPolls, 1);
    assert.ok(pollsWhileWaiting >= 3);
  } finally {
    await f.close();
  }
});

test(
  "should wait for an unresolved run and close the idle runner before preparing",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture();
    const abort = new AbortController();
    let tearingDown = false;
    let releaseRunner: (() => void) | undefined;
    let runnerJob: Promise<{ ready: boolean }> | undefined;
    let managerRun: ReturnType<SettingsManager["run"]> | undefined;
    let io: Promise<unknown> = Promise.resolve();
    const stop = () => {
      tearingDown = true;
      abort.abort();
      releaseRunner?.();
    };
    const deadline = setTimeout(stop, 5000);
    t.signal.addEventListener("abort", stop, { once: true });
    try {
      await local(f);
      await f.manager().run({ once: true });
      const originalPointer = (await f.store.read())!.current!;
      const oldStore = f.store.generationStore(originalPointer.agentId, originalPointer.generation);
      // Serialize only this fixture's generation reads and completion write.
      const serial = <T>(run: () => Promise<T>): Promise<T> => {
        const result = io.then(run);
        io = result.catch(() => {});
        return result;
      };
      const read = oldStore.read.bind(oldStore);
      const write = oldStore.write.bind(oldStore);
      const generationStore = f.store.generationStore.bind(f.store);
      t.mock.method(oldStore, "read", () => serial(read));
      t.mock.method(oldStore, "write", (...args: Parameters<typeof write>) =>
        serial(() => write(...args)),
      );
      t.mock.method(f.store, "generationStore", (agentId: string, generation: string) =>
        agentId === originalPointer.agentId && generation === originalPointer.generation
          ? oldStore
          : generationStore(agentId, generation),
      );
      const active = (await oldStore.read())!;
      const operationId = uuid();
      const body = {
        protocol: 1,
        operationId,
        agentId: originalPointer.agentId,
        bindingEpoch: originalPointer.bindingEpoch,
        reportedReady: false,
      };
      active.operations.push({
        operationId,
        action: "ready",
        body,
        payloadHash: digest(stableJson({ action: "ready", body })),
        state: "PENDING",
        result: null,
      });
      await oldStore.write(active);
      let bytes = await readFile(oldStore.file);
      let runnerStarted = false,
        finished = false,
        cleaned = false,
        replacementRequested = false,
        waiterPolls = 0,
        runnerCalls = 0;
      f.pollHook = async () => {
        if (runnerStarted && !replacementRequested) {
          replacementRequested = true;
          const operationId = uuid();
          f.response = {
            ...f.response,
            operation: {
              operationId,
              deviceId: f.response.deviceId,
              expectedConfigRevision: 1,
              state: "REQUESTED",
              requested: {
                operationId,
                deviceId: f.response.deviceId,
                expectedConfigRevision: 1,
                runtime: "codex",
              },
              receipt: null,
            },
          };
        } else if (f.response.operation!.state === "APPLYING" && !finished && ++waiterPolls === 3) {
          const completed = (await oldStore.read())!;
          completed.operations[0].state = "CONFIRMED";
          completed.operations[0].result = {
            agentId: originalPointer.agentId,
            bindingEpoch: originalPointer.bindingEpoch,
            reportedReady: false,
            validUntil: null,
            verification: "reported",
          };
          finished = true;
          await oldStore.write(completed);
          bytes = await readFile(oldStore.file);
        }
      };
      f.receiptHook = (receipt) => {
        if (receipt.state === "LOCAL_CONFIRMATION") f.applying();
        if (receipt.state === "APPLIED" && receipt.configRevision === 2) abort.abort();
      };
      managerRun = f
        .manager({
          adapter: (provider, reserve) => {
            const adapter = f.options.adapter!(provider, reserve);
            const prepare = adapter.prepare;
            adapter.prepare = async (...args) => {
              assert.equal(finished, true);
              assert.equal(cleaned, true);
              return prepare(...args);
            };
            return adapter;
          },
          runner: () => ({
            run: async (options) => {
              assert.equal(options.once, false);
              runnerStarted = true;
              runnerCalls++;
              runnerJob = new Promise((resolve) => {
                let closing = false;
                releaseRunner = () => {
                  if (closing) return;
                  closing = true;
                  setTimeout(() => {
                    cleaned = true;
                    resolve({ ready: false });
                  }, 5);
                };
                options.signal.addEventListener(
                  "abort",
                  () => {
                    if (!tearingDown) assert.equal(finished, true);
                    releaseRunner!();
                  },
                  { once: true },
                );
              });
              return runnerJob;
            },
          }),
        })
        .run({ signal: abort.signal });
      const status = await managerRun;
      assert.equal(status.state, "APPLIED");
      assert.equal(status.configRevision, 2);
      assert.equal(cleaned, true);
      assert.ok(waiterPolls >= 3);
      assert.equal(runnerCalls, 1);
      assert.deepEqual(await readFile(oldStore.file), bytes);
      assert.notEqual((await f.store.read())!.current!.generation, originalPointer.generation);
    } finally {
      clearTimeout(deadline);
      stop();
      await runnerJob;
      await managerRun?.catch(() => {});
      await io;
      t.signal.removeEventListener("abort", stop);
      await f.close();
    }
  },
);

test("should spawn no catalog child when its UUID reservation cannot be synced", async () => {
  const f = await fixture("claude");
  try {
    const { readdir } = await import("node:fs/promises");
    const store = new SettingsStore(f.profile, {
      beforeSync: async (stage) => {
        if (stage !== "file") return;
        for (const name of await readdir(f.store.dir))
          if (name.startsWith(".settings-") && name.endsWith(".tmp")) {
            const candidate = JSON.parse(await readFile(join(f.store.dir, name), "utf8"));
            if (candidate.journal?.catalogContext) throw new RuntimeError("UNSAFE_STORAGE");
          }
      },
    });
    let spawns = 0;
    const options: SettingsManagerOptions = {
      ...f.options,
      adapter: (_provider, reserve) => ({
        ...f.options.adapter!("claude", reserve),
        capabilities: async (root) => {
          await reserve(root, "2.1.287", digest("verified-policy-fixture"));
          spawns++;
          return claudeRecord(f.record).settings!.capabilities;
        },
      }),
    };
    const status = await new SettingsManager(f.profile, store, f.client, options).run({
      once: true,
    });
    assert.equal(status.state, "UNKNOWN");
    assert.equal(spawns, 0);
    assert.equal((await store.read())!.journal!.catalogContext, undefined);
    await new SettingsManager(f.profile, store, f.client, options).run({ once: true });
    assert.equal(spawns, 0);
  } finally {
    await f.close();
  }
});

test("should never prepare again after the owned context callback fails to sync", async () => {
  const f = await fixture();
  try {
    await local(f);
    const { readdir } = await import("node:fs/promises");
    const store = new SettingsStore(f.profile, {
      beforeSync: async (stage) => {
        if (stage !== "file") return;
        for (const name of await readdir(f.store.dir))
          if (name.startsWith(".settings-") && name.endsWith(".tmp")) {
            const candidate = JSON.parse(await readFile(join(f.store.dir, name), "utf8"));
            if (candidate.journal?.context) throw new RuntimeError("UNSAFE_STORAGE");
          }
      },
    });
    assert.equal(
      (await new SettingsManager(f.profile, store, f.client, f.options).run({ once: true })).state,
      "UNKNOWN",
    );
    assert.equal(f.prepares, 1);
    assert.equal((await store.read())!.journal!.context, null);
    const options = {
      ...f.options,
      adapter: () => {
        throw new Error("new prepare after uncertain callback");
      },
    };
    for (let attempt = 0; attempt < 2; attempt++)
      assert.equal(
        (await new SettingsManager(f.profile, store, f.client, options).run({ once: true })).state,
        "UNKNOWN",
      );
    assert.equal(f.prepares, 1);
  } finally {
    await f.close();
  }
});

test("should acknowledge server cancellation of an uncommitted durable candidate without retrying commit", async () => {
  const f = await fixture();
  try {
    await local(f);
    f.failBeforeCommit = true;
    await f.manager().run({ once: true });
    const pending = (await f.store.read())!.journal!;
    assert.ok(pending.commitBody);
    assert.equal(f.prepares, 1);
    f.response.operation!.state = "CANCELLED";
    const status = await f
      .manager({
        adapter: () => {
          throw new Error("new cleanup provider");
        },
      })
      .run({ once: true });
    assert.equal(status.state, "CANCELLED");
    assert.equal((await f.store.read())!.current, null);
    assert.equal(f.prepares, 1);
    assert.equal(f.requests.filter((r) => r.body.state === "COMMITTED").length, 1);
    await f.store.assertIdle();
  } finally {
    await f.close();
  }
});

test("should keep an initial Claude reservation unready even if a runner reports ready", async () => {
  const f = await fixture("claude");
  try {
    await local(f);
    await f.manager().run({ once: true });
    const status = await f
      .manager({ runner: () => ({ run: async () => ({ ready: true }) }) })
      .run({ once: true });
    assert.equal(status.state, "APPLIED");
    assert.equal(status.ready, false);
    assert.equal((await f.profile.read())!.mappings[0].materialization, "RESERVED");
  } finally {
    await f.close();
  }
});

test("should retain one persistent runner across repeated idle settings polls", async () => {
  const f = await fixture();
  try {
    await local(f);
    await f.manager().run({ once: true });
    const abort = new AbortController();
    let polls = 0,
      runnerCalls = 0,
      cleaned = false;
    f.pollHook = () => {
      if (++polls === 8) abort.abort();
    };
    await f
      .manager({
        runner: () => ({
          run: async (options) => {
            assert.equal(options.once, false);
            runnerCalls++;
            return new Promise((resolve) =>
              options.signal.addEventListener(
                "abort",
                () =>
                  setTimeout(() => {
                    cleaned = true;
                    resolve({ ready: false });
                  }, 5),
                { once: true },
              ),
            );
          },
        }),
      })
      .run({ signal: abort.signal });
    assert.equal(polls, 8);
    assert.equal(runnerCalls, 1);
    assert.equal(cleaned, true);
  } finally {
    await f.close();
  }
});

for (const terminal of ["APPLIED", "CANCELLED"] as const) {
  test(`should recover the exact ${terminal} receipt hidden from an unscoped poll`, async () => {
    const f = await fixture();
    try {
      const originalWrite = f.store.write.bind(f.store);
      let fail = true;
      f.store.write = async (state, check) => {
        if (fail && state.journal?.phase === terminal) {
          fail = false;
          throw new RuntimeError("UNSAFE_STORAGE");
        }
        return originalWrite(state, check);
      };
      if (terminal === "APPLIED") await local(f);
      await f
        .manager(
          terminal === "CANCELLED"
            ? {
                folder: async () => ({ status: "CANCELLED" }),
              }
            : {},
        )
        .run({ once: true });
      assert.notEqual((await f.store.read())!.journal!.phase, terminal);
      assert.equal(f.response.operation!.state, terminal);
      const creates = { prepares: f.prepares, catalogs: f.catalogs };
      const status = await f
        .manager({
          adapter: () => {
            throw new Error("terminal recovery must not create a provider");
          },
          folder: async () => {
            throw new Error("terminal recovery must not choose again");
          },
        })
        .run({ once: true });
      assert.equal(status.state, terminal, JSON.stringify(status));
      assert.deepEqual({ prepares: f.prepares, catalogs: f.catalogs }, creates);
      assert.equal(
        f.requests.filter((r) => r.action === "poll").at(-1)!.body.operationId,
        f.response.operation!.operationId,
      );
    } finally {
      await f.close();
    }
  });
}

test("should sync a recovered current pointer before sending APPLIED after directory sync failure", async () => {
  const f = await fixture();
  try {
    await local(f);
    let failed = false,
      recoveredPointerSynced = false;
    const store = new SettingsStore(f.profile, {
      beforeSync: async (stage) => {
        if (stage !== "directory") return;
        const state = await f.store.read();
        if (state?.journal?.phase !== "LOCAL_COMMITTED") return;
        if (!failed) {
          failed = true;
          throw new RuntimeError("UNSAFE_STORAGE");
        }
        recoveredPointerSynced = true;
      },
    });
    const abort = new AbortController();
    f.receiptHook = (body) => {
      if (body.state === "APPLIED") {
        assert.equal(recoveredPointerSynced, true);
        abort.abort();
      }
    };
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      assert.equal(
        (
          await new SettingsManager(f.profile, store, f.client, f.options).run({
            signal: abort.signal,
          })
        ).state,
        "APPLIED",
      );
    } finally {
      clearTimeout(timeout);
    }
    assert.equal(f.prepares, 1);
    assert.equal(recoveredPointerSynced, true);
  } finally {
    await f.close();
  }
});

test("should durably bind explicit automatic consent before catalog and echo it through apply", async () => {
  const f = await fixture("claude");
  try {
    const original = f.options.adapter!;
    const adapter: NonNullable<SettingsManagerOptions["adapter"]> = (provider, reserve) => {
      const created = original(provider, reserve);
      const capabilities = created.capabilities.bind(created);
      created.capabilities = async (root, check) => {
        const journal = (await f.store.read())!.journal!;
        assert.equal(journal.repositoryAccess!.generation, journal.generation);
        assert.equal(
          journal.repositoryAccess!.confirmationOperationId,
          journal.operation.operationId,
        );
        assert.equal(journal.repositoryAccess!.localRootReference, journal.localRootReference);
        assert.equal(journal.receipt!.readMode, "AUTO_CODE");
        assert.deepEqual(journal.files, []);
        return capabilities(root, check);
      };
      return created;
    };
    const manager = () =>
      f.manager({
        adapter,
        confirm: async () => ({
          confirmed: true,
          repositoryAlias: "Repository",
          files: [],
          handoff: "Shared evidence.",
          readMode: "AUTO_CODE",
        }),
      });
    assert.equal((await manager().run({ once: true })).state, "LOCAL_CONFIRMATION");
    f.applying();
    f.response.operation!.requested.readMode = "AUTO_CODE";
    assert.equal((await manager().run({ once: true })).state, "APPLIED");
    const state = (await f.store.read())!;
    assert.equal(state.journal!.settings!.repositoryAccess!.mode, "AUTO_CODE");
    assert.equal(f.response.applied!.readMode, "AUTO_CODE");
    const local = await f.store
      .generationStore(state.current!.agentId, state.current!.generation)
      .read();
    assert.deepEqual(local!.settings!.repositoryAccess, state.journal!.repositoryAccess);
  } finally {
    await f.close();
  }
});

test("should reject automatic mode omission insertion and approval persistence failure before provider calls", async () => {
  for (const automatic of [false, true]) {
    const f = await fixture("claude");
    try {
      await f
        .manager({
          confirm: async () => ({
            confirmed: true,
            repositoryAlias: "Repository",
            files: automatic ? [] : [...f.policy.files],
            handoff: "Shared evidence.",
            ...(automatic ? { readMode: "AUTO_CODE" as const } : {}),
          }),
        })
        .run({ once: true });
      f.applying();
      if (!automatic) f.response.operation!.requested.readMode = "AUTO_CODE";
      const before = f.catalogs;
      const outcome = await f.manager().run({ once: true });
      assert.equal(outcome.ready, false);
      assert.equal(f.catalogs, before);
      assert.equal(f.prepares, 0);
    } finally {
      await f.close();
    }
  }
});

test("should submit no provider catalog or input when automatic consent durability fails", async () => {
  const f = await fixture("claude");
  const write = f.store.write.bind(f.store);
  f.store.write = async (state, check) => {
    if (state.journal?.repositoryAccess) throw new RuntimeError("UNSAFE_STORAGE");
    return write(state, check);
  };
  try {
    const outcome = await f
      .manager({
        confirm: async () => ({
          confirmed: true,
          repositoryAlias: "Repository",
          files: [],
          handoff: "Shared evidence.",
          readMode: "AUTO_CODE",
        }),
      })
      .run({ once: true });
    assert.equal(outcome.ready, false);
    assert.equal(f.catalogs, 0);
    assert.equal(f.prepares, 0);
    assert.equal(f.adapters.length, 0);
    assert.equal((await f.store.read())!.journal!.repositoryAccess, undefined);
  } finally {
    await f.close();
  }
});

for (const provider of ["codex", "claude"] as const) {
  test(`should apply ${provider} settings when only the native model display name changes`, async () => {
    const f = await fixture(provider);
    try {
      Object.assign(f.observedCaps.models[0], { displayName: "Native name before" });
      await local(f);
      assert.equal(
        (f.response.catalog!.models[0] as unknown as Record<string, unknown>).displayName,
        "Native name before",
      );
      Object.assign(f.observedCaps.models[0], { displayName: "Native name after" });
      const status = await f.manager().run({ once: true });
      assert.equal(status.state, "APPLIED", JSON.stringify(status));
      assert.equal(f.prepares, 1);
    } finally {
      await f.close();
    }
  });
  for (const field of (provider === "codex"
    ? ["model", "efforts", "version", "id", "defaults"]
    : ["model", "efforts", "id", "defaults"]) as (
    "model" | "efforts" | "version" | "id" | "defaults"
  )[]) {
    test(`should reject changed semantic ${provider} ${field} between folder selection and apply`, async () => {
      const f = await fixture(provider);
      try {
        await local(f);
        if (field === "version") f.observedCaps.version = "changed-version";
        else if (field === "id") f.observedCaps.models[0].id = "changed-id";
        else if (field === "defaults") f.observedCaps.defaultSettings = null;
        else if (field === "model") {
          f.observedCaps.models[0].model = "changed-model";
          f.observedCaps.defaultSettings!.model = "changed-model";
        } else {
          f.observedCaps.models[0].efforts.push("changed-effort");
          if (provider === "claude") {
            f.observedCaps.models[0].defaultEffort = "changed-effort";
            f.observedCaps.defaultSettings!.effort = "changed-effort";
          }
        }
        const status = await f.manager().run({ once: true });
        assert.equal(status.reason, "SNAPSHOT_CHANGED", JSON.stringify(status));
        assert.equal(f.prepares, 0);
      } finally {
        await f.close();
      }
    });
  }
}

for (const budget of [13000, 15100]) {
  test(`should preserve all models in a formerly valid ${budget}-byte catalog and fit confirmation envelopes`, async () => {
    const f = await fixture();
    try {
      const models: Capabilities["models"] = [];
      const original = {
        runtime: "codex" as const,
        version: f.observedCaps.version,
        models,
        defaultSettings: { model: "large-model-0", effort: "low" },
        policy: "verified" as const,
      };
      for (let i = 0; i < 256; i++) {
        const model = {
          id: `large-id-${i}-${"x".repeat(60)}`,
          model: i === 0 ? "large-model-0" : `large-model-${i}-${"y".repeat(60)}`,
          efforts: ["low", "high"],
          defaultEffort: "low",
          isDefault: i === 0,
        };
        const candidate = { ...original, models: [...models, model], snapshotHash: "a".repeat(64) };
        if (jsonbTextBytes(candidate) > budget) break;
        models.push(model);
      }
      const hash = capabilityHash(original);
      f.observedCaps = {
        ...f.observedCaps,
        models: models.map((m) => ({ ...m, displayName: "Native " + "x".repeat(110) })),
        defaultSettings: original.defaultSettings,
      };
      const status = await f.manager().run({ once: true });
      assert.equal(status.state, "LOCAL_CONFIRMATION", JSON.stringify(status));
      assert.deepEqual(f.response.catalog!.models, models);
      assert.equal(f.response.catalog!.snapshotHash, hash);
      assert.ok(jsonbTextBytes(f.response.catalog) > budget - 500);
      const local = f.requests.find(
        (r) => r.action === "receipt" && r.body.state === "LOCAL_CONFIRMATION",
      )!.body;
      assert.ok(jsonbTextBytes(local) <= 16384);
      assert.ok(jsonbTextBytes(f.response) <= 16200);
      assert.ok(jsonbTextBytes({ ok: true, data: f.response }) <= 16384);
      if (budget === 13000) {
        f.applying();
        const applied = await f.manager().run({ once: true });
        assert.equal(applied.state, "APPLIED", JSON.stringify(applied));
        assert.ok(jsonbTextBytes(f.response) <= 16200);
      }
    } finally {
      await f.close();
    }
  });
}

test("should preserve once mode and skip background reports without a callback", async () => {
  const f = await fixture();
  let reports = 0;
  try {
    await f
      .manager({
        heartbeat: async () => {
          reports++;
        },
      })
      .run({ once: true });
    assert.equal(reports, 0);
    await f
      .manager({
        heartbeat: async () => {
          reports++;
        },
      })
      .run({ signal: AbortSignal.abort() });
    assert.equal(reports, 0);
    const abort = new AbortController();
    f.pollHook = () => abort.abort();
    await f.manager().run({ signal: abort.signal });
    assert.equal(f.prepares, 0);
  } finally {
    await f.close();
  }
});

test(
  "should keep reporting while settings confirmation is pending without preparing AI",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture();
    const abort = new AbortController(),
      reported = deferred(),
      confirming = deferred();
    let reports = 0,
      pendingConfirmation = false;
    const timeout = globalThis.setTimeout;
    t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) =>
      timeout(callback, ms === 30_000 ? 5 : ms),
    );
    let job: Promise<unknown> | undefined;
    try {
      job = f
        .manager({
          heartbeat: async (credential, signal) => {
            assert.equal(credential, "a".repeat(64));
            assert.equal(signal.aborted, false);
            reports++;
            if (pendingConfirmation) reported.resolve();
          },
          confirm: async (_root, signal) => {
            pendingConfirmation = true;
            confirming.resolve();
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
              if (signal.aborted) resolve();
            });
            return { confirmed: false, repositoryAlias: "Repository", files: [], handoff: "" };
          },
        })
        .run({ signal: abort.signal });
      await Promise.all([reported.promise, confirming.promise]);
      assert.ok(reports >= 2);
      assert.equal(f.prepares, 0);
      assert.equal(f.catalogs, 0);
    } finally {
      abort.abort();
      await job;
      await f.close();
    }
  },
);

test(
  "should serialize reports and stop before releasing the device lock",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    f.response = { ...f.response, operation: null };
    const abort = new AbortController(),
      entered = deferred(),
      release = deferred();
    let settled = false,
      reports = 0;
    let job: Promise<unknown> | undefined;
    try {
      job = f
        .manager({
          heartbeat: async (_credential, signal) => {
            reports++;
            entered.resolve();
            await release.promise;
            assert.equal(signal.aborted, true);
          },
        })
        .run({ signal: abort.signal })
        .then(() => {
          settled = true;
        });
      await entered.promise;
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false);
      await assert.rejects(
        new SettingsStore(f.profile).locked(async () => {}),
        { code: "RUNTIME_BUSY" },
      );
      release.resolve();
      await job;
      assert.equal(reports, 1);
      await new SettingsStore(f.profile).locked(async () => {});
    } finally {
      abort.abort();
      release.resolve();
      await job;
      await f.close();
    }
  },
);

test(
  "should ignore a late heartbeat authentication failure after credential replacement",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    f.response = { ...f.response, operation: null };
    const abort = new AbortController(),
      entered = deferred(),
      release = deferred(),
      failed = deferred();
    let job: Promise<unknown> | undefined;
    try {
      job = f
        .manager({
          heartbeat: async (credential) => {
            assert.equal(credential, "a".repeat(64));
            entered.resolve();
            await release.promise;
            failed.resolve();
            throw new ConnectionError("UNAUTHENTICATED");
          },
        })
        .run({ signal: abort.signal });
      await entered.promise;
      await f.profile.transaction(async () => {
        const current = (await f.profile.read())!;
        current.credential = "b".repeat(64);
        await f.profile.write(current);
      });
      const replacement = await readFile(f.profile.file);
      release.resolve();
      await failed.promise;
      abort.abort();
      await job;
      assert.deepEqual(await readFile(f.profile.file), replacement);
      assert.equal((await f.profile.read())!.status, "connected");
    } finally {
      abort.abort();
      release.resolve();
      await job;
      await f.close();
    }
  },
);

test(
  "should keep runner profile transactions available during a slow heartbeat",
  { timeout: 10000 },
  async () => {
    const f = await runnerFixture({ pollIntervalMs: 25 });
    const settings = new SettingsStore(f.profile);
    const abort = new AbortController(),
      entered = deferred(),
      release = deferred();
    const mapping = (await f.profile.read())!.mappings[0];
    const response: SettingsResponse = {
      protocol: 1,
      deviceId: f.scope.deviceId,
      configRevision: 0,
      catalog: null,
      operation: null,
      applied: null,
      current: true,
      currentBinding: {
        agentId: f.scope.agentId,
        workspaceId: mapping.workspaceId!,
        bindingEpoch: 1,
        runtime: "codex",
      },
    };
    const pointer = {
      generation: f.context.generation,
      agentId: f.scope.agentId,
      workspaceId: mapping.workspaceId!,
      bindingEpoch: 1,
      configRevision: 0,
      provider: "codex" as const,
      localRootReference: uuid(),
      legacy: true,
    };
    const operationId = uuid();
    const initial: Parameters<SettingsStore["write"]>[0] = {
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
    await settings.write(initial);
    initial.journal!.phase = "CANCELLED";
    initial.journal!.receipt = {
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
    await settings.write(initial);
    let reports = 0;
    const manager = new SettingsManager(
      f.profile,
      settings,
      new SettingsClient(f.scope.server, async () => Response.json({ ok: true, data: response })),
      {
        pollIntervalMs: 25,
        heartbeat: async () => {
          reports++;
          entered.resolve();
          await release.promise;
        },
        runner: () => f.runner(),
      },
    );
    const job = manager.run({ signal: abort.signal });
    try {
      await entered.promise;
      const before = performance.now();
      await f.rotate();
      assert.ok(performance.now() - before < 2000);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      const admissions = f.requests.filter((request) => request.action === "admission").length;
      const polls = f.requests.filter((request) => request.action === "poll").length;
      assert.ok(admissions >= 2);
      assert.ok(polls >= 2);
      f.pauseInput(true);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(f.inputState().appliedRevision, f.inputState().revision);
      assert.ok(f.requests.filter((request) => request.action === "poll").length > polls);
      assert.equal(f.adapter.starts, 0);
      assert.equal(f.adapter.prepares, 0);
      assert.equal(reports, 1);
      abort.abort();
      release.resolve();
      const status = await job;
      assert.equal(status.reason, null);
      assert.equal(f.adapter.closed, true);
    } finally {
      abort.abort();
      release.resolve();
      await job;
      await f.close();
    }
  },
);

test(
  "should recheck abort after the credential snapshot before starting a report",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture();
    f.response = { ...f.response, operation: null };
    const abort = new AbortController(),
      reading = deferred(),
      release = deferred();
    let reports = 0,
      reads = 0;
    const read = f.profile.read.bind(f.profile);
    t.mock.method(f.profile, "read", async () => {
      const state = await read();
      if (++reads === 3) {
        reading.resolve();
        await release.promise;
      }
      return state;
    });
    const job = f
      .manager({
        heartbeat: async () => {
          reports++;
        },
      })
      .run({ signal: abort.signal });
    try {
      await reading.promise;
      abort.abort();
      release.resolve();
      await job;
      assert.equal(reports, 0);
    } finally {
      abort.abort();
      release.resolve();
      await job;
      await f.close();
    }
  },
);

test(
  "should preserve runner cleanup failure while waiting for background heartbeat cleanup",
  { timeout: 5000 },
  async () => {
    const f = await fixture();
    const abort = new AbortController(),
      entered = deferred(),
      release = deferred(),
      runnerClosed = deferred();
    let job: Promise<unknown> | undefined;
    try {
      await local(f);
      await f.manager().run({ once: true });
      job = f
        .manager({
          heartbeat: async () => {
            entered.resolve();
            await release.promise;
            throw new ConnectionError("UNAVAILABLE");
          },
          runner: () => ({
            run: async ({ signal }) => {
              await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
                if (signal.aborted) resolve();
              });
              runnerClosed.resolve();
              throw new RuntimeError("CLEANUP_INCOMPLETE");
            },
          }),
        })
        .run({ signal: abort.signal });
      const rejected = assert.rejects(job, { code: "CLEANUP_INCOMPLETE" });
      await entered.promise;
      // Wait until the runner is owned before stopping the manager.
      while (!f.requests.some((request) => request.action === "poll" && !request.body.operationId))
        await new Promise((resolve) => setTimeout(resolve, 2));
      await new Promise((resolve) => setTimeout(resolve, 20));
      abort.abort();
      await runnerClosed.promise;
      assert.ok(await lstat(f.store.lockPath));
      release.resolve();
      await rejected;
      await assert.rejects(
        new SettingsStore(f.profile).locked(async () => {}),
        { code: "RUNTIME_BUSY" },
      );
    } finally {
      abort.abort();
      release.resolve();
      await job?.catch(() => {});
      await f.close();
    }
  },
);

test(
  "should keep reporting while one answer is pending without starting another runner",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture();
    const abort = new AbortController(),
      reported = deferred(),
      started = deferred();
    let job: Promise<unknown> | undefined;
    let runnerCalls = 0,
      reports = 0;
    try {
      await local(f);
      await f.manager().run({ once: true });
      const prepares = f.prepares,
        catalogs = f.catalogs;
      const timeout = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", (callback: () => void, ms?: number) =>
        timeout(callback, ms === 30_000 ? 5 : ms),
      );
      job = f
        .manager({
          heartbeat: async () => {
            reports++;
            if (runnerCalls && reports >= 2) reported.resolve();
          },
          runner: () => ({
            run: async ({ signal }) => {
              runnerCalls++;
              started.resolve();
              return new Promise<{ ready: boolean }>((resolve) => {
                signal.addEventListener("abort", () => resolve({ ready: false }), { once: true });
                if (signal.aborted) resolve({ ready: false });
              });
            },
          }),
        })
        .run({ signal: abort.signal });
      await Promise.all([reported.promise, started.promise]);
      assert.ok(reports >= 2);
      assert.equal(runnerCalls, 1);
      assert.equal(f.prepares, prepares);
      assert.equal(f.catalogs, catalogs);
    } finally {
      abort.abort();
      await job;
      await f.close();
    }
  },
);

function settingsRenewal(f: Awaited<ReturnType<typeof fixture>>) {
  let rotations = 0;
  const rotated = deferred();
  const renewal = new ConnectionRenewal(
    new Connector(
      f.profile,
      new CentralClient(f.scope.server, async () => {
        rotations++;
        rotated.resolve();
        return Response.json({
          ok: true,
          data: {
            protocol: 1,
            deviceId: f.scope.deviceId,
            expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
          },
        });
      }),
    ),
  );
  return { renewal, rotations: () => rotations, rotated: rotated.promise };
}

for (const boundary of ["bootstrap", "with-idle"] as const)
  test(`should await a shared slow rotation at the ${boundary} connection snapshot during settings change`, async (t) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    let rotation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (boundary === "with-idle") {
        await local(f);
        await f.manager().run({ once: true });
        const operationId = uuid();
        f.response = {
          ...f.response,
          operation: {
            operationId,
            deviceId: f.scope.deviceId,
            expectedConfigRevision: f.response.configRevision,
            state: "REQUESTED",
            requested: {
              operationId,
              deviceId: f.scope.deviceId,
              expectedConfigRevision: f.response.configRevision,
              runtime: "codex",
            },
            receipt: null,
          },
          catalog: null,
        };
        assert.equal((await f.manager().run({ once: true })).state, "LOCAL_CONFIRMATION");
        f.applying();
      }
      const renewal = new ConnectionRenewal(
        new Connector(
          f.profile,
          new CentralClient(f.scope.server, async () => {
            entered.resolve();
            await release.promise;
            return Response.json({
              ok: true,
              data: {
                protocol: 1,
                deviceId: f.scope.deviceId,
                expiresAt: new Date(Date.now() + 604800000).toISOString(),
              },
            });
          }),
        ),
      );
      const rotate = async () => {
        if (rotation) return;
        const state = (await f.profile.read())!;
        state.credentialExpiresAt = new Date(Date.now() + 299000).toISOString();
        await f.profile.write(state);
        rotation = renewal.ensure();
        await entered.promise;
        timer = setTimeout(() => release.resolve(), 100);
      };
      if (boundary === "bootstrap") {
        const call = f.client.call.bind(f.client);
        t.mock.method(f.client, "call", async (...args: Parameters<SettingsClient["call"]>) => {
          const result = await call(...args);
          if (args[0] === "poll") await rotate();
          return result;
        });
      } else {
        const assertUnchanged = RuntimeFilePolicy.prototype.assertUnchanged;
        t.mock.method(
          RuntimeFilePolicy.prototype,
          "assertUnchanged",
          async function (this: RuntimeFilePolicy, ...args: Parameters<typeof assertUnchanged>) {
            await assertUnchanged.apply(this, args);
            await rotate();
          },
        );
      }
      const status = await f.manager({ renewal }).run({ once: true });
      await rotation;
      assert.equal(status.state, boundary === "bootstrap" ? "LOCAL_CONFIRMATION" : "APPLIED");
      assert.notEqual((await f.store.read())!.journal!.phase, "UNKNOWN");
      assert.equal(status.reason, null);
    } finally {
      release.resolve();
      if (timer) clearTimeout(timer);
      await rotation;
      await f.close();
    }
  });
async function waitForRenewal(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("synthetic renewal did not reach the expected boundary");
}

test("should renew an idle manager before its first credential-bearing poll", async () => {
  const f = await fixture();
  try {
    f.response = { ...f.response, operation: null };
    const state = (await f.profile.read())!;
    state.credentialExpiresAt = new Date(Date.now() + 299000).toISOString();
    await f.profile.write(state);
    const r = settingsRenewal(f);
    await f.manager({ renewal: r.renewal }).run({ once: true });
    assert.equal(r.rotations(), 1);
    assert.equal(f.requests[0].secret, `Bearer ${(await f.profile.read())!.credential}`);
    assert.equal(f.prepares, 0);
  } finally {
    await f.close();
  }
});

for (const dialog of ["folder", "consent"] as const)
  test(`should renew while the owner ${dialog} dialog is pending`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    const abort = new AbortController(),
      r = settingsRenewal(f);
    let run: Promise<unknown> | undefined;
    try {
      const state = (await f.profile.read())!;
      state.credentialExpiresAt = new Date(Date.now() + 330000).toISOString();
      await f.profile.write(state);
      const options: SettingsManagerOptions = { renewal: r.renewal };
      if (dialog === "folder")
        options.folder = async () => {
          entered.resolve();
          await release.promise;
          return { status: "CANCELLED" };
        };
      else
        options.confirm = async () => {
          entered.resolve();
          await release.promise;
          return { confirmed: false };
        };
      run = f.manager(options).run({ signal: abort.signal });
      await entered.promise;
      t.mock.timers.setTime(Date.now() + 30000);
      await waitForRenewal(() => r.rotations() === 1);
      assert.equal(f.prepares, 0);
      abort.abort();
      release.resolve();
      await run;
    } finally {
      abort.abort();
      release.resolve();
      await run;
      await f.close();
    }
  });

for (const action of ["poll", "receipt"] as const)
  test(`should retry the exact stale settings ${action} once after a credential change`, async (t) => {
    const f = await fixture();
    try {
      const manager = f.manager();
      await manager.run({ once: true });
      const calls: { body: Body; credential: string }[] = [];
      const original = f.client.call.bind(f.client);
      t.mock.method(
        f.client,
        "call",
        async (...[current, body, credential, timeout]: Parameters<SettingsClient["call"]>) => {
          calls.push({ body: structuredClone(body), credential });
          if (calls.length === 1) {
            await f.profile.transaction(async () => {
              const state = (await f.profile.read())!;
              state.credential = "b".repeat(64);
              await f.profile.write(state);
            });
            throw new SettingsError("UNAUTHENTICATED");
          }
          return original(current, body, credential, timeout);
        },
      );
      const call = (
        manager as unknown as { call(action: "poll" | "receipt", body: Body): Promise<unknown> }
      ).call.bind(manager);
      await call(
        action,
        action === "receipt" ? (f.response.operation!.receipt as unknown as Body) : {},
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].body, calls[1].body);
      assert.notEqual(calls[0].credential, calls[1].credential);
      assert.equal(f.prepares, 0);
    } finally {
      await f.close();
    }
  });

for (const invalid of ["unchanged", "scope", "deadline"] as const)
  test(`should refuse settings stale-auth retry after ${invalid}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture();
    let elapsed = performance.now();
    t.mock.method(performance, "now", () => elapsed);
    try {
      const manager = f.manager();
      await manager.run({ once: true });
      let calls = 0;
      t.mock.method(f.client, "call", async () => {
        calls++;
        const state = (await f.profile.read())!;
        if (invalid !== "unchanged") state.credential = "b".repeat(64);
        if (invalid === "scope") state.scope!.roomId = uuid();
        await f.profile.write(state);
        if (invalid === "deadline") elapsed += 10000;
        throw new SettingsError("UNAUTHENTICATED");
      });
      await assert.rejects(
        (manager as unknown as { call(action: "poll"): Promise<unknown> }).call("poll"),
      );
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  });

test("should surface authentication loss after a closed settings journal", async () => {
  const f = await fixture();
  try {
    const first = await f
      .manager({ folder: async () => ({ status: "CANCELLED" }) })
      .run({ once: true });
    assert.equal(first.state, "CANCELLED");
    f.refusePoll = true;
    const failed = await f.manager().run({ once: true });
    assert.equal(failed.reason, "FORBIDDEN");
    assert.equal(failed.ready, false);
  } finally {
    await f.close();
  }
});

test("should renew from the thirty-second background pulse without a foreground settings poll", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = await fixture(),
    firstReport = deferred(),
    firstPoll = deferred(),
    pulseScheduled = deferred();
  const r = settingsRenewal(f),
    abort = new AbortController();
  const schedule = setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args: Parameters<typeof setTimeout>) => {
    const timer = schedule(...args);
    if (args[1] === 30000) pulseScheduled.resolve();
    return timer;
  });
  let job: Promise<unknown> | undefined;
  try {
    f.response = { ...f.response, operation: null };
    const state = (await f.profile.read())!;
    state.credentialExpiresAt = new Date(Date.now() + 330000).toISOString();
    await f.profile.write(state);
    f.pollHook = () => {
      firstPoll.resolve();
    };
    job = f
      .manager({
        renewal: r.renewal,
        pollIntervalMs: 100000,
        heartbeat: async () => {
          firstReport.resolve();
        },
      })
      .run({ signal: abort.signal });
    await firstReport.promise;
    await firstPoll.promise;
    await pulseScheduled.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(r.rotations(), 0);
    t.mock.timers.tick(30000);
    await r.rotated;
    assert.equal(r.rotations(), 1);
    assert.equal(f.requests.filter((request) => request.action === "poll").length, 1);
    abort.abort();
    await job;
    assert.equal(f.prepares, 0);
  } finally {
    abort.abort();
    await job;
    await r.renewal.stop();
    await f.close();
  }
});
