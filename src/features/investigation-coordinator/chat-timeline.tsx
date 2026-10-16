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
import { ChatMarkdown } from "./chat-markdown";
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
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 md:px-8 md:py-8"
        style={{ overflowAnchor: "none" }}
      >
        <ol aria-label="확정 공동 이력" className="mx-auto max-w-4xl space-y-7 md:space-y-8">
          {!events.some((event) => event.kind !== "RUN_STATE") && (
            <li className="mx-auto flex max-w-md flex-col items-center px-4 py-16 text-center md:py-24">
              <span
                aria-hidden="true"
                className="mb-5 flex size-12 items-center justify-center rounded-2xl border border-teal-800/10 bg-teal-50 text-sm font-semibold text-teal-800"
              >
                AI
              </span>
              <p className="text-lg font-semibold tracking-tight text-neutral-900">
                함께 코드를 살펴볼까요?
              </p>
              <p className="mt-2 text-sm leading-relaxed text-neutral-500">
                내 AI나 동료 AI를 선택하고 궁금한 점을 질문하세요.
              </p>
            </li>
          )}
          {timelineEvents(events).map((event) => {
            const question = questionForReply(event, events);
            const notice =
              event.kind === "HUMAN_INPUT_REQUIRED" ? projected.notices.get(event.eventId) : null;
            const questionStatuses =
              event.kind === "QUESTION" ? (projected.byQuestion.get(event.eventId) ?? []) : [];
            const sender = event.senderKind === "SYSTEM" ? "시스템" : event.senderAlias;
            const isAgent = event.senderKind === "AGENT";
            const isSystem = event.senderKind === "SYSTEM";
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
              <li key={event.eventId} className="flex min-w-0 gap-2.5 md:gap-3.5">
                <Avatar className="mt-0.5 size-8 shrink-0 rounded-xl">
                  <AvatarFallback
                    className={`rounded-xl text-[11px] font-semibold ${isAgent ? "bg-teal-800 text-white" : isSystem ? "bg-neutral-100 text-neutral-500" : "bg-neutral-200/80 text-neutral-700"}`}
                  >
                    {isAgent ? "AI" : isSystem ? "·" : sender.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <article
                  id={`message-${event.eventId}`}
                  tabIndex={-1}
                  className="min-w-0 flex-1 scroll-mt-6 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                >
                  <header className="flex min-h-7 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-sm font-semibold text-neutral-900">{sender}</span>
                    <span
                      className={`text-[11px] ${isAgent ? "text-teal-800" : "text-neutral-500"}`}
                    >
                      {isAgent ? "AI · " : ""}
                      {kind}
                    </span>
                    <span className="ml-auto text-[10px] tabular-nums text-neutral-500">
                      #{event.sequence}
                    </span>
                  </header>
                  {question && (
                    <a
                      href={`#message-${question.eventId}`}
                      aria-label={`질문 #${question.sequence} 원문 보기`}
                      className="my-2 flex min-w-0 items-center gap-3 rounded-r-lg border-l-2 border-teal-700/30 bg-neutral-100/60 px-3 py-2 text-xs text-neutral-600 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-teal-700"
                    >
                      <span className="line-clamp-1 min-w-0 flex-1">
                        질문 #{question.sequence}: {question.publicText}
                      </span>
                      <span className="shrink-0 text-[11px] text-teal-800">원문 보기</span>
                    </a>
                  )}
                  {event.publicText && (
                    <div
                      className={
                        isAgent
                          ? "pt-1 text-neutral-800 [&>div]:mt-0 [&_h1]:mt-5 [&_h2]:mt-5 [&_h3]:mt-4 [&_p]:leading-7 [&_pre]:my-4 [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-neutral-200/70 [&_pre]:bg-neutral-50"
                          : isSystem
                            ? "pt-1 text-neutral-600"
                            : "mt-1 w-fit max-w-full rounded-2xl rounded-tl-sm border border-neutral-200/60 bg-neutral-100/80 px-4 py-3 text-neutral-800 [&>div]:mt-0"
                      }
                    >
                      <ChatMarkdown text={event.publicText} messageId={event.eventId} />
                    </div>
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
                      className="mt-3 space-y-2 rounded-xl border border-neutral-200/70 bg-white/80 p-3"
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
          {projected.statuses
            .filter(
              (status) =>
                !status.question &&
                ["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"].includes(status.state),
            )
            .map((status) => (
              <li key={`result:${status.requestId}`}>
                <details className="mx-auto max-w-3xl text-xs text-neutral-600">
                  <summary className="cursor-pointer">
                    {status.target} · {status.label} · 실행 기록
                  </summary>
                  <div className="mt-2">
                    <ChatAnswerStatus status={status} />
                  </div>
                </details>
              </li>
            ))}
        </ol>
      </div>
      {unread && (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border-neutral-200 bg-white text-teal-900 shadow-md"
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
  compact = false,
}: {
  status: AnswerStatus;
  historical?: boolean;
  compact?: boolean;
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
  const details = (
    <>
      {compact && status.question && (
        <p className="whitespace-pre-wrap text-neutral-600">
          질문 #{status.question.sequence}: {status.question.publicText}
        </p>
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
    </>
  );
  return (
    <div className="min-w-0 space-y-1 text-xs [overflow-wrap:anywhere]">
      <p className="flex flex-wrap items-center gap-2 font-medium text-neutral-800">
        {status.spinning && (
          <span
            aria-hidden="true"
            className="size-3 shrink-0 animate-spin rounded-full border-2 border-teal-800/20 border-t-teal-800 motion-reduce:animate-none"
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
          질문 #{status.question.sequence}
          {!compact && `: ${status.question.publicText}`}
        </p>
      )}
      {!historical && status.freshness && (
        <p className="text-amber-800">{status.freshness} · 마지막 확인 상태를 표시합니다.</p>
      )}
      {compact ? (
        <details>
          <summary className="w-fit cursor-pointer text-neutral-500">상태 상세</summary>
          <div className="mt-2 space-y-1">{details}</div>
        </details>
      ) : (
        details
      )}
    </div>
  );
}
