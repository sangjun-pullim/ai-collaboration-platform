import { WorkflowError, errorStatus } from "./contracts.ts";
import {
  HISTORY_WINDOW_BYTES,
  historyWindowRequest,
  projectHistoryWindow,
  type HistoryWindowRequest,
} from "./history-window-contracts.ts";

export async function callHistoryWindow(body: HistoryWindowRequest, signal: AbortSignal) {
  try {
    const response = await fetch("/api/chat-history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(historyWindowRequest(body)),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      cache: "no-store",
      redirect: "error",
    });
    if (
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      throw new WorkflowError("UNAVAILABLE");
    const reader = response.body?.getReader();
    if (!reader) throw new WorkflowError("UNAVAILABLE");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > HISTORY_WINDOW_BYTES) {
          await reader.cancel();
          throw new WorkflowError("UNAVAILABLE");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (response.status !== 200 || envelope?.ok !== true) {
      const code = envelope?.error?.code;
      if (
        envelope?.ok === false &&
        typeof code === "string" &&
        Object.hasOwn(errorStatus, code) &&
        errorStatus[code as keyof typeof errorStatus] === response.status
      )
        throw new WorkflowError(code as keyof typeof errorStatus);
      throw new WorkflowError("UNAVAILABLE");
    }
    return projectHistoryWindow(envelope.data);
  } catch (error) {
    if (signal.aborted || error instanceof WorkflowError) throw error;
    throw new WorkflowError("UNAVAILABLE");
  }
}
