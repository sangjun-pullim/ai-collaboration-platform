import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { workflowCase } from "../helpers/workflow-fixture.js";
import {
  validateBody,
  projectResponse,
  type Body,
  type DeviceAction,
  type AttemptSnapshot,
} from "../../src/features/investigation-coordinator/contracts.js";

test(
  "should bind exact attachment retries capability negotiation and preinput failure to the assigned attempt",
  {
    timeout: 300000,
    skip:
      !process.env.LOCAL_ACCESS_DB_URL &&
      "requires the already prepared owned local DB and fixture app; never starts Docker",
  },
  async (t) =>
    workflowCase("attachment-workflow", async (f) => {
      const s = await f.directScene("attachment-workflow");
      const client = s.requester.web.dataClient();
      const admin = createClient(f.stack.config.api, f.stack.config.adminKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const anon = createClient(f.stack.config.api, f.stack.config.key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const ids: string[] = [];
      const scope = { protocol: 1, roomId: s.scope.roomId, expectedUserId: s.requester.id };
      const epoch = await f.epoch(s.responder);
      const capability = {
        protocol: 1,
        agentId: s.responder.agentId,
        bindingEpoch: epoch,
        imageInputVersion: 1,
      };
      const capabilityRpc = (body = capability) =>
        anon.rpc("chat_attachment_capability", { p_body: body, p_secret: s.responder.credential });
      // The existing fixture app predates the image HTTP contracts. Exercise the
      // installed SQL RPCs directly, retaining the current production validators.
      async function device(action: DeviceAction, fields: Body = {}) {
        const result = await anon.rpc(`workflow_device_${action.replaceAll("-", "_")}`, {
          p_body: validateBody(action, {
            protocol: 1,
            agentId: s.responder.agentId,
            bindingEpoch: epoch,
            ...fields,
          }),
          p_secret: s.responder.credential,
        });
        if (result.error) {
          const message = [
            "CONFLICT",
            "FORBIDDEN",
            "INVALID_BODY",
            "UNAUTHENTICATED",
            "UNAVAILABLE",
          ].includes(result.error.message)
            ? result.error.message
            : "withheld";
          t.diagnostic(`SQL ${action}: ${result.error.code} ${message}`);
        } else projectResponse(action, result.data);
        return result;
      }
      let stage = "capability";
      async function image() {
        const result = await client.rpc("chat_attachment_reserve", {
          p_body: {
            ...scope,
            mime: "image/png",
            bytes: 100,
            width: 10,
            height: 10,
            sha256: "b".repeat(64),
          },
        });
        assert.equal(result.error, null);
        assert.ok(result.data.attachmentId);
        ids.push(result.data.attachmentId);
        assert.equal(
          (await admin.rpc("chat_attachment_finalize", { p_id: result.data.attachmentId })).error,
          null,
        );
        return result.data.attachmentId as string;
      }
      try {
        assert.equal(
          (await capabilityRpc()).error?.message,
          "FORBIDDEN",
          "Codex is not advertised without actual version verification",
        );
        // Synthetic provider metadata only; no Claude process or model input is started.
        await f.stack.db.query(
          "update device_binding_private.agents set runtime='claude' where id=$1 and device_id=$2",
          [s.responder.agentId, s.responder.deviceId],
        );
        assert.equal(
          (await capabilityRpc({ ...capability, bindingEpoch: epoch + 1 })).error?.message,
          "FORBIDDEN",
        );
        assert.equal((await capabilityRpc()).error, null);
        const support = await client.rpc("chat_attachment_capabilities", { p_body: scope });
        assert.equal(support.error, null);
        assert.equal(support.data.length, 1);
        const a = await image(),
          b = await image();
        stage = "speech-replay";
        const speech = {
          ...scope,
          operationId: randomUUID(),
          publicText: "이미지를 첨부했습니다",
          attachmentId: a,
        };
        const first = await client.rpc("workflow_human_speak", { p_body: speech });
        assert.equal(first.error, null);
        assert.deepEqual(
          (await client.rpc("workflow_human_speak", { p_body: speech })).data,
          first.data,
        );
        assert.equal(
          (await client.rpc("workflow_human_speak", { p_body: { ...speech, attachmentId: b } }))
            .error?.message,
          "CONFLICT",
        );
        const { attachmentId: omitted, ...textOnly } = speech;
        void omitted;
        assert.equal(
          (await client.rpc("workflow_human_speak", { p_body: textOnly })).error?.message,
          "CONFLICT",
        );
        const plain = { ...textOnly, operationId: randomUUID() };
        assert.equal((await client.rpc("workflow_human_speak", { p_body: plain })).error, null);
        assert.equal(
          (await client.rpc("workflow_human_speak", { p_body: { ...plain, attachmentId: b } }))
            .error?.message,
          "CONFLICT",
        );
        const ask = {
          ...scope,
          operationId: randomUUID(),
          targetAgentId: s.responder.agentId,
          targetEpoch: epoch,
          expectedRoomRevision: (await f.read(s, s.requester)).roomRevision,
          publicText: "첨부 이미지를 설명해주세요",
          attachmentId: b,
          confirmed: true,
        };
        stage = "ask-replay";
        const admitted = await client.rpc("workflow_human_ask", { p_body: ask });
        assert.equal(admitted.error, null);
        const requestId = admitted.data.requestId as string;
        assert.ok(requestId);
        assert.equal(
          (await client.rpc("workflow_human_ask", { p_body: ask })).data.requestId,
          requestId,
        );
        assert.equal(
          (await client.rpc("workflow_human_ask", { p_body: { ...ask, attachmentId: a } })).error
            ?.message,
          "CONFLICT",
        );
        stage = "version-negotiation";
        const legacyPoll = (await device("poll")).data as {
          queuedRequest: unknown;
        };
        assert.equal(legacyPoll.queuedRequest, null);
        assert.equal(
          (await device("claim", { operationId: randomUUID(), requestId })).error?.message,
          "CONFLICT",
        );
        const queued = (await device("poll", { imageInputVersion: 1 })).data as {
          queuedRequest: { attachment: { attachmentId: string } };
        };
        assert.equal(queued.queuedRequest.attachment.attachmentId, b);
        const claimed = await device("claim", {
          operationId: randomUUID(),
          requestId,
          imageInputVersion: 1,
        });
        assert.equal(claimed.error, null);
        const started = await device("start-intent", f.identity(claimed.data as AttemptSnapshot));
        assert.equal(started.error, null);
        const attempt = started.data as AttemptSnapshot;
        const lease = await device("lease", f.identity(attempt));
        assert.equal(lease.error, null);
        assert.deepEqual(
          (lease.data as typeof attempt).payload.attachment,
          attempt.payload.attachment,
        );
        const oldPoll = (await device("poll")).data as {
          attempt: unknown;
          control: unknown;
        };
        assert.equal(oldPoll.attempt, null);
        assert.equal(oldPoll.control, null);
        const before = (
          await f.stack.db.query(
            "select reported_ready,valid_until from workflow_private.readiness where agent_id=$1",
            [s.responder.agentId],
          )
        ).rows[0];
        const failure = {
          ...f.identity(attempt),
          proofVersion: 1,
          proofHash: "c".repeat(64),
          reason: "IMAGE_CONTENT_MISMATCH",
        };
        stage = "interrupt-before-image-preinput-failure";
        const revision = (
          await f.stack.db.query("select revision from workflow_private.rooms where room_id=$1", [
            s.scope.roomId,
          ])
        ).rows[0].revision;
        const cancelled = await client.rpc("workflow_human_cancel", {
          p_body: {
            ...scope,
            operationId: randomUUID(),
            requestId: attempt.requestId,
            expectedRoomRevision: Number(revision),
          },
        });
        assert.equal(cancelled.error, null);
        assert.equal(cancelled.data.state, "REQUESTED");
        const control = await f.stack.db.query(
          "select state from workflow_private.controls where request_id=$1 and attempt_id=$2 and fence=$3",
          [attempt.requestId, attempt.attemptId, attempt.fence],
        );
        assert.equal(control.rows[0]?.state, "REQUESTED");
        stage = "image-preinput-failure";
        const failed = await device("fail-image-before-input", failure);
        assert.equal(failed.error, null);
        assert.equal((failed.data as { kind: string }).kind, "ATTACHMENT_PREINPUT_REJECTED");
        assert.deepEqual((await device("fail-image-before-input", failure)).data, failed.data);
        assert.equal(
          (
            await device("fail-image-before-input", {
              ...failure,
              operationId: randomUUID(),
              reason: "IMAGE_DOWNLOAD_FAILED",
            })
          ).error?.message,
          "CONFLICT",
        );
        assert.deepEqual(
          (
            await f.stack.db.query(
              "select reported_ready,valid_until from workflow_private.readiness where agent_id=$1",
              [s.responder.agentId],
            )
          ).rows[0],
          before,
        );
        assert.equal(
          (
            await f.stack.db.query("select state from workflow_private.attempts where id=$1", [
              attempt.attemptId,
            ])
          ).rows[0].state,
          "FAILED",
        );
        stage = "image-preinput-idle-regression";
        await t.test(
          "should release settings after an exact image preinput failure with a pending interrupt",
          async () => {
            const evidence = await f.stack.db.query(
              "select (select count(*)::int from workflow_private.preinput_failures where attempt_id=$1) text_proofs,(select count(*)::int from chat_attachments_private.preinput_failures where attempt_id=$1 and request_id=$2) image_proofs",
              [attempt.attemptId, attempt.requestId],
            );
            assert.deepEqual(evidence.rows[0], { text_proofs: 0, image_proofs: 1 });
            const retained = await f.stack.db.query(
              "select state from workflow_private.controls where request_id=$1 and attempt_id=$2 and fence=$3",
              [attempt.requestId, attempt.attemptId, attempt.fence],
            );
            assert.equal(retained.rows[0]?.state, "REQUESTED");
            const idle = await f.stack.db.query("select runtime_settings_private.idle($1) idle", [
              s.responder.deviceId,
            ]);
            assert.equal(
              idle.rows[0].idle,
              true,
              "An exact image input-free FAILED proof must release settings while retaining the old REQUESTED control",
            );
            const proof = (
              await f.stack.db.query(
                "select request_id,device_id,room_id,proof_hash,receipt from chat_attachments_private.preinput_failures where attempt_id=$1",
                [attempt.attemptId],
              )
            ).rows[0];
            await f.stack.db.query("begin");
            try {
              for (const patch of [
                { requestId: randomUUID() },
                { attemptId: randomUUID() },
                { fence: attempt.fence + 1 },
                { bindingEpoch: attempt.bindingEpoch + 1 },
                { proofHash: "d".repeat(64) },
                { state: "COMPLETED" },
                { kind: "PREINPUT_REJECTED" },
              ]) {
                await f.stack.db.query(
                  "update chat_attachments_private.preinput_failures set receipt=$1::jsonb where attempt_id=$2",
                  [JSON.stringify({ ...proof.receipt, ...patch }), attempt.attemptId],
                );
                assert.equal(
                  (
                    await f.stack.db.query("select runtime_settings_private.idle($1) idle", [
                      s.responder.deviceId,
                    ])
                  ).rows[0].idle,
                  false,
                  `Mismatched receipt ${Object.keys(patch)[0]} must retain the settings reservation`,
                );
              }
              await f.stack.db.query(
                "update chat_attachments_private.preinput_failures set receipt=$1::jsonb where attempt_id=$2",
                [JSON.stringify(proof.receipt), attempt.attemptId],
              );
              for (const patch of [
                { request_id: randomUUID() },
                { device_id: randomUUID() },
                { room_id: randomUUID() },
                { proof_hash: "d".repeat(64) },
              ]) {
                const changed = { ...proof, ...patch };
                await f.stack.db.query(
                  "update chat_attachments_private.preinput_failures set request_id=$1,device_id=$2,room_id=$3,proof_hash=$4 where attempt_id=$5",
                  [
                    changed.request_id,
                    changed.device_id,
                    changed.room_id,
                    changed.proof_hash,
                    attempt.attemptId,
                  ],
                );
                assert.equal(
                  (
                    await f.stack.db.query("select runtime_settings_private.idle($1) idle", [
                      s.responder.deviceId,
                    ])
                  ).rows[0].idle,
                  false,
                  `Mismatched proof ${Object.keys(patch)[0]} must retain the settings reservation`,
                );
              }
            } finally {
              await f.stack.db.query("rollback");
            }
            assert.equal(
              (
                await f.stack.db.query("select runtime_settings_private.idle($1) idle", [
                  s.responder.deviceId,
                ])
              ).rows[0].idle,
              true,
              "Rolling back synthetic mismatches must retain the exact valid image proof",
            );
          },
        );
        await f.stack.db.query(
          "update chat_attachments_private.capabilities set valid_until=clock_timestamp()-interval '1 second' where agent_id=$1",
          [s.responder.agentId],
        );
        const c = await image();
        stage = "expired-capability";
        assert.equal(
          (
            await client.rpc("workflow_human_ask", {
              p_body: { ...ask, operationId: randomUUID(), attachmentId: c },
            })
          ).error?.message,
          "CONFLICT",
        );
      } catch (error) {
        const frame =
          error instanceof Error
            ? error.stack?.match(/chat-attachments-workflow\.test\.(?:js|ts):(\d+):(\d+)/)
            : null;
        t.diagnostic(
          `Attachment workflow stage ${stage}${frame ? ` at ${frame[1]}:${frame[2]}` : ""}; private details withheld`,
        );
        throw error;
      } finally {
        // Only SQL fixture metadata exists; no Storage object has been uploaded here.
        await f.stack.db.query(
          "delete from chat_attachments_private.preinput_failures where room_id=$1",
          [s.scope.roomId],
        );
        await f.stack.db.query(
          "delete from chat_attachments_private.attempt_versions where attempt_id in (select a.id from workflow_private.attempts a join workflow_private.requests r on r.id=a.request_id where r.room_id=$1)",
          [s.scope.roomId],
        );
        await f.stack.db.query(
          "delete from chat_attachments_private.publications where room_id=$1",
          [s.scope.roomId],
        );
        await f.stack.db.query(
          "delete from chat_attachments_private.capabilities where room_id=$1",
          [s.scope.roomId],
        );
        await f.stack.db.query(
          "delete from chat_attachments_private.download_leases where attachment_id=any($1::uuid[])",
          [ids],
        );
        await f.stack.db.query(
          "with removed as (delete from chat_attachments_private.images where id=any($1::uuid[]) returning bytes,state) update chat_attachments_private.budget set charged_bytes=charged_bytes-coalesce((select sum(bytes) from removed where state<>'DELETED'),0) where id=1",
          [ids],
        );
      }
    }),
);
