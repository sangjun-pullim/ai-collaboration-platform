"use client";
import Link from "next/link";
import { useLayoutEffect, useRef, type FormEvent } from "react";
import type { PublicBinding } from "./contracts";
import { shouldSendOnEnter } from "./chat-presentation";
import { Button } from "../../components/ui/button";
import { Textarea } from "../../components/ui/textarea";
import { Send } from "lucide-react";
export function ChatComposer({
  roomId,
  readinessUnconfirmed,
  unavailableTargets = [],
  hasBlockingRun = false,
  mode,
  onMode,
  draft,
  onDraft,
  targets,
  target,
  targetValue,
  stale,
  onTarget,
  disabled,
  busy,
  pending,
  onSubmit,
}: {
  roomId: string;
  readinessUnconfirmed: boolean;
  unavailableTargets?: PublicBinding[];
  hasBlockingRun?: boolean;
  mode: "ask" | "speak";
  onMode: (mode: "ask" | "speak") => void;
  draft: string;
  onDraft: (draft: string) => void;
  targets: PublicBinding[];
  target?: PublicBinding;
  targetValue: string;
  stale: boolean;
  onTarget: (agentId: string) => void;
  disabled: boolean;
  busy: boolean;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<boolean>;
}) {
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const restoreFocus = useRef(false);
  useLayoutEffect(() => {
    const area = input.current;
    if (!area) return;
    area.style.height = "36px";
    area.style.height = `${Math.min(120, Math.max(36, area.scrollHeight))}px`;
  }, [draft]);
  useLayoutEffect(() => {
    if (restoreFocus.current && !busy && !pending) {
      restoreFocus.current = false;
      input.current?.focus();
    }
  });
  return (
    <form
      aria-label={mode === "ask" ? "AI에게 질문" : "방 참가자에게 메시지"}
      onSubmit={async (event) => {
        if (await onSubmit(event)) {
          restoreFocus.current = true;
          // Focus after the busy render has enabled the input again.
          if (input.current && !input.current.disabled) {
            restoreFocus.current = false;
            input.current.focus();
          }
        }
      }}
      className="shrink-0 bg-[#fdfdfc] px-3 py-2 md:px-6"
    >
      <div className="mx-auto max-w-4xl rounded-xl border border-neutral-200 bg-white p-2 shadow-[0_2px_12px_0_rgb(0_0_0/0.04)] transition-shadow focus-within:border-teal-600/50 focus-within:ring-2 focus-within:ring-teal-600/10 md:p-2">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b border-neutral-100 pb-1">
          <label className="min-w-0 text-xs text-neutral-500">
            <span className="sr-only">보낼 곳</span>
            <select
              className="max-w-full rounded-lg border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-xs font-medium text-neutral-700 outline-none focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-60 sm:text-sm"
              aria-label="보낼 곳"
              value={mode}
              disabled={busy || pending}
              onChange={(event) => onMode(event.target.value as "ask" | "speak")}
            >
              <option value="ask">AI에게 질문</option>
              <option value="speak">방 참가자에게 메시지</option>
            </select>
          </label>
          {mode === "ask" && (
            <label className="min-w-0 text-xs text-neutral-500">
              <span className="sr-only">직접 질문 대상</span>
              <select
                aria-label="직접 질문 대상"
                className="w-full min-w-0 rounded-lg border border-transparent bg-transparent px-2 py-1.5 text-xs font-medium text-neutral-800 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-teal-600 disabled:opacity-60 sm:text-sm"
                value={targetValue}
                disabled={busy || pending}
                onChange={(event) => onTarget(event.target.value)}
              >
                <option value="">대상을 선택하세요</option>
                {stale && (
                  <option value={targetValue}>
                    기존 대상 변경 또는 준비 보고 만료 · 다시 선택하세요
                  </option>
                )}
                {unavailableTargets.map((binding) => (
                  <option value={binding.agentId} key={binding.agentId} disabled>
                    {binding.owned ? "내 AI · " : ""}
                    {binding.ownerAlias} · {binding.runtime} · {binding.repositoryAlias} · 응답 준비
                    안 됨
                  </option>
                ))}
                {targets.map((binding) => (
                  <option value={binding.agentId} key={binding.agentId}>
                    {binding.owned ? "내 AI · " : ""}
                    {binding.ownerAlias} · {binding.runtime} · {binding.repositoryAlias} ·{" "}
                    {binding.sessionAlias}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        {mode === "ask" && !target && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1 text-[11px] text-neutral-500">
            <p>
              {readinessUnconfirmed
                ? "AI 응답 준비 확인 필요"
                : targets.length
                  ? "질문받을 AI를 선택하세요."
                  : hasBlockingRun
                    ? "이전 질문의 실행 결과 확인이 필요합니다."
                    : unavailableTargets.length
                      ? "AI는 등록되어 있지만 응답 준비가 확인되지 않았습니다."
                      : "응답 준비된 AI가 없습니다."}
            </p>
            {!targets.length && (
              <Link
                href={`/app/connections?room=${encodeURIComponent(roomId)}#ai-settings`}
                className="font-medium text-teal-800 underline underline-offset-2"
              >
                {hasBlockingRun ? "AI 연결 상태 확인" : "이 방의 AI 설정"}
              </Link>
            )}
          </div>
        )}
        {mode === "ask" && target && (
          <span className="sr-only">응답 준비 보고된 AI가 선택되었습니다.</span>
        )}
        <label className="sr-only" htmlFor="chat-message">
          {mode === "ask" ? "AI에게 보낼 질문" : "공동 발언"}
        </label>
        <Textarea
          id="chat-message"
          ref={input}
          name={mode === "ask" ? "humanQuestion" : "speech"}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          required
          maxLength={4000}
          rows={1}
          disabled={pending || busy}
          placeholder={
            mode === "ask" ? "선택한 AI에게 질문하세요…" : "방 참가자에게 메시지를 남기세요…"
          }
          className="mt-1 max-h-[120px] min-h-9 resize-none rounded-none border-0 bg-transparent px-1 py-1.5 text-sm leading-6 shadow-none placeholder:text-neutral-400 focus-visible:border-transparent focus-visible:ring-0 md:text-sm"
          aria-describedby="chat-input-help"
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              shouldSendOnEnter(
                event.key,
                event.shiftKey,
                event.nativeEvent.isComposing || composing.current,
                event.nativeEvent.keyCode,
              )
            ) {
              event.preventDefault();
              if (!disabled && draft.trim()) event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <p
            id="chat-input-help"
            className="min-w-0 flex-1 text-[11px] leading-relaxed text-neutral-500"
          >
            {mode === "ask"
              ? "질문과 답변은 참가자에게 공유됩니다."
              : "참가자에게 공유하며 AI 답변을 시작하지 않습니다."}{" "}
            <span className="sr-only">
              Enter 전송 · Shift+Enter 줄바꿈 · 한글 입력 중에는 전송하지 않습니다.
            </span>
          </p>
          <Button
            disabled={disabled || !draft.trim()}
            size="sm"
            className="shrink-0 rounded-lg bg-teal-800 px-4 text-white shadow-none hover:bg-teal-900 disabled:opacity-40"
            aria-label={mode === "ask" ? "AI에 질문 보내기" : "공동 발언 저장"}
          >
            <Send className="size-3.5" />
            {mode === "ask" ? "보내기" : "저장"}
          </Button>
        </div>
      </div>
    </form>
  );
}
