import test from "node:test";
import { RuntimeSettingsFixture } from "../helpers/runtime-settings-fixture.js";
import assert from "node:assert/strict";
import { Client } from "pg";
import { assertOwnedStack } from "../helpers/local-access-stack.js";
import { randomUUID } from "node:crypto";
import {
  workflowCase,
  type WorkflowFixture,
  type WorkflowScene,
} from "../helpers/workflow-fixture.js";
import type { DeviceResponse } from "../helpers/device-binding-fixture.js";
import {
  projectResponse,
  type InputState,
} from "../../src/features/investigation-coordinator/contracts.ts";

// Definitions require the existing owned DB/HTTP stack. Source/unit checks do not execute them.
const options = { timeout: 300000 };
async function preservationSnapshot(f: WorkflowFixture, s: WorkflowScene) {
  await assertOwnedStack(f.stack.config);
  assert.equal(f.rooms.get(s.scope.roomId), s.scope.organizationId);
  assert.equal(f.devices.profiles.get(s.origin.name), s.origin);
  const configuration = await f.stack.db.query(
    "select device_id,revision,catalog,applied from runtime_settings_private.configurations where device_id=$1",
    [s.origin.deviceId],
  );
  const operations = await f.stack.db.query(
    "select operation_id,expected_revision,state,requested,receipt,committed_receipt,applied_receipt from runtime_settings_private.operations where device_id=$1 order by operation_id",
    [s.origin.deviceId],
  );
  return {
    history: await f.history(s),
    epoch: await f.epoch(s.origin),
    configuration: configuration.rows,
    settingsOperations: operations.rows,
  };
}
async function sqlResponse(
  client: Client,
  statement: string,
  values: unknown[],
  forbidden = false,
): Promise<DeviceResponse> {
  let status = 200;
  let data: DeviceResponse["data"];
  try {
    data = { ok: true, data: (await client.query(statement, values)).rows[0].result };
  } catch (error) {
    if (!forbidden) throw error;
    assert.equal((error as { code?: string }).code, "P0001");
    assert.equal((error as Error).message, "FORBIDDEN");
    status = 403;
    data = { ok: false, error: { code: "FORBIDDEN" } };
  }
  return { status, data, text: JSON.stringify(data), headers: new Headers() };
}
async function orderedRoomCommit(
  f: WorkflowFixture,
  s: WorkflowScene,
  first: (holder: Client) => Promise<unknown>,
  second: (waiter: Client) => Promise<DeviceResponse>,
) {
  await assertOwnedStack(f.stack.config);
  assert.equal(f.rooms.get(s.scope.roomId), s.scope.organizationId);
  const holder = new Client({
    connectionString: f.stack.config.db,
    ssl: false,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
  const waiter = new Client({
    connectionString: f.stack.config.db,
    ssl: false,
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
  });
  let transaction = false;
  let waiterTransaction = false;
  let pending: Promise<DeviceResponse> | undefined;
  try {
    await holder.connect();
    await waiter.connect();
    await holder.query("begin");
    transaction = true;
    const pid = Number((await holder.query("select pg_backend_pid() pid")).rows[0].pid);
    const firstResult = await first(holder);
    await holder.query("reset role");
    // The first mutation retains its normal guard/scope locks and this exact owned room row lock.
    const room = await holder.query(
      "select room_id from workflow_private.rooms where room_id=$1 for update",
      [s.scope.roomId],
    );
    assert.equal(room.rowCount, 1);
    await waiter.query("begin");
    waiterTransaction = true;
    const waiterPid = Number((await waiter.query("select pg_backend_pid() pid")).rows[0].pid);
    assert.notEqual(waiterPid, pid);
    pending = second(waiter);
    // Attach rejection handling immediately while this exact second backend is blocked.
    void pending.catch(() => undefined);
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const wait = await f.stack.db.query(
        "select exists(select 1 from pg_catalog.pg_stat_activity a where a.pid=$2::integer and $1::integer=any(pg_catalog.pg_blocking_pids(a.pid)) and a.wait_event_type='Lock') blocked",
        [pid, waiterPid],
      );
      if (wait.rows[0].blocked === true) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(blocked, true, "Second mutation must wait for the first connection before commit");
    await holder.query("commit");
    transaction = false;
    const secondResult = await pending;
    pending = undefined;
    await waiter.query(secondResult.status === 200 ? "commit" : "rollback");
    waiterTransaction = false;
    return { first: firstResult, second: secondResult };
  } finally {
    try {
      if (transaction) await holder.query("rollback");
    } finally {
      // Closing the holder releases its locks even if rollback itself fails.
      await holder.end();
      try {
        await pending?.catch(() => undefined);
        if (waiterTransaction) await waiter.query("rollback");
      } finally {
        await waiter.end();
      }
    }
  }
}
function accepted(r: DeviceResponse) {
  assert.equal(r.status, 200);
  return r.data.data;
}
async function desired(f: WorkflowFixture, s: WorkflowScene): Promise<InputState> {
  return projectResponse(
    "admission",
    accepted(await f.device(s.origin, "admission")),
  ) as InputState;
}
async function control(
  f: WorkflowFixture,
  s: WorkflowScene,
  paused: boolean,
  operationId = randomUUID(),
) {
  const state = await desired(f, s);
  return f.human(s.owner, "input-control", {
    roomId: s.scope.roomId,
    operationId,
    agentId: s.origin.agentId!,
    bindingEpoch: state.bindingEpoch,
    expectedRevision: state.revision,
    paused,
  });
}
test(
  "should isolate owner control and preserve shared room history and settings generations",
  options,
  () =>
    workflowCase("own-input-scope", async (f) => {
      const s = await f.scene();
      const settings = new RuntimeSettingsFixture(f);
      await settings.requireMigration();
      const configured = await settings.prepare(s.owner, s.origin);
      settings.accepted(await settings.human(s.owner, "apply", configured.apply));
      const committed = settings.accepted(
        await settings.device(s.origin, "receipt", configured.commit),
      );
      assert.equal(committed.operation?.state, "COMMITTED");
      settings.accepted(
        await settings.device(s.origin, "receipt", { ...configured.commit, state: "APPLIED" }),
      );
      accepted(
        await f.human(s.owner, "speak", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          publicText: "새 답변 제어 전 보존할 합성 대화",
        }),
      );
      const before = await f.read(s);
      const preserved = await preservationSnapshot(f, s);
      assert.ok(preserved.history.events.length > 0);
      assert.equal(preserved.configuration.length, 1);
      assert.equal(Number(preserved.configuration[0].revision), configured.commit.configRevision);
      assert.equal(preserved.settingsOperations.length, 1);
      assert.equal(preserved.settingsOperations[0].state, "APPLIED");
      const initial = await desired(f, s);
      const operationCount = f.operations.length;
      accepted(await f.human(s.owner, "input-state", { roomId: s.scope.roomId }));
      accepted(
        await f.device(s.origin, "admission-ack", {
          revision: initial.revision,
          paused: initial.paused,
        }),
      );
      assert.equal(f.operations.length, operationCount);
      const result = projectResponse(
        "input-control",
        accepted(await control(f, s, true)),
      ) as InputState;
      assert.equal(result.paused, true);
      assert.equal(result.appliedRevision, null);
      const body = {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        agentId: s.origin.agentId!,
        bindingEpoch: initial.bindingEpoch,
        expectedRevision: result.revision,
        paused: false,
      };
      assert.equal((await f.human(s.peer, "input-control", body)).status, 403);
      assert.equal((await f.human(s.observer, "input-control", body)).status, 403);
      assert.equal(
        (await f.device(s.origin, "admission-ack", { revision: initial.revision, paused: false }))
          .status,
        409,
      );
      const after = await f.read(s);
      assert.equal(after.roomRevision, before.roomRevision);
      assert.deepEqual(after.events, before.events);
      assert.deepEqual(after.bindings, before.bindings);
      const unchanged = await preservationSnapshot(f, s);
      assert.equal(unchanged.epoch, preserved.epoch);
      assert.equal(unchanged.history.roomRevision, preserved.history.roomRevision);
      assert.deepEqual(unchanged.configuration, preserved.configuration);
      assert.deepEqual(unchanged.settingsOperations, preserved.settingsOperations);
      assert.deepEqual(unchanged.history.events, preserved.history.events);
      assert.deepEqual(unchanged.history.runs, preserved.history.runs);
      assert.deepEqual(unchanged.history.cycle, preserved.history.cycle);
      assert.equal(
        f.operations.some((op) => op.operationId === "undefined"),
        false,
      );
    }),
);
test(
  "should retain exact paused receipts and reject changed claim or control bodies and cross-action operation reuse",
  options,
  () =>
    workflowCase("own-input-denial", async (f) => {
      const s = await f.scene();
      const cycle = await f.start(s);
      assert.ok(cycle.requestId);
      const initial = await desired(f, s);
      const controlBody = {
        protocol: 1,
        roomId: s.scope.roomId,
        expectedUserId: s.owner.id,
        operationId: randomUUID(),
        agentId: s.origin.agentId!,
        bindingEpoch: initial.bindingEpoch,
        expectedRevision: initial.revision,
        paused: true,
      };
      const originalControl = await f.human(s.owner, "input-control", controlBody);
      const paused = projectResponse("input-control", accepted(originalControl)) as InputState;
      assert.equal(paused.paused, true);
      const humanReceipt = () =>
        f.stack.db.query(
          "select action,payload_hash,result from workflow_private.receipts where room_id=$1 and actor_kind='human' and actor_id=$2 and operation_id=$3",
          [s.scope.roomId, s.owner.id, controlBody.operationId],
        );
      const originalHumanReceipt = (await humanReceipt()).rows;
      assert.equal(originalHumanReceipt.length, 1);
      assert.equal(originalHumanReceipt[0].action, "input-control");
      assert.match(originalHumanReceipt[0].payload_hash, /^[a-f0-9]{64}$/);
      assert.deepEqual(originalHumanReceipt[0].result, paused);
      // Use the current revision so changed-body rejection cannot be explained by a stale revision.
      const changedControl = await f.human(s.owner, "input-control", {
        ...controlBody,
        expectedRevision: paused.revision,
        paused: false,
      });
      assert.equal(changedControl.status, 409);
      assert.deepEqual(changedControl.data.error, { code: "CONFLICT" });
      assert.deepEqual(await desired(f, s), paused);
      assert.deepEqual((await humanReceipt()).rows, originalHumanReceipt);
      const controlReplay = await f.human(s.owner, "input-control", controlBody);
      assert.equal(controlReplay.status, 200);
      assert.deepEqual(controlReplay.data, originalControl.data);
      assert.deepEqual(await desired(f, s), paused);
      assert.deepEqual((await humanReceipt()).rows, originalHumanReceipt);
      const operationId = randomUUID(),
        body = { operationId, requestId: cycle.requestId! };
      const denied = await f.device(s.origin, "claim", body);
      assert.equal(denied.status, 409);
      assert.deepEqual(denied.data.error, { code: "INPUT_PAUSED" });
      const resumed = projectResponse(
        "input-control",
        accepted(await control(f, s, false)),
      ) as InputState;
      assert.equal(resumed.paused, false);
      const historicalControlReplay = await f.human(s.owner, "input-control", controlBody);
      assert.equal(historicalControlReplay.status, 200);
      assert.deepEqual(historicalControlReplay.data, originalControl.data);
      assert.deepEqual(await desired(f, s), resumed);
      assert.deepEqual((await humanReceipt()).rows, originalHumanReceipt);
      assert.deepEqual((await f.device(s.origin, "claim", body)).data, denied.data);
      assert.equal(
        (await f.device(s.origin, "ready", { operationId, reportedReady: true })).status,
        409,
      );
      const other = randomUUID();
      accepted(await f.device(s.origin, "ready", { operationId: other, reportedReady: true }));
      assert.equal(
        (await f.device(s.origin, "claim", { ...body, operationId: other })).status,
        409,
      );
      const row = await f.stack.db.query(
        "select action,result from workflow_private.receipts where room_id=$1 and actor_kind='device' and actor_id=$2 and operation_id=$3",
        [s.scope.roomId, s.origin.deviceId, operationId],
      );
      assert.deepEqual(row.rows, [{ action: "claim", result: { claimDenied: "INPUT_PAUSED" } }]);
      // Prepare another valid request through the existing product fixture before taking snapshots.
      accepted(
        await f.human(s.owner, "interrupt", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          agentId: s.origin.agentId!,
          bindingEpoch: await f.epoch(s.origin),
          expectedRoomRevision: (await f.read(s)).roomRevision,
        }),
      );
      accepted(await f.ready(s.origin));
      accepted(await f.ready(s.responder));
      const alternate = await f.start(s);
      assert.ok(alternate.requestId);
      assert.notEqual(alternate.requestId, cycle.requestId);
      const validRequest = await f.stack.db.query(
        "select room_id,device_id,agent_id,owner_id,binding_epoch,state from workflow_private.requests where id=$1",
        [alternate.requestId],
      );
      assert.deepEqual(validRequest.rows, [
        {
          room_id: s.scope.roomId,
          device_id: s.origin.deviceId,
          agent_id: s.origin.agentId,
          owner_id: s.owner.id,
          binding_epoch: String(initial.bindingEpoch),
          state: "QUEUED",
        },
      ]);
      const claimSnapshot = async () => ({
        receipt: (
          await f.stack.db.query(
            "select action,payload_hash,result from workflow_private.receipts where room_id=$1 and actor_kind='device' and actor_id=$2 and operation_id=$3",
            [s.scope.roomId, s.origin.deviceId, operationId],
          )
        ).rows,
        requests: (
          await f.stack.db.query(
            "select * from workflow_private.requests where room_id=$1 order by id",
            [s.scope.roomId],
          )
        ).rows,
        attempts: (
          await f.stack.db.query(
            "select a.* from workflow_private.attempts a join workflow_private.requests q on q.id=a.request_id where q.room_id=$1 order by a.id",
            [s.scope.roomId],
          )
        ).rows,
      });
      const originalClaim = await claimSnapshot();
      assert.equal(originalClaim.receipt.length, 1);
      assert.equal(originalClaim.receipt[0].action, "claim");
      assert.match(originalClaim.receipt[0].payload_hash, /^[a-f0-9]{64}$/);
      assert.deepEqual(originalClaim.receipt[0].result, { claimDenied: "INPUT_PAUSED" });
      assert.equal(originalClaim.requests.length, 2);
      assert.deepEqual(
        originalClaim.requests.map((request) => request.id).sort(),
        [cycle.requestId, alternate.requestId].sort(),
      );
      assert.equal(
        originalClaim.requests.find((request) => request.id === cycle.requestId)?.state,
        "CANCELLED",
      );
      assert.equal(
        originalClaim.requests.find((request) => request.id === alternate.requestId)?.state,
        "QUEUED",
      );
      assert.equal(originalClaim.attempts.length, 0);
      const changedClaim = await f.device(s.origin, "claim", {
        ...body,
        requestId: alternate.requestId,
      });
      assert.equal(changedClaim.status, 409);
      assert.deepEqual(changedClaim.data.error, { code: "CONFLICT" });
      assert.deepEqual(await claimSnapshot(), originalClaim);
      const denialReplay = await f.device(s.origin, "claim", body);
      assert.equal(denialReplay.status, 409);
      assert.deepEqual(denialReplay.data, denied.data);
      assert.deepEqual(await claimSnapshot(), originalClaim);
      assert.deepEqual((await humanReceipt()).rows, originalHumanReceipt);
      assert.deepEqual(await desired(f, s), resumed);
      await f.recoverOperations();
    }),
);
test(
  "should preserve successful claim replay start-intent lease and terminal after owner pause",
  options,
  () =>
    workflowCase("own-input-admitted", async (f) => {
      const s = await f.scene();
      const cycle = await f.start(s);
      assert.ok(cycle.requestId);
      const body = { operationId: randomUUID(), requestId: cycle.requestId! };
      const claimed = accepted(await f.device(s.origin, "claim", body));
      accepted(await control(f, s, true));
      assert.deepEqual(accepted(await f.device(s.origin, "claim", body)), claimed);
      const attempt = projectResponse("claim", claimed) as Parameters<WorkflowFixture["intent"]>[1];
      const started = await f.intent(s.origin, attempt);
      accepted(await f.device(s.origin, "lease", f.identity(started)));
      await f.complete(s.origin, started);
      assert.equal((await desired(f, s)).paused, true);
    }),
);

test(
  "should preserve agent desired state across replacement and reject old epoch ACK",
  options,
  () =>
    workflowCase("own-input-epoch", async (f) => {
      const s = await f.scene(),
        epoch = await f.epoch(s.origin);
      const paused = projectResponse(
        "input-control",
        accepted(await control(f, s, true)),
      ) as InputState;
      accepted(
        await f.device(s.origin, "admission-ack", { revision: paused.revision, paused: true }),
      );
      accepted(
        await f.devices.request(
          "replace",
          {
            operationId: randomUUID(),
            agentId: s.origin.agentId!,
            expectedEpoch: epoch,
            repositoryAlias: "새 공개 저장소",
            branch: "main",
            commit: "unknown",
            dirty: "unknown",
            sessionAlias: "새 공개 세션",
            runtime: "codex",
          },
          s.origin.credential,
        ),
      );
      const current = await desired(f, s);
      assert.equal(current.bindingEpoch, epoch + 1);
      assert.equal(current.revision, paused.revision);
      assert.equal(current.paused, true);
      assert.equal(current.appliedEpoch, null);
      assert.equal(
        (
          await f.device(s.origin, "admission-ack", {
            bindingEpoch: epoch,
            revision: paused.revision,
            paused: true,
          })
        ).status,
        403,
      );
      accepted(
        await f.device(s.origin, "admission-ack", {
          revision: current.revision,
          paused: current.paused,
        }),
      );
      assert.equal((await desired(f, s)).appliedEpoch, epoch + 1);
    }),
);
test("should refuse input reads and ACK after revoked device or membership", options, () =>
  workflowCase("own-input-revocation", async (f) => {
    for (const kind of ["device", "room"]) {
      const s = await f.scene(kind),
        state = await desired(f, s);
      if (kind === "device")
        accepted(await f.devices.human(s.owner, "remove", { deviceId: s.origin.deviceId }));
      else
        await s.owner.web.mutate("revoke-room-member", {
          roomId: s.scope.roomId,
          userId: s.peer.id,
        });
      const target = kind === "device" ? s.origin : s.responder;
      assert.equal((await f.device(target, "admission")).status, 401);
      assert.equal(
        (await f.device(target, "admission-ack", { revision: state.revision, paused: false }))
          .status,
        401,
      );
    }
  }),
);

test(
  "should serialize claim and owner pause in both commit orders on independent owned connections",
  options,
  () =>
    workflowCase("own-input-commit-order", async (f) => {
      for (const first of ["pause", "claim"] as const) {
        const s = await f.scene(first),
          cycle = await f.start(s);
        assert.ok(cycle.requestId);
        const epoch = await f.epoch(s.origin),
          revision = (await desired(f, s)).revision;
        const claimBody = {
          protocol: 1,
          operationId: randomUUID(),
          agentId: s.origin.agentId!,
          bindingEpoch: epoch,
          requestId: cycle.requestId!,
        };
        const pauseBody = {
          protocol: 1,
          roomId: s.scope.roomId,
          expectedUserId: s.owner.id,
          operationId: randomUUID(),
          agentId: s.origin.agentId!,
          bindingEpoch: epoch,
          expectedRevision: revision,
          paused: true,
        };
        assert.equal(f.devices.profiles.get(s.origin.name), s.origin);
        assert.equal(s.origin.ownerUserId, s.owner.id);
        assert.equal(f.stack.users.has(s.owner.id), true);
        const trackedPause = await f.recordOwnedInputControl(s.owner, pauseBody);
        f.operations.push({
          roomId: s.scope.roomId,
          actorId: s.origin.deviceId!,
          action: "claim",
          operationId: claimBody.operationId,
        });
        await f.save();
        const ordered = await orderedRoomCommit(
          f,
          s,
          async (holder) => {
            if (first === "pause") {
              await holder.query("select set_config('request.jwt.claim.sub',$1,true)", [
                s.owner.id,
              ]);
              await holder.query("set local role authenticated");
              return (
                await holder.query("select public.workflow_human_input_control($1::jsonb) result", [
                  JSON.stringify(trackedPause),
                ])
              ).rows[0].result;
            }
            await holder.query("set local role anon");
            return (
              await holder.query("select public.workflow_device_claim($1::jsonb,$2::text) result", [
                JSON.stringify(claimBody),
                s.origin.credential,
              ])
            ).rows[0].result;
          },
          async (waiter) => {
            if (first === "pause") {
              await waiter.query("set local role anon");
              return sqlResponse(
                waiter,
                "select public.workflow_device_claim($1::jsonb,$2::text) result",
                [JSON.stringify(claimBody), s.origin.credential],
              );
            }
            await waiter.query("select set_config('request.jwt.claim.sub',$1,true)", [s.owner.id]);
            await waiter.query("set local role authenticated");
            return sqlResponse(
              waiter,
              "select public.workflow_human_input_control($1::jsonb) result",
              [JSON.stringify(trackedPause)],
            );
          },
        );
        if (first === "pause") {
          assert.equal(
            (projectResponse("input-control", ordered.first) as InputState).paused,
            true,
          );
          // A returned negative SQL receipt commits; only the actual HTTP projection returns 409.
          assert.equal(ordered.second.status, 200);
          assert.deepEqual(ordered.second.data.data, { claimDenied: "INPUT_PAUSED" });
          const denied = await f.device(s.origin, "claim", claimBody);
          assert.equal(denied.status, 409);
          assert.deepEqual(denied.data.error, { code: "INPUT_PAUSED" });
          const receipt = await f.stack.db.query(
            "select action,result from workflow_private.receipts where room_id=$1 and actor_kind='device' and actor_id=$2 and operation_id=$3",
            [s.scope.roomId, s.origin.deviceId, claimBody.operationId],
          );
          assert.deepEqual(receipt.rows, [
            { action: "claim", result: { claimDenied: "INPUT_PAUSED" } },
          ]);
        } else {
          projectResponse("claim", ordered.first);
          assert.equal(
            (projectResponse("input-control", accepted(ordered.second)) as InputState).paused,
            true,
          );
          assert.deepEqual(accepted(await f.device(s.origin, "claim", claimBody)), ordered.first);
        }
        await f.recoverOperations();
      }
    }),
);

test(
  "should serialize SQL010 apply control and settings commit old ACK in both commit orders",
  options,
  () =>
    workflowCase("own-input-settings-race", async (f) => {
      for (const applyFirst of ["apply", "control"] as const) {
        for (const commitFirst of ["commit", "ack"] as const) {
          const s = await f.scene(`${applyFirst}-${commitFirst}`);
          const settings = new RuntimeSettingsFixture(f);
          await settings.requireMigration();
          const intent = await settings.prepare(s.owner, s.origin);
          const state = await desired(f, s);
          const pauseBody = {
            protocol: 1,
            expectedUserId: s.owner.id,
            roomId: s.scope.roomId,
            operationId: randomUUID(),
            agentId: s.origin.agentId!,
            bindingEpoch: state.bindingEpoch,
            expectedRevision: state.revision,
            paused: true,
          };
          // The existing settings operation belongs to this persisted owned device identity.
          assert.equal(f.devices.profiles.get(s.origin.name), s.origin);
          assert.equal(s.origin.ownerUserId, s.owner.id);
          assert.equal(f.stack.users.has(s.owner.id), true);
          await f.save();
          const ownedSettings = await f.stack.db.query(
            "select o.operation_id from runtime_settings_private.operations o join device_binding_private.devices d on d.id=o.device_id where o.device_id=$1 and o.operation_id=$2 and d.owner_user_id=$3 and d.room_id=$4",
            [s.origin.deviceId, intent.base.operationId, s.owner.id, s.scope.roomId],
          );
          assert.equal(ownedSettings.rowCount, 1);
          const applied = await orderedRoomCommit(
            f,
            s,
            async (holder) => {
              await holder.query("select set_config('request.jwt.claim.sub',$1,true)", [
                s.owner.id,
              ]);
              await holder.query("set local role authenticated");
              if (applyFirst === "apply") {
                return (
                  await holder.query(
                    "select public.runtime_settings_human('apply',$1::jsonb) result",
                    [JSON.stringify(intent.apply)],
                  )
                ).rows[0].result;
              }
              const tracked = await f.recordOwnedInputControl(s.owner, pauseBody);
              return (
                await holder.query("select public.workflow_human_input_control($1::jsonb) result", [
                  JSON.stringify(tracked),
                ])
              ).rows[0].result;
            },
            async (waiter) => {
              await waiter.query("select set_config('request.jwt.claim.sub',$1,true)", [
                s.owner.id,
              ]);
              await waiter.query("set local role authenticated");
              if (applyFirst === "apply") {
                const tracked = await f.recordOwnedInputControl(s.owner, pauseBody);
                return sqlResponse(
                  waiter,
                  "select public.workflow_human_input_control($1::jsonb) result",
                  [JSON.stringify(tracked)],
                );
              }
              return sqlResponse(
                waiter,
                "select public.runtime_settings_human('apply',$1::jsonb) result",
                [JSON.stringify(intent.apply)],
              );
            },
          );
          const applyResult =
            applyFirst === "apply"
              ? settings.accepted({ status: 200, data: { ok: true, data: applied.first } })
              : settings.accepted(applied.second);
          assert.equal(applyResult.operation?.state, "APPLYING");
          const paused = projectResponse(
            "input-control",
            applyFirst === "control" ? applied.first : accepted(applied.second as DeviceResponse),
          ) as InputState;
          assert.equal(paused.paused, true);
          assert.equal(paused.revision, state.revision + 1);
          const ackBody = {
            protocol: 1,
            agentId: s.origin.agentId!,
            bindingEpoch: state.bindingEpoch,
            revision: paused.revision,
            paused: true,
          };
          const operationsBeforeAck = f.operations.length;
          const committed = await orderedRoomCommit(
            f,
            s,
            async (holder) => {
              await holder.query("set local role anon");
              if (commitFirst === "commit") {
                return (
                  await holder.query(
                    "select public.runtime_settings_device('receipt',$1::jsonb,$2::text) result",
                    [JSON.stringify(intent.commit), s.origin.credential],
                  )
                ).rows[0].result;
              }
              return (
                await holder.query(
                  "select public.workflow_device_admission_ack($1::jsonb,$2::text) result",
                  [JSON.stringify(ackBody), s.origin.credential],
                )
              ).rows[0].result;
            },
            async (waiter) => {
              await waiter.query("set local role anon");
              if (commitFirst === "commit") {
                return sqlResponse(
                  waiter,
                  "select public.workflow_device_admission_ack($1::jsonb,$2::text) result",
                  [JSON.stringify(ackBody), s.origin.credential],
                  true,
                );
              }
              return sqlResponse(
                waiter,
                "select public.runtime_settings_device('receipt',$1::jsonb,$2::text) result",
                [JSON.stringify(intent.commit), s.origin.credential],
              );
            },
          );
          const commitResult =
            commitFirst === "commit"
              ? settings.accepted({ status: 200, data: { ok: true, data: committed.first } })
              : settings.accepted(committed.second);
          assert.equal(commitResult.operation?.state, "COMMITTED");
          assert.equal(commitResult.configRevision, intent.commit.configRevision);
          if (commitFirst === "commit") {
            assert.equal(committed.second.status, 403);
            assert.deepEqual((committed.second as DeviceResponse).data.error, {
              code: "FORBIDDEN",
            });
          } else {
            const oldAck = projectResponse("admission-ack", committed.first) as InputState;
            assert.equal(oldAck.appliedRevision, paused.revision);
            assert.equal(oldAck.appliedEpoch, state.bindingEpoch);
          }
          assert.equal(f.operations.length, operationsBeforeAck);
          const receipt = await f.stack.db.query(
            "select state,apply_body,commit_body,committed_receipt from runtime_settings_private.operations where device_id=$1 and operation_id=$2",
            [s.origin.deviceId, intent.base.operationId],
          );
          assert.equal(receipt.rowCount, 1);
          assert.equal(receipt.rows[0].state, "COMMITTED");
          assert.deepEqual(receipt.rows[0].apply_body, intent.apply);
          assert.deepEqual(receipt.rows[0].commit_body, intent.commit);
          assert.deepEqual(receipt.rows[0].committed_receipt, commitResult.operation?.receipt);
          const after = await desired(f, s);
          assert.equal(after.bindingEpoch, state.bindingEpoch + 1);
          assert.equal(after.revision, paused.revision);
          assert.equal(after.paused, true);
          assert.equal(after.appliedEpoch, null);
          accepted(
            await f.device(s.origin, "admission-ack", {
              revision: after.revision,
              paused: after.paused,
            }),
          );
          assert.equal((await desired(f, s)).appliedEpoch, after.bindingEpoch);
          await f.recoverOperations();
        }
      }
    }),
);
