"use client";
/* eslint-disable @next/next/no-img-element -- Local bounded blob previews require no image proxy. */
import { useRef } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "../../components/ui/button";
export function AttachmentPicker({
  url,
  disabled,
  busy,
  error,
  onSelect,
  onRemove,
  onRetry,
}: {
  url?: string;
  disabled: boolean;
  busy: boolean;
  error: string | null;
  onSelect: (files: File[]) => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="이미지 파일 선택"
        disabled={disabled}
        onChange={(event) => {
          if (event.target.files?.length) onSelect(Array.from(event.target.files));
          event.target.value = "";
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled || busy}
        aria-label="이미지 첨부"
        onClick={() => input.current?.click()}
      >
        <Paperclip className="size-4" />
        <span className="sr-only">이미지 첨부</span>
      </Button>
      {url && (
        <div className="flex items-center gap-2">
          <img
            src={url}
            alt="전송 전 첨부 이미지"
            width={48}
            height={48}
            className="size-12 rounded border object-contain"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onRemove}
            aria-label="첨부 이미지 제거"
          >
            <X className="size-4" />
          </Button>
        </div>
      )}
      {busy && (
        <span role="status" className="text-xs text-neutral-500">
          이미지 준비·업로드 중…
        </span>
      )}
      {url && (
        <p className="basis-full text-xs text-neutral-500">
          오래된 이미지는 저장 공간 확보를 위해 정리될 수 있습니다.
          {busy && " 업로드 중 창을 닫으면 이미지를 다시 선택해야 합니다."}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
          {url && (
            <Button
              type="button"
              variant="link"
              size="sm"
              disabled={disabled || busy}
              onClick={onRetry}
            >
              업로드 재시도
            </Button>
          )}
        </p>
      )}
    </div>
  );
}
