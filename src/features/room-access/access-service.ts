import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AccessError, type AccessAction, type Organization, type Room, type Member, type GroupMember } from "./contracts";
export async function currentUser(client: SupabaseClient) {
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new AccessError("UNAUTHENTICATED");
  return user.id;
}
const rpcs: Record<AccessAction, string> = {
  bootstrap: "access_bootstrap", room: "access_room", invite: "access_invite", join: "access_join",
  "revoke-room-member": "access_revoke_room_member", "revoke-group-member": "access_revoke_group_member",
};
export async function mutate(client: SupabaseClient, action: AccessAction, body: Record<string, string>) {
  await currentUser(client);
  const params = Object.fromEntries(Object.entries(body).map(([key, value]) => [`p_${key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)}`, value]));
  const { data, error } = await client.rpc(rpcs[action], params);
  if (error) {
    const known = ["UNAUTHENTICATED", "FORBIDDEN", "INVALID_BODY", "INVITE_UNAVAILABLE", "ALREADY_MEMBER"] as const;
    const code = known.find(code => error.code === "P0001" && error.message === code);
    throw new AccessError(code ?? "UNAVAILABLE");
  }
  // Explicit projections prevent future RPC internal fields from reaching the browser.
  if (action === "bootstrap") return { organizationId: data.organizationId, roomId: data.roomId };
  if (action === "room" || action === "join") return { roomId: data.roomId };
  if (action === "invite") return { code: data.code, expiresAt: data.expiresAt };
  return { removed: data.removed === true };
}
export async function dashboard(client: SupabaseClient) {
  const userId = await currentUser(client);
  const [orgs, rooms] = await Promise.all([
    client.from("organizations").select("id,name,owner_user_id"),
    client.from("rooms").select("id,organization_id,title,goal,observation,environment"),
  ]);
  if (orgs.error || rooms.error) throw new AccessError("UNAVAILABLE");
  return { userId, organizations: orgs.data as Organization[], rooms: rooms.data as Room[] };
}
export async function roomDetails(client: SupabaseClient, roomId: string) {
  const userId = await currentUser(client);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(roomId)) throw new AccessError("NOT_FOUND");
  const { data: room, error } = await client.from("rooms").select("id,organization_id,title,goal,observation,environment").eq("id", roomId).maybeSingle();
  if (error) throw new AccessError("UNAVAILABLE");
  if (!room) throw new AccessError("NOT_FOUND");
  const [members, orgs, groupMembers] = await Promise.all([
    client.from("room_members").select("user_id,role,display_alias,status").eq("room_id", roomId).eq("status", "active"),
    client.from("organizations").select("id,name,owner_user_id").eq("id", room.organization_id).single(),
    client.from("organization_members").select("user_id,role,display_alias,status").eq("organization_id", room.organization_id).eq("status", "active"),
  ]);
  if (members.error || orgs.error || groupMembers.error) throw new AccessError("UNAVAILABLE");
  const role = members.data.find(member => member.user_id === userId)?.role;
  if (!role) throw new AccessError("NOT_FOUND");
  return { userId, room: room as Room, members: members.data as Member[], organization: orgs.data as Organization, groupMembers: groupMembers.data as GroupMember[], role: role as Member["role"] };
}
