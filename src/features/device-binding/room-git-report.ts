import {
  ConnectionError,
  isBranch,
  isGitCommit,
  isUtcTimestamp,
  projectBinding,
  type PublicBinding,
} from "./contracts.ts";
export type RoomGitReport = {
  branch: string;
  commit: string;
  observedAt: string;
  receivedAt: string;
  stale: boolean;
};
export type RoomGitBinding = PublicBinding & { gitReport: RoomGitReport | null };
function exact(input: unknown, keys: string[]): input is Record<string, unknown> {
  return (
    !!input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    Object.keys(input).length === keys.length &&
    keys.every((key) => Object.hasOwn(input, key))
  );
}
/** Server query time determines freshness; rendering never claims automatic updates. */
export function projectRoomGitBindings(input: unknown): RoomGitBinding[] {
  if (
    !exact(input, ["bindings", "queriedAt"]) ||
    !Array.isArray(input.bindings) ||
    !isUtcTimestamp(input.queriedAt)
  )
    throw new ConnectionError("UNAVAILABLE");
  const queriedAt = Date.parse(input.queriedAt);
  return input.bindings.map((value: unknown) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !Object.hasOwn(value, "gitReport")
    )
      throw new ConnectionError("UNAVAILABLE");
    const { gitReport, ...registration } = value as Record<string, unknown>;
    const binding = projectBinding(registration, true);
    if (gitReport === null) return { ...binding, gitReport: null };
    if (
      !exact(gitReport, ["branch", "commit", "observedAt", "receivedAt"]) ||
      !isBranch(gitReport.branch) ||
      !isGitCommit(gitReport.commit) ||
      !isUtcTimestamp(gitReport.observedAt) ||
      !isUtcTimestamp(gitReport.receivedAt)
    )
      throw new ConnectionError("UNAVAILABLE");
    return {
      ...binding,
      gitReport: {
        branch: gitReport.branch,
        commit: gitReport.commit,
        observedAt: gitReport.observedAt,
        receivedAt: gitReport.receivedAt,
        stale: queriedAt - Date.parse(gitReport.observedAt) >= 120_000,
      },
    };
  });
}
