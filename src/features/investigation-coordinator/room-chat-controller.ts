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
  permissionDenied: boolean;
  busy: boolean;
  pendingDirect: DirectIntent | null;
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
type Environment = { storage: () => Storage; hidden: () => boolean; now: () => number };
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

  constructor(
    private readonly actor: RoomChatActor,
    private readonly request: RoomChatRequest,
    private readonly environment: Environment = {
      storage: () => sessionStorage,
      hidden: () => document.hidden,
      now: () => Date.now(),
    },
  ) {
    this.pendingKey = directIntentKey(actor.userId, actor.roomId);
    this.state = {
      history: emptyHistory(actor.roomId),
      pollError: null,
      actionError: null,
      permissionDenied: false,
      busy: false,
      pendingDirect: null,
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
    this.update({ busy: false });
    try {
      this.update({
        pendingDirect: restoreDirectIntent(
          this.environment.storage(),
          this.actor.userId,
          this.actor.roomId,
        ),
      });
    } catch {
      // An inaccessible storage object cannot authorize restoration or a new direct input.
    }
    this.schedule(0);
  }

  stop() {
    this.active = false;
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

  loseAccess = () => {
    this.clearTimer();
    this.pollAbort?.abort();
    this.mutationAbort?.abort();
    this.update({
      history: emptyHistory(this.actor.roomId),
      requiredRecoveryRevision: 0,
      permissionDenied: true,
      cancelReceipts: [],
      pollError: "접근 권한을 확인해 주세요.",
    });
  };

  async poll() {
    if (!this.active || this.state.permissionDenied || this.pollAbort || this.mutationAbort) return;
    this.clearTimer();
    const generation = this.generation;
    const abort = new AbortController();
    this.pollAbort = abort;
    let backfill = false;
    let progressed = false;
    try {
      const afterSequence = this.state.history.cursor;
      const afterRetirementSequence = this.state.history.retirementCursor;
      const result = await this.request(
        "read-recovery",
        { protocol: 1, roomId: this.actor.roomId, afterSequence, afterRetirementSequence },
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
      const history = mergeHistory(this.state.history, page);
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
      backfill = page.hasMore || page.recovery.hasMoreRetirements || history.gap;
    } catch (failure) {
      if (!this.current(generation, abort)) return;
      if (accessDenied(codeOf(failure))) {
        this.loseAccess();
        return;
      }
      this.update({ pollError: "공동 기록을 불러올 수 없습니다. 다시 시도합니다." });
      this.failures++;
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
          backfill && progressed && !hidden && this.failures === 0
            ? 0
            : pollingDelay(backfill || running, hidden, this.failures),
        );
      }
    }
  }

  private clearIntent() {
    this.environment.storage().removeItem(this.pendingKey);
    this.update({ pendingDirect: null });
  }

  private persistIntent(action: DirectIntent["action"], body: Body) {
    const pendingDirect = { action, body };
    this.environment.storage().setItem(this.pendingKey, JSON.stringify(pendingDirect));
    this.update({ pendingDirect });
  }

  mutate = async (action: HumanAction, fields: Body, retryBody?: Body): Promise<boolean> => {
    if (
      !this.active ||
      !this.state.history.snapshot ||
      this.actor.role === "observer" ||
      this.state.permissionDenied ||
      this.mutationAbort ||
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
    this.update({ busy: true, actionError: null });
    let directIntent = false;
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
      if (action === "ask" || action === "cancel" || action === "retire") {
        this.persistIntent(action, body);
        directIntent = true;
      }
      const result = await this.request(action, body, abort.signal);
      if (!this.current(generation, abort)) return false;
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
      if (directIntent) this.clearIntent();
      return true;
    } catch (failure) {
      if (!this.current(generation, abort)) return false;
      const code = codeOf(failure);
      if (directIntent && code !== "UNAVAILABLE") {
        try {
          this.clearIntent();
        } catch {
          // Retain the exact intent if storage removal fails.
        }
      }
      this.update({
        actionError:
          code === "CONFLICT"
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
          this.failures = 0;
          this.schedule(0);
        }
      }
    }
  };
}
