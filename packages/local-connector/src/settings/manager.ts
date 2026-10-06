import { randomUUID } from "node:crypto";
import { createProviderAdapter } from "../provider-adapter.ts";
import { StateStore, type ConnectorState } from "../state-store.ts";
import { RuntimeStore, unresolvedRuntime } from "../runtime-store.ts";
import { createRepositoryAccess, repositoryMode } from "../workspace/repository-access.ts";
import { RuntimeFilePolicy } from "../runtime-file-policy.ts";
import {
  RuntimeError,
  stableJson,
  digest,
  type Capabilities,
  type OwnedContext,
  type RuntimeAdapter,
  type RuntimeRecord,
  type RuntimeSettings,
} from "../runtime-contracts.ts";
import { SettingsClient } from "./client.ts";
import {
  SettingsError,
  capabilityHash,
  projectCapability,
  validateBody,
  validateSelection,
  type Body,
  type Capability,
  type Operation,
  type Provider,
  type Receipt,
  type SettingsResponse,
  isId,
} from "./contracts.ts";
import { pickFolder, type FolderPickerResult } from "./folder-picker.ts";
import { confirmLocalScope, type LocalScopeChoice } from "./local-confirmation.ts";
import {
  SettingsStore,
  type SettingsState,
  type GenerationPointer,
  type SetupJournal,
} from "./store.ts";

type CatalogReservation = (
  root: string,
  version: string,
  fingerprint: string,
) => Promise<OwnedContext>;
type Runner = {
  run(options: { once: boolean; signal: AbortSignal }): Promise<{ ready?: boolean }>;
};
export type SettingsManagerOptions = {
  adapter?: (provider: Provider, reserveCatalog: CatalogReservation) => RuntimeAdapter;
  folder?: (signal: AbortSignal) => Promise<FolderPickerResult>;
  confirm?: (
    root: NonNullable<SetupJournal["root"]>,
    signal: AbortSignal,
  ) => Promise<LocalScopeChoice>;
  runner?: (pointer: GenerationPointer, store: RuntimeStore) => Runner;
  pollIntervalMs?: number;
};
export type SettingsManagerStatus = {
  state: string;
  ready: boolean;
  operationId: string | null;
  configRevision: number;
  reason: string | null;
};
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
const closed = (journal: SetupJournal) => ["APPLIED", "CANCELLED"].includes(journal.phase);

function catalog(provider: Provider, value: Capabilities): Capability {
  if (value.policy !== "CONFIRMED" || (value.runtime && value.runtime !== provider))
    throw new RuntimeError("UNSUPPORTED_SETTINGS");
  const contents = {
    runtime: provider,
    version: value.version,
    models: value.models,
    defaultSettings: value.defaultSettings,
    policy: "verified" as const,
  };
  return projectCapability({ ...contents, snapshotHash: capabilityHash(contents) });
}
function receipt(
  j: SetupJournal,
  state: Receipt["state"],
  revision = j.operation.expectedConfigRevision,
): Receipt {
  return {
    operationId: j.operation.operationId,
    ...(j.repositoryAccess ? { readMode: j.repositoryAccess.mode } : {}),
    state,
    configRevision: revision,
    runtime: j.settings?.provider ?? (j.operation.requested.runtime as Provider),
    model: j.settings?.requested.model ?? (j.applyBody?.model as string | undefined) ?? null,
    effort:
      j.settings?.requested.effort ?? (j.applyBody?.effort as string | null | undefined) ?? null,
    snapshotHash:
      j.settings?.capabilities.snapshotHash ??
      (j.applyBody?.snapshotHash as string | undefined) ??
      null,
    localRootReference: j.applyBody
      ? j.localRootReference
      : j.receipt?.repositoryAlias
        ? j.localRootReference
        : null,
    repositoryAlias:
      (j.applyBody?.repositoryAlias as string | undefined) ?? j.receipt?.repositoryAlias ?? null,
    sessionAlias:
      (j.applyBody?.sessionAlias as string | undefined) ??
      (j.settings ? (j.receipt?.sessionAlias ?? null) : null),
    catalog: null,
    bindingEpoch: null,
    agentId: null,
    workspaceId: null,
  };
}

/** One device lock owns settings polling and the runner until every owned child is closed. */
export class SettingsManager {
  private state!: SettingsState;
  private ready = false;
  private reason: string | null = null;
  private signal: AbortSignal = new AbortController().signal;
  private adapter: RuntimeAdapter | undefined;
  private runnerJob: Promise<void> | undefined;
  private runnerAbort: AbortController | undefined;
  private runnerFailure: unknown;
  private runnerSettled = false;
  private latestResponse: SettingsResponse | undefined;
  constructor(
    readonly profile: StateStore,
    readonly store: SettingsStore,
    readonly client: SettingsClient,
    private readonly options: SettingsManagerOptions = {},
  ) {
    if (
      store.profile !== profile ||
      !Number.isSafeInteger(options.pollIntervalMs ?? 1000) ||
      (options.pollIntervalMs ?? 1000) < 1
    )
      throw new RuntimeError("INVALID_RUNTIME");
  }
  private status(): SettingsManagerStatus {
    return {
      state: this.state?.journal?.phase ?? (this.state?.current ? "APPLIED" : "UNCONFIGURED"),
      ready: this.ready,
      operationId: this.state?.journal?.operation.operationId ?? null,
      configRevision: this.state?.current?.configRevision ?? 0,
      reason: this.reason ?? this.state?.journal?.reason ?? null,
    };
  }
  private async connected(): Promise<ConnectorState> {
    const p = await this.profile.read();
    if (
      !p ||
      p.status !== "connected" ||
      p.pending ||
      !isId(p.deviceId) ||
      !p.scope ||
      !isId(p.scope.organizationId) ||
      !isId(p.scope.roomId) ||
      !p.credential ||
      !/^[a-f0-9]{64}$/.test(p.credential) ||
      !p.credentialExpiresAt ||
      !(Date.parse(p.credentialExpiresAt) > Date.now()) ||
      p.server !== this.client.origin
    )
      throw new SettingsError("UNAUTHENTICATED");
    if (
      this.state &&
      (p.server !== this.state.server ||
        p.deviceId !== this.state.deviceId ||
        p.scope.organizationId !== this.state.organizationId ||
        p.scope.roomId !== this.state.roomId)
    )
      throw new SettingsError("FORBIDDEN");
    return p;
  }
  private async call(action: "poll" | "receipt", body: Body = {}): Promise<SettingsResponse> {
    const p = await this.connected();
    const journal = this.state?.journal;
    if (action === "poll" && journal && !closed(journal))
      body = { ...body, operationId: journal.operation.operationId };
    const response = await this.client.call(action, body, p.credential!);
    if (response.deviceId !== p.deviceId) throw new SettingsError("FORBIDDEN");
    this.latestResponse = response;
    return response;
  }
  private async save(update: (state: SettingsState, journal: SetupJournal) => void) {
    const next = structuredClone(this.state);
    update(next, next.journal!);
    try {
      await this.store.write(next);
      this.state = next;
    } catch (error) {
      this.state = (await this.store.read()) ?? this.state;
      throw error;
    }
  }
  private runtimeStore(pointer: GenerationPointer) {
    return pointer.legacy
      ? new RuntimeStore(this.profile.dir, this.profile.profile, pointer.agentId)
      : this.store.generationStore(pointer.agentId, pointer.generation);
  }
  private async bootstrap(response: SettingsResponse, operation: Operation) {
    if (
      operation.expectedConfigRevision !== response.configRevision ||
      operation.deviceId !== this.state.deviceId
    )
      throw new SettingsError("CONFLICT");
    const p = await this.connected();
    let previous = this.state.current;
    if (!previous && response.currentBinding) {
      const b = response.currentBinding;
      const legacy = await new RuntimeStore(
        this.profile.dir,
        this.profile.profile,
        b.agentId,
      ).read();
      const mapping = p.mappings.find(
        (m) =>
          m.agentId === b.agentId &&
          m.workspaceId === b.workspaceId &&
          m.bindingEpoch === b.bindingEpoch,
      );
      if (
        !legacy?.context ||
        !legacy.settings ||
        !mapping ||
        response.configRevision !== 0 ||
        legacy.scope.bindingEpoch !== b.bindingEpoch ||
        legacy.settings.provider !== b.runtime ||
        mapping.root !== legacy.context.root.path ||
        mapping.nativeSessionId !== legacy.context.threadId
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      previous = {
        generation: legacy.context.generation,
        agentId: b.agentId,
        workspaceId: b.workspaceId,
        bindingEpoch: b.bindingEpoch,
        configRevision: 0,
        provider: b.runtime,
        localRootReference: randomUUID(),
        legacy: true,
      };
    }
    this.assertBinding(response, previous);
    const next: SettingsState = {
      ...this.state,
      current: previous,
      journal: {
        operation: structuredClone(operation),
        phase: "CHOOSING",
        generation: randomUUID(),
        localRootReference: randomUUID(),
        root: null,
        settings: null,
        context: null,
        receipt: null,
        reason: null,
        previous,
      },
    };
    await this.store.write(next);
    this.state = next;
  }
  private assertBinding(response: SettingsResponse, pointer = this.state.current) {
    if (
      !response.current ||
      response.configRevision !== (pointer?.configRevision ?? 0) ||
      (pointer
        ? !same(response.currentBinding, {
            agentId: pointer.agentId,
            workspaceId: pointer.workspaceId,
            bindingEpoch: pointer.bindingEpoch,
            runtime: pointer.provider,
          })
        : response.currentBinding !== null)
    )
      throw new SettingsError("CONFLICT");
  }
  private sameOperation(response: SettingsResponse) {
    const j = this.state.journal!;
    const op = response.operation;
    if (
      !op ||
      op.operationId !== j.operation.operationId ||
      op.deviceId !== this.state.deviceId ||
      op.expectedConfigRevision !== j.operation.expectedConfigRevision ||
      op.requested.runtime !== j.operation.requested.runtime
    )
      throw new SettingsError("CONFLICT");
    return op;
  }
  private async pause(ms = this.options.pollIntervalMs ?? 1000, signal = this.signal) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  private async pulse(job: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    try {
      await Promise.race([
        job,
        new Promise<void>((resolve) => {
          wake = () => resolve();
          timer = setTimeout(resolve, this.options.pollIntervalMs ?? 1000);
          this.signal.addEventListener("abort", wake, { once: true });
          if (this.signal.aborted) resolve();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (wake) this.signal.removeEventListener("abort", wake);
    }
  }
  private async cleanupAdapter() {
    const adapter = this.adapter;
    this.adapter = undefined;
    if (adapter)
      try {
        await adapter.close();
      } catch {
        throw new RuntimeError("CLEANUP_INCOMPLETE");
      }
  }
  private createAdapter() {
    const j = this.state.journal!;
    const reserve: CatalogReservation = async (path, version, fingerprint) => {
      if (!j.root || path !== j.root.path) throw new RuntimeError("CONTEXT_UNCONFIRMED");
      const saved = this.state.journal!.catalogContext;
      if (saved) {
        if (
          saved.materialization?.state !== "RESERVED" ||
          saved.materialization.version !== version ||
          saved.materialization.policyFingerprint !== fingerprint
        )
          throw new RuntimeError("CONTEXT_UNCONFIRMED");
        return saved;
      }
      const context: OwnedContext = {
        ownership: "CONNECTOR_CREATED",
        provider: "claude",
        generation: j.generation,
        threadId: randomUUID(),
        root: j.root,
        epoch: (j.previous?.bindingEpoch ?? 0) + 1,
        level: "L1",
        ownedTurns: [],
        materialization: {
          state: "RESERVED",
          version,
          policyFingerprint: fingerprint,
          initHash: null,
        },
      };
      await this.save((_state, journal) => {
        journal.catalogContext = context;
      });
      return context;
    };
    const provider = j.operation.requested.runtime as Provider;
    return (
      this.options.adapter?.(provider, reserve) ??
      createProviderAdapter(provider, { profile: this.profile, reserveCatalog: reserve })
    );
  }
  private async cancel(serverCancelled: boolean) {
    this.ready = false;
    await this.save((_state, j) => {
      j.phase = "CANCEL_INTENT";
    });
    try {
      await this.cleanupAdapter();
    } catch {
      await this.save((_state, j) => {
        j.phase = "UNKNOWN";
        j.reason = "CLEANUP_INCOMPLETE";
      });
      throw new RuntimeError("CLEANUP_INCOMPLETE");
    }
    if (!serverCancelled) {
      const failure = receipt(this.state.journal!, "FAILED");
      await this.save((_state, j) => {
        j.receipt = failure;
      });
      await this.call("receipt", failure as unknown as Body);
    }
    const cancelled = receipt(this.state.journal!, "CANCELLED");
    await this.save((_state, j) => {
      j.receipt = cancelled;
    });
    const response = await this.call("receipt", cancelled as unknown as Body);
    if (
      this.sameOperation(response).state !== "CANCELLED" ||
      !same(response.operation!.receipt, cancelled)
    )
      throw new RuntimeError("UNKNOWN");
    await this.save((_state, j) => {
      j.phase = "CANCELLED";
      j.reason = null;
    });
    this.reason = null;
  }
  /** This is the sole settings poll while a dialog, catalog or preparation is outstanding. */
  private async watched<T>(
    run: (signal: AbortSignal, check: () => void) => Promise<T>,
  ): Promise<T> {
    const abort = new AbortController();
    const check = () => {
      if (abort.signal.aborted || this.signal.aborted) throw new RuntimeError("RUNTIME_CLOSED");
    };
    const onAbort = () => abort.abort();
    this.signal.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const job = Promise.resolve()
      .then(() => {
        check();
        return run(abort.signal, check);
      })
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      while (!settled) {
        await this.pulse(job);
        if (settled) break;
        if (this.signal.aborted) {
          abort.abort();
          await this.cleanupAdapter();
          await job;
          throw new RuntimeError("RUNTIME_CLOSED");
        }
        const response = await this.call("poll");
        const operation = this.sameOperation(response);
        if (operation.state === "CANCELLED") {
          abort.abort();
          await this.cleanupAdapter();
          await job;
          await this.cancel(true);
          throw new RuntimeError("RUNTIME_CLOSED");
        }
      }
      const outcome = await job;
      if ("error" in outcome) throw outcome.error;
      check();
      return outcome.value;
    } catch (error) {
      abort.abort();
      await this.cleanupAdapter();
      await job;
      throw error;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
    }
  }
  private async choose() {
    const selected = await this.watched(
      (signal) => this.options.folder?.(signal) ?? pickFolder({ signal }),
    );
    if (selected.status !== "SELECTED") {
      if (selected.status === "CANCELLED") return this.cancel(false);
      throw new RuntimeError(
        selected.status === "UNSUPPORTED" ? "POLICY_UNCONFIRMED" : "PROVIDER_UNAVAILABLE",
      );
    }
    await this.save((_state, j) => {
      j.root = selected.root;
    });
    const choice = await this.watched(
      (signal) =>
        this.options.confirm?.(selected.root, signal) ??
        confirmLocalScope(selected.root, { signal }),
    );
    if (!choice.confirmed) return this.cancel(false);
    if (
      choice.readMode !== undefined &&
      (choice.readMode !== "AUTO_CODE" || choice.files.length !== 0)
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    await new RuntimeFilePolicy(selected.root, choice.files).assertUnchanged(() => {});
    await this.save((_state, j) => {
      if (choice.readMode === "AUTO_CODE")
        j.repositoryAccess = createRepositoryAccess(
          j.generation,
          selected.root,
          j.localRootReference,
          j.operation.operationId,
        );
      j.files = choice.files;
      j.handoff = choice.handoff;
      j.receipt = {
        ...receipt(j, "LOCAL_CONFIRMATION"),
        repositoryAlias: choice.repositoryAlias,
        localRootReference: j.localRootReference,
      };
      j.phase = "CATALOG_INTENT";
    });
    this.adapter = this.createAdapter();
    const capabilities = await this.watched((_signal, check) =>
      this.adapter!.capabilities(selected.root.path, check),
    );
    const publicCatalog = catalog(
      this.state.journal!.operation.requested.runtime as Provider,
      capabilities,
    );
    await this.cleanupAdapter();
    await this.save((_state, j) => {
      j.phase = "LOCAL_CONFIRMATION";
      j.receipt!.catalog = publicCatalog;
    });
    await this.call("receipt", this.state.journal!.receipt as unknown as Body);
  }
  private async stopRunner(abort = false) {
    if (abort) this.runnerAbort?.abort();
    await this.runnerJob;
    this.runnerJob = undefined;
    this.runnerAbort = undefined;
    if (this.runnerFailure) {
      const error = this.runnerFailure;
      this.runnerFailure = undefined;
      if (error instanceof RuntimeError && error.code === "CLEANUP_INCOMPLETE") throw error;
      if (!(abort && error instanceof RuntimeError && error.code === "RUNTIME_CLOSED"))
        this.reason = error instanceof RuntimeError ? error.code : "UNKNOWN";
      this.ready = false;
    }
  }
  private startRunner(once: boolean) {
    if (
      this.runnerJob ||
      this.signal.aborted ||
      !this.options.runner ||
      !this.state.current ||
      (this.state.journal && !closed(this.state.journal))
    )
      return;
    const pointer = this.state.current;
    const controller = new AbortController();
    this.runnerAbort = controller;
    this.runnerSettled = false;
    this.runnerJob = this.options
      .runner(pointer, this.runtimeStore(pointer))
      .run({ once, signal: controller.signal })
      .then(
        async (result) => {
          const record = await this.runtimeStore(pointer).read();
          this.ready =
            result.ready === true &&
            !!record?.context &&
            record.context.generation === pointer.generation &&
            record.scope.bindingEpoch === pointer.bindingEpoch &&
            record.context.materialization?.state !== "RESERVED";
        },
        (error) => {
          this.ready = false;
          this.runnerFailure = error;
        },
      )
      .catch((error) => {
        this.runnerFailure = error;
        this.ready = false;
      })
      .finally(() => {
        this.runnerSettled = true;
      });
  }
  private async withIdle<T>(run: () => Promise<T>): Promise<T> {
    if (this.runnerJob)
      await this.watched(async (signal) => {
        while (!signal.aborted && !this.runnerSettled) {
          const pointer = this.state.current;
          const record = pointer ? await this.runtimeStore(pointer).read() : undefined;
          if (!record) throw new RuntimeError("CONTEXT_UNCONFIRMED");
          if (!unresolvedRuntime(record)) {
            await this.stopRunner(true);
            return;
          }
          await this.pause(this.options.pollIntervalMs ?? 1000, signal);
        }
        if (!signal.aborted) await this.stopRunner();
      });
    this.ready = false;
    for (const agentId of await RuntimeStore.agents(this.profile.dir, this.profile.profile)) {
      const record = await new RuntimeStore(this.profile.dir, this.profile.profile, agentId).read();
      if (record && unresolvedRuntime(record)) throw new RuntimeError("RUNTIME_BUSY");
    }
    for (const retained of this.state.retained) {
      const record = await this.runtimeStore(retained).read();
      if (record && unresolvedRuntime(record)) throw new RuntimeError("RUNTIME_BUSY");
    }
    const pointer = this.state.journal!.previous ?? null;
    if (!pointer) return run();
    const store = this.runtimeStore(pointer);
    return store.locked(async () => {
      const record = await store.read();
      if (
        !record?.context ||
        !record.settings ||
        unresolvedRuntime(record) ||
        !same(record.scope, {
          server: this.state.server,
          deviceId: this.state.deviceId,
          organizationId: this.state.organizationId,
          roomId: this.state.roomId,
          agentId: pointer.agentId,
          bindingEpoch: pointer.bindingEpoch,
        }) ||
        record.context.generation !== pointer.generation ||
        record.settings.provider !== pointer.provider
      )
        throw new RuntimeError("RUNTIME_BUSY");
      return store.sessionLocked(record.context.threadId, async () => {
        await new RuntimeFilePolicy(record.context!.root, record.settings!.files).assertUnchanged(
          () => {},
        );
        const p = await this.connected();
        if (
          !p.mappings.some(
            (m) =>
              m.agentId === pointer.agentId &&
              m.workspaceId === pointer.workspaceId &&
              m.bindingEpoch === pointer.bindingEpoch &&
              m.root === record.context!.root.path &&
              m.nativeSessionId === record.context!.threadId,
          )
        )
          throw new RuntimeError("CONTEXT_UNCONFIRMED");
        return run();
      });
    });
  }
  private applyBody(response: SettingsResponse) {
    const operation = this.sameOperation(response);
    if (operation.state !== "APPLYING") throw new SettingsError("CONFLICT");
    this.assertBinding(response, this.state.journal!.previous ?? null);
    const body = validateBody("apply", operation.requested);
    const j = this.state.journal!;
    if (
      !j.root ||
      !j.receipt?.catalog ||
      body.localRootReference !== j.localRootReference ||
      body.readMode !== j.repositoryAccess?.mode ||
      body.repositoryAlias !== j.receipt.repositoryAlias ||
      body.expectedEpoch !== (j.previous?.bindingEpoch ?? null)
    )
      throw new SettingsError("CONFLICT");
    validateSelection(
      {
        runtime: body.runtime as Provider,
        model: body.model as string,
        effort: body.effort as string | null,
        snapshotHash: body.snapshotHash as string,
      },
      j.receipt.catalog,
    );
    return body;
  }
  private async prepare(response: SettingsResponse) {
    const body = this.applyBody(response);
    this.ready = false;
    if (this.state.journal!.applyBody && !same(this.state.journal!.applyBody, body))
      throw new SettingsError("CONFLICT");
    await this.save((_state, j) => {
      j.phase = "APPLYING";
      j.applyBody = body;
      j.applyHash = digest(stableJson(body));
    });
    await this.withIdle(async () => {
      const j = this.state.journal!;
      this.adapter = this.createAdapter();
      const observed = await this.watched((_signal, check) =>
        this.adapter!.capabilities(j.root!.path, check),
      );
      if (!same(catalog(body.runtime as Provider, observed), j.receipt!.catalog))
        throw new RuntimeError("SNAPSHOT_CHANGED");
      const settings: RuntimeSettings = {
        provider: body.runtime as Provider,
        requested: { model: body.model as string, effort: body.effort as string | null },
        capabilities: { ...j.receipt!.catalog!, policy: "CONFIRMED" },
        files: j.files ?? [],
        handoff: j.handoff ?? "",
        publicScopeConfirmed: true,
        autoQuestionsConfirmed: false,
        ...(j.repositoryAccess ? { repositoryAccess: structuredClone(j.repositoryAccess) } : {}),
      };
      repositoryMode(settings, { generation: j.generation, root: j.root! });
      await new RuntimeFilePolicy(j.root!, settings.files).assertUnchanged(() => {});
      const latest = await this.call("poll");
      if (!same(this.applyBody(latest), body)) throw new SettingsError("CONFLICT");
      await this.save((_state, journal) => {
        journal.phase = "PREPARE_INTENT";
        journal.settings = settings;
        journal.receipt = {
          ...receipt(journal, "LOCAL_CONFIRMATION"),
          repositoryAlias: body.repositoryAlias as string,
          sessionAlias: body.sessionAlias as string,
        };
      });
      const context = await this.watched((_signal, check) =>
        this.adapter!.prepare(
          j.root!,
          settings,
          j.generation,
          (j.previous?.bindingEpoch ?? 0) + 1,
          check,
          async (context) => {
            await this.save((_state, journal) => {
              journal.context = context;
            });
          },
        ),
      );
      if (!same(context, this.state.journal!.context))
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      await this.cleanupAdapter();
      await this.save((_state, journal) => {
        journal.phase = "PREPARED";
        journal.commitBody = {
          ...receipt(journal, "COMMITTED", journal.operation.expectedConfigRevision + 1),
          repositoryAlias: body.repositoryAlias as string,
          sessionAlias: body.sessionAlias as string,
          bindingEpoch: (journal.previous?.bindingEpoch ?? 0) + 1,
          agentId: journal.previous?.agentId ?? null,
          workspaceId: journal.previous?.workspaceId ?? null,
        };
      });
      await this.commit();
    });
  }
  private verifyCommitted(response: SettingsResponse) {
    const op = this.sameOperation(response),
      j = this.state.journal!,
      committed = op.receipt;
    if (
      !committed ||
      !["COMMITTED", "APPLIED"].includes(op.state) ||
      !["COMMITTED", "APPLIED"].includes(committed.state) ||
      !j.context ||
      !j.settings ||
      !j.root ||
      !j.commitBody
    )
      throw new RuntimeError("UNKNOWN");
    if (
      !j.applyBody ||
      !same(op.requested, j.applyBody) ||
      digest(stableJson(j.applyBody)) !== j.applyHash
    )
      throw new SettingsError("CONFLICT");
    const { state: _state, agentId, workspaceId, ...rest } = committed;
    const {
      state: _localState,
      agentId: oldAgent,
      workspaceId: oldWorkspace,
      ...local
    } = j.commitBody!;
    void _state;
    void _localState;
    if (
      !same(rest, local) ||
      !agentId ||
      !workspaceId ||
      (oldAgent && oldAgent !== agentId) ||
      (oldWorkspace && oldWorkspace !== workspaceId) ||
      committed.bindingEpoch !== j.context.epoch ||
      !response.current ||
      response.configRevision !== committed.configRevision ||
      !same(response.currentBinding, {
        agentId,
        workspaceId,
        bindingEpoch: committed.bindingEpoch,
        runtime: committed.runtime,
      })
    )
      throw new SettingsError("CONFLICT");
    return committed;
  }
  private async commit() {
    const j = this.state.journal!;
    if (!j.commitBody || !j.context) throw new RuntimeError("UNKNOWN");
    if (j.phase === "PREPARED")
      await this.save((_state, journal) => {
        journal.phase = "COMMIT_INTENT";
      });
    const response = await this.call("receipt", this.state.journal!.commitBody as unknown as Body);
    await this.adopt(response);
  }
  private async adopt(response: SettingsResponse) {
    const committed = this.verifyCommitted(response);
    if (!["COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(this.state.journal!.phase))
      await this.save((_state, j) => {
        j.phase = "COMMITTED";
        j.receipt = { ...committed, state: "COMMITTED" };
      });
    const j = this.state.journal!,
      context = j.context!;
    const pointer: GenerationPointer = {
      generation: j.generation,
      agentId: committed.agentId!,
      workspaceId: committed.workspaceId!,
      bindingEpoch: committed.bindingEpoch!,
      configRevision: committed.configRevision,
      provider: committed.runtime!,
      localRootReference: j.localRootReference,
    };
    const generated = this.store.generationStore(pointer.agentId, pointer.generation);
    const oldRecord = j.previous ? await this.runtimeStore(j.previous).read() : undefined;
    await generated.locked(async () =>
      generated.sessionLocked(context.threadId, async () => {
        const existing = await generated.read();
        const record: RuntimeRecord = {
          version: 2,
          scope: {
            server: this.state.server,
            deviceId: this.state.deviceId,
            organizationId: this.state.organizationId,
            roomId: this.state.roomId,
            agentId: pointer.agentId,
            bindingEpoch: pointer.bindingEpoch,
          },
          settings: j.settings,
          context,
          ready: false,
          preparation: null,
          attempts: [],
          operations: [],
        };
        if (existing) {
          if (
            !same(existing.scope, record.scope) ||
            !same(existing.settings, record.settings) ||
            !same(existing.context, record.context)
          )
            throw new RuntimeError("CONTEXT_UNCONFIRMED");
        }
        // A readable rename is not proof that its parent directory was synced.
        await generated.write(existing ?? record);
        await this.profile.transaction(async () => {
          const p = await this.connected();
          const mapping = {
            formatVersion: 2 as const,
            runtime: pointer.provider,
            generation: pointer.generation,
            materialization: context.materialization?.state ?? ("MATERIALIZED" as const),
            root: context.root.path,
            nativeSessionId: context.threadId,
            workspaceId: pointer.workspaceId,
            agentId: pointer.agentId,
            bindingEpoch: pointer.bindingEpoch,
          };
          const previous = j.previous;
          const current = p.mappings.find((m) => m.agentId === pointer.agentId);
          if (previous && !current) throw new RuntimeError("CONTEXT_UNCONFIRMED");
          if (
            current &&
            !same(current, mapping) &&
            (!previous ||
              current.agentId !== previous.agentId ||
              current.workspaceId !== previous.workspaceId ||
              current.bindingEpoch !== previous.bindingEpoch ||
              current.root !== oldRecord?.context?.root.path ||
              current.nativeSessionId !== oldRecord?.context?.threadId)
          )
            throw new RuntimeError("CONTEXT_UNCONFIRMED");
          await this.profile.write({
            ...p,
            mappings: [...p.mappings.filter((m) => m.agentId !== pointer.agentId), mapping],
          });
        });
        if (!same(this.state.current, pointer))
          await this.save((state, journal) => {
            if (state.current) state.retained.push(state.current);
            state.current = pointer;
            journal.phase = "LOCAL_COMMITTED";
          });
        else
          // Repeat the durable write after a prior rename or directory-sync failure.
          await this.save((_state, journal) => {
            journal.phase = "LOCAL_COMMITTED";
          });
      }),
    );
    const applied = { ...committed, state: "APPLIED" as const };
    const appliedResponse = await this.call("receipt", applied as unknown as Body);
    this.verifyCommitted(appliedResponse);
    await this.save((_state, journal) => {
      journal.phase = "APPLIED";
      journal.receipt = applied;
      journal.reason = null;
    });
    this.reason = null;
  }
  private async recover(response: SettingsResponse) {
    const j = this.state.journal!,
      op = this.sameOperation(response);
    if (
      op.state === "CANCELLED" &&
      !["COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(j.phase) &&
      j.receipt?.state !== "COMMITTED"
    ) {
      if (
        ["LOCAL_CONFIRMATION", "PREPARED", "FAILED"].includes(j.phase) ||
        j.receipt?.state === "CANCELLED" ||
        !!j.commitBody
      )
        return this.cancel(true);
      if (
        j.phase === "UNKNOWN" &&
        !j.applyBody &&
        j.receipt?.state === "LOCAL_CONFIRMATION" &&
        j.receipt.catalog
      )
        return this.cancel(true);
      await this.save((_s, journal) => {
        journal.phase = "UNKNOWN";
        journal.reason = "UNKNOWN";
      });
      return;
    }
    if (["COMMITTED", "APPLIED"].includes(op.state)) return this.adopt(response);
    if (j.phase === "CANCEL_INTENT") {
      if (j.receipt?.state === "CANCELLED") {
        const result = await this.call("receipt", j.receipt as unknown as Body);
        if (this.sameOperation(result).state === "CANCELLED")
          await this.save((_s, journal) => {
            journal.phase = "CANCELLED";
          });
      }
      return;
    }
    if (
      ["COMMIT_INTENT", "PREPARED"].includes(j.phase) ||
      (j.phase === "UNKNOWN" && !!j.commitBody)
    )
      return this.commit();
    if (
      j.phase === "UNKNOWN" &&
      !j.applyBody &&
      j.receipt?.state === "LOCAL_CONFIRMATION" &&
      j.receipt.catalog
    ) {
      await this.call("receipt", j.receipt as unknown as Body);
      await this.save((_s, journal) => {
        journal.phase = "LOCAL_CONFIRMATION";
        journal.reason = null;
      });
      return;
    }
    if (j.phase === "LOCAL_CONFIRMATION" || j.phase === "APPLYING") {
      if (op.state === "REQUESTED") await this.call("receipt", j.receipt as unknown as Body);
      else if (op.state === "APPLYING") await this.prepare(response);
      return;
    }
    if (["CHOOSING", "CATALOG_INTENT", "PREPARE_INTENT", "UNKNOWN"].includes(j.phase))
      await this.save((_s, journal) => {
        journal.phase = "UNKNOWN";
        journal.reason = "UNKNOWN";
      });
  }
  private async failure(error: unknown) {
    this.ready = false;
    if (this.state?.journal && closed(this.state.journal)) return;
    this.reason =
      error instanceof RuntimeError || error instanceof SettingsError ? error.code : "UNKNOWN";
    const j = this.state?.journal;
    if (!j || closed(j) || ["COMMITTED", "LOCAL_COMMITTED"].includes(j.phase)) return;
    if (this.reason === "RUNTIME_BUSY" && j.phase === "APPLYING") {
      await this.save((_s, journal) => {
        journal.reason = "RUNTIME_BUSY";
      });
      return;
    }
    if (
      [
        "UNSUPPORTED_SETTINGS",
        "POLICY_UNCONFIRMED",
        "PROVIDER_UNAVAILABLE",
        "SNAPSHOT_CHANGED",
        "PUBLIC_TEXT_REJECTED",
      ].includes(this.reason) &&
      !j.context &&
      !["PREPARE_INTENT", "PREPARED", "COMMIT_INTENT"].includes(j.phase)
    ) {
      try {
        await this.cleanupAdapter();
      } catch (cleanup) {
        await this.save((_s, journal) => {
          journal.phase = "UNKNOWN";
          journal.reason = "CLEANUP_INCOMPLETE";
        });
        throw cleanup;
      }
      const failed = receipt(j, "FAILED");
      await this.save((_s, journal) => {
        journal.phase = "FAILED";
        journal.reason = this.reason;
        journal.receipt = failed;
      });
      await this.call("receipt", failed as unknown as Body).catch(() => {});
      return;
    }
    if (j.phase === "CANCEL_INTENT" || !!j.commitBody) {
      await this.save((_s, journal) => {
        journal.phase = "UNKNOWN";
        journal.reason = this.reason;
      });
      return;
    }
    await this.save((_s, journal) => {
      journal.phase = "UNKNOWN";
      journal.reason = this.reason;
    });
    const body = receipt(this.state.journal!, "UNKNOWN");
    await this.call("receipt", body as unknown as Body).catch(() => {});
  }
  async run(
    options: { once?: boolean; signal?: AbortSignal } = {},
  ): Promise<SettingsManagerStatus> {
    this.signal = options.signal ?? new AbortController().signal;
    this.ready = false;
    this.reason = null;
    this.latestResponse = undefined;
    return this.store.locked(async () => {
      const p = await this.connected();
      this.state = (await this.store.read()) ?? {
        version: 1,
        server: p.server,
        deviceId: p.deviceId!,
        organizationId: p.scope!.organizationId,
        roomId: p.scope!.roomId,
        current: null,
        retained: [],
        journal: null,
      };
      await this.connected();
      let ranRunner = false;
      try {
        do {
          if (this.signal.aborted) break;
          try {
            const response = await this.call("poll");
            const journal = this.state.journal;
            if (
              response.operation &&
              (!journal ||
                (closed(journal) &&
                  journal.operation.operationId !== response.operation.operationId))
            ) {
              if (response.operation.state !== "REQUESTED") throw new RuntimeError("UNKNOWN");
              await this.bootstrap(response, response.operation);
              await this.choose();
            } else if (journal && !closed(journal)) await this.recover(response);
            if (!this.state.journal || closed(this.state.journal)) {
              if (this.state.current) this.assertBinding(this.latestResponse ?? response);
              if (this.runnerSettled) await this.stopRunner();
              if (!options.once || !ranRunner) this.startRunner(options.once === true);
              ranRunner ||= !!this.runnerJob;
            }
          } catch (error) {
            await this.failure(error);
            if (error instanceof RuntimeError && error.code === "CLEANUP_INCOMPLETE") throw error;
          }
          if (options.once && (!this.runnerJob || this.runnerSettled)) {
            await this.stopRunner();
            break;
          }
          await this.pause();
        } while (!this.signal.aborted);
      } finally {
        try {
          await this.cleanupAdapter();
          await this.stopRunner(true);
        } catch {
          if (this.state?.journal && !closed(this.state.journal))
            await this.save((_s, j) => {
              j.phase = "UNKNOWN";
              j.reason = "CLEANUP_INCOMPLETE";
            });
          throw new RuntimeError("CLEANUP_INCOMPLETE");
        }
      }
      return this.status();
    });
  }
}
