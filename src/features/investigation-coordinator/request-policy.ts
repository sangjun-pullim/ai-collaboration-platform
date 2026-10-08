import "server-only";
import { readJsonBody } from "../../lib/http/read-json-body";
import { serverConfig } from "../../lib/supabase/server";
import { WorkflowError, validateBody, type Action } from "./contracts";
export async function readWorkflow(request: Request, action: Action, human: boolean) {
  const input = await readJsonBody(request, {
    expectedOrigin: human ? serverConfig().origin : undefined,
    error: (code) => new WorkflowError(code),
    utf8: "strict",
  });
  return validateBody(action, input);
}
export function workflowBearer(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match) throw new WorkflowError("UNAUTHENTICATED");
  return match[1];
}
