import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { setTimeout as delay } from "node:timers/promises";
import {
  workflowCase,
  type WorkflowFixture,
  type HumanDirectScene,
} from "../helpers/workflow-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";

const options = { timeout: 300000 };

test("should recover the original rejected claim after its real queue deadline", options, () =>
  workflowCase("unstarted-deadline", async (f) => {
    const s = await f.directScene("unstarted-deadline");
    const requestId = (await f.ask(s)).requestId!;
    await f.device(s.responder, "ready", { operationId: randomUUID(), reportedReady: false });
    const body = { requestId, operationId: randomUUID() };
    assert.deepEqual((await f.device(s.responder, "claim", body)).data.error, { code: "CONFLICT" });
    const deadline = await f.stack.db.query(
      "select deadline from workflow_private.requests where id=$1",
      [requestId],
    );
    await delay(Math.max(0, new Date(deadline.rows[0].deadline).getTime() - Date.now()) + 100);
    cancelled(await f.device(s.responder, "claim", body));
    const attempts = await f.stack.db.query(
      "select count(*)::int n from workflow_private.attempts where request_id=$1",
      [requestId],
    );
    assert.equal(attempts.rows[0].n, 0);
  }),
);
async function cancel(f: WorkflowFixture, s: HumanDirectScene, requestId: string) {
  const result = await f.human(s.requester, "cancel", {
    roomId: s.scope.roomId,
    requestId,
    operationId: randomUUID(),
    expectedRoomRevision: (await f.read(s)).roomRevision,
  });
  assert.equal(result.status, 200);
  return result;
}
function cancelled(result: { status: number; data: { error?: unknown } }) {
  assert.equal(result.status, 409);
  assert.deepEqual(result.data.error, { code: "REQUEST_CANCELLED" });
}

test(
  "should preserve exact cancelled no-attempt proof and reject cross-scope or reused operations",
  options,
  () =>
    workflowCase("unstarted-proof", async (f) => {
      const s = await f.directScene("unstarted-proof");
      const request = await f.ask(s);
      const requestId = request.requestId!;
      await cancel(f, s, requestId);
      const body = { requestId, operationId: randomUUID() };
      cancelled(await f.device(s.responder, "claim", body));
      cancelled(await f.device(s.responder, "claim", body));
      await assertOwnedStack(f.stack.config);
      const evidence = await f.stack.db.query(
        "select state,(select count(*)::int from workflow_private.attempts where request_id=$1) attempts from workflow_private.requests where id=$1",
        [requestId],
      );
      assert.deepEqual(evidence.rows, [{ state: "CANCELLED", attempts: 0 }]);
      const receipts = await f.stack.db.query(
        "select action,result from workflow_private.receipts where actor_id=$1 and operation_id=$2",
        [s.responder.deviceId, body.operationId],
      );
      assert.deepEqual(receipts.rows, [
        { action: "claim", result: { claimDenied: "REQUEST_CANCELLED" } },
      ]);
      assert.equal(
        (
          await f.device(s.responder, "ready", {
            operationId: body.operationId,
            reportedReady: true,
          })
        ).status,
        409,
      );
      const next = await f.ask(s);
      assert.deepEqual(
        (await f.device(s.responder, "claim", { ...body, requestId: next.requestId! })).data.error,
        { code: "CONFLICT" },
      );
      assert.equal(
        (
          await f.device(s.responder, "claim", {
            ...body,
            bindingEpoch: (await f.epoch(s.responder)) + 1,
          })
        ).status,
        403,
      );
      const other = await f.directScene("other-proof");
      assert.equal((await f.device(other.responder, "claim", body)).status, 403);
      await f.stack.db.query(
        "update device_binding_private.credentials set expires_at=clock_timestamp()-interval '1 second' where device_id=$1",
        [s.responder.deviceId],
      );
      assert.equal((await f.device(s.responder, "claim", body)).status, 401);
      const grants = await f.stack.db.query(
        "select has_function_privilege('anon','own_input_private.cancelled_claim(jsonb,text)','execute') anon,has_function_privilege('authenticated','own_input_private.cancelled_claim(jsonb,text)','execute') authenticated",
      );
      assert.deepEqual(grants.rows, [{ anon: false, authenticated: false }]);
    }),
);

test("should never replace an existing claim or any attempt with cancellation proof", options, () =>
  workflowCase("unstarted-existing", async (f) => {
    const s = await f.directScene("unstarted-existing");
    const admitted = await f.ask(s);
    const requestId = admitted.requestId!;
    const body = { requestId, operationId: randomUUID() };
    const claim = await f.device(s.responder, "claim", body);
    assert.equal(claim.status, 200);
    await cancel(f, s, requestId);
    const replay = await f.device(s.responder, "claim", body);
    assert.equal(replay.status, 200);
    assert.equal(
      (replay.data.data as { attemptId: string }).attemptId,
      (claim.data.data as { attemptId: string }).attemptId,
    );
    await assertOwnedStack(f.stack.config);
    // Even inconsistent retained request state must not erase an older attempt.
    await f.stack.db.query("update workflow_private.requests set state='CANCELLED' where id=$1", [
      requestId,
    ]);
    const denied = await f.device(s.responder, "claim", { requestId, operationId: randomUUID() });
    assert.equal(denied.status, 409);
    assert.deepEqual(denied.data.error, { code: "CONFLICT" });
    await f.stack.db.query(
      "update workflow_private.attempts set state='ABANDONED' where request_id=$1",
      [requestId],
    );
    assert.deepEqual(
      (await f.device(s.responder, "claim", { requestId, operationId: randomUUID() })).data.error,
      { code: "CONFLICT" },
    );
    const proof = await f.stack.db.query(
      "select count(*)::int n from workflow_private.receipts where result=$1::jsonb and room_id=$2",
      [JSON.stringify({ claimDenied: "REQUEST_CANCELLED" }), s.scope.roomId],
    );
    assert.equal(proof.rows[0].n, 0);
  }),
);

test(
  "should serialize cancellation with claim without ever proving an admitted attempt absent",
  options,
  () =>
    workflowCase("unstarted-race", async (f) => {
      const s = await f.directScene("unstarted-race");
      const admitted = await f.ask(s);
      const requestId = admitted.requestId!;
      const claimBody = { requestId, operationId: randomUUID() };
      const [claim] = await Promise.all([
        f.device(s.responder, "claim", claimBody),
        cancel(f, s, requestId),
      ]);
      const row = await f.stack.db.query(
        "select count(*)::int n from workflow_private.attempts where request_id=$1",
        [requestId],
      );
      if (claim.status === 200) {
        assert.equal(row.rows[0].n, 1);
        assert.equal((await f.device(s.responder, "claim", claimBody)).status, 200);
      } else {
        cancelled(claim);
        assert.equal(row.rows[0].n, 0);
        cancelled(await f.device(s.responder, "claim", claimBody));
      }
    }),
);

test("should deny both original proof replay and new proof after device removal", options, () =>
  workflowCase("unstarted-revoked", async (f) => {
    const s = await f.directScene("unstarted-revoked");
    const requestId = (await f.ask(s)).requestId!;
    await cancel(f, s, requestId);
    const body = { requestId, operationId: randomUUID() };
    cancelled(await f.device(s.responder, "claim", body));
    assert.equal(
      (await f.devices.human(s.owner, "remove", { deviceId: s.responder.deviceId })).status,
      200,
    );
    assert.equal((await f.device(s.responder, "claim", body)).status, 401);
    assert.equal(
      (await f.device(s.responder, "claim", { ...body, operationId: randomUUID() })).status,
      401,
    );
  }),
);

test(
  "should recover expired cancelled image claims without relaxing live image admission",
  options,
  () =>
    workflowCase("unstarted-image", async (f) => {
      const s = await f.directScene("unstarted-image");
      await assertOwnedStack(f.stack.config);
      await f.stack.db.query(
        "update device_binding_private.agents set runtime='claude' where id=$1",
        [s.responder.agentId],
      );
      const anon = createClient(f.stack.config.api, f.stack.config.key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const admin = createClient(f.stack.config.api, f.stack.config.adminKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const person = s.requester.web.dataClient();
      const epoch = await f.epoch(s.responder);
      const scope = { protocol: 1, expectedUserId: s.requester.id, roomId: s.scope.roomId };
      const capability = () =>
        anon.rpc("chat_attachment_capability", {
          p_body: {
            protocol: 1,
            agentId: s.responder.agentId,
            bindingEpoch: epoch,
            imageInputVersion: 1,
          },
          p_secret: s.responder.credential,
        });
      const images: string[] = [];
      try {
        for (const state of ["ATTACHED", "DELETING", "DELETED"]) {
          await f.ready(s.responder);
          assert.equal((await capability()).error, null);
          const reserved = await person.rpc("chat_attachment_reserve", {
            p_body: {
              ...scope,
              mime: "image/png",
              bytes: 100,
              width: 10,
              height: 10,
              sha256: "a".repeat(64),
            },
          });
          assert.equal(reserved.error, null);
          const id = reserved.data.attachmentId as string;
          images.push(id);
          assert.equal((await admin.rpc("chat_attachment_finalize", { p_id: id })).error, null);
          const request = await person.rpc("workflow_human_ask", {
            p_body: {
              ...scope,
              operationId: randomUUID(),
              targetAgentId: s.responder.agentId,
              targetEpoch: epoch,
              expectedRoomRevision: (await f.read(s)).roomRevision,
              publicText: "Synthetic image",
              attachmentId: id,
              confirmed: true,
            },
          });
          assert.equal(request.error, null);
          const requestId = request.data.requestId as string;
          await f.stack.db.query(
            "update chat_attachments_private.capabilities set valid_until=clock_timestamp()-interval '1 second' where agent_id=$1",
            [s.responder.agentId],
          );
          const unsupported = await f.device(s.responder, "claim", {
            requestId,
            operationId: randomUUID(),
          });
          assert.deepEqual(unsupported.data.error, { code: "CONFLICT" });
          const expired = await f.device(s.responder, "claim", {
            requestId,
            operationId: randomUUID(),
            imageInputVersion: 1,
          });
          assert.deepEqual(expired.data.error, { code: "CONFLICT" });
          if (state !== "ATTACHED") {
            assert.equal((await capability()).error, null);
            await f.stack.db.query(
              "update chat_attachments_private.images set state=$2,deleted_at=case when $2='DELETED' then clock_timestamp() else null end where id=$1",
              [id, state],
            );
            assert.deepEqual(
              (
                await f.device(s.responder, "claim", {
                  requestId,
                  operationId: randomUUID(),
                  imageInputVersion: 1,
                })
              ).data.error,
              { code: "CONFLICT" },
            );
          }
          await cancel(f, s, requestId);
          const body = { requestId, operationId: randomUUID() };
          cancelled(await f.device(s.responder, "claim", body));
          cancelled(await f.device(s.responder, "claim", { ...body, imageInputVersion: 1 }));
        }
      } finally {
        for (const id of images)
          await f.stack.db.query("delete from chat_attachments_private.images where id=$1", [id]);
      }
    }),
);
