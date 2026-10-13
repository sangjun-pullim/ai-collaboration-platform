import { randomUUID } from "node:crypto";
import { assertOwnedStack, ensure } from "./local-access-stack.js";
import type { WorkflowFixture, HumanDirectScene } from "./workflow-fixture.js";

async function assertRetirementScope(f: WorkflowFixture, s: HumanDirectScene) {
  await assertOwnedStack(f.stack.config);
  ensure(
    f.rooms.get(s.scope.roomId) === s.scope.organizationId &&
      f.stack.organizations.has(s.scope.organizationId) &&
      f.stack.users.has(s.owner.id) &&
      f.devices.profiles.get(s.responder.name) === s.responder &&
      s.responder.roomId === s.scope.roomId &&
      s.responder.ownerUserId === s.owner.id,
    "Unowned retirement risk scope",
  );
}

async function ownedUnknown(f: WorkflowFixture, s: HumanDirectScene, requestId: string) {
  await assertRetirementScope(f, s);
  ensure(f.identities.get("requestId")?.has(requestId), "Unrecorded retirement risk request");
  const result = await f.stack.db.query(
    "select r.id,r.cycle_id,r.question_id,a.id attempt_id from workflow_private.requests r join workflow_private.attempts a on a.request_id=r.id join workflow_private.cycles c on c.id=r.cycle_id where r.id=$1 and r.room_id=$2 and r.owner_id=$3 and r.device_id=$4 and r.agent_id=$5 and r.state='UNKNOWN' and a.state='UNKNOWN' and a.start_intent_at is not null and c.mode='DIRECT'",
    [requestId, s.scope.roomId, s.owner.id, s.responder.deviceId, s.responder.agentId],
  );
  ensure(result.rowCount === 1, "Unowned or non-UNKNOWN retirement risk template");
  return result.rows[0] as {
    id: string;
    cycle_id: string;
    question_id: string;
    attempt_id: string;
  };
}

/** Temporarily remove only the owned target's current room membership. */
export async function withDepartedRetirementOwner(
  f: WorkflowFixture,
  s: HumanDirectScene,
  run: () => Promise<void>,
) {
  await assertRetirementScope(f, s);
  const removed = await f.stack.db.query(
    "update public.room_members set status='removed' where organization_id=$1 and room_id=$2 and user_id=$3 and status='active' returning user_id",
    [s.scope.organizationId, s.scope.roomId, s.owner.id],
  );
  ensure(removed.rowCount === 1, "Owned retirement membership removal failed");
  try {
    await run();
  } finally {
    const restored = await f.stack.db.query(
      "update public.room_members set status='active' where organization_id=$1 and room_id=$2 and user_id=$3 and status='removed' returning user_id",
      [s.scope.organizationId, s.scope.roomId, s.owner.id],
    );
    ensure(restored.rowCount === 1, "Owned retirement membership restoration failed");
  }
}

/** Physical deletion must never stand in for the required revoked-device evidence. */
export async function deleteOriginalRetirementDevice(
  f: WorkflowFixture,
  s: HumanDirectScene,
  requestId: string,
) {
  await ownedUnknown(f, s, requestId);
  const removed = await f.stack.db.query(
    "delete from device_binding_private.devices where id=$1 and owner_user_id=$2 and organization_id=$3 and room_id=$4 and state='revoked' returning id",
    [s.responder.deviceId, s.owner.id, s.scope.organizationId, s.scope.roomId],
  );
  ensure(removed.rowCount === 1, "Owned retired-device deletion failed");
}

/** Seed one historical, started UNKNOWN with no retirement record in the owned room. */
export async function seedUnretiredUnknown(
  f: WorkflowFixture,
  s: HumanDirectScene,
  requestId: string,
) {
  const original = await ownedUnknown(f, s, requestId);
  const cycleId = randomUUID(),
    questionId = randomUUID(),
    nextRequestId = randomUUID(),
    attemptId = randomUUID();
  await f.stack.db.query("begin");
  try {
    await f.stack.db.query("select workflow_private.lock_room($1)", [s.scope.roomId]);
    await f.stack.db.query(
      "insert into workflow_private.cycles select (jsonb_populate_record(null::workflow_private.cycles,to_jsonb(c)||jsonb_build_object('id',$1::uuid,'retired_at',clock_timestamp()))).* from workflow_private.cycles c where id=$2 and room_id=$3",
      [cycleId, original.cycle_id, s.scope.roomId],
    );
    await f.stack.db.query(
      "insert into workflow_private.generations select (jsonb_populate_record(null::workflow_private.generations,to_jsonb(g)||jsonb_build_object('cycle_id',$1::uuid))).* from workflow_private.generations g where cycle_id=$2",
      [cycleId, original.cycle_id],
    );
    await f.stack.db.query(
      "insert into workflow_private.requests select (jsonb_populate_record(null::workflow_private.requests,to_jsonb(r)||jsonb_build_object('id',$1::uuid,'cycle_id',$2::uuid,'question_id',$3::uuid))).* from workflow_private.requests r where id=$4 and room_id=$5",
      [nextRequestId, cycleId, questionId, requestId, s.scope.roomId],
    );
    await f.stack.db.query(
      "insert into workflow_private.questions select (jsonb_populate_record(null::workflow_private.questions,to_jsonb(q)||jsonb_build_object('id',$1::uuid,'cycle_id',$2::uuid))).* from workflow_private.questions q where id=$3",
      [questionId, cycleId, original.question_id],
    );
    await f.stack.db.query(
      "insert into workflow_private.attempts select (jsonb_populate_record(null::workflow_private.attempts,to_jsonb(a)||jsonb_build_object('id',$1::uuid,'request_id',$2::uuid))).* from workflow_private.attempts a where id=$3 and request_id=$4",
      [attemptId, nextRequestId, original.attempt_id, requestId],
    );
    await f.stack.db.query("select workflow_private.state($1,'UNKNOWN')", [nextRequestId]);
    await f.captureResponse({ requestId: nextRequestId, cycleId, questionId, attemptId });
    await f.stack.db.query("commit");
    return { requestId: nextRequestId, cycleId, attemptId };
  } catch (error) {
    await f.stack.db.query("rollback");
    throw error;
  }
}

/** Seed historical paging data only in the fixture's exact owned scope. */
export async function seedRetirementHistory(
  f: WorkflowFixture,
  s: HumanDirectScene,
  requestId: string,
  count: number,
) {
  await assertOwnedStack(f.stack.config);
  ensure(
    f.rooms.get(s.scope.roomId) === s.scope.organizationId &&
      f.stack.organizations.has(s.scope.organizationId) &&
      f.stack.users.has(s.owner.id),
    "Unowned retirement paging scope",
  );
  ensure(Number.isInteger(count) && count > 0 && count <= 64, "Unbounded retirement paging seed");
  const owned = await f.stack.db.query(
    "select t.* from workflow_private.direct_retirements t join workflow_private.requests r on r.id=t.request_id where t.request_id=$1 and t.room_id=$2 and t.owner_id=$3 and r.owner_id=$3",
    [requestId, s.scope.roomId, s.owner.id],
  );
  ensure(owned.rowCount === 1, "Unowned retirement paging template");
  const original = owned.rows[0];
  await f.stack.db.query("begin");
  try {
    await f.stack.db.query("select workflow_private.lock_room($1)", [s.scope.roomId]);
    for (let i = 0; i < count; i++) {
      const cycleId = randomUUID(),
        questionId = randomUUID(),
        nextRequestId = randomUUID(),
        attemptId = randomUUID();
      await f.stack.db.query(
        "insert into workflow_private.cycles select (jsonb_populate_record(null::workflow_private.cycles,to_jsonb(c)||jsonb_build_object('id',$1::uuid,'retired_at',clock_timestamp()))).* from workflow_private.cycles c where id=$2 and room_id=$3",
        [cycleId, original.cycle_id, s.scope.roomId],
      );
      await f.stack.db.query(
        "insert into workflow_private.generations select (jsonb_populate_record(null::workflow_private.generations,to_jsonb(g)||jsonb_build_object('cycle_id',$1::uuid))).* from workflow_private.generations g where cycle_id=$2",
        [cycleId, original.cycle_id],
      );
      await f.stack.db.query(
        "insert into workflow_private.requests select (jsonb_populate_record(null::workflow_private.requests,to_jsonb(r)||jsonb_build_object('id',$1::uuid,'cycle_id',$2::uuid,'question_id',$3::uuid,'created_at',clock_timestamp()+$4::int*interval '1 second'))).* from workflow_private.requests r where id=$5 and room_id=$6",
        [nextRequestId, cycleId, questionId, i + 1, requestId, s.scope.roomId],
      );
      await f.stack.db.query(
        "insert into workflow_private.questions select (jsonb_populate_record(null::workflow_private.questions,to_jsonb(q)||jsonb_build_object('id',$1::uuid,'cycle_id',$2::uuid))).* from workflow_private.questions q where cycle_id=$3",
        [questionId, cycleId, original.cycle_id],
      );
      await f.stack.db.query(
        "insert into workflow_private.attempts select (jsonb_populate_record(null::workflow_private.attempts,to_jsonb(a)||jsonb_build_object('id',$1::uuid,'request_id',$2::uuid))).* from workflow_private.attempts a where id=$3 and request_id=$4",
        [attemptId, nextRequestId, original.attempt_id, requestId],
      );
      await f.stack.db.query(
        "update workflow_private.rooms set revision=revision+1 where room_id=$1",
        [s.scope.roomId],
      );
      await f.stack.db.query(
        "insert into workflow_private.direct_retirements select (jsonb_populate_record(null::workflow_private.direct_retirements,to_jsonb(t)||jsonb_build_object('request_id',$1::uuid,'cycle_id',$2::uuid,'attempt_id',$3::uuid,'room_revision',(select revision from workflow_private.rooms where room_id=$4),'retirement_sequence',(select max(retirement_sequence)+1 from workflow_private.direct_retirements where room_id=$4),'retired_at',clock_timestamp()))).* from workflow_private.direct_retirements t where request_id=$5",
        [nextRequestId, cycleId, attemptId, s.scope.roomId, requestId],
      );
      await f.captureResponse({ requestId: nextRequestId, cycleId, questionId, attemptId });
    }
    await f.stack.db.query("commit");
  } catch (error) {
    await f.stack.db.query("rollback");
    throw error;
  }
}
