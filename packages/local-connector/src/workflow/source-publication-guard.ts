import {
  RuntimeError,
  stableJson,
  type AttemptJournal,
  type RuntimeRecord,
} from "../runtime-contracts.ts";
import { isOwnedRuntimeRecord } from "./record-snapshot.ts";
import { projectSourceManifest, type ProjectedSource } from "./source-manifest.ts";

interface PublicationState {
  record: RuntimeRecord;
  journal: AttemptJournal;
}

function identity({ record, journal }: PublicationState) {
  if (!journal.snapshot) throw new RuntimeError("UNKNOWN");
  return {
    protocol: 1,
    agentId: record.scope.agentId,
    bindingEpoch: record.scope.bindingEpoch,
    requestId: journal.requestId,
    attemptId: journal.snapshot.attemptId,
    fence: journal.snapshot.fence,
  };
}

function assertOwned({ record, journal }: PublicationState) {
  if (!isOwnedRuntimeRecord(record) || !record.attempts.includes(journal))
    throw new RuntimeError("INVALID_RUNTIME");
}

/** Cache only immutable owned records; authority and exact attempt identity remain live checks. */
export function sourcePublicationGuard(
  initial: PublicationState,
  source: ProjectedSource,
  check: () => void,
  read: () => PublicationState,
  project = projectSourceManifest,
): () => void {
  assertOwned(initial);
  const expectedScope = stableJson(initial.journal.scope),
    expectedIdentity = stableJson(identity(initial)),
    expectedHash = source.manifestHash,
    expectedBytes = Buffer.from(source.bytes);
  let validatedRecord = initial.record;
  return () => {
    check();
    const current = read();
    assertOwned(current);
    const changed = current.record !== validatedRecord,
      rebuilt = changed ? project(current.record, current.journal) : undefined;
    if (
      stableJson(current.journal.scope) !== expectedScope ||
      stableJson(identity(current)) !== expectedIdentity ||
      (changed &&
        (!rebuilt || rebuilt.manifestHash !== expectedHash || !rebuilt.bytes.equals(expectedBytes)))
    )
      throw new RuntimeError("AUTHORITY_LOST");
    // A failed projection or comparison must never seed the cache.
    validatedRecord = current.record;
  };
}
