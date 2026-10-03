import "server-only";
import { serverConfig } from "../../lib/supabase/server";
import { ConnectionError, validateBody, type ConnectorAction, type HumanAction } from "./contracts";
export async function readConnection(
  request: Request,
  action: ConnectorAction | HumanAction,
  human: boolean,
) {
  if (human && request.headers.get("origin") !== serverConfig().origin)
    throw new ConnectionError("UNSAFE_ORIGIN");
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw new ConnectionError("INVALID_BODY");
  const reader = request.body?.getReader();
  if (!reader) throw new ConnectionError("INVALID_BODY");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) {
        await reader.cancel();
        throw new ConnectionError("BODY_TOO_LARGE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new ConnectionError("INVALID_BODY");
  }
  return validateBody(action, input);
}
export function bearer(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match) throw new ConnectionError("UNAUTHENTICATED");
  return match[1];
}
