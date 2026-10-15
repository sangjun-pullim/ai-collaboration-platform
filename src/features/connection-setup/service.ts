import "server-only";
import { randomBytes, createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryableAuthFailure } from "../room-access/team-entry-policy";
import { deviceClient } from "../device-binding/device-client";
import { serverConfig } from "../../lib/supabase/server";
import { SettingsError, errorStatus } from "../runtime-settings/contracts";
import { parseDescription, type SetupAction, type SetupBody } from "./contracts";
async function rpc(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, params);
  if (error)
    throw new SettingsError(
      error.code === "P0001" && Object.hasOwn(errorStatus, error.message)
        ? (error.message as keyof typeof errorStatus)
        : "UNAVAILABLE",
    );
  return data;
}
export async function humanSetup(
  client: SupabaseClient,
  action: "issue" | "inspect",
  body: SetupBody,
) {
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user)
    throw new SettingsError(retryableAuthFailure(error) ? "UNAVAILABLE" : "UNAUTHENTICATED");
  if (action === "inspect")
    return rpc(client, "connection_setup_human", { p_action: action, p_body: body });
  // Organization is resolved under the same membership checks by the database.
  const scope = await rpc(client, "connection_setup_human", {
    p_action: "scope",
    p_body: { roomId: body.roomId },
  });
  const description = await parseDescription({
    version: 1,
    origin: serverConfig().origin,
    ownerUserId: user.id,
    organizationId: scope.organizationId,
    roomId: body.roomId,
    deviceAlias: body.deviceAlias,
    selection: body.selection,
  });
  const payload = JSON.stringify(description);
  const payloadHash = createHash("sha256").update(payload, "utf8").digest("hex");
  const key = randomBytes(32).toString("hex");
  const result = await rpc(client, "connection_setup_human", {
    p_action: action,
    p_body: {
      requestId: body.requestId,
      payload,
      payloadHash,
      keyHash: createHash("sha256").update(key).digest("hex"),
    },
  });
  return { ...result, ...(result.created === true ? { key } : {}) };
}
export async function publicSetup(action: SetupAction, body: SetupBody, secret: string) {
  const { url, key } = serverConfig();
  return rpc(deviceClient(url, key), "connection_setup_device", {
    p_action: action,
    p_body: body,
    p_secret: secret,
  });
}
