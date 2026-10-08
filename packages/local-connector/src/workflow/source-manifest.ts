import {
  digest,
  stableJson,
  RuntimeError,
  type AttemptJournal,
  type RuntimeRecord,
} from "../runtime-contracts.ts";
import { repositoryMode } from "../workspace/repository-access.ts";
import { validRepositoryCalls } from "../workspace/repository-observation.ts";
import { validSourceObservation } from "./source-snapshot.ts";
import {
  validPublicSourceManifest,
  sourceManifestByteLimit,
  type PublicSourceManifest,
  type PublicSourceCall,
  type PublicSourceExcerpt,
} from "./source-contracts.ts";
export interface SourceByteLedger {
  recordBytes: number;
  inputBytes: number;
  publicInputBytes: number;
  callBytes: number;
  publicCallBytes: number;
  rootBytes: number;
  publicBytes: number;
}
export interface ProjectedSource {
  manifest: PublicSourceManifest;
  bytes: Buffer;
  manifestHash: string;
  ledger: SourceByteLedger;
}
/** Consumes a RuntimeStore-validated record; never reads files, native state, or tool result text. */
export function projectSourceManifest(
  record: RuntimeRecord,
  journal: AttemptJournal,
): ProjectedSource | null {
  if (!journal.sourceObservation) return null;
  const input = journal.sourceObservation;
  if (
    !validSourceObservation(input) ||
    !record.settings ||
    !record.context ||
    !validRepositoryCalls(journal, record.settings, record.context, record.operations)
  )
    throw new RuntimeError("INVALID_RUNTIME");
  const readMode = repositoryMode(record.settings, record.context);
  if (
    journal.generation !== record.context.generation ||
    stableJson(journal.scope) !== stableJson(record.scope)
  )
    throw new RuntimeError("AUTHORITY_LOST");
  const { ref, ...git } = input.git;
  const publicInput = {
    ...input,
    git: { ...git, refJson: ref === null ? null : JSON.stringify(ref) },
    files: {
      ...input.files,
      entries: input.files.entries.map(({ path, hash }) => ({
        pathJson: JSON.stringify(path),
        hash,
      })),
    },
  };
  const calls: PublicSourceCall[] = [];
  let callBytes = 0;
  journal.toolCalls.forEach((call, callIndex) => {
    const observation = call.repositoryObservation ?? call.peerEvidenceObservation;
    if (!observation) return;
    callBytes += Buffer.byteLength(stableJson(call));
    const files = observation.files.map((file, excerptIndex): PublicSourceExcerpt => ({
      excerptIndex,
      pathJson: JSON.stringify(file.path),
      hash: file.hash,
      readAt: file.readAt,
      byteStart: file.byteStart,
      byteEnd: file.byteEnd,
      excerptHash: file.excerptHash,
    }));
    if (observation.kind === "REPOSITORY_TOOL_OBSERVATION")
      calls.push({
        callIndex,
        kind: observation.kind,
        tool: observation.tool,
        resultHash: observation.resultHash,
        files,
      });
    else {
      if (!call.operationId) throw new RuntimeError("INVALID_RUNTIME");
      calls.push({
        callIndex,
        kind: observation.kind,
        purpose: observation.purpose,
        questionOperationId: call.operationId,
        files: files.map((file, index) => ({
          ...file,
          lineCount: observation.files[index].lineCount,
          requestedStartLine: observation.files[index].startLine,
          requestedEndLine: observation.files[index].endLine,
        })),
      });
    }
  });
  const manifest: PublicSourceManifest = {
    version: 2,
    kind: "RUN_SOURCE_MANIFEST",
    readMode,
    input: publicInput,
    calls,
  };
  if (!validPublicSourceManifest(manifest)) throw new RuntimeError("INVALID_RUNTIME");
  const bytes = Buffer.from(stableJson(manifest)),
    inputBytes = Buffer.byteLength(stableJson(input)),
    publicInputBytes = Buffer.byteLength(stableJson(publicInput)),
    publicCallBytes = Buffer.byteLength(stableJson(calls)),
    recordBytes = Buffer.byteLength(JSON.stringify(record));
  // Array brackets and preserved call separators belong to the call collection, not new root metadata.
  callBytes += 2 + Math.max(0, calls.length - 1);
  const rootBytes = bytes.length - publicInputBytes - publicCallBytes;
  // Validated local records dominate the projection. A failure is an invariant defect, never truncation.
  if (
    rootBytes > 256 ||
    publicInputBytes > 2 * inputBytes ||
    publicCallBytes > 2 * callBytes ||
    bytes.length > 2 * recordBytes ||
    bytes.length > sourceManifestByteLimit
  )
    throw new RuntimeError("INVALID_RUNTIME");
  return {
    manifest,
    bytes,
    manifestHash: digest(bytes),
    ledger: {
      recordBytes,
      inputBytes,
      publicInputBytes,
      callBytes,
      publicCallBytes,
      rootBytes,
      publicBytes: bytes.length,
    },
  };
}
