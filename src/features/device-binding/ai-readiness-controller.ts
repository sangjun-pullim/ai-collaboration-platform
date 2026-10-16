import { callInvestigation } from "../investigation-coordinator/investigation-client.ts";
import type { Candidate, RecoveryHistoryPage } from "../investigation-coordinator/contracts.ts";
import {
  ConnectionError,
  messages,
  type ConnectionErrorCode,
  type OwnedDevice,
} from "./contracts.ts";
import {
  projectConnectionStatus,
  type ConnectionStatus,
  type StatusRequest,
  type ExecutionStatus,
} from "./connection-status-contracts.ts";

export type SettingsBinding = {
  agentId: string;
  bindingEpoch: number;
  configRevision: number;
  applied: boolean;
};
export type ReadinessView = {
  target: StatusRequest | null;
  binding: SettingsBinding | null;
  state: "idle" | "checking" | "complete" | "error" | "expired";
  checkedAt: string | null;
  error: ConnectionErrorCode | null;
  device: OwnedDevice | null;
  selectedReady: boolean;
  roomBlocked: boolean;
  ready: boolean;
  requestId: string | null;
  failure: NonNullable<ExecutionStatus>["failure"];
  validUntil: string | null;
  candidate: Candidate | null;
};
const initial = (): ReadinessView => ({
  target: null,
  binding: null,
  state: "idle",
  checkedAt: null,
  error: null,
  device: null,
  selectedReady: false,
  roomBlocked: false,
  ready: false,
  requestId: null,
  failure: null,
  validUntil: null,
  candidate: null,
});
export async function requestConnectionStatus(
  target: StatusRequest,
  signal: AbortSignal,
): Promise<ConnectionStatus> {
  const response = await fetch("/api/connections/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
    signal,
    cache: "no-store",
    redirect: "error",
  });
  if (
    response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new ConnectionError("UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new ConnectionError("UNAVAILABLE");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16_384) {
        await reader.cancel();
        throw new ConnectionError("UNAVAILABLE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!response.ok || result.ok !== true)
    throw new ConnectionError(
      Object.hasOwn(messages, result.error?.code) ? result.error.code : "UNAVAILABLE",
    );
  return projectConnectionStatus(result.data, target);
}
type StatusReader = typeof requestConnectionStatus;
type RecoveryReader = (target: StatusRequest, signal: AbortSignal) => Promise<RecoveryHistoryPage>;
const readRecovery: RecoveryReader = async (target, signal) =>
  (await callInvestigation(
    "read-recovery",
    {
      protocol: 1,
      roomId: target.roomId,
      expectedUserId: target.expectedUserId,
      afterSequence: 0,
      afterRetirementSequence: 0,
    },
    signal,
  )) as RecoveryHistoryPage;

export class AiReadinessController {
  private view = initial();
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private abort: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private status: StatusReader = requestConnectionStatus,
    private recovery: RecoveryReader = readRecovery,
    private timeoutMs = 10_000,
  ) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(change: Partial<ReadinessView>) {
    this.view = { ...this.view, ...change };
    for (const listener of this.listeners) listener();
  }
  private cancel() {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.pending = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
  }
  start() {
    this.active = true;
  }
  stop() {
    this.active = false;
    this.cancel();
  }
  select(target: StatusRequest | null) {
    this.cancel();
    this.view = { ...initial(), target };
    this.update({});
    if (target) void this.check();
  }
  setBinding(binding: SettingsBinding | null) {
    if (JSON.stringify(binding) === JSON.stringify(this.view.binding)) return;
    this.cancel();
    this.update({
      binding,
      ready: false,
      selectedReady: false,
      requestId: null,
      failure: null,
      candidate: null,
    });
    if (this.view.target) void this.check();
  }
  check(): Promise<void> {
    if (this.pending) return this.pending;
    if (!this.active || !this.view.target) return Promise.resolve();
    if (this.expiry) clearTimeout(this.expiry);
    const generation = ++this.generation;
    const target = this.view.target;
    const binding = this.view.binding;
    const abort = new AbortController();
    this.abort = abort;
    this.update({
      state: "checking",
      ready: false,
      selectedReady: false,
      error: null,
      device: null,
      requestId: null,
      failure: null,
      candidate: null,
    });
    const work = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const results = await Promise.race([
          Promise.allSettled([
            Promise.resolve().then(() => {
              if (abort.signal.aborted) throw new ConnectionError("UNAVAILABLE");
              return this.status(target, abort.signal);
            }),
            Promise.resolve().then(() => {
              if (abort.signal.aborted) throw new ConnectionError("UNAVAILABLE");
              return this.recovery(target, abort.signal);
            }),
          ]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              reject(new ConnectionError("UNAVAILABLE"));
            }, this.timeoutMs);
          }),
          new Promise<never>((_, reject) => {
            abort.signal.addEventListener(
              "abort",
              () => reject(new ConnectionError("UNAVAILABLE")),
              { once: true },
            );
          }),
        ]);
        if (!this.active || generation !== this.generation) return;
        const [pc, ai] = results;
        const status = pc.status === "fulfilled" ? projectConnectionStatus(pc.value, target) : null;
        this.update({ device: status?.device ?? null });
        if (!status || ai.status !== "fulfilled")
          throw pc.status === "rejected"
            ? pc.reason
            : ai.status === "rejected"
              ? ai.reason
              : new ConnectionError("UNAVAILABLE");
        const history = ai.value;
        if (history.roomId !== target.roomId) throw new ConnectionError("FORBIDDEN");
        const owned = history.bindings.filter(
          (item) =>
            item.owned &&
            item.agentId === binding?.agentId &&
            item.bindingEpoch === binding.bindingEpoch,
        );
        const selected = owned.length === 1 ? owned[0] : null;
        const now = Date.now();
        const deviceValid =
          status.device.state === "active" && Date.parse(status.device.expiresAt ?? "") > now;
        const execution = status.executionStatus;
        const executionMatches =
          !!binding &&
          execution?.agentId === binding.agentId &&
          execution.bindingEpoch === binding.bindingEpoch;
        const selectedReady =
          deviceValid &&
          executionMatches &&
          !!selected?.reportedReady &&
          Date.parse(selected.validUntil ?? "") > now;
        const matching = history.runs.find(
          (run) =>
            history.recovery.hasBlockingRuns &&
            run.state === "UNKNOWN" &&
            run.agentId === binding?.agentId &&
            run.bindingEpoch === binding.bindingEpoch &&
            !history.recovery.retirements.some((entry) => entry.requestId === run.requestId),
        );
        const candidate = history.recovery.candidate;
        const requestId =
          matching?.requestId ??
          (candidate?.agentId === binding?.agentId &&
          candidate?.bindingEpoch === binding?.bindingEpoch
            ? (candidate?.requestId ?? null)
            : null);
        const failure = executionMatches ? (execution?.failure ?? null) : null;
        const roomBlocked = history.recovery.hasBlockingRuns;
        const ready = !!binding?.applied && selectedReady && !roomBlocked && !failure;
        this.update({
          state: "complete",
          checkedAt: status.checkedAt,
          selectedReady,
          roomBlocked,
          ready,
          requestId,
          failure,
          validUntil: selected?.validUntil ?? null,
          candidate:
            selected &&
            candidate?.agentId === binding?.agentId &&
            candidate?.bindingEpoch === binding?.bindingEpoch &&
            executionMatches
              ? candidate
              : null,
        });
        const expires = Math.min(
          Date.parse(selected?.validUntil ?? ""),
          Date.parse(status.device.expiresAt ?? ""),
        );
        if (selectedReady && Number.isFinite(expires))
          this.expiry = setTimeout(
            () => {
              if (this.active && generation === this.generation)
                this.update({ state: "expired", ready: false, selectedReady: false });
            },
            Math.min(2_147_483_647, Math.max(0, expires - Date.now())),
          );
      } catch (error) {
        if (this.active && generation === this.generation) {
          const code =
            error &&
            typeof error === "object" &&
            "code" in error &&
            Object.hasOwn(messages, String(error.code))
              ? (error.code as ConnectionErrorCode)
              : "UNAVAILABLE";
          this.update({
            state: "error",
            checkedAt: new Date().toISOString(),
            error: code,
            ready: false,
            selectedReady: false,
          });
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (generation === this.generation) {
          this.pending = null;
          this.abort = null;
        }
      }
    };
    this.pending = work();
    return this.pending;
  }
}

export function readinessMessage(view: ReadinessView, now = Date.now()): string {
  if (view.state === "checking") return "응답 준비 확인 중";
  if (view.state === "error")
    return `응답 준비 확인 실패 · ${messages[view.error ?? "UNAVAILABLE"]}`;
  if (view.state === "expired" || (view.ready && Date.parse(view.validUntil ?? "") <= now))
    return "응답 준비 확인이 만료되었습니다. 상태를 다시 확인하세요.";
  if (view.failure) return "AI에 전달되기 전 설정 검사 실패 · Mac에서 설정을 다시 확인하세요.";
  if (view.requestId)
    return "이전 결과를 확인할 수 없음 · 기록을 보존하고 다시 연결하는 복구 안내가 필요합니다. 연결을 자동으로 취소하지 않습니다.";
  if (view.roomBlocked)
    return "이 방에 미확인 요청이 있어 새 AI 질문을 시작할 수 없습니다. 이전 요청의 복구 안내를 확인하세요.";
  if (view.ready) return "AI 준비 완료";
  return "응답 준비 미확인 · 상태를 다시 확인하세요.";
}
