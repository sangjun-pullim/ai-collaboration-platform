import { access, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, join, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ConnectionError, isBranch, validateBody, type WorkspaceMetadata, type AgentMetadata } from "./contracts.ts";
const execute = promisify(execFile);
export async function canonicalRoot(input: string) {
  let root: string;
  try { root = await realpath(resolve(input)); const info = await lstat(root); if (!info.isDirectory()) throw new Error(); await access(root, constants.R_OK | constants.X_OK); } catch { throw new ConnectionError("INVALID_BODY"); }
  let home: string;
  try { home = await realpath(homedir()); } catch { throw new ConnectionError("FORBIDDEN"); }
  const protectedRoots = [join(home,".codex"),join(home,".claude"),join(home,".agents"),join(home,".ssh"),join(home,".aws"),join(home,".config"),join(home,"Library"),"/etc","/private/etc","/System","/Library","/usr","/bin","/sbin","/dev","/proc","/Applications"];
  // Protect existing canonical targets too, including settings symlinked outside home.
  for (const protectedRoot of [...protectedRoots]) {
    try { protectedRoots.push(await realpath(protectedRoot)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw new ConnectionError("FORBIDDEN");
    }
  }
  const contains = (parent: string, child: string) => { const rel = relative(parent,child); return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
  // Broad ancestors are rejected as well as any protected subtree.
  if (root === parse(root).root || ["/var","/private/var","/private/var/folders","/private/tmp","/tmp","/Users","/Volumes"].includes(root) || contains(root,home) || protectedRoots.some(p => contains(p,root) || contains(root,p))) throw new ConnectionError("FORBIDDEN");
  return root;
}
export async function gitMetadata(root: string) {
  const env = { PATH: process.env.PATH, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" };
  const fixed = ["-c","core.fsmonitor=false","-c","core.hooksPath=/dev/null","-c","core.attributesFile=/dev/null","-c","safe.directory=", "-C",root];
  let commit = "unknown"; let branch = "unknown";
  try { const out = (await execute("/usr/bin/git",[...fixed,"rev-parse","--verify","HEAD"], { env, timeout: 2000, maxBuffer: 4096 })).stdout.trim(); if (/^[a-f0-9]{40}$/.test(out)) commit = out; } catch {}
  try { const out = (await execute("/usr/bin/git",[...fixed,"symbolic-ref","--quiet","--short","HEAD"], { env, timeout: 2000, maxBuffer: 4096 })).stdout.trim(); if (isBranch(out)) branch = out; } catch {}
  return { branch, commit, dirty: "unknown" as const };
}
export function workspaceBody(operationId: string, metadata: WorkspaceMetadata) {
  return validateBody("workspace", { operationId, repositoryAlias: metadata.repositoryAlias, branch: metadata.branch, commit: metadata.commit, dirty: metadata.dirty });
}
export function agentBody(operationId: string, workspaceId: string, metadata: AgentMetadata) {
  return validateBody("agent", { operationId, workspaceId, sessionAlias: metadata.sessionAlias, runtime: metadata.runtime });
}
