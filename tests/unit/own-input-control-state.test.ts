import test from "node:test";
import assert from "node:assert/strict";
import {
  adoptInputState,
  projectOwnInputStates,
  inputIntent,
  inputIntentKey,
  inputReceipt,
  inputStatus,
  restoreInputIntent,
} from "../../src/features/investigation-coordinator/own-input-control-state.ts";
import type { InputState } from "../../src/features/investigation-coordinator/contracts.ts";
const id = "00000000-0000-4000-8000-000000000001",
  other = "00000000-0000-4000-8000-000000000002";
const state: InputState = {
  agentId: id,
  bindingEpoch: 1,
  revision: 1,
  paused: false,
  appliedRevision: null,
  appliedEpoch: null,
  appliedAt: null,
};
test("should adopt revisions monotonically and invalidate an old epoch ACK", () => {
  const current = {
    ...state,
    revision: 3,
    paused: true,
    appliedRevision: 3,
    appliedEpoch: 1,
    appliedAt: new Date().toISOString(),
  };
  assert.deepEqual(adoptInputState(current, state, id, 1), current);
  assert.equal(adoptInputState(current, current, id, 2), undefined);
  assert.throws(() => adoptInputState(current, { ...state, revision: 3 }, id, 1), {
    code: "UNAVAILABLE",
  });
  assert.equal(inputStatus(current, false), "일시정지 적용 보고");
  assert.equal(inputStatus({ ...state, bindingEpoch: 2 }, false), "요청됨 · 연결 프로그램 대기");
  assert.equal(inputStatus(current, true), "상태 확인 불가");
});
test("should persist and restore only this actor and room exact mutation body", () => {
  const intent = inputIntent(id, id, state, other);
  const storage = {
    getItem: (key: string) => (key === inputIntentKey(id, id) ? JSON.stringify(intent) : null),
  };
  assert.deepEqual(restoreInputIntent(storage, id, id), intent);
  assert.equal(restoreInputIntent(storage, other, id), null);
  const forged = {
    getItem: () => JSON.stringify({ ...intent, body: { ...intent.body, expectedUserId: other } }),
  };
  assert.equal(restoreInputIntent(forged, id, id), null);
  assert.deepEqual(inputReceipt(intent, { ...state, paused: true, revision: 2 }), {
    ...state,
    paused: true,
    revision: 2,
  });
  assert.throws(() => inputReceipt(intent, state), { code: "UNAVAILABLE" });
});
test("should keep current newer state when an exact old operation receipt is delivered", () => {
  const intent = inputIntent(id, id, state, other),
    receipt = inputReceipt(intent, { ...state, revision: 2, paused: true });
  const newer = { ...state, revision: 3 };
  assert.deepEqual(adoptInputState(newer, receipt, id, 1), newer);
  assert.equal(
    restoreInputIntent({ getItem: () => JSON.stringify(intent) }, id, id)?.body.operationId,
    other,
  );
});

test("should select current displayed owned bindings and ignore additional valid owner states", () => {
  const extra = { ...state, agentId: other };
  const projected = projectOwnInputStates({}, { roomId: id, bindings: [state, extra] }, id, [
    [id, 1],
  ]);
  assert.deepEqual(projected, { [id]: state });
  assert.deepEqual(
    projectOwnInputStates(
      { [id]: state },
      { roomId: id, bindings: [{ ...state, bindingEpoch: 1 }] },
      id,
      [[id, 2]],
    ),
    {},
  );
  assert.throws(
    () => projectOwnInputStates({}, { roomId: other, bindings: [state] }, id, [[id, 1]]),
    { code: "UNAVAILABLE" },
  );
});
