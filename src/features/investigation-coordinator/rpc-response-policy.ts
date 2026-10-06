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
      (value as { claimDenied: unknown }).claimDenied === "INPUT_PAUSED"
    )
      throw new WorkflowError("INPUT_PAUSED");
    throw new WorkflowError("UNAVAILABLE");
  }
  return projectResponse(action, value);
}
