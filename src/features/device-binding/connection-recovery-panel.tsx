"use client";

import { useState } from "react";
import { Button } from "../../components/ui/button";
import { RequestRetirementControls } from "../investigation-coordinator/request-retirement-controls";
import type {
  ConnectionRecoveryController,
  RecoveryTarget,
  RecoveryView,
} from "./connection-recovery-controller";

export function ConnectionRecoveryPanel({
  userId,
  roomId,
  availableTarget,
  view,
  controller,
  onOpen,
  onSelectTarget,
  onPrepareApproval,
}: {
  userId: string;
  roomId: string;
  availableTarget: RecoveryTarget | null;
  view: RecoveryView;
  controller: ConnectionRecoveryController;
  onOpen: (target: RecoveryTarget) => void;
  onSelectTarget: (deviceId: string) => void;
  onPrepareApproval: () => void;
}) {
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const target =
    view.target?.userId === userId && view.target.roomId === roomId ? view.target : null;
  const targetKey = target
    ? JSON.stringify([target.userId, target.roomId, target.deviceId, target.candidate])
    : "";
  if (!target)
    return availableTarget ? (
      <Button variant="outline" onClick={() => onOpen(availableTarget)}>
        기록을 보존하고 다시 연결
      </Button>
    ) : null;
  if (view.phase === "retired")
    return (
      <section
        aria-label="이전 요청 보존 복구"
        className="space-y-2 rounded-lg bg-muted/50 p-3 text-sm"
      >
        <p>이전 기록 보관 완료 · 새 연결과 AI 설정·응답 준비 확인이 필요합니다.</p>
        {!view.active && (
          <Button variant="outline" onClick={() => onSelectTarget(target.deviceId)}>
            원래 복구 대상 선택
          </Button>
        )}
        {view.error && <p role="alert">{view.error}</p>}
        <Button disabled={!view.active || view.busy} onClick={onPrepareApproval}>
          원본을 보존하고 새 승인 명령 준비
        </Button>
      </section>
    );
  return (
    <section
      aria-label="이전 요청 보존 복구"
      className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm"
    >
      <h3 className="font-semibold">이전 결과를 확인할 수 없음 · 기록을 보존하고 다시 연결</h3>
      <p className="break-all">
        대상 방: {target.roomId} · 원래 기기: {target.deviceAlias} ({target.deviceId})
      </p>
      <p className="break-all">
        보존할 요청: {target.candidate.requestId} · AI: {target.candidate.agentId} · 연결 버전:{" "}
        {target.candidate.bindingEpoch}
      </p>
      <p>
        이전 질문과 UNKNOWN 기록을 보존합니다. 실행 종료를 확인한 것으로 처리하지 않으며 질문을
        자동으로 다시 보내지 않습니다.
      </p>
      <p>
        연결 취소는 서버 인증을 해제합니다. 원래 Mac 터미널이 실행 중이면 사용자가 Ctrl+C로 종료해야
        합니다. 브라우저는 종료 여부를 확인할 수 없습니다.
      </p>
      {!view.active && (
        <div role="status">
          <p>
            선택이 바뀌어 이 대상의 복구를 보류했습니다. 원래 기기를 선택한 뒤 상태를 다시
            확인하세요.
          </p>
          <Button variant="outline" onClick={() => onSelectTarget(target.deviceId)}>
            원래 복구 대상 선택
          </Button>
        </div>
      )}
      <div role="status" aria-live="polite">
        {view.busy
          ? "해당 단계의 서버 결과 확인 중…"
          : view.phase === "retire-ready"
            ? "원래 기기의 연결 취소 확인 · 서버에서 이전 요청 정리 가능 확인"
            : view.phase === "retire-unconfirmed"
              ? "이전 요청 정리 결과 미확정 · 같은 요청의 결과를 확인하세요."
              : view.phase === "needs-check"
                ? "이 단계의 결과를 다시 확인해야 합니다."
                : "연결 취소 전 · 아래 대상을 명시적으로 확인하세요."}
      </div>
      {view.checkedAt && <p>서버 확인 시각: {new Date(view.checkedAt).toLocaleString("ko-KR")}</p>}
      {view.error && <p role="alert">{view.error}</p>}
      {view.phase === "review" && (
        <>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={confirmation === targetKey}
              disabled={!view.active || view.busy}
              onChange={(event) => setConfirmation(event.target.checked ? targetKey : null)}
            />
            위 방의 원래 본인 기기 하나만 취소하고, 표시한 요청의 원본 기록을 보존하겠습니다.
          </label>
          <Button
            disabled={!view.active || view.busy || confirmation !== targetKey}
            onClick={() => {
              setConfirmation(null);
              void controller.revoke(true);
            }}
          >
            확인한 기기만 연결 취소
          </Button>
        </>
      )}
      <Button
        variant="outline"
        disabled={!view.active || view.busy}
        onClick={() => {
          setConfirmation(null);
          void controller.check();
        }}
      >
        복구 단계 상태 다시 확인
      </Button>
      {view.phase === "retire-ready" && (
        <RequestRetirementControls
          userId={target.userId}
          roomId={target.roomId}
          candidate={view.candidate}
          disabled={!view.active || view.busy}
          mutate={controller.mutate}
        />
      )}
      {view.phase === "retire-unconfirmed" && (
        <Button
          variant="outline"
          disabled={!view.active || view.busy}
          onClick={() => void controller.retryRetirement()}
        >
          같은 정리 요청 결과 확인
        </Button>
      )}
    </section>
  );
}
