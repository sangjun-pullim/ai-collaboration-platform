import { isAlias, isHash, isId } from "./contracts.ts";

export type ConnectionAsset = { path: string; sha256: string; bytes: number };
export type ConnectionManifest = { version: 1; code: ConnectionAsset; bootstrap: ConnectionAsset };
export const preloadVariables = [
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5OPT",
  "PERL5DB",
  "PERL5LIB",
  "PERLLIB",
  "PERLIO",
  "PERL_USE_UNSAFE_INC",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
] as const;

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function connectionOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.origin !== input ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("UNSAFE_CONNECTION_ORIGIN");
  return url.origin;
}

export function parseConnectionManifest(input: unknown): ConnectionManifest {
  if (!exact(input, ["version", "code", "bootstrap"]) || input.version !== 1)
    throw new Error("INVALID_CONNECTION_MANIFEST");
  for (const [kind, suffix, limit] of [
    ["code", ".tar.gz", 16 * 1024 * 1024],
    ["bootstrap", ".sh", 128 * 1024],
  ] as const) {
    const asset = input[kind];
    if (
      !exact(asset, ["path", "sha256", "bytes"]) ||
      !isHash(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) ||
      Number(asset.bytes) < 1 ||
      Number(asset.bytes) > limit ||
      asset.path !==
        `/local-connection/${kind === "code" ? "connector" : "bootstrap"}-${asset.sha256}${suffix}`
    )
      throw new Error("INVALID_CONNECTION_MANIFEST");
  }
  return input as unknown as ConnectionManifest;
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

export type RecoveryGeneration = { previousProfile: string; recoveryId: string; profile: string };
export type ConnectionSelection = { version: 1; baseProfile: string; chain: RecoveryGeneration[] };
const recoveryUuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
async function profileHash(parts: string[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `web-${hex.slice(0, 32)}`;
}

export function connectionSelectionKey(origin: string, userId: string, roomId: string) {
  connectionOrigin(origin);
  if (!isId(userId) || !isId(roomId)) throw new Error("INVALID_CONNECTION_SCOPE");
  return `ai-collab-connection:${JSON.stringify([origin, userId, roomId])}`;
}

export async function readConnectionSelection(
  raw: string | null,
  origin: string,
  userId: string,
  roomId: string,
): Promise<ConnectionSelection> {
  const baseProfile = await connectionProfile(origin, userId, roomId);
  if (raw === null) return { version: 1, baseProfile, chain: [] };
  if (raw.length > 16384) throw new Error("INVALID_CONNECTION_SELECTION");
  const value: unknown = JSON.parse(raw);
  if (
    !exact(value, ["version", "baseProfile", "chain"]) ||
    value.version !== 1 ||
    value.baseProfile !== baseProfile ||
    !Array.isArray(value.chain) ||
    value.chain.length > 32
  )
    throw new Error("INVALID_CONNECTION_SELECTION");
  let previous = baseProfile;
  for (const generation of value.chain) {
    if (
      !exact(generation, ["previousProfile", "recoveryId", "profile"]) ||
      generation.previousProfile !== previous ||
      !recoveryUuid(generation.recoveryId) ||
      generation.profile !==
        (await profileHash(["connection-recovery", previous, generation.recoveryId])) ||
      generation.profile === previous
    )
      throw new Error("INVALID_CONNECTION_SELECTION");
    previous = generation.profile as string;
  }
  return value as unknown as ConnectionSelection;
}

export async function nextConnectionSelection(
  selection: ConnectionSelection,
  recoveryId: string,
): Promise<ConnectionSelection> {
  if (!recoveryUuid(recoveryId) || selection.chain.length >= 32)
    throw new Error("INVALID_CONNECTION_SELECTION");
  const previousProfile = selection.chain.at(-1)?.profile ?? selection.baseProfile;
  const profile = await profileHash(["connection-recovery", previousProfile, recoveryId]);
  if (profile === previousProfile) throw new Error("INVALID_CONNECTION_SELECTION");
  return {
    version: 1,
    baseProfile: selection.baseProfile,
    chain: [...selection.chain, { previousProfile, recoveryId, profile }],
  };
}

export async function connectionProfile(
  origin: string,
  userId: string,
  roomId: string,
): Promise<string> {
  connectionOrigin(origin);
  if (!isId(userId) || !isId(roomId)) throw new Error("INVALID_CONNECTION_SCOPE");
  return profileHash([origin, userId, roomId]);
}

export async function localConnectionCommand(input: {
  origin: string;
  userId: string;
  roomId: string;
  organizationId: string;
  deviceAlias: string;
  manifest: unknown;
  selection?: unknown;
}): Promise<string> {
  const origin = connectionOrigin(input.origin);
  if (!isId(input.organizationId) || !isAlias(input.deviceAlias))
    throw new Error("INVALID_CONNECTION_SCOPE");
  const manifest = parseConnectionManifest(input.manifest);
  const selection = await readConnectionSelection(
    input.selection === undefined ? null : JSON.stringify(input.selection),
    origin,
    input.userId,
    input.roomId,
  );
  const generation = selection.chain.at(-1);
  const profile = generation?.profile ?? selection.baseProfile;
  // -p disables inherited shell functions/startup hooks without changing user IDs.
  const launcher = `set -euo pipefail
umask 077
file=$(/usr/bin/mktemp -t ai-collab-bootstrap)
trap '/bin/rm -f "$file"' EXIT
status=$(ulimit -f 128; /usr/bin/curl --disable --fail --silent --show-error --proto '=http,https' --max-redirs 0 --connect-timeout 10 --max-time 60 --max-filesize 131072 --write-out '%{http_code}' --output "$file" "$1$2")
[ "$status" = 200 ]
[ "$(/usr/bin/wc -c < "$file")" -le 131072 ]
digest=$(/usr/bin/shasum -a 256 "$file")
[ "\${digest%% *}" = "$3" ]
/bin/bash --noprofile --norc -p "$file" "$1" "$4" "$5" "$6" "$7"${generation ? ' "$8" "$9" "${10}"' : ""}`;
  const args = [
    origin,
    manifest.bootstrap.path,
    manifest.bootstrap.sha256,
    profile,
    input.deviceAlias,
    input.organizationId,
    input.roomId,
    ...(generation
      ? [generation.previousProfile, generation.recoveryId, JSON.stringify(selection)]
      : []),
  ];
  return `(builtin unset ${preloadVariables.join(" ")}; /bin/bash --noprofile --norc -p -c ${quote(launcher)} ai-collab ${args.map(quote).join(" ")})`;
}

export function consumeConnectionFragment(hash: string, rooms: { roomId: string }[]) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (
    [...params.keys()].length !== 2 ||
    params.getAll("code").length !== 1 ||
    params.getAll("room").length !== 1
  )
    return null;
  const code = params.get("code");
  const roomId = params.get("room");
  return isHash(code) && isId(roomId) && rooms.some((room) => room.roomId === roomId)
    ? { code, roomId }
    : null;
}
