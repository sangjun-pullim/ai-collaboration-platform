import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retryableAuthFailure } from "../room-access/team-entry-policy";
import { WorkflowError, errorStatus } from "./contracts";
import { projectHistoryWindow, type HistoryWindowRequest } from "./history-window-contracts";

export async function readHistoryWindow(client: SupabaseClient, body: HistoryWindowRequest) {
  const {
    data: { user },
    error,
  } = await client.auth.getUser();
  if (error || !user)
    throw new WorkflowError(retryableAuthFailure(error) ? "UNAVAILABLE" : "UNAUTHENTICATED");
  if (body.expectedUserId.toLowerCase() !== user.id.toLowerCase())
    throw new WorkflowError("FORBIDDEN");
  const result = await client.rpc("workflow_human_history_window", { p_body: body });
  if (result.error)
    throw new WorkflowError(
      result.error.code === "P0001" && Object.hasOwn(errorStatus, result.error.message)
        ? (result.error.message as keyof typeof errorStatus)
        : "UNAVAILABLE",
    );
  return projectHistoryWindow(result.data);
}
