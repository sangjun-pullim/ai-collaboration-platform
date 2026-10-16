import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";

test(
  "should restrict pre-input RPC grants and reject an expired device credential",
  { timeout: 300000 },
  () =>
    workflowCase("preinput-expired", async (f) => {
      const s = await f.directScene();
      const admission = await f.ask(s);
      const attempt = await f.run(s.responder, admission.requestId!);
      await assertOwnedStack(f.stack.config);
      const grants = await f.stack.db.query(`select
      has_function_privilege('anon','public.workflow_device_fail_before_input(jsonb,text)','execute') device,
      has_function_privilege('authenticated','public.workflow_device_fail_before_input(jsonb,text)','execute') human_device,
      has_function_privilege('anon','public.connection_execution_status(uuid,uuid)','execute') anon_status,
      has_function_privilege('authenticated','public.connection_execution_status(uuid,uuid)','execute') owner_status,
      has_table_privilege('authenticated','workflow_private.preinput_failures','select') evidence`);
      assert.deepEqual(grants.rows[0], {
        device: true,
        human_device: false,
        anon_status: false,
        owner_status: true,
        evidence: false,
      });
      await f.stack.db.query(
        "update device_binding_private.credentials set expires_at=clock_timestamp()-interval '1 second' where device_id=$1",
        [s.responder.deviceId],
      );
      const result = await f.device(s.responder, "fail-before-input", {
        ...f.identity(attempt),
        proofVersion: 1,
        proofHash: "e".repeat(64),
        reason: "SNAPSHOT_CHANGED",
      });
      assert.equal(result.status, 401);
      const evidence = await f.stack.db.query(
        "select count(*)::int n from workflow_private.preinput_failures where attempt_id=$1",
        [attempt.attemptId],
      );
      assert.equal(evidence.rows[0].n, 0);
    }),
);

test(
  "should serialize device revocation with pre-input failure without reopening the device",
  { timeout: 300000 },
  () =>
    workflowCase("preinput-revoke-race", async (f) => {
      const s = await f.directScene();
      const admission = await f.ask(s);
      const attempt = await f.run(s.responder, admission.requestId!);
      const body = {
        ...f.identity(attempt),
        proofVersion: 1,
        proofHash: "f".repeat(64),
        reason: "POLICY_REJECTED",
      };
      const [failure, revoke] = await Promise.all([
        f.device(s.responder, "fail-before-input", body),
        f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId }),
      ]);
      assert.equal(revoke.status, 200);
      assert.ok([200, 401].includes(failure.status));
      assert.equal((await f.device(s.responder, "fail-before-input", body)).status, 401);
      const history = await f.read(s);
      assert.equal(
        history.runs.find((run) => run.requestId === attempt.requestId)?.state,
        failure.status === 200 ? "FAILED" : "UNKNOWN",
      );
      assert.equal((await f.count(s.scope.roomId)).attempts, 1);
    }),
);

test(
  "should serialize duplicate pre-input reports and never advance a paired investigation",
  { timeout: 300000 },
  () =>
    workflowCase("preinput-paired", async (f) => {
      const s = await f.scene();
      const admission = await f.start(s);
      const attempt = await f.run(s.origin, admission.requestId!);
      const before = await f.count(s.scope.roomId);
      const body = {
        ...f.identity(attempt),
        proofVersion: 1,
        proofHash: "c".repeat(64),
        reason: "LOCAL_VALIDATION_FAILED",
      };
      const results = await Promise.all([
        f.device(s.origin, "fail-before-input", body),
        f.device(s.origin, "fail-before-input", body),
      ]);
      assert.deepEqual(
        results.map((result) => result.status),
        [200, 200],
      );
      assert.deepEqual(results[0].data, results[1].data);
      const after = await f.count(s.scope.roomId);
      assert.equal(after.requests, before.requests);
      assert.equal(after.attempts, before.attempts);
      assert.equal((await f.read(s)).cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal((await f.poll(s.responder)).queuedRequest, null);
    }),
);

test(
  "should preserve one terminal when a pre-input failure races normal completion",
  { timeout: 300000 },
  () =>
    workflowCase("preinput-race", async (f) => {
      const s = await f.directScene();
      const admission = await f.ask(s);
      const attempt = await f.run(s.responder, admission.requestId!);
      const identity = f.identity(attempt);
      const [failure, completion] = await Promise.all([
        f.device(s.responder, "fail-before-input", {
          ...identity,
          proofVersion: 1,
          proofHash: "d".repeat(64),
          reason: "SNAPSHOT_CHANGED",
        }),
        f.device(s.responder, "complete", {
          ...identity,
          operationId: randomUUID(),
          terminal: "COMPLETED",
          publicText: "합성 완료",
        }),
      ]);
      assert.deepEqual([failure.status, completion.status].sort(), [200, 409]);
      const history = await f.read(s);
      assert.equal(
        history.runs.find((run) => run.requestId === attempt.requestId)?.state,
        failure.status === 200 ? "FAILED" : "COMPLETED",
      );
      assert.equal((await f.count(s.scope.roomId)).attempts, 1);
    }),
);

test(
  "should settle an owned pre-input failure and allow a new human direct question",
  { timeout: 300000 },
  () =>
    workflowCase("preinput-direct", async (f) => {
      const s = await f.directScene();
      const admission = await f.ask(s);
      const attempt = await f.run(s.responder, admission.requestId!);
      const body = {
        ...f.identity(attempt),
        proofVersion: 1,
        proofHash: "a".repeat(64),
        reason: "SNAPSHOT_CHANGED",
      };
      const failed = await f.device(s.responder, "fail-before-input", body);
      assert.equal(failed.status, 200);
      assert.deepEqual(failed.data.data, {
        requestId: attempt.requestId,
        attemptId: attempt.attemptId,
        fence: attempt.fence,
        bindingEpoch: attempt.bindingEpoch,
        state: "FAILED",
        kind: "PREINPUT_REJECTED",
        proofHash: body.proofHash,
        adoption: "HUMAN_INPUT_REQUIRED",
      });
      assert.deepEqual((await f.device(s.responder, "fail-before-input", body)).data, failed.data);
      assert.equal(
        (await f.device(s.responder, "fail-before-input", { ...body, proofHash: "b".repeat(64) }))
          .status,
        409,
      );
      assert.equal(
        (await f.device(s.responder, "fail-before-input", { ...body, operationId: randomUUID() }))
          .status,
        409,
      );
      const statusBody = {
        expectedUserId: s.owner.id,
        roomId: s.scope.roomId,
        deviceId: s.responder.deviceId,
      };
      const status = await s.owner.web.post("/api/connections/status", statusBody);
      assert.equal(status.status, 200);
      const data = await status.json();
      assert.deepEqual(data.data.executionStatus.failure, {
        requestId: attempt.requestId,
        reason: body.reason,
      });
      assert.equal(
        (
          await s.requester.web.post("/api/connections/status", {
            ...statusBody,
            expectedUserId: s.requester.id,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await s.owner.web.post("/api/connections/status", {
            ...statusBody,
            expectedUserId: s.requester.id,
          })
        ).status,
        403,
      );
      const history = await f.read(s);
      assert.equal(history.cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal(
        history.runs.find((run) => run.requestId === attempt.requestId)?.state,
        "FAILED",
      );
      assert.ok(
        history.events.some(
          (event) =>
            event.kind === "RUN_STATE" &&
            event.requestId === attempt.requestId &&
            event.publicText === "",
        ),
      );
      await f.ready(s.responder);
      const next = await f.ask(s, randomUUID(), "새로운 합성 질문");
      assert.equal(next.accepted, true);
      assert.notEqual(next.requestId, attempt.requestId);
    }),
);

test(
  "should reject foreign scope and malformed evidence while preserving legacy UNKNOWN",
  { timeout: 300000 },
  () =>
    workflowCase("preinput-scope", async (f) => {
      const s = await f.directScene();
      const foreign = await f.directScene("foreign");
      const admission = await f.ask(s);
      const attempt = await f.run(s.responder, admission.requestId!);
      const body = {
        protocol: 1,
        ...f.identity(attempt),
        agentId: attempt.agentId,
        bindingEpoch: attempt.bindingEpoch,
        proofVersion: 1,
        proofHash: "b".repeat(64),
        reason: "POLICY_REJECTED",
      };
      await assertOwnedStack(f.stack.config);
      const call = (input: unknown, credential = s.responder.credential) =>
        f.stack.db.query(
          "select public.workflow_device_fail_before_input($1::jsonb,$2::text) result",
          [JSON.stringify(input), credential],
        );
      for (const patch of [
        { proofVersion: null },
        { reason: "UNKNOWN" },
        { proofHash: "bad" },
        { publicText: "forged" },
      ])
        await assert.rejects(call({ ...body, ...patch }), { message: "INVALID_BODY" });
      await assert.rejects(call(body, foreign.responder.credential), { message: "FORBIDDEN" });
      await assert.rejects(call({ ...body, bindingEpoch: attempt.bindingEpoch + 1 }), {
        message: "FORBIDDEN",
      });
      await assert.rejects(call({ ...body, fence: attempt.fence + 1 }), { message: "CONFLICT" });
      await f.expire("lease", attempt.attemptId);
      const before = await f.read(s);
      assert.equal(
        before.runs.find((run) => run.requestId === attempt.requestId)?.state,
        "UNKNOWN",
      );
      const empty = await f.stack.db.query(
        "select count(*)::int n from workflow_private.preinput_failures where attempt_id=$1",
        [attempt.attemptId],
      );
      assert.equal(empty.rows[0].n, 0);
      const result = await call(body);
      assert.equal(result.rows[0].result.adoption, "HISTORICAL");
      const repeated = await call(body);
      assert.deepEqual(repeated.rows[0].result, result.rows[0].result);
      const count = await f.count(s.scope.roomId);
      assert.equal(count.requests, 1);
      assert.equal(count.attempts, 1);
      const idle = await f.stack.db.query("select runtime_settings_private.idle($1) idle", [
        s.responder.deviceId,
      ]);
      assert.equal(
        idle.rows[0].idle,
        true,
        "A proved input-free terminal must not leave settings blocked by its old control",
      );
      const revoked = await f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId });
      assert.equal(revoked.status, 200);
      await assert.rejects(call(body), { message: "UNAUTHENTICATED" });
    }),
);
