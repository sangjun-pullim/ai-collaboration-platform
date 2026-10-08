import { NextResponse } from "next/server";
import { requestClient, privateHeaders } from "../../../../lib/supabase/server";
import {
  humanActions,
  WorkflowError,
  type HumanAction,
} from "../../../../features/investigation-coordinator/contracts";
import { readWorkflow } from "../../../../features/investigation-coordinator/request-policy";
import {
  humanWorkflow,
  workflowFailure,
} from "../../../../features/investigation-coordinator/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (!humanActions.includes(action as HumanAction)) throw new WorkflowError("NOT_FOUND");
    const body = await readWorkflow(request, action as HumanAction, true);
    session = await requestClient();
    return session.finish({
      ok: true,
      data: await humanWorkflow(session.client, action as HumanAction, body),
    });
  } catch (error) {
    const result = workflowFailure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
