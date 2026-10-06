import { resolve } from "node:path";
import { isId, isHash } from "../contracts.ts";
import {
  digest,
  stableJson,
  RuntimeError,
  type RepositoryAccess,
  type RepositoryMode,
  type RuntimeSettings,
  type RootIdentity,
  type OwnedContext,
  type RepositoryToolPolicy,
} from "../runtime-contracts.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]) =>
  object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export const approvalTime = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const lowerId = (value: unknown) => isId(value) && value === value.toLowerCase();
export function rootIdentityHash(root: RootIdentity): string {
  if (
    !exact(root, ["path", "dev", "ino", "uid"]) ||
    typeof root.path !== "string" ||
    root.path !== resolve(root.path) ||
    !root.path.startsWith("/") ||
    /[\0\r\n]/.test(root.path) ||
    [root.dev, root.ino, root.uid].some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  return digest(stableJson(root));
}
export function validRepositoryAccess(value: unknown): value is RepositoryAccess {
  if (
    !exact(value, [
      "version",
      "mode",
      "generation",
      "localRootReference",
      "confirmationOperationId",
      "approvedAt",
      "rootIdentityHash",
      "sharePathHashConfirmed",
    ])
  )
    return false;
  const access = value as RepositoryAccess;
  return (
    access.version === 1 &&
    access.mode === "AUTO_CODE" &&
    lowerId(access.generation) &&
    lowerId(access.localRootReference) &&
    lowerId(access.confirmationOperationId) &&
    approvalTime(access.approvedAt) &&
    isHash(access.rootIdentityHash) &&
    access.sharePathHashConfirmed === true
  );
}
/** Only the trusted manager calls this after an explicit local confirmation. */
export function createRepositoryAccess(
  generation: string,
  root: RootIdentity,
  localRootReference: string,
  confirmationOperationId: string,
  approvedAt = new Date().toISOString(),
): RepositoryAccess {
  const access: RepositoryAccess = {
    version: 1,
    mode: "AUTO_CODE",
    generation,
    localRootReference,
    confirmationOperationId,
    approvedAt,
    rootIdentityHash: rootIdentityHash(root),
    sharePathHashConfirmed: true,
  };
  if (!validRepositoryAccess(access)) throw new RuntimeError("CONTEXT_UNCONFIRMED");
  return access;
}
/** Empty legacy files never grant automatic repository access. */
export function repositoryMode(
  settings: RuntimeSettings,
  context: Pick<OwnedContext, "generation" | "root">,
): RepositoryMode {
  if (!Object.hasOwn(settings, "repositoryAccess")) return "SELECTED";
  const access = settings.repositoryAccess;
  if (
    !validRepositoryAccess(access) ||
    settings.files.length !== 0 ||
    access.generation !== context.generation ||
    access.rootIdentityHash !== rootIdentityHash(context.root)
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  return "AUTO_CODE";
}
export function validToolPolicy(value: unknown): value is RepositoryToolPolicy {
  return (
    exact(value, ["version", "mode", "peerAllowed"]) &&
    (value as RepositoryToolPolicy).version === 1 &&
    ["SELECTED", "AUTO_CODE"].includes((value as RepositoryToolPolicy).mode) &&
    typeof (value as RepositoryToolPolicy).peerAllowed === "boolean"
  );
}
