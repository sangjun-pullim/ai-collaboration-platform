import { WorkflowError } from "./contracts.ts";

export const RUN_DIAGNOSTICS_LIMIT = 40;
export const RUN_DIAGNOSTICS_BYTES = 16384;
export type StopReason =
  "RESPONSE_TIMEOUT" | "EXECUTION_LEASE_EXPIRED" | "BINDING_CHANGED" | "CONTEXT_CHANGED";
export type RunDiagnostic = {
  requestId: string;
  deadline: string;
  stopReason: StopReason | null;
  stopObservedAt: string | null;
};
export type RunDiagnosticsRequest = {
  protocol: 1;
  expectedUserId: string;
  roomId: string;
  requestIds: string[];
};
export type RunDiagnostics = { protocol: 1; roomId: string; diagnostics: RunDiagnostic[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
export function runDiagnosticsRequest(value: unknown): RunDiagnosticsRequest {
  if (
    !exact(value, ["protocol", "expectedUserId", "roomId", "requestIds"]) ||
    value.protocol !== 1 ||
    !id(value.expectedUserId) ||
    !id(value.roomId) ||
    !Array.isArray(value.requestIds) ||
    value.requestIds.length < 1 ||
    value.requestIds.length > RUN_DIAGNOSTICS_LIMIT ||
    !value.requestIds.every(id) ||
    new Set(value.requestIds.map((x) => x.toLowerCase())).size !== value.requestIds.length
  )
    throw new WorkflowError("INVALID_BODY");
  return value as RunDiagnosticsRequest;
}
export function projectRunDiagnostics(
  value: unknown,
  request?: RunDiagnosticsRequest,
): RunDiagnostics {
  const fail = () => {
    throw new WorkflowError("UNAVAILABLE");
  };
  if (
    !exact(value, ["protocol", "roomId", "diagnostics"]) ||
    value.protocol !== 1 ||
    !id(value.roomId) ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > RUN_DIAGNOSTICS_LIMIT ||
    new TextEncoder().encode(JSON.stringify(value)).length > RUN_DIAGNOSTICS_BYTES
  )
    return fail();
  for (const item of value.diagnostics) {
    if (
      !exact(item, ["requestId", "deadline", "stopReason", "stopObservedAt"]) ||
      !id(item.requestId) ||
      !timestamp(item.deadline) ||
      !(
        (item.stopReason === null && item.stopObservedAt === null) ||
        (typeof item.stopReason === "string" &&
          [
            "RESPONSE_TIMEOUT",
            "EXECUTION_LEASE_EXPIRED",
            "BINDING_CHANGED",
            "CONTEXT_CHANGED",
          ].includes(item.stopReason) &&
          timestamp(item.stopObservedAt))
      )
    )
      return fail();
  }
  const result = value as RunDiagnostics;
  const ids = new Set(result.diagnostics.map((x) => x.requestId.toLowerCase()));
  if (
    ids.size !== result.diagnostics.length ||
    (request &&
      (result.roomId.toLowerCase() !== request.roomId.toLowerCase() ||
        ids.size !== request.requestIds.length ||
        request.requestIds.some((x) => !ids.has(x.toLowerCase()))))
  )
    return fail();
  return result;
}
