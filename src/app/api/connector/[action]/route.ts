import { NextResponse } from "next/server";
import { connectorActions, ConnectionError, type ConnectorAction } from "../../../../features/device-binding/contracts";
import { readConnection, bearer } from "../../../../features/device-binding/request-policy";
import { deviceMutation, connectionFailure } from "../../../../features/device-binding/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let body: unknown; let status = 200;
  try {
    const { action } = await context.params;
    if (!connectorActions.includes(action as ConnectorAction)) throw new ConnectionError("NOT_FOUND");
    const secret = action === "begin" ? undefined : bearer(request);
    body = { ok: true, data: await deviceMutation(action as ConnectorAction, await readConnection(request, action as ConnectorAction, false), secret) };
  } catch (error) { const result = connectionFailure(error); body = result.body; status = result.status; }
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store, max-age=0", Pragma: "no-cache", Expires: "0", Vary: "Authorization" } });
}
