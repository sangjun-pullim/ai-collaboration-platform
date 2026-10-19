import { isId } from "./contracts.ts";
import {
  CLEANUP_BATCH,
  CLEANUP_MILLISECONDS,
  type AttachmentRpc,
  type ImageStorage,
} from "./quota.ts";
import { WorkflowError } from "../investigation-coordinator/contracts.ts";

export async function cleanupImages(rpc: AttachmentRpc, storage: ImageStorage, now = Date.now) {
  const deadline = now() + CLEANUP_MILLISECONDS;
  const claim = (await rpc(
    "chat_attachment_cleanup_claim",
    { p_limit: CLEANUP_BATCH },
    { timeoutMilliseconds: CLEANUP_MILLISECONDS },
  )) as {
    leaseId: string | null;
    attachmentIds: string[];
  };
  if (!claim.leaseId) return { deleted: 0, pending: 0 };
  if (
    !isId(claim.leaseId) ||
    !Array.isArray(claim.attachmentIds) ||
    claim.attachmentIds.length > CLEANUP_BATCH ||
    claim.attachmentIds.some((id) => !isId(id))
  )
    throw new WorkflowError("UNAVAILABLE");
  let deleted = 0;
  for (const id of claim.attachmentIds) {
    if (now() >= deadline) break;
    try {
      // DELETING and charged bytes survive every uncertain Storage/DB outcome.
      await storage.remove(id, Math.max(1, Math.min(2000, deadline - now())));
      const remaining = deadline - now();
      if (remaining <= 0) break;
      await rpc(
        "chat_attachment_cleanup_confirm",
        { p_id: id, p_lease: claim.leaseId },
        { timeoutMilliseconds: remaining },
      );
      deleted++;
    } catch {
      /* Retry the same permanent object on the next cleanup lease. */
    }
  }
  return { deleted, pending: claim.attachmentIds.length - deleted };
}
