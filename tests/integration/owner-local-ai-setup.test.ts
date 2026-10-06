import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { workflowCase, type WorkflowFixture } from "../helpers/workflow-fixture.js";
import { RuntimeSettingsFixture, settingsCatalog } from "../helpers/runtime-settings-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";
import type { Receipt } from "../../src/features/runtime-settings/contracts.ts";
const options = { timeout: 300000 };
async function settings(f: WorkflowFixture) {
  const s = new RuntimeSettingsFixture(f);
  await s.requireMigration();
  return s;
}
test("should expose the existing owner binding before any settings receipt", options, () =>
  workflowCase("settings-current-binding", async (f) => {
    const r = await settings(f),
      s = await f.directScene();
    const response = r.accepted(await r.human(s.owner, "list", { deviceId: s.responder.deviceId }));
    assert.equal(response.applied, null);
    assert.deepEqual(response.currentBinding, {
      agentId: s.responder.agentId,
      workspaceId: s.responder.workspaceId,
      bindingEpoch: 1,
      runtime: "codex",
    });
    const intent = await r.prepare(s.owner, s.responder);
    assert.equal(intent.apply.expectedEpoch, response.currentBinding!.bindingEpoch);
  }),
);
test(
  "should retain every pre-apply cancelled folder operation until exact device cleanup",
  options,
  () =>
    workflowCase("settings-folder-cancel", async (f) => {
      const r = await settings(f);
      for (const stage of ["REQUESTED", "LOCAL_CONFIRMATION", "UNKNOWN", "FAILED"] as const) {
        const s = await f.directScene(`folder-${stage}`);
        const base = {
          operationId: randomUUID(),
          deviceId: s.responder.deviceId!,
          expectedConfigRevision: 0,
          runtime: "claude",
        };
        r.accepted(await r.human(s.owner, "select-folder", base));
        const local: Receipt = {
          operationId: base.operationId,
          state: "LOCAL_CONFIRMATION",
          configRevision: 0,
          runtime: "claude",
          model: null,
          effort: null,
          snapshotHash: null,
          localRootReference: stage === "REQUESTED" ? null : randomUUID(),
          repositoryAlias: stage === "REQUESTED" ? null : "공유 저장소",
          sessionAlias: null,
          catalog: settingsCatalog(),
          bindingEpoch: null,
          agentId: null,
          workspaceId: null,
        };
        if (stage !== "REQUESTED") r.accepted(await r.device(s.responder, "receipt", local));
        if (stage === "UNKNOWN" || stage === "FAILED")
          r.accepted(
            await r.device(s.responder, "receipt", { ...local, state: stage, catalog: null }),
          );
        r.accepted(
          await r.human(s.owner, "cancel", {
            operationId: base.operationId,
            deviceId: base.deviceId,
          }),
        );
        assert.equal(
          r.accepted(await r.device(s.responder, "poll", {})).operation!.state,
          "CANCELLED",
        );
        const next = { ...base, operationId: randomUUID() };
        assert.equal((await r.human(s.owner, "select-folder", next)).status, 409);
        const cleanup = { ...local, state: "CANCELLED" as const, catalog: null };
        assert.equal(
          (await r.device(s.responder, "receipt", { ...cleanup, runtime: "codex" })).status,
          409,
        );
        if (stage !== "REQUESTED")
          assert.equal(
            (
              await r.device(s.responder, "receipt", {
                ...cleanup,
                localRootReference: randomUUID(),
              })
            ).status,
            409,
          );
        r.accepted(await r.device(s.responder, "receipt", cleanup));
        assert.equal(r.accepted(await r.device(s.responder, "poll", {})).operation, null);
        const exact = r.accepted(
          await r.device(s.responder, "poll", { operationId: base.operationId }),
        );
        assert.equal(exact.operation!.state, "CANCELLED");
        assert.deepEqual(exact.operation!.receipt, cleanup);
        assert.deepEqual(
          r.accepted(
            await r.human(s.owner, "list", {
              deviceId: base.deviceId,
              operationId: base.operationId,
            }),
          ).operation,
          exact.operation,
        );
        r.accepted(await r.human(s.owner, "select-folder", next));
      }
    }),
);

test("should reject every foreign owner device and stale body replay", options, () =>
  workflowCase("settings-owner", async (f) => {
    const r = await settings(f),
      s = await f.scene();
    const intent = await r.prepare(s.peer, s.responder);
    for (const person of [s.owner, s.observer, s.outsider]) {
      assert.equal((await r.human(person, "list", { deviceId: s.responder.deviceId })).status, 403);
      assert.equal(
        (
          await r.human(person, "list", {
            deviceId: s.responder.deviceId,
            operationId: intent.base.operationId,
          })
        ).status,
        403,
      );
    }
    assert.equal(
      r.accepted(
        await r.device(s.origin, "poll", {
          operationId: intent.base.operationId,
        }),
      ).operation,
      null,
    );
    assert.equal((await r.human(s.owner, "select-folder", intent.base)).status, 403);
    assert.equal(
      (await r.human(s.peer, "select-folder", { ...intent.base, runtime: "codex" })).status,
      409,
    );
    assert.equal(
      (await r.human(s.peer, "select-runtime", { ...intent.selected, runtime: "codex" })).status,
      409,
    );
    assert.equal(
      (await r.device(s.responder, "receipt", { ...intent.local, runtime: "codex" })).status,
      409,
    );
    assert.equal(
      (await r.human(s.peer, "select-folder", { ...intent.base, expectedConfigRevision: 1 }))
        .status,
      409,
    );
    assert.equal(
      (await r.human(s.peer, "select-folder", { ...intent.base, operationId: randomUUID() }))
        .status,
      409,
    );
    assert.equal((await r.device(s.origin, "receipt", intent.local)).status, 404);
    assert.equal(
      (await r.human(s.peer, "apply", { ...intent.apply, snapshotHash: "a".repeat(64) })).status,
      409,
    );
    const removed = await s.owner.web.mutate("revoke-room-member", {
      roomId: s.scope.roomId,
      userId: s.peer.id,
    });
    assert.equal(removed.removed, true);
    assert.equal((await r.device(s.responder, "poll", {})).status, 401);
    assert.equal((await r.human(s.peer, "apply", intent.apply)).status, 403);
  }),
);

test(
  "should commit binding and receipt atomically and recover after 121 seconds and credential rotation",
  options,
  () =>
    workflowCase("settings-commit", async (f) => {
      const r = await settings(f),
        s = await f.directScene(),
        i = await r.prepare(s.owner, s.responder);
      r.accepted(await r.human(s.owner, "apply", i.apply));
      const committed = r.accepted(await r.device(s.responder, "receipt", i.commit));
      assert.equal(committed.operation?.state, "COMMITTED");
      assert.equal(committed.applied, null);
      assert.equal(await f.epoch(s.responder), 2);
      const exact = committed.operation!.receipt!;
      assert.equal(exact.runtime, "claude");
      assert.equal(exact.effort, null);
      assert.equal(exact.bindingEpoch, 2);
      const database = await f.stack.db.query(
        "select a.runtime,a.binding_epoch,c.revision,o.state,o.committed_receipt from runtime_settings_private.operations o join runtime_settings_private.configurations c using(device_id) join device_binding_private.agents a on a.id=o.agent_id where o.device_id=$1 and o.operation_id=$2",
        [s.responder.deviceId, i.base.operationId],
      );
      assert.equal(database.rows[0].runtime, "claude");
      assert.equal(database.rows[0].state, "COMMITTED");
      assert.deepEqual(database.rows[0].committed_receipt, exact);
      await r.expireCommit(s.responder, i.base.operationId);
      await f.stack.db.query(
        "update device_binding_private.agents set replacement_completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and device_id=$2 and replacement_operation=$3",
        [s.responder.agentId, s.responder.deviceId, i.base.operationId],
      );
      assert.deepEqual(
        r.accepted(await r.device(s.responder, "receipt", i.commit)).operation!.receipt,
        exact,
      );
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
      assert.equal((await r.device(s.responder, "poll", {}, old)).status, 401);
      assert.deepEqual(
        r.accepted(await r.device(s.responder, "receipt", i.commit)).operation!.receipt,
        exact,
      );
      assert.equal(
        (
          await r.human(s.owner, "cancel", {
            operationId: i.base.operationId,
            deviceId: s.responder.deviceId,
          })
        ).status,
        409,
      );
      const applied = { ...exact, state: "APPLIED" as const };
      r.accepted(await r.device(s.responder, "receipt", applied));
      assert.equal(r.accepted(await r.device(s.responder, "poll", {})).operation, null);
      assert.deepEqual(
        r.accepted(
          await r.device(s.responder, "poll", {
            operationId: i.base.operationId,
          }),
        ).operation!.receipt,
        applied,
      );
      assert.deepEqual(
        r.accepted(await r.human(s.owner, "list", { deviceId: s.responder.deviceId })).applied,
        applied,
      );
      assert.equal((await f.ready(s.responder)).status, 200);
    }),
);

test(
  "should register an unprepared first owned binding through the commit transaction",
  options,
  () =>
    workflowCase("settings-first", async (f) => {
      const r = await settings(f),
        s = await f.directScene();
      const p = await f.devices.connected(s.requester, s.scope, "first-settings");
      const i = await r.prepare(s.requester, p);
      r.accepted(await r.human(s.requester, "apply", i.apply));
      const result = r.accepted(await r.device(p, "receipt", i.commit));
      assert.ok(result.operation!.receipt!.agentId);
      assert.equal(result.operation!.receipt!.bindingEpoch, 1);
      const proof = await f.stack.db.query(
        "select count(*)::int workspaces,(select count(*)::int from device_binding_private.agents where device_id=$1) agents,(select count(*)::int from workflow_private.readiness where device_id=$1 and reported_ready) ready from device_binding_private.workspaces where device_id=$1",
        [p.deviceId],
      );
      assert.deepEqual(proof.rows[0], { workspaces: 1, agents: 1, ready: 0 });
    }),
);

test("should serialize apply against new DIRECT and legacy replacement", options, () =>
  workflowCase("settings-races", async (f) => {
    const r = await settings(f);
    for (const reverse of [false, true]) {
      const s = await f.directScene(`direct-${reverse}`),
        i = await r.prepare(s.owner, s.responder);
      const page = await f.read(s, s.requester);
      const ask = () =>
        f.human(s.requester, "ask", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          targetAgentId: s.responder.agentId!,
          targetEpoch: 1,
          expectedRoomRevision: page.roomRevision,
          publicText: "설정 경합",
          confirmed: true,
        });
      const jobs = [() => r.human(s.owner, "apply", i.apply), ask];
      if (reverse) jobs.reverse();
      assert.deepEqual(
        (await Promise.all(jobs.map((job) => job()))).map((x) => x.status).sort(),
        [200, 409],
      );
    }
    for (const reverse of [false, true]) {
      const s = await f.directScene(`replace-${reverse}`),
        i = await r.prepare(s.owner, s.responder);
      const replace = () =>
        f.devices.request(
          "replace",
          {
            operationId: randomUUID(),
            agentId: s.responder.agentId!,
            expectedEpoch: 1,
            repositoryAlias: "다른 저장소",
            branch: "unknown",
            commit: "unknown",
            dirty: "unknown",
            sessionAlias: "다른 AI",
            runtime: "codex",
          },
          s.responder.credential,
        );
      const jobs = [() => r.human(s.owner, "apply", i.apply), replace];
      if (reverse) jobs.reverse();
      assert.deepEqual(
        (await Promise.all(jobs.map((job) => job()))).map((x) => x.status).sort(),
        [200, 409],
      );
    }
  }),
);

async function cycleState(
  f: WorkflowFixture,
  roomId: string,
  cycleId: string,
  values: {
    mode: "ACTIVE" | "PAUSED";
    runs: number;
    rounds: number;
    expired: boolean;
    retired?: boolean;
    unresolved?: boolean;
  },
) {
  await assertOwnedStack(f.stack.config);
  assert.equal(f.rooms.has(roomId), true);
  await f.stack.db.query("begin");
  try {
    await f.stack.db.query("select device_binding_private.guard()");
    await f.stack.db.query(
      "update workflow_private.requests set state=$3 where room_id=$1 and cycle_id=$2",
      [roomId, cycleId, values.unresolved ? "UNKNOWN" : "CANCELLED"],
    );
    await f.stack.db.query(
      "update workflow_private.cycles set state='HUMAN_INPUT_REQUIRED',runs_reserved=$3,peer_rounds_reserved=$4,deadline=clock_timestamp()+case when $5 then interval '-1 second' else interval '10 minutes' end,retired_at=case when $6 then clock_timestamp() else null end where room_id=$1 and id=$2",
      [roomId, cycleId, values.runs, values.rounds, values.expired, values.retired ?? false],
    );
    await f.stack.db.query("update workflow_private.rooms set mode=$2 where room_id=$1", [
      roomId,
      values.mode,
    ]);
    await f.stack.db.query("commit");
  } catch (error) {
    await f.stack.db.query("rollback");
    throw error;
  }
}
test(
  "should block resumable HUMAN_INPUT_REQUIRED in ACTIVE and PAUSED rooms with empty poll and finished requests",
  options,
  () =>
    workflowCase("settings-pair-idle", async (f) => {
      const r = await settings(f);
      for (const mode of ["ACTIVE", "PAUSED"] as const) {
        const s = await f.scene(`pair-${mode}`),
          i = await r.prepare(s.peer, s.responder),
          a = await f.start(s);
        await cycleState(f, s.scope.roomId, a.cycleId, {
          mode,
          runs: 10,
          rounds: 4,
          expired: false,
        });
        assert.equal((await f.poll(s.responder)).queuedRequest, null);
        assert.equal((await r.human(s.peer, "apply", i.apply)).status, 409);
        assert.equal(await f.epoch(s.responder), 1);
      }
    }),
);

test(
  "should check deadline and run or peer budget edges while retaining every retired unresolved request",
  options,
  () =>
    workflowCase("settings-budget", async (f) => {
      const r = await settings(f);
      for (const edge of [
        { runs: 11, rounds: 4, expired: false },
        { runs: 10, rounds: 5, expired: false },
        { runs: 10, rounds: 4, expired: true },
      ]) {
        const s = await f.scene(`edge-${edge.runs}-${edge.rounds}-${edge.expired}`),
          i = await r.prepare(s.peer, s.responder),
          a = await f.start(s);
        await cycleState(f, s.scope.roomId, a.cycleId, {
          mode: "PAUSED",
          ...edge,
          retired: true,
          unresolved: true,
        });
        assert.equal((await r.human(s.peer, "apply", i.apply)).status, 409);
        await cycleState(f, s.scope.roomId, a.cycleId, { mode: "PAUSED", ...edge });
        r.accepted(await r.human(s.peer, "apply", i.apply));
        assert.equal(await f.epoch(s.responder), 1);
      }
    }),
);

test(
  "should allow a new setting after proof-closed terminal DIRECT without resuming its old generation",
  options,
  () =>
    workflowCase("settings-direct-terminal", async (f) => {
      const r = await settings(f),
        s = await f.directScene(),
        i = await r.prepare(s.owner, s.responder);
      const admitted = await f.ask(s);
      const attempt = await f.run(s.responder, admitted.requestId!);
      await f.complete(s.responder, attempt, "FAILED");
      const before = await f.stack.db.query(
        "select generation,peer_epoch,state from workflow_private.cycles where id=$1 and room_id=$2",
        [admitted.cycleId, s.scope.roomId],
      );
      assert.equal(before.rows[0].state, "HUMAN_INPUT_REQUIRED");
      r.accepted(await r.human(s.owner, "apply", i.apply));
      const committed = r.accepted(await r.device(s.responder, "receipt", i.commit));
      r.accepted(
        await r.device(s.responder, "receipt", {
          ...committed.operation!.receipt!,
          state: "APPLIED",
        }),
      );
      const after = await f.stack.db.query(
        "select generation,peer_epoch,state from workflow_private.cycles where id=$1 and room_id=$2",
        [admitted.cycleId, s.scope.roomId],
      );
      assert.deepEqual(after.rows, before.rows);
      await f.ready(s.responder);
      assert.ok((await f.ask(s)).requestId);
    }),
);

test(
  "should serialize cancel before commit and keep unresolved UNKNOWN candidates reserved",
  options,
  () =>
    workflowCase("settings-cancel", async (f) => {
      const r = await settings(f);
      for (const reverse of [false, true]) {
        const s = await f.directScene(`cancel-${reverse}`),
          i = await r.prepare(s.owner, s.responder);
        r.accepted(await r.human(s.owner, "apply", i.apply));
        const jobs = [
          () =>
            r.human(s.owner, "cancel", {
              operationId: i.base.operationId,
              deviceId: s.responder.deviceId,
            }),
          () => r.device(s.responder, "receipt", i.commit),
        ];
        if (reverse) jobs.reverse();
        const result = await Promise.all(jobs.map((job) => job()));
        assert.deepEqual(result.map((x) => x.status).sort(), [200, 409]);
        const poll = r.accepted(await r.device(s.responder, "poll", {}));
        if (poll.operation!.state === "CANCELLED") {
          assert.equal(await f.epoch(s.responder), 1);
          assert.equal((await f.ready(s.responder)).status, 409);
          const cleanup: Receipt = {
            ...i.commit,
            state: "CANCELLED",
            configRevision: i.base.expectedConfigRevision,
            bindingEpoch: null,
            agentId: null,
            workspaceId: null,
          };
          r.accepted(await r.device(s.responder, "receipt", cleanup));
          assert.equal((await f.ready(s.responder)).status, 200);
        } else assert.equal(poll.operation!.state, "COMMITTED");
      }
      const s = await f.directScene("unknown-settings"),
        i = await r.prepare(s.owner, s.responder);
      r.accepted(await r.human(s.owner, "apply", i.apply));
      r.accepted(
        await r.device(s.responder, "receipt", {
          ...i.commit,
          state: "UNKNOWN",
          configRevision: i.base.expectedConfigRevision,
          bindingEpoch: null,
          agentId: null,
          workspaceId: null,
        }),
      );
      assert.equal(
        (
          await r.human(s.owner, "cancel", {
            operationId: i.base.operationId,
            deviceId: s.responder.deviceId,
          })
        ).status,
        409,
      );
      assert.equal((await f.ready(s.responder)).status, 409);
      const cleanup: Receipt = {
        ...i.commit,
        state: "CANCELLED",
        configRevision: i.base.expectedConfigRevision,
        bindingEpoch: null,
        agentId: null,
        workspaceId: null,
      };
      assert.equal(
        (await r.device(s.responder, "receipt", { ...cleanup, localRootReference: randomUUID() }))
          .status,
        409,
      );
      assert.equal(
        (await r.device(s.responder, "receipt", { ...cleanup, runtime: "codex" })).status,
        409,
      );
      r.accepted(await r.device(s.responder, "receipt", cleanup));
      assert.equal((await f.ready(s.responder)).status, 200);
    }),
);

test("should return stale epoch receipts as historical without adopting them", options, () =>
  workflowCase("settings-history", async (f) => {
    const r = await settings(f),
      s = await f.directScene(),
      i = await r.prepare(s.owner, s.responder);
    r.accepted(await r.human(s.owner, "apply", i.apply));
    const first = r.accepted(await r.device(s.responder, "receipt", i.commit));
    const receipt = first.operation!.receipt!;
    r.accepted(await r.device(s.responder, "receipt", { ...receipt, state: "APPLIED" }));
    assert.equal(
      (
        await f.devices.request(
          "replace",
          {
            operationId: randomUUID(),
            agentId: s.responder.agentId!,
            expectedEpoch: 2,
            repositoryAlias: "교체 저장소",
            branch: "unknown",
            commit: "unknown",
            dirty: "unknown",
            sessionAlias: "교체 AI",
            runtime: "codex",
          },
          s.responder.credential,
        )
      ).status,
      200,
    );
    const historical = r.accepted(await r.device(s.responder, "receipt", i.commit));
    assert.equal(historical.current, false);
    assert.deepEqual(historical.operation!.receipt, { ...receipt, state: "APPLIED" });
    assert.equal(await f.epoch(s.responder), 3);
  }),
);

test(
  "should verify SQL and JavaScript canonical Unicode nested null and escape hashing identically",
  options,
  () =>
    workflowCase("settings-canonical", async (f) => {
      const r = await settings(f);
      void r;
      const catalog = {
        runtime: "claude" as const,
        version: '검증 "버전"\n',
        models: [
          { id: "모델", model: "模型", efforts: ["낮음"], defaultEffort: null, isDefault: false },
        ],
        defaultSettings: null,
        policy: "unsupported" as const,
      };
      const { capabilityHash } = await import("../../src/features/runtime-settings/contracts.ts");
      await assertOwnedStack(f.stack.config);
      const digest = await f.stack.db.query(
        "select encode(extensions.digest(runtime_settings_private.canonical($1::jsonb),'sha256'),'hex') hash",
        [JSON.stringify(catalog)],
      );
      assert.equal(digest.rows[0].hash, capabilityHash(catalog));
    }),
);

test(
  "should retain terminal unuploaded attempts and unacknowledged controls across retired cycles",
  options,
  () =>
    workflowCase("settings-unresolved-proof", async (f) => {
      const r = await settings(f),
        s = await f.directScene(),
        i = await r.prepare(s.owner, s.responder),
        a = await f.ask(s),
        attempt = await f.run(s.responder, a.requestId!);
      await assertOwnedStack(f.stack.config);
      assert.equal(f.rooms.has(s.scope.roomId), true);
      await f.stack.db.query("select workflow_private.control($1::uuid)", [a.requestId]);
      await cycleState(f, s.scope.roomId, a.cycleId, {
        mode: "PAUSED",
        runs: 11,
        rounds: 5,
        expired: true,
        retired: true,
      });
      await f.stack.db.query(
        "update workflow_private.attempts set state='COMPLETED',adoption='PENDING',terminal_text='합성 결과' where request_id=$1 and id=$2",
        [a.requestId, attempt.attemptId],
      );
      assert.equal((await r.human(s.owner, "apply", i.apply)).status, 409);
      await f.stack.db.query(
        "update workflow_private.attempts set adoption='HISTORICAL' where request_id=$1 and id=$2",
        [a.requestId, attempt.attemptId],
      );
      assert.equal((await r.human(s.owner, "apply", i.apply)).status, 409);
      await f.stack.db.query(
        "update workflow_private.controls set state='ACKNOWLEDGED' where request_id=$1 and attempt_id=$2",
        [a.requestId, attempt.attemptId],
      );
      // The DIRECT question also carries unresolved evidence until explicitly closed.
      await f.stack.db.query(
        "update workflow_private.questions set adoption='HISTORICAL' where cycle_id=$1",
        [a.cycleId],
      );
      r.accepted(await r.human(s.owner, "apply", i.apply));
    }),
);

test(
  "should separate admitted owner cookies from device bearer and recheck account revocation",
  options,
  () =>
    workflowCase("settings-auth-boundaries", async (f) => {
      const r = await settings(f),
        s = await f.directScene(),
        i = await r.prepare(s.owner, s.responder);
      const mixed = await s.owner.web.post(
        "/api/runtime-settings/list",
        { deviceId: s.responder.deviceId },
        { Authorization: `Bearer ${s.responder.credential}` },
      );
      assert.equal(mixed.status, 403);
      const cookie = await fetch(`${f.stack.config.app}/api/runtime-settings/poll`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${s.responder.credential}`,
          Cookie: "synthetic-session=1",
        },
        body: "{}",
      });
      assert.equal(cookie.status, 403);
      await assertOwnedStack(f.stack.config);
      assert.equal(f.stack.users.has(s.owner.id), true);
      await f.stack.db.query(
        "update auth.users set banned_until=clock_timestamp()+interval '1 minute' where id=$1",
        [s.owner.id],
      );
      assert.equal((await r.device(s.responder, "poll", {})).status, 401);
      assert.notEqual((await r.human(s.owner, "apply", i.apply)).status, 200);
      await f.stack.db.query(
        "update auth.users set banned_until=null,deleted_at=clock_timestamp() where id=$1",
        [s.owner.id],
      );
      assert.equal((await r.device(s.responder, "poll", {})).status, 401);
      await f.stack.db.query("update auth.users set deleted_at=null where id=$1", [s.owner.id]);
      assert.equal((await r.device(s.responder, "poll", {})).status, 200);
      assert.equal(
        (await f.devices.human(s.owner, "revoke", { deviceId: s.responder.deviceId })).status,
        200,
      );
      assert.equal((await r.device(s.responder, "poll", {})).status, 401);
    }),
);

test(
  "should echo exact owner approved automatic scope and reject legacy insertion or scope deletion",
  options,
  () =>
    workflowCase("settings-automatic-contract", async (f) => {
      const r = await settings(f);
      for (const automatic of [false, true]) {
        const scene = await f.directScene(`mode-${automatic}`);
        const intent = await r.prepare(
          scene.owner,
          scene.responder,
          automatic ? "AUTO_CODE" : undefined,
        );
        assert.equal(intent.local.readMode, automatic ? "AUTO_CODE" : undefined);
        assert.equal(Object.hasOwn(intent.selected, "readMode"), false);
        const forgedApply = { ...intent.apply } as Record<string, unknown>;
        if (automatic) delete forgedApply.readMode;
        else forgedApply.readMode = "AUTO_CODE";
        assert.equal((await r.human(scene.owner, "apply", forgedApply)).status, 409);
        for (const readMode of [
          null,
          "SELECTED",
          "AUTO_CODE\ud800",
          "AUTO_CODE ",
          { mode: "AUTO_CODE" },
        ])
          assert.equal(
            (await r.human(scene.owner, "apply", { ...intent.apply, readMode })).status,
            400,
          );
        assert.equal((await r.human(scene.requester, "apply", intent.apply)).status, 403);
        assert.equal(
          (
            await r.human(scene.owner, "apply", {
              ...intent.apply,
              localRootReference: randomUUID(),
            })
          ).status,
          409,
        );
        r.accepted(await r.human(scene.owner, "apply", intent.apply));
        const committed = r.accepted(await r.device(scene.responder, "receipt", intent.commit));
        assert.equal(committed.operation!.receipt!.readMode, intent.local.readMode);
        const applied = { ...committed.operation!.receipt!, state: "APPLIED" as const };
        const forgedReceipt = { ...applied };
        if (automatic) delete forgedReceipt.readMode;
        else forgedReceipt.readMode = "AUTO_CODE";
        assert.equal((await r.device(scene.responder, "receipt", forgedReceipt)).status, 409);
        const final = r.accepted(await r.device(scene.responder, "receipt", applied));
        assert.deepEqual(final.applied, applied);
        assert.deepEqual(
          r.accepted(await r.device(scene.responder, "receipt", applied)).applied,
          applied,
        );
        assert.equal((await r.human(scene.owner, "apply", forgedApply)).status, 409);
      }
    }),
);
