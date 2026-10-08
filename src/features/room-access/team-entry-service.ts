import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AccessError } from "./contracts";
import { confirmedMissingSession, projectEntry, retryableAuthFailure } from "./team-entry-policy";

// The Auth provider also limits anonymous signup by the application server's IP.
// This bounded per-process limiter rejects bursts before a signup is submitted.
const signups: number[] = [];
function reserveSignup(now = Date.now()) {
  while (signups.length && signups[0] <= now - 60_000) signups.shift();
  if (signups.length >= 10) throw new AccessError("CODE_COOLDOWN");
  signups.push(now);
}
type EntrySession = {
  client: SupabaseClient;
  hasAuthCookies: boolean;
  preserveSessionCookies(): void;
};
export async function enterTeam(session: EntrySession, body: Record<string, string>) {
  let identity: string | undefined;
  try {
    const { data, error } = await session.client.auth.getUser();
    if (!error && data.user) identity = data.user.id;
    else if (confirmedMissingSession(error, session.hasAuthCookies)) {
      reserveSignup();
      const created = await session.client.auth.signInAnonymously();
      if (created.error)
        throw new AccessError(created.error.status === 429 ? "CODE_COOLDOWN" : "UNAVAILABLE");
      identity = created.data.user?.id;
      if (!identity) throw new AccessError("UNAVAILABLE");
    } else {
      session.preserveSessionCookies();
      throw new AccessError(retryableAuthFailure(error) ? "UNAVAILABLE" : "UNAUTHENTICATED");
    }
  } catch (error) {
    session.preserveSessionCookies();
    if (error instanceof AccessError) throw error;
    throw new AccessError("UNAVAILABLE");
  }
  const { data, error } = await session.client.rpc("team_entry_admit", {
    p_code: body.code,
    p_display_name: body.displayName,
  });
  if (error) throw new AccessError("UNAVAILABLE");
  const entry = projectEntry(data);
  if (entry.userId !== identity) throw new AccessError("UNAVAILABLE");
  return entry;
}

export async function admittedEntry(client: SupabaseClient) {
  const { data, error } = await client.rpc("team_entry_status");
  if (error) throw new AccessError("UNAVAILABLE");
  if (!data?.admitted) throw new AccessError("UNAUTHENTICATED");
  return projectEntry({ ok: true, ...data });
}
