import { NextResponse } from "next/server";
import { requestClient, privateHeaders, serverConfig } from "../../../../lib/supabase/server";
import { readJsonBody } from "../../../../lib/http/read-json-body";
import { WorkflowError } from "../../../../features/investigation-coordinator/contracts";
import { workflowFailure } from "../../../../features/investigation-coordinator/service";
import { validateRealtimeBody } from "../../../../features/investigation-coordinator/realtime-contracts";
import { chatRealtime } from "../../../../features/investigation-coordinator/realtime-service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (action !== "authorize" && action !== "release") throw new WorkflowError("NOT_FOUND");
    const body = validateRealtimeBody(
      action,
      await readJsonBody(request, {
        expectedOrigin: serverConfig().origin,
        error: (code) => new WorkflowError(code),
        utf8: "strict",
      }),
    );
    session = await requestClient();
    return session.finish({ ok: true, data: await chatRealtime(session.client, action, body) });
  } catch (error) {
    const failure = workflowFailure(error);
    return session
      ? session.finish(failure.body, failure.status)
      : privateHeaders(NextResponse.json(failure.body, { status: failure.status }));
  }
}
