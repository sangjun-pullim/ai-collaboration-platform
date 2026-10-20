import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryableAuthFailure } from "../room-access/team-entry-policy";
import { WorkflowError, errorStatus } from "./contracts";
import {
  runDiagnosticsRequest,
  projectRunDiagnostics,
  type RunDiagnosticsRequest,
} from "./run-diagnostics-contracts";

export async function readRunDiagnostics(client: SupabaseClient, input: RunDiagnosticsRequest) {
  const body = runDiagnosticsRequest(input);
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user)
    throw new WorkflowError(retryableAuthFailure(error) ? "UNAVAILABLE" : "UNAUTHENTICATED");
  if (body.expectedUserId.toLowerCase() !== user.id.toLowerCase())
    throw new WorkflowError("FORBIDDEN");
  const result = await client.rpc("workflow_human_run_diagnostics", { p_body: body });
  if (result.error)
    throw new WorkflowError(
      result.error.code === "P0001" && Object.hasOwn(errorStatus, result.error.message)
        ? (result.error.message as keyof typeof errorStatus)
        : "UNAVAILABLE",
    );
  return projectRunDiagnostics(result.data, body);
}
