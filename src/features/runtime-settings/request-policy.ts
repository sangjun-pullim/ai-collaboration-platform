import "server-only";
import { readJsonBody } from "../../lib/http/read-json-body";
import { serverConfig } from "../../lib/supabase/server";
import { SettingsError, validateBody, type Action } from "./contracts";
export async function readSettings(request: Request, action: Action, human: boolean) {
  if (human && request.headers.has("authorization")) throw new SettingsError("FORBIDDEN");
  if (!human && request.headers.has("cookie")) throw new SettingsError("FORBIDDEN");
  const input = await readJsonBody(request, {
    expectedOrigin: human ? serverConfig().origin : undefined,
    error: (code) => new SettingsError(code),
    utf8: "strict",
  });
  return validateBody(action, input);
}
export function settingsBearer(request: Request) {
  const match = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/);
  if (!match) throw new SettingsError("UNAUTHENTICATED");
  return match[1];
}
