import { AccessError } from "./contracts";

export type EntryIdentity = { userId: string; displayName: string };
type AuthFailure = { name?: string; status?: number; code?: string };

export function retryableAuthFailure(error: unknown) {
  const value = error as AuthFailure | null;
  return (
    !value ||
    value.name === "AuthRetryableFetchError" ||
    value.name === "AbortError" ||
    value.name === "TimeoutError" ||
    value.status === 429 ||
    (value.status ?? 0) >= 500 ||
    (value.status === undefined && value.name !== "AuthSessionMissingError")
  );
}

export function confirmedMissingSession(error: unknown, hasAuthCookies: boolean) {
  return !hasAuthCookies && (error as AuthFailure | null)?.name === "AuthSessionMissingError";
}

export function projectEntry(value: unknown): EntryIdentity {
  if (!value || typeof value !== "object") throw new AccessError("UNAVAILABLE");
  const data = value as Record<string, unknown>;
  if (data.ok === false) {
    const code = (data.error as { code?: string } | undefined)?.code;
    if (
      code === "CODE_REJECTED" ||
      code === "CODE_COOLDOWN" ||
      code === "UNAUTHENTICATED" ||
      code === "INVALID_BODY"
    )
      throw new AccessError(code);
    throw new AccessError("UNAVAILABLE");
  }
  if (
    data.ok !== true ||
    typeof data.userId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      data.userId,
    ) ||
    typeof data.displayName !== "string" ||
    !data.displayName.trim() ||
    data.displayName.length > 80
  )
    throw new AccessError("UNAVAILABLE");
  return { userId: data.userId, displayName: data.displayName };
}
