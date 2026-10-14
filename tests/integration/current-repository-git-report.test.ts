import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { workflowCase, type WorkflowFixture } from "../helpers/workflow-fixture.js";
import { RuntimeSettingsFixture } from "../helpers/runtime-settings-fixture.js";
import { assertOwnedStack, type FixturePerson } from "../helpers/local-access-stack.js";
import type { DeviceProfile } from "../helpers/device-binding-fixture.js";
import { projectResponse } from "../../src/features/device-binding/contracts.ts";
import { projectRoomGitBindings } from "../../src/features/device-binding/room-git-report.ts";
const options = { timeout: 300000 };
async function installed(f: WorkflowFixture) {
  await assertOwnedStack(f.stack.config);
  const r = await f.stack.db.query(
    "select to_regprocedure('public.connector_git_report(jsonb,text)') is not null installed",
  );
  assert.equal(
    r.rows[0].installed,
    true,
    "Parent must install the reviewed migration before running integration",
  );
  const settings = new RuntimeSettingsFixture(f);
  await settings.requireMigration();
  return settings;
}
async function apply(
  settings: RuntimeSettingsFixture,
  owner: FixturePerson,
  device: DeviceProfile,
) {
  const intent = await settings.prepare(owner, device);
  settings.accepted(await settings.human(owner, "apply", intent.apply));
  const committed = settings.accepted(await settings.device(device, "receipt", intent.commit))
    .operation!.receipt!;
  settings.accepted(await settings.device(device, "receipt", { ...committed, state: "APPLIED" }));
  return committed;
}
function body(receipt: Awaited<ReturnType<typeof apply>>, changes: Record<string, unknown> = {}) {
  return {
    agentId: receipt.agentId!,
    workspaceId: receipt.workspaceId!,
    bindingEpoch: receipt.bindingEpoch!,
    configRevision: receipt.configRevision,
    branch: "dev",
    commit: "a".repeat(40),
    observedAt: new Date(Date.now() - 1000).toISOString(),
    ...changes,
  };
}
async function anon(f: WorkflowFixture, name: string, params: unknown) {
  await assertOwnedStack(f.stack.config);
  const response = await fetch(`${f.stack.config.api}/rest/v1/rpc/${name}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { apikey: f.stack.config.key, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return { status: response.status, data: (await response.json()) as Record<string, unknown> };
}
async function room(person: FixturePerson, roomId: string) {
  const r = await person.web
    .dataClient()
    .rpc("connection_room_git_bindings", { p_room_id: roomId });
  assert.equal(r.error, null);
  return projectRoomGitBindings(r.data);
}
const report = (f: WorkflowFixture, p: DeviceProfile, b: unknown, credential = p.credential) =>
  f.devices.request("git-report", b, credential);
const rejected = (r: { status: number; data: Record<string, unknown> }, code: string) => {
  assert.ok(r.status >= 400);
  assert.equal(r.data.code, "P0001");
  assert.equal(r.data.message, code);
};

test(
  "should accept current reports preserve legacy API and enforce clock ordering direct RPC validation and private ACL",
  options,
  () =>
    workflowCase("git-report-current", async (f) => {
      const settings = await installed(f),
        s = await f.directScene(),
        receipt = await apply(settings, s.owner, s.responder);
      const old = (await f.devices.request("bindings", {}, s.responder.credential)).data.data;
      assert.deepEqual(projectResponse("bindings", old, true), old);
      const oldRoom = await s.owner.web
        .dataClient()
        .rpc("connection_room_bindings", { p_room_id: s.scope.roomId });
      assert.equal(oldRoom.error, null);
      const readiness = await f.stack.db.query(
        "select * from workflow_private.readiness where device_id=$1",
        [s.responder.deviceId],
      );
      const b = body(receipt);
      assert.deepEqual((await report(f, s.responder, b)).data, {
        ok: true,
        data: { protocol: 1, reported: true },
      });
      const first = (await room(s.owner, s.scope.roomId))[0].gitReport!;
      assert.equal(first.branch, "dev");
      assert.equal(first.commit, b.commit);
      assert.equal(first.observedAt, b.observedAt);
      assert.ok(Date.parse(first.receivedAt) >= Date.parse(first.observedAt));
      assert.equal(first.stale, false);
      assert.equal((await report(f, s.responder, b)).status, 200);
      assert.equal(
        (await room(s.owner, s.scope.roomId))[0].gitReport!.receivedAt,
        first.receivedAt,
      );
      assert.equal((await report(f, s.responder, { ...b, branch: "main" })).status, 409);
      assert.equal(
        (
          await report(f, s.responder, {
            ...b,
            observedAt: new Date(Date.parse(b.observedAt) - 1).toISOString(),
          })
        ).status,
        409,
      );
      assert.equal((await room(s.owner, s.scope.roomId))[0].gitReport!.branch, "dev");
      for (const observedAt of [
        new Date(Date.now() - 301000).toISOString(),
        new Date(Date.now() + 61000).toISOString(),
      ])
        assert.equal((await report(f, s.responder, { ...b, observedAt })).status, 409);
      for (const branch of ["../secret", "feature//bad", "feature.lock", "/private", "dev.", ""]) {
        rejected(
          await anon(f, "connector_git_report", {
            p_body: { ...b, branch },
            p_secret: s.responder.credential,
          }),
          "INVALID_BODY",
        );
      }
      for (const bad of [
        { ...b, commit: "A".repeat(40) },
        { ...b, configRevision: 0 },
        { ...b, bindingEpoch: 9007199254740992 },
        { ...b, observedAt: "2026-02-30T00:00:00.000Z" },
        { ...b, root: "/private" },
      ])
        rejected(
          await anon(f, "connector_git_report", { p_body: bad, p_secret: s.responder.credential }),
          "INVALID_BODY",
        );
      const newer = {
        ...b,
        commit: "c".repeat(64),
        observedAt: new Date(Date.parse(b.observedAt) + 1).toISOString(),
      };
      assert.equal((await report(f, s.responder, newer)).status, 200);
      assert.equal(
        (
          await report(f, s.responder, {
            ...newer,
            branch: "unknown",
            commit: "unknown",
            observedAt: new Date(Date.parse(b.observedAt) + 2).toISOString(),
          })
        ).status,
        200,
      );
      assert.equal((await room(s.observer, s.scope.roomId))[0].gitReport!.commit, "unknown");
      const after = (await f.devices.request("bindings", {}, s.responder.credential)).data.data;
      assert.deepEqual(after, old);
      assert.deepEqual(projectResponse("bindings", after, true), old);
      const afterRoom = await s.owner.web
        .dataClient()
        .rpc("connection_room_bindings", { p_room_id: s.scope.roomId });
      assert.deepEqual(afterRoom.data, oldRoom.data);
      const heartbeat = (await f.devices.request("heartbeat", {}, s.responder.credential)).data
        .data as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(heartbeat).sort(),
        ["protocol", "state", "verification", "lastSeenAt"].sort(),
      );
      assert.deepEqual(projectResponse("heartbeat", heartbeat, true), heartbeat);
      assert.deepEqual(
        (
          await f.stack.db.query("select * from workflow_private.readiness where device_id=$1", [
            s.responder.deviceId,
          ])
        ).rows,
        readiness.rows,
      );
      const nonparticipant = await s.outsider.web
        .dataClient()
        .rpc("connection_room_git_bindings", { p_room_id: s.scope.roomId });
      assert.equal(nonparticipant.error?.message, "NOT_FOUND");
      assert.ok(
        (await anon(f, "connection_room_git_bindings", { p_room_id: s.scope.roomId })).status >=
          400,
      );
      assert.ok(
        (
          await s.owner.web
            .dataClient()
            .rpc("connector_git_report", { p_body: b, p_secret: s.responder.credential })
        ).error,
      );
      for (const role of ["anon", "authenticated"]) {
        await f.stack.db.query("begin");
        try {
          await f.stack.db.query(`set local role ${role}`);
          await assert.rejects(
            f.stack.db.query("select * from runtime_settings_private.git_reports"),
            { code: "42501" },
          );
        } finally {
          await f.stack.db.query("rollback");
        }
      }
    }),
);

test(
  "should fence epochs revisions and unfinished settings across replacement of the same workspace",
  options,
  () =>
    workflowCase("git-report-fencing", async (f) => {
      const settings = await installed(f),
        s = await f.directScene(),
        receipt = await apply(settings, s.owner, s.responder),
        b = body(receipt);
      assert.equal((await report(f, s.responder, b)).status, 200);
      for (const patch of [
        { bindingEpoch: b.bindingEpoch - 1 },
        { bindingEpoch: b.bindingEpoch + 1 },
        { configRevision: b.configRevision + 1 },
      ])
        assert.equal((await report(f, s.responder, { ...b, ...patch })).status, 409);
      const i = await settings.prepare(s.owner, s.responder);
      // LOCAL_CONFIRMATION is nonterminal even though the old current pointer still exists.
      assert.equal((await report(f, s.responder, body(receipt))).status, 409);
      settings.accepted(await settings.human(s.owner, "apply", i.apply));
      assert.equal((await report(f, s.responder, body(receipt))).status, 409);
      const committed = settings.accepted(await settings.device(s.responder, "receipt", i.commit))
        .operation!.receipt!;
      assert.equal(committed.workspaceId, receipt.workspaceId);
      assert.equal(committed.bindingEpoch, receipt.bindingEpoch! + 1);
      assert.equal((await room(s.owner, s.scope.roomId))[0].gitReport, null);
      assert.equal((await report(f, s.responder, body(committed))).status, 409);
      settings.accepted(
        await settings.device(s.responder, "receipt", { ...committed, state: "APPLIED" }),
      );
      assert.equal((await report(f, s.responder, body(receipt))).status, 409);
      assert.equal((await report(f, s.responder, body(committed, { branch: "main" }))).status, 200);
      assert.equal((await room(s.owner, s.scope.roomId))[0].gitReport!.branch, "main");
      const scope = await f.stack.db.query(
        "select binding_epoch,state,verification from device_binding_private.agents where id=$1",
        [committed.agentId],
      );
      assert.equal(Number(scope.rows[0].binding_epoch), committed.bindingEpoch);
      // Exercise every SQL predicate state without invoking native AI or external services.
      const originalApplied = settings.accepted(
        await settings.human(s.owner, "list", { deviceId: s.responder.deviceId! }),
      ).applied!;
      for (const patch of [
        { agentId: randomUUID() },
        { workspaceId: randomUUID() },
        { bindingEpoch: committed.bindingEpoch! + 1 },
        { configRevision: committed.configRevision + 1 },
      ]) {
        await assertOwnedStack(f.stack.config);
        await f.stack.db.query(
          "update runtime_settings_private.configurations set applied=$2::jsonb where device_id=$1",
          [s.responder.deviceId, JSON.stringify({ ...originalApplied, ...patch })],
        );
        assert.equal((await report(f, s.responder, body(committed))).status, 409);
        assert.equal((await room(s.owner, s.scope.roomId))[0].gitReport, null);
      }
      await f.stack.db.query(
        "update runtime_settings_private.configurations set applied=$2::jsonb where device_id=$1",
        [s.responder.deviceId, JSON.stringify(originalApplied)],
      );
      const pending = await settings.prepare(s.owner, s.responder);
      for (const state of [
        "REQUESTED",
        "LOCAL_CONFIRMATION",
        "APPLYING",
        "COMMITTED",
        "FAILED",
        "UNKNOWN",
        "CANCELLED",
      ]) {
        await assertOwnedStack(f.stack.config);
        assert.equal(f.devices.profiles.has(s.responder.name), true);
        await f.stack.db.query(
          "update runtime_settings_private.operations set state=$3,applied_receipt=null where device_id=$1 and operation_id=$2",
          [s.responder.deviceId, pending.base.operationId, state],
        );
        assert.equal((await report(f, s.responder, body(committed))).status, 409);
      }
    }),
);

test(
  "should reject foreign device owner room agent workspace old credentials revoked removed and deleted scopes",
  options,
  () =>
    workflowCase("git-report-authority", async (f) => {
      const settings = await installed(f),
        s = await f.directScene("one"),
        other = await f.directScene("two");
      const receipt = await apply(settings, s.owner, s.responder),
        b = body(receipt);
      const foreign = await apply(settings, other.owner, other.responder);
      assert.equal(
        (
          await report(f, s.responder, {
            ...b,
            agentId: foreign.agentId,
            workspaceId: foreign.workspaceId,
          })
        ).status,
        404,
      );
      assert.equal((await report(f, other.responder, b)).status, 404);
      assert.equal((await report(f, s.responder, { ...b, workspaceId: randomUUID() })).status, 404);
      assert.equal((await report(f, s.responder, { ...b, agentId: randomUUID() })).status, 404);
      assert.equal((await f.devices.request("git-report", b)).status, 401);
      assert.equal((await report(f, s.responder, b, "a".repeat(64))).status, 401);
      const old = s.responder.credential!,
        fresh = randomBytes(32).toString("hex"),
        credentialHash = createHash("sha256").update(fresh).digest("hex");
      f.devices.hashes.add(credentialHash);
      await f.devices.saveCleanupIdentity();
      assert.equal(
        (await f.devices.request("rotate", { operationId: randomUUID(), credentialHash }, old))
          .status,
        200,
      );
      s.responder.credential = fresh;
      await f.devices.saveCleanupIdentity();
      rejected(
        await anon(f, "connector_git_report", { p_body: b, p_secret: old }),
        "UNAUTHENTICATED",
      );
      assert.equal((await report(f, s.responder, body(receipt))).status, 200);
      assert.equal(
        (await f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId })).status,
        200,
      );
      assert.equal((await report(f, s.responder, body(receipt))).status, 401);
      assert.equal(
        (await f.devices.human(s.owner, "remove", { deviceId: s.responder.deviceId })).status,
        200,
      );
      assert.equal((await report(f, s.responder, body(receipt))).status, 401);
      assert.equal(
        (await room(s.owner, s.scope.roomId)).some(
          (binding) => binding.agentId === receipt.agentId,
        ),
        false,
      );
      const reportCount = async () =>
        (
          await f.stack.db.query(
            "select count(*)::int count from runtime_settings_private.git_reports where agent_id=$1",
            [receipt.agentId],
          )
        ).rows[0].count;
      // Removal revokes the binding; only physical deletion runs the FK cleanup.
      assert.equal(await reportCount(), 1);
      await f.devices.cleanupPairing(s.responder.name);
      assert.equal(await reportCount(), 0);
      assert.equal((await report(f, other.responder, body(foreign))).status, 200);
      await f.stack.disable(other.owner);
      assert.equal((await report(f, other.responder, body(foreign))).status, 401);
    }),
);
