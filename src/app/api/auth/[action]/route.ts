import {
  authActions,
  AccessError,
  type AuthAction,
} from "../../../../features/room-access/contracts";
import { readMutation } from "../../../../features/room-access/request-policy";
import { requestClient, failure, privateHeaders } from "../../../../lib/supabase/server";
import { NextResponse } from "next/server";
import { enterTeam } from "../../../../features/room-access/team-entry-service";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (!(authActions as readonly string[]).includes(action)) throw new AccessError("NOT_FOUND");
    const body = await readMutation(request, action as AuthAction);
    session = await requestClient();
    if (action === "enter") {
      return session.finish({ ok: true, data: await enterTeam(session, body) });
    } else {
      // Obtain current user so an eligible refresh and its revocation share this response.
      try {
        await session.client.auth.getUser();
        const { error } = await session.client.auth.signOut({ scope: "local" });
        if (error && error.status !== 401 && error.status !== 403 && error.status !== 404)
          throw new AccessError("UNAVAILABLE");
      } finally {
        session.clearSessionCookies();
      }
    }
    return session.finish({ ok: true, data: {} });
  } catch (error) {
    const result = failure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
