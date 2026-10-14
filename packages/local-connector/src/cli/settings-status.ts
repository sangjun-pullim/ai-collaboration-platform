import { serviceOrigin } from "../central-client.ts";
import { isId } from "../contracts.ts";
import type { SettingsManagerStatus } from "../settings/manager.ts";

const failureHints: Record<string, string> = {
  UNAUTHENTICATED:
    "서버가 인증 또는 접근 권한을 거부했습니다. 웹의 내 AI 연결에서 계정과 기기 연결 상태를 확인하세요.",
  FORBIDDEN:
    "서버가 인증 또는 접근 권한을 거부했습니다. 웹의 내 AI 연결에서 계정과 기기 연결 상태를 확인하세요.",
  UNAVAILABLE: "설정 서버에 연결하지 못했습니다. 네트워크와 웹의 연결 상태를 확인하세요.",
  RUNTIME_BUSY: "다른 로컬 실행이 진행 중입니다. 기존 터미널의 실행 상태를 확인하세요.",
  PROVIDER_UNAVAILABLE: "로컬 AI를 실행하지 못했습니다. AI 설치와 로그인 상태를 확인하세요.",
  UNSUPPORTED_SETTINGS:
    "선택한 AI 설정을 사용할 수 없습니다. 웹에서 모델과 effort를 다시 선택하세요.",
  SNAPSHOT_CHANGED: "사용 가능한 AI 설정이 바뀌었습니다. 웹에서 모델과 effort를 다시 선택하세요.",
  POLICY_UNCONFIRMED: "로컬 AI의 실행 정책을 확인하지 못했습니다. 로컬 AI 설정을 확인하세요.",
  CONTEXT_UNCONFIRMED:
    "로컬 AI와 폴더의 연결을 확인하지 못했습니다. 기존 터미널과 웹의 설정을 확인하세요.",
  CLEANUP_INCOMPLETE:
    "이전 로컬 실행의 종료를 확인하지 못했습니다. 기존 터미널의 실행 상태를 확인하세요.",
  AUTHORITY_LOST:
    "이 실행의 권한을 확인하지 못했습니다. 웹의 연결과 기존 터미널 상태를 확인하세요.",
  CONFLICT: "웹과 로컬의 설정 상태가 일치하지 않습니다. 웹의 연결과 기존 터미널 상태를 확인하세요.",
  QUOTA: "연결 또는 실행 한도에 도달했습니다. 웹의 연결 상태와 한도를 확인하세요.",
};

/** One sink per interactive connect run; only the displayed action determines duplicates. */
export function createSettingsStatusSink(options: {
  origin: string;
  roomId?: string;
  write: (message: string) => void;
}): (status: SettingsManagerStatus) => void {
  const connections = new URL("/app/connections", serviceOrigin(options.origin));
  if (isId(options.roomId)) connections.searchParams.set("room", options.roomId);
  let previous: string | undefined;
  return (status) => {
    let message: string;
    if (status.reason) {
      message = Object.hasOwn(failureHints, status.reason)
        ? failureHints[status.reason]
        : "설정 상태를 확인하지 못했습니다. 웹의 연결과 기존 터미널 상태를 확인하세요.";
    } else if (status.state === "APPLIED") {
      message =
        "설정 적용 완료. 질문 가능한 상태인지는 웹 채팅방에서 확인하세요. 이 터미널을 열어 두세요.";
    } else if (status.state === "UNCONFIGURED") {
      message = "웹의 내 AI 연결에서 AI와 폴더를 설정하세요. 이 터미널을 열어 두세요.";
    } else if (status.state === "LOCAL_CONFIRMATION") {
      message = "웹의 내 AI 연결에서 모델과 effort(추론 강도)를 선택한 뒤 적용하세요.";
    } else if (["CHOOSING", "CATALOG_INTENT"].includes(status.state)) {
      message = "로컬 AI와 폴더 설정을 준비 중입니다. 로컬 폴더 선택과 확인 창을 확인하세요.";
    } else if (
      [
        "APPLYING",
        "PREPARE_INTENT",
        "PREPARED",
        "COMMIT_INTENT",
        "COMMITTED",
        "LOCAL_COMMITTED",
      ].includes(status.state)
    ) {
      message = "로컬 AI 설정을 적용하고 실행을 준비 중입니다. 이 터미널을 열어 두세요.";
    } else if (["CANCEL_INTENT", "CANCELLED"].includes(status.state)) {
      message = "설정 작업이 취소됐거나 취소를 확인 중입니다. 웹의 연결 상태를 확인하세요.";
    } else {
      message = "설정 상태를 확인하지 못했습니다. 웹의 연결과 기존 터미널 상태를 확인하세요.";
    }
    if (message === previous) return;
    previous = message;
    options.write(`${message}\n${connections.href}\n`);
  };
}
