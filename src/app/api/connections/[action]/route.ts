import { NextResponse } from "next/server";
import { requestClient, privateHeaders } from "../../../../lib/supabase/server";
import {
  humanActions,
  ConnectionError,
  type HumanAction,
} from "../../../../features/device-binding/contracts";
import { readConnection } from "../../../../features/device-binding/request-policy";
import { humanMutation, connectionFailure } from "../../../../features/device-binding/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (!humanActions.includes(action as HumanAction)) throw new ConnectionError("NOT_FOUND");
    const body = await readConnection(request, action as HumanAction, true);
    session = await requestClient();
    return session.finish({
      ok: true,
      data: await humanMutation(session.client, action as HumanAction, body),
    });
  } catch (error) {
    const result = connectionFailure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
