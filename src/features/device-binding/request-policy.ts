import "server-only";
import { readJsonBody } from "../../lib/http/read-json-body";
import { serverConfig } from "../../lib/supabase/server";
import { ConnectionError, validateBody, type ConnectorAction, type HumanAction } from "./contracts";
export async function readConnection(
  request: Request,
  action: ConnectorAction | HumanAction,
  human: boolean,
) {
  const input = await readJsonBody(request, {
    expectedOrigin: human ? serverConfig().origin : undefined,
    error: (code) => new ConnectionError(code),
    utf8: "replacement",
  });
  return validateBody(action, input);
}
export function bearer(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match) throw new ConnectionError("UNAUTHENTICATED");
  return match[1];
}
