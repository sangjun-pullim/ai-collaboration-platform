import type { SetupInspection } from "../connection-setup/setup-controller.ts";
import {
  SettingsError,
  isId,
  validateBody,
  validateSelection,
  type Body,
  type Capability,
  type ErrorCode,
  type HumanAction,
  type Provider,
  type Selection,
  type SettingsResponse,
} from "./contracts.ts";

type CurrentResponse = SettingsResponse;
export type SettingsRequest = (
  action: HumanAction,
  body: Body,
  signal?: AbortSignal,
) => Promise<CurrentResponse>;
export type SettingsView = {
  response: CurrentResponse | null;
  provider: Provider | null;
  draft: Selection | null;
  sessionAlias: string;
  busy: HumanAction | null;
  error: ErrorCode | null;
  reservedOperationId: string | null;
  setupInspection?: SetupInspection | null;
  setupError?: boolean;
  setupCheckedAt?: number;
  pollManual?: boolean;
  saveError?: ErrorCode | null;
  applyUnconfirmed?: boolean;
};

export function confirmedCatalog(response: CurrentResponse | null): Capability | null {
  const op = response?.operation;
  const catalog = response?.catalog;
  const receipt = op?.receipt;
  if (
    !response?.current ||
    !op ||
    op.state !== "LOCAL_CONFIRMATION" ||
    op.expectedConfigRevision !== response.configRevision ||
    receipt?.state !== "LOCAL_CONFIRMATION" ||
    receipt.operationId !== op.operationId ||
    receipt.configRevision !== response.configRevision ||
    !isId(receipt.localRootReference) ||
    !receipt.repositoryAlias ||
    catalog?.policy !== "verified" ||
    catalog.runtime !== op.requested.runtime ||
    (Object.hasOwn(op.requested, "snapshotHash") &&
      op.requested.snapshotHash !== catalog.snapshotHash) ||
    receipt.runtime !== catalog.runtime
  )
    return null;
  return catalog;
}

export function selectionSaved(view: SettingsView): boolean {
  const catalog = confirmedCatalog(view.response);
  const requested = view.response?.operation?.requested;
  if (!view.draft || !catalog || !requested) return false;
  try {
    validateSelection(view.draft, catalog);
    return ["runtime", "model", "effort", "snapshotHash"].every(
      (key) => requested[key] === view.draft![key as keyof Selection],
    );
  } catch {
    return false;
  }
}

function released(response: CurrentResponse): boolean {
  const op = response.operation;
  const receipt = op?.receipt;
  if (
    !op ||
    !receipt ||
    op.deviceId !== response.deviceId ||
    receipt.operationId !== op.operationId
  )
    return false;
  if (op.state === "CANCELLED" && receipt.state === "CANCELLED")
    return (
      receipt.configRevision === op.expectedConfigRevision &&
      response.configRevision === op.expectedConfigRevision
    );
  const binding = response.currentBinding;
  return (
    op.state === "APPLIED" &&
    receipt.state === "APPLIED" &&
    response.current &&
    !!binding &&
    receipt.configRevision === op.expectedConfigRevision + 1 &&
    receipt.configRevision === response.configRevision &&
    receipt.agentId === binding.agentId &&
    receipt.workspaceId === binding.workspaceId &&
    receipt.bindingEpoch === binding.bindingEpoch &&
    receipt.runtime === binding.runtime
  );
}

function initialSelection(catalog: Capability, requested: Body): Selection | null {
  const candidate = {
    runtime: catalog.runtime,
    model: requested.model ?? catalog.defaultSettings?.model,
    effort: Object.hasOwn(requested, "effort") ? requested.effort : catalog.defaultSettings?.effort,
    snapshotHash: catalog.snapshotHash,
  } as Selection;
  try {
    return validateSelection(candidate, catalog);
  } catch {
    return null;
  }
}

export class SettingsController {
  private view: SettingsView = {
    response: null,
    provider: null,
    draft: null,
    sessionAlias: "",
    busy: null,
    error: null,
    reservedOperationId: null,
  };
  private listeners = new Set<() => void>();
  private saveInFlight = false;
  private applyAttempts = new Set<string>();
  private pollStartedAt = 0;
  private visible = true;
  private active = false;
  private generation = 0;
  private pollInFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort: AbortController | null = null;
  private mutationAbort: AbortController | null = null;
  private bindingOperationId: string | null = null;
  private bindingIdentity: string | undefined;

  constructor(
    readonly deviceId: string,
    private readonly request: SettingsRequest,
    private readonly interval = 2500,
    private readonly uuid: () => string = () => crypto.randomUUID(),
    private readonly defaultAlias = "",
    private readonly observe?: (signal: AbortSignal) => Promise<SetupInspection>,
  ) {}

  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(change: Partial<SettingsView>) {
    this.view = { ...this.view, ...change };
    this.listeners.forEach((listener) => listener());
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.pollStartedAt = Date.now();
    this.generation++;
    this.update({ busy: null });
    this.schedule(0);
  }

  stop() {
    this.active = false;
    this.generation++;
    this.clearTimer();
    this.pollAbort?.abort();
    this.mutationAbort?.abort();
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      this.clearTimer();
      this.pollAbort?.abort();
    } else this.schedule(0);
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay = this.interval) {
    if (this.active && Date.now() - this.pollStartedAt >= 300000) this.update({ pollManual: true });
    if (this.view.response && !this.view.reservedOperationId && !this.view.busy) return;
    if (
      !this.active ||
      !this.visible ||
      Date.now() - this.pollStartedAt >= 300000 ||
      this.timer !== null ||
      this.pollInFlight ||
      this.view.busy ||
      this.saveInFlight
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  async poll() {
    if (!this.active || !this.visible || this.pollInFlight || this.view.busy || this.saveInFlight)
      return;
    this.clearTimer();
    this.pollInFlight = true;
    const generation = this.generation;
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      const body: Body = { deviceId: this.deviceId };
      if (this.view.reservedOperationId) body.operationId = this.view.reservedOperationId;
      const response = await this.request("list", body, abort.signal);
      if (this.active && generation === this.generation && !abort.signal.aborted) {
        this.adopt(response);
        // Diagnostic observation follows the authoritative list, never overlaps it.
        if (this.observe && this.view.reservedOperationId) {
          try {
            const setupInspection = await this.observe(abort.signal);
            if (this.active && generation === this.generation && !abort.signal.aborted) {
              if (
                setupInspection.device?.deviceId !== this.deviceId ||
                (setupInspection.settings &&
                  (setupInspection.settings.operationId !==
                    this.view.response?.operation?.operationId ||
                    setupInspection.settings.configRevision !== this.view.response?.configRevision))
              )
                throw new SettingsError("CONFLICT");
              this.update({ setupInspection, setupError: false, setupCheckedAt: Date.now() });
            }
          } catch {
            if (this.active && generation === this.generation && !abort.signal.aborted)
              this.update({ setupError: true });
          }
        }
      }
    } catch (error) {
      if (this.active && generation === this.generation) this.failure(error);
    } finally {
      this.pollInFlight = false;
      if (this.pollAbort === abort) this.pollAbort = null;
      this.schedule();
    }
  }

  private failure(error: unknown) {
    this.update({ error: error instanceof SettingsError ? error.code : "UNAVAILABLE" });
  }

  private adopt(response: CurrentResponse, expectedOperationId?: string) {
    const op = response.operation;
    if (
      response.deviceId !== this.deviceId ||
      (op && op.deviceId !== this.deviceId) ||
      (op?.receipt && op.receipt.operationId !== op.operationId) ||
      (expectedOperationId && op?.operationId !== expectedOperationId) ||
      (this.view.reservedOperationId && op && op.operationId !== this.view.reservedOperationId) ||
      response.configRevision < (this.view.response?.configRevision ?? 0)
    )
      throw new SettingsError("CONFLICT");
    // An absent list operation alone is not proof of local candidate cleanup.
    if (!op && this.view.reservedOperationId && this.view.response?.operation)
      response = { ...response, operation: this.view.response.operation };
    if (response.operation) {
      const binding = response.currentBinding;
      const identity =
        binding === undefined
          ? undefined
          : binding === null
            ? "unbound"
            : `${binding.agentId}:${binding.workspaceId}:${binding.bindingEpoch}:${binding.runtime}`;
      const currentOp = response.operation;
      const committed = currentOp.receipt;
      const ownCommit =
        (currentOp.state === "COMMITTED" || currentOp.state === "APPLIED") &&
        committed &&
        binding &&
        committed.agentId === binding.agentId &&
        committed.workspaceId === binding.workspaceId &&
        committed.bindingEpoch === binding.bindingEpoch &&
        committed.runtime === binding.runtime &&
        committed.configRevision === currentOp.expectedConfigRevision + 1;
      if (this.bindingOperationId !== currentOp.operationId || ownCommit) {
        this.bindingOperationId = currentOp.operationId;
        this.bindingIdentity = identity;
      } else if (this.bindingIdentity !== undefined && identity !== this.bindingIdentity) {
        response = { ...response, current: false };
      } else if (this.bindingIdentity === undefined) {
        this.bindingIdentity = identity;
      }
    }
    const catalog = confirmedCatalog(response);
    const previous = this.view.response;
    const newOperation =
      !!response.operation && response.operation.operationId !== previous?.operation?.operationId;
    const clearSave = released(response) || newOperation;
    const sameSelection =
      previous?.operation?.operationId === response.operation?.operationId &&
      previous?.configRevision === response.configRevision &&
      previous?.catalog?.snapshotHash === catalog?.snapshotHash;
    this.update({
      response,
      provider: released(response)
        ? this.view.provider
        : ((response.operation?.requested.runtime as Provider | undefined) ?? this.view.provider),
      draft: catalog
        ? sameSelection
          ? this.view.draft
          : initialSelection(catalog, response.operation!.requested)
        : null,
      sessionAlias:
        typeof response.operation?.requested.sessionAlias === "string"
          ? response.operation.requested.sessionAlias
          : this.view.sessionAlias || response.applied?.sessionAlias || this.defaultAlias,
      reservedOperationId: released(response)
        ? null
        : (response.operation?.operationId ?? this.view.reservedOperationId),
      ...(clearSave
        ? { applyUnconfirmed: false, saveError: null, setupInspection: null, setupError: false }
        : {}),
      error: clearSave ? null : (this.view.saveError ?? null),
    });
  }

  setProvider(provider: Provider) {
    if (this.view.busy || this.view.reservedOperationId) return;
    this.update({ provider, draft: null, error: null });
  }

  setModel(model: string) {
    if (this.view.busy || this.saveInFlight || selectionSaved(this.view)) return;
    const catalog = confirmedCatalog(this.view.response);
    const item = catalog?.models.find((item) => item.model === model);
    if (!catalog || !item) return;
    this.update({
      draft: {
        runtime: catalog.runtime,
        model,
        effort: item.efforts.length === 0 ? null : item.defaultEffort,
        snapshotHash: catalog.snapshotHash,
      },
    });
  }

  setEffort(effort: string) {
    if (this.view.busy || this.saveInFlight || selectionSaved(this.view) || !this.view.draft)
      return;
    const draft = { ...this.view.draft, effort };
    const catalog = confirmedCatalog(this.view.response);
    try {
      if (!catalog) return;
      validateSelection(draft, catalog);
      this.update({ draft });
    } catch {}
  }

  setSessionAlias(sessionAlias: string) {
    if (
      this.view.busy ||
      this.saveInFlight ||
      this.view.response?.operation?.state !== "LOCAL_CONFIRMATION"
    )
      return;
    this.update({
      sessionAlias,
      ...(!this.view.applyUnconfirmed ? { saveError: null, error: null } : {}),
    });
  }

  private async mutate(action: HumanAction, body: Body): Promise<boolean> {
    if (!this.active || this.view.busy) return false;
    validateBody(action, body);
    this.generation++;
    this.pollStartedAt = Date.now();
    this.clearTimer();
    this.pollAbort?.abort();
    const generation = this.generation;
    const abort = new AbortController();
    this.mutationAbort = abort;
    this.update({ busy: action, error: null, pollManual: false });
    let received = false;
    try {
      const response = await this.request(action, body, abort.signal);
      received = true;
      if (this.active && generation === this.generation)
        this.adopt(response, body.operationId as string);
      return this.active && generation === this.generation;
    } catch (error) {
      if (this.active && generation === this.generation) {
        if (
          !received &&
          action === "select-folder" &&
          error instanceof SettingsError &&
          [
            "INVALID_BODY",
            "BODY_TOO_LARGE",
            "UNAUTHENTICATED",
            "FORBIDDEN",
            "NOT_FOUND",
            "CONFLICT",
            "QUOTA",
          ].includes(error.code)
        )
          this.update({ reservedOperationId: null });
        this.failure(error);
      }
      return false;
    } finally {
      if (this.mutationAbort === abort) this.mutationAbort = null;
      if (this.active && generation === this.generation) {
        this.update({ busy: null });
        this.schedule(0);
      }
    }
  }

  async selectFolder() {
    if (
      !this.active ||
      this.view.busy ||
      this.view.reservedOperationId ||
      !this.view.provider ||
      !this.view.response?.current
    )
      return;
    const operationId = this.uuid();
    this.update({ reservedOperationId: operationId });
    await this.mutate("select-folder", {
      operationId,
      deviceId: this.deviceId,
      expectedConfigRevision: this.view.response.configRevision,
      runtime: this.view.provider,
    });
  }

  async save() {
    const { response, draft, sessionAlias } = this.view;
    const catalog = confirmedCatalog(response);
    if (
      !this.active ||
      this.saveInFlight ||
      this.view.busy ||
      !response?.operation ||
      !catalog ||
      !draft ||
      !sessionAlias.trim() ||
      response.currentBinding === undefined ||
      this.applyAttempts.has(response.operation.operationId)
    )
      return;
    const identity = JSON.stringify([
      this.deviceId,
      response.operation.operationId,
      response.configRevision,
      catalog.snapshotHash,
      response.currentBinding,
      response.operation.receipt?.localRootReference,
      response.operation.receipt?.repositoryAlias,
    ]);
    const intended = { ...draft };
    const operationId = response.operation.operationId;
    this.saveInFlight = true;
    this.update({ saveError: null, applyUnconfirmed: false });
    this.pollStartedAt = Date.now();
    try {
      validateSelection(intended, catalog);
      // One explicit click owns both writes; an uncertain first result stops here.
      if (!selectionSaved(this.view)) {
        const selected = await this.mutate("select-runtime", {
          ...intended,
          operationId,
          deviceId: this.deviceId,
          expectedConfigRevision: response.configRevision,
        });
        if (!selected) {
          this.update({ saveError: this.view.error });
          return;
        }
      } else {
        if (!(await this.mutate("list", { deviceId: this.deviceId, operationId }))) return;
      }
      const current = this.view.response;
      const currentCatalog = confirmedCatalog(current);
      const nextIdentity = JSON.stringify([
        this.deviceId,
        current?.operation?.operationId,
        current?.configRevision,
        currentCatalog?.snapshotHash,
        current?.currentBinding,
        current?.operation?.receipt?.localRootReference,
        current?.operation?.receipt?.repositoryAlias,
      ]);
      if (
        identity !== nextIdentity ||
        !this.active ||
        !selectionSaved(this.view) ||
        JSON.stringify(this.view.draft) !== JSON.stringify(intended)
      ) {
        this.failure(new SettingsError("CONFLICT"));
        return;
      }
      const generation = this.generation;
      this.update({ sessionAlias });
      if (generation === this.generation) await this.applySelection();
    } catch (error) {
      this.failure(error);
    } finally {
      this.saveInFlight = false;
      this.schedule(0);
    }
  }

  async selectRuntime() {
    if (this.saveInFlight) return;
    const { response, draft } = this.view;
    const catalog = confirmedCatalog(response);
    if (!response?.operation || !catalog || !draft || selectionSaved(this.view)) return;
    try {
      validateSelection(draft, catalog);
      await this.mutate("select-runtime", {
        ...draft,
        operationId: response.operation.operationId,
        deviceId: this.deviceId,
        expectedConfigRevision: response.configRevision,
      });
    } catch (error) {
      this.failure(error);
    }
  }

  async apply() {
    if (this.saveInFlight) return;
    await this.applySelection();
  }

  private async applySelection() {
    const { response, draft, sessionAlias } = this.view;
    const receipt = response?.operation?.receipt;
    if (
      !response?.operation ||
      !selectionSaved(this.view) ||
      !draft ||
      !receipt ||
      response.currentBinding === undefined ||
      this.applyAttempts.has(response.operation.operationId)
    )
      return;
    try {
      const applyBody = {
        ...draft,
        operationId: response.operation.operationId,
        deviceId: this.deviceId,
        expectedConfigRevision: response.configRevision,
        localRootReference: receipt.localRootReference,
        repositoryAlias: receipt.repositoryAlias,
        sessionAlias,
        expectedEpoch: response.currentBinding?.bindingEpoch ?? null,
        ...(receipt.readMode === "AUTO_CODE" ? { readMode: receipt.readMode } : {}),
      };
      validateBody("apply", applyBody);
      this.applyAttempts.add(response.operation.operationId);
      if (!(await this.mutate("apply", applyBody)))
        this.update({ saveError: this.view.error, applyUnconfirmed: true });
    } catch (error) {
      this.failure(error);
      this.update({ saveError: this.view.error });
    }
  }

  async cancel() {
    if (this.saveInFlight) return;
    const operationId = this.view.reservedOperationId;
    const op = this.view.response?.operation;
    if (
      !operationId ||
      op?.state === "COMMITTED" ||
      op?.state === "APPLIED" ||
      op?.state === "CANCELLED" ||
      ((op?.state === "UNKNOWN" || op?.state === "FAILED") &&
        Object.hasOwn(op.requested, "expectedEpoch"))
    )
      return;
    await this.mutate("cancel", { operationId, deviceId: this.deviceId });
  }
}
