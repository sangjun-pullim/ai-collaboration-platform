import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, lstat } from "node:fs/promises";
import { ClaudeCatalogStore } from "../src/claude/catalog-store.ts";
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
import { SettingsManager, type SettingsManagerOptions } from "../src/settings/manager.ts";
import { SettingsClient } from "../src/settings/client.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { type Body, type Receipt, type SettingsResponse } from "../src/settings/contracts.ts";
import { runtimeFixture, uuid, observation } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";

/** This HTTP fixture exercises the real client's projection, not an actual DB transaction. */
async function fixture(provider: "codex" | "claude" = "codex") {
  const f = await runtimeFixture();
  const profile = new StateStore(f.stateDir, "one");
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
  let pollHook: (() => Promise<void> | void) | undefined;
  const fetcher: typeof fetch = async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push({ action, body, secret: new Headers(init?.headers).get("authorization") });
    if (action === "poll") {
      await pollHook?.();
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
          operation: { ...response.operation!, state: receipt.state, receipt },
        };
      }
    }
    if (action === "receipt") receiptHook?.(body as unknown as Receipt);
    const hiddenTerminal =
      action === "poll" &&
      ["APPLIED", "CANCELLED"].includes(response.operation?.state ?? "") &&
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
    const selection = local.catalog!.defaultSettings!;
    response.operation = {
      ...response.operation!,
      state: "APPLYING",
      requested: {
        operationId: response.operation!.operationId,
        deviceId: response.deviceId,
        expectedConfigRevision: response.configRevision,
        runtime: local.runtime,
        ...selection,
        snapshotHash: local.catalog!.snapshotHash,
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
async function local(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal((await f.manager().run({ once: true })).state, "LOCAL_CONFIRMATION");
  assert.equal(f.prepares, 0);
  f.applying();
}

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

test("should keep default Claude admission closed without a verified policy", async () => {
  const f = await fixture("claude");
  try {
    const status = await f.manager({ adapter: undefined }).run({ once: true });
    assert.equal(status.state, "FAILED");
    assert.equal(status.reason, "POLICY_UNCONFIRMED");
    const journal = (await f.store.read())!.journal!;
    assert.equal(journal.catalogContext, undefined);
    assert.equal(journal.context, null);
    assert.equal(f.prepares, 0);
    assert.equal(f.adapters.length, 0);
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
