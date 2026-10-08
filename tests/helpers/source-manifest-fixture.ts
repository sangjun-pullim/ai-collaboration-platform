import { createHash } from "node:crypto";
import {
  sourceStableJson,
  type PublicSourceManifest,
  type PublicSourceExcerpt,
} from "../../src/features/investigation-coordinator/source-contracts.ts";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
/** Fixture-only synthetic metadata; no native execution or repository input is needed. */
export function sourceFixtureManifest(
  paths: string[] = ["src/input.ts"],
  ref: string | null = null,
) {
  const entries = paths
    .map((path) => ({ path, hash: hash(path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const input = {
    version: 1 as const,
    kind: "INPUT_SOURCE_OBSERVATION" as const,
    git: {
      observedAt: "2026-10-06T00:00:00.000Z",
      commit: null,
      ref,
      dirty: "unknown" as const,
    },
    files: {
      validatedAt: "2026-10-06T00:00:00.000Z",
      pathBase: "SELECTED_ROOT" as const,
      entries,
      manifestHash: hash(sourceStableJson(entries)),
    },
  };
  const manifest: PublicSourceManifest = {
    version: 2,
    kind: "RUN_SOURCE_MANIFEST",
    readMode: "SELECTED",
    input: {
      ...input,
      observationHash: hash(sourceStableJson(input)),
      git: {
        observedAt: input.git.observedAt,
        commit: input.git.commit,
        dirty: input.git.dirty,
        refJson: ref === null ? null : JSON.stringify(ref),
      },
      files: {
        ...input.files,
        entries: entries.map(({ path, hash }) => ({ pathJson: JSON.stringify(path), hash })),
      },
    },
    calls: [],
  };
  const bytes = Buffer.from(sourceStableJson(manifest));
  return { manifest, bytes, manifestHash: hash(bytes) };
}

/** Synthetic reported observations, including a pre-question proof with no delivery receipt. */
export function sourceFixtureAutoManifest(questionOperationId: string) {
  const source = sourceFixtureManifest([], "null");
  const excerpt = (path: string, excerptIndex: number, byteStart: number): PublicSourceExcerpt => ({
    excerptIndex,
    pathJson: JSON.stringify(path),
    hash: hash(path),
    readAt: "2026-10-06T00:00:01.000Z",
    byteStart,
    byteEnd: byteStart + 8,
    excerptHash: hash(`${path}:${byteStart}`),
  });
  const repeated = "src/auth/route.ts";
  const manifest: PublicSourceManifest = {
    ...source.manifest,
    readMode: "AUTO_CODE",
    calls: [
      {
        callIndex: 0,
        kind: "REPOSITORY_TOOL_OBSERVATION",
        tool: "list_workspace_files",
        resultHash: hash("list"),
        files: [],
      },
      {
        callIndex: 2,
        kind: "REPOSITORY_TOOL_OBSERVATION",
        tool: "read_workspace_file",
        resultHash: hash("read"),
        files: [excerpt(repeated, 0, 0)],
      },
      {
        callIndex: 5,
        kind: "REPOSITORY_TOOL_OBSERVATION",
        tool: "search_workspace",
        resultHash: hash("search"),
        files: [
          excerpt(repeated, 0, 16),
          excerpt("src/😀\ud800.ts", 1, 0),
          excerpt(`${"a".repeat(509)}.ts`, 2, 0),
        ],
      },
      {
        callIndex: 9,
        kind: "PEER_EVIDENCE_OBSERVATION",
        purpose: "VERIFIED_FOR_PEER_QUESTION",
        questionOperationId,
        files: [
          {
            ...excerpt(repeated, 0, 32),
            lineCount: 12,
            requestedStartLine: 2,
            requestedEndLine: 3,
          },
          {
            ...excerpt("src/\ue000.ts", 1, 0),
            lineCount: 4,
            requestedStartLine: 1,
            requestedEndLine: 4,
          },
        ],
      },
    ],
  };
  const bytes = Buffer.from(sourceStableJson(manifest));
  return { manifest, bytes, manifestHash: hash(bytes) };
}
