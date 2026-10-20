import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";
import { projectRunDiagnostics } from "../../src/features/investigation-coordinator/run-diagnostics-contracts.js";
import { projectResponse } from "../../src/features/investigation-coordinator/contracts.js";
const options = { timeout: 300000 };

test(
  "should grant ten minutes only to new direct questions and retain peer two-minute deadlines",
  options,
  () =>
    workflowCase("timeout-admission", async (f) => {
      const s = await f.directScene("timeout-direct");
      const admitted = await f.ask(s);
      const result = await f.stack.db.query(
        "select extract(epoch from (q.deadline-c.created_at)) seconds,q.deadline<=c.deadline capped,r.deadline=q.deadline copied from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id join workflow_private.requests r on r.question_id=q.id where r.id=$1",
        [admitted.requestId],
      );
      assert.equal(result.rows[0].capped, true);
      assert.equal(result.rows[0].copied, true);
      assert.ok(Number(result.rows[0].seconds) > 599 && Number(result.rows[0].seconds) <= 600);
      const pair = await f.scene("timeout-pair");
      const origin = await f.start(pair);
      const a = await f.run(pair.origin, origin.requestId!);
      const q = await f.question(pair.origin, a);
      const peer = await f.stack.db.query(
        "select extract(epoch from (deadline-clock_timestamp())) remaining from workflow_private.requests where id=$1",
        [q.peerRequestId],
      );
      assert.ok(Number(peer.rows[0].remaining) > 110 && Number(peer.rows[0].remaining) <= 120);
    }),
);

test(
  "should record first observed deadline or lease loss without changing termination evidence",
  options,
  () =>
    workflowCase("timeout-causes", async (f) => {
      for (const cause of [
        "deadline",
        "lease",
        "both",
        "deadline-first",
        "tie",
        "legacy",
      ] as const) {
        const s = await f.directScene(`timeout-${cause}`);
        const admitted = await f.ask(s);
        const a = await f.run(s.responder, admitted.requestId!);
        await assertOwnedStack(f.stack.config);
        if (cause === "legacy") {
          await f.stack.db.query(
            "update workflow_private.attempts set state='UNKNOWN' where id=$1",
            [a.attemptId],
          );
          await f.stack.db.query(
            "update workflow_private.requests set state='UNKNOWN' where id=$1",
            [admitted.requestId],
          );
        }
        if (cause !== "lease") await f.expire("cycle", admitted.cycleId);
        if (cause !== "deadline") await f.expire("lease", a.attemptId);
        if (cause === "both")
          await f.stack.db.query(
            "update workflow_private.attempts set lease_expires_at=clock_timestamp()-interval '2 seconds' where id=$1",
            [a.attemptId],
          );
        if (cause === "tie")
          await f.stack.db.query(
            "update workflow_private.attempts set lease_expires_at=(select deadline from workflow_private.cycles where id=$2) where id=$1",
            [a.attemptId, admitted.cycleId],
          );
        const page = await f.read(s);
        projectResponse("read", page);
        const before = await f.stack.db.query(
          "select stop_reason,stop_observed_at,stop_attempt_id,stop_fence,state from workflow_private.requests where id=$1",
          [admitted.requestId],
        );
        assert.equal(
          before.rows[0].stop_reason,
          cause === "legacy"
            ? null
            : cause === "deadline" || cause === "deadline-first"
              ? "RESPONSE_TIMEOUT"
              : "EXECUTION_LEASE_EXPIRED",
        );
        assert.equal(before.rows[0].state, cause === "deadline" ? "RUNNING" : "UNKNOWN");
        if (cause !== "legacy") {
          assert.equal(before.rows[0].stop_attempt_id, a.attemptId);
          assert.equal(Number(before.rows[0].stop_fence), a.fence);
        }
        await f.read(s);
        const after = await f.stack.db.query(
          "select stop_reason,stop_observed_at,stop_attempt_id,stop_fence,state from workflow_private.requests where id=$1",
          [admitted.requestId],
        );
        assert.deepEqual(after.rows, before.rows);
        assert.equal((await f.count(s.scope.roomId)).requests, 1);
        if (cause === "lease") {
          const observed = await f.device(s.responder, "observe", {
            ...f.identity(a),
            terminal: "COMPLETED",
            publicText: "늦은 정상 종결 관찰",
          });
          assert.equal(observed.status, 200);
          assert.deepEqual(projectResponse("observe", observed.data.data), {
            requestId: a.requestId,
            attemptId: a.attemptId,
            terminal: "COMPLETED",
            adoption: "HISTORICAL",
            continuationRequestId: null,
          });
          const late = (
            await f.stack.db.query(
              "select state,stop_reason from workflow_private.requests where id=$1",
              [admitted.requestId],
            )
          ).rows[0];
          assert.deepEqual(late, { state: "COMPLETED", stop_reason: "EXECUTION_LEASE_EXPIRED" });
        }
      }
    }),
);

test(
  "should authenticate read-only room diagnostics and reject mixed or revoked access",
  options,
  () =>
    workflowCase("timeout-access", async (f) => {
      const s = await f.directScene("timeout-access");
      const requestId = (await f.ask(s)).requestId!;
      const other = await f.directScene("timeout-foreign");
      const foreignId = (await f.ask(other)).requestId!;
      for (const person of [s.owner, s.requester, s.observer]) {
        const body = {
          protocol: 1 as const,
          roomId: s.scope.roomId,
          expectedUserId: person.id,
          requestIds: [requestId],
        };
        const response = await person.web.post("/api/run-diagnostics", body);
        assert.equal(response.status, 200);
        const result = projectRunDiagnostics((await response.json()).data, body);
        assert.equal(result.diagnostics[0].stopReason, null);
      }
      const body = {
        protocol: 1,
        roomId: s.scope.roomId,
        expectedUserId: s.owner.id,
        requestIds: [requestId],
      };
      assert.equal(
        (
          await s.owner.web.post("/api/run-diagnostics", {
            ...body,
            requestIds: [requestId, foreignId],
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await s.owner.web.post("/api/run-diagnostics", {
            ...body,
            expectedUserId: s.requester.id,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await s.outsider.web.post("/api/run-diagnostics", {
            ...body,
            expectedUserId: s.outsider.id,
          })
        ).status,
        403,
      );
      await assertOwnedStack(f.stack.config);
      await f.stack.db.query(
        "update public.room_members set status='removed' where room_id=$1 and user_id=$2",
        [s.scope.roomId, s.observer.id],
      );
      assert.equal(
        (
          await s.observer.web.post("/api/run-diagnostics", {
            ...body,
            expectedUserId: s.observer.id,
          })
        ).status,
        403,
      );
      const ids = Array.from({ length: 41 }, () => randomUUID());
      assert.equal(
        (await s.owner.web.post("/api/run-diagnostics", { ...body, requestIds: ids })).status,
        400,
      );
    }),
);

test(
  "should exclude unstarted pair requeue from stop reasons and record the subsequent real timeout",
  options,
  () =>
    workflowCase("timeout-requeue", async (f) => {
      const s = await f.scene("timeout-requeue");
      const admitted = await f.start(s);
      const first = await f.claim(s.origin, admitted.requestId!);
      await f.expire("lease", first.attemptId);
      await f.read(s);
      assert.equal(
        (
          await f.stack.db.query("select stop_reason from workflow_private.requests where id=$1", [
            admitted.requestId,
          ])
        ).rows[0].stop_reason,
        null,
      );
      const second = await f.run(s.origin, admitted.requestId!);
      await f.expire("cycle", admitted.cycleId);
      await f.read(s);
      const row = (
        await f.stack.db.query(
          "select stop_reason,stop_attempt_id,state from workflow_private.requests where id=$1",
          [admitted.requestId],
        )
      ).rows[0];
      assert.deepEqual(row, {
        stop_reason: "RESPONSE_TIMEOUT",
        stop_attempt_id: second.attemptId,
        state: "RUNNING",
      });
    }),
);
