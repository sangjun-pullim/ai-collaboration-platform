import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import type { OwnedContext } from "./runtime-contracts.ts";
import { ConnectionError, type PublicBinding, type WorkspaceMetadata } from "./contracts.ts";
import { StateStore, type ConnectorState } from "./state-store.ts";
import { WorkflowClient } from "./workflow-client.ts";
import {
  WorkflowError,
  projectPoll,
  projectResponse,
  validateBody,
  type AttemptSnapshot,
  type Body,
  type Control,
  type DeviceAction,
  type PollSnapshot,
  type RequestPayload,
  type TerminalReceipt,
} from "./workflow-contracts.ts";
import {
  RuntimeAdmission,
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  type AttemptAuthority,
  type AttemptJournal,
  type RequestedSettings,
  type RuntimeAdapter,
  type RuntimeCode,
  type RuntimeOperation,
  type RuntimeRecord,
  type RuntimeScope,
  type RuntimeSettings,
  type TerminalEvidence,
  type ToolCall,
  type ToolResult,
} from "./runtime-contracts.ts";
import {
  RuntimeStore,
  runtimeRecord,
  unresolvedRuntime,
  pruneConfirmedReady,
  assertRuntimeCapacity,
  terminalReserveBytes,
} from "./runtime-store.ts";
import { RuntimeFilePolicy, publicText } from "./runtime-file-policy.ts";
import { selectSettings } from "./codex-adapter.ts";

export interface RuntimeConnections {
  rotate(assertLive?: () => void): Promise<unknown>;
  bindings(credential: string): Promise<PublicBinding[]>;
  replace(input: {
    agentId: string;
    root: string;
    nativeSessionId: string;
    repositoryAlias: string;
    sessionAlias: string;
    confirmed: boolean;
    operationId: string;
    metadata?: WorkspaceMetadata;
    assertLive?: () => void;
  }): Promise<unknown>;
}
export interface PrepareRuntime {
  root?: string;
  choice: RequestedSettings | "default";
  files: string[];
  handoff: string;
  confirmed: boolean;
  autoQuestionsConfirmed: boolean;
}
export interface RunnerOptions {
  pollIntervalMs?: number;
  leaseIntervalMs?: number;
  drainTimeoutMs?: number;
  /** Deterministic fault seams are constructor-only and have no CLI/environment equivalent. */
  beforeMutation?: (kind: string) => Promise<void>;
}
interface CapacityReservationCommit {
  operationId: string;
  remaining(record: RuntimeRecord): number | undefined;
}
const code = (error: unknown): RuntimeCode =>
  error instanceof RuntimeError
    ? error.code
    : error instanceof WorkflowError &&
        ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT"].includes(error.code)
      ? "AUTHORITY_LOST"
      : "UNKNOWN";
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const same = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);
function scopeOf(state: ConnectorState, agentId: string, origin: string): RuntimeScope {
  const mapping = state.mappings.find((m) => m.agentId === agentId);
  if (
    state.server !== origin ||
    state.status !== "connected" ||
    !state.deviceId ||
    !state.scope ||
    !mapping?.bindingEpoch ||
    !state.credential ||
    Date.parse(state.credentialExpiresAt ?? "") <= Date.now()
  )
    throw new RuntimeError("AUTHORITY_LOST");
  return {
    server: origin,
    deviceId: state.deviceId,
    organizationId: state.scope.organizationId,
    roomId: state.scope.roomId,
    agentId,
    bindingEpoch: mapping.bindingEpoch,
  };
}
function matchAttempt(actual: AttemptSnapshot, expected: AttemptSnapshot) {
  if (
    actual.requestId !== expected.requestId ||
    actual.attemptId !== expected.attemptId ||
    actual.agentId !== expected.agentId ||
    actual.bindingEpoch !== expected.bindingEpoch ||
    actual.fence !== expected.fence ||
    !same(actual.payload, expected.payload)
  )
    throw new RuntimeError("AUTHORITY_LOST");
}
function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
export class WorkflowRunner {
  private readonly admission = new RuntimeAdmission();
  private record!: RuntimeRecord;
  private archivedLast: AttemptJournal | undefined;
  private readonly capacityReservations = new Map<string, number>();
  private readonly ordinaryReadiness = new Set<string>();
  private mutations: Promise<unknown> = Promise.resolve();
  private retired = false;
  private active: AttemptAuthority | undefined;
  private toolOpen = false;
  private readonly secrets = new Set<string>();
  private readonly calls = new Map<string, { hash: string; result: Promise<ToolResult> }>();
  private lockHeld = false;
  private interruptOnStop: Promise<unknown> | undefined;
  private lossReason: RuntimeCode | null = null;
  private readyWork: Promise<void> | undefined;
  private lastReadyAt = -Infinity;
  private lastReadyValue: boolean | undefined;
  private roomPoll: { revision: number; mode: PollSnapshot["roomMode"] } | undefined;
  constructor(
    readonly profile: StateStore,
    readonly store: RuntimeStore,
    readonly client: WorkflowClient,
    readonly adapter: RuntimeAdapter,
    readonly connections: RuntimeConnections,
    private readonly options: RunnerOptions = {},
  ) {}
  private check = () => {
    this.admission.assert();
    if (this.retired || !this.lockHeld) throw new RuntimeError("RUNTIME_CLOSED");
  };
  private storageCheck = () => {
    if (this.retired || !this.lockHeld) throw new RuntimeError("RUNTIME_CLOSED");
  };
  private async mutate(
    kind: string,
    update: (record: RuntimeRecord) => void,
    guard = this.check,
    reservation?: CapacityReservationCommit,
  ) {
    const job = this.mutations.then(async () => {
      guard();
      if (this.options.beforeMutation) {
        await this.options.beforeMutation(kind);
        guard();
      }
      const next = structuredClone(this.record);
      update(next);
      guard();
      if (this.ordinaryMutation(kind)) this.assertOrdinaryCapacity(next, 0, 0, reservation);
      try {
        await this.store.write(next, guard);
        guard();
        this.record = next;
        this.commitCapacityReservation(next, reservation);
      } catch (error) {
        // A monitor can close after rename/fsync. Re-adopt the owned committed journal before
        // queued terminal/outbox mutations; never submit the pre-commit in-memory snapshot again.
        this.storageCheck();
        const committed = await this.store.read();
        this.storageCheck();
        if (committed) {
          this.record = committed;
          this.commitCapacityReservation(committed, reservation);
        }
        throw error;
      }
    });
    this.mutations = job.catch(() => {});
    return job;
  }
  private ordinaryMutation(kind: string) {
    return [
      "claim-intent",
      "claimed",
      "server-intent",
      "server-intent-confirmed",
      "provider-intent",
      "lease",
      "ready",
      "tool-receipt",
      "question-call-intent",
      "question-call-receipt",
    ].includes(kind);
  }
  private assertOrdinaryCapacity(
    record = this.record,
    extraBytes = 0,
    extraOperations = 0,
    reservation?: CapacityReservationCommit,
  ) {
    const remaining = reservation?.remaining(record);
    const reserved = [...this.capacityReservations].reduce(
      (sum, [operationId, bytes]) =>
        sum +
        (operationId === reservation?.operationId && remaining !== undefined ? remaining : bytes),
      0,
    );
    // Receipt/snapshot projections replace only their own in-flight budget. The shared budget
    // stays unchanged until the owned disk proves that projection committed.
    const last = record.attempts.at(-1);
    const terminal = last && ["TERMINAL", "UPLOADED"].includes(last.state) ? last.terminal : null;
    // Durable terminal bytes consume the existing terminal reservation even across restart.
    // Fresh claim/provider admission still uses the full admission reserve, without this credit.
    const allocated = terminal
      ? Math.min(Buffer.byteLength(JSON.stringify(terminal)), terminalReserveBytes - 128 * 1024)
      : 0;
    assertRuntimeCapacity(record, false, reserved + extraBytes - allocated, extraOperations);
  }
  private commitCapacityReservation(
    record: RuntimeRecord,
    reservation?: CapacityReservationCommit,
  ) {
    if (!reservation) return;
    const remaining = reservation.remaining(record);
    if (remaining === undefined) return;
    if (remaining === 0) this.capacityReservations.delete(reservation.operationId);
    else this.capacityReservations.set(reservation.operationId, remaining);
  }
  private receiptReservation(
    operation: RuntimeOperation,
    result: unknown,
  ): CapacityReservationCommit {
    return {
      operationId: operation.operationId,
      remaining: (record) => {
        const saved = record.operations.find(
          (candidate) => candidate.operationId === operation.operationId,
        );
        if (saved?.state === "CLOSED") return 0;
        if (saved?.state !== "CONFIRMED" || !same(saved.result, result)) return undefined;
        return ["claim", "start-intent", "lease"].includes(operation.action) ? 65536 : 0;
      },
    };
  }
  private snapshotReservation(
    operation: RuntimeOperation,
    snapshot: AttemptSnapshot,
    journalId: string,
  ): CapacityReservationCommit {
    return {
      operationId: operation.operationId,
      remaining: (record) => {
        const saved = record.operations.find(
          (candidate) => candidate.operationId === operation.operationId,
        );
        if (saved?.state === "CLOSED") return 0;
        if (saved?.state !== "CONFIRMED" || !same(saved.result, snapshot)) return undefined;
        return same(this.journal(journalId, record).snapshot, snapshot) ? 0 : undefined;
      },
    };
  }
  private reservedAction(action: DeviceAction, body: Body) {
    return (
      ["complete", "observe", "interrupt-ack"].includes(action) ||
      (action === "ready" &&
        !body.reportedReady &&
        !this.ordinaryReadiness.has(String(body.operationId)))
    );
  }
  private responseGrowth(action: DeviceAction) {
    // claim/start/lease receipts are stored twice: durable response and refreshed snapshot.
    if (["claim", "start-intent", "lease"].includes(action)) return 2 * 65536;
    if (action === "question" || action === "ready") return 1024;
    return 2048;
  }
  private async compactJournal(force = false) {
    this.check();
    if (this.active || this.toolOpen) throw new RuntimeError("RUNTIME_BUSY");
    await this.readyWork;
    if (!(await this.admission.drain(this.options.drainTimeoutMs ?? 2000)))
      throw new RuntimeError("RUNTIME_BUSY");
    this.check();
    const job = this.mutations.then(async () => {
      this.check();
      await this.store.drainWrites();
      const needsCompaction =
        force ||
        this.record.operations.length > 768 ||
        this.record.attempts.length > 128 ||
        Buffer.byteLength(JSON.stringify(this.record)) > 256 * 1024;
      if (!needsCompaction) return;
      this.record = await this.store.compact(this.record, this.check);
      this.check();
      this.archivedLast = await this.store.lastAttempt(this.record);
      this.check();
    });
    this.mutations = job.catch(() => {});
    await job;
  }
  private async admitExecution() {
    await this.compactJournal();
    try {
      assertRuntimeCapacity(this.record, true);
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "RUNTIME_CAPACITY") throw error;
      await this.compactJournal(true);
      assertRuntimeCapacity(this.record, true);
    }
  }
  private async profileState(guard = this.check): Promise<ConnectorState> {
    const deadline = performance.now() + 2000;
    for (;;) {
      guard();
      try {
        return await this.profile.transaction(async () => {
          guard();
          let state = await this.profile.read();
          guard();
          if (!state) throw new RuntimeError("AUTHORITY_LOST");
          if (state.pending?.action === "rotate") {
            await this.connections.rotate(guard);
            guard();
            state = await this.profile.read();
            guard();
          }
          const ownReplacement =
            state?.pending?.action === "replace" &&
            state.pending.body.operationId === this.record?.preparation?.operationId;
          if (!state || (state.pending && !ownReplacement) || state.registration)
            throw new RuntimeError("AUTHORITY_LOST");
          scopeOf(state, this.store.agentId, this.client.origin);
          if (state.credential) this.secrets.add(state.credential);
          return state;
        }, guard);
      } catch (error) {
        // Existing profile locks refuse concurrent admission with FORBIDDEN; use only a bounded retry.
        if (
          !(error instanceof ConnectionError && error.code === "FORBIDDEN") ||
          performance.now() >= deadline
        )
          throw error;
        await delay(20, this.admission.signal);
        guard();
      }
    }
  }
  private async credential(expected: RuntimeScope, guard = this.check) {
    const state = await this.profileState(guard);
    guard();
    const current = scopeOf(state, this.store.agentId, this.client.origin);
    if (!same(current, expected)) throw new RuntimeError("AUTHORITY_LOST");
    return state.credential!;
  }
  private deadline() {
    return this.active
      ? Math.min(
          Date.parse(this.active.attempt.leaseExpiresAt),
          Date.parse(this.active.attempt.payload.deadline),
        )
      : Date.now() + 10000;
  }
  private async workflow(
    action: DeviceAction,
    body: Body,
    expected = this.record.scope,
    guard = this.check,
  ): Promise<unknown> {
    guard();
    const pinned = validateBody(action, body);
    const secret = await this.credential(expected, guard);
    guard();
    if (Date.now() >= this.deadline()) throw new RuntimeError("AUTHORITY_LOST");
    const timeout = () => Math.max(1, Math.min(10000, this.deadline() - Date.now()));
    try {
      const result = await this.client.call(action, pinned, secret, timeout());
      guard();
      if (Date.now() >= this.deadline()) throw new RuntimeError("AUTHORITY_LOST");
      return result;
    } catch (error) {
      guard();
      if (
        error instanceof WorkflowError &&
        error.code === "UNAVAILABLE" &&
        ["ready", "poll", "lease"].includes(action)
      ) {
        await delay(
          Math.min(100, Math.max(1, this.deadline() - Date.now())),
          this.admission.signal,
        );
        guard();
        const current = await this.credential(expected, guard);
        guard();
        if (Date.now() >= this.deadline()) throw new RuntimeError("AUTHORITY_LOST");
        const result = await this.client.call(action, pinned, current, timeout());
        guard();
        if (Date.now() >= this.deadline()) throw new RuntimeError("AUTHORITY_LOST");
        return result;
      }
      if (
        !(error instanceof WorkflowError) ||
        !["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code)
      )
        throw error;
      this.admission.pause();
      try {
        const recovered = await this.credential(expected, guard);
        guard();
        if (recovered === secret || Date.now() >= this.deadline())
          throw new RuntimeError("AUTHORITY_LOST");
        // Same action/body/operation ID, once, within the unchanged scope/epoch lease.
        const result = await this.client.call(action, pinned, recovered, timeout());
        guard();
        if (Date.now() >= this.deadline()) throw new RuntimeError("AUTHORITY_LOST");
        return result;
      } catch {
        throw new RuntimeError("AUTHORITY_LOST");
      } finally {
        if (!this.admission.closed) this.admission.resume();
      }
    }
  }
  private base() {
    return {
      protocol: 1,
      agentId: this.record.scope.agentId,
      bindingEpoch: this.record.scope.bindingEpoch,
    };
  }
  private identity(a: AttemptJournal) {
    if (!a.snapshot) throw new RuntimeError("UNKNOWN");
    return {
      ...this.base(),
      requestId: a.requestId,
      attemptId: a.snapshot.attemptId,
      fence: a.snapshot.fence,
    };
  }
  private journalKey(a: AttemptJournal) {
    return a.claimOperationId ?? a.requestId;
  }
  private journal(key: string, record = this.record) {
    const matches = record.attempts.filter(
      (a) => a.claimOperationId === key || (!a.claimOperationId && a.requestId === key),
    );
    if (matches.length !== 1) throw new RuntimeError("UNKNOWN");
    return matches[0];
  }
  private attemptJournal(
    attempt: Pick<AttemptSnapshot, "requestId" | "attemptId" | "fence" | "bindingEpoch">,
    record = this.record,
  ) {
    const matches = record.attempts.filter(
      (a) =>
        a.requestId === attempt.requestId &&
        a.scope.bindingEpoch === attempt.bindingEpoch &&
        a.snapshot?.attemptId === attempt.attemptId &&
        a.snapshot.fence === attempt.fence,
    );
    if (matches.length !== 1) throw new RuntimeError("UNKNOWN");
    return matches[0];
  }
  private operationJournal(op: RuntimeOperation) {
    if (op.action !== "claim") return this.attemptJournal(op.body as unknown as AttemptSnapshot);
    const direct = this.record.attempts.find((a) => a.claimOperationId === op.operationId);
    if (direct) return direct;
    const legacy = this.record.attempts.filter(
      (a) =>
        !a.claimOperationId &&
        a.requestId === op.body.requestId &&
        a.scope.bindingEpoch === op.body.bindingEpoch,
    );
    if (
      legacy.length !== 1 ||
      this.record.operations.filter(
        (o) =>
          o.action === "claim" &&
          o.body.requestId === op.body.requestId &&
          o.body.bindingEpoch === op.body.bindingEpoch,
      ).length !== 1
    )
      throw new RuntimeError("UNKNOWN");
    return legacy[0];
  }
  private async operation(
    action: DeviceAction,
    fields: Body,
    operationId = randomUUID(),
    guard = this.check,
  ): Promise<RuntimeOperation> {
    guard();
    const body = validateBody(action, { ...this.base(), ...fields, operationId });
    const payloadHash = digest(stableJson({ action, body }));
    const prior = this.record.operations.find((o) => o.operationId === operationId);
    if (prior) {
      if (prior.action !== action || prior.payloadHash !== payloadHash || !same(prior.body, body))
        throw new RuntimeError("INVALID_RUNTIME");
      return prior;
    }
    const operation: RuntimeOperation = {
      operationId,
      action,
      body,
      payloadHash,
      state: "PENDING",
      result: null,
    };
    const reserved = this.reservedAction(action, body);
    if (!reserved) this.capacityReservations.set(operationId, this.responseGrowth(action));
    try {
      await this.mutate(
        "operation-intent",
        (record) => {
          pruneConfirmedReady(record);
          record.operations.push(operation);
          if (
            record.operations.length > 1024 ||
            Buffer.byteLength(JSON.stringify(record)) > 2 * 1024 * 1024
          )
            throw new RuntimeError("RUNTIME_CAPACITY");
          if (!reserved) this.assertOrdinaryCapacity(record);
        },
        guard,
      );
      guard();
      return operation;
    } catch (error) {
      this.capacityReservations.delete(operationId);
      throw error;
    }
  }
  private async transmit(
    operation: RuntimeOperation,
    guard = this.check,
    received?: (result: unknown) => void,
  ): Promise<unknown> {
    guard();
    const current = this.record.operations.find((o) => o.operationId === operation.operationId);
    if (
      !current ||
      !same(current.body, operation.body) ||
      current.action !== operation.action ||
      current.payloadHash !== operation.payloadHash
    )
      throw new RuntimeError("INVALID_RUNTIME");
    if (current.state === "CONFIRMED") {
      received?.(current.result);
      guard();
      return current.result;
    }
    if (current.state === "CLOSED") throw new RuntimeError("RUNTIME_CLOSED");
    if (current.state !== "TRANSMITTED")
      await this.mutate(
        "operation-transmitted",
        (record) => {
          record.operations.find((o) => o.operationId === operation.operationId)!.state =
            "TRANSMITTED";
        },
        guard,
      );
    if (
      !this.reservedAction(operation.action, operation.body) &&
      !this.capacityReservations.has(operation.operationId)
    ) {
      this.capacityReservations.set(operation.operationId, this.responseGrowth(operation.action));
      this.assertOrdinaryCapacity();
    }
    guard();
    const result = await this.workflow(operation.action, operation.body, this.record.scope, guard);
    guard();
    projectResponse(operation.action, result);
    const response = result as Record<string, unknown>,
      body = operation.body;
    if (
      operation.action === "ready" &&
      (response.agentId !== body.agentId ||
        response.bindingEpoch !== body.bindingEpoch ||
        response.reportedReady !== body.reportedReady)
    )
      throw new RuntimeError("AUTHORITY_LOST");
    if (["claim", "start-intent", "lease"].includes(operation.action)) {
      if (
        response.requestId !== body.requestId ||
        response.agentId !== body.agentId ||
        response.bindingEpoch !== body.bindingEpoch ||
        (operation.action !== "claim" &&
          (response.attemptId !== body.attemptId || response.fence !== body.fence))
      )
        throw new RuntimeError("AUTHORITY_LOST");
    }
    if (
      operation.action === "question" &&
      response.cycleId !== this.operationJournal(operation).snapshot?.payload.cycleId
    )
      throw new RuntimeError("AUTHORITY_LOST");
    if (
      ["complete", "observe"].includes(operation.action) &&
      (response.requestId !== body.requestId ||
        response.attemptId !== body.attemptId ||
        response.terminal !== body.terminal)
    )
      throw new RuntimeError("AUTHORITY_LOST");
    if (
      operation.action === "interrupt-ack" &&
      (response.controlId !== body.controlId ||
        response.requestId !== body.requestId ||
        response.attemptId !== body.attemptId ||
        response.fence !== body.fence)
    )
      throw new RuntimeError("AUTHORITY_LOST");
    received?.(result);
    guard();
    const reservation = this.receiptReservation(operation, result);
    await this.mutate(
      "operation-receipt",
      (record) => {
        const o = record.operations.find((o) => o.operationId === operation.operationId)!;
        if (o.state !== "CLOSED") {
          o.state = "CONFIRMED";
          o.result = result;
        }
        pruneConfirmedReady(record);
        if (!this.reservedAction(operation.action, operation.body))
          this.assertOrdinaryCapacity(record, 0, 0, reservation);
      },
      guard,
      reservation,
    );
    guard();
    return result;
  }
  private async poll() {
    const result = projectPoll(await this.workflow("poll", this.base()));
    this.check();
    if (
      result.roomId !== this.record.scope.roomId ||
      result.agentId !== this.record.scope.agentId ||
      result.bindingEpoch !== this.record.scope.bindingEpoch
    )
      throw new RuntimeError("AUTHORITY_LOST");
    return result;
  }
  private observeRoom(poll: PollSnapshot) {
    // An older concurrent response cannot re-enable a scope already observed paused.
    if (
      !this.roomPoll ||
      poll.roomRevision > this.roomPoll.revision ||
      (poll.roomRevision === this.roomPoll.revision &&
        (poll.roomMode !== "ACTIVE" || this.roomPoll.mode === "ACTIVE"))
    )
      this.roomPoll = { revision: poll.roomRevision, mode: poll.roomMode };
  }
  private async ready(reportedReady: boolean, guard = this.check, finalReadiness = false) {
    guard();
    const operationId = randomUUID();
    if (!finalReadiness) this.ordinaryReadiness.add(operationId);
    try {
      const op = await this.operation("ready", { reportedReady }, operationId, guard);
      guard();
      return await this.transmit(op, guard);
    } finally {
      this.ordinaryReadiness.delete(operationId);
    }
  }
  private async refreshReady(guard = this.check) {
    guard();
    while (this.readyWork) {
      await this.readyWork;
      guard();
    }
    let hasCapacity = true;
    try {
      assertRuntimeCapacity(this.record, true);
      this.assertOrdinaryCapacity();
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "RUNTIME_CAPACITY") throw error;
      hasCapacity = false;
    }
    const reportedReady = this.roomPoll?.mode === "ACTIVE" && hasCapacity;
    if (this.lastReadyValue === reportedReady && Date.now() - this.lastReadyAt < 15000) return;
    const live = () => {
      guard();
      if (reportedReady && this.roomPoll?.mode !== "ACTIVE")
        throw new RuntimeError("AUTHORITY_LOST");
    };
    const job = this.admission.track(async () => {
      live();
      const started = Date.now();
      await this.ready(reportedReady, live, !hasCapacity);
      live();
      await this.mutate(
        reportedReady ? "ready" : "not-ready",
        (record) => {
          record.ready = reportedReady;
        },
        live,
      );
      live();
      this.lastReadyAt = started;
      this.lastReadyValue = reportedReady;
    });
    this.readyWork = job;
    try {
      await job;
      guard();
    } finally {
      if (this.readyWork === job) this.readyWork = undefined;
    }
  }
  private assertIdle(poll: PollSnapshot) {
    if (
      poll.queuedRequest ||
      (poll.attempt &&
        !["COMPLETED", "FAILED", "INTERRUPTED", "ABANDONED"].includes(poll.attempt.state)) ||
      poll.control?.state === "REQUESTED" ||
      unresolvedRuntime(this.record)
    )
      throw new RuntimeError("RUNTIME_BUSY");
  }
  private async underBinding<T>(run: (recovered: boolean) => Promise<T>): Promise<T> {
    return this.store.locked(async (recovered) => {
      this.lockHeld = true;
      try {
        const saved = await this.store.read();
        this.check();
        if (saved) {
          this.record = saved;
          this.archivedLast = await this.store.lastAttempt(saved);
          this.check();
        }
        const state = await this.profileState();
        this.check();
        const scope = scopeOf(state, this.store.agentId, this.client.origin);
        this.record = saved ?? runtimeRecord(scope);
        // A replacement receipt can have advanced the profile while its local preparation is unfinished.
        if (
          !same(this.record.scope, scope) &&
          !(
            this.record.preparation &&
            scope.bindingEpoch === this.record.preparation.previousEpoch + 1 &&
            same({ ...scope, bindingEpoch: this.record.scope.bindingEpoch }, this.record.scope)
          )
        )
          throw new RuntimeError("AUTHORITY_LOST");
        if (!saved) await this.store.write(this.record, this.check);
        if (recovered) await this.markUnresolvedUnknown("UNKNOWN");
        return await run(recovered);
      } finally {
        await this.shutdown();
        this.retired = true;
        this.lockHeld = false;
      }
    });
  }
  async prepare(input: PrepareRuntime) {
    if (!input.confirmed) throw new RuntimeError("INVALID_RUNTIME");
    return this.underBinding(async () => {
      const prepare = async () => {
        if (this.record.preparation) {
          if (
            !this.record.preparation.candidate ||
            !["CANDIDATE", "REPLACE_PENDING"].includes(this.record.preparation.state)
          )
            throw new RuntimeError("UNKNOWN");
          return this.store.sessionLocked(this.record.preparation.candidate.threadId, async () => {
            try {
              return await this.finishPreparation();
            } finally {
              await this.shutdown();
            }
          });
        }
        const poll = await this.poll();
        this.assertIdle(poll);
        await this.ready(false);
        this.check();
        const state = await this.profileState();
        this.check();
        const mapping = state.mappings.find((m) => m.agentId === this.store.agentId)!;
        const policy = await RuntimeFilePolicy.select(
          input.root ?? mapping.root,
          input.files,
          this.check,
        );
        this.check();
        if (policy.root.path !== mapping.root) throw new RuntimeError("CONTEXT_UNCONFIRMED");
        const capabilities = await this.admission.wait(() =>
          this.adapter.capabilities(policy.root.path, this.check),
        );
        this.check();
        const requested = selectSettings(capabilities, input.choice),
          handoff = publicText(
            input.handoff,
            [policy.root.path, mapping.nativeSessionId, ...this.secrets],
            true,
          );
        const settings: RuntimeSettings = {
          provider: "codex",
          requested,
          capabilities,
          files: [...policy.files],
          handoff,
          publicScopeConfirmed: true,
          autoQuestionsConfirmed: input.autoQuestionsConfirmed,
        };
        const generation = randomUUID(),
          operationId = randomUUID();
        await this.mutate("prepare-intent", (record) => {
          record.ready = false;
          record.preparation = {
            operationId,
            previousEpoch: record.scope.bindingEpoch,
            generation,
            settings,
            candidate: null,
            state: "PROVIDER_PENDING",
          };
        });
        this.check();
        const epoch = this.record.scope.bindingEpoch + 1;
        const created = async (context: OwnedContext) => {
          this.check();
          if (
            context.ownership !== "CONNECTOR_CREATED" ||
            context.generation !== generation ||
            context.epoch !== epoch ||
            !same(context.root, policy.root) ||
            context.level !== "L1" ||
            !Array.isArray(context.ownedTurns) ||
            context.ownedTurns.length
          )
            throw new RuntimeError("CONTEXT_UNCONFIRMED");
          await this.mutate("prepare-created", (record) => {
            if (
              record.preparation?.state !== "PROVIDER_PENDING" ||
              record.preparation.candidate !== null
            )
              throw new RuntimeError("UNKNOWN");
            record.preparation.candidate = structuredClone(context);
            record.preparation.state = "PROVIDER_CREATED";
          });
          this.check();
        };
        const context = await this.admission.wait(() =>
          this.adapter.prepare(policy.root, settings, generation, epoch, this.check, created),
        );
        this.check();
        const recorded = (this.record as RuntimeRecord).preparation;
        if (recorded?.state !== "PROVIDER_CREATED" || !same(recorded.candidate, context))
          throw new RuntimeError("UNKNOWN");
        await this.mutate("prepare-candidate", (record) => {
          record.preparation!.state = "CANDIDATE";
        });
        this.check();
        return this.store.sessionLocked(context.threadId, async () => {
          try {
            return await this.finishPreparation();
          } finally {
            await this.shutdown();
          }
        });
      };
      if (this.record.context)
        return this.store.sessionLocked(this.record.context.threadId, async () => {
          try {
            return await prepare();
          } finally {
            await this.shutdown();
          }
        });
      return prepare();
    });
  }
  private async finishPreparation() {
    const preparation = this.record.preparation;
    if (!preparation?.candidate || !["CANDIDATE", "REPLACE_PENDING"].includes(preparation.state))
      throw new RuntimeError("UNKNOWN");
    const context = preparation.candidate;
    const guard = this.check;
    await new RuntimeFilePolicy(context.root, preparation.settings.files).assertUnchanged(guard);
    guard();
    await this.admission.wait(() => this.adapter.validate(context, preparation.settings, guard));
    guard();
    // Recovery never silently creates another thread after ambiguous provider preparation.
    const state = await this.profileState();
    guard();
    const current = scopeOf(state, this.store.agentId, this.client.origin);
    if (current.bindingEpoch === preparation.previousEpoch) {
      const poll = await this.poll();
      guard();
      if (
        poll.queuedRequest ||
        (poll.attempt &&
          !["COMPLETED", "FAILED", "INTERRUPTED", "ABANDONED"].includes(poll.attempt.state))
      )
        throw new RuntimeError("RUNTIME_BUSY");
      const bindings = await this.connections.bindings(state.credential!);
      guard();
      const binding = bindings.find(
        (b) => b.agentId === this.store.agentId && b.bindingEpoch === preparation.previousEpoch,
      );
      if (!binding) throw new RuntimeError("AUTHORITY_LOST");
      await this.mutate("replace-intent", (record) => {
        record.preparation!.state = "REPLACE_PENDING";
      });
      guard();
      await this.profile.transaction(async () => {
        guard();
        const live = await this.profile.read();
        guard();
        if (
          !live ||
          !same(scopeOf(live, this.store.agentId, this.client.origin), this.record.scope)
        )
          throw new RuntimeError("AUTHORITY_LOST");
        if (
          live.pending &&
          (live.pending.action !== "replace" ||
            live.pending.body.operationId !== preparation.operationId)
        )
          throw new RuntimeError("RUNTIME_BUSY");
        await this.connections.replace({
          agentId: this.store.agentId,
          root: context.root.path,
          nativeSessionId: context.threadId,
          repositoryAlias: binding.repositoryAlias,
          sessionAlias: binding.sessionAlias,
          confirmed: true,
          operationId: preparation.operationId,
          metadata: {
            repositoryAlias: binding.repositoryAlias,
            branch: binding.branch,
            commit: binding.commit,
            dirty: binding.dirty,
          },
          assertLive: guard,
        });
        guard();
      });
      guard();
    } else if (
      current.bindingEpoch !== preparation.previousEpoch + 1 ||
      preparation.state !== "REPLACE_PENDING"
    )
      throw new RuntimeError("AUTHORITY_LOST");
    const finalized = await this.profileState();
    guard();
    const scope = scopeOf(finalized, this.store.agentId, this.client.origin);
    const mapping = finalized.mappings.find((m) => m.agentId === this.store.agentId)!;
    if (
      scope.bindingEpoch !== context.epoch ||
      mapping.nativeSessionId !== context.threadId ||
      mapping.root !== context.root.path
    )
      throw new RuntimeError("AUTHORITY_LOST");
    await this.mutate("prepare-finalize", (record) => {
      record.scope = scope;
      record.settings = preparation.settings;
      record.context = context;
      record.preparation = null;
      record.ready = false;
    });
    return this.publicStatus();
  }
  private publicStatus() {
    const last = this.record.lastArchive ? this.archivedLast : this.record.attempts.at(-1);
    return {
      state: this.record.preparation
        ? "PREPARING"
        : (last?.state ?? (this.record.context ? "PREPARED" : "UNPREPARED")),
      provider: "codex",
      bindingEpoch: this.record.scope.bindingEpoch,
      ready: this.record.ready,
      readinessVerification: "reported",
      contextLevel: this.record.context?.level ?? null,
      requested: this.record.settings?.requested ?? null,
      observation: last?.terminal?.observation ?? null,
      terminal: last?.terminal?.terminal ?? null,
      textProof: last?.terminal?.textProof ?? null,
      adoption: last?.receipt?.adoption ?? null,
      error: last?.reason ?? null,
    };
  }
  async status() {
    const record = await this.store.read();
    if (!record) return { state: "UNPREPARED", ready: false };
    this.record = record;
    this.archivedLast = await this.store.lastAttempt(record);
    return this.publicStatus();
  }
  private assertContext() {
    if (
      !this.record.context ||
      !this.record.settings ||
      this.record.preparation ||
      this.record.context.ownership !== "CONNECTOR_CREATED" ||
      this.record.context.epoch !== this.record.scope.bindingEpoch
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  async run(options: { once?: boolean; signal?: AbortSignal } = {}) {
    return this.underBinding(async () => {
      this.assertContext();
      return this.store.sessionLocked(this.record.context!.threadId, async (recovered) => {
        const onAbort = () => this.stop();
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) this.stop();
        try {
          if (recovered) await this.markUnresolvedUnknown("UNKNOWN");
          await this.compactJournal();
          await this.recover();
          this.check();
          if (unresolvedRuntime(this.record)) return this.publicStatus();
          await this.admission.wait(() =>
            this.adapter.validate(this.record.context!, this.record.settings!, this.check),
          );
          this.check();
          const initial = await this.poll();
          this.check();
          if (
            initial.attempt &&
            !["ABANDONED", "COMPLETED", "FAILED", "INTERRUPTED"].includes(initial.attempt.state)
          )
            throw new RuntimeError("UNKNOWN");
          this.observeRoom(initial);
          await this.refreshReady();
          this.check();
          for (;;) {
            this.check();
            const poll = await this.poll();
            this.check();
            this.observeRoom(poll);
            if (poll.roomMode !== "ACTIVE") {
              await this.refreshReady();
              this.check();
              if (options.once) return this.publicStatus();
            } else if (poll.queuedRequest) {
              await this.execute(poll.queuedRequest);
              if (
                options.once ||
                this.record.attempts.some((a) => !["UPLOADED", "NOT_STARTED"].includes(a.state))
              )
                return this.publicStatus();
            } else if (options.once) return this.publicStatus();
            await this.refreshReady();
            this.check();
            await delay(this.options.pollIntervalMs ?? 2000, this.admission.signal);
          }
        } finally {
          options.signal?.removeEventListener("abort", onAbort);
          // Session locks cannot be released until admitted work has drained or been permanently closed.
          await this.shutdown();
        }
      });
    });
  }
  private live(requestId: string, requireNative = false) {
    this.check();
    if (requireNative) this.admission.assertTool();
    const a = this.journal(requestId);
    const active = this.active;
    if (
      !active ||
      a.scope.bindingEpoch !== this.record.scope.bindingEpoch ||
      a.generation !== this.record.context?.generation ||
      !same(a.scope, this.record.scope) ||
      !a.snapshot ||
      Date.parse(a.snapshot.leaseExpiresAt) <= Date.now() ||
      Date.parse(a.snapshot.payload.deadline) <= Date.now() ||
      ["UNKNOWN", "TERMINAL", "UPLOADED", "NOT_STARTED"].includes(a.state) ||
      (requireNative && (!this.toolOpen || !a.native))
    )
      throw new RuntimeError("TOOL_REJECTED");
    matchAttempt(a.snapshot, active.attempt);
  }
  private async execute(payload: RequestPayload) {
    this.check();
    if (
      payload.agentId !== this.record.scope.agentId ||
      payload.bindingEpoch !== this.record.scope.bindingEpoch ||
      Date.parse(payload.deadline) <= Date.now()
    )
      throw new RuntimeError("AUTHORITY_LOST");
    try {
      await this.admitExecution();
      this.check();
    } catch (error) {
      if (!(error instanceof RuntimeError) || error.code !== "RUNTIME_CAPACITY") throw error;
      await this.mutate("not-ready", (record) => {
        record.ready = false;
      });
      if (this.record.operations.length < 1024) {
        try {
          await this.ready(false, this.check, true);
        } catch {
          /* Capacity refusal keeps all original evidence. */
        }
      }
      throw error;
    }
    const requestId = payload.requestId,
      claimOperationId = randomUUID(),
      journalId = claimOperationId;
    await this.mutate("claim-intent", (record) => {
      delete record.lastArchive;
      record.attempts.push({
        requestId,
        claimOperationId,
        scope: structuredClone(record.scope),
        generation: record.context!.generation,
        state: "CLAIM_PENDING",
        snapshot: null,
        native: null,
        terminal: null,
        receipt: null,
        reason: null,
        toolCalls: [],
      });
    });
    try {
      const claim = await this.operation("claim", { requestId }, claimOperationId);
      const snapshot = (await this.transmit(claim)) as AttemptSnapshot;
      if (
        !same(snapshot.payload, payload) ||
        snapshot.state !== "LEASED" ||
        Date.parse(snapshot.leaseExpiresAt) <= Date.now()
      )
        throw new RuntimeError("AUTHORITY_LOST");
      await this.mutate(
        "claimed",
        (record) => {
          const a = this.journal(journalId, record);
          a.snapshot = snapshot;
          a.state = "CLAIMED";
        },
        this.check,
        this.snapshotReservation(claim, snapshot, journalId),
      );
      const authority: AttemptAuthority = {
        scope: structuredClone(this.record.scope),
        context: structuredClone(this.record.context!),
        attempt: snapshot,
        signal: this.admission.signal,
        assertLive: () => this.live(journalId),
        ack: async (threadId, turnId) => {
          this.live(journalId);
          if (
            threadId !== authority.context.threadId ||
            authority.context.ownedTurns.some((t) => t.turnId === turnId)
          )
            throw new RuntimeError("UNKNOWN");
          await this.mutate(
            "native-ack",
            (record) => {
              const a = this.journal(journalId, record);
              if (a.state !== "PROVIDER_INTENT") throw new RuntimeError("UNKNOWN");
              a.native = { threadId, turnId };
              a.state = "ACKNOWLEDGED";
            },
            () => this.live(journalId),
          );
          this.live(journalId);
          this.toolOpen = true;
        },
        tool: async (call) => this.admission.track(() => this.tool(journalId, call)),
      };
      this.active = authority;
      const monitorController = new AbortController();
      let publication: Promise<void> | undefined;
      const monitor = this.monitor(authority, monitorController.signal, () => publication).catch(
        (error) => {
          this.lossReason = code(error);
          this.stop();
          return error;
        },
      );
      try {
        await this.mutate("server-intent", (record) => {
          this.journal(journalId, record).state = "SERVER_INTENT_PENDING";
        });
        const start = await this.operation("start-intent", this.identity(this.journal(journalId)));
        const intent = (await this.transmit(start)) as AttemptSnapshot;
        matchAttempt(intent, snapshot);
        if (intent.state !== "EXECUTING" || !intent.startIntentAt)
          throw new RuntimeError("AUTHORITY_LOST");
        await this.mutate(
          "server-intent-confirmed",
          (record) => {
            const a = this.journal(journalId, record);
            a.snapshot = intent;
            a.state = "SERVER_INTENT_CONFIRMED";
          },
          this.check,
          this.snapshotReservation(start, intent, journalId),
        );
        authority.attempt = intent;
        const evidence = await this.admission.wait(() =>
          this.adapter.execute(authority, this.record.settings!, payload, async () => {
            this.live(journalId);
            this.assertOrdinaryCapacity();
            await this.mutate(
              "provider-intent",
              (record) => {
                const a = this.journal(journalId, record);
                if (a.state !== "SERVER_INTENT_CONFIRMED") throw new RuntimeError("UNKNOWN");
                a.state = "PROVIDER_INTENT";
              },
              () => this.live(journalId),
            );
            this.live(journalId);
          }),
        );
        this.check();
        this.toolOpen = false;
        await this.persistTerminal(journalId, evidence);
        this.check();
        publication = this.publish(journalId, "complete", () => monitorController.abort());
        await publication;
      } finally {
        monitorController.abort();
        await monitor;
        this.toolOpen = false;
        this.active = undefined;
        this.calls.clear();
        this.capacityReservations.clear();
      }
    } catch (error) {
      this.toolOpen = false;
      if (!this.retired) await this.markUnresolvedUnknown(this.lossReason ?? code(error));
    }
  }
  private async monitor(
    authority: AttemptAuthority,
    signal: AbortSignal,
    publication: () => Promise<void> | undefined,
  ) {
    let failure: unknown;
    // Readiness IPC cannot delay lease/control cadence. Both jobs are tracked until drained or closed.
    const jobs = [
      () => this.monitorAttempt(authority, signal, publication),
      () => this.monitorReady(authority, signal),
    ].map((run) =>
      this.admission.wait(run).catch(async (error) => {
        // Ordinary journal growth cannot cancel an already durable terminal's exact outbox.
        if (
          error instanceof RuntimeError &&
          error.code === "RUNTIME_CAPACITY" &&
          this.attemptJournal(authority.attempt).terminal
        ) {
          const pending = publication();
          if (pending) await pending;
          return;
        }
        if (
          !signal.aborted &&
          this.attemptJournal(authority.attempt).state !== "UPLOADED" &&
          failure === undefined
        ) {
          failure = error;
          this.lossReason = code(error);
          this.stop();
        }
      }),
    );
    await Promise.all(jobs);
    if (failure !== undefined) throw failure;
  }
  private monitorGuard(authority: AttemptAuthority, signal: AbortSignal) {
    return () => {
      this.check();
      if (signal.aborted) throw new RuntimeError("RUNTIME_CLOSED");
      const a = this.attemptJournal(authority.attempt);
      if (a.state === "UPLOADED") throw new RuntimeError("RUNTIME_CLOSED");
      if (
        this.active !== authority ||
        !same(authority.scope, this.record.scope) ||
        a.generation !== this.record.context?.generation ||
        !a.snapshot ||
        a.state === "UNKNOWN" ||
        Date.parse(a.snapshot.leaseExpiresAt) <= Date.now() ||
        Date.parse(a.snapshot.payload.deadline) <= Date.now()
      )
        throw new RuntimeError("AUTHORITY_LOST");
      matchAttempt(a.snapshot, authority.attempt);
    };
  }
  private async monitorReady(authority: AttemptAuthority, signal: AbortSignal) {
    const guard = this.monitorGuard(authority, signal);
    while (!signal.aborted && !this.admission.closed) {
      await delay(Math.min(this.options.pollIntervalMs ?? 2000, 2000), signal);
      if (signal.aborted) return;
      this.check();
      if (this.attemptJournal(authority.attempt).state === "UPLOADED") return;
      if (
        Date.now() - this.lastReadyAt < 15000 &&
        this.lastReadyValue === (this.roomPoll?.mode === "ACTIVE")
      )
        continue;
      guard();
      const poll = await this.poll();
      this.check();
      if (signal.aborted || this.attemptJournal(authority.attempt).state === "UPLOADED") return;
      guard();
      const a = this.attemptJournal(authority.attempt);
      if (poll.attempt) {
        matchAttempt(poll.attempt, a.snapshot!);
        if (
          !["LEASED", "EXECUTING"].includes(poll.attempt.state) &&
          poll.attempt.state !== a.terminal?.terminal
        )
          throw new RuntimeError("AUTHORITY_LOST");
      } else if (!a.terminal) throw new RuntimeError("AUTHORITY_LOST");
      this.observeRoom(poll);
      await this.refreshReady(guard);
      guard();
    }
  }
  private async monitorAttempt(
    authority: AttemptAuthority,
    signal: AbortSignal,
    publication: () => Promise<void> | undefined,
  ) {
    const guard = this.monitorGuard(authority, signal);
    let lastLease = Date.now();
    while (!signal.aborted && !this.admission.closed) {
      await delay(Math.min(this.options.pollIntervalMs ?? 2000, 2000), signal);
      if (signal.aborted) return;
      this.check();
      const a = this.attemptJournal(authority.attempt);
      if (["UPLOADED"].includes(a.state)) return;
      guard();
      if (Date.parse(a.snapshot!.leaseExpiresAt) <= Date.now())
        throw new RuntimeError("AUTHORITY_LOST");
      if (Date.now() - lastLease >= Math.min(this.options.leaseIntervalMs ?? 6000, 6000)) {
        const lease = await this.operation("lease", this.identity(a), randomUUID(), guard);
        guard();
        let renewed: AttemptSnapshot;
        try {
          renewed = (await this.transmit(lease, guard)) as AttemptSnapshot;
        } catch (error) {
          const pending = publication();
          if (
            !(error instanceof WorkflowError && error.code === "CONFLICT") ||
            !this.journal(this.journalKey(a)).terminal ||
            !pending
          )
            throw error;
          // A lease cannot renew a centrally completed attempt. Only this publication's exact receipt
          // may close the monitor; a conflict alone never proves completion or permits more work.
          try {
            await this.admission.wait(() => pending);
          } catch {
            throw error;
          }
          this.check();
          if (signal.aborted) return;
          throw error;
        }
        guard();
        matchAttempt(renewed, a.snapshot!);
        if (this.journal(this.journalKey(a)).terminal?.terminal === renewed.state) return;
        if (
          !["LEASED", "EXECUTING"].includes(renewed.state) ||
          Date.parse(renewed.leaseExpiresAt) <= Date.now()
        )
          throw new RuntimeError("AUTHORITY_LOST");
        await this.mutate(
          "lease",
          (record) => {
            const current = this.journal(this.journalKey(a), record);
            if (current.snapshot!.state === "EXECUTING" && renewed.state === "LEASED")
              throw new RuntimeError("AUTHORITY_LOST");
            current.snapshot = renewed;
          },
          guard,
          this.snapshotReservation(lease, renewed, this.journalKey(a)),
        );
        guard();
        authority.attempt = renewed;
        lastLease = Date.now();
      }
      const poll = await this.poll();
      guard();
      this.observeRoom(poll);
      if (!poll.attempt) {
        if (this.journal(this.journalKey(a)).terminal) return;
        throw new RuntimeError("AUTHORITY_LOST");
      }
      matchAttempt(poll.attempt, this.journal(this.journalKey(a)).snapshot!);
      const localTerminal = this.journal(this.journalKey(a)).terminal;
      if (localTerminal && poll.attempt.state === localTerminal.terminal) return;
      if (
        !["LEASED", "EXECUTING"].includes(poll.attempt.state) ||
        (poll.roomMode !== "ACTIVE" && !poll.control)
      )
        throw new RuntimeError("AUTHORITY_LOST");
      if (poll.control?.state === "REQUESTED") {
        guard();
        this.toolOpen = false;
        await this.interrupt(authority, poll.control, guard);
        guard();
      }
    }
  }
  private async interrupt(authority: AttemptAuthority, control: Control, guard = this.check) {
    guard();
    const a = this.attemptJournal(authority.attempt);
    if (
      control.requestId !== a.requestId ||
      control.attemptId !== a.snapshot?.attemptId ||
      control.fence !== a.snapshot.fence
    )
      throw new RuntimeError("AUTHORITY_LOST");
    const acknowledged = await this.admission.track(() => {
      guard();
      return this.adapter.interrupt(authority);
    });
    guard();
    if (acknowledged) {
      const prior = this.record.operations.find(
        (o) => o.action === "interrupt-ack" && o.body.controlId === control.controlId,
      );
      const op =
        prior ??
        (await this.operation(
          "interrupt-ack",
          { ...this.identity(a), controlId: control.controlId },
          randomUUID(),
          guard,
        ));
      guard();
      await this.transmit(op, guard);
      guard();
    }
  }
  private denied(a?: AttemptJournal) {
    return [
      this.profile.dir,
      this.store.dir,
      this.record.context?.root.path ?? "",
      this.record.context?.threadId ?? "",
      this.record.context?.generation ?? "",
      a?.native?.turnId ?? "",
      ...(this.record.context?.ownedTurns.map((t) => t.turnId) ?? []),
      ...this.secrets,
    ];
  }
  private async tool(requestId: string, call: ToolCall): Promise<ToolResult> {
    const guard = () => this.live(requestId, true);
    guard();
    const a = this.journal(requestId);
    if (
      !a.native ||
      call.threadId !== a.native.threadId ||
      call.turnId !== a.native.turnId ||
      call.namespace !== scopedNamespace ||
      !call.callId ||
      call.callId.length > 512
    )
      throw new RuntimeError("TOOL_REJECTED");
    const hash = digest(stableJson(call));
    const key = `${requestId}:${call.callId}`;
    const cached = this.calls.get(key);
    if (cached) {
      if (cached.hash !== hash) throw new RuntimeError("TOOL_REJECTED");
      const result = await cached.result;
      guard();
      return result;
    }
    const prior = a.toolCalls.find((c) => c.callId === call.callId);
    if (prior) {
      if (prior.payloadHash !== hash || !prior.result) throw new RuntimeError("TOOL_REJECTED");
      return prior.result;
    }
    const result = this.performTool(requestId, call, hash, guard);
    this.calls.set(key, { hash, result });
    return result;
  }
  private toolReservationBytes(call: ToolCall): number {
    if (call.tool !== "read_workspace_file") return 8192;
    const maximum = 6 * 65536 + 4096;
    if (!exact(call.arguments, ["path"]) || typeof call.arguments.path !== "string") return maximum;
    const path = call.arguments.path;
    const file = this.record.settings!.files.find((candidate) => candidate.path === path);
    if (!file || !Number.isInteger(file.size) || file.size < 0 || file.size > 65536) return maximum;
    return 6 * file.size + 4096;
  }
  private async performTool(
    requestId: string,
    call: ToolCall,
    hash: string,
    guard: () => void,
  ): Promise<ToolResult> {
    guard();
    const a = this.journal(requestId),
      settings = this.record.settings!,
      policy = new RuntimeFilePolicy(this.record.context!.root, settings.files);
    if (a.toolCalls.length >= 256) throw new RuntimeError("RUNTIME_CAPACITY");
    const capacityKey = `tool:${requestId}:${call.callId}`;
    this.capacityReservations.set(capacityKey, this.toolReservationBytes(call));
    try {
      this.assertOrdinaryCapacity(this.record, 0, call.tool === "ask_peer" ? 1 : 0);
    } catch (error) {
      this.capacityReservations.delete(capacityKey);
      throw error;
    }
    try {
      await this.credential(this.record.scope, guard);
      guard();
      await policy.assertUnchanged(guard);
      guard();
      let result: ToolResult;
      if (
        call.tool === "read_workspace_file" &&
        exact(call.arguments, ["path"]) &&
        typeof call.arguments.path === "string"
      ) {
        const text = await policy.read(call.arguments.path, guard);
        guard();
        result = { success: true, contentItems: [{ type: "inputText", text }] };
        await this.mutate(
          "tool-receipt",
          (record) => {
            this.capacityReservations.delete(capacityKey);
            this.journal(requestId, record).toolCalls.push({
              callId: call.callId,
              payloadHash: hash,
              operationId: null,
              result,
            });
          },
          guard,
        );
        guard();
        return result;
      }
      if (
        call.tool !== "ask_peer" ||
        a.snapshot!.payload.requestKind === "PEER" ||
        !settings.autoQuestionsConfirmed ||
        !exact(call.arguments, ["question", "evidence"]) ||
        typeof call.arguments.question !== "string" ||
        call.arguments.question.length > 2000 ||
        !Array.isArray(call.arguments.evidence) ||
        call.arguments.evidence.length < 1 ||
        call.arguments.evidence.length > 4
      )
        throw new RuntimeError("TOOL_REJECTED");
      const question = publicText(call.arguments.question, this.denied(a));
      for (const evidence of call.arguments.evidence) {
        if (
          !exact(evidence, ["path", "startLine", "endLine"]) ||
          typeof evidence.path !== "string" ||
          !Number.isSafeInteger(evidence.startLine) ||
          !Number.isSafeInteger(evidence.endLine) ||
          Number(evidence.startLine) < 1 ||
          Number(evidence.endLine) < Number(evidence.startLine)
        )
          throw new RuntimeError("TOOL_REJECTED");
        const content = await policy.read(evidence.path, guard);
        guard();
        if (Number(evidence.endLine) > content.split("\n").length)
          throw new RuntimeError("TOOL_REJECTED");
      }
      const operationId = randomUUID();
      await this.mutate(
        "question-call-intent",
        (record) => {
          this.journal(requestId, record).toolCalls.push({
            callId: call.callId,
            payloadHash: hash,
            operationId,
            result: null,
          });
        },
        guard,
      );
      guard();
      const op = await this.operation(
        "question",
        { ...this.identity(a), publicText: question, confirmed: true },
        operationId,
        guard,
      );
      guard();
      const receipt = (await this.transmit(op, guard)) as {
        cycleId: string;
        questionId: string | null;
        peerRequestId: string | null;
        accepted: boolean;
      };
      guard();
      if (receipt.cycleId !== a.snapshot!.payload.cycleId) throw new RuntimeError("AUTHORITY_LOST");
      result = {
        success: receipt.accepted,
        contentItems: [
          {
            type: "inputText",
            text: receipt.accepted ? "accepted/pending" : "HUMAN_INPUT_REQUIRED",
          },
        ],
      };
      await this.mutate(
        "question-call-receipt",
        (record) => {
          this.capacityReservations.delete(capacityKey);
          this.journal(requestId, record).toolCalls.find((c) => c.callId === call.callId)!.result =
            result;
        },
        guard,
      );
      guard();
      return result;
    } finally {
      this.capacityReservations.delete(capacityKey);
    }
  }
  private async persistTerminal(requestId: string, evidence: TerminalEvidence, guard = this.check) {
    guard();
    const a = this.journal(requestId);
    if (!a.native || evidence.threadId !== a.native.threadId || evidence.turnId !== a.native.turnId)
      throw new RuntimeError("UNKNOWN");
    const terminal = structuredClone(evidence);
    if (terminal.terminal === "COMPLETED" && terminal.textProof === "FINAL_ANSWER") {
      try {
        terminal.publicText = publicText(terminal.privateText, this.denied(a), true);
      } catch {
        terminal.publicText = "";
        terminal.textProof = "UNCONFIRMED";
      }
    } else terminal.publicText = "";
    await this.mutate(
      "terminal-evidence",
      (record) => {
        const a = this.journal(requestId, record);
        a.terminal = terminal;
        a.state = "TERMINAL";
        a.reason =
          terminal.textProof === "UNCONFIRMED" && terminal.terminal === "COMPLETED"
            ? "PUBLIC_TEXT_REJECTED"
            : null;
        if (!record.context!.ownedTurns.some((t) => t.turnId === terminal.turnId))
          record.context!.ownedTurns.push({ turnId: terminal.turnId, terminal: terminal.terminal });
        record.context!.level = "L2";
      },
      guard,
    );
    guard();
  }
  private async publish(requestId: string, action: "complete" | "observe", received?: () => void) {
    const a = this.journal(requestId);
    if (!a.terminal) throw new RuntimeError("UNKNOWN");
    const prior = this.record.operations.find(
      (o) =>
        o.action === action &&
        o.body.requestId === a.requestId &&
        o.body.attemptId === a.snapshot?.attemptId &&
        o.body.fence === a.snapshot?.fence,
    );
    const op =
      prior ??
      (await this.operation(action, {
        ...this.identity(a),
        terminal: a.terminal.terminal,
        publicText: a.terminal.publicText,
      }));
    const receipt = (await this.transmit(
      op,
      this.check,
      received
        ? (result) => {
            const receipt = result as TerminalReceipt;
            this.check();
            if (
              receipt.requestId !== a.requestId ||
              receipt.attemptId !== a.snapshot?.attemptId ||
              receipt.terminal !== a.terminal!.terminal
            )
              throw new RuntimeError("AUTHORITY_LOST");
            received();
          }
        : undefined,
    )) as TerminalReceipt;
    this.check();
    if (
      receipt.requestId !== a.requestId ||
      receipt.attemptId !== a.snapshot?.attemptId ||
      receipt.terminal !== a.terminal.terminal
    )
      throw new RuntimeError("AUTHORITY_LOST");
    await this.mutate("publication-receipt", (record) => {
      const a = this.journal(requestId, record);
      a.receipt = receipt;
      a.state = "UPLOADED";
      // Their transmission/result stays recorded. A matching central terminal receipt closes future renewal/control work; it does not claim rollback.
      for (const o of record.operations)
        if (
          o.body.requestId === a.requestId &&
          o.body.attemptId === a.snapshot?.attemptId &&
          o.body.fence === a.snapshot?.fence &&
          o.body.attemptId === receipt.attemptId &&
          ["lease", "interrupt-ack"].includes(o.action) &&
          o.state !== "CONFIRMED"
        )
          o.state = "CLOSED";
    });
  }
  private async recoverUnstarted() {
    for (const original of [...this.record.attempts]) {
      this.check();
      let key = this.journalKey(original),
        a = this.journal(key);
      const sealed = a.state === "NOT_STARTED";
      if (
        (sealed && a.unstartedClosure?.kind !== "SERVER_ABANDONED") ||
        ["UPLOADED", "TERMINAL", "PROVIDER_INTENT", "ACKNOWLEDGED", "RUNNING"].includes(a.state) ||
        a.native ||
        a.terminal ||
        a.receipt ||
        a.toolCalls.length ||
        a.snapshot?.startIntentAt != null
      )
        continue;
      const claims = this.record.operations.filter(
        (o) =>
          o.action === "claim" &&
          o.body.requestId === a.requestId &&
          o.body.bindingEpoch === a.scope.bindingEpoch,
      );
      if (!a.claimOperationId) {
        if (claims.length !== 1) continue;
        const claimOperationId = claims[0].operationId;
        await this.mutate("legacy-claim-association", (record) => {
          this.journal(key, record).claimOperationId = claimOperationId;
        });
        this.check();
        key = claimOperationId;
        a = this.journal(key);
      }
      const claim = claims.find((o) => o.operationId === a.claimOperationId);
      const known =
        a.snapshot ??
        (a.unstartedClosure?.kind === "SERVER_ABANDONED"
          ? a.unstartedClosure.snapshot
          : claim?.state === "CONFIRMED"
            ? (claim.result as AttemptSnapshot)
            : null);
      const starts = this.record.operations.filter(
        (o) =>
          o.action === "start-intent" &&
          o.body.requestId === a.requestId &&
          o.body.bindingEpoch === a.scope.bindingEpoch &&
          (!known || (o.body.attemptId === known.attemptId && o.body.fence === known.fence)),
      );
      const leases = this.record.operations.filter(
        (o) =>
          o.action === "lease" &&
          ["PENDING", "TRANSMITTED"].includes(o.state) &&
          o.body.agentId === a.scope.agentId &&
          o.body.requestId === a.requestId &&
          o.body.bindingEpoch === a.scope.bindingEpoch &&
          known &&
          o.body.attemptId === known.attemptId &&
          o.body.fence === known.fence,
      );
      if (sealed && !leases.length) continue;
      if (
        known?.startIntentAt != null ||
        starts.some(
          (o) => o.state === "CONFIRMED" && (o.result as AttemptSnapshot).startIntentAt !== null,
        )
      )
        continue;
      const guard = () => {
        this.check();
        const current = this.journal(key);
        if (
          !same(current.scope, this.record.scope) ||
          current.generation !== this.record.context?.generation ||
          (sealed
            ? !same(current, a)
            : [
                "NOT_STARTED",
                "PROVIDER_INTENT",
                "ACKNOWLEDGED",
                "RUNNING",
                "TERMINAL",
                "UPLOADED",
              ].includes(current.state)) ||
          current.native ||
          current.terminal ||
          current.receipt ||
          current.toolCalls.length ||
          current.snapshot?.startIntentAt != null
        )
          throw new RuntimeError("AUTHORITY_LOST");
      };
      guard();
      let proof: AttemptJournal["unstartedClosure"];
      if (!claim || claim.state === "PENDING") {
        if (sealed || a.snapshot || starts.length || leases.length) continue;
        // This read checks current server authentication/scope; poll absence is never closure proof.
        await this.poll();
        guard();
        await this.credential(a.scope, guard);
        guard();
        proof = { kind: "LOCAL_NOT_TRANSMITTED", claimOperationId: a.claimOperationId! };
      } else {
        if (!["TRANSMITTED", "CONFIRMED"].includes(claim.state)) continue;
        // Always obtain a fresh original claim receipt, including for locally confirmed claims.
        const observed = projectResponse(
          "claim",
          await this.workflow("claim", claim.body, a.scope, guard),
        ) as unknown as AttemptSnapshot;
        guard();
        if (
          observed.requestId !== a.requestId ||
          observed.agentId !== a.scope.agentId ||
          observed.bindingEpoch !== a.scope.bindingEpoch
        )
          throw new RuntimeError("AUTHORITY_LOST");
        if (known) matchAttempt(observed, known);
        if (claim.state === "CONFIRMED") matchAttempt(observed, claim.result as AttemptSnapshot);
        if (sealed && a.unstartedClosure?.kind === "SERVER_ABANDONED")
          matchAttempt(observed, a.unstartedClosure.snapshot);
        if (observed.state !== "ABANDONED" || observed.startIntentAt !== null) continue;
        proof = {
          kind: "SERVER_ABANDONED",
          claimOperationId: a.claimOperationId!,
          snapshot: structuredClone(observed),
        };
      }
      guard();
      await this.mutate(
        "unstarted-closure",
        (record) => {
          const current = this.journal(key, record);
          // A sealed journal and its original receipts are immutable. Fresh claim evidence authorizes
          // only closure of this attempt's residual leases; it never renews or replays them.
          if (!sealed) {
            current.unstartedClosure = proof;
            current.state = "NOT_STARTED";
            current.reason = null;
          }
          for (const op of record.operations)
            if (
              ["PENDING", "TRANSMITTED"].includes(op.state) &&
              ((!sealed &&
                (op.operationId === current.claimOperationId ||
                  starts.some((start) => start.operationId === op.operationId))) ||
                (proof?.kind === "SERVER_ABANDONED" &&
                  leases.some((lease) => lease.operationId === op.operationId)))
            )
              op.state = "CLOSED";
        },
        guard,
      );
      this.check();
    }
  }
  private async recover() {
    await this.recoverUnstarted();
    this.check();
    // Recover exact durable terminals before ordinary readiness/question work. An older
    // readiness intent cannot block or advertise fresh provider admission during this recovery.
    for (const a of this.record.attempts.filter((a) => a.state === "TERMINAL")) {
      const pending = this.record.operations.find(
        (o) =>
          ["complete", "observe"].includes(o.action) &&
          o.body.requestId === a.requestId &&
          o.body.attemptId === a.snapshot?.attemptId &&
          o.body.fence === a.snapshot?.fence,
      );
      if (pending) await this.publish(this.journalKey(a), pending.action as "complete" | "observe");
      else {
        const poll = await this.poll();
        if (poll.attempt?.state !== "UNKNOWN") await this.publish(this.journalKey(a), "complete");
      }
    }
    for (const op of this.record.operations.filter(
      (o) => !["CONFIRMED", "CLOSED"].includes(o.state),
    )) {
      this.check();
      if (op.body.bindingEpoch !== this.record.scope.bindingEpoch)
        throw new RuntimeError("AUTHORITY_LOST");
      if (["lease", "interrupt-ack", "claim", "start-intent"].includes(op.action)) continue;
      // A question that never crossed its durable transmission boundary cannot run after tool closure.
      if (op.action === "question" && op.state === "PENDING") continue;
      if (["complete", "observe"].includes(op.action)) {
        const a = this.operationJournal(op);
        await this.publish(this.journalKey(a), op.action as "complete" | "observe");
        continue;
      }
      await this.transmit(op);
      this.check();
    }
    await this.markUnresolvedUnknown("UNKNOWN");
  }
  private async markUnresolvedUnknown(reason: RuntimeCode) {
    if (this.admission.closed) await this.boundedMutations();
    else await this.mutations;
    await this.store.drainWrites();
    this.storageCheck();
    const disk = await this.store.read();
    this.storageCheck();
    if (disk) this.record = disk;
    if (
      !this.record.attempts.some(
        (a) => !["TERMINAL", "UPLOADED", "UNKNOWN", "NOT_STARTED"].includes(a.state),
      )
    )
      return;
    const next = structuredClone(this.record);
    next.ready = false;
    for (const a of next.attempts)
      if (!["TERMINAL", "UPLOADED", "NOT_STARTED"].includes(a.state)) {
        a.state = "UNKNOWN";
        a.reason = reason;
      }
    if (this.admission.closed) {
      await this.store.write(next, this.storageCheck);
      this.storageCheck();
      this.record = next;
    } else
      await this.mutate(
        "unknown",
        (record) => {
          Object.assign(record, next);
        },
        this.storageCheck,
      );
  }
  async observe() {
    return this.underBinding(async () => {
      this.assertContext();
      return this.store.sessionLocked(this.record.context!.threadId, async () => {
        try {
          await this.compactJournal();
          await this.markUnresolvedUnknown("UNKNOWN");
          const a = this.record.attempts.find(
            (a) => a.state === "UNKNOWN" || a.state === "TERMINAL",
          );
          if (!a?.native) return this.publicStatus();
          if (!a.terminal) {
            const evidence = await this.admission.wait(() =>
              this.adapter.observe(
                this.record.context!,
                this.record.settings!,
                a.native!,
                this.check,
              ),
            );
            this.check();
            if (!evidence) return this.publicStatus();
            await this.persistTerminal(this.journalKey(a), evidence);
          }
          const poll = await this.poll();
          this.check();
          if (!poll.attempt) throw new RuntimeError("AUTHORITY_LOST");
          matchAttempt(poll.attempt, a.snapshot!);
          if (poll.attempt.state === "UNKNOWN") await this.publish(this.journalKey(a), "observe");
          else if (["EXECUTING", "COMPLETED", "FAILED", "INTERRUPTED"].includes(poll.attempt.state))
            await this.publish(this.journalKey(a), "complete");
          return this.publicStatus();
        } finally {
          await this.shutdown();
        }
      });
    });
  }
  stop() {
    this.toolOpen = false;
    this.admission.close();
    if (this.active && !this.interruptOnStop)
      this.interruptOnStop = this.adapter.interrupt(this.active).catch(() => false);
  }
  private async boundedMutations() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.mutations,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.options.drainTimeoutMs ?? 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async shutdown() {
    if (!this.lockHeld || this.retired) return;
    this.toolOpen = false;
    const authority = this.active;
    this.stop();
    await this.interruptOnStop;
    if (authority) {
      try {
        await this.adapter.interrupt(authority);
      } catch {
        /* Private provider diagnostics never become public errors. */
      }
    }
    const drained = await this.admission.drain(this.options.drainTimeoutMs ?? 2000);
    try {
      await this.adapter.close();
    } catch {
      await this.markUnresolvedUnknown("CLEANUP_INCOMPLETE");
      throw new RuntimeError("CLEANUP_INCOMPLETE");
    }
    await this.boundedMutations();
    await this.store.drainWrites();
    if (this.record) {
      await this.markUnresolvedUnknown(drained ? "UNKNOWN" : "CLEANUP_INCOMPLETE");
      const next = structuredClone(this.record);
      next.ready = false;
      await this.store.write(next, this.storageCheck);
      this.storageCheck();
      this.record = next;
    }
  }
  async assertReplaceable() {
    return this.guardMutation(async () => true);
  }
  async guardMutation<T>(mutation: () => Promise<T>, remove = false): Promise<T> {
    return this.underBinding(async () => {
      const execute = async () => {
        this.assertIdle(await this.poll());
        this.check();
        const result = await mutation();
        this.check();
        if (remove) {
          await this.store.remove();
          this.retired = true;
        } else {
          const state = await this.profileState();
          this.check();
          const scope = scopeOf(state, this.store.agentId, this.client.origin);
          if (!same(scope, this.record.scope)) {
            if (
              scope.bindingEpoch !== this.record.scope.bindingEpoch + 1 ||
              !same({ ...scope, bindingEpoch: this.record.scope.bindingEpoch }, this.record.scope)
            )
              throw new RuntimeError("AUTHORITY_LOST");
            await this.mutate("mapping-invalidated", (record) => {
              record.scope = scope;
              record.context = null;
              record.settings = null;
              record.ready = false;
            });
          }
        }
        return result;
      };
      return this.record.context
        ? this.store.sessionLocked(this.record.context.threadId, execute)
        : execute();
    });
  }
  async guardLocalRemoval<T>(
    mutation: (proof: {
      check(): void;
      validate(): Promise<void>;
      remove(): Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    this.admission.assert();
    if (this.retired || this.lockHeld || this.active) throw new RuntimeError("RUNTIME_BUSY");
    if (
      this.profile.profile !== this.store.profile ||
      this.profile.dir !== resolve(this.store.stateDir)
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    return this.store.locked(async () => {
      const removals: Promise<void>[] = [];
      this.lockHeld = true;
      const drain = async () => {
        this.toolOpen = false;
        this.admission.close();
        await this.admission.drain(this.options.drainTimeoutMs ?? 2000);
        await Promise.allSettled(removals);
        await this.boundedMutations();
        await this.store.drainWrites();
      };
      try {
        const saved = await this.store.read();
        this.check();
        const owner = await this.profile.read();
        this.check();
        const mappings =
          owner?.mappings.filter((mapping) => mapping.agentId === this.store.agentId) ?? [];
        const mapping = mappings[0];
        if (
          !owner ||
          owner.server !== this.client.origin ||
          !owner.deviceId ||
          !owner.scope ||
          mappings.length !== 1 ||
          !Number.isSafeInteger(mapping.bindingEpoch) ||
          mapping.bindingEpoch! < 1
        )
          throw new RuntimeError("AUTHORITY_LOST");
        if (owner.pending || owner.registration) throw new RuntimeError("RUNTIME_BUSY");
        const scope: RuntimeScope = {
          server: owner.server,
          deviceId: owner.deviceId,
          organizationId: owner.scope.organizationId,
          roomId: owner.scope.roomId,
          agentId: this.store.agentId,
          bindingEpoch: mapping.bindingEpoch!,
        };
        if (
          saved &&
          (!same(saved.scope, scope) ||
            (saved.context &&
              (saved.context.root.path !== mapping.root ||
                saved.context.threadId !== mapping.nativeSessionId)))
        )
          throw new RuntimeError("AUTHORITY_LOST");
        if (saved && unresolvedRuntime(saved)) throw new RuntimeError("RUNTIME_BUSY");
        let removed = false;
        const validate = async () => {
          this.check();
          const current = await this.store.read();
          this.check();
          const profile = await this.profile.read();
          this.check();
          if (!same(current, saved) || !same(profile, owner))
            throw new RuntimeError("AUTHORITY_LOST");
          if (current && unresolvedRuntime(current)) throw new RuntimeError("RUNTIME_BUSY");
        };
        const remove = () => {
          const job = this.admission.track(async () => {
            if (removed) throw new RuntimeError("RUNTIME_CLOSED");
            await validate();
            this.check();
            if (saved) {
              const before = await lstat(this.store.file);
              this.check();
              await validate();
              this.check();
              const current = await lstat(this.store.file);
              this.check();
              if (
                !current.isFile() ||
                current.isSymbolicLink() ||
                current.uid !== process.getuid?.() ||
                (current.mode & 0o777) !== 0o600 ||
                current.nlink !== 1 ||
                current.ino !== before.ino ||
                current.dev !== before.dev ||
                current.size !== before.size ||
                current.mtimeMs !== before.mtimeMs ||
                current.ctimeMs !== before.ctimeMs
              )
                throw new RuntimeError("UNSAFE_STORAGE");
              // The secure store read verifies schema/ownership. Guard the actual unlink after its
              // final await and retain the binding/session locks until dispatched filesystem work ends.
              this.check();
              await unlink(this.store.file);
              this.check();
              const directory = await open(
                this.store.dir,
                constants.O_RDONLY | constants.O_NOFOLLOW,
              );
              try {
                this.check();
                await directory.sync();
                this.check();
              } finally {
                await directory.close();
              }
            }
            removed = true;
          });
          removals.push(job);
          return job;
        };
        // No provider/server work is admitted here. The caller holds every owned protection and
        // revalidates all immutable proofs under the original profile transaction before deletion.
        const execute = async () => {
          try {
            await validate();
            this.check();
            const result = await mutation({ check: this.check, validate, remove });
            this.check();
            return result;
          } finally {
            await drain();
          }
        };
        return saved?.context
          ? await this.store.sessionLocked(saved.context.threadId, execute)
          : await execute();
      } finally {
        await drain();
        this.retired = true;
        this.lockHeld = false;
      }
    });
  }
  async removeLocal() {
    return this.guardLocalRemoval((proof) =>
      this.profile.transaction(async () => {
        await proof.validate();
        proof.check();
        await proof.remove();
        proof.check();
        return { state: "removed" };
      }, proof.check),
    );
  }
}
