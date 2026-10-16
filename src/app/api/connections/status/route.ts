import { NextResponse } from "next/server";
import { requestClient, privateHeaders } from "../../../../lib/supabase/server";
import { readConnectionStatus } from "../../../../features/device-binding/request-policy";
import { connectionStatus, connectionFailure } from "../../../../features/device-binding/service";

export const runtime = "nodejs";
export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const body = await readConnectionStatus(request);
    session = await requestClient();
    return session.finish({ ok: true, data: await connectionStatus(session.client, body) });
  } catch (error) {
    const result = connectionFailure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
