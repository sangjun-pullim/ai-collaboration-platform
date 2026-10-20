import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  runDiagnosticsRequest,
  projectRunDiagnostics,
} from "../../src/features/investigation-coordinator/run-diagnostics-contracts.ts";

const roomId = randomUUID(),
  expectedUserId = randomUUID(),
  requestId = randomUUID();
const body = { protocol: 1, roomId, expectedUserId, requestIds: [requestId] };
test("should accept forty unique IDs and reject invalid or duplicate requests", () => {
  assert.equal(
    runDiagnosticsRequest({ ...body, requestIds: Array.from({ length: 40 }, () => randomUUID()) })
      .requestIds.length,
    40,
  );
  for (const requestIds of [
    [],
    [requestId, requestId.toUpperCase()],
    ["invalid"],
    Array.from({ length: 41 }, () => randomUUID()),
  ])
    assert.throws(() => runDiagnosticsRequest({ ...body, requestIds }), { code: "INVALID_BODY" });
  assert.throws(() => runDiagnosticsRequest({ ...body, secret: "private" }), {
    code: "INVALID_BODY",
  });
});
test("should preserve legacy null reasons and reject secrets or incomplete observations", () => {
  const item = {
    requestId,
    deadline: "2030-01-01T00:00:00Z",
    stopReason: null,
    stopObservedAt: null,
  };
  const response = { protocol: 1, roomId, diagnostics: [item] };
  assert.deepEqual(projectRunDiagnostics(response, runDiagnosticsRequest(body)), response);
  for (const change of [
    { secret: "private" },
    { stopReason: "OTHER" },
    { stopReason: "RESPONSE_TIMEOUT" },
    { deadline: "invalid" },
  ])
    assert.throws(
      () => projectRunDiagnostics({ ...response, diagnostics: [{ ...item, ...change }] }),
      { code: "UNAVAILABLE" },
    );
  assert.throws(
    () => projectRunDiagnostics({ ...response, roomId: randomUUID() }, runDiagnosticsRequest(body)),
    { code: "UNAVAILABLE" },
  );
  assert.throws(
    () => projectRunDiagnostics({ ...response, diagnostics: [] }, runDiagnosticsRequest(body)),
    { code: "UNAVAILABLE" },
  );
});
