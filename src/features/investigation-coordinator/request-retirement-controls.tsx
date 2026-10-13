"use client";

import { useState } from "react";
import type { Body, Candidate, HumanAction } from "./contracts";
import { pinRetirement, retirementPinMatches, type RetirementPin } from "./direct-intents";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";

export function RequestRetirementControls({
  userId,
  roomId,
  candidate,
  disabled,
  mutate,
}: {
  userId: string;
  roomId: string;
  candidate: Candidate | null;
  disabled: boolean;
  mutate: (action: HumanAction, fields: Body) => Promise<boolean>;
}) {
  const [pin, setPin] = useState<RetirementPin | null>(null);
  const unchanged = !!pin && retirementPinMatches(pin, userId, roomId, candidate);
  const available = !!candidate?.canRetire && !disabled;
  async function confirm() {
    if (!pin || !unchanged || !available) return;
    const { requestId, cycleId, attemptId, fence, agentId, bindingEpoch, roomRevision } = pin;
    await mutate("retire", {
      requestId,
      cycleId,
      attemptId,
      fence,
      agentId,
      bindingEpoch,
      expectedRoomRevision: roomRevision,
      confirmed: true,
    });
    setPin(null);
  }
  return (
    <>
      {candidate && (
        <div className="space-y-2 text-xs">
          {!candidate.deviceRevoked && (
            <p>
              내 AI 연결에서 이전 기기를 해제하세요.{" "}
              <a href="/app/connections" className="underline">
                내 AI 연결 관리
              </a>
            </p>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!available}
            onClick={() => setPin(pinRetirement(userId, roomId, candidate))}
          >
            이전 요청 정리
          </Button>
        </div>
      )}
      <Dialog
        open={!!pin}
        onOpenChange={(open) => {
          if (!open) setPin(null);
        }}
      >
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-lg">
          <DialogTitle>이전 요청 정리</DialogTitle>
          <DialogDescription>
            이 질문을 답변 미확인 상태로 이전 기록에 보관합니다. 실행 종료를 확인한 것으로 처리하지
            않으며 질문을 다시 보내지 않습니다.
          </DialogDescription>
          {!unchanged && (
            <p role="alert" className="text-sm">
              확인 중 대상 또는 방 상태가 바뀌었습니다. 현재 요청을 다시 확인하세요.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setPin(null)}>
              취소
            </Button>
            {!unchanged && (
              <Button
                variant="outline"
                disabled={!available}
                onClick={() => candidate && setPin(pinRetirement(userId, roomId, candidate))}
              >
                현재 요청 다시 확인
              </Button>
            )}
            <Button disabled={!unchanged || !available} onClick={() => void confirm()}>
              이전 기록에 보관
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
