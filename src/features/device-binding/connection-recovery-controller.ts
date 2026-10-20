import { callInvestigation } from "../investigation-coordinator/investigation-client.ts";
import { mutationBody } from "../investigation-coordinator/direct-intents.ts";
import {
  projectResponse,
  WorkflowError,
  validateBody,
  type Body,
  type Candidate,
  type HumanAction,
  type RecoveryHistoryPage,
  type RetirementReceipt,
} from "../investigation-coordinator/contracts.ts";
import { ConnectionError, isAlias, isId } from "./contracts.ts";
import { projectConnectionStatus, type ConnectionStatus } from "./connection-status-contracts.ts";
import { requestConnectionStatus, type ReadinessView } from "./ai-readiness-controller.ts";

export type RecoveryTarget = {
  userId: string;
  roomId: string;
  deviceId: string;
  deviceAlias: string;
  candidate: Candidate;
};
export type RecoveryView = {
  target: RecoveryTarget | null;
  candidate: Candidate | null;
  phase: "closed" | "review" | "needs-check" | "retire-ready" | "retire-unconfirmed" | "retired";
  busy: boolean;
  active: boolean;
  error: string | null;
  checkedAt: string | null;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
type Dependencies = {
  status: typeof requestConnectionStatus;
  workflow: typeof callInvestigation;
  revoke: (body: { deviceId: string }, signal: AbortSignal) => Promise<void>;
  storage: Storage;
  uuid: () => string;
  timeoutMs: number;
};
const identity = ["requestId", "cycleId", "attemptId", "fence", "agentId", "bindingEpoch"] as const;
function sameCandidate(left: Candidate, right: Candidate) {
  return identity.every((key) => left[key] === right[key]);
}
function scope(target: RecoveryTarget) {
  return { expectedUserId: target.userId, roomId: target.roomId, deviceId: target.deviceId };
}
function key(userId: string, roomId: string) {
  return `connection-preserved-recovery:${userId}:${roomId}`;
}
const browserStorage: Storage = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
async function revokeDevice(body: { deviceId: string }, signal: AbortSignal) {
  const response = await fetch("/api/connections/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
    redirect: "error",
  });
  if (
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new ConnectionError("UNAVAILABLE");
  const text = await response.text();
  if (text.length > 16_384) throw new ConnectionError("UNAVAILABLE");
  const value = JSON.parse(text);
  if (!response.ok || value.ok !== true || value.data?.removed !== true)
    throw new ConnectionError("UNAVAILABLE");
}
const initial = (): RecoveryView => ({
  target: null,
  candidate: null,
  phase: "closed",
  busy: false,
  active: false,
  error: null,
  checkedAt: null,
});

export class ConnectionRecoveryController {
  private view = initial();
  private listeners = new Set<() => void>();
  private context: { userId: string; roomId: string; deviceId: string | null } | null = null;
  private generation = 0;
  private abort: AbortController | null = null;
  private pending: Promise<boolean> | null = null;
  private retireIntent: Body | null = null;
  private revokeAttempted = false;
  private journalRaw: string | null = null;
  private replacementDeviceId: string | null = null;
  private dependencies: Dependencies;
  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      status: requestConnectionStatus,
      workflow: callInvestigation,
      revoke: revokeDevice,
      storage: browserStorage,
      uuid: () => crypto.randomUUID(),
      timeoutMs: 10_000,
      ...dependencies,
    };
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<RecoveryView>) {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }
  private currentTarget() {
    const target = this.view.target;
    return target &&
      this.context?.userId === target.userId &&
      this.context.roomId === target.roomId &&
      this.context.deviceId === target.deviceId
      ? target
      : null;
  }
  stop() {
    const phase = this.view.busy
      ? this.retireIntent
        ? "retire-unconfirmed"
        : "needs-check"
      : this.view.phase;
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
    this.update({ busy: false, active: false, phase });
  }
  setContext(userId: string, roomId: string, deviceId: string | null) {
    const changed =
      this.context?.userId !== userId ||
      this.context.roomId !== roomId ||
      this.context.deviceId !== deviceId;
    if (changed) this.stop();
    const scopeChanged = this.context?.userId !== userId || this.context.roomId !== roomId;
    this.context = { userId, roomId, deviceId };
    if (scopeChanged) {
      this.view = initial();
      this.retireIntent = null;
      this.revokeAttempted = false;
      this.journalRaw = null;
      this.replacementDeviceId = null;
      try {
        const raw = this.dependencies.storage.getItem(key(userId, roomId));
        this.journalRaw = raw;
        if (raw) {
          const saved = JSON.parse(raw);
          const target = saved.target as RecoveryTarget;
          if (
            target.userId !== userId ||
            target.roomId !== roomId ||
            !isId(target.deviceId) ||
            !isAlias(target.deviceAlias) ||
            !isId(target.userId) ||
            !isId(target.roomId)
          )
            throw new Error("INVALID_JOURNAL");
          this.validatePin(target);
          if (saved.retireIntent) {
            const intent = validateBody("retire", saved.retireIntent);
            if (
              intent.expectedUserId !== userId ||
              intent.roomId !== roomId ||
              identity.some((field) => intent[field] !== target.candidate[field])
            )
              throw new Error("INVALID_JOURNAL");
            this.retireIntent = intent;
          }
          this.revokeAttempted = saved.revokeAttempted === true;
          if (saved.replacementDeviceId !== null && saved.replacementDeviceId !== undefined) {
            if (!isId(saved.replacementDeviceId) || saved.replacementDeviceId === target.deviceId)
              throw new Error("INVALID_JOURNAL");
            this.replacementDeviceId = saved.replacementDeviceId;
          } else this.view = { ...initial(), target, phase: "needs-check" };
        }
      } catch {
        this.update({
          error: "보존한 복구 대상을 읽지 못했습니다. 원래 계정·방과 브라우저 저장소를 확인하세요.",
        });
      }
    }
    this.update({ active: !!this.currentTarget() });
  }
  private validatePin(target: RecoveryTarget) {
    validateBody("retire", {
      protocol: 1,
      roomId: target.roomId,
      expectedUserId: target.userId,
      operationId: target.deviceId,
      ...Object.fromEntries(identity.map((field) => [field, target.candidate[field]])),
      expectedRoomRevision: target.candidate.roomRevision,
      confirmed: true,
    });
  }
  open(target: RecoveryTarget) {
    if (
      this.view.busy ||
      (this.view.target &&
        this.view.phase !== "review" &&
        this.view.phase !== "retired" &&
        this.view.phase !== "closed")
    )
      return;
    this.validatePin(target);
    if (
      this.context?.userId !== target.userId ||
      this.context.roomId !== target.roomId ||
      this.context.deviceId !== target.deviceId
    )
      return;
    this.stop();
    this.retireIntent = null;
    this.revokeAttempted = false;
    this.replacementDeviceId = null;
    this.update({
      ...initial(),
      target: structuredClone(target),
      candidate: structuredClone(target.candidate),
      phase: "review",
      active: true,
    });
  }
  private persist() {
    const target = this.view.target!;
    const raw = JSON.stringify({
      target,
      retireIntent: this.retireIntent,
      revokeAttempted: this.revokeAttempted,
      replacementDeviceId: this.replacementDeviceId,
    });
    const storageKey = key(target.userId, target.roomId);
    if (this.dependencies.storage.getItem(storageKey) !== this.journalRaw)
      throw new Error("JOURNAL_CHANGED");
    this.dependencies.storage.setItem(storageKey, raw);
    if (this.dependencies.storage.getItem(storageKey) !== raw) throw new Error("JOURNAL_CHANGED");
    this.journalRaw = raw;
  }
  private async read(target: RecoveryTarget, signal: AbortSignal) {
    const [rawStatus, rawPage] = await Promise.all([
      this.dependencies.status(scope(target), signal),
      this.dependencies.workflow(
        "read-recovery",
        {
          protocol: 1,
          roomId: target.roomId,
          expectedUserId: target.userId,
          afterSequence: 0,
          afterRetirementSequence: 0,
        },
        signal,
      ),
    ]);
    const status = projectConnectionStatus(rawStatus, scope(target));
    let page = projectResponse("read-recovery", rawPage) as RecoveryHistoryPage;
    if (page.roomId !== target.roomId) throw new Error("SCOPE_CHANGED");
    let retirement = page.recovery.retirements.find(
      (entry) => entry.requestId === target.candidate.requestId,
    );
    for (let count = 0; !retirement && page.recovery.hasMoreRetirements; count++) {
      if (count >= 128 || signal.aborted) throw new Error("RECOVERY_INCOMPLETE");
      const cursor = page.recovery.nextRetirementCursor;
      const next = projectResponse(
        "read-recovery",
        await this.dependencies.workflow(
          "read-recovery",
          {
            protocol: 1,
            roomId: target.roomId,
            expectedUserId: target.userId,
            afterSequence: 0,
            afterRetirementSequence: cursor,
          },
          signal,
        ),
      ) as RecoveryHistoryPage;
      if (next.roomId !== target.roomId || next.recovery.nextRetirementCursor <= cursor)
        throw new Error("RECOVERY_INCOMPLETE");
      page = next;
      retirement = page.recovery.retirements.find(
        (entry) => entry.requestId === target.candidate.requestId,
      );
    }
    if (retirement) {
      if (
        ["cycleId", "agentId", "bindingEpoch"].some(
          (field) =>
            retirement[field as keyof typeof retirement] !==
            target.candidate[field as keyof Candidate],
        )
      )
        throw new Error("TARGET_CHANGED");
      return { status, candidate: null, retired: true };
    }
    const candidate = page.recovery.candidate;
    if (
      !candidate ||
      !sameCandidate(target.candidate, candidate) ||
      status.device.state === "removed"
    )
      throw new Error("TARGET_CHANGED");
    if (status.device.state === "active") {
      if (
        status.executionStatus?.agentId !== target.candidate.agentId ||
        status.executionStatus.bindingEpoch !== target.candidate.bindingEpoch ||
        candidate.deviceRevoked
      )
        throw new Error("BINDING_CHANGED");
      if (
        !page.bindings.some(
          (binding) =>
            binding.owned &&
            binding.agentId === candidate.agentId &&
            binding.bindingEpoch === candidate.bindingEpoch,
        )
      )
        throw new Error("OWNER_CHANGED");
    } else if (!this.revokeAttempted || !candidate.deviceRevoked)
      throw new Error("REVOCATION_UNCONFIRMED");
    return { status, candidate, retired: false };
  }
  private adopt(result: {
    status: ConnectionStatus;
    candidate: Candidate | null;
    retired: boolean;
  }) {
    const revoked = result.status.device.state === "revoked" && result.candidate?.deviceRevoked;
    this.update({
      candidate: result.candidate,
      checkedAt: result.status.checkedAt,
      phase: result.retired
        ? "retired"
        : this.retireIntent
          ? "retire-unconfirmed"
          : revoked && result.candidate?.canRetire
            ? "retire-ready"
            : revoked
              ? "needs-check"
              : "review",
      error:
        revoked && !result.candidate?.canRetire
          ? "원래 기기 연결 취소는 확인했습니다. 서버가 이전 요청 정리를 허용하는지 다시 확인하세요."
          : null,
    });
  }
  private run(
    work: (target: RecoveryTarget, signal: AbortSignal, guard: () => void) => Promise<boolean>,
    isCurrent = () => !!this.currentTarget(),
  ): Promise<boolean> {
    if (this.pending) return this.pending;
    const target = this.view.target;
    if (!target || !isCurrent()) return Promise.resolve(false);
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const guard = () => {
      if (abort.signal.aborted || generation !== this.generation || !isCurrent())
        throw new Error("SCOPE_CHANGED");
      if (this.dependencies.storage.getItem(key(target.userId, target.roomId)) !== this.journalRaw)
        throw new Error("JOURNAL_CHANGED");
    };
    this.update({ busy: true, error: null });
    let timer: ReturnType<typeof setTimeout>;
    const cancelled = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(new Error("CHECK_UNAVAILABLE")), {
        once: true,
      });
      timer = setTimeout(() => abort.abort(), this.dependencies.timeoutMs);
    });
    this.pending = Promise.race([
      Promise.resolve().then(() => {
        guard();
        return work(target, abort.signal, guard);
      }),
      cancelled,
    ])
      .catch(() => {
        if (generation === this.generation)
          this.update({
            phase: this.retireIntent ? "retire-unconfirmed" : "needs-check",
            candidate: null,
            error:
              "이 단계의 결과를 확인하지 못했습니다. 같은 대상의 상태를 다시 확인하세요. 연결 취소·요청 정리·질문 전송을 자동으로 반복하지 않습니다.",
          });
        return false;
      })
      .finally(() => {
        clearTimeout(timer);
        if (generation === this.generation) {
          this.pending = null;
          this.abort = null;
          this.update({ busy: false });
        }
      });
    return this.pending;
  }
  check() {
    return this.run(async (target, signal, guard) => {
      const result = await this.read(target, signal);
      guard();
      this.adopt(result);
      return true;
    });
  }
  async reconcileReplacement(ready: ReadinessView): Promise<boolean> {
    if (!this.isReplacementConnected(ready) || this.view.busy) return false;
    if (this.view.phase === "retired") return this.completeReplacement(ready);
    return this.run(
      async (target, signal, guard) => {
        const result = await this.read(target, signal);
        guard();
        if (!result.retired) return false;
        this.adopt(result);
        return true;
      },
      () => this.isReplacementConnected(ready),
    ).then((retired) => (retired ? this.completeReplacement(ready) : false));
  }
  private isReplacementConnected(ready: ReadinessView): boolean {
    const target = this.view.target;
    const replacement = ready.target;
    if (
      !target ||
      !replacement ||
      ready.state !== "complete" ||
      !ready.device ||
      ready.device.state !== "active" ||
      !(Date.parse(ready.device.expiresAt ?? "") > Date.now()) ||
      ready.device.roomId !== target.roomId ||
      ready.device.deviceId !== replacement.deviceId ||
      replacement.deviceId === target.deviceId ||
      replacement.expectedUserId !== target.userId ||
      replacement.roomId !== target.roomId ||
      this.context?.userId !== target.userId ||
      this.context.roomId !== target.roomId ||
      this.context.deviceId !== replacement.deviceId
    )
      return false;
    return true;
  }
  completeReplacement(ready: ReadinessView): boolean {
    if (this.view.phase !== "retired" || this.view.busy || !this.isReplacementConnected(ready))
      return false;
    try {
      this.replacementDeviceId = ready.target!.deviceId;
      this.persist();
      this.update(initial());
      return true;
    } catch {
      this.replacementDeviceId = null;
      this.update({
        error:
          "새 연결은 확인했지만 복구 진행 상태를 저장하지 못했습니다. 브라우저 저장소와 다른 탭의 선택을 확인하세요.",
      });
      return false;
    }
  }
  revoke(confirmed: boolean): Promise<boolean> {
    if (!confirmed || this.view.phase !== "review") return Promise.resolve(false);
    return this.run(async (target, signal, guard) => {
      const before = await this.read(target, signal);
      guard();
      if (before.retired || before.status.device.state === "revoked") {
        this.adopt(before);
        return true;
      }
      this.revokeAttempted = true;
      this.persist();
      guard();
      try {
        await this.dependencies.revoke({ deviceId: target.deviceId }, signal);
      } catch {
        guard();
      }
      guard();
      const after = await this.read(target, signal);
      guard();
      this.adopt(after);
      if (after.status.device.state !== "revoked" && !after.retired)
        this.update({
          error:
            "이 기기의 연결 취소가 아직 확인되지 않았습니다. 같은 대상의 상태를 다시 확인하세요.",
          phase: "needs-check",
          candidate: null,
        });
      return this.view.phase === "retire-ready" || this.view.phase === "retired";
    });
  }
  mutate = (action: HumanAction, fields: Body): Promise<boolean> => {
    if (
      action !== "retire" ||
      this.view.phase !== "retire-ready" ||
      !this.view.candidate?.canRetire ||
      this.retireIntent
    )
      return Promise.resolve(false);
    const allowed = [...identity, "expectedRoomRevision", "confirmed"];
    if (
      Object.keys(fields).length !== allowed.length ||
      Object.keys(fields).some((key) => !allowed.includes(key as (typeof allowed)[number])) ||
      fields.confirmed !== true ||
      identity.some((key) => fields[key] !== this.view.candidate![key]) ||
      fields.expectedRoomRevision !== this.view.candidate.roomRevision
    )
      return Promise.resolve(false);
    return this.run(async (target, signal, guard) => {
      const before = await this.read(target, signal);
      guard();
      this.adopt(before);
      if (before.retired) return true;
      if (
        before.status.device.state !== "revoked" ||
        !before.candidate?.canRetire ||
        before.candidate.roomRevision !== fields.expectedRoomRevision
      )
        return false;
      this.retireIntent = mutationBody(
        "retire",
        { ...fields, operationId: this.dependencies.uuid() },
        target.userId,
        target.roomId,
      );
      this.persist();
      guard();
      return this.submitRetirement(target, signal, guard);
    });
  };
  retryRetirement() {
    if (this.view.phase !== "retire-unconfirmed" || !this.retireIntent)
      return Promise.resolve(false);
    return this.run(async (target, signal, guard) => {
      const before = await this.read(target, signal);
      guard();
      this.adopt(before);
      if (before.retired) return true;
      if (before.status.device.state !== "revoked" || !before.candidate?.canRetire) return false;
      this.persist();
      guard();
      return this.submitRetirement(target, signal, guard);
    });
  }
  private async submitRetirement(target: RecoveryTarget, signal: AbortSignal, guard: () => void) {
    try {
      const receipt = projectResponse(
        "retire",
        await this.dependencies.workflow("retire", this.retireIntent!, signal),
      ) as RetirementReceipt;
      guard();
      if (
        identity.some((key) => receipt[key] !== this.retireIntent![key]) ||
        receipt.roomRevision <= Number(this.retireIntent!.expectedRoomRevision)
      )
        throw new Error("WRONG_RECEIPT");
      this.update({ phase: "retired", candidate: null, checkedAt: receipt.retiredAt, error: null });
      return true;
    } catch (error) {
      guard();
      const result = await this.read(target, signal);
      guard();
      this.adopt(result);
      if (
        !result.retired &&
        error instanceof WorkflowError &&
        error.code === "CONFLICT" &&
        result.candidate?.canRetire
      ) {
        this.retireIntent = null;
        this.persist();
        guard();
        this.adopt(result);
        this.update({
          error:
            "이전 정리 요청이 거절되었습니다. 현재 방 상태와 같은 요청을 다시 확인한 뒤 정리를 승인하세요.",
        });
        return false;
      }
      if (!result.retired)
        this.update({
          phase: "retire-unconfirmed",
          error:
            "이전 요청 정리 결과가 미확정입니다. 상태를 다시 조회하거나 같은 정리 요청의 결과를 확인하세요.",
        });
      return result.retired;
    }
  }
}
