import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium, expect } from "@playwright/test";
import {
  seedRetirementHistory,
  seedUnretiredUnknown,
  withDepartedRetirementOwner,
  deleteOriginalRetirementDevice,
} from "../helpers/direct-retirement-fixture.js";
import {
  workflowCase,
  type WorkflowFixture,
  type HumanDirectScene,
} from "../helpers/workflow-fixture.js";
import {
  projectResponse,
  type RecoveryHistoryPage,
  type Body,
} from "../../src/features/investigation-coordinator/contracts.js";
import { assertOwnedStack, type FixturePerson } from "../helpers/local-access-stack.js";
import type { DeviceResponse } from "../helpers/device-binding-fixture.js";

async function recovery(
  f: WorkflowFixture,
  s: HumanDirectScene,
  person = s.owner,
  afterRetirementSequence = 0,
  afterSequence = 0,
) {
  const response = await person.web.post("/api/investigations/read-recovery", {
    protocol: 1,
    roomId: s.scope.roomId,
    afterSequence,
    afterRetirementSequence,
  });
  const envelope = await response.json();
  if (response.status !== 200)
    console.error(JSON.stringify({ retirementReadHTTPStatus: response.status }));
  assert.equal(response.status, 200, JSON.stringify(envelope));
  return projectResponse("read-recovery", envelope.data) as RecoveryHistoryPage;
}
async function retire(
  f: WorkflowFixture,
  s: HumanDirectScene,
  body: Body,
  person: FixturePerson = s.owner,
) {
  return f.human(person, "retire", body);
}

function errorCode(response: DeviceResponse) {
  assert.equal(response.data.ok, false);
  return (response.data.error as Record<string, unknown>).code;
}
function responseData(response: DeviceResponse) {
  assert.equal(response.data.ok, true);
  return response.data.data as Record<string, unknown>;
}
const riskOptions = { timeout: 300000 };
function retirementBody(s: HumanDirectScene, page: RecoveryHistoryPage): Body {
  assert.ok(page.recovery.candidate);
  const { requestId, cycleId, attemptId, fence, agentId, bindingEpoch } = page.recovery.candidate;
  return {
    protocol: 1,
    roomId: s.scope.roomId,
    operationId: randomUUID(),
    expectedUserId: s.owner.id,
    expectedRoomRevision: page.roomRevision,
    requestId,
    cycleId,
    attemptId,
    fence,
    agentId,
    bindingEpoch,
    confirmed: true,
  };
}
async function expiredDirect(f: WorkflowFixture, s: HumanDirectScene, revoke = true) {
  const admitted = await f.ask(s);
  const attempt = await f.run(s.responder, admitted.requestId!);
  await f.expire("cycle", admitted.cycleId);
  await f.expire("lease", attempt.attemptId);
  await recovery(f, s);
  if (revoke)
    assert.equal(
      (await f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId! })).status,
      200,
    );
  const page = await recovery(f, s);
  return { admitted, attempt, page, body: retirementBody(s, page) };
}
async function readyPair(f: WorkflowFixture, s: HumanDirectScene) {
  const origin = await f.devices.register(
    await f.devices.connected(s.owner, s.scope, "risk-fresh-origin"),
  );
  const peer = await f.devices.register(
    await f.devices.connected(s.requester, s.scope, "risk-fresh-peer"),
  );
  assert.equal((await f.ready(origin)).status, 200);
  assert.equal((await f.ready(peer)).status, 200);
  return {
    roomId: s.scope.roomId,
    originAgentId: origin.agentId!,
    peerAgentId: peer.agentId!,
    originEpoch: await f.epoch(origin),
    peerEpoch: await f.epoch(peer),
    publicText: "Owned synthetic retirement risk direction",
    confirmed: true,
  };
}
async function requestEvidence(f: WorkflowFixture, s: HumanDirectScene, requestId: string) {
  await assertOwnedStack(f.stack.config);
  assert.equal(f.rooms.get(s.scope.roomId), s.scope.organizationId);
  assert.equal(f.identities.get("requestId")?.has(requestId), true);
  const evidence = await f.stack.db.query(
    "select r.state,a.state attempt_state,c.retired_at is not null cycle_retired,(select count(*)::int from workflow_private.direct_retirements t where t.request_id=r.id) retirements,(select count(*)::int from workflow_private.controls ctl where ctl.request_id=r.id) controls from workflow_private.requests r join workflow_private.attempts a on a.request_id=r.id join workflow_private.cycles c on c.id=r.cycle_id where r.id=$1 and r.room_id=$2 and r.owner_id=$3",
    [requestId, s.scope.roomId, s.owner.id],
  );
  assert.equal(evidence.rowCount, 1);
  return evidence.rows[0] as {
    state: string;
    attempt_state: string;
    cycle_retired: boolean;
    retirements: number;
    controls: number;
  };
}

test(
  "should reject wrong retirement pins cookie actors departed owners and deleted device evidence",
  riskOptions,
  (t) =>
    workflowCase("retirement-risk-denials", async (f) => {
      const s = await f.directScene("retirement-denials");
      const prepared = await expiredDirect(f, s);
      const { body } = prepared;
      const before = await requestEvidence(f, s, prepared.attempt.requestId);
      for (const [field, value] of [
        ["bindingEpoch", (body.bindingEpoch as number) + 1],
        ["cycleId", randomUUID()],
        ["attemptId", randomUUID()],
        ["agentId", randomUUID()],
      ] as const) {
        await t.test(`should reject a wrong ${field} without altering UNKNOWN`, async () => {
          const response = await retire(f, s, {
            ...body,
            [field]: value,
            operationId: randomUUID(),
          });
          assert.equal(response.status, 409);
          assert.equal(errorCode(response), "CONFLICT");
          assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), before);
        });
      }
      await t.test("should reject a cookie actor that differs from expectedUserId", async () => {
        for (const [person, expectedUserId] of [
          [s.owner, s.requester.id],
          [s.requester, s.owner.id],
        ] as const) {
          const response = await retire(
            f,
            s,
            { ...body, expectedUserId, operationId: randomUUID() },
            person,
          );
          assert.equal(response.status, 403);
          assert.equal(errorCode(response), "FORBIDDEN");
        }
        assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), before);
      });
      await t.test(
        "should reject a departed target owner and restore only the owned membership",
        async () => {
          await withDepartedRetirementOwner(f, s, async () => {
            const response = await retire(f, s, { ...body, operationId: randomUUID() });
            assert.equal(response.status, 403);
            assert.equal(errorCode(response), "FORBIDDEN");
          });
          assert.equal((await recovery(f, s)).recovery.candidate?.canRetire, true);
          assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), before);
        },
      );
      await t.test(
        "should reject a deleted original device without fabricating revocation evidence",
        async () => {
          await deleteOriginalRetirementDevice(f, s, prepared.attempt.requestId);
          const page = await recovery(f, s);
          assert.equal(page.recovery.candidate?.deviceRevoked, false);
          assert.equal(page.recovery.candidate?.canRetire, false);
          const response = await retire(f, s, { ...body, operationId: randomUUID() });
          assert.equal(response.status, 409);
          assert.equal(errorCode(response), "CONFLICT");
          assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), before);
          assert.equal(page.recovery.hasBlockingRuns, true);
        },
      );
    }),
);

test(
  "should deny room-owner retirement of a different owner's AI while allowing that target owner",
  riskOptions,
  () =>
    workflowCase("retirement-risk-room-owner", async (f) => {
      const initial = await f.directScene("retirement-other-owner");
      const responder = await f.devices.register(
        await f.devices.connected(initial.requester, initial.scope, "risk-other-owner"),
      );
      await f.ready(responder);
      const s = { ...initial, requester: initial.owner, owner: initial.requester, responder };
      const prepared = await expiredDirect(f, s);
      assert.equal((await recovery(f, s, initial.owner)).recovery.candidate, null);
      const denied = await retire(
        f,
        s,
        { ...prepared.body, expectedUserId: initial.owner.id, operationId: randomUUID() },
        initial.owner,
      );
      assert.equal(denied.status, 403);
      assert.equal(errorCode(denied), "FORBIDDEN");
      assert.equal((await requestEvidence(f, s, prepared.attempt.requestId)).retirements, 0);
      assert.equal((await retire(f, s, prepared.body)).status, 200);
    }),
);

test(
  "should keep another historical UNKNOWN blocking ask start pause completion and room resume",
  riskOptions,
  () =>
    workflowCase("retirement-risk-blocker", async (f) => {
      const s = await f.directScene("retirement-other-unknown");
      const prepared = await expiredDirect(f, s);
      const other = await seedUnretiredUnknown(f, s, prepared.attempt.requestId);
      const pair = await readyPair(f, s);
      assert.equal((await retire(f, s, prepared.body)).status, 200);
      const current = await recovery(f, s);
      assert.equal(current.recovery.hasBlockingRuns, true);
      assert.equal(current.recovery.retirements.length, 1);
      const retired = await requestEvidence(f, s, prepared.attempt.requestId);
      assert.equal((await requestEvidence(f, s, other.requestId)).retirements, 0);
      for (const action of ["ask", "start"] as const) {
        const fields =
          action === "start"
            ? pair
            : {
                roomId: s.scope.roomId,
                targetAgentId: pair.originAgentId,
                targetEpoch: pair.originEpoch,
                publicText: "Owned synthetic blocked direct question",
                confirmed: true,
              };
        const response = await f.human(action === "start" ? s.owner : s.requester, action, {
          ...fields,
          operationId: randomUUID(),
          expectedRoomRevision: current.roomRevision,
        });
        assert.equal(response.status, 409);
        assert.equal(errorCode(response), "CONFLICT");
      }
      const paused = await f.human(s.owner, "pause", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedRoomRevision: current.roomRevision,
      });
      assert.equal(paused.status, 200);
      assert.equal(responseData(paused).roomMode, "PAUSING");
      const afterPause = await recovery(f, s);
      assert.equal(afterPause.roomMode, "PAUSING");
      assert.equal(afterPause.recovery.hasBlockingRuns, true);
      const resumed = await f.human(s.owner, "resume", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedRoomRevision: afterPause.roomRevision,
        mode: "room",
      });
      assert.equal(resumed.status, 409);
      assert.equal(errorCode(resumed), "CONFLICT");
      assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), retired);
      assert.equal((await requestEvidence(f, s, other.requestId)).controls, 1);
      assert.equal((await requestEvidence(f, s, other.requestId)).state, "UNKNOWN");
    }),
);

test(
  "should permit fresh paired start after retirement while preserving the old UNKNOWN and pause resume semantics",
  riskOptions,
  () =>
    workflowCase("retirement-risk-start", async (f) => {
      const s = await f.directScene("retirement-paired-start");
      const prepared = await expiredDirect(f, s);
      const pair = await readyPair(f, s);
      const blocked = await f.human(s.owner, "start", {
        ...pair,
        operationId: randomUUID(),
        expectedRoomRevision: prepared.page.roomRevision,
      });
      assert.equal(blocked.status, 409);
      assert.equal((await retire(f, s, prepared.body)).status, 200);
      const retired = await requestEvidence(f, s, prepared.attempt.requestId);
      const current = await recovery(f, s);
      assert.equal(current.recovery.hasBlockingRuns, false);
      const started = await f.human(s.owner, "start", {
        ...pair,
        operationId: randomUUID(),
        expectedRoomRevision: current.roomRevision,
      });
      assert.equal(started.status, 200);
      assert.equal(responseData(started).accepted, true);
      assert.notEqual(responseData(started).requestId, prepared.attempt.requestId);
      const active = await recovery(f, s);
      assert.equal(active.recovery.hasBlockingRuns, true);
      const paused = await f.human(s.owner, "pause", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedRoomRevision: active.roomRevision,
      });
      assert.equal(paused.status, 200);
      assert.equal(responseData(paused).roomMode, "PAUSED");
      assert.equal((await recovery(f, s)).recovery.hasBlockingRuns, false);
      const resumed = await f.human(s.owner, "resume", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedRoomRevision: responseData(paused).roomRevision as number,
        mode: "room",
      });
      assert.equal(resumed.status, 200);
      assert.equal(responseData(resumed).roomMode, "ACTIVE");
      assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), retired);
    }),
);

test(
  "should return one immutable receipt for concurrent same-operation retirement without a second revision",
  riskOptions,
  () =>
    workflowCase("retirement-risk-concurrent", async (f) => {
      const s = await f.directScene("retirement-concurrent");
      const prepared = await expiredDirect(f, s);
      const results = await Promise.all([retire(f, s, prepared.body), retire(f, s, prepared.body)]);
      assert.deepEqual(
        results.map((result) => result.status),
        [200, 200],
      );
      assert.deepEqual(results[0].data.data, results[1].data.data);
      const page = await recovery(f, s);
      assert.equal(page.roomRevision, prepared.page.roomRevision + 1);
      assert.equal(page.recovery.retirements.length, 1);
      assert.equal(page.recovery.highWaterRetirementSequence, 1);
      assert.equal((await requestEvidence(f, s, prepared.attempt.requestId)).state, "UNKNOWN");
      assert.equal((await requestEvidence(f, s, prepared.attempt.requestId)).retirements, 1);
      const newOperation = await retire(f, s, { ...prepared.body, operationId: randomUUID() });
      assert.equal(newOperation.status, 409);
      assert.equal((await recovery(f, s)).roomRevision, page.roomRevision);
    }),
);

test(
  "should serialize terminal reporting device revocation and retirement without recording a false terminal",
  riskOptions,
  () =>
    workflowCase("retirement-risk-race", async (f) => {
      const s = await f.directScene("retirement-terminal-race");
      const prepared = await expiredDirect(f, s, false);
      const [retired, terminal, revoked] = await Promise.all([
        retire(f, s, prepared.body),
        f.device(s.responder, "observe", {
          ...f.identity(prepared.attempt),
          terminal: "COMPLETED",
          publicText: "Owned synthetic race terminal",
        }),
        f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId! }),
      ]);
      assert.equal(revoked.status, 200);
      assert.ok([200, 409].includes(retired.status));
      assert.ok([200, 401].includes(terminal.status));
      const evidence = await requestEvidence(f, s, prepared.attempt.requestId);
      if (terminal.status === 200) {
        assert.equal(responseData(terminal).terminal, "COMPLETED");
        assert.equal(responseData(terminal).adoption, "HISTORICAL");
        assert.equal(retired.status, 409);
        assert.equal(evidence.state, "COMPLETED");
        assert.equal(evidence.attempt_state, "COMPLETED");
        assert.equal(evidence.retirements, 0);
        assert.equal((await recovery(f, s)).recovery.hasBlockingRuns, false);
      } else {
        assert.equal(evidence.state, "UNKNOWN");
        assert.equal(evidence.attempt_state, "UNKNOWN");
        assert.equal(evidence.retirements, retired.status === 200 ? 1 : 0);
        if (retired.status === 409) {
          const page = await recovery(f, s);
          assert.equal(page.recovery.candidate?.canRetire, true);
          assert.equal((await retire(f, s, prepared.body)).status, 200);
        }
        assert.equal((await requestEvidence(f, s, prepared.attempt.requestId)).state, "UNKNOWN");
        assert.equal((await recovery(f, s)).recovery.hasBlockingRuns, false);
      }
    }),
);

test(
  "should reject a revoked UNKNOWN while its effective direct-question deadline is still in the future",
  riskOptions,
  () =>
    workflowCase("retirement-risk-before-deadline", async (f) => {
      const s = await f.directScene("retirement-before-deadline");
      const admitted = await f.ask(s);
      const attempt = await f.run(s.responder, admitted.requestId!);
      assert.equal(
        (await f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId! })).status,
        200,
      );
      const page = await recovery(f, s);
      const before = await requestEvidence(f, s, attempt.requestId);
      assert.equal(before.state, "UNKNOWN");
      assert.equal(before.attempt_state, "UNKNOWN");
      const deadline = await f.stack.db.query(
        "select least(r.deadline,c.deadline)>clock_timestamp() unexpired,d.state='revoked' revoked from workflow_private.requests r join workflow_private.cycles c on c.id=r.cycle_id join device_binding_private.devices d on d.id=r.device_id where r.id=$1 and r.room_id=$2 and r.owner_id=$3 and d.id=$4 and d.owner_user_id=$3",
        [attempt.requestId, s.scope.roomId, s.owner.id, s.responder.deviceId],
      );
      assert.equal(deadline.rowCount, 1);
      assert.equal(deadline.rows[0].unexpired, true);
      assert.equal(deadline.rows[0].revoked, true);
      const response = await retire(f, s, {
        protocol: 1,
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedUserId: s.owner.id,
        expectedRoomRevision: page.roomRevision,
        requestId: attempt.requestId,
        cycleId: admitted.cycleId,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        agentId: s.responder.agentId!,
        bindingEpoch: attempt.bindingEpoch,
        confirmed: true,
      });
      assert.equal(response.status, 409);
      assert.equal(errorCode(response), "CONFLICT");
      assert.deepEqual(await requestEvidence(f, s, attempt.requestId), before);
      assert.equal((await recovery(f, s)).recovery.hasBlockingRuns, true);
      assert.equal((await recovery(f, s)).recovery.retirements.length, 0);
    }),
);

test(
  "should block AI_PAIR cycle resume on a separate unretired UNKNOWN after exact DIRECT retirement",
  riskOptions,
  () =>
    workflowCase("retirement-risk-cycle-resume", async (f) => {
      const s = await f.directScene("retirement-cycle-resume");
      const prepared = await expiredDirect(f, s);
      const pair = await readyPair(f, s);
      assert.equal((await retire(f, s, prepared.body)).status, 200);
      const retired = await requestEvidence(f, s, prepared.attempt.requestId);
      let page = await recovery(f, s);
      const started = await f.human(s.owner, "start", {
        ...pair,
        operationId: randomUUID(),
        expectedRoomRevision: page.roomRevision,
      });
      assert.equal(started.status, 200);
      const cycleId = responseData(started).cycleId as string;
      page = await recovery(f, s);
      const interrupt = () =>
        f.human(s.owner, "interrupt", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          agentId: pair.originAgentId,
          bindingEpoch: pair.originEpoch,
          expectedRoomRevision: page.roomRevision,
        });
      assert.equal((await interrupt()).status, 200);
      page = await recovery(f, s);
      assert.ok(page.cycle && !("mode" in page.cycle));
      assert.equal(page.cycle.state, "HUMAN_INPUT_REQUIRED");
      assert.equal(page.recovery.hasBlockingRuns, false);
      const resumable: Body = {
        ...pair,
        cycleId,
        mode: "cycle",
        operationId: randomUUID(),
        expectedRoomRevision: page.roomRevision,
      };
      const resumed = await f.human(s.owner, "resume", resumable);
      assert.equal(resumed.status, 200);
      assert.equal(responseData(resumed).accepted, true);
      page = await recovery(f, s);
      assert.equal((await interrupt()).status, 200);
      page = await recovery(f, s);
      assert.equal(page.recovery.hasBlockingRuns, false);
      const other = await seedUnretiredUnknown(f, s, prepared.attempt.requestId);
      page = await recovery(f, s);
      assert.equal(page.recovery.hasBlockingRuns, true);
      assert.ok(page.cycle && !("mode" in page.cycle));
      assert.equal(page.cycle.cycleId, cycleId);
      assert.equal(page.cycle.state, "HUMAN_INPUT_REQUIRED");
      const blocked = await f.human(s.owner, "resume", {
        ...resumable,
        operationId: randomUUID(),
        expectedRoomRevision: page.roomRevision,
      });
      assert.equal(blocked.status, 409);
      assert.equal(errorCode(blocked), "CONFLICT");
      const after = await recovery(f, s);
      assert.equal(after.cycle?.cycleId, cycleId);
      assert.equal(after.cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal(after.recovery.retirements.length, 1);
      assert.deepEqual(await requestEvidence(f, s, prepared.attempt.requestId), retired);
      const unknown = await requestEvidence(f, s, other.requestId);
      assert.equal(unknown.state, "UNKNOWN");
      assert.equal(unknown.retirements, 0);
      assert.equal(unknown.cycle_retired, true);
    }),
);

test(
  "should preserve an expired UNKNOWN and remove its revoked device from conversation blockers",
  { timeout: 300000 },
  () =>
    workflowCase("retirement", async (f) => {
      const s = await f.directScene("retirement");
      const admitted = await f.ask(s);
      const attempt = await f.claim(s.responder, admitted.requestId!);
      await f.intent(s.responder, attempt);
      const beforeCancel = await f.read(s, s.requester);
      const cancelBody = {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        requestId: admitted.requestId!,
        expectedRoomRevision: beforeCancel.roomRevision,
      };
      const cancellation = await f.human(s.requester, "cancel", cancelBody);
      assert.equal(cancellation.status, 200);
      assert.equal((cancellation.data.data as Record<string, unknown>).state, "REQUESTED");
      await f.expire("cycle", admitted.cycleId!);
      await f.expire("lease", attempt.attemptId);
      const livePage = await recovery(f, s);
      assert.equal(livePage.recovery.candidate?.canRetire, false);
      const early: Body = {
        protocol: 1,
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedUserId: s.owner.id,
        expectedRoomRevision: livePage.roomRevision,
        requestId: admitted.requestId!,
        cycleId: admitted.cycleId!,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        agentId: s.responder.agentId!,
        bindingEpoch: await f.epoch(s.responder),
        confirmed: true,
      };
      assert.equal((await retire(f, s, early)).status, 409);
      await f.stack.db.query(
        "update device_binding_private.credentials set expires_at=clock_timestamp()-interval '1 second' where device_id=$1",
        [s.responder.deviceId],
      );
      assert.equal((await recovery(f, s)).recovery.candidate?.deviceRevoked, false);
      assert.equal((await retire(f, s, { ...early, operationId: randomUUID() })).status, 409);
      await f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId! });
      const before = await f.stack.db.query(
        "select to_jsonb(r) as request,to_jsonb(a) as attempt,c.runs_reserved,c.peer_rounds_reserved from workflow_private.requests r join workflow_private.attempts a on a.request_id=r.id join workflow_private.cycles c on c.id=r.cycle_id where r.id=$1",
        [admitted.requestId],
      );
      const page = await recovery(f, s);
      assert.equal(page.recovery.hasBlockingRuns, true);
      assert.ok(page.recovery.candidate);
      assert.equal(page.recovery.candidate.canRetire, true);
      const candidate = page.recovery.candidate;
      const fields: Body = {
        ...candidate,
        roomId: s.scope.roomId,
        expectedUserId: s.owner.id,
        expectedRoomRevision: page.roomRevision,
        operationId: randomUUID(),
        confirmed: true,
      };
      delete fields.roomRevision;
      delete fields.canRetire;
      delete fields.deviceRevoked;
      for (const person of [s.requester, s.observer, s.outsider]) {
        const denied = await retire(
          f,
          s,
          { ...fields, expectedUserId: person.id, operationId: randomUUID() },
          person,
        );
        assert.equal(denied.status, 403);
      }
      const wrongFence = await retire(f, s, {
        ...fields,
        fence: candidate.fence + 1,
        operationId: randomUUID(),
      });
      assert.equal(wrongFence.status, 409);
      const result = await retire(f, s, fields);
      assert.equal(result.status, 200);
      assert.equal((result.data.data as Record<string, unknown>).state, "RETIRED_UNCONFIRMED");
      const same = await retire(f, s, fields);
      assert.equal(same.status, 200);
      assert.deepEqual(same.data.data, result.data.data);
      const conflict = await retire(f, s, { ...fields, fence: candidate.fence + 1 });
      assert.equal(conflict.status, 409);
      const restoredCancel = await f.human(s.requester, "cancel", cancelBody);
      assert.equal(restoredCancel.status, 200);
      assert.deepEqual(restoredCancel.data.data, cancellation.data.data);
      const afterPage = await recovery(f, s);
      assert.equal(afterPage.cycle, null);
      assert.equal(afterPage.recovery.hasBlockingRuns, false);
      assert.equal(afterPage.recovery.retirements.length, 1);
      assert.equal(afterPage.recovery.retirements[0].requestId, admitted.requestId);
      assert.equal(afterPage.recovery.candidate, null);
      const observerPage = await recovery(f, s, s.observer);
      assert.equal(observerPage.recovery.candidate, null);
      assert.deepEqual(observerPage.recovery.retirements, afterPage.recovery.retirements);
      const after = await f.stack.db.query(
        "select to_jsonb(r) as request,to_jsonb(a) as attempt,c.runs_reserved,c.peer_rounds_reserved from workflow_private.requests r join workflow_private.attempts a on a.request_id=r.id join workflow_private.cycles c on c.id=r.cycle_id where r.id=$1",
        [admitted.requestId],
      );
      assert.deepEqual(after.rows, before.rows);
      const legacy = await f.read(s, s.requester);
      assert.equal(Object.hasOwn(legacy, "recovery"), false);
      const staleCancel = await f.human(s.requester, "cancel", {
        ...cancelBody,
        operationId: randomUUID(),
        expectedRoomRevision: afterPage.roomRevision,
      });
      assert.equal(staleCancel.status, 409);
      const deniedUpload = await f.device(s.responder, "observe", {
        ...f.identity(attempt),
        terminal: "COMPLETED",
        publicText: "A late old answer",
      });
      assert.equal(deniedUpload.status, 401);
      const paused = await f.human(s.owner, "pause", {
        roomId: s.scope.roomId,
        expectedRoomRevision: afterPage.roomRevision,
        operationId: randomUUID(),
      });
      assert.equal(paused.status, 200);
      assert.equal((paused.data.data as Record<string, unknown>).roomMode, "PAUSED");
      const resumed = await f.human(s.owner, "resume", {
        roomId: s.scope.roomId,
        expectedRoomRevision: (paused.data.data as Record<string, unknown>).roomRevision as number,
        operationId: randomUUID(),
        mode: "room",
      });
      assert.equal(resumed.status, 200);
      const fresh = await f.devices.register(
        await f.devices.connected(s.owner, s.scope, "retirement-fresh"),
      );
      await f.ready(fresh);
      const newAdmission = await f.ask({ ...s, responder: fresh });
      assert.notEqual(newAdmission.requestId, admitted.requestId);
      assert.equal((await recovery(f, s)).recovery.hasBlockingRuns, true);
      const secondAttempt = await f.claim(fresh, newAdmission.requestId!);
      await f.intent(fresh, secondAttempt);
      await f.expire("cycle", newAdmission.cycleId!);
      await f.devices.human(s.owner, "revoke", { deviceId: fresh.deviceId! });
      const browser = await chromium.launch({ headless: true });
      try {
        const entry = f.stack.entryForBrowser(s.owner);
        const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await desktop.addCookies(
          entry.cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
        );
        const page = await desktop.newPage();
        const roomURL = f.stack.config.app + "/app/rooms/" + s.scope.roomId;
        await page.goto(roomURL);
        await expect(
          page.getByRole("button", { name: "이전 요청 정리", exact: true }),
        ).toBeEnabled();
        await page.getByRole("button", { name: "이전 요청 정리", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "취소", exact: true }).click();
        assert.equal((await recovery(f, s)).recovery.retirements.length, 1);
        await desktop.close();
        const observer = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await observer.addCookies(
          f.stack
            .entryForBrowser(s.observer)
            .cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
        );
        const observerPage = await observer.newPage();
        await observerPage.goto(roomURL);
        await expect(
          observerPage.getByRole("region", { name: "AI 답변 상태", exact: true }),
        ).toBeVisible();
        await expect(
          observerPage.getByRole("button", { name: "이전 요청 정리", exact: true }),
        ).toHaveCount(0);
        const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await mobile.addCookies(
          entry.cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
        );
        const mobilePage = await mobile.newPage();
        await mobilePage.goto(roomURL);
        await expect(
          mobilePage.getByRole("button", { name: "이전 요청 정리", exact: true }),
        ).toBeEnabled();
        await mobilePage.getByRole("button", { name: "이전 요청 정리", exact: true }).click();
        await mobilePage.getByRole("button", { name: "이전 기록에 보관", exact: true }).click();
        await expect(
          mobilePage.getByRole("button", { name: "이전 요청 정리", exact: true }),
        ).toHaveCount(0);
        await expect(
          mobilePage.getByRole("region", { name: "AI 답변 상태", exact: true }),
        ).toHaveCount(0);
        await expect(
          mobilePage.locator("summary").filter({ hasText: "답변 미확인 · 이전 기록" }),
        ).toHaveCount(2);
        await expect(
          observerPage.getByRole("region", { name: "AI 답변 상태", exact: true }),
        ).toHaveCount(0, { timeout: 15000 });
        assert.equal((await recovery(f, s)).recovery.retirements.length, 2);
        await mobile.close();
        await observer.close();
      } finally {
        await browser.close();
      }
      await seedRetirementHistory(f, s, admitted.requestId!, 33);
      const highWater = (await f.read(s)).highWaterSequence;
      const firstPage = await recovery(f, s, s.owner, 0, highWater);
      assert.equal(firstPage.events.length, 0);
      assert.equal(
        firstPage.runs.some((run) => run.requestId === admitted.requestId),
        false,
      );
      assert.equal(firstPage.recovery.retirements[0].requestId, admitted.requestId);
      assert.equal(firstPage.recovery.retirements.length, 32);
      assert.equal(firstPage.recovery.hasMoreRetirements, true);
      const lastPage = await recovery(
        f,
        s,
        s.owner,
        firstPage.recovery.nextRetirementCursor,
        highWater,
      );
      assert.equal(lastPage.recovery.retirements.length, 3);
      assert.equal(lastPage.recovery.nextRetirementCursor, 35);
      assert.equal(lastPage.recovery.hasMoreRetirements, false);
      assert.equal(lastPage.recovery.hasBlockingRuns, false);
      const obsoleteCursor = await s.owner.web.post("/api/investigations/read-recovery", {
        protocol: 1,
        roomId: s.scope.roomId,
        afterSequence: 0,
        afterRetirementSequence: 36,
      });
      assert.equal(obsoleteCursor.status, 409);
    }),
);
