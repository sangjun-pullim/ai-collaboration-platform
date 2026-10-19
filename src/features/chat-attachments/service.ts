import { createHash } from "node:crypto";
import {
  AttachmentQuotaError,
  descriptor,
  type AttachmentDescriptor,
  type UserScope,
} from "./contracts.ts";
import { canonicalImage } from "./validation.ts";
import { cleanupImages } from "./cleanup.ts";
import type { AttachmentRpc, ImageStorage } from "./quota.ts";
import { WorkflowError } from "../investigation-coordinator/contracts.ts";

export async function uploadImage(
  userRpc: AttachmentRpc,
  adminRpc: AttachmentRpc,
  storage: ImageStorage,
  scope: UserScope,
  bytes: Buffer,
  mime: string,
): Promise<AttachmentDescriptor> {
  // Authorization precedes both privileged Storage access and decoder work.
  await userRpc("chat_attachment_authorize_upload", { p_body: scope });
  const image = await canonicalImage(bytes, mime);
  const { data, ...metadata } = image;
  const reserve = () =>
    userRpc("chat_attachment_reserve", { p_body: { ...scope, ...metadata } }) as Promise<{
      attachmentId?: string;
      needsCleanup?: boolean;
      reason?: string;
    }>;
  let reservation = await reserve();
  if (reservation.needsCleanup) {
    await cleanupImages(adminRpc, storage);
    reservation = await reserve();
  }
  if (!reservation.attachmentId)
    throw new AttachmentQuotaError(
      reservation.reason === "TOO_MANY_PENDING" ? "TOO_MANY_PENDING" : "STORAGE_PROTECTED",
    );
  const result = descriptor({ attachmentId: reservation.attachmentId, ...metadata });
  // No catch releases the reservation: an upload response can be lost after a write.
  await storage.put(result.attachmentId, data, image.mime);
  await adminRpc("chat_attachment_finalize", { p_id: result.attachmentId });
  return result;
}
export async function downloadImage(authorize: () => Promise<unknown>, storage: ImageStorage) {
  // This RPC atomically verifies identity/assignment, leases the image, and charges egress.
  let grant: { descriptor: unknown; leaseId: string };
  try {
    grant = (await authorize()) as typeof grant;
  } catch (error) {
    if (error instanceof WorkflowError && error.code === "QUOTA")
      throw new AttachmentQuotaError("EGRESS_LIMIT");
    throw error;
  }
  const image = descriptor(grant.descriptor);
  const bytes = await storage.get(image.attachmentId);
  if (
    bytes.length !== image.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== image.sha256
  )
    throw new WorkflowError("UNAVAILABLE");
  return { bytes, descriptor: image };
}
