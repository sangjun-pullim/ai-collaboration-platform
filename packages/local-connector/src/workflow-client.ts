import { serviceOrigin } from "./central-client.ts";
import {
  WorkflowError,
  validateBody,
  projectEnvelope,
  type Body,
  type DeviceAction,
} from "./workflow-contracts.ts";
export class WorkflowClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly fetcher?: typeof fetch,
  ) {
    try {
      this.origin = serviceOrigin(origin);
    } catch {
      throw new WorkflowError("INVALID_BODY");
    }
  }
  async call(action: DeviceAction, body: Body, secret: string, timeoutMs = 10000) {
    const validated = validateBody(action, body);
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new WorkflowError("UNAUTHENTICATED");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new WorkflowError("INVALID_BODY");
    let response: Response;
    try {
      response = await (this.fetcher ?? fetch)(`${this.origin}/api/workflow/${action}`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, Math.floor(timeoutMs)))),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(validated),
      });
    } catch {
      throw new WorkflowError("UNAVAILABLE");
    }
    if (response.headers.get("content-type")?.split(";")[0] !== "application/json")
      throw new WorkflowError("UNAVAILABLE");
    const reader = response.body?.getReader();
    if (!reader) throw new WorkflowError("UNAVAILABLE");
    const responseLimit = ["source-support", "source-upload", "source-confirm"].includes(action)
      ? 16384
      : 65536;
    let size = 0;
    const parts: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > responseLimit) {
          await reader.cancel();
          throw new WorkflowError("UNAVAILABLE");
        }
        parts.push(value);
      }
    } catch {
      throw new WorkflowError("UNAVAILABLE");
    } finally {
      reader.releaseLock();
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    } catch {
      throw new WorkflowError("UNAVAILABLE");
    }
    return projectEnvelope(action, envelope, response.status);
  }
}
