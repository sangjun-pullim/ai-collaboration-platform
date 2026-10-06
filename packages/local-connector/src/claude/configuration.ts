import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, parse, resolve } from "node:path";
import { createHash } from "node:crypto";
import { providerEnvironment as codexProviderEnvironment } from "../codex-transport.ts";
import { digest, RuntimeError, stableJson } from "../runtime-contracts.ts";
import { object } from "./owned-history.ts";

export type SourceKind = "user" | "project" | "local" | "managed" | "instruction" | "auth";
export interface ConfigurationSource {
  path: string;
  kind: SourceKind;
}
export interface SourceSnapshot {
  path: string;
  kind: SourceKind | "binary";
  identity: string;
  hash: string;
  env: Record<string, string>;
  plugins: string[];
  managedConflict: boolean;
}

export function canonicalAncestors(path: string): void {
  if (path !== resolve(path)) throw new RuntimeError("POLICY_UNCONFIRMED");
  let current = path;
  for (;;) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || realpathSync(current) !== current)
        throw new RuntimeError("UNSAFE_STORAGE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) break;
    current = parent;
  }
}
export function fileIdentity(stat: Stats): string {
  return [
    stat.dev,
    stat.ino,
    stat.uid,
    stat.mode,
    stat.nlink,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ].join(":");
}

/** Bounded descriptor reads; no raw settings or credentials survive this function. */
export function readConfigurationFile(
  path: string,
  limit = 1024 * 1024,
  singleLink = true,
): Buffer | null {
  canonicalAncestors(path);
  let before: Stats;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RuntimeError("UNSAFE_STORAGE");
  }
  if (
    !before.isFile() ||
    (singleLink && before.nlink !== 1) ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o022) !== 0 ||
    before.size > limit
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (fileIdentity(fstatSync(fd)) !== fileIdentity(before))
      throw new RuntimeError("SNAPSHOT_CHANGED");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (
      offset !== before.size ||
      fileIdentity(fstatSync(fd)) !== fileIdentity(before) ||
      fileIdentity(lstatSync(path)) !== fileIdentity(before)
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    return bytes.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RuntimeError("POLICY_UNCONFIRMED");
  }
}
function absentIdentity(path: string): string {
  let parent = dirname(path);
  for (;;) {
    try {
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new RuntimeError("UNSAFE_STORAGE");
      return `ABSENT:${parent}:${stat.dev}:${stat.ino}:${stat.uid}:${stat.mode}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (parent === next) throw new RuntimeError("UNSAFE_STORAGE");
      parent = next;
    }
  }
}
const authenticationKeys = new Set([
  "oauthAccount",
  "claudeAiOauth",
  "oauthToken",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "apiKey",
  "primaryApiKey",
  "userID",
  "emailAddress",
]);
function executionProjection(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !authenticationKeys.has(key)));
}
function nonempty(value: unknown) {
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    !(Array.isArray(value) && value.length === 0) &&
    !(typeof value === "object" && Object.keys(value).length === 0)
  );
}
export function snapshotSource(
  source: ConfigurationSource,
  prior?: SourceSnapshot,
): SourceSnapshot {
  canonicalAncestors(source.path);
  let identity = absentIdentity(source.path);
  try {
    identity += `:FILE:${fileIdentity(lstatSync(source.path))}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new RuntimeError("UNSAFE_STORAGE");
  }
  if (prior?.identity === identity) return prior;
  const bytes = readConfigurationFile(source.path);
  let projected: unknown = null,
    env: Record<string, string> = {},
    plugins: string[] = [],
    managedConflict = false;
  if (bytes !== null) {
    const text = decode(bytes);
    if (source.kind === "instruction") projected = text;
    else {
      let value: Record<string, unknown>;
      try {
        value = object(JSON.parse(text));
      } catch {
        throw new RuntimeError("POLICY_UNCONFIRMED");
      }
      const execution = executionProjection(value);
      projected = execution;
      if (value.enabledPlugins !== undefined) {
        const enabled = object(value.enabledPlugins);
        plugins = Object.keys(enabled).sort();
        if (
          plugins.length > 256 ||
          plugins.some(
            (name) =>
              !name ||
              name.length > 256 ||
              /[\0\r\n]/.test(name) ||
              typeof enabled[name] !== "boolean",
          )
        )
          throw new RuntimeError("POLICY_UNCONFIRMED");
      }
      if (value.env !== undefined) {
        const raw = object(value.env);
        if (
          Object.entries(raw).some(
            ([key, entry]) =>
              !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof entry !== "string" || entry.length > 8192,
          )
        )
          throw new RuntimeError("POLICY_UNCONFIRMED");
        if (
          Object.keys(providerEnvironment(raw as NodeJS.ProcessEnv)).length !==
          Object.keys(raw).length
        )
          throw new RuntimeError("POLICY_UNCONFIRMED");
        env =
          typeof raw.CLAUDE_CODE_EFFORT_LEVEL === "string"
            ? { CLAUDE_CODE_EFFORT_LEVEL: raw.CLAUDE_CODE_EFFORT_LEVEL }
            : {};
      }
      if (
        [
          "apiKeyHelper",
          "awsAuthRefresh",
          "awsCredentialExport",
          "otelHeadersHelper",
          "policyHelper",
        ].some((key) => nonempty(value[key]))
      )
        throw new RuntimeError("POLICY_UNCONFIRMED");
      managedConflict =
        source.kind === "managed" &&
        ((value.disableAllHooks !== undefined && value.disableAllHooks !== true) ||
          [
            "hooks",
            "enabledPlugins",
            "extraKnownMarketplaces",
            "permissions",
            "mcpServers",
            "forceLoginMethod",
          ].some((key) => nonempty(value[key])));
    }
  }
  return {
    path: source.path,
    kind: source.kind,
    identity,
    hash: digest(stableJson(projected)),
    env,
    plugins,
    managedConflict,
  };
}

export function snapshotBinary(path: string, prior?: SourceSnapshot): SourceSnapshot {
  canonicalAncestors(path);
  const identity = fileIdentity(lstatSync(path));
  if (prior?.identity === identity) return prior;
  const bytes = readConfigurationFile(path, 256 * 1024 * 1024, false);
  if (!bytes) throw new RuntimeError("POLICY_UNCONFIRMED");
  return {
    path,
    kind: "binary",
    identity,
    hash: createHash("sha256").update(bytes).digest("hex"),
    env: {},
    plugins: [],
    managedConflict: false,
  };
}

export function providerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(codexProviderEnvironment(env)).filter(
      ([key]) =>
        !/^(?:LOCAL_ACCESS_|LOCAL_DEVICE_|LOCAL_WORKFLOW_|AI_COLLAB_)/.test(key) &&
        !/(?:DATABASE|DB_URL|POSTGRES|SUPABASE|ADMIN|BEARER)/i.test(key),
    ),
  );
}
