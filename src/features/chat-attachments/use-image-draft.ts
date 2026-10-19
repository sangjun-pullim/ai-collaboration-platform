"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { prepareImage } from "./prepare";
import { imageError, uploadPreparedImage } from "./client";
import type { AttachmentDescriptor, UserScope } from "./contracts";
import { WorkflowError } from "../investigation-coordinator/contracts";

export function useImageDraft(scope: UserScope, enabled: boolean, onAccessLost: () => void) {
  const [draft, setDraft] = useState<{
    url: string;
    blob: Blob;
    descriptor?: AttachmentDescriptor;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null),
    url = useRef<string | null>(null);
  const reset = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setDraft(null);
    setBusy(false);
    setError(null);
  }, []);
  useEffect(() => {
    let active = true;
    if (!enabled)
      queueMicrotask(() => {
        if (active) reset();
      });
    return () => {
      active = false;
      abort.current?.abort();
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, [enabled, reset]);
  async function upload(blob: Blob, preview: string, controller: AbortController) {
    try {
      const descriptor = await uploadPreparedImage(scope, blob, controller.signal);
      if (abort.current === controller && !controller.signal.aborted)
        setDraft({ blob, url: preview, descriptor });
    } catch (failure) {
      if (abort.current !== controller || controller.signal.aborted) return;
      if (
        failure instanceof WorkflowError &&
        ["FORBIDDEN", "UNAUTHENTICATED"].includes(failure.code)
      ) {
        reset();
        onAccessLost();
        return;
      }
      setError(imageError(failure));
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  }
  async function select(files: File[]) {
    if (!enabled || files.length !== 1) {
      setError("이미지는 한 번에 1장만 첨부할 수 있습니다.");
      return;
    }
    reset();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      const blob = await prepareImage(files[0]);
      if (abort.current !== controller || controller.signal.aborted) return;
      const preview = URL.createObjectURL(blob);
      url.current = preview;
      setDraft({ url: preview, blob });
      await upload(blob, preview, controller);
    } catch (failure) {
      if (abort.current === controller && !controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : imageError(failure));
        setBusy(false);
      }
    }
  }
  async function retry() {
    if (!draft || busy || !enabled) return;
    const controller = new AbortController();
    abort.current = controller;
    setError(null);
    setBusy(true);
    await upload(draft.blob, draft.url, controller);
  }
  return {
    draft: enabled ? draft : null,
    busy: enabled && busy,
    error: enabled ? error : null,
    select,
    retry,
    reset,
  };
}
