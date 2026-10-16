import {
  WorkflowError,
  projectResponse,
  type Body,
  type RecoveryHistoryPage,
  type RetirementReceipt,
  type HumanAction,
} from "./contracts.ts";
import {
  emptyHistory,
  mergeHistory,
  recordRetirements,
  recoverySnapshot,
  type HistoryState,
} from "./history-state.ts";
import {
  directIntentKey,
  mutationBody,
  restoreDirectIntent,
  type DirectIntent,
} from "./direct-intents.ts";
import { speechOutbox, speechIntent, announceOutbox, type SpeechOutbox } from "./chat-outbox.ts";
import { cacheChatHistory, cachedChatHistory, clearChatHistory } from "./chat-history-cache.ts";
import type { RealtimeState } from "./room-realtime.ts";
import { pollingDelay } from "./polling-policy.ts";

export type RoomChatActor = {
  userId: string;
  roomId: string;
  role: "owner" | "participant" | "observer";
};
export type RoomChatRequest = (
  action: HumanAction,
  body: Body,
  signal: AbortSignal,
) => Promise<unknown>;
export type RoomChatState = {
  history: HistoryState;
  pollError: string | null;
  actionError: string | null;
  storageError: string | null;
  permissionDenied: boolean;
  busy: boolean;
  pendingDirect: DirectIntent | null;
  outboxConflict: DirectIntent | null;
  realtimeState: RealtimeState;
  observedAt: number;
  requiredRecoveryRevision: number;
  cancelReceipts: CancelReceipt[];
};
export type CancelReceipt = {
  requestId: string;
  cycleId: string;
  agentId: string;
  epoch: number;
  state: "REQUESTED" | "NO_ACTIVE_RUN";
};
type Environment = {
  storage: () => Storage;
  hidden: () => boolean;
  now: () => number;
  outbox?: SpeechOutbox;
  cache?: boolean;
};
const accessDenied = (code: string) => ["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"].includes(code);
const codeOf = (failure: unknown) =>
  failure instanceof WorkflowError ? failure.code : "UNAVAILABLE";

/** Owns one room's requests and public history; presentation state stays in the view. */
export class RoomChatController {
  private state: RoomChatState;
  private readonly listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort: AbortController | null = null;
  private mutationAbort: AbortController | null = null;
  private readonly pendingKey: string;
  private resyncRequested = false;
  private resyncNotBefore = 0;
  private restored = false;
  private validated = false;
  private preserveSavedIntent = false;
  private cached: HistoryState | null = null;

  constructor(
    private readonly actor: RoomChatActor,
    private readonly request: RoomChatRequest,
    private readonly environment: Environment = {
      storage: () => sessionStorage,
      hidden: () => document.hidden,
      now: () => Date.now(),
      outbox: speechOutbox,
      cache: true,
    },
  ) {
    this.pendingKey = directIntentKey(actor.userId, actor.roomId);
    this.state = {
      history: emptyHistory(actor.roomId),
      pollError: null,
      actionError: null,
      storageError: null,
      permissionDenied: false,
      busy: false,
      pendingDirect: null,
      outboxConflict: null,
      realtimeState: "connecting",
      observedAt: 0,
      requiredRecoveryRevision: 0,
      cancelReceipts: [],
    };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(change: Partial<RoomChatState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.generation++;
    this.failures = 0;
    this.resyncRequested = false;
    this.resyncNotBefore = 0;
    const previousHistory =
      !this.state.permissionDenied && this.state.history.snapshot ? this.state.history : null;
    this.restored = false;
    this.validated = false;
    this.cached = this.environment.cache
      ? (cachedChatHistory(this.actor, this.environment.now()) ?? previousHistory)
      : previousHistory;
    this.update({
      busy: false,
      history: emptyHistory(this.actor.roomId),
      pendingDirect: null,
      outboxConflict: null,
      cancelReceipts: [],
      observedAt: 0,
      realtimeState: "connecting",
    });
    this.schedule(0);
  }

  stop() {
    if (this.environment.cache && this.validated && !this.state.permissionDenied)
      cacheChatHistory(this.actor, this.state.history, this.environment.now());
    this.active = false;
    this.resyncRequested = false;
    this.generation++;
    this.clearTimer();
    this.pollAbort?.abort();
    this.mutationAbort?.abort();
    this.pollAbort = null;
    this.mutationAbort = null;
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    if (
      !this.active ||
      this.state.permissionDenied ||
      this.timer !== null ||
      this.pollAbort ||
      this.mutationAbort
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delay);
  }

  private current(generation: number, abort: AbortController) {
    return (
      this.active &&
      this.generation === generation &&
      !this.state.permissionDenied &&
      !abort.signal.aborted
    );
  }

  requestResync = () => {
    if (!this.active || this.state.permissionDenied) return;
    this.resyncRequested = true;
    if (this.pollAbort || this.mutationAbort) return;
    this.clearTimer();
    this.schedule(Math.max(0, this.resyncNotBefore - this.environment.now()));
  };

  loseAccess = () => this.revokeAccess(false);
  invalidateSession = (nextUserId?: string) => this.revokeAccess(nextUserId === this.actor.userId);

  private revokeAccess(preserveSavedIntent: boolean) {
    this.preserveSavedIntent = preserveSavedIntent;
    clearChatHistory(this.actor.userId, this.actor.roomId);
    this.cached = null;
    this.validated = false;
    if (!preserveSavedIntent)
      void this.environment.outbox
        ?.clear(this.actor.userId, this.actor.roomId)
        .then(announceOutbox)
        .catch(() =>
          this.update({ storageError: "권한이 사라진 방의 저장 메시지를 정리하지 못했습니다." }),
        );
    try {
      if (!preserveSavedIntent) this.environment.storage().removeItem(this.pendingKey);
    } catch {
      /* Access is hidden regardless of cleanup availability. */
    }
    this.resyncRequested = false;
    this.clearTimer();
    this.pollAbort?.abort();
    this.mutationAbort?.abort();
    this.update({
      history: emptyHistory(this.actor.roomId),
      requiredRecoveryRevision: 0,
      permissionDenied: true,
      pendingDirect: null,
      outboxConflict: null,
      busy: false,
      cancelReceipts: [],
      pollError: "접근 권한을 확인해 주세요.",
    });
  }

  async poll() {
    if (!this.active || this.state.permissionDenied || this.pollAbort || this.mutationAbort) return;
    this.clearTimer();
    this.resyncRequested = false;
    const generation = this.generation;
    const abort = new AbortController();
    this.pollAbort = abort;
    let backfill = false;
    let progressed = false;
    try {
      const previousHistory = this.cached ?? this.state.history;
      const afterSequence = previousHistory.cursor;
      const afterRetirementSequence = previousHistory.retirementCursor;
      const result = await this.request(
        "read-recovery",
        {
          protocol: 1,
          roomId: this.actor.roomId,
          expectedUserId: this.actor.userId,
          afterSequence,
          afterRetirementSequence,
        },
        abort.signal,
      );
      if (!this.current(generation, abort)) return;
      const page = projectResponse("read-recovery", result) as RecoveryHistoryPage;
      if (
        page.roomId !== this.actor.roomId ||
        page.nextCursor < afterSequence ||
        page.events.some((event) => event.sequence <= afterSequence) ||
        page.recovery.nextRetirementCursor < afterRetirementSequence ||
        page.recovery.retirements.some((entry) => entry.sequence <= afterRetirementSequence) ||
        (!page.recovery.retirements.length &&
          page.recovery.nextRetirementCursor !== afterRetirementSequence)
      )
        throw new WorkflowError("UNAVAILABLE");
      const history = mergeHistory(previousHistory, page);
      this.cached = null;
      this.validated = true;
      if (!this.restored) {
        await this.restorePending();
        if (!this.current(generation, abort)) return;
        this.restored = true;
      }
      progressed =
        history.cursor > afterSequence || history.retirementCursor > afterRetirementSequence;
      const cancelReceipts = this.state.cancelReceipts.filter((receipt) => {
        const run = history.snapshot?.runs.find(
          (run) =>
            run.requestId === receipt.requestId &&
            run.cycleId === receipt.cycleId &&
            run.agentId === receipt.agentId &&
            run.bindingEpoch === receipt.epoch,
        );
        // An older backfill or a different target cannot clear this acceptance receipt.
        const latest = history.events
          .filter(
            (event) =>
              event.kind === "RUN_STATE" &&
              event.requestId === receipt.requestId &&
              event.cycleId === receipt.cycleId &&
              event.agentId === receipt.agentId &&
              event.bindingEpoch === receipt.epoch,
          )
          .at(-1);
        const state =
          latest && (!run || Date.parse(latest.createdAt) > Date.parse(run.updatedAt))
            ? latest.runState
            : run?.state;
        return !state || !["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"].includes(state);
      });
      this.update({ history, cancelReceipts, observedAt: this.environment.now(), pollError: null });
      this.failures = 0;
      this.resyncNotBefore = this.environment.now() + 1000;
      backfill = page.hasMore || page.recovery.hasMoreRetirements || history.gap;
    } catch (failure) {
      if (!this.current(generation, abort)) return;
      if (accessDenied(codeOf(failure))) {
        this.loseAccess();
        return;
      }
      this.update({ pollError: "공동 기록을 불러올 수 없습니다. 다시 시도합니다." });
      this.failures++;
      this.resyncNotBefore =
        this.environment.now() + pollingDelay(false, this.environment.hidden(), this.failures);
    } finally {
      // A superseded lifecycle's request must not clear or schedule its replacement.
      if (this.pollAbort === abort) {
        this.pollAbort = null;
        const running = this.state.history.runs.some((run) =>
          ["QUEUED", "LEASED", "RUNNING"].includes(run.state),
        );
        const hidden = this.environment.hidden();
        // Drain validated history pages serially; stalled pages must not create a busy loop.
        this.schedule(
          this.resyncRequested
            ? Math.max(0, this.resyncNotBefore - this.environment.now())
            : backfill && progressed && !hidden && this.failures === 0
              ? 0
              : this.nextPollDelay(backfill || running, hidden),
        );
      }
    }
  }

  setRealtimeState = (realtimeState: RealtimeState) => {
    if (!this.active || this.state.permissionDenied) return;
    this.update({ realtimeState });
    if (realtimeState !== "connected") this.requestResync();
  };

  private nextPollDelay(running: boolean, hidden: boolean) {
    const base =
      this.state.realtimeState === "connected" && !this.failures
        ? 30_000
        : pollingDelay(running, hidden, this.failures);
    const snapshot = this.state.history.snapshot;
    const deadlines = [
      ...(snapshot?.bindings.map((binding) => binding.validUntil) ?? []),
      snapshot?.cycle?.deadline,
    ]
      .filter((value): value is string => !!value)
      .map(Date.parse)
      .filter((value) => value > this.environment.now());
    return Math.max(1, Math.min(base, ...deadlines.map((value) => value - this.environment.now())));
  }

  private async restorePending() {
    const generation = this.generation;
    let legacy: DirectIntent | null = null;
    try {
      legacy = restoreDirectIntent(
        this.environment.storage(),
        this.actor.userId,
        this.actor.roomId,
      );
      if (!this.environment.outbox) {
        if (this.active && generation === this.generation) this.update({ pendingDirect: legacy });
        return;
      }
      const stored = await this.environment.outbox.read(this.actor.userId, this.actor.roomId);
      if (!this.active || generation !== this.generation || this.state.permissionDenied) return;
      if (stored.expired)
        this.update({
          storageError: "저장된 메시지의 로컬 보관 기간 7일이 만료되어 제거했습니다.",
        });
      if (legacy?.action === "speak") {
        if (
          stored.entry &&
          (stored.entry.operationId !== legacy.body.operationId ||
            stored.entry.body.publicText !== legacy.body.publicText)
        ) {
          this.update({ pendingDirect: speechIntent(stored.entry), outboxConflict: legacy });
          return;
        }
        await this.environment.outbox.reserve(legacy.body);
        if (!this.active || generation !== this.generation || this.state.permissionDenied) {
          if (this.state.permissionDenied && !this.preserveSavedIntent)
            await this.environment.outbox.remove(
              this.actor.userId,
              this.actor.roomId,
              legacy.body.operationId as string,
            );
          return;
        }
        // Transfer only after the IndexedDB transaction has committed.
        this.environment.storage().removeItem(this.pendingKey);
        this.update({ pendingDirect: legacy, outboxConflict: null });
        announceOutbox();
        return;
      }
      this.update({
        pendingDirect: legacy ?? (stored.entry ? speechIntent(stored.entry) : null),
        outboxConflict: null,
      });
    } catch {
      if (this.active && generation === this.generation)
        this.update({
          ...(legacy && legacy.action !== "speak" ? { pendingDirect: legacy } : {}),
          storageError: "저장된 요청을 확인하지 못했습니다. 저장 공간과 다른 탭을 확인하세요.",
        });
    }
  }
  refreshOutbox = async () => {
    if (!this.active || !this.validated || this.state.permissionDenied || this.mutationAbort)
      return;
    await this.restorePending();
  };
  confirmStoredConflict = () => {
    this.update({ outboxConflict: null });
  };

  private async clearIntent() {
    const pending = this.state.pendingDirect;
    if (!pending) return;
    this.update({ pendingDirect: null });
    try {
      if (pending.action === "speak" && this.environment.outbox) {
        await this.environment.outbox.remove(
          this.actor.userId,
          this.actor.roomId,
          pending.body.operationId as string,
        );
        announceOutbox();
      } else {
        const storage = this.environment.storage();
        try {
          storage.setItem(this.pendingKey, JSON.stringify({ ...pending, settled: true }));
        } catch {
          /* Removal may still succeed at quota. */
        }
        storage.removeItem(this.pendingKey);
      }
      if (!this.state.permissionDenied) {
        this.update({ pendingDirect: null });
        if (this.environment.outbox) await this.restorePending();
      }
    } catch {
      this.update({
        storageError: "전송 결과는 확정되었습니다. 저장된 요청을 정리하지 못했습니다.",
      });
    }
  }

  private persistIntent(action: DirectIntent["action"], body: Body) {
    const pendingDirect = { action, body };
    const generation = this.generation;
    if (action === "speak" && this.environment.outbox) {
      return this.environment.outbox.reserve(body).then(async (entry) => {
        if (!this.active || generation !== this.generation || this.state.permissionDenied) {
          if (this.state.permissionDenied && !this.preserveSavedIntent)
            await this.environment.outbox?.remove(
              this.actor.userId,
              this.actor.roomId,
              entry.operationId,
            );
          return;
        }
        this.update({ pendingDirect: speechIntent(entry) });
        announceOutbox();
      });
    } else {
      this.environment.storage().setItem(this.pendingKey, JSON.stringify(pendingDirect));
      this.update({ pendingDirect });
    }
  }

  mutate = async (action: HumanAction, fields: Body, retryBody?: Body): Promise<boolean> => {
    if (
      !this.active ||
      !this.state.history.snapshot ||
      this.actor.role === "observer" ||
      this.state.permissionDenied ||
      this.mutationAbort ||
      (this.environment.outbox && (!this.restored || !!this.state.outboxConflict)) ||
      (this.state.pendingDirect && !retryBody)
    )
      return false;
    const pending = this.state.pendingDirect;
    if (
      retryBody &&
      (!pending ||
        pending.action !== action ||
        Object.keys(retryBody).length !== Object.keys(pending.body).length ||
        Object.keys(pending.body).some((key) => pending.body[key] !== retryBody[key]))
    )
      return false;
    const recovery = recoverySnapshot(this.state.history);
    const newInput = action === "ask" || action === "start" || action === "resume";
    if (
      newInput &&
      !retryBody &&
      (!recovery ||
        recovery.recovery.hasBlockingRuns ||
        this.state.pollError ||
        recovery.roomRevision < this.state.requiredRecoveryRevision)
    )
      return false;
    this.clearTimer();
    this.pollAbort?.abort();
    this.pollAbort = null;
    const generation = this.generation;
    const abort = new AbortController();
    this.mutationAbort = abort;
    this.update({ busy: true, actionError: null, storageError: null });
    let directIntent = false;
    let savingIntent = false;
    try {
      const body = mutationBody(action, fields, this.actor.userId, this.actor.roomId, retryBody);
      const cancelTarget =
        action === "cancel"
          ? (this.state.history.snapshot?.runs.find((run) => run.requestId === body.requestId) ??
            this.state.history.events.find(
              (event) =>
                event.requestId === body.requestId &&
                event.cycleId &&
                event.agentId &&
                event.bindingEpoch !== null,
            ))
          : undefined;
      if (action === "retire" && !retryBody) {
        const candidate = recovery?.recovery.candidate;
        if (
          !candidate ||
          !candidate.canRetire ||
          this.state.pollError ||
          this.state.history.retirements.some((entry) => entry.requestId === candidate.requestId) ||
          candidate.roomRevision !== body.expectedRoomRevision ||
          ["requestId", "cycleId", "attemptId", "fence", "agentId", "bindingEpoch"].some(
            (key) => body[key] !== candidate[key as keyof typeof candidate],
          )
        )
          throw new WorkflowError("CONFLICT");
      }
      if (action === "speak" || action === "ask" || action === "cancel" || action === "retire") {
        savingIntent = true;
        const persistence = this.persistIntent(action, body);
        if (persistence) await persistence;
        if (!this.current(generation, abort)) return false;
        savingIntent = false;
        directIntent = true;
      }
      const result = await this.request(action, body, abort.signal);
      if (!this.current(generation, abort)) return false;
      if (action === "speak") projectResponse("speak", result);
      if (action === "retire") {
        const receipt = projectResponse("retire", result) as RetirementReceipt;
        if (
          ["requestId", "cycleId", "attemptId", "fence", "agentId", "bindingEpoch"].some(
            (key) => receipt[key as keyof RetirementReceipt] !== body[key],
          ) ||
          receipt.roomRevision <= (body.expectedRoomRevision as number)
        )
          throw new WorkflowError("UNAVAILABLE");
        const { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt } = receipt;
        this.update({
          history: recordRetirements(this.state.history, [
            { sequence, requestId, cycleId, agentId, bindingEpoch, retiredAt },
          ]),
          requiredRecoveryRevision: Math.max(
            this.state.requiredRecoveryRevision,
            receipt.roomRevision,
          ),
        });
      }
      if (action === "cancel") {
        const receipt = projectResponse("cancel", result) as {
          requestId: string | null;
          state: CancelReceipt["state"];
        };
        if (receipt.state === "REQUESTED" && receipt.requestId !== body.requestId)
          throw new WorkflowError("UNAVAILABLE");
        if (cancelTarget?.cycleId && cancelTarget.agentId && cancelTarget.bindingEpoch !== null) {
          const cancelReceipt: CancelReceipt = {
            requestId: body.requestId as string,
            cycleId: cancelTarget.cycleId,
            agentId: cancelTarget.agentId,
            epoch: cancelTarget.bindingEpoch,
            state: receipt.state,
          };
          this.update({
            cancelReceipts: [
              ...this.state.cancelReceipts.filter(
                (previous) => previous.requestId !== cancelReceipt.requestId,
              ),
              cancelReceipt,
            ],
          });
        }
      }
      if (directIntent) await this.clearIntent();
      return true;
    } catch (failure) {
      if (!this.current(generation, abort)) return false;
      const code = codeOf(failure);
      if (directIntent && code !== "UNAVAILABLE") {
        await this.clearIntent();
      }
      if (savingIntent && action === "speak" && this.environment.outbox)
        await this.restorePending();
      this.update({
        actionError: savingIntent
          ? "요청을 브라우저에 저장할 수 없어 전송하지 않았습니다. 초안을 보관하고 저장 공간을 확인해 주세요."
          : code === "CONFLICT"
            ? "상태가 바뀌었습니다. 기록을 갱신한 뒤 다시 시도해 주세요."
            : "요청을 완료할 수 없습니다. 접근 권한과 연결 보고를 확인해 주세요.",
      });
      if (accessDenied(code)) this.loseAccess();
      return false;
    } finally {
      if (this.mutationAbort === abort) {
        this.mutationAbort = null;
        if (this.active && this.generation === generation) {
          this.update({ busy: false });
          this.schedule(0);
        }
      }
    }
  };
}
