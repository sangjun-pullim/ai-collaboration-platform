import "server-only";
import { createClient } from "@supabase/supabase-js";
import { IMAGE_BUCKET, MAX_IMAGE_BYTES, objectKey } from "./contracts.ts";
import { readImageBytes } from "./validation.ts";
import type { AttachmentRpc, ImageStorage } from "./quota.ts";
import { WorkflowError, errorStatus } from "../investigation-coordinator/contracts.ts";

function storageConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.AI_COLLAB_IMAGE_STORAGE_SECRET;
  if (!url || !key) throw new WorkflowError("UNAVAILABLE");
  try {
    const endpoint = new URL(url);
    if (
      endpoint.origin !== url ||
      endpoint.username ||
      endpoint.password ||
      !(
        endpoint.protocol === "https:" ||
        (endpoint.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname))
      )
    )
      throw new Error();
    if (
      !key.startsWith("sb_secret_") &&
      JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString()).role !== "service_role"
    )
      throw new Error();
  } catch {
    throw new WorkflowError("UNAVAILABLE");
  }
  return { url, key };
}
export const storageAdminRpc: AttachmentRpc = async (name, params, options) => {
  if (
    ![
      "chat_attachment_finalize",
      "chat_attachment_cleanup_claim",
      "chat_attachment_cleanup_confirm",
    ].includes(name)
  )
    throw new WorkflowError("FORBIDDEN");
  const { url, key } = storageConfig();
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(2000, options?.timeoutMilliseconds ?? 2000)),
          ),
        }),
    },
  });
  const { data, error } = await client.rpc(name, params);
  if (error)
    throw new WorkflowError(
      error.code === "P0001" && Object.hasOwn(errorStatus, error.message)
        ? (error.message as keyof typeof errorStatus)
        : "UNAVAILABLE",
    );
  return data;
};
export class PrivateImageStorage implements ImageStorage {
  private async request(path: string, init: RequestInit, timeout = 15_000) {
    const { url, key } = storageConfig();
    const headers = new Headers(init.headers);
    headers.set("apikey", key);
    headers.set("Authorization", `Bearer ${key}`);
    return fetch(`${url}/storage/v1/object/${IMAGE_BUCKET}${path}`, {
      ...init,
      headers,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(timeout),
    });
  }
  async put(id: string, bytes: Buffer, mime: string) {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new WorkflowError("INVALID_BODY");
    const response = await this.request(`/${objectKey(id)}`, {
      method: "POST",
      headers: { "Content-Type": mime, "x-upsert": "false", "Cache-Control": "private, no-store" },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkflowError("UNAVAILABLE");
    }
    await response.body?.cancel();
  }
  async get(id: string) {
    const response = await this.request(`/${objectKey(id)}`, { method: "GET" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkflowError("UNAVAILABLE");
    }
    return readImageBytes(response);
  }
  async remove(id: string, timeout = 2000) {
    const response = await this.request(
      "",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [objectKey(id)] }),
      },
      timeout,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new WorkflowError("UNAVAILABLE");
    }
    await response.body?.cancel();
  }
}
