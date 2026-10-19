import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { cleanupImages } from "../../src/features/chat-attachments/cleanup.ts";
import type { AttachmentRpc, ImageStorage } from "../../src/features/chat-attachments/quota.ts";

function rpc(client: SupabaseClient): AttachmentRpc {
  return async (name, args) => {
    const result = await client.rpc(name, args);
    if (result.error) throw new Error(result.error.message);
    return result.data;
  };
}
test(
  "should enforce real SQL attachment permissions reservations leases and UNKNOWN protection",
  {
    timeout: 300_000,
    skip:
      !process.env.LOCAL_ACCESS_DB_URL &&
      "requires the existing owned local stack; never starts Docker",
  },
  async (t) =>
    workflowCase("attachment-ledger", async (f) => {
      const installed = await f.stack.db.query(
        "select to_regclass('chat_attachments_private.images') is not null installed",
      );
      assert.equal(
        installed.rows[0].installed,
        true,
        "Supervisor must apply the additive migration to the isolated stack first",
      );
      const s = await f.directScene("attachment-ledger");
      const client = s.requester.web.dataClient(),
        userRpc = rpc(client);
      const admin = rpc(
        createClient(f.stack.config.api, f.stack.config.adminKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        }),
      );
      const ids: string[] = [],
        removed: string[] = [];
      const storage: ImageStorage = {
        async put() {
          throw new Error("not used");
        },
        async get() {
          throw new Error("not used");
        },
        async remove(id) {
          assert.ok(ids.includes(id));
          removed.push(id);
        },
      };
      const scope = { protocol: 1, roomId: s.scope.roomId, expectedUserId: s.requester.id };
      const body = (bytes = 100) => ({
        ...scope,
        mime: "image/png",
        bytes,
        width: 1,
        height: 1,
        sha256: "a".repeat(64),
      });
      const original = (
        await f.stack.db.query("select * from chat_attachments_private.budget where id=1")
      ).rows[0];
      const month = (
        await f.stack.db.query(
          "select date_trunc('month',clock_timestamp() at time zone 'UTC')::date::text m",
        )
      ).rows[0].m;
      const originalEgress = (
        await f.stack.db.query(
          "select charged_bytes from chat_attachments_private.egress where month=$1",
          [month],
        )
      ).rows[0];
      const count = (
        await f.stack.db.query("select count(*)::int n from chat_attachments_private.images")
      ).rows[0].n;
      assert.equal(count, 0, "Resource boundary tests require an empty isolated image ledger");
      const clearCleanupLease = () =>
        f.stack.db.query(
          "update chat_attachments_private.budget set cleanup_until=clock_timestamp()-interval '1 second' where id=1",
        );
      async function reserve(bytes = 100) {
        const result = (await userRpc("chat_attachment_reserve", { p_body: body(bytes) })) as {
          attachmentId: string;
        };
        assert.ok(result.attachmentId);
        ids.push(result.attachmentId);
        return result.attachmentId;
      }
      async function attach(id: string, requestId: string | null = null) {
        await admin("chat_attachment_finalize", { p_id: id });
        let eventId: string;
        if (requestId) {
          eventId = (
            await f.stack.db.query(
              "select event_id from public.workflow_events where request_id=$1 and kind='QUESTION' and sender_kind='HUMAN' order by sequence limit 1",
              [requestId],
            )
          ).rows[0].event_id;
        } else {
          const text = `synthetic image ${randomUUID()}`;
          assert.equal(
            (
              await f.human(s.requester, "speak", {
                roomId: s.scope.roomId,
                operationId: randomUUID(),
                publicText: text,
              })
            ).status,
            200,
          );
          eventId = (
            await f.stack.db.query(
              "select event_id from public.workflow_events where room_id=$1 and public_text=$2",
              [s.scope.roomId, text],
            )
          ).rows[0].event_id;
        }
        await f.stack.db.query("select chat_attachments_private.publish($1,$2,$3,$4,$5)", [
          id,
          s.scope.roomId,
          s.requester.id,
          eventId,
          requestId,
        ]);
        return eventId;
      }
      try {
        await t.test(
          "should deny foreign sessions observers and direct table or privileged RPC access",
          async () => {
            for (const person of [s.observer, s.outsider]) {
              await assert.rejects(
                rpc(person.web.dataClient())("chat_attachment_authorize_upload", {
                  p_body: { ...scope, expectedUserId: person.id },
                }),
                /FORBIDDEN/,
              );
            }
            await assert.rejects(
              userRpc("chat_attachment_authorize_upload", {
                p_body: { ...scope, expectedUserId: s.owner.id },
              }),
              /FORBIDDEN/,
            );
            const privileges = (
              await f.stack.db.query(
                "select has_schema_privilege('authenticated','chat_attachments_private','USAGE') access, has_function_privilege('authenticated','public.chat_attachment_finalize(uuid)','EXECUTE') finalize, has_function_privilege('anon','public.chat_attachment_cleanup_claim(integer)','EXECUTE') cleanup",
              )
            ).rows[0];
            assert.deepEqual(privileges, { access: false, finalize: false, cleanup: false });
          },
        );
        await t.test(
          "should serialize concurrent upload reservations at the 75 percent threshold",
          async () => {
            await f.stack.db.query(
              "update chat_attachments_private.budget set storage_limit=524288,cleaning=false where id=1",
            );
            const results = (await Promise.all([
              userRpc("chat_attachment_reserve", { p_body: body(250000) }),
              userRpc("chat_attachment_reserve", { p_body: body(250000) }),
            ])) as { attachmentId?: string; needsCleanup?: boolean }[];
            for (const result of results) if (result.attachmentId) ids.push(result.attachmentId);
            assert.equal(results.filter((r) => r.attachmentId).length, 1);
            assert.equal(results.filter((r) => r.needsCleanup).length, 1);
            assert.equal(
              Number(
                (
                  await f.stack.db.query(
                    "select charged_bytes from chat_attachments_private.budget where id=1",
                  )
                ).rows[0].charged_bytes,
              ),
              250000,
            );
            await f.stack.db.query(
              "update chat_attachments_private.images set created_at=clock_timestamp()-interval '2 hours' where id=any($1::uuid[])",
              [ids],
            );
            assert.equal((await cleanupImages(admin, storage)).deleted, 1);
            await clearCleanupLease();
            await f.stack.db.query(
              "update chat_attachments_private.budget set storage_limit=1000000000,cleaning=false where id=1",
            );
          },
        );
        await t.test(
          "should protect fresh images UNKNOWN requests and live download leases",
          async () => {
            const fresh = await reserve();
            await attach(fresh);
            const orphan = await reserve();
            const ready = await reserve();
            await admin("chat_attachment_finalize", { p_id: ready });
            const admission = await f.ask(s),
              attempt = await f.run(s.responder, admission.requestId!);
            const unknown = await reserve();
            await attach(unknown, admission.requestId!);
            const deviceBody = {
              protocol: 1,
              attachmentId: unknown,
              agentId: s.responder.agentId,
              bindingEpoch: await f.epoch(s.responder),
              requestId: admission.requestId,
              attemptId: attempt.attemptId,
              fence: attempt.fence,
              imageInputVersion: 1,
            };
            const anon = rpc(
              createClient(f.stack.config.api, f.stack.config.key, {
                auth: { persistSession: false },
              }),
            );
            const deviceGrant = (await anon("chat_attachment_device_download", {
              p_body: deviceBody,
              p_secret: s.responder.credential,
            })) as { leaseId: string };
            assert.ok(deviceGrant.leaseId);
            for (const patch of [
              { attachmentId: fresh },
              { attemptId: randomUUID() },
              { requestId: randomUUID() },
              { fence: attempt.fence + 1 },
              { bindingEpoch: deviceBody.bindingEpoch + 1 },
            ]) {
              await assert.rejects(
                anon("chat_attachment_device_download", {
                  p_body: { ...deviceBody, ...patch },
                  p_secret: s.responder.credential,
                }),
                /FORBIDDEN/,
              );
            }
            await reserve(350000);
            await f.stack.db.query(
              "update chat_attachments_private.budget set storage_limit=524288 where id=1",
            );
            await f.stack.db.query(
              "update workflow_private.requests set state='UNKNOWN' where id=$1",
              [admission.requestId],
            );
            await f.stack.db.query(
              "update workflow_private.attempts set state='UNKNOWN' where id=$1",
              [attempt.attemptId],
            );
            await f.stack.db.query(
              "update chat_attachments_private.images set attached_at=clock_timestamp()-interval '25 hours' where id=$1",
              [unknown],
            );
            await f.stack.db.query(
              "update chat_attachments_private.budget set cleaning=true where id=1",
            );
            assert.equal((await cleanupImages(admin, storage)).deleted, 0);
            assert.equal(removed.includes(unknown), false);
            assert.equal(removed.includes(orphan), false);
            assert.equal(removed.includes(fresh), false);
            await clearCleanupLease();
            await f.stack.db.query(
              "update chat_attachments_private.images set attached_at=clock_timestamp()-interval '25 hours' where id=$1",
              [fresh],
            );
            const grant = (await userRpc("chat_attachment_user_download", {
              p_body: { ...scope, attachmentId: fresh },
            })) as { leaseId: string };
            await assert.rejects(
              rpc(s.outsider.web.dataClient())("chat_attachment_user_download", {
                p_body: { ...scope, expectedUserId: s.outsider.id, attachmentId: fresh },
              }),
              /FORBIDDEN/,
            );
            await f.stack.db.query(
              "update chat_attachments_private.images set created_at=clock_timestamp()-interval '2 hours' where id=$1",
              [orphan],
            );
            assert.equal((await cleanupImages(admin, storage)).deleted, 1);
            assert.ok(removed.includes(orphan));
            assert.equal(removed.includes(fresh), false);
            await clearCleanupLease();
            await f.stack.db.query(
              "update chat_attachments_private.download_leases set expires_at=clock_timestamp()-interval '1 second' where id=$1",
              [grant.leaseId],
            );
            await assert.rejects(
              anon("chat_attachment_device_download", {
                p_body: deviceBody,
                p_secret: s.responder.credential,
              }),
              /FORBIDDEN/,
            );
            // READY is never publishable after cleanup has selected it.
            await f.stack.db.query(
              "update chat_attachments_private.images set created_at=clock_timestamp()-interval '2 hours' where id=$1",
              [ready],
            );
            const selected = (await admin("chat_attachment_cleanup_claim", { p_limit: 32 })) as {
              attachmentIds: string[];
            };
            assert.ok(selected.attachmentIds.includes(ready));
            assert.ok(selected.attachmentIds.includes(fresh));
            await assert.rejects(admin("chat_attachment_finalize", { p_id: ready }), /CONFLICT/);
            assert.equal(selected.attachmentIds.includes(unknown), false);
            await clearCleanupLease();
            await f.stack.db.query(
              "delete from chat_attachments_private.download_leases where attachment_id=$1",
              [unknown],
            );
            // Simulate a retained attachment with a missing request without
            // violating the DIRECT cycle's exactly-one-request graph constraint.
            const missingRequestId = randomUUID();
            await f.stack.db.query(
              "update chat_attachments_private.images set request_id=$1 where id=$2 and room_id=$3",
              [missingRequestId, unknown, s.scope.roomId],
            );
            assert.equal(
              (
                await f.stack.db.query(
                  "select count(*)::int n from workflow_private.requests where id=$1",
                  [missingRequestId],
                )
              ).rows[0].n,
              0,
            );
            const missingRequest = (await admin("chat_attachment_cleanup_claim", {
              p_limit: 32,
            })) as { attachmentIds: string[] };
            assert.equal(missingRequest.attachmentIds.includes(unknown), false);
          },
        );
        await t.test("should atomically cap egress across concurrent downloads", async () => {
          await f.stack.db.query(
            "update chat_attachments_private.budget set storage_limit=1000000000,cleaning=false where id=1",
          );
          const live = await reserve();
          await attach(live);
          await f.stack.db.query(
            "insert into chat_attachments_private.egress(month,charged_bytes) values($1,1999999900) on conflict(month) do update set charged_bytes=excluded.charged_bytes",
            [month],
          );
          const result = await Promise.allSettled([
            userRpc("chat_attachment_user_download", {
              p_body: { ...scope, attachmentId: live },
            }),
            userRpc("chat_attachment_user_download", {
              p_body: { ...scope, attachmentId: live },
            }),
          ]);
          assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
          assert.equal(result.filter((r) => r.status === "rejected").length, 1);
          assert.equal(
            Number(
              (
                await f.stack.db.query(
                  "select charged_bytes from chat_attachments_private.egress where month=$1",
                  [month],
                )
              ).rows[0].charged_bytes,
            ),
            2000000000,
          );
        });
      } finally {
        // No real Storage object was created. Remove only this fixture's fake objects.
        await f.stack.db.query(
          "delete from chat_attachments_private.download_leases where attachment_id=any($1::uuid[])",
          [ids],
        );
        await f.stack.db.query(
          "delete from chat_attachments_private.images where id=any($1::uuid[])",
          [ids],
        );
        await f.stack.db.query(
          "update chat_attachments_private.budget set storage_limit=$1,charged_bytes=$2,cleaning=$3,cleanup_lease=$4,cleanup_until=$5 where id=1",
          [
            original.storage_limit,
            original.charged_bytes,
            original.cleaning,
            original.cleanup_lease,
            original.cleanup_until,
          ],
        );
        await f.stack.db.query("delete from chat_attachments_private.egress where month=$1", [
          month,
        ]);
        if (originalEgress)
          await f.stack.db.query(
            "insert into chat_attachments_private.egress(month,charged_bytes) values($1,$2)",
            [month, originalEgress.charged_bytes],
          );
      }
    }),
);
