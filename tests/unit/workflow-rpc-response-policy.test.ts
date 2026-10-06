import test from "node:test";
import assert from "node:assert/strict";
import { projectRpcResponse } from "../../src/features/investigation-coordinator/rpc-response-policy.ts";
import {
  deviceActions,
  humanActions,
} from "../../src/features/investigation-coordinator/contracts.ts";
test("should translate only an exact claim denial marker to INPUT_PAUSED", () => {
  assert.throws(() => projectRpcResponse("claim", { claimDenied: "INPUT_PAUSED" }), {
    code: "INPUT_PAUSED",
  });
  for (const action of [...humanActions, ...deviceActions].filter((action) => action !== "claim"))
    assert.throws(() => projectRpcResponse(action, { claimDenied: "INPUT_PAUSED" }), {
      code: "UNAVAILABLE",
    });
  for (const marker of [{ claimDenied: "other" }, { claimDenied: "INPUT_PAUSED", extra: true }])
    assert.throws(() => projectRpcResponse("claim", marker), { code: "UNAVAILABLE" });
});
test("should preserve normal RPC projections and reject malformed success data", () => {
  const result = {
    roomId: "00000000-0000-4000-8000-000000000001",
    roomRevision: 1,
    roomMode: "PAUSED",
  };
  assert.deepEqual(projectRpcResponse("pause", result), result);
  assert.throws(() => projectRpcResponse("claim", {}), { code: "UNAVAILABLE" });
});
