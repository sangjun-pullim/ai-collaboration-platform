import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
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
import { assertNoManagedSources } from "./native-sources.ts";

const admitted = new WeakSet<object>();
const supportedVersions = ["2.1.288", "2.1.293"] as const;
const publisher =
  'anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"';
export interface NativeClaudeInstallation {
  readonly kind: "NATIVE";
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
  "INSTALLATION" | "PUBLISHER" | "VERSION" | "MANAGED_POLICY" | "LOGIN";
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

function installationEntry(home: string) {
  const entry = join(home, ".local", "bin", "claude");
  installationAncestors(entry, home);
  const link = lstatSync(entry);
  if (!link.isSymbolicLink() || link.uid !== process.getuid?.() || link.nlink !== 1)
    throw unavailable();
  const executable = realpathSync(entry);
  const version = supportedVersions.find(
    (value) => executable === join(home, ".local", "share", "claude", "versions", value),
  );
  if (!version) throw unavailable("VERSION");
  installationAncestors(executable, home);
  const stat = lstatSync(executable);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o111) === 0 ||
    (stat.mode & 0o022) !== 0
  )
    throw unavailable();
  return { entry, executable, entryIdentity: fileIdentity(link), version };
}

/** Parent-owned provenance only. JSON objects and environment flags cannot authorize a binary. */
export function assertNativeInstallation(
  installation: NativeClaudeInstallation,
  check: () => void,
) {
  if (!admitted.has(installation)) throw unavailable();
  check();
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
  const current = installationEntry(home);
  const binary = snapshotBinary(current.executable, prior?.binary);
  if (prior) assertNativeInstallation(prior, check);
  const env = { ...providerEnvironment(environment), LC_ALL: "C", DISABLE_AUTOUPDATER: "1" };
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
