import { ConnectionError } from "../contracts.ts";
import { createHash } from "node:crypto";

export function parseCliOptions(rest: string[], command?: string): Record<string, string> {
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
    "previous-profile",
    "recovery-id",
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
  if (options["previous-profile"] !== undefined || options["recovery-id"] !== undefined) {
    const previous = options["previous-profile"],
      id = options["recovery-id"];
    if (
      command !== "connect" ||
      !/^web-[a-f0-9]{32}$/.test(previous ?? "") ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id ?? "") ||
      options.profile === previous ||
      options.profile !==
        `web-${createHash("sha256")
          .update(JSON.stringify(["connection-recovery", previous, id]))
          .digest("hex")
          .slice(0, 32)}`
    )
      throw new ConnectionError("INVALID_BODY");
  }
  return options;
}
