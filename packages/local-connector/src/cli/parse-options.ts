import { ConnectionError } from "../contracts.ts";
import { createHash } from "node:crypto";

export type RecoveryChain = {
  version: 1;
  baseProfile: string;
  chain: { previousProfile: string; recoveryId: string; profile: string }[];
};
const webProfile = (value: unknown): value is string =>
  typeof value === "string" && /^web-[a-f0-9]{32}$/.test(value);
const nonce = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export function parseRecoveryChain(
  raw: string,
  profile: string,
  previous: string,
  id: string,
): RecoveryChain {
  try {
    if (Buffer.byteLength(raw) > 16384) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (
      !exact(value, ["version", "baseProfile", "chain"]) ||
      value.version !== 1 ||
      !webProfile(value.baseProfile) ||
      !Array.isArray(value.chain) ||
      !value.chain.length ||
      value.chain.length > 32
    )
      throw new Error();
    let parent = value.baseProfile;
    for (const generation of value.chain) {
      if (
        !exact(generation, ["previousProfile", "recoveryId", "profile"]) ||
        generation.previousProfile !== parent ||
        !nonce(generation.recoveryId) ||
        generation.profile !==
          `web-${createHash("sha256")
            .update(JSON.stringify(["connection-recovery", parent, generation.recoveryId]))
            .digest("hex")
            .slice(0, 32)}` ||
        generation.profile === parent
      )
        throw new Error();
      parent = generation.profile as string;
    }
    const last = value.chain.at(-1);
    if (last.profile !== profile || last.previousProfile !== previous || last.recoveryId !== id)
      throw new Error();
    return value as unknown as RecoveryChain;
  } catch {
    throw new ConnectionError("INVALID_BODY");
  }
}

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
    "recovery-chain",
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
  if (options["recovery-chain"] !== undefined) {
    if (command !== "connect" || !options["previous-profile"] || !options["recovery-id"])
      throw new ConnectionError("INVALID_BODY");
    parseRecoveryChain(
      options["recovery-chain"],
      options.profile,
      options["previous-profile"],
      options["recovery-id"],
    );
  }
  return options;
}
