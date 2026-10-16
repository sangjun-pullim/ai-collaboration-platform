import { execFile } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { digest, RuntimeError, stableJson } from "../runtime-contracts.ts";
import {
  canonicalAncestors,
  fileIdentity,
  providerEnvironment,
  snapshotBinary,
  type SourceSnapshot,
} from "./configuration.ts";
import { object } from "./owned-history.ts";
import {
  ensureNativeRuntime,
  inspectCachedNativeRuntime,
  reviewedNativeRelease,
  NativeCacheError,
} from "./native-runtime-cache.ts";
import { assertNoManagedSources } from "./native-sources.ts";

const admitted = new WeakSet<object>();
const supportedVersions = ["2.1.288", "2.1.293"] as const;
const publisher =
  'anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
export interface NativeClaudeInstallation {
  readonly kind: "NATIVE";
  readonly source: "PERSONAL" | "APP_CACHE";
  readonly version: (typeof supportedVersions)[number];
  readonly home: string;
  readonly entry: string;
  readonly entryIdentity: string;
  readonly executable: string;
  readonly binary: Readonly<SourceSnapshot>;
  readonly configDirectory: string;
  readonly projectsDirectory: string;
  readonly accountHash: string;
}
type ProbeFailure = Error & { code?: unknown; stdout?: string; stderr?: string };
export type NativeAdmissionStage =
  | "INSTALLATION"
  | "PUBLISHER"
  | "VERSION"
  | "MANAGED_POLICY"
  | "LOGIN"
  | "DOWNLOAD"
  | "CACHE_INTEGRITY";
export class NativeAdmissionError extends RuntimeError {
  constructor(readonly stage: NativeAdmissionStage) {
    super("POLICY_UNCONFIRMED");
  }
}
const unavailable = (stage: NativeAdmissionStage = "INSTALLATION") =>
  new NativeAdmissionError(stage);

function probe(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        cwd,
        env,
        timeout: 5000,
        maxBuffer: 256 * 1024,
        encoding: "utf8",
        windowsHide: true,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as ProbeFailure;
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
        } else resolve(stdout);
      },
    );
  });
}

function installationAncestors(path: string, home: string) {
  canonicalAncestors(dirname(path));
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const stat = lstatSync(directory);
    const privateDirectory = directory === home || directory.startsWith(`${home}/`);
    const owner = process.getuid?.();
    const trustedOwner = stat.uid === owner || (!privateDirectory && stat.uid === 0);
    // Root-owned sticky system directories protect each user's private child directory.
    const stickySystem = !privateDirectory && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || !trustedOwner || ((stat.mode & 0o022) !== 0 && !stickySystem))
      throw unavailable();
    if (dirname(directory) === directory) return;
  }
}

function assertNativeExecutable(executable: string, home: string) {
  installationAncestors(executable, home);
  const stat = lstatSync(executable);
  if (
    realpathSync(executable) !== executable ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  )
    throw unavailable();
}

function installationEntry(home: string) {
  const entry = join(home, ".local", "bin", "claude");
  installationAncestors(entry, home);
  const link = lstatSync(entry);
  if (!link.isSymbolicLink() || link.uid !== process.getuid?.() || link.nlink !== 1)
    throw unavailable();
  const target = realpathSync(entry);
  const versionsDirectory = join(home, ".local", "share", "claude", "versions");
  let version = supportedVersions.find((value) => target === join(versionsDirectory, value));
  let executable = target;
  if (!version) {
    // A personal auto-update never authorizes execution of an unreviewed binary.
    if (
      dirname(target) !== versionsDirectory ||
      !/^\d+\.\d+\.\d+$/.test(target.slice(versionsDirectory.length + 1))
    )
      throw unavailable("VERSION");
    assertNativeExecutable(target, home);
    const fallbackVersion = supportedVersions.at(-1)!;
    const fallback = join(versionsDirectory, fallbackVersion);
    if (!existsSync(fallback)) {
      const release = reviewedNativeRelease();
      return {
        entry,
        entryIdentity: fileIdentity(link),
        source: "APP_CACHE" as const,
        executable: join(
          home,
          "Library",
          "Application Support",
          "ai-collab",
          "runtimes",
          "claude",
          release.version,
          release.platform,
          "claude",
        ),
        version: fallbackVersion,
      };
    }
    executable = fallback;
    version = fallbackVersion;
  }
  assertNativeExecutable(executable, home);
  return {
    entry,
    executable,
    entryIdentity: fileIdentity(link),
    version,
    source: "PERSONAL" as const,
  };
}

/** Parent-owned provenance only. JSON objects and environment flags cannot authorize a binary. */
export function assertNativeInstallation(
  installation: NativeClaudeInstallation,
  check: () => void,
) {
  if (!admitted.has(installation)) throw unavailable();
  check();
  if (installation.source === "APP_CACHE") {
    const cached = inspectCachedNativeRuntime(
      installation.home,
      reviewedNativeRelease(),
      installation.binary,
    );
    if (
      cached.path !== installation.executable ||
      cached.binary.identity !== installation.binary.identity ||
      cached.binary.hash !== installation.binary.hash
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    assertNoManagedSources(installation.home, installation.configDirectory);
    check();
    return;
  }
  const current = installationEntry(installation.home);
  const binary = snapshotBinary(current.executable, installation.binary);
  if (
    current.entry !== installation.entry ||
    current.version !== installation.version ||
    current.entryIdentity !== installation.entryIdentity ||
    current.executable !== installation.executable ||
    binary.identity !== installation.binary.identity ||
    binary.hash !== installation.binary.hash
  )
    throw new RuntimeError("SNAPSHOT_CHANGED");
  assertNoManagedSources(installation.home, installation.configDirectory);
  check();
}

export function assertNativeEnvironment(env: NodeJS.ProcessEnv) {
  if (
    Object.keys(env).some(
      (key) =>
        env[key] &&
        (/^(?:DYLD_|LD_PRELOAD$|NODE_OPTIONS$|BUN_OPTIONS$|BUN_INSPECT$)/.test(key) ||
          /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_OAUTH_TOKEN)$/.test(
            key,
          ) ||
          /^(?:CLAUDE_CODE_USE_|CLAUDE_CODE_SETTINGS_|CLAUDE_CODE_ADDITIONAL_DIRECTORIES_)/.test(
            key,
          )),
    )
  )
    throw unavailable();
}

/** Only signature-verified official code is invoked; probes do not submit model input. */
async function verifyInstallation(
  root: string,
  environment: NodeJS.ProcessEnv,
  check: () => void,
  prior?: NativeClaudeInstallation,
): Promise<NativeClaudeInstallation> {
  check();
  if (process.platform !== "darwin") throw unavailable();
  assertNativeEnvironment(environment);
  const home = realpathSync(homedir());
  const configDirectory = join(home, ".claude");
  // Other profiles retain their files; their global configuration location is not yet verified.
  if (
    environment.CLAUDE_CONFIG_DIR !== undefined &&
    environment.CLAUDE_CONFIG_DIR !== configDirectory
  )
    throw unavailable();
  assertNoManagedSources(home, configDirectory);
  if (prior) assertNativeInstallation(prior, check);
  const current =
    prior?.source === "APP_CACHE"
      ? {
          entry: prior.entry,
          entryIdentity: prior.entryIdentity,
          executable: prior.executable,
          version: prior.version,
          source: prior.source,
        }
      : installationEntry(home);
  const env = { ...providerEnvironment(environment), LC_ALL: "C", DISABLE_AUTOUPDATER: "1" };
  const verifyPublisher = async (path: string) => {
    try {
      await probe(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--verbose=2", `-R=${publisher}`, path],
        env,
        root,
      );
      check();
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw unavailable("PUBLISHER");
    }
  };
  if (current.source === "APP_CACHE" && !prior) {
    try {
      const path = await ensureNativeRuntime(home, reviewedNativeRelease(), check, verifyPublisher);
      if (path !== current.executable) throw unavailable("CACHE_INTEGRITY");
    } catch (error) {
      if (error instanceof NativeCacheError) throw unavailable(error.stage);
      // Preserve cancellation, publisher and snapshot errors; classify cache filesystem failures.
      if (error instanceof RuntimeError && error.code !== "UNSAFE_STORAGE") throw error;
      throw unavailable("CACHE_INTEGRITY");
    }
  }
  const binary = snapshotBinary(current.executable, prior?.binary);
  let stage: NativeAdmissionStage = "PUBLISHER";
  try {
    if (!prior) {
      await probe(
        "/usr/bin/codesign",
        ["--verify", "--strict", "--verbose=2", `-R=${publisher}`, current.executable],
        env,
        root,
      );
      check();
      stage = "VERSION";
      if (
        (await probe(current.executable, ["--version"], env, root)).trim() !==
        `${current.version} (Claude Code)`
      )
        throw unavailable(stage);
    }
    check();
    stage = "MANAGED_POLICY";
    // A preference domain may exist in memory even when no plist is visible.
    try {
      await probe("/usr/bin/defaults", ["read", "com.anthropic.claudecode"], env, root);
      throw unavailable(stage);
    } catch (error) {
      const failure = error as ProbeFailure;
      if (
        failure.code !== 1 ||
        failure.stdout?.trim() ||
        !failure.stderr ||
        !/(?:Domain com\.anthropic\.claudecode|domain\/default pair of \(com\.anthropic\.claudecode,\s*\)) does not exist/.test(
          failure.stderr,
        )
      )
        throw unavailable(stage);
    }
    check();
    stage = "LOGIN";
    const auth = object(JSON.parse(await probe(current.executable, ["auth", "status"], env, root)));
    if (
      auth.loggedIn !== true ||
      auth.authMethod !== "claude.ai" ||
      auth.apiProvider !== "firstParty" ||
      !["pro", "max"].includes(String(auth.subscriptionType).toLowerCase()) ||
      auth.configDirectory !== configDirectory ||
      auth.projectsDirectory !== join(configDirectory, "projects")
    )
      throw unavailable(stage);
    const accountHash = digest(
      stableJson({
        subscriptionType: auth.subscriptionType,
        identity: Object.fromEntries(
          Object.entries(auth).filter(([key]) =>
            ["email", "orgId", "organizationId", "accountId", "userId"].includes(key),
          ),
        ),
      }),
    );
    if (prior && accountHash !== prior.accountHash) throw new RuntimeError("SNAPSHOT_CHANGED");
    const installation: NativeClaudeInstallation = Object.freeze({
      kind: "NATIVE",
      home,
      ...current,
      binary: Object.freeze(binary),
      configDirectory,
      projectsDirectory: join(configDirectory, "projects"),
      accountHash,
    });
    admitted.add(installation);
    assertNativeInstallation(installation, check);
    return installation;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    // Neither credentials nor native stderr are exposed through product errors.
    throw unavailable(stage);
  }
}

export async function verifyNativeInstallation(
  root: string,
  environment: NodeJS.ProcessEnv,
  check: () => void,
  prior?: NativeClaudeInstallation,
): Promise<NativeClaudeInstallation> {
  try {
    return await verifyInstallation(root, environment, check, prior);
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw unavailable();
  }
}
