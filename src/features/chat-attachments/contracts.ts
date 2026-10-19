import { WorkflowError } from "../investigation-coordinator/contracts.ts";

export const IMAGE_BUCKET = "chat-images";
export class AttachmentQuotaError extends WorkflowError {
  constructor(readonly reason: "STORAGE_PROTECTED" | "TOO_MANY_PENDING" | "EGRESS_LIMIT") {
    super("QUOTA");
  }
}
export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_IMAGE_PIXELS = 4_194_304;
export const MAX_IMAGE_EDGE = 2048;
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];
export type AttachmentDescriptor = {
  attachmentId: string;
  mime: ImageMime;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
};
export type AttachmentState = "RESERVED" | "READY" | "ATTACHED" | "DELETING" | "DELETED";
export type AttachmentView = AttachmentDescriptor & {
  eventId: string;
  state: "ATTACHED" | "DELETING" | "DELETED";
  revision: number;
  deletedAt: string | null;
};
export type UserScope = { protocol: 1; roomId: string; expectedUserId: string };
export type ImageCapability = {
  agentId: string;
  bindingEpoch: number;
  imageInputVersion: 1;
  validUntil: string;
};
export function capabilityBody(input: unknown) {
  const body = exactBody(input, ["protocol", "agentId", "bindingEpoch", "imageInputVersion"]);
  if (
    body.imageInputVersion !== 1 ||
    !Number.isSafeInteger(body.bindingEpoch) ||
    (body.bindingEpoch as number) < 1
  )
    throw new WorkflowError("INVALID_BODY");
  return body;
}
export type DeviceDownload = {
  protocol: 1;
  attachmentId: string;
  agentId: string;
  bindingEpoch: number;
  requestId: string;
  attemptId: string;
  fence: number;
  imageInputVersion: 1;
};
export function isId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
export function objectKey(id: string): string {
  if (!isId(id)) throw new WorkflowError("INVALID_BODY");
  return `${id.toLowerCase()}/image`;
}
export function exactBody(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WorkflowError("INVALID_BODY");
  const body = input as Record<string, unknown>;
  if (
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(body, key)) ||
    body.protocol !== 1
  )
    throw new WorkflowError("INVALID_BODY");
  for (const key of keys) {
    if (key.endsWith("Id") && !isId(body[key])) throw new WorkflowError("INVALID_BODY");
  }
  return body;
}
export function userScope(input: unknown): UserScope {
  return exactBody(input, ["protocol", "roomId", "expectedUserId"]) as UserScope;
}
export function readBody(input: unknown): UserScope & { eventIds: string[] } {
  const body = exactBody(input, ["protocol", "roomId", "expectedUserId", "eventIds"]);
  if (
    !Array.isArray(body.eventIds) ||
    body.eventIds.length > 32 ||
    body.eventIds.some((id) => !isId(id)) ||
    new Set(body.eventIds).size !== body.eventIds.length
  )
    throw new WorkflowError("INVALID_BODY");
  return body as UserScope & { eventIds: string[] };
}
export function deviceDownloadBody(input: unknown): DeviceDownload {
  const body = exactBody(input, [
    "protocol",
    "attachmentId",
    "agentId",
    "bindingEpoch",
    "requestId",
    "attemptId",
    "fence",
    "imageInputVersion",
  ]);
  if (
    body.imageInputVersion !== 1 ||
    [body.bindingEpoch, body.fence].some((n) => !Number.isSafeInteger(n) || (n as number) < 1)
  )
    throw new WorkflowError("INVALID_BODY");
  return body as DeviceDownload;
}
export function descriptor(input: unknown): AttachmentDescriptor {
  const value = input as AttachmentDescriptor;
  if (
    !value ||
    !isId(value.attachmentId) ||
    !IMAGE_MIMES.includes(value.mime) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(value.width) ||
    !Number.isSafeInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > MAX_IMAGE_EDGE ||
    value.height > MAX_IMAGE_EDGE ||
    value.width * value.height > MAX_IMAGE_PIXELS ||
    !/^[a-f0-9]{64}$/.test(value.sha256)
  )
    throw new WorkflowError("UNAVAILABLE");
  return {
    attachmentId: value.attachmentId,
    mime: value.mime,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
    sha256: value.sha256,
  };
}
