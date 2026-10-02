import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { canonicalRoot } from "./workspace-registration.ts";
import { digest, RuntimeError, type FileSnapshot, type RootIdentity } from "./runtime-contracts.ts";

const secretPattern = /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH)|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|authorization|credential)\s*[=:]\s*["']?[^\s"']{8,}/i;
export function isSelectedPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !isAbsolute(value) && !/[\\\0\r\n]/.test(value) &&
    value.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/^(?:\.git|\.codex|\.claude|\.agents|\.ssh|\.aws|\.config|node_modules|\.next|\.cache|cache|credentials?|auth(?:\.json)?|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i.test(part));
}
export function publicText(value: string, denied: readonly string[] = [], allowEmpty = false): string {
  const text = value.trim();
  if ((!text && !allowEmpty) || Buffer.byteLength(text) > 8192 || Array.from(text).length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || secretPattern.test(text) || denied.some(v => v.length > 0 && text.includes(v)) || /(?:PROVIDER_RAW_ERROR|Traceback \(most recent call|Error:\s|\/Users\/|\/private\/var\/|\/home\/)/.test(text)) throw new RuntimeError("PUBLIC_TEXT_REJECTED");
  return text;
}
async function ancestors(path: string, check: () => void) {
  const paths: string[] = []; let current = resolve(path);
  while (current !== parse(current).root) { paths.unshift(current); current = dirname(current); }
  for (const part of paths) { const info = await lstat(part); check(); if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimeError("SNAPSHOT_CHANGED"); }
}
export class RuntimeFilePolicy {
  constructor(readonly root: RootIdentity, readonly files: readonly FileSnapshot[]) {}
  static async root(input: string, check = () => {}) {
    await ancestors(resolve(input), check); check();
    const path = await canonicalRoot(input); check(); const info = await lstat(path); check();
    if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0) throw new RuntimeError("SNAPSHOT_CHANGED");
    return { path, dev: info.dev, ino: info.ino, uid: info.uid };
  }
  static async select(input: string, paths: string[], check = () => {}): Promise<RuntimeFilePolicy> {
    if (paths.length > 32 || new Set(paths).size !== paths.length || paths.some(p => !isSelectedPath(p))) throw new RuntimeError("TOOL_REJECTED");
    const policy = new RuntimeFilePolicy(await this.root(input, check), []); const files: FileSnapshot[] = []; let total = 0;
    for (const path of paths) { const read = await policy.readSnapshot(path, check); check(); total += read.snapshot.size; if (total > 512 * 1024) throw new RuntimeError("TOOL_REJECTED"); files.push(read.snapshot); }
    return new RuntimeFilePolicy(policy.root, files);
  }
  async assertUnchanged(check = () => {}) {
    await this.checkRoot(check);
    for (const file of this.files) { await this.read(file.path, check); check(); }
  }
  private async checkRoot(check: () => void) {
    await ancestors(this.root.path, check); const root = await lstat(this.root.path); check();
    const path = await realpath(this.root.path); check();
    if (root.dev !== this.root.dev || root.ino !== this.root.ino || root.uid !== this.root.uid || !root.isDirectory() || (root.mode & 0o022) !== 0 || path !== this.root.path) throw new RuntimeError("SNAPSHOT_CHANGED");
  }
  private async readSnapshot(path: string, check: () => void) {
    if (!isSelectedPath(path)) throw new RuntimeError("TOOL_REJECTED");
    await this.checkRoot(check); check(); const absolute = join(this.root.path, path); await ancestors(dirname(absolute), check);
    const info = await lstat(absolute); check();
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0 || info.size > 65536) throw new RuntimeError("TOOL_REJECTED");
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      check(); const before = await handle.stat(); check();
      if (before.ino !== info.ino || before.dev !== info.dev || !before.isFile() || before.nlink !== 1 || before.size > 65536) throw new RuntimeError("SNAPSHOT_CHANGED");
      const data = Buffer.alloc(65537); const { bytesRead } = await handle.read(data, 0, data.length, 0); check();
      if (bytesRead > 65536 || bytesRead !== before.size) throw new RuntimeError("TOOL_REJECTED");
      const after = await handle.stat(); check(); const current = await lstat(absolute); check(); await this.checkRoot(check);
      if ([after, current].some(s => s.ino !== before.ino || s.dev !== before.dev || s.size !== before.size || s.mtimeMs !== before.mtimeMs || s.ctimeMs !== before.ctimeMs || s.nlink !== 1 || s.uid !== this.root.uid || (s.mode & 0o022) !== 0)) throw new RuntimeError("SNAPSHOT_CHANGED");
      let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead)); } catch { throw new RuntimeError("TOOL_REJECTED"); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || secretPattern.test(text)) throw new RuntimeError("TOOL_REJECTED");
      const snapshot = { path, dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, hash: digest(data.subarray(0, bytesRead)) };
      return { text, snapshot };
    } finally { await handle.close(); }
  }
  async read(path: string, check = () => {}): Promise<string> {
    const expected = this.files.find(file => file.path === path); if (!expected) throw new RuntimeError("TOOL_REJECTED");
    const { text, snapshot } = await this.readSnapshot(path, check); check();
    if (JSON.stringify(snapshot) !== JSON.stringify(expected)) throw new RuntimeError("SNAPSHOT_CHANGED"); return text;
  }
}
