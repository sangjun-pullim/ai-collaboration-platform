import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { canonicalRoot } from "../workspace-registration.ts";
import { digest, RuntimeError, type RootIdentity } from "../runtime-contracts.ts";
import { automaticSecretMaterial } from "./automatic-content-policy.ts";

export const secretPattern =
  /-----BEGIN (?:[A-Z ]*PRIVATE KEY|OPENSSH)|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret|authorization|credential)\s*[=:]\s*["']?[^\s"']{8,}/i;
export const selectedFileLimit = 65536;
export const repositoryFileLimit = 2 * 1024 * 1024;
export type Check = () => void;

async function checked<T>(check: Check, action: () => Promise<T>): Promise<T> {
  check();
  const result = await action();
  check();
  return result;
}
async function ancestors(path: string, check: Check) {
  const paths: string[] = [];
  let current = resolve(path);
  while (current !== parse(current).root) {
    paths.unshift(current);
    current = dirname(current);
  }
  for (const part of paths) {
    const info = await checked(check, () => lstat(part));
    if (info.isSymbolicLink() || !info.isDirectory()) throw new RuntimeError("SNAPSHOT_CHANGED");
  }
}
export async function resolveSafeRoot(input: string, check: Check) {
  await ancestors(resolve(input), check);
  const path = await checked(check, () => canonicalRoot(input));
  const info = await checked(check, () => lstat(path));
  if (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new RuntimeError("SNAPSHOT_CHANGED");
  return { path, dev: info.dev, ino: info.ino, uid: info.uid };
}
export async function assertSafeRoot(root: RootIdentity, check: Check) {
  await ancestors(root.path, check);
  const info = await checked(check, () => lstat(root.path));
  const path = await checked(check, () => realpath(root.path));
  if (
    info.dev !== root.dev ||
    info.ino !== root.ino ||
    info.uid !== root.uid ||
    !info.isDirectory() ||
    (info.mode & 0o022) !== 0 ||
    path !== root.path
  )
    throw new RuntimeError("SNAPSHOT_CHANGED");
}
function sameIdentity(info: Stats, expected: Stats) {
  return (
    info.dev === expected.dev &&
    info.ino === expected.ino &&
    info.uid === expected.uid &&
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (info.mode & 0o022) === 0
  );
}
function structuralPath(path: string) {
  return (
    path.length > 0 &&
    path.length <= 512 &&
    !isAbsolute(path) &&
    !/[\\\0\r\n]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function containedDirectory(root: RootIdentity, path: string) {
  const rel = relative(root.path, path);
  return (
    isAbsolute(root.path) &&
    resolve(root.path) === root.path &&
    isAbsolute(path) &&
    resolve(path) === path &&
    (rel === "" ||
      (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && structuralPath(rel)))
  );
}
// Retain the identities below the approved root, rather than merely checking names twice.
export async function captureDirectory(root: RootIdentity, path: string, check: Check) {
  if (root.uid !== process.getuid?.()) throw new RuntimeError("SNAPSHOT_CHANGED");
  if (!containedDirectory(root, path)) throw new RuntimeError("TOOL_REJECTED");
  await assertSafeRoot(root, check);
  const captured: { path: string; info: Stats }[] = [];
  let current = root.path;
  const suffix = path.slice(root.path.length).split("/").filter(Boolean);
  for (const part of suffix) {
    current = join(current, part);
    const info = await checked(check, () => lstat(current));
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== root.uid ||
      (info.mode & 0o022) !== 0
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    captured.push({ path: current, info });
  }
  return async () => {
    await assertSafeRoot(root, check);
    for (const entry of captured) {
      const currentInfo = await checked(check, () => lstat(entry.path));
      if (!sameIdentity(currentInfo, entry.info)) throw new RuntimeError("SNAPSHOT_CHANGED");
    }
    check();
  };
}
export async function readSafeFile(
  root: RootIdentity,
  path: string,
  check: Check,
  mode: "selected" | "repository",
  reserveBytes: (bytes: number) => void = () => {},
) {
  if (!structuralPath(path) || !containedDirectory(root, root.path))
    throw new RuntimeError("TOOL_REJECTED");
  const maximum = mode === "selected" ? selectedFileLimit : repositoryFileLimit;
  const absolute = join(root.path, path);
  const verify =
    mode === "repository"
      ? await captureDirectory(root, dirname(absolute), check)
      : async () => {
          await assertSafeRoot(root, check);
          await ancestors(dirname(absolute), check);
        };
  async function io<T>(action: () => Promise<T>) {
    await verify();
    const result = await checked(check, action);
    await verify();
    return result;
  }
  const info = await io(() => lstat(absolute));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    info.uid !== root.uid ||
    (info.mode & 0o022) !== 0 ||
    info.size > maximum
  )
    throw new RuntimeError("TOOL_REJECTED");
  // Reserve the bounded read before opening. Reservations are never refunded after failure.
  reserveBytes(info.size + 1);
  await verify();
  check();
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let result;
  try {
    check();
    await verify();
    const before = await io(() => handle.stat());
    if (
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.uid !== root.uid ||
      (before.mode & 0o022) !== 0 ||
      before.size !== info.size ||
      before.size > maximum
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    const data = Buffer.alloc(info.size + 1);
    const { bytesRead } = await io(() => handle.read(data, 0, data.length, 0));
    if (bytesRead > maximum || bytesRead !== before.size) throw new RuntimeError("TOOL_REJECTED");
    const after = await io(() => handle.stat());
    const current = await io(() => lstat(absolute));
    if (
      [after, current].some(
        (s) =>
          !s.isFile() ||
          s.isSymbolicLink() ||
          s.ino !== before.ino ||
          s.dev !== before.dev ||
          s.size !== before.size ||
          s.mtimeMs !== before.mtimeMs ||
          s.ctimeMs !== before.ctimeMs ||
          s.nlink !== 1 ||
          s.uid !== root.uid ||
          (s.mode & 0o022) !== 0,
      )
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    const bytes = data.subarray(0, bytesRead);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: mode === "repository" }).decode(
        bytes,
      );
    } catch {
      throw new RuntimeError("TOOL_REJECTED");
    }
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
      (mode === "selected" && secretPattern.test(text))
    )
      throw new RuntimeError("TOOL_REJECTED");
    if (mode === "repository" && automaticSecretMaterial(text, path))
      throw new RuntimeError("TOOL_REJECTED");
    result = {
      text,
      bytes,
      snapshot: {
        path,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
        hash: digest(bytes),
      },
    };
  } finally {
    await handle.close();
  }
  await verify();
  check();
  return result;
}
