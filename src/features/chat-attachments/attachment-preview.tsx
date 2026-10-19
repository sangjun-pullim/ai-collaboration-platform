"use client";
/* eslint-disable @next/next/no-img-element -- Authenticated bounded blobs must stay outside public image proxies. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import { imageError } from "./client";
import { cachedImage } from "./image-cache";
import type { AttachmentView, UserScope } from "./contracts";
import { WorkflowError } from "../investigation-coordinator/contracts";
export function AttachmentPreview({
  image,
  scope,
  onAccessLost,
}: {
  image: AttachmentView;
  scope: UserScope;
  onAccessLost: () => void;
}) {
  const [loaded, setLoaded] = useState<{ id: string; revision: number; url: string } | null>(null),
    [error, setError] = useState<string | null>(null),
    [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const {
    attachmentId,
    mime,
    bytes,
    width: imageWidth,
    height: imageHeight,
    sha256,
    state,
    revision,
  } = image;
  const immutable = useMemo(
    () => ({ attachmentId, mime, bytes, width: imageWidth, height: imageHeight, sha256 }),
    [attachmentId, mime, bytes, imageWidth, imageHeight, sha256],
  );
  const requestScope = useMemo(
    () => ({ protocol: 1 as const, roomId: scope.roomId, expectedUserId: scope.expectedUserId }),
    [scope.roomId, scope.expectedUserId],
  );
  useEffect(() => {
    if (state !== "ATTACHED" || !visible) return;
    const abort = new AbortController();
    let url: string | undefined;
    void cachedImage(requestScope, immutable)
      .then((blob) => {
        if (!abort.signal.aborted) {
          url = URL.createObjectURL(blob);
          setLoaded({ id: attachmentId, revision, url });
          setError(null);
        }
      })
      .catch((failure) => {
        if (!abort.signal.aborted) {
          setLoaded(null);
          setError(imageError(failure));
          if (
            failure instanceof WorkflowError &&
            ["FORBIDDEN", "UNAUTHENTICATED"].includes(failure.code)
          )
            onAccessLost();
        }
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [immutable, requestScope, attachmentId, revision, state, onAccessLost, visible]);
  if (image.state !== "ATTACHED")
    return (
      <p role="status" className="mt-2 text-xs text-neutral-500">
        {image.state === "DELETED"
          ? "보관 기간 만료로 이미지가 정리되었습니다"
          : "이미지를 정리하고 있습니다"}
      </p>
    );
  const url =
    loaded?.id === image.attachmentId && loaded.revision === image.revision ? loaded.url : null;
  const width = Math.min(224, image.width, (200 * image.width) / image.height),
    height = (width * image.height) / image.width;
  return (
    <div className="mt-2" ref={container}>
      <button
        type="button"
        disabled={!url}
        aria-label="첨부 이미지 확대"
        onClick={() => setOpen(true)}
        className="block overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 focus-visible:outline-2 focus-visible:outline-teal-700"
        style={{ width, height }}
      >
        {url ? (
          <img
            src={url}
            alt="첨부 이미지 미리보기"
            width={image.width}
            height={image.height}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="text-xs text-neutral-500">{error ?? "이미지 불러오는 중…"}</span>
        )}
      </button>
      <Dialog open={open && !!url} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-4xl overflow-auto">
          <DialogTitle>첨부 이미지</DialogTitle>
          <DialogDescription>방 참가자에게 공유된 이미지입니다.</DialogDescription>
          {url && (
            <img
              src={url}
              alt="첨부 이미지 확대 보기"
              width={image.width}
              height={image.height}
              className="max-h-[75dvh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
