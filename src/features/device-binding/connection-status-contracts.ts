import { ConnectionError, isId, projectDevice, type OwnedDevice } from "./contracts.ts";

export type StatusRequest = { expectedUserId: string; roomId: string; deviceId: string };
export const preinputReasons = [
  "SNAPSHOT_CHANGED",
  "POLICY_REJECTED",
  "LOCAL_VALIDATION_FAILED",
] as const;
export type ExecutionStatus = {
  agentId: string;
  bindingEpoch: number;
  failure: { requestId: string; reason: (typeof preinputReasons)[number] } | null;
};
export type ConnectionStatus = StatusRequest & {
  device: OwnedDevice;
  checkedAt: string;
  executionStatus: ExecutionStatus | null;
};

export function validateStatusRequest(input: unknown): StatusRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ConnectionError("INVALID_BODY");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    !["expectedUserId", "roomId", "deviceId"].every((key) => isId(value[key]))
  )
    throw new ConnectionError("INVALID_BODY");
  return value as StatusRequest;
}

export function projectExecutionStatus(input: unknown): ExecutionStatus | null {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ConnectionError("UNAVAILABLE");
  const value = input as ExecutionStatus;
  if (
    !isId(value.agentId) ||
    !Number.isSafeInteger(value.bindingEpoch) ||
    value.bindingEpoch < 1 ||
    (value.failure !== null &&
      (!value.failure ||
        !isId(value.failure.requestId) ||
        !preinputReasons.includes(value.failure.reason)))
  )
    throw new ConnectionError("UNAVAILABLE");
  return {
    agentId: value.agentId,
    bindingEpoch: value.bindingEpoch,
    failure:
      value.failure === null
        ? null
        : { requestId: value.failure.requestId, reason: value.failure.reason },
  };
}

export function projectConnectionStatus(input: unknown, expected: StatusRequest): ConnectionStatus {
  if (!input || typeof input !== "object") throw new ConnectionError("UNAVAILABLE");
  const value = input as ConnectionStatus;
  const device = projectDevice(value.device);
  if (
    value.expectedUserId !== expected.expectedUserId ||
    value.roomId !== expected.roomId ||
    value.deviceId !== expected.deviceId ||
    device.deviceId !== expected.deviceId ||
    device.roomId !== expected.roomId ||
    typeof value.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(value.checkedAt))
  )
    throw new ConnectionError("UNAVAILABLE");
  return {
    ...expected,
    device,
    checkedAt: value.checkedAt,
    executionStatus: projectExecutionStatus(value.executionStatus),
  };
}
