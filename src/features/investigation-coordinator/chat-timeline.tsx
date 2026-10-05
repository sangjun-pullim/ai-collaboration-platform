"use client";
import type { RefObject, UIEventHandler } from "react";
import type { PublicBinding, PublicEvent, RunSummary } from "./contracts";
import type { HistoricalRun } from "./history-state";
import { eventTarget, questionForReply, timelineEvents } from "./chat-presentation";
import { Avatar, AvatarFallback } from "../../components/ui/avatar";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
export function ChatTimeline({
  events,
  runs,
  historicalRuns,
  bindings,
  labels,
  scrollRef,
  onScroll,
  unread,
  onLatest,
}: {
  events: PublicEvent[];
  runs: RunSummary[];
  historicalRuns: HistoricalRun[];
  bindings: PublicBinding[];
  labels: Record<string, string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  unread: boolean;
  onLatest: () => void;
}) {
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
            const target = eventTarget(event, runs, bindings, historicalRuns);
            const question = questionForReply(event, events);
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
                    {event.senderKind === "AGENT" ? "AI" : event.senderAlias.slice(0, 1)}
                  </AvatarFallback>
                </Avatar>
                <article className="min-w-0 flex-1">
                  <header className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold">{event.senderAlias}</span>
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
                  {target && (
                    <div className="mt-2 space-y-1 rounded-md border bg-neutral-50 px-3 py-2 text-xs text-neutral-500">
                      <p className="break-all">
                        저장된 대상: {target.savedAlias ?? "별칭 정보 없음"} · {target.agentId} ·
                        epoch {target.epoch}
                      </p>
                      {target.current ? (
                        <p>
                          현재 연결 정보: {target.current.ownerAlias} · {target.current.runtime} ·{" "}
                          {target.current.repositoryAlias} · {target.current.sessionAlias}
                        </p>
                      ) : (
                        <p>현재 같은 연결 없음</p>
                      )}
                      <p>당시 저장소 정보 없음{target.state ? ` · ${labels[target.state]}` : ""}</p>
                      {event.requestId && <p className="break-all">요청 {event.requestId}</p>}
                    </div>
                  )}
                  {event.adoption !== "NONE" && (
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
