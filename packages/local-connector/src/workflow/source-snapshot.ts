import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { isBranch, isHash } from "../contracts.ts";
import { RuntimeFilePolicy, isSelectedPath } from "../runtime-file-policy.ts";
import {
  digest,
  stableJson,
  RuntimeError,
  type FileSnapshot,
  type RootIdentity,
  type SourceObservation,
} from "../runtime-contracts.ts";

const execute = promisify(execFile);
export const sourceObservationByteLimit = 128 * 1024;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
  object(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const time = (v: unknown) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const commit = (v: unknown) =>
  v === null || (typeof v === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v));

export function sourceEntries(
  files: readonly FileSnapshot[],
): SourceObservation["files"]["entries"] {
  return files
    .map(({ path, hash }) => ({ path, hash }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export function validSourceObservation(v: unknown): v is SourceObservation {
  try {
    if (
      !exact(v, ["version", "kind", "git", "files", "observationHash"]) ||
      v.version !== 1 ||
      v.kind !== "INPUT_SOURCE_OBSERVATION" ||
      !exact(v.git, ["observedAt", "commit", "ref", "dirty"]) ||
      !time(v.git.observedAt) ||
      !commit(v.git.commit) ||
      !(v.git.ref === null || isBranch(v.git.ref)) ||
      v.git.dirty !== "unknown" ||
      !exact(v.files, ["validatedAt", "pathBase", "entries", "manifestHash"]) ||
      !time(v.files.validatedAt) ||
      v.files.pathBase !== "SELECTED_ROOT" ||
      !Array.isArray(v.files.entries) ||
      v.files.entries.length > 32 ||
      !v.files.entries.every(
        (e, i, entries) =>
          exact(e, ["path", "hash"]) &&
          isSelectedPath(e.path) &&
          isHash(e.hash) &&
          (i === 0 || entries[i - 1].path < e.path),
      ) ||
      !isHash(v.files.manifestHash) ||
      v.files.manifestHash !== digest(stableJson(v.files.entries)) ||
      !isHash(v.observationHash)
    )
      return false;
    const { observationHash, ...body } = v;
    return (
      observationHash === digest(stableJson(body)) &&
      Buffer.byteLength(JSON.stringify(v)) <= sourceObservationByteLimit
    );
  } catch {
    return false;
  }
}
/** Covers the actual escaped entries plus bounded metadata and the optional journal field. */
export function sourceObservationReserveBytes(files: readonly FileSnapshot[]): number {
  return (
    Buffer.byteLength(JSON.stringify(sourceEntries(files))) +
    2048 +
    Buffer.byteLength(',"sourceObservation":')
  );
}
export interface SourceGitOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  signal: AbortSignal;
}
export type SourceGitExecutor = (
  command: string,
  args: string[],
  options: SourceGitOptions,
) => Promise<{ stdout: string }>;
/** Constructor/test seam only; no CLI or environment override. */
export async function collectSourceObservation(
  root: RootIdentity,
  files: readonly FileSnapshot[],
  check: () => void,
  signal: AbortSignal,
  run: SourceGitExecutor = (command, args, options) => execute(command, args, options),
): Promise<SourceObservation> {
  const live = () => {
    check();
    if (signal.aborted) throw new RuntimeError("AUTHORITY_LOST");
  };
  const verifyRoot = async () => {
    live();
    let current: RootIdentity;
    try {
      current = await RuntimeFilePolicy.root(root.path, live);
    } catch (error) {
      live();
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("SNAPSHOT_CHANGED");
    }
    live();
    if (stableJson(current) !== stableJson(root)) throw new RuntimeError("SNAPSHOT_CHANGED");
  };
  const deadline = performance.now() + 3000;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 3000);
  const env = {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
  const fixed = [
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "safe.directory=",
    "-c",
    "protocol.allow=never",
    "-C",
    root.path,
  ];
  const read = async (args: string[]) => {
    await verifyRoot();
    live();
    let output: string | null = null;
    const remaining = deadline - performance.now();
    if (remaining > 0 && !controller.signal.aborted) {
      try {
        const result = await run("/usr/bin/git", [...fixed, ...args], {
          cwd: root.path,
          env,
          timeout: Math.max(1, Math.min(2000, Math.floor(remaining))),
          maxBuffer: 4096,
          signal: controller.signal,
        });
        live();
        if (Buffer.byteLength(result.stdout) <= 4096) output = result.stdout.trim();
      } catch {
        live();
      }
    }
    live();
    await verifyRoot();
    live();
    return output;
  };
  let gitCommit: string | null = null,
    ref: string | null = null;
  try {
    const first = await read(["rev-parse", "--verify", "HEAD"]);
    live();
    const branch = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    live();
    const last = await read(["rev-parse", "--verify", "HEAD"]);
    live();
    if (first !== null && commit(first) && first === last) {
      gitCommit = first;
      if (branch !== null && isBranch(branch)) ref = branch;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
  live();
  const observedAt = new Date().toISOString();
  await new RuntimeFilePolicy(root, files).assertUnchanged(live);
  live();
  const entries = sourceEntries(files);
  const body = {
    version: 1 as const,
    kind: "INPUT_SOURCE_OBSERVATION" as const,
    git: { observedAt, commit: gitCommit, ref, dirty: "unknown" as const },
    files: {
      validatedAt: new Date().toISOString(),
      pathBase: "SELECTED_ROOT" as const,
      entries,
      manifestHash: digest(stableJson(entries)),
    },
  };
  const observation = { ...body, observationHash: digest(stableJson(body)) };
  if (!validSourceObservation(observation)) throw new RuntimeError("INVALID_RUNTIME");
  return observation;
}
