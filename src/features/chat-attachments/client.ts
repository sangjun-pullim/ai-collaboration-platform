import {
  descriptor,
  MAX_IMAGE_BYTES,
  type AttachmentDescriptor,
  type AttachmentView,
  type ImageCapability,
  type UserScope,
} from "./contracts.ts";
import { WorkflowError } from "../investigation-coordinator/contracts.ts";

export const imageOnlyText = (mode: "speak" | "ask", text: string) =>
  text.trim() || (mode === "speak" ? "이미지를 첨부했습니다" : "첨부 이미지를 설명해주세요");
async function jsonResponse(response: Response) {
  if (!response.headers.get("content-type")?.startsWith("application/json"))
    throw new WorkflowError("UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowError("UNAVAILABLE");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 32768) {
        await reader.cancel();
        throw new WorkflowError("UNAVAILABLE");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!response.ok || result?.ok !== true) {
    const code = result?.error?.code;
    if (
      [
        "FORBIDDEN",
        "UNAUTHENTICATED",
        "NOT_FOUND",
        "CONFLICT",
        "QUOTA",
        "INVALID_BODY",
        "BODY_TOO_LARGE",
      ].includes(code)
    )
      throw Object.assign(new WorkflowError(code), { reason: result?.error?.reason });
    throw new WorkflowError("UNAVAILABLE");
  }
  return result.data as unknown;
}
export async function attachmentJson(
  action: "read" | "capabilities",
  scope: UserScope,
  signal: AbortSignal,
  eventIds?: string[],
) {
  return jsonResponse(
    await fetch(`/api/chat-attachments/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...scope, ...(eventIds ? { eventIds } : {}) }),
      signal,
      cache: "no-store",
      redirect: "error",
    }),
  );
}
export async function uploadPreparedImage(
  scope: UserScope,
  blob: Blob,
  signal: AbortSignal,
): Promise<AttachmentDescriptor> {
  return descriptor(
    await jsonResponse(
      await fetch("/api/chat-attachments/upload", {
        method: "POST",
        headers: {
          "Content-Type": blob.type,
          "X-Room-Id": scope.roomId,
          "X-Expected-User-Id": scope.expectedUserId,
        },
        body: blob,
        signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
        cache: "no-store",
        redirect: "error",
      }),
    ),
  );
}
export function attachmentViews(input: unknown, ids: string[]): AttachmentView[] {
  if (!Array.isArray(input) || input.length > 32) throw new WorkflowError("UNAVAILABLE");
  const seen = new Set<string>();
  return input.map((value) => {
    const image = descriptor(value);
    if (
      !ids.includes(value.eventId) ||
      seen.has(value.eventId) ||
      !["ATTACHED", "DELETING", "DELETED"].includes(value.state) ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < 1 ||
      (value.state === "DELETED"
        ? typeof value.deletedAt !== "string" || !Number.isFinite(Date.parse(value.deletedAt))
        : value.deletedAt !== null)
    )
      throw new WorkflowError("UNAVAILABLE");
    seen.add(value.eventId);
    return {
      ...image,
      eventId: value.eventId,
      state: value.state,
      revision: value.revision,
      deletedAt: value.deletedAt,
    };
  });
}
export function imageCapabilities(input: unknown): ImageCapability[] {
  if (!Array.isArray(input) || input.length > 20) throw new WorkflowError("UNAVAILABLE");
  return input.filter(
    (value) =>
      typeof value?.agentId === "string" &&
      Number.isSafeInteger(value.bindingEpoch) &&
      value.bindingEpoch > 0 &&
      value.imageInputVersion === 1 &&
      typeof value.validUntil === "string" &&
      Number.isFinite(Date.parse(value.validUntil)),
  );
}
export async function imageBlob(
  scope: UserScope,
  image: AttachmentDescriptor,
  signal: AbortSignal,
): Promise<Blob> {
  const response = await fetch(
    `/api/chat-attachments/content/${image.attachmentId}?${new URLSearchParams({ roomId: scope.roomId, expectedUserId: scope.expectedUserId })}`,
    { signal, cache: "no-store", redirect: "error" },
  );
  if (!response.ok) {
    await jsonResponse(response);
    throw new WorkflowError("UNAVAILABLE");
  }
  if (
    response.headers.get("content-type") !== image.mime ||
    response.headers.get("x-content-sha256") !== image.sha256
  ) {
    await response.body?.cancel();
    throw new WorkflowError("UNAVAILABLE");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new WorkflowError("UNAVAILABLE");
  let size = 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > MAX_IMAGE_BYTES || size > image.bytes) {
        await reader.cancel();
        throw new WorkflowError("UNAVAILABLE");
      }
      chunks.push(new Uint8Array(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (size !== image.bytes) throw new WorkflowError("UNAVAILABLE");
  const blob = new Blob(chunks, { type: image.mime });
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== image.sha256) throw new WorkflowError("UNAVAILABLE");
  return blob;
}
export function imageError(error: unknown) {
  if (error instanceof WorkflowError) {
    if (error.code === "QUOTA")
      return (error as WorkflowError & { reason?: string }).reason === "EGRESS_LIMIT"
        ? "이번 달 이미지 전송 한도에 도달했습니다. 텍스트 채팅은 계속할 수 있습니다."
        : "이미지 저장 한도에 도달했습니다. 보호 중인 이미지가 있어 정리할 수 없습니다. 나중에 다시 시도하세요.";
    if (error.code === "INVALID_BODY" || error.code === "BODY_TOO_LARGE")
      return "정적 PNG, JPEG, WebP 이미지만 첨부할 수 있습니다. 파일 형식과 크기를 확인하세요.";
    if (error.code === "CONFLICT" || error.code === "NOT_FOUND")
      return "이미지 보관 기간이 지났습니다. 이미지를 다시 첨부하세요.";
  }
  return "이미지를 처리하지 못했습니다. 연결을 확인하고 다시 시도하세요.";
}
