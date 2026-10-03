import {
  WorkflowError,
  projectEnvelope,
  validateBody,
  type HumanAction,
  type Body,
} from "./contracts.ts";

export async function callInvestigation(
  action: HumanAction,
  body: Body,
  signal: AbortSignal,
): Promise<unknown> {
  const validated = validateBody(action, body);
  try {
    const response = await fetch(`/api/investigations/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      cache: "no-store",
      redirect: "error",
    });
    if (
      response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    ) {
      throw new WorkflowError("UNAVAILABLE");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new WorkflowError("UNAVAILABLE");
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 262_144) {
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
    return projectEnvelope(
      action,
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      response.status,
    );
  } catch (error) {
    if (signal.aborted || error instanceof WorkflowError) throw error;
    throw new WorkflowError("UNAVAILABLE");
  }
}
