import {
  RuntimeError,
  type AttemptJournal,
  type RuntimeOperation,
  type RuntimeRecord,
} from "../runtime-contracts.ts";

export const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function unsafe(): never {
  throw new RuntimeError("UNSAFE_STORAGE");
}

export function claimMatches(a: AttemptJournal, o: RuntimeOperation) {
  return (
    o.action === "claim" &&
    o.body.requestId === a.requestId &&
    o.body.bindingEpoch === a.scope.bindingEpoch &&
    o.operationId === a.claimOperationId
  );
}

export function attemptMatches(a: AttemptJournal, o: RuntimeOperation) {
  const snapshot =
    a.snapshot ??
    (a.unstartedClosure?.kind === "SERVER_ABANDONED" ? a.unstartedClosure.snapshot : null);
  return (
    !!snapshot &&
    o.body.requestId === a.requestId &&
    o.body.bindingEpoch === a.scope.bindingEpoch &&
    o.body.attemptId === snapshot.attemptId &&
    o.body.fence === snapshot.fence
  );
}

export function unresolvedRuntime(record: RuntimeRecord) {
  return (
    !!record.preparation ||
    record.attempts.some((a) => !["UPLOADED", "NOT_STARTED"].includes(a.state)) ||
    record.operations.some((o) => !["CONFIRMED", "CLOSED"].includes(o.state))
  );
}
