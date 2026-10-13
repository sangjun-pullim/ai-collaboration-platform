"use client";
import type { RefObject, UIEventHandler } from "react";
import type { PublicBinding, PublicEvent, RunSummary } from "./contracts";
import type { HistoricalRun } from "./history-state";
import {
  answerStatuses,
  questionForReply,
  timelineEvents,
  type AnswerStatus,
} from "./chat-presentation";
import { RunSourceView } from "./run-source-view";
import { Avatar, AvatarFallback } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
export function ChatTimeline({
  events,
  runs,
  historicalRuns,
  bindings,
  cycle = null,
  observedAt = 0,
  now,
  pollError = null,
  gap = false,
  role = "observer",
  presentation,
  labels,
  scrollRef,
  onScroll,
  unread,
  onLatest,
  onAccessLost,
}: {
  events: PublicEvent[];
  runs: RunSummary[];
  historicalRuns: HistoricalRun[];
  bindings: PublicBinding[];
  labels: Record<string, string>;
  presentation?: ReturnType<typeof answerStatuses>;
  cycle?: import("./contracts").HistoryPage["cycle"];
  observedAt?: number;
  now?: number;
  pollError?: string | null;
  gap?: boolean;
  role?: "owner" | "participant" | "observer";
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  unread: boolean;
  onLatest: () => void;
  onAccessLost: () => void;
}) {
  const context = {
    events,
    runs,
    historicalRuns,
    bindings,
    cycle,
    observedAt,
    now,
    pollError,
    gap,
    role,
  };
  const projected = presentation ?? answerStatuses(context);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        aria-label="대화 기록 스크롤"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 md:px-8"
        style={{ overflowAnchor: "none" }}
      >
        <ol aria-label="확정 공동 이력" className="mx-auto max-w-3xl space-y-6">
          {!events.some((event) => event.kind !== "RUN_STATE") && (
            <li className="py-12 text-center text-sm text-neutral-500">
              대화를 시작하세요. 내 AI 없이도 동료 AI에게 질문할 수 있습니다.
            </li>
          )}
          {timelineEvents(events).map((event) => {
            const question = questionForReply(event, events);
            const notice =
              event.kind === "HUMAN_INPUT_REQUIRED" ? projected.notices.get(event.eventId) : null;
            const questionStatuses =
              event.kind === "QUESTION" ? (projected.byQuestion.get(event.eventId) ?? []) : [];
            const sender = event.senderKind === "SYSTEM" ? "시스템" : event.senderAlias;
            const kind =
              event.kind === "SPEECH"
                ? event.senderKind === "AGENT"
                  ? "공개 조사 결과"
                  : "공동 발언"
                : event.kind === "QUESTION"
                  ? "질문"
                  : event.kind === "ANSWER"
                    ? "답변"
                    : event.kind.startsWith("ROOM_")
                      ? labels[event.roomMode ?? ""]
                      : event.kind === "HUMAN_INPUT_REQUIRED"
                        ? "사람 확인 필요"
                        : "공개 기록";
            return (
              <li key={event.eventId} className="flex min-w-0 gap-3">
                <Avatar className="mt-1 size-8 shrink-0">
                  <AvatarFallback>
                    {event.senderKind === "AGENT" ? "AI" : sender.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <article className="min-w-0 flex-1">
                  <header className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold">{sender}</span>
                    <span className="text-xs text-neutral-500">{kind}</span>
                    <span className="text-xs text-neutral-400">#{event.sequence}</span>
                  </header>
                  {question && (
                    <p className="mt-2 border-l-2 pl-3 text-xs text-neutral-500">
                      질문 #{question.sequence}: {question.publicText}
                    </p>
                  )}
                  {event.publicText && (
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                      {event.publicText}
                    </p>
                  )}
                  {notice && (
                    <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                      <p>{notice.explanation}</p>
                      {notice.statuses.map((status) => (
                        <ChatAnswerStatus key={status.requestId} status={status} historical />
                      ))}
                      {!notice.statuses.some((status) => status.guidance) && (
                        <p>{notice.guidance}</p>
                      )}
                    </div>
                  )}
                  {event.kind === "QUESTION" && (
                    <div
                      aria-label={`질문 #${event.sequence} 답변 상태`}
                      className="mt-2 space-y-2 rounded-md border bg-neutral-50 p-3"
                    >
                      {questionStatuses.length ? (
                        questionStatuses.map((status) => (
                          <ChatAnswerStatus key={status.requestId} status={status} />
                        ))
                      ) : (
                        <p className="text-xs text-neutral-500">
                          이 질문의 대상 실행 상태를 확인할 기록이 없습니다.
                        </p>
                      )}
                    </div>
                  )}
                  {(event.kind === "QUESTION" ||
                    event.kind === "ANSWER" ||
                    event.senderKind === "AGENT") && (
                    <RunSourceView
                      key={`${event.roomId}:${event.eventId}`}
                      roomId={event.roomId}
                      eventId={event.eventId}
                      bindings={bindings}
                      onAccessLost={onAccessLost}
                    />
                  )}
                  {event.adoption !== "NONE" && !notice && (
                    <Badge variant="secondary" className="mt-2 text-[10px]">
                      {labels[event.adoption]}
                    </Badge>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      </div>
      {unread && (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-sm"
          onClick={onLatest}
        >
          새 메시지 · 아래로 이동
        </Button>
      )}
    </div>
  );
}

export function ChatAnswerStatus({
  status,
  historical = false,
}: {
  status: AnswerStatus;
  historical?: boolean;
}) {
  if (status.retiredAt)
    return (
      <details className="text-xs text-neutral-600">
        <summary className="cursor-pointer">{status.target} · 답변 미확인 · 이전 기록</summary>
        <div className="mt-2 space-y-1">
          <p>마지막 상태: {status.state === "UNKNOWN" ? "실행 결과 확인 필요" : status.state}</p>
          {status.interruptStage && (
            <p>
              {status.interruptStage === "ACKNOWLEDGED" ? "중단 요청 수신 확인" : "중단 요청 접수"}{" "}
              · 종료 확인 대기
            </p>
          )}
          {status.updatedAt && (
            <p>
              마지막 상태 보고:{" "}
              <time dateTime={status.updatedAt}>
                {new Date(status.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
              </time>
            </p>
          )}
          <p>
            정리 시각:{" "}
            <time dateTime={status.retiredAt}>
              {new Date(status.retiredAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
            </time>
          </p>
          <p>{status.detail}</p>
          <p>{status.guidance}</p>
        </div>
      </details>
    );
  return (
    <div className="min-w-0 space-y-1 text-xs [overflow-wrap:anywhere]">
      <p className="flex flex-wrap items-center gap-2 font-medium text-neutral-800">
        {status.spinning && (
          <span
            aria-hidden="true"
            className="size-3 shrink-0 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 motion-reduce:animate-none"
          />
        )}
        <span>{status.target}</span>
        <span>
          {historical ? "당시 상태: " : ""}
          {status.label}
        </span>
      </p>
      {status.question && (
        <p className="line-clamp-2 text-neutral-600">
          질문 #{status.question.sequence}: {status.question.publicText}
        </p>
      )}
      {!historical && status.freshness && (
        <p className="text-amber-800">{status.freshness} · 마지막 확인 상태를 표시합니다.</p>
      )}
      {status.updatedAt ? (
        <p className="text-neutral-500">
          마지막 상태 보고:{" "}
          <time dateTime={status.updatedAt}>
            {new Date(status.updatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
          </time>
        </p>
      ) : (
        <p className="text-neutral-500">상태 확인 시각 미기록</p>
      )}
      <p className="text-neutral-600">{status.detail}</p>
      {status.guidance && <p className="text-neutral-600">{status.guidance}</p>}
      {status.guidance && status.ownConnection && (
        <a href="/app/connections" className="inline-block underline underline-offset-2">
          내 AI 연결 관리
        </a>
      )}
    </div>
  );
}
