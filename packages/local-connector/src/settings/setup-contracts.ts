// Public observations are hints, never authorization or completion evidence.
export const setupStages = [
  "FOLDER_SELECTION",
  "SHARING_CONFIRMATION",
  "MODEL_DISCOVERY",
  "MODEL_SELECTION",
  "APPLYING",
  "CANCELLING",
  "FAILED",
] as const;
export const setupReasons = [
  "UNCONFIRMED",
  "TIMEOUT",
  "DENIED",
  "UNSUPPORTED",
  "FAILED",
  "SHARING_UNCONFIRMED",
  "PROVIDER_UNAVAILABLE",
  "RUNTIME_BUSY",
  "SNAPSHOT_CHANGED",
  "POLICY_UNCONFIRMED",
  "CONTEXT_UNCONFIRMED",
  "CLEANUP_INCOMPLETE",
  "FORBIDDEN",
  "CONFLICT",
  "UNAUTHENTICATED",
  "UNAVAILABLE",
] as const;
export const startupStages = ["PREPARING", "DOWNLOADING", "CONNECTING", "FAILED"] as const;
export const startupReasons = [
  ...setupReasons,
  "MACOS_REQUIRED",
  "MACOS_13_5_REQUIRED",
  "UNSUPPORTED_ARCHITECTURE",
  "DOWNLOAD_FAILED",
  "DOWNLOAD_DIGEST",
  "INVALID_MANIFEST",
  "INVALID_ARCHIVE",
  "INVALID_DESCRIPTION",
  "EXPIRED",
  "RUNTIME_VERSION",
  "RUNTIME_ARCHIVE",
  "RUNTIME_FILE",
  "REDIRECT_OR_HTTP_ERROR",
  "DOWNLOAD_SIZE",
  "MACOS_VERSION",
] as const;
export type SetupStage = (typeof setupStages)[number];
export type SetupReason = (typeof setupReasons)[number];
export type StartupStage = (typeof startupStages)[number];
export type StartupReason = (typeof startupReasons)[number];
export type SetupIdentity = { deviceId: string; operationId: string; configRevision: number };
export type SetupReport = SetupIdentity & {
  stage: SetupStage;
  reason: SetupReason | null;
  sequence: number;
};
export type SetupObservation = SetupReport & { receivedAt: string };
export type StartupReport = {
  attemptId: string;
  sequence: number;
  stage: StartupStage;
  reason: StartupReason | null;
};
export type StartupObservation = StartupReport & { receivedAt: string; authenticated: false };
export type ObservationResponse = { sequence: number; observation: SetupObservation | null };
export const setupMaxBytes = 16384;
export function setupExact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
export function setupId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  );
}
export function setupInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum;
}
export function validateObservation(
  action: "settings-inspect" | "settings-report",
  value: unknown,
): SetupIdentity | SetupReport {
  const keys = ["deviceId", "operationId", "configRevision"];
  if (action === "settings-report") keys.push("stage", "reason", "sequence");
  if (
    !setupExact(value, keys) ||
    !setupId(value.deviceId) ||
    !setupId(value.operationId) ||
    !setupInteger(value.configRevision)
  )
    throw new Error("INVALID_BODY");
  if (
    action === "settings-report" &&
    (!setupStages.includes(value.stage as SetupStage) ||
      !(value.reason === null || setupReasons.includes(value.reason as SetupReason)) ||
      !setupInteger(value.sequence, 1))
  )
    throw new Error("INVALID_BODY");
  return value as unknown as SetupIdentity | SetupReport;
}
export function projectObservation(value: unknown): ObservationResponse {
  if (!setupExact(value, ["sequence", "observation"]) || !setupInteger(value.sequence))
    throw new Error("UNAVAILABLE");
  if (value.observation !== null) {
    if (
      !setupExact(value.observation, [
        "deviceId",
        "operationId",
        "configRevision",
        "stage",
        "reason",
        "sequence",
        "receivedAt",
      ]) ||
      typeof value.observation.receivedAt !== "string" ||
      !Number.isFinite(Date.parse(value.observation.receivedAt))
    )
      throw new Error("UNAVAILABLE");
    const { receivedAt: _, ...report } = value.observation;
    void _;
    validateObservation("settings-report", report);
    if (report.sequence !== value.sequence) throw new Error("UNAVAILABLE");
  } else if (value.sequence !== 0) throw new Error("UNAVAILABLE");
  return value as unknown as ObservationResponse;
}
