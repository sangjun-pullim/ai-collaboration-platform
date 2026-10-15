import {
  validateObservation,
  projectObservation,
  type SetupIdentity,
  type SetupReport,
} from "./setup-contracts.ts";
import {
  SettingsError,
  validateBody,
  projectEnvelope,
  maxBytes,
  type Body,
  type DeviceAction,
} from "./contracts.ts";
import { serviceOrigin } from "../central-client.ts";
export class SettingsClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    try {
      this.origin = serviceOrigin(origin);
    } catch {
      throw new SettingsError("INVALID_BODY");
    }
  }
  async call(action: DeviceAction, body: Body, secret: string, timeoutMs = 10000) {
    const result = await this.send(
      "runtime-settings",
      action,
      validateBody(action, body),
      secret,
      timeoutMs,
    );
    return projectEnvelope(result.input, result.status);
  }
  async observe(
    action: "settings-inspect" | "settings-report",
    body: SetupIdentity | SetupReport,
    secret: string,
    timeoutMs = 2000,
  ) {
    let validated;
    try {
      validated = validateObservation(action, body);
    } catch {
      throw new SettingsError("INVALID_BODY");
    }
    const envelope = await this.send(
      "connection-setup",
      action,
      validated,
      secret,
      Math.min(2000, timeoutMs),
    );
    if (!envelope.input || typeof envelope.input !== "object")
      throw new SettingsError("UNAVAILABLE");
    const value = envelope.input as { ok?: boolean; data?: unknown };
    if (envelope.status !== 200 || value.ok !== true) throw new SettingsError("UNAVAILABLE");
    try {
      return projectObservation(value.data);
    } catch {
      throw new SettingsError("UNAVAILABLE");
    }
  }
  private async send(
    namespace: string,
    action: string,
    validated: unknown,
    secret: string,
    timeoutMs: number,
  ) {
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new SettingsError("UNAUTHENTICATED");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SettingsError("INVALID_BODY");
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/api/${namespace}/${action}`, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(Math.min(10000, Math.floor(timeoutMs))),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(validated),
      });
    } catch {
      throw new SettingsError("UNAVAILABLE");
    }
    if (response.headers.get("content-type")?.split(";")[0] !== "application/json")
      throw new SettingsError("UNAVAILABLE");
    const reader = response.body?.getReader();
    if (!reader) throw new SettingsError("UNAVAILABLE");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          throw new SettingsError("UNAVAILABLE");
        }
        parts.push(value);
      }
    } catch {
      throw new SettingsError("UNAVAILABLE");
    } finally {
      reader.releaseLock();
    }
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
    } catch {
      throw new SettingsError("UNAVAILABLE");
    }
    return { input, status: response.status };
  }
}
