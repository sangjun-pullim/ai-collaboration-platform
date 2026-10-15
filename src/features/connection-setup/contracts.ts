import { SettingsError, isId } from "../runtime-settings/contracts.ts";
import { isAlias, isHash } from "../device-binding/contracts.ts";
import {
  connectionOrigin,
  readConnectionSelection,
  type ConnectionSelection,
} from "../device-binding/local-connection-command.ts";
import {
  setupExact,
  setupInteger,
  startupStages,
  startupReasons,
  validateObservation,
  type StartupStage,
  type StartupReason,
} from "./setup-contracts.ts";
export * from "./setup-contracts.ts";
export const setupActions = [
  "issue",
  "inspect",
  "resolve",
  "startup-report",
  "settings-inspect",
  "settings-report",
] as const;
export type SetupAction = (typeof setupActions)[number];
export type LaunchDescription = {
  version: 1;
  origin: string;
  ownerUserId: string;
  organizationId: string;
  roomId: string;
  deviceAlias: string;
  selection: ConnectionSelection;
};
export type SetupBody = Record<string, unknown>;
export async function parseDescription(input: unknown): Promise<LaunchDescription> {
  if (
    !setupExact(input, [
      "version",
      "origin",
      "ownerUserId",
      "organizationId",
      "roomId",
      "deviceAlias",
      "selection",
    ]) ||
    input.version !== 1 ||
    typeof input.origin !== "string" ||
    !isId(input.ownerUserId) ||
    !isId(input.organizationId) ||
    !isId(input.roomId) ||
    !isAlias(input.deviceAlias)
  )
    throw new SettingsError("INVALID_BODY");
  try {
    connectionOrigin(input.origin);
    await readConnectionSelection(
      JSON.stringify(input.selection),
      input.origin,
      input.ownerUserId,
      input.roomId,
    );
  } catch {
    throw new SettingsError("INVALID_BODY");
  }
  return input as unknown as LaunchDescription;
}
export function validateSetupBody(action: SetupAction, input: unknown): SetupBody {
  const keys: Record<SetupAction, string[]> = {
    issue: ["requestId", "roomId", "deviceAlias", "selection"],
    inspect: ["roomId", "requestId", "deviceId"],
    resolve: [],
    "startup-report": ["attemptId", "sequence", "stage", "reason"],
    "settings-inspect": ["deviceId", "operationId", "configRevision"],
    "settings-report": ["deviceId", "operationId", "configRevision", "sequence", "stage", "reason"],
  };
  if (!setupExact(input, keys[action])) throw new SettingsError("INVALID_BODY");
  for (const key of ["requestId", "roomId", "deviceId", "attemptId"]) {
    if (
      Object.hasOwn(input, key) &&
      !(action === "inspect" && key !== "roomId" && input[key] === null) &&
      !isId(input[key])
    )
      throw new SettingsError("INVALID_BODY");
  }
  if (action === "issue" && !isAlias(input.deviceAlias)) throw new SettingsError("INVALID_BODY");
  if (
    action === "startup-report" &&
    (!setupInteger(input.sequence, 1) ||
      !startupStages.includes(input.stage as StartupStage) ||
      !(input.reason === null || startupReasons.includes(input.reason as StartupReason)))
  )
    throw new SettingsError("INVALID_BODY");
  if (action === "settings-inspect" || action === "settings-report") {
    try {
      validateObservation(action, input);
    } catch {
      throw new SettingsError("INVALID_BODY");
    }
  }
  return input;
}
export function setupBearer(request: Request) {
  const secret = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!isHash(secret)) throw new SettingsError("UNAUTHENTICATED");
  return secret;
}
