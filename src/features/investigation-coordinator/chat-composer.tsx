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
      className="shrink-0 border-t bg-white px-4 py-3 md:px-6"
    >
      <div className="mx-auto max-w-4xl space-y-2">
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <label className="min-w-0 text-xs text-neutral-500">
            <span className="sr-only">보낼 곳</span>
            <select
              className="max-w-full rounded-md border px-2 py-1.5 text-sm text-neutral-800"
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
                className="w-full min-w-0 rounded-md border px-2 py-1.5 text-sm text-neutral-800"
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
          <p className="text-xs text-neutral-500">
            {target
              ? `${target.owned ? "내 AI · " : ""}${target.ownerAlias} · ${target.runtime} · ${target.repositoryAlias} · ${target.sessionAlias} · 응답 준비 보고`
              : targets.length
                ? "질문받을 AI를 선택하세요."
                : readinessUnconfirmed
                  ? "AI 응답 준비 확인 필요"
                  : "응답 준비된 AI가 없습니다."}
          </p>
        )}
        {mode === "ask" && !targets.length && (
          <div className="space-y-1 text-xs text-neutral-600">
            <p>PC 연결 후 AI와 폴더 설정을 마치세요.</p>
            <Link
              href={`/app/connections?room=${encodeURIComponent(roomId)}#ai-settings`}
              className="inline-block underline"
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
          className="max-h-32 min-h-14 resize-y"
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
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="chat-input-help" className="min-w-0 flex-1 text-[11px] text-neutral-500">
            {mode === "ask"
              ? "질문과 답변은 참가자에게 공유됩니다."
              : "참가자에게 공유하며 AI 답변을 시작하지 않습니다."}{" "}
            <span className="sr-only md:not-sr-only">
              Enter 전송 · Shift+Enter 줄바꿈 · 한글 입력 중에는 전송하지 않습니다.
            </span>
          </p>
          <Button
            disabled={disabled || !draft.trim()}
            size="sm"
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
