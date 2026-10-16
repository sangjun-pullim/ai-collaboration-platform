import { WorkflowError } from "./contracts.ts";

export type RealtimeBody = {
  protocol: 1;
  roomId: string;
  expectedUserId: string;
  clientId: string;
  leaseId?: string;
};
export type RealtimeGrant = {
  protocol: 1;
  roomId: string;
  userId: string;
  clientId: string;
  leaseId: string;
  topic: string;
  expiresAt: string;
  tokenExpiresAt: string;
  accessToken: string;
  url: string;
  key: string;
};
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function validateRealtimeBody(
  action: "authorize" | "release",
  input: unknown,
): RealtimeBody {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WorkflowError("INVALID_BODY");
  const value = input as Record<string, unknown>;
  const keys = [
    "protocol",
    "roomId",
    "expectedUserId",
    "clientId",
    ...(action === "release" || Object.hasOwn(value, "leaseId") ? ["leaseId"] : []),
  ];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.protocol !== 1 ||
    keys.filter((key) => key !== "protocol").some((key) => !uuid(value[key]))
  )
    throw new WorkflowError("INVALID_BODY");
  return value as RealtimeBody;
}
export function validateRealtimeGrant(input: unknown, body: RealtimeBody): RealtimeGrant {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new WorkflowError("UNAVAILABLE");
  const grant = input as RealtimeGrant;
  const keys = [
    "protocol",
    "roomId",
    "userId",
    "clientId",
    "leaseId",
    "topic",
    "expiresAt",
    "tokenExpiresAt",
    "accessToken",
    "url",
    "key",
  ];
  if (
    Object.keys(grant).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(grant, key)) ||
    grant.protocol !== 1 ||
    grant.roomId !== body.roomId ||
    grant.userId !== body.expectedUserId ||
    grant.clientId !== body.clientId ||
    !uuid(grant.leaseId) ||
    (body.leaseId && body.leaseId !== grant.leaseId) ||
    !/^chat-lease:[0-9a-f]{64}$/.test(grant.topic) ||
    !Number.isFinite(Date.parse(grant.expiresAt)) ||
    !Number.isFinite(Date.parse(grant.tokenExpiresAt)) ||
    typeof grant.accessToken !== "string" ||
    !grant.accessToken ||
    typeof grant.key !== "string" ||
    !grant.key ||
    typeof grant.url !== "string" ||
    !/^https?:\/\//.test(grant.url)
  )
    throw new WorkflowError("UNAVAILABLE");
  return grant;
}
