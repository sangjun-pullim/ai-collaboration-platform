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
  projection?: "native-global";
  projectionRoots?: readonly string[];
  nativeReadOnly?: boolean;
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
function nativeGlobalProjection(value: Record<string, unknown>, roots: readonly string[] = []) {
  // These are CLI bookkeeping, not executable policy. Unknown keys remain pinned.
  const bookkeeping = new Set([
    "numStartups",
    "installMethod",
    "autoUpdates",
    "autoUpdaterStatus",
    "cachedStatsigGates",
    "cachedDynamicConfigs",
    "cachedGrowthBookFeatures",
    "cachedClaudeAiOrg",
    "cachedSubscriptionInfo",
    "cachedExtraUsageEnabled",
    "cachedAccountSubscriptionType",
    "lastReleaseNotesSeen",
    "lastOnboardingVersion",
    "hasCompletedOnboarding",
    "firstStartTime",
    "lastCost",
    "lastDuration",
    "lastSessionId",
    "changelogCache",
    "claudeCodeFirstTokenDate",
    "s1mAccessCache",
    "groveConfigCache",
    "migrationFlags",
    "nativeBinaryLastUpdatedAt",
    "tipsHistory",
    "cachedUsageUtilization",
    "cachedGrowthBookFeaturesAt",
    "cachedExperimentData",
    "cachedExperimentFeatures",
    "cachedArtifactRoster",
    "cachedChromeExtensionInstalled",
    "cachedExtraUsageDisabledReason",
    "additionalModelCostsCache",
    "additionalModelOptionsCache",
    "additionalModelOptionsAnsweredAt",
    "autoCompactWindowsCache",
    "clientDataCacheSlots",
    "orgModelDefaultCache",
    "modelAccessCache",
    "overageCreditGrantCache",
    "promoStartupStatusCache",
    "passesEligibilityCache",
    "githubWebConnectionStatusCache",
    "changelogLastFetched",
    "agentLastUsed",
    "skillUsage",
    "toolUsage",
    "pluginUsage",
    "announcementImpressions",
    "seenNotifications",
    "tipsHistoryByCommand",
    "tipLifetimeShownCounts",
    "subscriptionNoticeCount",
    "promptQueueUseCount",
  ]);
  const feedback = value.feedbackSurveyState;
  // Only the reviewed native survey timestamp is bookkeeping; unexpected data stays pinned.
  if (
    feedback !== null &&
    typeof feedback === "object" &&
    !Array.isArray(feedback) &&
    Object.keys(feedback).length === 1 &&
    "lastShownTime" in feedback &&
    typeof feedback.lastShownTime === "number" &&
    Number.isSafeInteger(feedback.lastShownTime) &&
    feedback.lastShownTime >= 0
  )
    bookkeeping.add("feedbackSurveyState");
  const projection = Object.fromEntries(
    Object.entries(executionProjection(value)).filter(([key]) => !bookkeeping.has(key)),
  );
  const account = value.oauthAccount;
  delete projection.projects;
  if (value.projects !== undefined) {
    const projects = object(value.projects);
    projection.projects = Object.fromEntries(
      roots.flatMap((root) => {
        if (!Object.hasOwn(projects, root)) return [];
        const policy = Object.fromEntries(
          Object.entries(object(projects[root])).filter(
            ([key]) =>
              !/^last[A-Z]/.test(key) &&
              ![
                "exampleFiles",
                "exampleFilesGeneratedAt",
                "reactVulnerabilityCache",
                "hasUnseenTeamArtifacts",
                "hasClaudeMdExternalIncludesWarningShown",
              ].includes(key),
          ),
        );
        return Object.keys(policy).length ? [[root, policy]] : [];
      }),
    );
  }
  if (account !== undefined) {
    const metadata = object(account);
    // Preserve account and organization transitions while allowing token/cache refreshes.
    projection.account = Object.fromEntries(
      Object.entries(metadata).filter(([key]) =>
        [
          "accountUuid",
          "organizationUuid",
          "organizationType",
          "billingType",
          "emailAddress",
        ].includes(key),
      ),
    );
  }
  return projection;
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
      const execution =
        source.projection === "native-global"
          ? nativeGlobalProjection(value, source.projectionRoots)
          : executionProjection(value);
      projected = execution;
      if (
        source.nativeReadOnly &&
        (nonempty(value.additionalDirectories) ||
          (value.permissions !== undefined &&
            nonempty(object(value.permissions).additionalDirectories)))
      )
        throw new RuntimeError("POLICY_UNCONFIRMED");
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
          source.nativeReadOnly &&
          Object.entries(raw).some(
            ([key, entry]) =>
              entry &&
              (/^(?:DYLD_|LD_PRELOAD$|NODE_OPTIONS$|BUN_OPTIONS$|BUN_INSPECT$)/.test(key) ||
                /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_OAUTH_TOKEN)$/.test(
                  key,
                ) ||
                /^(?:CLAUDE_CODE_USE_|CLAUDE_CODE_SETTINGS_|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_)/.test(
                  key,
                )),
          )
        )
          throw new RuntimeError("POLICY_UNCONFIRMED");
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
  const before = lstatSync(path);
  const identity = fileIdentity(before);
  if (
    !before.isFile() ||
    before.uid !== process.getuid?.() ||
    (before.mode & 0o022) !== 0 ||
    before.size <= 0 ||
    before.size > 256 * 1024 * 1024
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  if (prior?.identity === identity) return prior;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const hash = createHash("sha256");
  try {
    if (fileIdentity(fstatSync(fd)) !== identity) throw new RuntimeError("SNAPSHOT_CHANGED");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (!count) break;
      offset += count;
      if (offset > before.size) throw new RuntimeError("SNAPSHOT_CHANGED");
      hash.update(buffer.subarray(0, count));
    }
    if (
      offset !== before.size ||
      fileIdentity(fstatSync(fd)) !== identity ||
      fileIdentity(lstatSync(path)) !== identity
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
  } finally {
    closeSync(fd);
  }
  return {
    path,
    kind: "binary",
    identity,
    hash: hash.digest("hex"),
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
