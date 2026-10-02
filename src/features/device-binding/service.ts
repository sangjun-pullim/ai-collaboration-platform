import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deviceClient } from "./device-client";
import { serverConfig } from "../../lib/supabase/server";
import { ConnectionError, errorStatus, projectResponse, projectBinding, projectDevice, type Body, type ConnectorAction, type HumanAction } from "./contracts";
const humanRpcs: Record<HumanAction, string> = { approve: "connection_approve", revoke: "connection_revoke", remove: "connection_remove" };
const deviceRpcs: Record<ConnectorAction, string> = { begin: "connector_begin", "pairing-status": "connector_pairing_status", exchange: "connector_exchange", rotate: "connector_rotate", heartbeat: "connector_heartbeat", workspace: "connector_workspace", agent: "connector_agent", replace: "connector_replace", bindings: "connector_bindings" };
async function rpc(client: SupabaseClient, name: string, params: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, params);
  if (error) { const code = error.code === "P0001" && Object.hasOwn(errorStatus, error.message) ? error.message as keyof typeof errorStatus : "UNAVAILABLE"; throw new ConnectionError(code); }
  return data;
}
export async function humanMutation(client: SupabaseClient, action: HumanAction, body: Body) {
  const { data: { user }, error } = await client.auth.getUser(); if (error || !user) throw new ConnectionError("UNAUTHENTICATED");
  return projectResponse(action, await rpc(client, humanRpcs[action], { p_body: body }));
}
export async function deviceMutation(action: ConnectorAction, body: Body, secret?: string) {
  const { url, key } = serverConfig();
  const client = deviceClient(url, key);
  return projectResponse(action, await rpc(client, deviceRpcs[action], { p_body: body, p_secret: secret ?? null }));
}
export async function ownedConnections(client: SupabaseClient) {
  const data = await rpc(client, "connection_list", {});
  if (!Array.isArray(data.devices) || !Array.isArray(data.rooms)) throw new ConnectionError("UNAVAILABLE");
  return { devices: data.devices.map(projectDevice), rooms: data.rooms.map((r: Record<string, unknown>) => ({ roomId: String(r.roomId), organizationId: String(r.organizationId), roomTitle: String(r.roomTitle), organizationName: String(r.organizationName) })) as { roomId: string; organizationId: string; roomTitle: string; organizationName: string }[] };
}
export async function roomBindings(client: SupabaseClient, roomId: string) {
  const data = await rpc(client, "connection_room_bindings", { p_room_id: roomId });
  if (!Array.isArray(data)) throw new ConnectionError("UNAVAILABLE"); return data.map((b: unknown) => projectBinding(b));
}
export function connectionFailure(error: unknown) { const code = error instanceof ConnectionError ? error.code : "UNAVAILABLE"; return { body: { ok: false, error: { code } }, status: errorStatus[code] }; }
