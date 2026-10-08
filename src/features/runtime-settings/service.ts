import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryableAuthFailure } from "../room-access/team-entry-policy";
import { deviceClient } from "../device-binding/device-client";
import { serverConfig } from "../../lib/supabase/server";
import {
  SettingsError,
  errorStatus,
  projectResponse,
  type Body,
  type HumanAction,
  type DeviceAction,
} from "./contracts";
async function rpc(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, params);
  if (error)
    throw new SettingsError(
      error.code === "P0001" && Object.hasOwn(errorStatus, error.message)
        ? (error.message as keyof typeof errorStatus)
        : "UNAVAILABLE",
    );
  return projectResponse(data);
}
export async function humanSettings(client: SupabaseClient, action: HumanAction, body: Body) {
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user)
    throw new SettingsError(retryableAuthFailure(error) ? "UNAVAILABLE" : "UNAUTHENTICATED");
  return rpc(client, "runtime_settings_human", { p_action: action, p_body: body });
}
export async function deviceSettings(action: DeviceAction, body: Body, secret: string) {
  const { url, key } = serverConfig();
  return rpc(deviceClient(url, key), "runtime_settings_device", {
    p_action: action,
    p_body: body,
    p_secret: secret,
  });
}
export function settingsFailure(error: unknown) {
  const code = error instanceof SettingsError ? error.code : "UNAVAILABLE";
  return { body: { ok: false, error: { code } }, status: errorStatus[code] };
}
