import { NextResponse } from "next/server";
import { requestClient, privateHeaders, serverConfig } from "../../../lib/supabase/server";
import { readJsonBody } from "../../../lib/http/read-json-body";
import { WorkflowError } from "../../../features/investigation-coordinator/contracts";
import { workflowFailure } from "../../../features/investigation-coordinator/service";
import { historyWindowRequest } from "../../../features/investigation-coordinator/history-window-contracts";
import { readHistoryWindow } from "../../../features/investigation-coordinator/history-window-service";
export const runtime = "nodejs";
export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const body = historyWindowRequest(
      await readJsonBody(request, {
        expectedOrigin: serverConfig().origin,
        error: (code) => new WorkflowError(code),
        utf8: "strict",
      }),
    );
    session = await requestClient();
    return session.finish({ ok: true, data: await readHistoryWindow(session.client, body) });
  } catch (error) {
    const failure = workflowFailure(error);
    return session
      ? session.finish(failure.body, failure.status)
      : privateHeaders(NextResponse.json(failure.body, { status: failure.status }));
  }
}
