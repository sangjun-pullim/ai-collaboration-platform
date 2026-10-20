import { WorkflowError, projectResponse, type Action } from "./contracts.ts";

/** A persisted denial is a claim-only RPC result, never a public success projection. */
export function projectRpcResponse(action: Action, value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "claimDenied")
  ) {
    if (
      action === "claim" &&
      Object.keys(value).length === 1 &&
      ["INPUT_PAUSED", "REQUEST_CANCELLED"].includes((value as { claimDenied: string }).claimDenied)
    )
      throw new WorkflowError(
        (value as { claimDenied: "INPUT_PAUSED" | "REQUEST_CANCELLED" }).claimDenied,
      );
    throw new WorkflowError("UNAVAILABLE");
  }
  return projectResponse(action, value);
}
