import "server-only";
import { readJsonBody } from "../../lib/http/read-json-body";
import { AccessError, type AccessAction, type AuthAction } from "./contracts";
import { serverConfig } from "../../lib/supabase/server";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const room = { title: 160, goal: 2000, observation: 2000, environment: 2000 };
const fields: Record<AuthAction | AccessAction, Record<string, number>> = {
  enter: { code: 128, displayName: 80 },
  logout: {},
  bootstrap: { groupName: 100, ...room, displayAlias: 80 },
  room: { organizationId: 36, ...room },
  invite: { roomId: 36, role: 11 },
  join: { code: 64, displayAlias: 80 },
  "revoke-room-member": { roomId: 36, userId: 36 },
  "revoke-group-member": { organizationId: 36, userId: 36 },
};
export async function readMutation(request: Request, action: AuthAction | AccessAction) {
  const body = await readJsonBody(request, {
    expectedOrigin: serverConfig().origin,
    error: (code) => new AccessError(code),
    utf8: "strict",
  });
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AccessError("INVALID_BODY");
  const data = body as Record<string, unknown>;
  const schema = fields[action];
  if (!schema) throw new AccessError("NOT_FOUND");
  if (
    Object.keys(data).length !== Object.keys(schema).length ||
    Object.keys(data).some((key) => !Object.hasOwn(schema, key))
  )
    throw new AccessError("INVALID_BODY");
  const result: Record<string, string> = {};
  for (const [key, max] of Object.entries(schema)) {
    const value = data[key];
    if (
      typeof value !== "string" ||
      !value.length ||
      value.length > max ||
      /\u0000/.test(value) ||
      Buffer.from(value, "utf8").toString("utf8") !== value
    )
      throw new AccessError("INVALID_BODY");
    if (action === "enter" && /[\u0000-\u001f\u007f-\u009f]/.test(value))
      throw new AccessError("INVALID_BODY");
    result[key] = action === "enter" && key === "code" ? value : value.trim();
    if (!result[key]) throw new AccessError("INVALID_BODY");
    if (key.endsWith("Id") && !uuid.test(result[key])) throw new AccessError("INVALID_BODY");
  }
  if (action === "join" && !/^[a-f0-9]{64}$/.test(result.code))
    throw new AccessError("INVALID_BODY");
  if (action === "invite" && !["participant", "observer"].includes(result.role))
    throw new AccessError("INVALID_BODY");
  return result;
}
