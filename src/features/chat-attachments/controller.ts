"use client";
import { useEffect, useMemo, useState } from "react";
import { attachmentJson, attachmentViews, imageCapabilities } from "./client";
import type { AttachmentView, ImageCapability, UserScope } from "./contracts";
import { WorkflowError } from "../investigation-coordinator/contracts";
const denied = (failure: unknown) =>
  failure instanceof WorkflowError && ["FORBIDDEN", "UNAUTHENTICATED"].includes(failure.code);
export function useImageCapabilities(
  scope: UserScope,
  revision: number,
  enabled: boolean,
  onAccessLost: () => void,
) {
  const [capabilities, setCapabilities] = useState<ImageCapability[]>([]);
  const requestScope = useMemo(
    () => ({ protocol: 1 as const, roomId: scope.roomId, expectedUserId: scope.expectedUserId }),
    [scope.roomId, scope.expectedUserId],
  );
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = imageCapabilities(
          await attachmentJson("capabilities", requestScope, abort.signal),
        );
        if (!abort.signal.aborted) setCapabilities(result);
      } catch (failure) {
        if (!abort.signal.aborted) {
          setCapabilities([]);
          if (denied(failure)) onAccessLost();
        }
      }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 15000);
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [requestScope, revision, enabled, onAccessLost]);
  return enabled ? capabilities.filter((value) => Date.parse(value.validUntil) > revision) : [];
}
export function useVisibleAttachments(
  scope: UserScope,
  eventIds: string[],
  revision: number,
  enabled: boolean,
  onAccessLost: () => void,
) {
  const [views, setViews] = useState<Map<string, AttachmentView>>(new Map());
  const requestScope = useMemo(
    () => ({ protocol: 1 as const, roomId: scope.roomId, expectedUserId: scope.expectedUserId }),
    [scope.roomId, scope.expectedUserId],
  );
  const key = eventIds.slice(0, 32).join(",");
  useEffect(() => {
    if (!enabled || !key) return;
    const abort = new AbortController();
    const ids = key.split(",");
    void attachmentJson("read", requestScope, abort.signal, ids)
      .then((result) => {
        const next = attachmentViews(result, ids);
        if (!abort.signal.aborted) setViews(new Map(next.map((value) => [value.eventId, value])));
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setViews(new Map());
          if (denied(failure)) onAccessLost();
        }
      });
    return () => abort.abort();
  }, [requestScope, key, revision, enabled, onAccessLost]);
  return enabled ? views : new Map<string, AttachmentView>();
}
