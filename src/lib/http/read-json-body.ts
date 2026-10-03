export async function readJsonBody(
  request: Request,
  options: {
    expectedOrigin?: string;
    error: (code: "UNSAFE_ORIGIN" | "INVALID_BODY" | "BODY_TOO_LARGE") => Error;
    utf8: "strict" | "replacement";
  },
): Promise<unknown> {
  if (
    options.expectedOrigin !== undefined &&
    request.headers.get("origin") !== options.expectedOrigin
  )
    throw options.error("UNSAFE_ORIGIN");
  if (
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json"
  )
    throw options.error("INVALID_BODY");
  const reader = request.body?.getReader();
  if (!reader) throw options.error("INVALID_BODY");
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw options.error("BODY_TOO_LARGE");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(parts, size);
  try {
    const text =
      options.utf8 === "strict"
        ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        : bytes.toString("utf8");
    return JSON.parse(text);
  } catch {
    throw options.error("INVALID_BODY");
  }
}
