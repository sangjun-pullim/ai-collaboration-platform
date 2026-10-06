import { randomUUID } from "node:crypto";
import { ensure, assertOwnedStack, type FixturePerson } from "./local-access-stack.js";
import type { DeviceProfile } from "./device-binding-fixture.js";
import type { WorkflowFixture } from "./workflow-fixture.js";
import {
  capabilityHash,
  projectResponse,
  type Body,
  type HumanAction,
  type DeviceAction,
  type Receipt,
  type SettingsResponse,
  type Capability,
} from "../../src/features/runtime-settings/contracts.ts";
export function settingsCatalog(): Capability {
  const contents = {
    runtime: "claude" as const,
    version: "synthetic-1",
    models: [
      { id: "model-one", model: "model-one", efforts: [], defaultEffort: null, isDefault: true },
    ],
    defaultSettings: { model: "model-one", effort: null },
    policy: "verified" as const,
  };
  return { ...contents, snapshotHash: capabilityHash(contents) };
}
export class RuntimeSettingsFixture {
  constructor(readonly workflow: WorkflowFixture) {}
  async requireMigration() {
    await assertOwnedStack(this.workflow.stack.config);
    const r = await this.workflow.stack.db.query(
      "select to_regprocedure('public.runtime_settings_device(text,jsonb,text)') is not null installed",
    );
    ensure(r.rows[0].installed, "Runtime settings requires supervising migration installation");
  }
  async human(person: FixturePerson, action: HumanAction, body: Body) {
    const r = await person.web.post(`/api/runtime-settings/${action}`, body);
    return { status: r.status, data: await r.json() };
  }
  async device(p: DeviceProfile, action: DeviceAction, body: Body, credential = p.credential) {
    ensure(credential, "Owned credential required");
    const r = await fetch(`${this.workflow.stack.config.app}/api/runtime-settings/${action}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  accepted(r: { status: number; data: unknown }): SettingsResponse {
    ensure(r.status === 200, "Owned settings request failed");
    const e = r.data as { ok: boolean; data: unknown };
    ensure(e.ok === true, "Owned settings envelope failed");
    return projectResponse(e.data);
  }
  async prepare(person: FixturePerson, p: DeviceProfile, readMode?: "AUTO_CODE") {
    const current = this.accepted(await this.human(person, "list", { deviceId: p.deviceId }));
    const base = {
      operationId: randomUUID(),
      deviceId: p.deviceId!,
      expectedConfigRevision: current.configRevision,
      runtime: "claude",
    };
    this.accepted(await this.human(person, "select-folder", base));
    const catalog = settingsCatalog();
    const local: Receipt = {
      operationId: base.operationId,
      ...(readMode ? { readMode } : {}),
      state: "LOCAL_CONFIRMATION",
      configRevision: current.configRevision,
      runtime: "claude",
      model: null,
      effort: null,
      snapshotHash: null,
      localRootReference: randomUUID(),
      repositoryAlias: "공유 저장소",
      sessionAlias: null,
      catalog,
      bindingEpoch: null,
      agentId: null,
      workspaceId: null,
    };
    this.accepted(await this.device(p, "receipt", local));
    const selected = {
      ...base,
      runtime: "claude",
      model: "model-one",
      effort: null,
      snapshotHash: catalog.snapshotHash,
    };
    this.accepted(await this.human(person, "select-runtime", selected));
    const apply = {
      ...selected,
      ...(local.readMode ? { readMode: local.readMode } : {}),
      localRootReference: local.localRootReference,
      repositoryAlias: local.repositoryAlias,
      sessionAlias: "내 AI",
      expectedEpoch: current.currentBinding?.bindingEpoch ?? null,
    };
    const commit: Receipt = {
      operationId: base.operationId,
      ...(local.readMode ? { readMode: local.readMode } : {}),
      state: "COMMITTED",
      configRevision: current.configRevision + 1,
      runtime: "claude",
      model: "model-one",
      effort: null,
      snapshotHash: catalog.snapshotHash,
      localRootReference: local.localRootReference,
      repositoryAlias: local.repositoryAlias,
      sessionAlias: "내 AI",
      catalog: null,
      bindingEpoch: current.currentBinding ? current.currentBinding.bindingEpoch + 1 : 1,
      agentId: current.currentBinding?.agentId ?? null,
      workspaceId: current.currentBinding?.workspaceId ?? null,
    };
    return { base, local, selected, apply, commit };
  }
  async expireCommit(p: DeviceProfile, operationId: string) {
    await assertOwnedStack(this.workflow.stack.config);
    ensure(this.workflow.devices.profiles.has(p.name), "Unowned settings identity");
    const r = await this.workflow.stack.db.query(
      "update runtime_settings_private.operations set created_at=clock_timestamp()-interval '121 seconds' where device_id=$1 and operation_id=$2 returning operation_id",
      [p.deviceId, operationId],
    );
    ensure(r.rowCount === 1, "Exact operation required");
  }
}

export type SettingsUpgradeEvidence = {
  scene: Awaited<ReturnType<WorkflowFixture["scene"]>>;
  claimBody: { operationId: string; requestId: string };
  claimReceipt: unknown;
  wrapperDefinitions: { identity: string; hash: string }[];
  history: Awaited<ReturnType<WorkflowFixture["history"]>>;
};
async function preservedWrappers(f: WorkflowFixture) {
  const result = await f.stack.db.query<{
    identity: string;
    hash: string;
  }>(`select p.oid::regprocedure::text identity,md5(p.prosrc) hash from pg_proc p
    where p.oid in ('workflow_private.history(uuid,bigint,uuid)'::regprocedure,
    'workflow_private.human(text,jsonb)'::regprocedure,'workflow_private.device(text,jsonb,text)'::regprocedure)
    order by p.oid::regprocedure::text`);
  return result.rows;
}
/** The supervisor installs only the additive migration between capture and verification. */
export async function captureSettingsUpgradeEvidence(
  f: WorkflowFixture,
): Promise<SettingsUpgradeEvidence> {
  await assertOwnedStack(f.stack.config);
  const absent = await f.stack.db.query(
    "select to_regprocedure('public.runtime_settings_device(text,jsonb,text)') is null absent",
  );
  ensure(
    absent.rows[0].absent,
    "Upgrade capture requires the existing 001–009 stack; never reset migrations",
  );
  const scene = await f.scene("settings-upgrade");
  const admission = await f.start(scene);
  const claimBody = { operationId: randomUUID(), requestId: admission.requestId! };
  const claimed = await f.device(scene.origin, "claim", claimBody);
  ensure(claimed.status === 200, "Owned legacy claim failed");
  const attempt = claimed.data.data as Parameters<WorkflowFixture["intent"]>[1];
  await f.intent(scene.origin, attempt);
  await f.expire("lease", attempt.attemptId);
  await f.poll(scene.origin);
  const replay = await f.device(scene.origin, "claim", claimBody);
  ensure(replay.status === 200, "Owned legacy replay failed");
  return {
    scene,
    claimBody,
    claimReceipt: replay.data.data,
    wrapperDefinitions: await preservedWrappers(f),
    history: await f.history(scene),
  };
}
export async function verifySettingsUpgradeEvidence(
  f: WorkflowFixture,
  evidence: SettingsUpgradeEvidence,
) {
  const r = new RuntimeSettingsFixture(f);
  await r.requireMigration();
  ensure(
    f.rooms.get(evidence.scene.scope.roomId) === evidence.scene.scope.organizationId,
    "Exact owned upgrade room required",
  );
  ensure(
    JSON.stringify(await preservedWrappers(f)) === JSON.stringify(evidence.wrapperDefinitions),
    "DIRECT wrapper execution definitions must be preserved",
  );
  const replay = await f.device(evidence.scene.origin, "claim", evidence.claimBody);
  ensure(
    replay.status === 200 &&
      JSON.stringify(replay.data.data) === JSON.stringify(evidence.claimReceipt),
    "Existing UNKNOWN receipt must replay exactly",
  );
  const history = await f.history(evidence.scene);
  for (const field of ["events", "runs", "cycle"] as const)
    ensure(
      JSON.stringify(history[field]) === JSON.stringify(evidence.history[field]),
      "Legacy events runs and cycle must remain unchanged",
    );
  const operation = await r.prepare(evidence.scene.owner, evidence.scene.origin);
  ensure(
    (await r.human(evidence.scene.owner, "apply", operation.apply)).status === 409,
    "Legacy UNKNOWN evidence must block settings after upgrade",
  );
}
