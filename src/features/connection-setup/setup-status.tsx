"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Button } from "../../components/ui/button";
import { SetupController, setupSummary, type SetupInspection } from "./setup-controller";
import type { SetupReason } from "./setup-contracts";
const reasons: Record<SetupReason, string> = {
  UNCONFIRMED: "원인을 아직 확인하지 못했습니다.",
  TIMEOUT: "폴더 선택 시간이 지났습니다.",
  DENIED: "폴더 접근 권한을 확인하세요.",
  UNSUPPORTED: "이 Mac에서 폴더 선택을 지원하지 않습니다.",
  FAILED: "폴더 선택에 실패했습니다.",
  SHARING_UNCONFIRMED: "공유 확인이 완료되지 않았습니다.",
  PROVIDER_UNAVAILABLE: "AI 프로그램 준비에 실패했습니다. Mac의 프로그램 상태를 확인하세요.",
  RUNTIME_BUSY:
    "이전 연결 또는 AI 설정이 정리되지 않았습니다. 터미널의 오류와 연결 실패 진단 파일을 확인하세요.",
  SNAPSHOT_CHANGED: "모델 목록이 변경되었습니다. 같은 요청의 정리 완료를 확인하세요.",
  POLICY_UNCONFIRMED: "공유 정책 확인이 필요합니다.",
  CONTEXT_UNCONFIRMED: "이전 실행 확인이 필요합니다.",
  CLEANUP_INCOMPLETE: "PC 정리를 확인하지 못했습니다. 같은 요청의 상태를 확인하세요.",
  FORBIDDEN: "이 방의 참가 권한과 연결한 계정을 확인하세요. 같은 계정과 방으로 연결을 재개하세요.",
  CONFLICT:
    "연결이나 승인 상태가 변경되었습니다. 같은 연결의 상태를 확인한 뒤 새 명령을 복사하세요.",
  UNAUTHENTICATED:
    "기기 인증을 확인할 수 없습니다. 연결 옵션에서 새 승인으로 다시 연결을 선택하세요.",
  UNAVAILABLE: "Mac에서 서버 통신을 확인하지 못했습니다.",
};
function startupReason(reason: string | null): string | null {
  if (!reason) return null;
  if (Object.hasOwn(reasons, reason)) return reasons[reason as SetupReason];
  const messages: Record<string, string> = {
    MACOS_REQUIRED: "이 명령은 Mac의 터미널에서 실행하세요.",
    MACOS_13_5_REQUIRED: "macOS 13.5 이상에서 실행하세요.",
    MACOS_VERSION: "Mac의 운영체제 버전을 확인하세요.",
    UNSUPPORTED_ARCHITECTURE: "지원하는 Mac의 실행 환경인지 확인하세요.",
    DOWNLOAD_FAILED: "Mac의 네트워크 연결을 확인하고 같은 연결로 재개하세요.",
    DOWNLOAD_DIGEST: "실행 파일 검증에 실패했습니다. 새 명령을 복사하세요.",
    DOWNLOAD_SIZE: "실행 파일의 크기를 확인하지 못했습니다. 새 명령을 복사하세요.",
    REDIRECT_OR_HTTP_ERROR:
      "다운로드 서버에 접근하지 못했습니다. Mac의 네트워크 연결을 확인하세요.",
    INVALID_DESCRIPTION: "명령 설명서가 만료되었거나 검증되지 않았습니다. 새 명령을 복사하세요.",
    EXPIRED: "명령이 만료되었습니다. 새 명령을 복사하세요.",
    INVALID_MANIFEST: "실행 파일 안내를 검증하지 못했습니다. 새 명령을 복사하세요.",
    INVALID_ARCHIVE: "실행 파일을 검증하지 못했습니다. 새 명령을 복사하세요.",
    RUNTIME_ARCHIVE: "Node 실행 프로그램을 준비하지 못했습니다. Mac의 터미널을 확인하세요.",
    RUNTIME_FILE: "Node 실행 프로그램을 확인하지 못했습니다. Mac의 터미널을 확인하세요.",
    RUNTIME_VERSION: "Node 실행 프로그램의 버전을 확인하지 못했습니다. Mac의 터미널을 확인하세요.",
  };
  return messages[reason] ?? "Mac의 터미널에서 연결 원인을 확인하세요.";
}
function commandSummary(inspection: SetupInspection | null, now: number): string {
  if (inspection?.expiresAt && Date.parse(inspection.expiresAt) <= now)
    return "복사한 명령이 만료되었습니다. 새 명령을 복사하세요.";
  switch (inspection?.startup?.stage) {
    case "FAILED":
      return "이번 명령 실행을 시작하지 못했습니다.";
    case "CONNECTING":
      return "복사한 명령 실행 중 · 웹 승인과 Mac 확인을 기다립니다";
    case "DOWNLOADING":
      return "복사한 명령의 Mac 실행 프로그램을 준비하고 있습니다";
    default:
      return "복사한 명령의 실행 보고를 기다립니다. 실행한 Mac의 터미널을 확인하세요.";
  }
}
export function SetupStatus({
  roomId,
  requestId = null,
  deviceId = null,
  onRetry,
  onFreshApproval,
}: {
  roomId: string;
  requestId?: string | null;
  deviceId?: string | null;
  onRetry?: () => void;
  onFreshApproval?: () => void;
}) {
  const controller = useMemo(
    () => new SetupController({ roomId, requestId, deviceId }),
    [roomId, requestId, deviceId],
  );
  const view = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    const changed = () => controller.setVisible(document.visibilityState === "visible");
    changed();
    controller.start();
    document.addEventListener("visibilitychange", changed);
    return () => {
      controller.stop();
      document.removeEventListener("visibilitychange", changed);
    };
  }, [controller]);
  return (
    <SetupProgress
      inspection={view.inspection}
      now={view.checkedAt}
      error={view.error}
      manual={view.manual}
      commandOnly={requestId !== null && deviceId === null}
      onRetry={onRetry}
      onFreshApproval={onFreshApproval}
      onCheck={() => {
        void controller.poll();
      }}
    />
  );
}
export function SetupProgress({
  inspection,
  now = 0,
  error = false,
  manual = false,
  onCheck,
  onRetry,
  onFreshApproval,
  fallback,
  embedded = false,
  commandOnly = false,
}: {
  inspection: SetupInspection | null;
  fallback?: string;
  embedded?: boolean;
  commandOnly?: boolean;
  now?: number;
  error?: boolean;
  manual?: boolean;
  onCheck: () => void;
  onRetry?: () => void;
  onFreshApproval?: () => void;
}) {
  const needsFreshApproval =
    commandOnly &&
    inspection?.startup?.stage === "FAILED" &&
    inspection.startup.reason === "UNAUTHENTICATED" &&
    !!onFreshApproval;
  const observation = commandOnly
    ? inspection?.startup
    : (inspection?.settings ?? inspection?.startup);
  return (
    <div
      role={embedded ? undefined : "status"}
      aria-label={commandOnly ? "복사한 명령의 실행 상태" : "현재 연결 진행"}
      className={`space-y-2 rounded-lg p-3 text-sm ${observation?.stage === "FAILED" || error ? "border border-amber-200 bg-amber-50" : "bg-neutral-50"}`}
    >
      {commandOnly && (
        <p className="text-xs font-medium text-neutral-500">
          명령 실행 보고 · 기기 연결 확인과 별도
        </p>
      )}
      <p>
        {error
          ? "서버에서 상태를 확인하지 못했습니다. 같은 요청의 상태를 다시 확인하세요."
          : commandOnly
            ? commandSummary(inspection, now)
            : inspection?.settings || inspection?.startup || !fallback
              ? setupSummary(inspection, now)
              : fallback}
      </p>

      {observation && (
        <p className="text-xs text-neutral-500">
          마지막 보고: {new Date(observation.receivedAt).toLocaleString("ko-KR")}
        </p>
      )}
      {!commandOnly && inspection?.settings?.reason && <p>{reasons[inspection.settings.reason]}</p>}
      {(commandOnly || !inspection?.device?.authenticated) &&
        inspection?.startup?.stage === "FAILED" && (
          <p>{startupReason(inspection.startup.reason)}</p>
        )}
      {needsFreshApproval && (
        <Button variant="outline" onClick={onFreshApproval}>
          새 승인으로 다시 연결
        </Button>
      )}
      {!needsFreshApproval &&
        onRetry &&
        (inspection?.startup?.stage === "FAILED" ||
          (inspection?.expiresAt && Date.parse(inspection.expiresAt) <= now)) && (
          <Button variant="outline" onClick={onRetry}>
            새 명령 복사
          </Button>
        )}
      {(manual || error || observation?.stage === "FAILED") && (
        <Button variant="outline" onClick={onCheck}>
          상태 다시 확인
        </Button>
      )}
    </div>
  );
}
