import { ConnectionError, projectResponse, validateBody, type ConnectorAction, type Body, errorStatus } from "./contracts.ts";
export function serviceOrigin(input: string) {
  let url: URL; try { url = new URL(input); } catch { throw new ConnectionError("INVALID_BODY"); }
  if (url.origin !== input || url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) throw new ConnectionError("INVALID_BODY");
  return url.origin;
}
export class CentralClient {
  readonly origin: string;
  constructor(origin: string, private readonly fetcher?: typeof fetch) { this.origin = serviceOrigin(origin); }
  async call(action: ConnectorAction, body: Body, secret?: string) {
    validateBody(action, body);
    let response: Response;
    try { response = await (this.fetcher??fetch)(`${this.origin}/api/connector/${action}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) }); } catch { throw new ConnectionError("UNAVAILABLE"); }
    if (response.headers.get("content-type")?.split(";")[0] !== "application/json") throw new ConnectionError("UNAVAILABLE");
    const reader = response.body?.getReader(); if (!reader) throw new ConnectionError("UNAVAILABLE");
    let size = 0; const parts: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 16384) { await reader.cancel(); throw new ConnectionError("UNAVAILABLE"); } parts.push(value); } } finally { reader.releaseLock(); }
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new ConnectionError("UNAVAILABLE"); }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).length !== 2) throw new ConnectionError("UNAVAILABLE");
    if (envelope.ok === false && !response.ok && Object.hasOwn(envelope, "error")) {
      const error = envelope.error as Record<string, unknown>;
      if (error && typeof error === "object" && Object.keys(error).length === 1 && typeof error.code === "string" && Object.hasOwn(errorStatus, error.code) && response.status === errorStatus[error.code as keyof typeof errorStatus]) throw new ConnectionError(error.code as keyof typeof errorStatus);
    }
    if (!response.ok || envelope.ok !== true || !Object.hasOwn(envelope, "data")) throw new ConnectionError("UNAVAILABLE");
    return projectResponse(action, envelope.data, true);
  }
}
