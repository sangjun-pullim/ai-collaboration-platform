import { ConnectionError } from "../contracts.ts";

export function parseCliOptions(rest: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  const allowed = new Set([
    "server",
    "state-dir",
    "profile",
    "device-alias",
    "organization-id",
    "room-id",
    "confirm-scope",
    "root",
    "native-session",
    "repository-alias",
    "session-alias",
    "agent-id",
    "confirm-public",
    "runtime",
    "model",
    "effort",
    "runtime-default",
    "files",
    "handoff",
    "confirm-new-context",
    "confirm-auto-questions",
    "once",
  ]);
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2);
    if (
      !rest[i]?.startsWith("--") ||
      !allowed.has(key) ||
      !rest[i + 1] ||
      Object.hasOwn(options, key)
    )
      throw new ConnectionError("INVALID_BODY");
    options[key] = rest[i + 1];
  }
  return options;
}
