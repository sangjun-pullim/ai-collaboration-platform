import {
  SettingsError,
  validateBody,
  projectEnvelope,
  maxBytes,
  type Body,
  type HumanAction,
} from "./contracts";
export async function requestSettings(action: HumanAction, body: Body, signal?: AbortSignal) {
  const validated = validateBody(action, body);
  let response: Response;
  try {
    response = await fetch(`/api/runtime-settings/${action}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validated),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
        : AbortSignal.timeout(10000),
    });
  } catch {
    throw new SettingsError("UNAVAILABLE");
  }
  if (response.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new SettingsError("UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new SettingsError("UNAVAILABLE");
  let size = 0;
  const parts: Uint8Array[] = [];
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
  const raw = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    raw.set(part, offset);
    offset += part.length;
  }
  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new SettingsError("UNAVAILABLE");
  }
  return projectEnvelope(input, response.status);
}
