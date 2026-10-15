import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { workflowCase, type WorkflowFixture } from "../helpers/workflow-fixture.js";
import { RuntimeSettingsFixture } from "../helpers/runtime-settings-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";
import { readConnectionSelection } from "../../src/features/device-binding/local-connection-command.ts";
const options = { timeout: 300000 };
async function installed(f: WorkflowFixture) {
  await assertOwnedStack(f.stack.config);
  const result = await f.stack.db.query(
    "select to_regprocedure('public.connection_setup_device(text,jsonb,text)') is not null installed",
  );
  assert.equal(
    result.rows[0].installed,
    true,
    "Parent must explicitly apply SQL021 to the owned isolated stack",
  );
}
async function publicCall(f: WorkflowFixture, action: string, body: unknown, key?: string) {
  const r = await fetch(`${f.stack.config.app}/api/connection-setup/${action}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}
async function human(
  person: { web: { post: (path: string, body: unknown) => Promise<Response> } },
  action: string,
  body: unknown,
) {
  const r = await person.web.post(`/api/connection-setup/${action}`, body);
  return { status: r.status, data: await r.json() };
}
test(
  "should issue replay-safe hashed tickets and fix startup tracking to the first attempt",
  options,
  () =>
    workflowCase("setup-ticket", async (f) => {
      await installed(f);
      const scene = await f.directScene();
      const selection = await readConnectionSelection(
        null,
        f.stack.config.app,
        scene.owner.id,
        scene.scope.roomId,
      );
      const body = {
        requestId: randomUUID(),
        roomId: scene.scope.roomId,
        deviceAlias: "검증 Mac",
        selection,
      };
      assert.equal((await publicCall(f, "issue", body)).status, 403);
      assert.equal(
        (
          await publicCall(f, "inspect", {
            roomId: scene.scope.roomId,
            requestId: null,
            deviceId: null,
          })
        ).status,
        403,
      );
      const issued = await human(scene.owner, "issue", body);
      assert.equal(issued.status, 200);
      const ticket = issued.data.data;
      assert.match(ticket.key, /^[a-f0-9]{64}$/);
      const replay = await human(scene.owner, "issue", body);
      assert.equal(replay.status, 200);
      assert.equal(replay.data.data.key, undefined);
      assert.equal(replay.data.data.reissueRequired, true);
      assert.equal(
        (await human(scene.owner, "issue", { ...body, deviceAlias: "다른 이름" })).status,
        409,
      );
      const stored = await f.stack.db.query(
        "select key_hash,payload,payload_hash from connection_setup_private.tickets where owner_id=$1 and request_id=$2",
        [scene.owner.id, body.requestId],
      );
      assert.equal(stored.rows[0].key_hash, createHash("sha256").update(ticket.key).digest("hex"));
      assert.ok(!JSON.stringify(stored.rows[0]).includes(ticket.key));
      const first = await publicCall(f, "resolve", {}, ticket.key);
      assert.equal(first.status, 200);
      assert.equal(
        first.data.data.payloadHash,
        createHash("sha256").update(first.data.data.payload).digest("hex"),
      );
      assert.equal((await publicCall(f, "resolve", {}, ticket.key)).status, 200);
      const a = randomUUID(),
        b = randomUUID();
      const report = { attemptId: a, sequence: 1, stage: "CONNECTING", reason: null };
      assert.equal((await publicCall(f, "startup-report", report, ticket.key)).status, 200);
      assert.equal((await publicCall(f, "startup-report", report, ticket.key)).status, 200);
      assert.equal(
        (await publicCall(f, "startup-report", { ...report, reason: "UNAVAILABLE" }, ticket.key))
          .status,
        409,
      );
      assert.equal(
        (
          await publicCall(
            f,
            "startup-report",
            { attemptId: b, sequence: 1, stage: "FAILED", reason: "RUNTIME_BUSY" },
            ticket.key,
          )
        ).status,
        200,
      );
      const inspectBody = {
        roomId: scene.scope.roomId,
        requestId: body.requestId,
        deviceId: scene.responder.deviceId,
      };
      const view = await human(scene.owner, "inspect", inspectBody);
      assert.equal(view.status, 200);
      assert.equal(view.data.data.startup.attemptId, a);
      assert.equal(view.data.data.startup.authenticated, false);
      assert.equal(view.data.data.device.authenticated, true);
      assert.equal((await human(scene.requester, "inspect", inspectBody)).status, 404);
      assert.equal((await human(scene.observer, "inspect", inspectBody)).status, 403);
      assert.equal(
        (
          await publicCall(
            f,
            "settings-inspect",
            { deviceId: scene.responder.deviceId, operationId: randomUUID(), configRevision: 0 },
            ticket.key,
          )
        ).status,
        401,
      );
      assert.equal(
        (await publicCall(f, "startup-report", { ...report, sequence: 2 }, ticket.key)).status,
        200,
      );
      assert.equal((await publicCall(f, "startup-report", report, ticket.key)).status, 409);
      assert.equal(
        (
          await publicCall(
            f,
            "startup-report",
            { ...report, sequence: 3, stage: "FAILED", reason: "MACOS_13_5_REQUIRED" },
            ticket.key,
          )
        ).status,
        200,
      );
      for (let n = 0; n < 6; n++)
        assert.equal(
          (
            await publicCall(
              f,
              "startup-report",
              { ...report, attemptId: randomUUID() },
              ticket.key,
            )
          ).status,
          200,
        );
      assert.equal(
        (await publicCall(f, "startup-report", { ...report, attemptId: randomUUID() }, ticket.key))
          .status,
        429,
      );
      await f.stack.db.query(
        "update connection_setup_private.tickets set expires_at=clock_timestamp()-interval '1 second' where owner_id=$1 and request_id=$2",
        [scene.owner.id, body.requestId],
      );
      assert.equal((await publicCall(f, "resolve", {}, ticket.key)).status, 409);
      const retry = await human(scene.owner, "issue", { ...body, requestId: randomUUID() });
      assert.equal(retry.status, 200);
      assert.deepEqual(
        JSON.parse((await publicCall(f, "resolve", {}, retry.data.data.key)).data.data.payload)
          .selection,
        selection,
      );
    }),
);
test("should isolate authenticated settings observations without changing receipts", options, () =>
  workflowCase("setup-observation", async (f) => {
    await installed(f);
    const scene = await f.directScene(),
      r = new RuntimeSettingsFixture(f);
    await r.requireMigration();
    const prepared = await r.prepare(scene.owner, scene.responder);
    const poll = r.accepted(await r.device(scene.responder, "poll", {}));
    const identity = {
      deviceId: scene.responder.deviceId,
      operationId: poll.operation!.operationId,
      configRevision: poll.configRevision,
    };
    const before = await f.stack.db.query(
      "select receipt,selection_body,apply_body from runtime_settings_private.operations where device_id=$1 and operation_id=$2",
      [identity.deviceId, identity.operationId],
    );
    const report = { ...identity, sequence: 1, stage: "MODEL_SELECTION", reason: null };
    assert.equal(
      (await publicCall(f, "settings-inspect", identity, scene.responder.credential)).data.data
        .sequence,
      0,
    );
    assert.equal(
      (await publicCall(f, "settings-report", report, scene.responder.credential)).status,
      200,
    );
    assert.equal(
      (await publicCall(f, "settings-report", report, scene.responder.credential)).status,
      200,
    );
    assert.equal(
      (
        await publicCall(
          f,
          "settings-report",
          { ...report, stage: "FAILED" },
          scene.responder.credential,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await publicCall(
          f,
          "settings-report",
          { ...report, sequence: 2, stage: "APPLYING" },
          scene.responder.credential,
        )
      ).status,
      200,
    );
    assert.equal(
      (await publicCall(f, "settings-report", report, scene.responder.credential)).status,
      409,
    );
    assert.equal(
      (
        await publicCall(
          f,
          "settings-report",
          { ...report, sequence: 3, stderr: "private" },
          scene.responder.credential,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await publicCall(
          f,
          "settings-report",
          { ...report, sequence: 3, reason: "/Users/private" },
          scene.responder.credential,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await publicCall(
          f,
          "settings-report",
          { ...report, operationId: randomUUID() },
          scene.responder.credential,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await publicCall(
          f,
          "settings-report",
          { ...report, configRevision: 1 },
          scene.responder.credential,
        )
      ).status,
      409,
    );
    const other = await f.directScene("other");
    assert.equal(
      (await publicCall(f, "settings-report", report, other.responder.credential)).status,
      403,
    );
    const inspect = { roomId: scene.scope.roomId, requestId: null, deviceId: identity.deviceId };
    assert.equal((await human(scene.owner, "inspect", inspect)).data.data.settings.sequence, 2);
    assert.equal((await human(scene.requester, "inspect", inspect)).status, 403);
    assert.equal(
      (await human(scene.owner, "inspect", { ...inspect, deviceId: other.responder.deviceId }))
        .status,
      403,
    );
    const after = await f.stack.db.query(
      "select receipt,selection_body,apply_body from runtime_settings_private.operations where device_id=$1 and operation_id=$2",
      [identity.deviceId, identity.operationId],
    );
    assert.deepEqual(after.rows, before.rows);
    void prepared;
    const privileges = await f.stack.db.query(
      "select has_table_privilege('anon','connection_setup_private.tickets','SELECT') a,has_table_privilege('authenticated','connection_setup_private.observations','UPDATE') h",
    );
    assert.deepEqual(privileges.rows[0], { a: false, h: false });
    await f.stack.db.query(
      "update device_binding_private.credentials set expires_at=created_at+interval '1 second' where device_id=$1",
      [identity.deviceId],
    );
    assert.equal(
      (await publicCall(f, "settings-inspect", identity, scene.responder.credential)).status,
      401,
    );
  }),
);
test("should enforce membership loss issuance quotas and strict request bodies", options, () =>
  workflowCase("setup-quotas", async (f) => {
    await installed(f);
    const scene = await f.directScene();
    const selection = await readConnectionSelection(
      null,
      f.stack.config.app,
      scene.owner.id,
      scene.scope.roomId,
    );
    const issue = () => ({
      requestId: randomUUID(),
      roomId: scene.scope.roomId,
      deviceAlias: "검증 Mac",
      selection,
    });
    assert.equal((await human(scene.observer, "issue", issue())).status, 403);
    assert.equal((await human(scene.outsider, "issue", issue())).status, 403);
    assert.equal(
      (await human(scene.owner, "issue", { ...issue(), secret: "private" })).status,
      400,
    );
    const first = await human(scene.owner, "issue", issue());
    assert.equal(first.status, 200);
    for (let n = 1; n < 32; n++)
      assert.equal((await human(scene.owner, "issue", issue())).status, 200);
    assert.equal((await human(scene.owner, "issue", issue())).status, 429);
    await f.stack.db.query(
      "update connection_setup_private.tickets set expires_at=clock_timestamp()-interval '1 second' where owner_id=$1",
      [scene.owner.id],
    );
    let lastKey = "";
    for (let n = 32; n < 128; n++) {
      await f.stack.db.query(
        "update connection_setup_private.tickets set expires_at=clock_timestamp()-interval '1 second' where owner_id=$1",
        [scene.owner.id],
      );
      const next = await human(scene.owner, "issue", issue());
      assert.equal(next.status, 200);
      lastKey = next.data.data.key;
    }
    assert.equal((await human(scene.owner, "issue", issue())).status, 429);
    await f.stack.db.query(
      "update public.room_members set status='removed' where room_id=$1 and user_id=$2",
      [scene.scope.roomId, scene.owner.id],
    );
    assert.equal((await publicCall(f, "resolve", {}, lastKey)).status, 403);
    const malformed = await fetch(`${f.stack.config.app}/api/connection-setup/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${first.data.data.key}`,
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);
  }),
);
