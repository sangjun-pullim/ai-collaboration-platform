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

export async function connectionProfile(
  origin: string,
  userId: string,
  roomId: string,
): Promise<string> {
  connectionOrigin(origin);
  if (!isId(userId) || !isId(roomId)) throw new Error("INVALID_CONNECTION_SCOPE");
  const bytes = new TextEncoder().encode(JSON.stringify([origin, userId, roomId]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `web-${hex.slice(0, 32)}`;
}

export async function localConnectionCommand(input: {
  origin: string;
  userId: string;
  roomId: string;
  organizationId: string;
  deviceAlias: string;
  manifest: unknown;
}): Promise<string> {
  const origin = connectionOrigin(input.origin);
  if (!isId(input.organizationId) || !isAlias(input.deviceAlias))
    throw new Error("INVALID_CONNECTION_SCOPE");
  const manifest = parseConnectionManifest(input.manifest);
  const profile = await connectionProfile(origin, input.userId, input.roomId);
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
/bin/bash --noprofile --norc -p "$file" "$1" "$4" "$5" "$6" "$7"`;
  return `(builtin unset ${preloadVariables.join(" ")}; /bin/bash --noprofile --norc -p -c ${quote(launcher)} ai-collab ${[origin, manifest.bootstrap.path, manifest.bootstrap.sha256, profile, input.deviceAlias, input.organizationId, input.roomId].map(quote).join(" ")})`;
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
