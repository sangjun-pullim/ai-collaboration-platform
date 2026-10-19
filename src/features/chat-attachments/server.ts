import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deviceClient } from "../device-binding/device-client.ts";
import { retryableAuthFailure } from "../room-access/team-entry-policy.ts";
import { serverConfig } from "../../lib/supabase/server";
import { WorkflowError, errorStatus } from "../investigation-coordinator/contracts.ts";
import { workflowFailure } from "../investigation-coordinator/service";
import { type AttachmentRpc } from "./quota.ts";
import { PrivateImageStorage, storageAdminRpc } from "./storage.ts";
import { uploadImage, downloadImage } from "./service.ts";
import { AttachmentQuotaError, type DeviceDownload, type UserScope } from "./contracts.ts";

export function attachmentFailure(error: unknown) {
  const failure = workflowFailure(error);
  return error instanceof AttachmentQuotaError
    ? {
        ...failure,
        body: { ...failure.body, error: { ...failure.body.error, reason: error.reason } },
      }
    : failure;
}

export function attachmentRpc(client: SupabaseClient): AttachmentRpc {
  return async (name, params) => {
    const { data, error } = await client.rpc(name, params);
    if (error)
      throw new WorkflowError(
        error.code === "P0001" && Object.hasOwn(errorStatus, error.message)
          ? (error.message as keyof typeof errorStatus)
          : "UNAVAILABLE",
      );
    return data;
  };
}
export async function authenticatedRpc(client: SupabaseClient, expectedUserId: string) {
  const result = await client.auth.getUser();
  if (result.error || !result.data.user)
    throw new WorkflowError(retryableAuthFailure(result.error) ? "UNAVAILABLE" : "UNAUTHENTICATED");
  if (result.data.user.id.toLowerCase() !== expectedUserId.toLowerCase())
    throw new WorkflowError("FORBIDDEN");
  return attachmentRpc(client);
}
export async function storeUserImage(
  client: SupabaseClient,
  scope: UserScope,
  bytes: Buffer,
  mime: string,
) {
  return uploadImage(
    await authenticatedRpc(client, scope.expectedUserId),
    storageAdminRpc,
    new PrivateImageStorage(),
    scope,
    bytes,
    mime,
  );
}
export async function userImage(client: SupabaseClient, scope: UserScope, id: string) {
  const rpc = await authenticatedRpc(client, scope.expectedUserId);
  return downloadImage(
    () => rpc("chat_attachment_user_download", { p_body: { ...scope, attachmentId: id } }),
    new PrivateImageStorage(),
  );
}
export async function deviceImage(body: DeviceDownload, secret: string) {
  const { url, key } = serverConfig();
  const rpc = attachmentRpc(deviceClient(url, key));
  return downloadImage(
    () => rpc("chat_attachment_device_download", { p_body: body, p_secret: secret }),
    new PrivateImageStorage(),
  );
}
export async function reportImageCapability(body: Record<string, unknown>, secret: string) {
  const { url, key } = serverConfig();
  return attachmentRpc(deviceClient(url, key))("chat_attachment_capability", {
    p_body: body,
    p_secret: secret,
  });
}
