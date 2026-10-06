export const protocol = 1 as const;
export const maxBytes = 16384;
export const humanActions = ["list", "select-folder", "select-runtime", "apply", "cancel"] as const;
export const deviceActions = ["poll", "receipt"] as const;
export type HumanAction = (typeof humanActions)[number];
export type DeviceAction = (typeof deviceActions)[number];
export type Action = HumanAction | DeviceAction;
export type Provider = "codex" | "claude";
export type State =
  | "REQUESTED"
  | "LOCAL_CONFIRMATION"
  | "APPLYING"
  | "COMMITTED"
  | "APPLIED"
  | "CANCELLED"
  | "FAILED"
  | "UNKNOWN";
export type ErrorCode =
  | "INVALID_BODY"
  | "BODY_TOO_LARGE"
  | "UNSAFE_ORIGIN"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "QUOTA"
  | "UNAVAILABLE";
export const errorStatus: Record<ErrorCode, number> = {
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
export class SettingsError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
export const isId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export const isHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const positive = (v: unknown) => integer(v) && Number(v) > 0;
const nullable = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v);
const provider = (v: unknown) => v === "codex" || v === "claude";
const safeText = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/.test(v) &&
  !v.includes("..") &&
  !isId(v) &&
  !/^[a-f0-9]{24,}$/i.test(v) &&
  !/^sk-/i.test(v) &&
  !/token|secret|credential|bearer/i.test(v);
const alias = (v: unknown): v is string =>
  typeof v === "string" &&
  v === v.trim() &&
  v.length > 0 &&
  v.length <= 40 &&
  /^[\p{L}\p{N} _.-]+$/u.test(v) &&
  !v.startsWith(".") &&
  !v.includes("..") &&
  !isId(v) &&
  !/^[A-Za-z0-9_-]{24,}$/.test(v);
const states: State[] = [
  "REQUESTED",
  "LOCAL_CONFIRMATION",
  "APPLYING",
  "COMMITTED",
  "APPLIED",
  "CANCELLED",
  "FAILED",
  "UNKNOWN",
];
type Schema = Record<string, (v: unknown) => boolean>;
function exact(
  input: unknown,
  schema: Schema,
  code: ErrorCode = "INVALID_BODY",
  optional: Schema = {},
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsError(code);
  const b = input as Record<string, unknown>;
  if (
    Object.keys(b).some((k) => !Object.hasOwn(schema, k) && !Object.hasOwn(optional, k)) ||
    Object.entries(schema).some(([k, check]) => !Object.hasOwn(b, k) || !check(b[k])) ||
    Object.entries(optional).some(([k, check]) => Object.hasOwn(b, k) && !check(b[k]))
  )
    throw new SettingsError(code);
  return Object.fromEntries(
    [...Object.keys(schema), ...Object.keys(optional).filter((k) => Object.hasOwn(b, k))].map(
      (k) => [k, b[k]],
    ),
  );
}
function bounded(input: unknown, code: ErrorCode) {
  if (new TextEncoder().encode(JSON.stringify(input)).length > maxBytes)
    throw new SettingsError(code);
}
export type Selection = {
  runtime: Provider;
  model: string;
  effort: string | null;
  snapshotHash: string;
};
export type Capability = {
  runtime: Provider;
  version: string;
  models: {
    id: string;
    model: string;
    efforts: string[];
    defaultEffort: string | null;
    isDefault: boolean;
  }[];
  defaultSettings: { model: string; effort: string | null } | null;
  snapshotHash: string;
  policy: "verified" | "unsupported";
};
function canonical(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function capabilityHash(input: Omit<Capability, "snapshotHash">): string {
  const raw = new TextEncoder().encode(canonical(input));
  const bytes = new Uint8Array(Math.ceil((raw.length + 9) / 64) * 64);
  bytes.set(raw);
  bytes[raw.length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 4, raw.length * 8);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (n: number, b: number) => (n >>> b) | (n << (32 - b));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const w = new Int32Array(64);
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15],
        b = w[i - 2];
      w[i] =
        w[i - 16] +
        (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) +
        w[i - 7] +
        (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, j] = h;
    for (let i = 0; i < 64; i++) {
      const t =
        (j + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
      const u = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      j = g;
      g = f;
      f = e;
      e = (d + t) | 0;
      d = c;
      c = b;
      b = a;
      a = (t + u) | 0;
    }
    [a, b, c, d, e, f, g, j].forEach((n, i) => (h[i] = (h[i] + n) | 0));
  }
  return h.map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}
export function projectCapability(input: unknown): Capability {
  bounded(input, "INVALID_BODY");
  const b = exact(input, {
    runtime: provider,
    version: safeText,
    models: (v) => Array.isArray(v) && v.length <= 256,
    defaultSettings: (v) => v === null || !!v,
    snapshotHash: isHash,
    policy: (v) => v === "verified" || v === "unsupported",
  });
  const models = (b.models as unknown[]).map(
    (m) =>
      exact(m, {
        id: safeText,
        model: safeText,
        efforts: (v) =>
          Array.isArray(v) && v.length <= 12 && v.every(safeText) && new Set(v).size === v.length,
        defaultEffort: nullable(safeText),
        isDefault: (v) => typeof v === "boolean",
      }) as Capability["models"][number],
  );
  if (
    new Set(models.map((m) => m.id)).size !== models.length ||
    new Set(models.map((m) => m.model)).size !== models.length ||
    models.filter((m) => m.isDefault).length > 1 ||
    models.some(
      (m) =>
        (b.runtime === "codex" && (m.efforts.length === 0 || m.defaultEffort === null)) ||
        (m.defaultEffort !== null && !m.efforts.includes(m.defaultEffort)),
    )
  )
    throw new SettingsError("INVALID_BODY");
  const defaults =
    b.defaultSettings === null
      ? null
      : (exact(b.defaultSettings, {
          model: safeText,
          effort: nullable(safeText),
        }) as Capability["defaultSettings"]);
  if (
    defaults &&
    !models.some(
      (m) =>
        m.model === defaults.model &&
        (defaults.effort === null
          ? b.runtime === "claude" && m.efforts.length === 0
          : m.efforts.includes(defaults.effort)),
    )
  )
    throw new SettingsError("INVALID_BODY");
  if (b.policy === "unsupported" && (models.length || defaults !== null))
    throw new SettingsError("INVALID_BODY");
  const result = { ...b, models, defaultSettings: defaults } as Capability;
  const { snapshotHash, ...contents } = result;
  if (capabilityHash(contents) !== snapshotHash) throw new SettingsError("INVALID_BODY");
  return result;
}
export function validateSelection(selection: Selection, catalog: Capability) {
  if (
    catalog.policy !== "verified" ||
    catalog.runtime !== selection.runtime ||
    catalog.snapshotHash !== selection.snapshotHash
  )
    throw new SettingsError("CONFLICT");
  const m = catalog.models.find((m) => m.model === selection.model);
  if (
    !m ||
    (selection.effort !== null && !m.efforts.includes(selection.effort)) ||
    (selection.effort === null && (selection.runtime !== "claude" || m.efforts.length > 0))
  )
    throw new SettingsError("INVALID_BODY");
  return selection;
}
const base = { operationId: isId, deviceId: isId, expectedConfigRevision: integer };
const selection = {
  runtime: provider,
  model: safeText,
  effort: nullable(safeText),
  snapshotHash: isHash,
};
const readModeSchema: Schema = { readMode: (v) => v === "AUTO_CODE" };
const receiptSchema = {
  operationId: isId,
  state: (v: unknown) =>
    typeof v === "string" &&
    ["LOCAL_CONFIRMATION", "COMMITTED", "APPLIED", "CANCELLED", "FAILED", "UNKNOWN"].includes(v),
  configRevision: integer,
  runtime: nullable(provider),
  model: nullable(safeText),
  effort: nullable(safeText),
  snapshotHash: nullable(isHash),
  localRootReference: nullable(isId),
  repositoryAlias: nullable(alias),
  sessionAlias: nullable(alias),
  catalog: (v: unknown) => {
    try {
      if (v !== null) projectCapability(v);
      return true;
    } catch {
      return false;
    }
  },
  bindingEpoch: nullable(positive),
  agentId: nullable(isId),
  workspaceId: nullable(isId),
};
export type Body = Record<string, unknown>;
export function validateBody(action: Action, input: unknown): Body {
  bounded(input, "BODY_TOO_LARGE");
  const lookup: Schema =
    input !== null && typeof input === "object" && Object.hasOwn(input, "operationId")
      ? { operationId: isId }
      : {};
  const schema: Schema =
    action === "poll"
      ? lookup
      : action === "list"
        ? { deviceId: isId, ...lookup }
        : action === "cancel"
          ? { operationId: isId, deviceId: isId }
          : action === "select-folder"
            ? { ...base, runtime: provider }
            : action === "select-runtime"
              ? { ...base, ...selection }
              : action === "apply"
                ? {
                    ...base,
                    ...selection,
                    localRootReference: isId,
                    repositoryAlias: alias,
                    sessionAlias: alias,
                    expectedEpoch: nullable(positive),
                  }
                : receiptSchema;
  const b = exact(
    input,
    schema,
    "INVALID_BODY",
    action === "apply" || action === "receipt" ? readModeSchema : {},
  );
  if (
    b.readMode !== undefined &&
    action === "receipt" &&
    (!isId(b.localRootReference) || !alias(b.repositoryAlias) || !provider(b.runtime))
  )
    throw new SettingsError("INVALID_BODY");
  if (b.catalog !== undefined && b.catalog !== null) b.catalog = projectCapability(b.catalog);
  return b;
}
export type Operation = {
  operationId: string;
  deviceId: string;
  expectedConfigRevision: number;
  state: State;
  requested: Body;
  receipt: Receipt | null;
};
export type Receipt = {
  operationId: string;
  state: State;
  readMode?: "AUTO_CODE";
  configRevision: number;
  runtime: Provider | null;
  model: string | null;
  effort: string | null;
  snapshotHash: string | null;
  localRootReference: string | null;
  repositoryAlias: string | null;
  sessionAlias: string | null;
  catalog: Capability | null;
  bindingEpoch: number | null;
  agentId: string | null;
  workspaceId: string | null;
};
export type SettingsResponse = {
  protocol: 1;
  deviceId: string;
  configRevision: number;
  catalog: Capability | null;
  operation: Operation | null;
  applied: Receipt | null;
  current: boolean;
  currentBinding: {
    agentId: string;
    workspaceId: string;
    bindingEpoch: number;
    runtime: Provider;
  } | null;
};
export function projectResponse(input: unknown): SettingsResponse {
  try {
    bounded(input, "UNAVAILABLE");
    const b = exact(
      input,
      {
        protocol: (v) => v === protocol,
        deviceId: isId,
        configRevision: integer,
        catalog: (v) => v === null || !!v,
        operation: (v) => v === null || !!v,
        applied: (v) => v === null || !!v,
        current: (v) => typeof v === "boolean",
        currentBinding: (v) => v === null || !!v,
      },
      "UNAVAILABLE",
    );
    if (b.catalog !== null) b.catalog = projectCapability(b.catalog);
    if (b.currentBinding !== null)
      b.currentBinding = exact(
        b.currentBinding,
        {
          agentId: isId,
          workspaceId: isId,
          bindingEpoch: positive,
          runtime: provider,
        },
        "UNAVAILABLE",
      );
    if (b.applied !== null)
      b.applied = exact(b.applied, receiptSchema, "UNAVAILABLE", readModeSchema);
    if (b.operation !== null) {
      const op = exact(
        b.operation,
        {
          operationId: isId,
          deviceId: isId,
          expectedConfigRevision: integer,
          state: (v) => states.includes(v as State),
          requested: (v) => !!v && typeof v === "object" && !Array.isArray(v),
          receipt: (v) => v === null || !!v,
        },
        "UNAVAILABLE",
      );
      const requested = op.requested as Record<string, unknown>;
      const action = Object.hasOwn(requested, "expectedEpoch")
        ? "apply"
        : Object.hasOwn(requested, "model")
          ? "select-runtime"
          : "select-folder";
      op.requested = validateBody(action, requested);
      if (op.receipt !== null)
        op.receipt = exact(op.receipt, receiptSchema, "UNAVAILABLE", readModeSchema);
      b.operation = op;
    }
    for (const receipt of [b.applied, (b.operation as Operation | null)?.receipt]) {
      if (receipt && Object.hasOwn(receipt, "readMode")) validateBody("receipt", receipt);
    }
    return b as SettingsResponse;
  } catch {
    throw new SettingsError("UNAVAILABLE");
  }
}
export function projectEnvelope(input: unknown, status: number): SettingsResponse {
  if (status === 200) {
    const e = exact(input, { ok: (v) => v === true, data: (v) => !!v }, "UNAVAILABLE");
    return projectResponse(e.data);
  }
  const e = exact(input, { ok: (v) => v === false, error: (v) => !!v }, "UNAVAILABLE");
  const err = exact(
    e.error,
    { code: (v) => typeof v === "string" && Object.hasOwn(errorStatus, v) },
    "UNAVAILABLE",
  );
  const code = err.code as ErrorCode;
  if (errorStatus[code] !== status) throw new SettingsError("UNAVAILABLE");
  throw new SettingsError(code);
}
