import { serviceOrigin } from "./central-client.ts";
import {
  WorkflowError,
  validateBody,
  projectEnvelope,
  type Body,
  type DeviceAction,
  type ImageDescriptor,
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
  async imageCapability(agentId: string, bindingEpoch: number, secret: string): Promise<void> {
    const scope = validateBody("poll", { protocol: 1, agentId, bindingEpoch });
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new WorkflowError("UNAUTHENTICATED");
    const response = await (this.fetcher ?? fetch)(
      `${this.origin}/api/chat-attachments/capability`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ ...scope, imageInputVersion: 1 }),
      },
    );
    await response.body?.cancel();
    if (!response.ok) throw new WorkflowError("UNAVAILABLE");
  }
  async image(
    body: Body,
    secret: string,
    descriptor: ImageDescriptor,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new WorkflowError("UNAUTHENTICATED");
    const response = await (this.fetcher ?? fetch)(
      `${this.origin}/api/chat-attachments/device-download`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      },
    );
    const reader = response.body?.getReader();
    if (!reader) throw new WorkflowError("UNAVAILABLE");
    try {
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0] !== descriptor.mime ||
        response.headers.get("content-length") !== String(descriptor.bytes)
      )
        throw new WorkflowError("UNAVAILABLE");
      const buffer = Buffer.alloc(descriptor.bytes);
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > buffer.length) throw new WorkflowError("UNAVAILABLE");
        buffer.set(value, size);
        size += value.length;
      }
      if (size !== buffer.length) throw new WorkflowError("UNAVAILABLE");
      return buffer;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
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
