export const protocol = 1 as const;
export const humanActions = ["approve", "revoke", "remove"] as const;
export const connectorActions = [
  "begin",
  "pairing-status",
  "exchange",
  "rotate",
  "heartbeat",
  "workspace",
  "agent",
  "replace",
  "bindings",
] as const;
export type HumanAction = (typeof humanActions)[number];
export type ConnectorAction = (typeof connectorActions)[number];
export type ConnectionErrorCode =
  | "INVALID_BODY"
  | "BODY_TOO_LARGE"
  | "UNSAFE_ORIGIN"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "QUOTA"
  | "UNAVAILABLE";
export const errorStatus: Record<ConnectionErrorCode, number> = {
  INVALID_BODY: 400,
  BODY_TOO_LARGE: 400,
  UNSAFE_ORIGIN: 403,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  QUOTA: 429,
  UNAVAILABLE: 503,
};
export class ConnectionError extends Error {
  constructor(readonly code: ConnectionErrorCode) {
    super(code);
  }
}
export const messages: Record<ConnectionErrorCode, string> = {
  INVALID_BODY: "입력과 공개 정보 확인을 점검하세요.",
  BODY_TOO_LARGE: "입력 내용을 줄여 주세요.",
  UNSAFE_ORIGIN: "이 화면에서 다시 요청하세요.",
  UNAUTHENTICATED: "다시 로그인하거나 새 기기 연결을 승인하세요.",
  FORBIDDEN: "참가 권한과 기기 소유자를 확인하세요.",
  NOT_FOUND: "연결을 찾을 수 없습니다.",
  CONFLICT: "연결이 만료되었거나 변경되었습니다. 로컬 연결 상태를 확인하세요.",
  QUOTA: "연결 한도에 도달했습니다. 사용하지 않는 연결을 제거하세요.",
  UNAVAILABLE: "연결 서비스를 사용할 수 없습니다. 잠시 뒤 다시 시도하세요.",
};
export const isId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function isAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length >= 1 &&
    value.length <= 40 &&
    /^[\p{L}\p{N} _.-]+$/u.test(value) &&
    !/^\./.test(value) &&
    !value.includes("..") &&
    !isId(value) &&
    !/^[a-f0-9]{24,}$/i.test(value) &&
    !/^[A-Za-z0-9_-]{24,}$/.test(value)
  );
}
export const isBranch = (value: unknown): value is string =>
  typeof value === "string" &&
  (value === "unknown" ||
    (value.length <= 120 &&
      /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith("/") &&
      !value.endsWith(".lock") &&
      !value.endsWith(".")));
export type GitMetadata = { branch: string; commit: string; dirty: "unknown" };
export type WorkspaceMetadata = {
  repositoryAlias: string;
  branch: string;
  commit: string;
  dirty: "unknown";
};
export type AgentMetadata = { sessionAlias: string; runtime: "codex" | "claude" };
export type Body = Record<string, string | number | boolean>;
const schemas: Record<
  HumanAction | ConnectorAction,
  Record<string, (value: unknown) => boolean>
> = {
  approve: {
    code: isHash,
    organizationId: isId,
    roomId: isId,
    confirmed: (value) => value === true,
  },
  revoke: { deviceId: isId },
  remove: { deviceId: isId },
  begin: {
    codeHash: isHash,
    proofHash: isHash,
    deviceAlias: isAlias,
    protocol: (value) => value === protocol,
  },
  "pairing-status": { pairingId: isId },
  exchange: {
    pairingId: isId,
    operationId: isId,
    credentialHash: isHash,
    confirmed: (value) => value === true,
  },
  rotate: { operationId: isId, credentialHash: isHash },
  heartbeat: {},
  bindings: {},
  workspace: {
    operationId: isId,
    repositoryAlias: isAlias,
    branch: isBranch,
    commit: (value) =>
      value === "unknown" || (typeof value === "string" && /^[a-f0-9]{40}$/.test(value)),
    dirty: (value) => value === "unknown",
  },
  agent: {
    operationId: isId,
    workspaceId: isId,
    sessionAlias: isAlias,
    runtime: (value) => value === "codex" || value === "claude",
  },
  replace: {
    operationId: isId,
    agentId: isId,
    expectedEpoch: (value) => Number.isSafeInteger(value) && Number(value) > 0,
    repositoryAlias: isAlias,
    branch: isBranch,
    commit: (value) =>
      value === "unknown" || (typeof value === "string" && /^[a-f0-9]{40}$/.test(value)),
    dirty: (value) => value === "unknown",
    sessionAlias: isAlias,
    runtime: (value) => value === "codex" || value === "claude",
  },
};
export function validateBody(action: HumanAction | ConnectorAction, input: unknown): Body {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ConnectionError("INVALID_BODY");
  const body = input as Record<string, unknown>;
  const schema = schemas[action];
  if (
    !schema ||
    Object.keys(body).length !== Object.keys(schema).length ||
    Object.keys(body).some((key) => !Object.hasOwn(schema, key)) ||
    Object.entries(schema).some(([key, validate]) => !validate(body[key]))
  )
    throw new ConnectionError("INVALID_BODY");
  if (action === "begin" && body.codeHash === body.proofHash)
    throw new ConnectionError("INVALID_BODY");
  return Object.fromEntries(Object.keys(schema).map((key) => [key, body[key]])) as Body;
}
export type Scope = {
  ownerAlias: string;
  organizationId: string;
  organizationName: string;
  roomId: string;
  roomTitle: string;
  deviceAlias: string;
};
export type PublicBinding = {
  workspaceId: string;
  agentId: string;
  deviceAlias: string;
  ownerAlias: string;
  repositoryAlias: string;
  branch: string;
  commit: string;
  dirty: "unknown";
  sessionAlias: string;
  runtime: "codex" | "claude";
  bindingEpoch: number;
  state: "registered";
  verification: "unverified";
  lastSeenAt: string | null;
};
export type OwnedDevice = {
  deviceId: string;
  deviceAlias: string;
  organizationId: string;
  roomId: string;
  state: "active" | "revoked" | "removed";
  lastSeenAt: string | null;
  expiresAt: string | null;
};
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 160;
const nullableDate = (v: unknown) => v === null || date(v);
const scopeSchema = {
  ownerAlias: text,
  organizationId: isId,
  organizationName: text,
  roomId: isId,
  roomTitle: text,
  deviceAlias: isAlias,
};
const bindingSchema = {
  workspaceId: isId,
  agentId: isId,
  deviceAlias: isAlias,
  ownerAlias: text,
  repositoryAlias: isAlias,
  branch: isBranch,
  commit: (v: unknown) => v === "unknown" || (typeof v === "string" && /^[a-f0-9]{40}$/.test(v)),
  dirty: (v: unknown) => v === "unknown",
  sessionAlias: isAlias,
  runtime: (v: unknown) => v === "codex" || v === "claude",
  bindingEpoch: (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0,
  state: (v: unknown) => v === "registered",
  verification: (v: unknown) => v === "unverified",
  lastSeenAt: nullableDate,
};
function project(
  input: unknown,
  schema: Record<string, (v: unknown) => boolean>,
  strict: boolean,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ConnectionError("UNAVAILABLE");
  const record = input as Record<string, unknown>;
  if (
    strict &&
    (Object.keys(record).length !== Object.keys(schema).length ||
      Object.keys(record).some((k) => !Object.hasOwn(schema, k)))
  )
    throw new ConnectionError("UNAVAILABLE");
  if (Object.entries(schema).some(([k, check]) => !check(record[k])))
    throw new ConnectionError("UNAVAILABLE");
  return Object.fromEntries(Object.keys(schema).map((k) => [k, record[k]]));
}
export function projectBinding(input: unknown, strict = false): PublicBinding {
  return project(input, bindingSchema, strict) as PublicBinding;
}
export function projectDevice(input: unknown): OwnedDevice {
  return project(
    input,
    {
      deviceId: isId,
      deviceAlias: isAlias,
      organizationId: isId,
      roomId: isId,
      state: (v) => ["active", "revoked", "removed"].includes(String(v)),
      lastSeenAt: nullableDate,
      expiresAt: nullableDate,
    },
    false,
  ) as OwnedDevice;
}
export function projectResponse(
  action: HumanAction | ConnectorAction,
  input: unknown,
  strict = false,
): Record<string, unknown> {
  let schema: Record<string, (v: unknown) => boolean>;
  if (action === "begin")
    schema = { protocol: (v) => v === protocol, pairingId: isId, expiresAt: date };
  else if (action === "pairing-status") {
    const status = (input as Record<string, unknown>)?.state;
    schema = {
      protocol: (v) => v === protocol,
      pairingId: isId,
      state: (v) => ["pending", "approved", "exchanged", "expired", "revoked"].includes(String(v)),
      expiresAt: date,
      ...(status === "approved"
        ? {
            scope: (v) => {
              try {
                project(v, scopeSchema, strict);
                return true;
              } catch {
                return false;
              }
            },
          }
        : {}),
    };
  } else if (action === "exchange" || action === "rotate")
    schema = { protocol: (v) => v === protocol, deviceId: isId, expiresAt: date };
  else if (action === "workspace") schema = { protocol: (v) => v === protocol, workspaceId: isId };
  else if (action === "agent" || action === "replace")
    schema = {
      protocol: (v) => v === protocol,
      agentId: isId,
      workspaceId: isId,
      bindingEpoch: (v) => Number.isSafeInteger(v) && Number(v) > 0,
      state: (v) => v === "registered",
      verification: (v) => v === "unverified",
    };
  else if (action === "bindings")
    schema = {
      protocol: (v) => v === protocol,
      bindings: (v) =>
        Array.isArray(v) &&
        v.every((b) => {
          try {
            projectBinding(b, strict);
            return true;
          } catch {
            return false;
          }
        }),
    };
  else if (action === "heartbeat")
    schema = {
      protocol: (v) => v === protocol,
      state: (v) => v === "registered",
      verification: (v) => v === "unverified",
      lastSeenAt: date,
    };
  else if (action === "approve") schema = { approved: (v) => v === true, deviceAlias: isAlias };
  else schema = { removed: (v) => v === true };
  const result = project(input, schema, strict);
  if (result.scope) result.scope = project(result.scope, scopeSchema, strict);
  if (Array.isArray(result.bindings))
    result.bindings = result.bindings.map((b) => projectBinding(b, strict));
  return result;
}
