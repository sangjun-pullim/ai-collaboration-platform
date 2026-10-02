import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync,
  realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { ExperimentPolicyError } from "./experiment-policy.js";

export const WORKSPACE_FILES = ["public-context.txt", "tool-proof.txt"] as const;
export const MAX_FILE_BYTES = 64 * 1024;

export function isWorkspacePath(value: unknown): value is typeof WORKSPACE_FILES[number] {
  return typeof value === "string" && !value.includes("\0") && !value.includes("\\") &&
    !value.includes(":") && !value.startsWith("/") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    (WORKSPACE_FILES as readonly string[]).includes(value);
}

/** Only the canonical, privately owned synthetic root supplied by the locked store is supported. */
export class WorkspaceFilePolicy {
  readonly #rootStat: Stats;
  public constructor(private readonly root: string) {
    try {
      this.#rootStat = this.#checkRoot();
    } catch { throw rejected(); }
  }

  public read(path: unknown, beforeReturn?: () => void): string {
    if (!isWorkspacePath(path)) throw rejected();
    let fd: number | undefined;
    try {
      this.#assertRoot();
      const target = join(this.root, path);
      const before = this.#file(target);
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      assertSame(before, opened);
      assertFile(opened);
      const bytes = Buffer.alloc(MAX_FILE_BYTES);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_FILE_BYTES || bytes.subarray(0, length).includes(0)) throw rejected();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw rejected();
      beforeReturn?.();
      assertSame(opened, fstatSync(fd));
      assertSame(before, this.#file(target));
      this.#assertRoot();
      return text;
    } catch { throw rejected(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  /** Bounded synchronous I/O keeps preparation and cleanup inside the repository lock. */
  public replaceProof(content: string, assertAdmission: () => void): void {
    let fd: number | undefined;
    let temporary: string | undefined;
    try {
      assertAdmission();
      if (!/^[a-f0-9]{48}$/.test(content)) throw rejected();
      this.#assertRoot();
      const target = join(this.root, "tool-proof.txt");
      const before = this.#optionalFile(target);
      assertAdmission();
      temporary = join(this.root, `.tool-proof-${randomUUID()}.tmp`);
      fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
      const created = fstatSync(fd);
      assertFile(created);
      assertAdmission();
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
      assertSameIdentity(created, fstatSync(fd));
      assertSameIdentity(created, this.#file(temporary));
      this.#assertRoot();
      const current = this.#optionalFile(target);
      if (before === undefined ? current !== undefined : current === undefined) throw rejected();
      if (before !== undefined && current !== undefined) assertSame(before, current);
      assertAdmission();
      renameSync(temporary, target);
      temporary = undefined;
      const directoryFd = openSync(this.root, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } catch (error) {
      if (error instanceof ExperimentPolicyError && error.code === "RUNTIME_SHUTDOWN") throw error;
      throw rejected();
    } finally {
      try { if (fd !== undefined) closeSync(fd); }
      finally { if (temporary !== undefined) unlinkSync(temporary); }
    }
  }

  #checkRoot(): Stats {
    if (realpathSync(this.root) !== this.root) throw rejected();
    // Check each canonical component; no user-supplied subdirectories are accepted.
    let component = this.root;
    while (true) {
      const stat = lstatSync(component);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw rejected();
      const parent = dirname(component);
      if (parent === component) break;
      component = parent;
    }
    const stat = lstatSync(this.root);
    assertPrivate(stat);
    return stat;
  }

  #assertRoot(): void {
    const current = this.#checkRoot();
    // Directory link counts can change when children are created on APFS.
    if (current.dev !== this.#rootStat.dev || current.ino !== this.#rootStat.ino) throw rejected();
  }

  #file(path: string): Stats {
    const scope = relative(this.root, realpathSync(path));
    if (scope.startsWith(`..${sep}`) || scope === ".." || scope.startsWith(sep) || dirname(path) !== this.root) throw rejected();
    const stat = lstatSync(path);
    assertFile(stat);
    return stat;
  }

  #optionalFile(path: string): Stats | undefined {
    // lstat detects a dangling link rather than treating it as a missing target.
    try { lstatSync(path); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    return this.#file(path);
  }
}

function assertPrivate(stat: Stats): void {
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw rejected();
}
function assertFile(stat: Stats): void {
  assertPrivate(stat);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw rejected();
}
function assertSameIdentity(a: Stats, b: Stats): void {
  if (a.dev !== b.dev || a.ino !== b.ino || a.nlink !== b.nlink) throw rejected();
}
function assertSame(a: Stats, b: Stats): void {
  assertSameIdentity(a, b);
  if (a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs || a.mode !== b.mode || a.uid !== b.uid) throw rejected();
}
function rejected(): ExperimentPolicyError { return new ExperimentPolicyError("WORKSPACE_FILE_REJECTED"); }
