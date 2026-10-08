import {
  accessActions,
  AccessError,
  type AccessAction,
} from "../../../../features/room-access/contracts";
import { readMutation } from "../../../../features/room-access/request-policy";
import { mutate } from "../../../../features/room-access/access-service";
import { requestClient, failure, privateHeaders } from "../../../../lib/supabase/server";
import { NextResponse } from "next/server";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (!(accessActions as readonly string[]).includes(action)) throw new AccessError("NOT_FOUND");
    const body = await readMutation(request, action as AccessAction);
    session = await requestClient();
    return session.finish({
      ok: true,
      data: await mutate(session.client, action as AccessAction, body),
    });
  } catch (error) {
    const result = failure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
