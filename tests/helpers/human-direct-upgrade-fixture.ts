import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { WorkflowFixture, WorkflowScene, HumanDirectScene } from "./workflow-fixture.js";
import { requireHumanDirectMigration } from "./human-direct-fixture.js";
import { assertOwnedStack, ensure } from "./local-access-stack.js";
import { validateBody, type AttemptSnapshot, type Body, type HistoryPage } from "../../src/features/investigation-coordinator/contracts.ts";

export interface LegacyUpgradeEvidence {
  scene: WorkflowScene;
  completedCycleId: string;
  unknownClaimBody: Body;
  unknownClaimReceipt: AttemptSnapshot;
  history: HistoryPage;
}

/** Root calls this before additive SQL007 installation, retaining the live fixture. */
export async function captureLegacyUpgradeEvidence(fixture: WorkflowFixture): Promise<LegacyUpgradeEvidence> {
  await assertOwnedStack(fixture.stack.config);
  const absent = await fixture.stack.db.query("select to_regprocedure('public.workflow_human_ask(jsonb)') is null legacy");
  ensure(absent.rows[0].legacy === true, "Upgrade capture requires the pre-007 stack; never reset or reapply migrations");
  const scene = await fixture.scene("human-direct-upgrade");
  const admission = await fixture.start(scene);
  const origin = await fixture.run(scene.origin, admission.requestId!);
  const question = await fixture.question(scene.origin, origin);
  const peer = await fixture.run(scene.responder, question.peerRequestId!);
  await fixture.complete(scene.origin, origin);
  const answer = await fixture.complete(scene.responder, peer);
  ensure(answer.continuationRequestId, "Legacy continuation missing");
  await fixture.complete(scene.origin, await fixture.run(scene.origin, answer.continuationRequestId));
  const second = await fixture.start(scene);
  const unknownClaimBody = { operationId: randomUUID(), requestId: second.requestId! };
  const response = await fixture.device(scene.origin, "claim", unknownClaimBody);
  ensure(response.status === 200, "Legacy owned claim failed");
  const leased = response.data.data as AttemptSnapshot;
  await fixture.intent(scene.origin, leased);
  await fixture.expire("lease", leased.attemptId);
  await fixture.poll(scene.origin);
  const replay = await fixture.device(scene.origin, "claim", unknownClaimBody);
  ensure(replay.status === 200, "Legacy original receipt recovery failed");
  const unknownClaimReceipt = replay.data.data as AttemptSnapshot;
  ensure(unknownClaimReceipt.state === "UNKNOWN", "Legacy unknown proof missing");
  return { scene, completedCycleId: admission.cycleId, unknownClaimBody, unknownClaimReceipt,
    history: await fixture.history(scene) };
}

/** Root applies only the new migration between capture and verify; this helper never installs SQL. */
export async function verifyLegacyUpgradeEvidence(fixture: WorkflowFixture, evidence: LegacyUpgradeEvidence) {
  await assertOwnedStack(fixture.stack.config);
  await requireHumanDirectMigration(fixture);
  ensure(fixture.rooms.get(evidence.scene.scope.roomId) === evidence.scene.scope.organizationId,
    "Unowned legacy upgrade scene");
  assert.deepEqual(await fixture.history(evidence.scene), evidence.history);
  const replay = await fixture.device(evidence.scene.origin, "claim", evidence.unknownClaimBody);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.data, evidence.unknownClaimReceipt);
  const cycles = await fixture.stack.db.query(`select mode,
    origin_agent_id is not null origin_present, origin_epoch is not null epoch_present
    from workflow_private.cycles where room_id=$1 order by created_at,id`, [evidence.scene.scope.roomId]);
  assert.equal(cycles.rowCount, 2);
  assert.ok(cycles.rows.every(row => row.mode === "AI_PAIR" && row.origin_present && row.epoch_present));
  const questions = await fixture.stack.db.query(`select q.source,q.requester_user_id,
    q.origin_request_id is not null origin_request_present, q.origin_epoch is not null origin_epoch_present
    from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id
    where c.id=$1 and c.room_id=$2`, [evidence.completedCycleId, evidence.scene.scope.roomId]);
  assert.deepEqual(questions.rows, [{ source: "AI", requester_user_id: null,
    origin_request_present: true, origin_epoch_present: true }]);
}

type DirectOperation = { action: "ask" | "cancel"; body: Body; result: Record<string, unknown> };
export interface ActorPreconditionUpgradeEvidence {
  scene: HumanDirectScene;
  operations: DirectOperation[];
  history: HistoryPage;
  receipts: Record<string, unknown>[];
  originalFunctions: Record<string, unknown>[];
}

async function originalFunctions(fixture: WorkflowFixture) {
  const result = await fixture.stack.db.query(`select p.oid::regprocedure::text identity,
    md5(pg_get_functiondef(p.oid)) definition_hash from pg_proc p
    where p.oid in ('workflow_private.human(text,jsonb)'::regprocedure,
      'workflow_private.validate(text,jsonb)'::regprocedure) order by p.oid::regprocedure::text`);
  return result.rows;
}

async function directReceipts(fixture: WorkflowFixture, scene: HumanDirectScene) {
  ensure(fixture.rooms.get(scene.scope.roomId) === scene.scope.organizationId
    && fixture.stack.users.has(scene.requester.id), "Unowned direct receipt evidence");
  const result = await fixture.stack.db.query(`select * from workflow_private.receipts
    where room_id=$1 and actor_kind='human' and actor_id=$2 and action in ('ask','cancel')
    order by operation_id`, [scene.scope.roomId, scene.requester.id]);
  return result.rows;
}

/** Root retains this live fixture across installation of SQL008; no migration execution here. */
export async function captureActorPreconditionUpgradeEvidence(fixture: WorkflowFixture): Promise<ActorPreconditionUpgradeEvidence> {
  await assertOwnedStack(fixture.stack.config);
  await requireHumanDirectMigration(fixture);
  const absent = await fixture.stack.db.query("select to_regprocedure('workflow_private.human_actor(text,jsonb)') is null legacy");
  ensure(absent.rows[0].legacy === true, "Actor upgrade capture requires SQL007 before SQL008; never reset migrations");
  const scene = await fixture.directScene("actor-upgrade");
  const operations: DirectOperation[] = [];
  const askBody = async (publicText: string) => validateBody("ask", {
    protocol: 1, roomId: scene.scope.roomId, operationId: randomUUID(), expectedUserId: scene.requester.id,
    targetAgentId: scene.responder.agentId!, targetEpoch: await fixture.epoch(scene.responder),
    expectedRoomRevision: (await fixture.read(scene, scene.requester)).roomRevision, publicText, confirmed: true,
  });
  const firstBody = await askBody("  한글 기존 직접 질문  ");
  const first = await fixture.legacyDirect(scene.requester, "ask", firstBody);
  ensure(typeof first.requestId === "string", "Legacy direct request missing");
  await fixture.complete(scene.responder, await fixture.run(scene.responder, first.requestId));
  await fixture.ready(scene.responder);
  const secondBody = await askBody("기존 취소 receipt");
  const second = await fixture.legacyDirect(scene.requester, "ask", secondBody);
  ensure(typeof second.requestId === "string", "Legacy cancellable request missing");
  const cancelBody = validateBody("cancel", { protocol: 1, roomId: scene.scope.roomId,
    operationId: randomUUID(), expectedUserId: scene.requester.id, requestId: second.requestId,
    expectedRoomRevision: (await fixture.read(scene, scene.requester)).roomRevision });
  await fixture.legacyDirect(scene.requester, "cancel", cancelBody);
  // Compare replay responses after terminal transitions, not the original ACTIVE response.
  for (const [action, body] of [["ask", firstBody], ["ask", secondBody], ["cancel", cancelBody]] as const) {
    operations.push({ action, body, result: await fixture.legacyDirect(scene.requester, action, body) });
  }
  const receipts = await directReceipts(fixture, scene);
  assert.equal(receipts.length, 3);
  return { scene, operations, receipts, history: await fixture.history(scene, scene.requester),
    originalFunctions: await originalFunctions(fixture) };
}

/** Root applies SQL008 once between capture and verify; all assertions use exact owned IDs. */
export async function verifyActorPreconditionUpgradeEvidence(fixture: WorkflowFixture, evidence: ActorPreconditionUpgradeEvidence) {
  await assertOwnedStack(fixture.stack.config);
  await assertActorPreconditionSchema(fixture, evidence.scene);
  assert.deepEqual(await originalFunctions(fixture), evidence.originalFunctions);
  assert.deepEqual(await fixture.history(evidence.scene, evidence.scene.requester), evidence.history);
  for (const operation of evidence.operations) {
    const replay = await fixture.human(evidence.scene.requester, operation.action, operation.body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data.data, operation.result);
    const { expectedUserId: omitted, ...oldBody } = operation.body;
    void omitted;
    const missing = await evidence.scene.requester.web.dataClient().rpc(`workflow_human_${operation.action}`, { p_body: oldBody });
    assert.equal(missing.error?.message, "INVALID_BODY");
  }
  assert.deepEqual(await directReceipts(fixture, evidence.scene), evidence.receipts);
  assert.deepEqual(await fixture.history(evidence.scene, evidence.scene.requester), evidence.history);
}

/** Definition, privilege and owned query-plan evidence, without performance claims. */
export async function assertActorPreconditionSchema(fixture: WorkflowFixture, scene: HumanDirectScene) {
  await assertOwnedStack(fixture.stack.config);
  ensure(fixture.rooms.get(scene.scope.roomId) === scene.scope.organizationId, "Unowned index probe");
  const functions = await fixture.stack.db.query(`select p.oid::regprocedure::text identity,
    p.prosecdef and p.proconfig @> array['search_path=""'] secured,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
      where acl.grantee=0 and acl.privilege_type='EXECUTE') public_execute
    from pg_proc p where p.oid in (
      to_regprocedure('workflow_private.human_actor(text,jsonb)'),
      'public.workflow_human_ask(jsonb)'::regprocedure,'public.workflow_human_cancel(jsonb)'::regprocedure)`);
  assert.equal(functions.rowCount, 3);
  for (const row of functions.rows) {
    assert.equal(row.secured, true);
    assert.equal(row.anon_execute, false);
    assert.equal(row.public_execute, false);
    assert.equal(row.authenticated_execute, !row.identity.startsWith("workflow_private."));
  }
  const index = await fixture.stack.db.query(`select am.amname='btree' and i.indisvalid and not i.indisunique
    and i.indpred is null and i.indexprs is null and i.indnatts=1 and i.indnkeyatts=1
    and a.attname='cycle_id' correct
    from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid
    join pg_am am on am.oid=c.relam join pg_attribute a on a.attrelid=t.oid and a.attnum=i.indkey[0]
    where c.oid=to_regclass('workflow_private.workflow_questions_cycle')
      and t.oid='workflow_private.questions'::regclass`);
  assert.deepEqual(index.rows, [{ correct: true }]);
  const cycle = await fixture.stack.db.query("select id from workflow_private.cycles where room_id=$1 order by created_at,id limit 1", [scene.scope.roomId]);
  ensure(cycle.rowCount === 1 && fixture.identities.get("cycleId")?.has(cycle.rows[0].id), "Missing owned cycle plan identity");
  await fixture.stack.db.query("begin");
  try {
    await fixture.stack.db.query("set local enable_seqscan=off");
    const explained = await fixture.stack.db.query("explain (format json) select id from workflow_private.questions where cycle_id=$1", [cycle.rows[0].id]);
    const indexes: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      if (typeof object["Index Name"] === "string") indexes.push(object["Index Name"]);
      for (const child of Object.values(object)) visit(child);
    };
    visit(explained.rows[0]["QUERY PLAN"]);
    assert.ok(indexes.includes("workflow_questions_cycle"));
  } finally { await fixture.stack.db.query("rollback"); }
}
