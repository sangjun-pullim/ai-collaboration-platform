import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverConfig } from "../../lib/supabase/server";
import { WorkflowError, errorStatus } from "./contracts";
import { validateRealtimeGrant, type RealtimeBody } from "./realtime-contracts";

export async function chatRealtime(
  client: SupabaseClient,
  action: "authorize" | "release",
  body: RealtimeBody,
) {
  const verified = await client.auth.getUser();
  if (verified.error || !verified.data.user) throw new WorkflowError("UNAUTHENTICATED");
  if (verified.data.user.id !== body.expectedUserId) throw new WorkflowError("FORBIDDEN");
  const session = await client.auth.getSession();
  const token = session.data.session?.access_token;
  if (session.error || !token) throw new WorkflowError("UNAUTHENTICATED");
  const reverified = await client.auth.getUser(token);
  if (reverified.error || reverified.data.user?.id !== verified.data.user.id)
    throw new WorkflowError("UNAUTHENTICATED");
  let claims: { sub: string; session_id: string; exp: number };
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    throw new WorkflowError("UNAUTHENTICATED");
  }
  if (
    claims.sub !== body.expectedUserId ||
    typeof claims.session_id !== "string" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  )
    throw new WorkflowError("UNAUTHENTICATED");
  if (action === "authorize" && process.env.CHAT_REALTIME_ENABLED === "false")
    throw new WorkflowError("UNAVAILABLE");
  const { url, key } = serverConfig();
  // Pin RPC identity to the exact independently verified token, including session_id.
  const pinned = createClient(url, key, {
    accessToken: async () => token,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await pinned.rpc(`chat_realtime_${action}`, { p_body: body });
  if (error)
    throw new WorkflowError(
      error.code === "P0001" && Object.hasOwn(errorStatus, error.message)
        ? (error.message as keyof typeof errorStatus)
        : "UNAVAILABLE",
    );
  if (action === "release") return { released: true };
  return validateRealtimeGrant(
    {
      ...data,
      accessToken: token,
      tokenExpiresAt: new Date(claims.exp * 1000).toISOString(),
      url,
      key,
    },
    body,
  );
}
