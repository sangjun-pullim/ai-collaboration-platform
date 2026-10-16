import { createHash } from "node:crypto";
import {
  constants,
  createWriteStream,
  lstatSync,
  mkdirSync,
  realpathSync,
  openSync,
} from "node:fs";
import { chmod, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RuntimeError } from "../runtime-contracts.ts";
import {
  canonicalAncestors,
  fileIdentity,
  snapshotBinary,
  type SourceSnapshot,
} from "./configuration.ts";

/** Internal download descriptor. Admission supplies the fixed release below, never user input. */
export type NativeRuntimeRelease = Readonly<{
  version: string;
  platform: string;
  bytes: number;
  sha256: string;
}>;
export function reviewedNativeRelease(): NativeRuntimeRelease {
  const platform = `darwin-${process.arch}`;
  const releases: Record<string, { bytes: number; sha256: string }> = {
    "darwin-arm64": {
      bytes: 236330608,
      sha256: "4e21122a227857da1178aca3299700c1fd7f2b77c93f12e73c2c76db796a105e",
    },
    "darwin-x64": {
      bytes: 244819072,
      sha256: "267af22d4eb187b8d65d1592e6fabf57b1df6c254913d5a6c5d8b956a02cd002",
    },
  };
  if (process.platform !== "darwin" || !releases[platform])
    throw new NativeCacheError("CACHE_INTEGRITY");
  return Object.freeze({ version: "2.1.293", platform, ...releases[platform] });
}
export class NativeCacheError extends RuntimeError {
  constructor(readonly stage: "DOWNLOAD" | "CACHE_INTEGRITY") {
    super("POLICY_UNCONFIRMED");
  }
}
const rejected = () => new NativeCacheError("CACHE_INTEGRITY");
function exists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw rejected();
  }
}
function directory(path: string) {
  canonicalAncestors(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw rejected();
  return `${stat.dev}:${stat.ino}`;
}
function cacheParent(home: string, release: NativeRuntimeRelease, create: boolean) {
  if (!/^2\.1\.\d+$/.test(release.version) || !/^darwin-(arm64|x64)$/.test(release.platform))
    throw rejected();
  directory(home);
  let path = home;
  for (const part of [
    "Library",
    "Application Support",
    "ai-collab",
    "runtimes",
    "claude",
    release.version,
  ]) {
    path = join(path, part);
    if (create && !exists(path)) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    directory(path);
  }
  return path;
}
export function inspectCachedNativeRuntime(
  home: string,
  release: NativeRuntimeRelease,
  prior?: SourceSnapshot,
) {
  const parent = cacheParent(home, release, false);
  const folder = join(parent, release.platform);
  directory(folder);
  const path = join(folder, "claude");
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    realpathSync(path) !== path ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0 ||
    stat.size !== release.bytes
  )
    throw rejected();
  const binary = snapshotBinary(path, prior);
  if (binary.hash !== release.sha256) throw rejected();
  return { path, binary };
}

async function download(path: string, release: NativeRuntimeRelease, check: () => void) {
  const abort = new AbortController();
  let failure: unknown;
  let lastRead = Date.now();
  const started = lastRead;
  const timer = setInterval(() => {
    try {
      check();
      if (Date.now() - started >= 120_000 || Date.now() - lastRead >= 15_000)
        throw new NativeCacheError("DOWNLOAD");
    } catch (error) {
      failure = error;
      abort.abort();
    }
  }, 250);
  let response: Response | undefined;
  try {
    check();
    response = await fetch(
      `https://downloads.claude.ai/claude-code-releases/${release.version}/${release.platform}/claude`,
      {
        redirect: "error",
        signal: abort.signal,
      },
    );
    const length = response.headers.get("content-length");
    if (
      response.status !== 200 ||
      !response.body ||
      response.redirected ||
      (length !== null && length !== String(release.bytes))
    )
      throw new NativeCacheError("DOWNLOAD");
    let received = 0;
    const hash = createHash("sha256");
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          check();
          lastRead = Date.now();
          received += chunk.length;
          if (received > release.bytes) throw rejected();
          hash.update(chunk);
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      bounded,
      createWriteStream(path, {
        fd: openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
        autoClose: true,
      }),
      { signal: abort.signal },
    );
    check();
    if (received !== release.bytes || hash.digest("hex") !== release.sha256) throw rejected();
  } catch (error) {
    if (failure) throw failure;
    if (error instanceof RuntimeError) throw error;
    throw new NativeCacheError("DOWNLOAD");
  } finally {
    clearInterval(timer);
    abort.abort();
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

/** Publish a verified directory; a competing completed directory is never overwritten. */
export async function ensureNativeRuntime(
  home: string,
  release: NativeRuntimeRelease,
  check: () => void,
  verifyPublisher: (path: string) => Promise<void>,
): Promise<string> {
  check();
  const parent = cacheParent(home, release, true);
  const identity = directory(parent);
  const target = join(parent, release.platform);
  if (exists(target)) return inspectCachedNativeRuntime(home, release).path;
  const candidate = await mkdtemp(join(parent, ".preparing-"));
  try {
    await chmod(candidate, 0o700);
    const path = join(candidate, "claude");
    await download(path, release, check);
    await chmod(path, 0o700);
    const before = fileIdentity(lstatSync(path));
    await verifyPublisher(path);
    check();
    if (directory(parent) !== identity || fileIdentity(lstatSync(path)) !== before)
      throw rejected();
    // Recheck a winner immediately before publish, including invalid/empty existing directories.
    if (exists(target)) return inspectCachedNativeRuntime(home, release).path;
    try {
      await rename(candidate, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
    check();
    return inspectCachedNativeRuntime(home, release).path;
  } finally {
    // Only the unique directory created by this attempt is eligible for cleanup.
    if (directory(parent) === identity) await rm(candidate, { recursive: true, force: true });
  }
}
