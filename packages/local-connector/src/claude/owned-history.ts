import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isId } from "../contracts.ts";
import { RuntimeError } from "../runtime-contracts.ts";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RuntimeError("UNKNOWN");
  return value as Record<string, unknown>;
}

export interface OwnedHistory {
  materialized: boolean;
  sessionId: string;
  root: string;
  records: Record<string, unknown>[];
  format?: "claude-jsonl-v1";
}

function secureHistory(stat: Stats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o077) === 0 &&
    stat.size <= 16 * 1024 * 1024
  );
}
async function canonicalParent(path: string, check: () => void): Promise<boolean> {
  let parent = dirname(path);
  try {
    if ((await realpath(parent)) !== parent) throw new RuntimeError("UNSAFE_STORAGE");
    check();
    return true;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new RuntimeError("UNSAFE_STORAGE");
  }
  // A missing native directory is expected before the first input. A dangling link is not.
  for (;;) {
    check();
    try {
      const stat = await lstat(parent);
      check();
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(parent)) !== parent)
        throw new RuntimeError("UNSAFE_STORAGE");
      check();
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new RuntimeError("UNSAFE_STORAGE");
      const next = dirname(parent);
      if (next === parent) throw new RuntimeError("UNSAFE_STORAGE");
      parent = next;
    }
  }
}

/** Read one reserved native transcript in full. Never search or edit personal histories. */
export async function readOwnedHistory(
  path: string,
  sessionId: string,
  root: string,
  check: () => void,
): Promise<OwnedHistory> {
  if (!isId(sessionId) || path !== resolve(path) || basename(path) !== `${sessionId}.jsonl`)
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  check();
  if (!(await canonicalParent(path, check)))
    return { materialized: false, sessionId, root, records: [] };
  check();
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { materialized: false, sessionId, root, records: [] };
    throw new RuntimeError("UNSAFE_STORAGE");
  }
  check();
  if (!secureHistory(before)) throw new RuntimeError("UNSAFE_STORAGE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check();
    const opened = await handle.stat();
    if (!secureHistory(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      throw new RuntimeError("UNSAFE_STORAGE");
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      check();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    check();
    if (
      offset !== before.size ||
      [after, current].some(
        (stat) =>
          !secureHistory(stat) ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs ||
          stat.nlink !== 1 ||
          (stat.mode & 0o077) !== 0,
      )
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    let records: Record<string, unknown>[];
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
      if (text && !text.endsWith("\n")) throw new RuntimeError("UNKNOWN");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length > 4096 || lines.some((line) => Buffer.byteLength(line) > 1024 * 1024))
        throw new RuntimeError("RUNTIME_CAPACITY");
      records = lines.map((line) => object(JSON.parse(line)));
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("UNKNOWN");
    }
    return { materialized: true, sessionId, root, records };
  } finally {
    await handle.close();
  }
}
