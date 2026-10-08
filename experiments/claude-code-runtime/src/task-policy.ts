import { constants, closeSync, fstatSync, lstatSync, openSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ProbeError, digest, readBounded, sameFile, syncDirectory } from "./owned-probe-store.js";
import { renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";

export const NATIVE_VERSION = "2.1.287";
export const OWNED_SERVER = "owned_probe";
export const TOOL_NAMES = ["read_selected_file", "ask_peer"] as const;
export const NATIVE_TOOL_NAMES = TOOL_NAMES.map((name) => `mcp__${OWNED_SERVER}__${name}`);
export interface Source { path: string; kind: "user" | "project" | "local" | "managed" | "instruction" }

/** This seam is constructor-only. A CLI user cannot supply policy evidence. */
export interface NativeEvidence {
  version: typeof NATIVE_VERSION;
  provenance: "SYNTHETIC_FIXTURE";
  startup: "TASK_OVERLAY_BEFORE_EXECUTION";
  execution: "TASK_OVERLAY_PINS_RUNTIME_RELOAD";
  instructions: "PRESERVED";
  callback: "NATIVE_ASSISTANT_TOOL_USE";
  managed: "NO_CONFLICT" | "CONFLICT";
  initialUserMessage: "ABSENT" | "PRESENT";
  inheritedHooks: "DISABLED" | "UNCONFIRMED";
}
export interface PolicyOptions { sources: Source[]; knownPlugins: string[]; evidence?: NativeEvidence }

const RESERVED = new Set([
  "DATABASE_URL", "DIRECT_URL", "DB_PASSWORD", "JWT_SECRET", "GOTRUE_JWT_SECRET", "PGRST_JWT_SECRET",
  "SERVER_SECRET", "LOCAL_AUTH_TOKEN", "SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY",
  "SUPABASE_JWT_SECRET", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "APP_ORIGIN",
]);
export function providerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith("LOCAL_ACCESS_") && !key.startsWith("AI_COLLAB_") && !RESERVED.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

function sourceFingerprint(source: Source): string {
  if (!isAbsolute(source.path) || realpathSync(dirname(source.path)) !== dirname(source.path)) {
    throw new ProbeError("STARTUP_EXECUTION_UNCONFIRMED");
  }
  let before: Stats;
  try { before = lstatSync(source.path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const parent = lstatSync(dirname(source.path));
      return digest(JSON.stringify({ path: source.path, missing: true, dev: parent.dev, ino: parent.ino, mode: parent.mode }));
    }
    throw new ProbeError("STARTUP_EXECUTION_UNCONFIRMED");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) {
    throw new ProbeError("STARTUP_EXECUTION_UNCONFIRMED");
  }
  const fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!sameFile(before, fstatSync(fd))) throw new ProbeError("POLICY_DRIFT");
    const bytes = readBounded(fd, 1024 * 1024);
    if (!sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(source.path))) throw new ProbeError("POLICY_DRIFT");
    return digest(JSON.stringify({ path: source.path, kind: source.kind, dev: before.dev, ino: before.ino,
      mode: before.mode, size: before.size, mtime: before.mtimeMs, ctime: before.ctimeMs, hash: digest(bytes) }));
  } finally { closeSync(fd); }
}

export class TaskPolicy {
  #fingerprint: string | undefined;
  #closed = false;
  constructor(private readonly options: PolicyOptions = { sources: [], knownPlugins: [] }) {}

  admit(): void {
    const e = this.options.evidence;
    // No reviewed native execution-period precedence proof currently exists in this experiment.
    // Only isolated constructor-injected synthetic evidence can pass this guard.
    if (!e || e.provenance !== "SYNTHETIC_FIXTURE" || e.version !== NATIVE_VERSION ||
        e.startup !== "TASK_OVERLAY_BEFORE_EXECUTION" || e.execution !== "TASK_OVERLAY_PINS_RUNTIME_RELOAD" ||
        e.instructions !== "PRESERVED" || e.callback !== "NATIVE_ASSISTANT_TOOL_USE") {
      throw new ProbeError("EXECUTION_PRECEDENCE_UNCONFIRMED");
    }
    if (e.managed !== "NO_CONFLICT" || e.initialUserMessage !== "ABSENT" || e.inheritedHooks !== "DISABLED" ||
        this.options.sources.length > 64 || new Set(this.options.sources.map((s) => s.path)).size !== this.options.sources.length ||
        this.options.knownPlugins.length > 64 || this.options.knownPlugins.some((p) => !/^[\w@./-]{1,200}$/.test(p))) {
      throw new ProbeError("STARTUP_EXECUTION_UNCONFIRMED");
    }
    this.#fingerprint = this.fingerprint();
    this.assertLive();
  }

  fingerprint(): string { return digest(JSON.stringify(this.options.sources.map(sourceFingerprint))); }

  assertLive(): void {
    if (this.#closed || !this.#fingerprint) throw new ProbeError("RUNTIME_CLOSED");
    try {
      if (this.fingerprint() !== this.#fingerprint) throw new ProbeError("POLICY_DRIFT");
    } catch { this.#closed = true; throw new ProbeError("POLICY_DRIFT"); }
  }

  close(): void { this.#closed = true; }
  get callbackProven(): boolean { return this.options.evidence?.callback === "NATIVE_ASSISTANT_TOOL_USE"; }

  overlay(): Record<string, unknown> {
    this.assertLive();
    return { disableAllHooks: true, enabledPlugins: Object.fromEntries([...this.options.knownPlugins, "cc-plugin-agents-md@builtin", "cc-plugin-telemetry@builtin"].map((p) => [p, false])) };
  }

  arguments(sessionId: string, resume: boolean): string[] {
    this.assertLive();
    return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
      resume ? "--resume" : "--session-id", sessionId,
      "--setting-sources", "user,project,local", "--settings", JSON.stringify(this.overlay()),
      "--tools", "", "--allowedTools", NATIVE_TOOL_NAMES.join(","), "--permission-mode", "dontAsk",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} })];
    // SDK-hosted MCP is registered over initialize, not falsely declared as a local native server.
  }
}

export interface FileSnapshot {
  path: string; dev: number; ino: number; size: number; hash: string;
}
const MAX_FILE = 65536;

/** All file access is confined to explicitly selected files in a fresh synthetic root. */
export class SelectedFiles {
  readonly #root: string;
  readonly #identity: Stats;
  readonly #snapshots = new Map<string, FileSnapshot>();
  constructor(root: string, paths: string[]) {
    this.#root = realpathSync(root);
    this.#identity = lstatSync(root);
    if (root !== this.#root || !this.#identity.isDirectory() || (this.#identity.mode & 0o777) !== 0o700 ||
        this.#identity.uid !== process.getuid?.() || paths.length === 0 || paths.length > 32 || new Set(paths).size !== paths.length) {
      throw new ProbeError("FILE_REJECTED");
    }
    let total = 0;
    for (const path of paths) {
      const current = this.open(path);
      total += current.snapshot.size;
      this.#snapshots.set(path, current.snapshot);
    }
    if (total > 512 * 1024) throw new ProbeError("FILE_REJECTED");
  }

  snapshots(): FileSnapshot[] { return structuredClone([...this.#snapshots.values()]); }
  assertUnchanged(): void { for (const path of this.#snapshots.keys()) this.read(path, () => {}); }

  read(path: string, check: () => void): string {
    check();
    const expected = this.#snapshots.get(path);
    if (!expected) throw new ProbeError("FILE_REJECTED");
    const current = this.open(path);
    if (JSON.stringify(current.snapshot) !== JSON.stringify(expected)) throw new ProbeError("FILE_REJECTED");
    check();
    return current.text;
  }

  private open(path: string): { snapshot: FileSnapshot; text: string } {
    let fd: number | undefined;
    try {
      if (!path || path.includes("\\") || path.includes(":") || path.includes("\0") || isAbsolute(path) ||
          path.split("/").some((p) => !p || p === "." || p === "..") ||
          /(^|\/)(\.env(?:\..*)?|credentials?|secrets?|auth(?:\.json)?|id_rsa|id_ed25519)$/i.test(path)) {
        throw new ProbeError("FILE_REJECTED");
      }
      const root = lstatSync(this.#root);
      if (root.dev !== this.#identity.dev || root.ino !== this.#identity.ino || realpathSync(this.#root) !== this.#root) {
        throw new ProbeError("FILE_REJECTED");
      }
      const target = join(this.#root, path);
      const scope = relative(this.#root, realpathSync(target));
      if (scope !== path || scope.startsWith(`..${sep}`)) throw new ProbeError("FILE_REJECTED");
      // Every component must remain a real directory rather than a symlink alias.
      let parent = dirname(target);
      while (parent !== this.#root) {
        if (lstatSync(parent).isSymbolicLink() || realpathSync(parent) !== parent) throw new ProbeError("FILE_REJECTED");
        parent = dirname(parent);
      }
      const before = lstatSync(target);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE ||
          before.uid !== process.getuid?.() || ![0o600, 0o644].includes(before.mode & 0o777)) throw new ProbeError("FILE_REJECTED");
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!sameFile(before, fstatSync(fd))) throw new ProbeError("FILE_REJECTED");
      const bytes = readBounded(fd, MAX_FILE);
      if (bytes.length > MAX_FILE || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(target))) {
        throw new ProbeError("FILE_REJECTED");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ||
          /-----BEGIN .*PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/i.test(text)) {
        throw new ProbeError("FILE_REJECTED");
      }
      return { snapshot: { path, dev: before.dev, ino: before.ino, size: bytes.length, hash: digest(bytes) }, text };
    } catch { throw new ProbeError("FILE_REJECTED"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  replaceOwnedFixture(path: string, content: string, reaped: boolean, active: boolean, check: () => void): FileSnapshot[] {
    if (!reaped || active || !this.#snapshots.has(path) || path.includes("/")) throw new ProbeError("FILE_REJECTED");
    if (Buffer.byteLength(content) > MAX_FILE || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) ||
        /-----BEGIN .*PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/i.test(content)) {
      throw new ProbeError("FILE_REJECTED");
    }
    this.read(path, check);
    const temporary = join(this.#root, `.fixture-${randomUUID()}`);
    let renamed = false;
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
      this.read(path, check);
      check();
      renameSync(temporary, join(this.#root, path));
      renamed = true;
      syncDirectory(this.#root);
      const updated = this.open(path).snapshot;
      this.#snapshots.set(path, updated);
      return this.snapshots();
    } finally { closeSync(fd); if (!renamed) unlinkSync(temporary); }
  }
}
