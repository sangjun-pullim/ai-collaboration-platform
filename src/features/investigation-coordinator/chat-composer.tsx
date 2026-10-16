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
      className="shrink-0 bg-[#fdfdfc] px-3 pb-3 pt-2 md:px-6 md:pb-5"
    >
      <div className="mx-auto max-w-4xl rounded-2xl border border-neutral-200 bg-white p-3 shadow-[0_2px_12px_0_rgb(0_0_0/0.04)] transition-shadow focus-within:border-teal-600/50 focus-within:ring-2 focus-within:ring-teal-600/10 md:p-4">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b border-neutral-100 pb-3">
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
        {mode === "ask" && (
          <p className={`pt-2 text-[11px] ${target ? "text-teal-800" : "text-neutral-500"}`}>
            {target
              ? "응답 준비 보고된 AI가 선택되었습니다."
              : targets.length
                ? "질문받을 AI를 선택하세요."
                : readinessUnconfirmed
                  ? "AI 응답 준비 확인 필요"
                  : "응답 준비된 AI가 없습니다."}
          </p>
        )}
        {mode === "ask" && !targets.length && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
            <p>PC 연결 후 AI와 폴더 설정을 마치세요.</p>
            <Link
              href={`/app/connections?room=${encodeURIComponent(roomId)}#ai-settings`}
              className="inline-block font-medium text-teal-800 underline underline-offset-2"
            >
              이 방의 AI 설정
            </Link>
          </div>
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
          rows={2}
          disabled={pending || busy}
          placeholder={
            mode === "ask" ? "선택한 AI에게 질문하세요…" : "방 참가자에게 메시지를 남기세요…"
          }
          className="mt-2 max-h-32 min-h-16 resize-y rounded-none border-0 bg-transparent px-1 py-2 text-sm leading-relaxed shadow-none placeholder:text-neutral-400 focus-visible:border-transparent focus-visible:ring-0 md:text-sm"
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
        <div className="mt-2 flex items-end justify-between gap-3">
          <p
            id="chat-input-help"
            className="min-w-0 flex-1 text-[11px] leading-relaxed text-neutral-500"
          >
            {mode === "ask"
              ? "질문과 답변은 참가자에게 공유됩니다."
              : "참가자에게 공유하며 AI 답변을 시작하지 않습니다."}{" "}
            <span className="sr-only md:not-sr-only md:block">
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
