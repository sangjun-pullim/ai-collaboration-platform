import {
  SettingsError,
  projectResponse,
  type SettingsResponse,
} from "../runtime-settings/contracts.ts";
import {
  setupExact,
  projectObservation,
  setupId,
  type SetupObservation,
  type StartupObservation,
  type SetupStage,
  startupStages,
  startupReasons,
} from "./setup-contracts.ts";
import { type SetupAction, type SetupBody } from "./contracts.ts";
export type SetupInspection = {
  requestId: string | null;
  expiresAt: string | null;
  startup: StartupObservation | null;
  settings: SetupObservation | null;
  runtime: SettingsResponse | null;
  device: { deviceId: string; state: string; authenticated: boolean } | null;
};
export type IssuedLaunch = {
  requestId: string;
  expiresAt: string;
  payloadHash: string;
  created: boolean;
  reissueRequired: boolean;
  key?: string;
};
export async function requestSetup(
  action: SetupAction,
  body: SetupBody,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`/api/connection-setup/${action}`, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = response.body?.getReader();
  if (!reader || response.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new SettingsError("UNAVAILABLE");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new SettingsError("UNAVAILABLE");
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
  let envelope;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SettingsError("UNAVAILABLE");
  }
  if (response.status !== 200 || !envelope?.ok) throw new SettingsError("UNAVAILABLE");
  return envelope.data;
}
export function parseInspection(value: unknown): SetupInspection {
  if (!setupExact(value, ["requestId", "expiresAt", "startup", "settings", "runtime", "device"]))
    throw new SettingsError("UNAVAILABLE");
  if (value.requestId !== null && !setupId(value.requestId)) throw new SettingsError("UNAVAILABLE");
  if (
    value.expiresAt !== null &&
    (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))
  )
    throw new SettingsError("UNAVAILABLE");
  if (value.settings !== null)
    projectObservation({
      sequence: (value.settings as SetupObservation).sequence,
      observation: value.settings,
    });
  if (value.runtime !== null) value = { ...value, runtime: projectResponse(value.runtime) };
  const result = value as unknown as SetupInspection;
  const startup = result.startup;
  if (
    startup &&
    (!setupExact(startup, [
      "attemptId",
      "sequence",
      "stage",
      "reason",
      "receivedAt",
      "authenticated",
    ]) ||
      !setupId(startup.attemptId) ||
      !Number.isSafeInteger(startup.sequence) ||
      startup.sequence < 1 ||
      startup.authenticated !== false ||
      !startupStages.includes(startup.stage) ||
      !(startup.reason === null || startupReasons.includes(startup.reason)) ||
      !Number.isFinite(Date.parse(startup.receivedAt)))
  )
    throw new SettingsError("UNAVAILABLE");
  if (
    result.device &&
    (!setupExact(result.device, ["deviceId", "state", "authenticated"]) ||
      !setupId(result.device.deviceId) ||
      !["active", "revoked", "removed"].includes(result.device.state) ||
      typeof result.device.authenticated !== "boolean")
  )
    throw new SettingsError("UNAVAILABLE");
  return result;
}
export type SetupView = {
  inspection: SetupInspection | null;
  error: boolean;
  manual: boolean;
  waiting: boolean;
  checkedAt: number;
};
export class SetupController {
  private view: SetupView = {
    inspection: null,
    error: false,
    manual: false,
    waiting: false,
    checkedAt: 0,
  };
  private listeners = new Set<() => void>();
  private active = false;
  private visible = true;
  private until = 0;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: AbortController | null = null;
  constructor(
    private readonly body: { roomId: string; requestId: string | null; deviceId: string | null },
    private readonly request = requestSetup,
    private readonly now = () => Date.now(),
  ) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(change: Partial<SetupView>) {
    this.view = { ...this.view, ...change };
    this.listeners.forEach((fn) => fn());
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.until = this.now() + 300000;
    this.update({ waiting: true });
    void this.poll();
  }
  stop() {
    this.active = false;
    this.generation++;
    this.flight?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  setVisible(visible: boolean) {
    this.visible = visible;
    if (!visible) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.flight?.abort();
    } else if (this.now() < this.until) void this.poll();
    else if (this.active) this.update({ manual: true });
  }
  async poll() {
    if (!this.active || !this.visible || this.flight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const generation = this.generation,
      abort = new AbortController();
    this.flight = abort;
    try {
      const inspection = parseInspection(await this.request("inspect", this.body, abort.signal));
      if (this.active && !abort.signal.aborted && generation === this.generation) {
        if (
          inspection.requestId !== this.body.requestId ||
          (this.body.deviceId && inspection.device?.deviceId !== this.body.deviceId)
        )
          throw new Error("CONFLICT");
        this.update({ inspection, error: false, waiting: false, checkedAt: this.now() });
      }
    } catch {
      if (this.active && !abort.signal.aborted && generation === this.generation)
        this.update({ error: true });
    } finally {
      this.flight = null;
      if (this.active && this.visible && this.now() < this.until)
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.poll();
        }, 2500);
      else if (this.active) this.update({ manual: this.now() >= this.until });
    }
  }
}

const stages: Record<SetupStage, string> = {
  FOLDER_SELECTION: "Mac에서 폴더를 선택하세요",
  SHARING_CONFIRMATION: "Mac에서 공유 범위를 확인하세요",
  MODEL_DISCOVERY: "사용 가능한 모델 확인 중",
  MODEL_SELECTION: "모델과 추론 강도를 선택하세요",
  APPLYING: "Mac의 설정 적용 확인을 기다립니다",
  CANCELLING: "Mac의 취소와 정리 확인을 기다립니다",
  FAILED: "연결 확인이 필요합니다",
};

export function setupSummary(value: SetupInspection | null, now = Date.now()) {
  const operation = value?.runtime?.operation;
  // Completion always comes from the existing authenticated immutable receipt.
  const runtime = value?.runtime;
  const applied = runtime?.applied;
  if (
    value?.device?.authenticated &&
    runtime?.current &&
    applied?.state === "APPLIED" &&
    applied.configRevision === runtime.configRevision &&
    applied.agentId === runtime.currentBinding?.agentId &&
    applied.workspaceId === runtime.currentBinding?.workspaceId &&
    applied.bindingEpoch === runtime.currentBinding?.bindingEpoch &&
    (!operation || operation.state === "APPLIED")
  )
    return "PC 설정 적용이 확인되었습니다. 채팅방에서 AI 응답 준비를 확인하세요.";
  if (
    value?.device?.authenticated &&
    operation?.state === "CANCELLED" &&
    operation.receipt?.state === "CANCELLED"
  )
    return "취소와 PC 정리가 확인되었습니다. 새 설정을 선택할 수 있습니다.";
  if (operation?.state === "COMMITTED") return "서버 저장 완료 · PC 확정 기다림";
  if (operation?.state === "APPLYING")
    return "Mac의 설정 적용 확인을 기다립니다. 같은 요청의 상태를 확인하세요.";
  if (operation?.state === "CANCELLED")
    return "Mac의 취소와 정리 확인을 기다립니다. PC 정리가 확인되어야 새 설정을 시작할 수 있습니다.";
  if (operation?.state === "FAILED" || operation?.state === "UNKNOWN")
    return "같은 요청의 상태를 확인하세요. 결과와 PC 정리가 확정되기 전에는 새 설정을 시작할 수 없습니다.";
  if (value?.settings) return stages[value.settings.stage];
  if (value?.device?.authenticated)
    return "기기 인증 확인 · 세부 상태를 받지 못했습니다. 같은 연결의 터미널을 확인하세요.";
  if (value?.expiresAt && Date.parse(value.expiresAt) <= now)
    return "연결 명령이 만료되었습니다. 새 명령을 복사하세요.";
  if (value?.startup?.stage === "FAILED")
    return "연결 시작에 실패했습니다. Mac의 터미널 원인을 확인하고 같은 연결로 재개하세요.";
  return value?.startup?.stage === "DOWNLOADING"
    ? "Mac 실행 프로그램을 준비하고 있습니다"
    : value?.startup?.stage === "CONNECTING"
      ? "Mac 연결 실행 중 · 승인과 로컬 확인을 기다립니다"
      : "Mac에서 실행 기다림 · 실행 상태가 도착하지 않았습니다";
}
