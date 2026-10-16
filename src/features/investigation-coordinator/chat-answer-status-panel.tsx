"use client";

import { useState, type ReactNode } from "react";
import type { AnswerStatus } from "./chat-presentation";
import { ChatAnswerStatus } from "./chat-timeline";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";

export function ChatAnswerStatusPanel({
  statuses,
  children,
}: {
  statuses: AnswerStatus[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    statuses
      .map(
        (status) =>
          `${status.question ? `질문 #${status.question.sequence}` : status.target} · ${status.label}`,
      )
      .join(" / ") || "전송 결과 확인 필요";
  return (
    <section
      aria-label="AI 답변 상태"
      className="flex h-10 shrink-0 items-center gap-2 border-t bg-neutral-50 px-4 text-xs md:px-6"
    >
      <p role="status" className="min-w-0 flex-1 truncate" title={summary}>
        {summary}
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm">
            상세
          </Button>
        </DialogTrigger>
        <DialogContent className="max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto text-xs">
          <DialogTitle>AI 답변 상태 상세</DialogTitle>
          <DialogDescription>
            창을 닫아도 질문과 기록은 유지됩니다. 중단 접수는 실행 종료 확인과 다릅니다.
          </DialogDescription>
          {statuses.map((status) => (
            <ChatAnswerStatus key={status.requestId} status={status} />
          ))}
          {children}
        </DialogContent>
      </Dialog>
    </section>
  );
}
