import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { open, rename, rm, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import {
  DeviceFixture,
  assertDeviceMigrationSources,
  secret,
  type DeviceProfile,
  type DeviceResponse,
} from "./device-binding-fixture.js";
import {
  assertOwnedStack,
  productEnvironment,
  ensure,
  type FixturePerson,
} from "./local-access-stack.js";
import { authBrowserChildEnvironment } from "./auth-browser-artifact-policy.js";
import { SourceBrowserRegistry } from "./source-browser-fixture.js";
import {
  sourceRead,
  sourceFixtureAutoManifest,
  uploadFixtureSource,
} from "./shared-source-history-fixture.js";
import {
  projectEnvelope,
  validateBody,
  type Action,
  type HumanAction,
  type DeviceAction,
  type Body,
  type HistoryPage,
  type AttemptSnapshot,
  type CycleAdmission,
  type PollSnapshot,
  type TerminalReceipt,
} from "../../src/features/investigation-coordinator/contracts.js";
export type WorkflowScene = {
  scope: { organizationId: string; roomId: string };
  owner: FixturePerson;
  peer: FixturePerson;
  observer: FixturePerson;
  outsider: FixturePerson;
  origin: DeviceProfile;
  responder: DeviceProfile;
};
export type HumanDirectScene = {
  scope: WorkflowScene["scope"];
  owner: FixturePerson;
  requester: FixturePerson;
  observer: FixturePerson;
  outsider: FixturePerson;
  responder: DeviceProfile;
};
function profileName(name: string) {
  if (/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) return name;
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 24);
  const stem =
    name
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, 15)
      .replace(/-+$/, "") || "profile";
  return `${stem}-${suffix}`;
}
function safe(error: unknown, stage: string) {
  const frame =
    error instanceof Error
      ? error.stack?.match(
          /\/(investigation-coordinator\.test|workflow-fixture)\.(?:js|ts):(\d+):(\d+)/,
        )
      : null;
  return new Error(
    `Owned workflow ${stage} failed${frame ? ` at ${frame[1]}:${frame[2]}:${frame[3]}` : ""}; private diagnostics withheld`,
  );
}
export class WorkflowFixture {
  readonly rooms = new Map<string, string>();
  readonly identities = new Map<string, Set<string>>();
  readonly operations: { roomId: string; actorId: string; action: Action; operationId: string }[] =
    [];
  private writes: Promise<void> = Promise.resolve();
  private actorKinds = new Map<string, "human" | "device">();
  private constructor(readonly devices: DeviceFixture) {
    const previous = devices.stack.onOwnedIdentity;
    devices.stack.onOwnedIdentity = async () => {
      await previous?.();
      await this.save();
    };
  }
  get stack() {
    return this.devices.stack;
  }
  static async open(label: string) {
    await assertDeviceMigrationSources();
    const devices = await DeviceFixture.open(`workflow-${label}`);
    try {
      const installed = await devices.stack.db.query(
        "select to_regclass('workflow_private.attempts') is not null installed,to_regprocedure('public.workflow_device_claim(jsonb,text)') is not null claim",
      );
      ensure(
        installed.rows[0].installed && installed.rows[0].claim,
        "Workflow migration requires supervising installation",
      );
      const f = new WorkflowFixture(devices);
      await f.save();
      return f;
    } catch (e) {
      await devices.close();
      throw safe(e, "setup");
    }
  }
  async save() {
    const pending = this.writes.then(async () => {
      await this.devices.saveCleanupIdentity();
      const file = join(this.devices.root, "workflow-identity.json");
      try {
        const s = await lstat(file);
        ensure(
          s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o777) === 0o600,
          "Unsafe workflow identity",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const identity = {
        version: 1,
        namespace: this.stack.namespace,
        project: this.stack.config.project,
        rooms: [...this.rooms].map(([id, organizationId]) => ({ id, organizationId })),
        users: [...this.stack.users],
        organizations: [...this.stack.organizationOwners].map(([id, ownerUserId]) => ({
          id,
          ownerUserId,
        })),
        bindings: [...this.devices.profiles.values()].map((p) => ({
          name: p.name,
          deviceId: p.deviceId,
          agentId: p.agentId,
          ownerUserId: p.ownerUserId,
          roomId: p.roomId,
        })),
        records: Object.fromEntries([...this.identities].map(([k, v]) => [k, [...v]])),
        operations: this.operations,
      };
      const temporary = join(this.devices.root, `.workflow-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(JSON.stringify(identity));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, file);
        const parent = await open(
          this.devices.root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } finally {
        await handle?.close();
        await rm(temporary, { force: true });
      }
    });
    this.writes = pending.catch(() => {});
    return pending;
  }
  private capture(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (
        [
          "cycleId",
          "requestId",
          "attemptId",
          "eventId",
          "questionId",
          "controlId",
          "continuationRequestId",
          "peerRequestId",
        ].includes(k) &&
        typeof v === "string"
      ) {
        const key = k === "continuationRequestId" || k === "peerRequestId" ? "requestId" : k;
        const ids = this.identities.get(key) ?? new Set();
        ids.add(v);
        this.identities.set(key, ids);
      } else if (v && typeof v === "object") this.capture(v);
    }
  }
  async scene(label = "main"): Promise<WorkflowScene> {
    const owner = await this.stack.person(`${label}-owner`),
      peer = await this.stack.person(`${label}-peer`),
      observer = await this.stack.person(`${label}-observer`),
      outsider = await this.stack.person(`${label}-outsider`);
    const scope = await this.stack.bootstrap(owner);
    this.rooms.set(scope.roomId, scope.organizationId);
    await this.save();
    await this.stack.join(peer, await this.stack.invite(owner, scope.roomId), "질문 참가자");
    await this.stack.join(
      observer,
      await this.stack.invite(owner, scope.roomId, "observer"),
      "관찰자",
    );
    const origin = await this.devices.register(
      await this.devices.connected(owner, scope, profileName(`${label}-origin`)),
    );
    const responder = await this.devices.register(
      await this.devices.connected(peer, scope, profileName(`${label}-peer`)),
    );
    await this.ready(origin);
    await this.ready(responder);
    return { scope, owner, peer, observer, outsider, origin, responder };
  }
  async captureResponse(value: unknown) {
    this.capture(value);
    await this.save();
  }
  async directScene(label = "direct"): Promise<HumanDirectScene> {
    const owner = await this.stack.person(`${label}-owner`);
    const requester = await this.stack.person(`${label}-requester`);
    const observer = await this.stack.person(`${label}-observer`);
    const outsider = await this.stack.person(`${label}-outsider`);
    const scope = await this.stack.bootstrap(owner);
    this.rooms.set(scope.roomId, scope.organizationId);
    await this.save();
    await this.stack.join(requester, await this.stack.invite(owner, scope.roomId), "질문 참가자");
    await this.stack.join(
      observer,
      await this.stack.invite(owner, scope.roomId, "observer"),
      "관찰자",
    );
    const responder = await this.devices.register(
      await this.devices.connected(owner, scope, profileName(`${label}-responder`)),
    );
    await this.ready(responder);
    ensure(
      ![...this.devices.profiles.values()].some((profile) => profile.ownerUserId === requester.id),
      "Requester must have no local device profile",
    );
    return { scope, owner, requester, observer, outsider, responder };
  }
  async ask(s: HumanDirectScene, operationId = randomUUID(), publicText = "한글 직접 질문") {
    const history = await this.read(s, s.requester);
    const response = await this.human(s.requester, "ask", {
      roomId: s.scope.roomId,
      operationId,
      targetAgentId: s.responder.agentId!,
      targetEpoch: await this.epoch(s.responder),
      expectedRoomRevision: history.roomRevision,
      publicText,
      confirmed: true,
    });
    ensure(response.status === 200, "Human direct admission failed");
    return response.data.data as CycleAdmission;
  }
  async legacyDirect(person: FixturePerson, action: "ask" | "cancel", fields: Body) {
    ensure(
      this.stack.users.has(person.id) && this.rooms.has(String(fields.roomId)),
      "Unowned legacy direct actor",
    );
    const checked = validateBody(action, { protocol: 1, expectedUserId: person.id, ...fields });
    ensure(checked.expectedUserId === person.id, "Legacy fixture actor mismatch");
    const { expectedUserId: omitted, ...body } = checked;
    void omitted;
    this.actorKinds.set(person.id, "human");
    this.operations.push({
      roomId: String(body.roomId),
      actorId: person.id,
      action,
      operationId: String(body.operationId),
    });
    await this.save();
    // Only root uses this before SQL008; the new web contract cannot submit an old body.
    const response = await person.web
      .dataClient()
      .rpc(`workflow_human_${action}`, { p_body: body });
    ensure(!response.error, "Owned legacy direct RPC failed");
    projectEnvelope(action, { ok: true, data: response.data }, 200);
    this.capture(response.data);
    await this.save();
    return response.data as Record<string, unknown>;
  }
  async human(person: FixturePerson, action: HumanAction, fields: Body): Promise<DeviceResponse> {
    ensure(
      this.stack.users.has(person.id) && this.rooms.has(String(fields.roomId)),
      "Unowned workflow request",
    );
    this.actorKinds.set(person.id, "human");
    const body = validateBody(action, {
      protocol: 1,
      ...(action === "ask" || action === "cancel" || action === "input-control"
        ? { expectedUserId: person.id }
        : {}),
      ...fields,
    });
    if (action === "input-control")
      ensure(body.expectedUserId === person.id, "Workflow input actor mismatch");
    if (!["read", "input-state"].includes(action))
      this.operations.push({
        roomId: String(body.roomId),
        actorId: person.id,
        action,
        operationId: String(body.operationId),
      });
    await this.save();
    const response = await person.web.post(`/api/investigations/${action}`, body);
    const text = await response.text();
    const data = JSON.parse(text);
    if (response.status === 200) {
      projectEnvelope(action, data, response.status);
      this.capture(data);
      await this.save();
    }
    return { status: response.status, headers: response.headers, text, data };
  }
  async recordOwnedInputControl(person: FixturePerson, fields: Body) {
    const body = validateBody("input-control", {
      protocol: 1,
      expectedUserId: person.id,
      ...fields,
    });
    ensure(
      this.stack.users.has(person.id) &&
        this.rooms.has(String(body.roomId)) &&
        body.expectedUserId === person.id &&
        [...this.devices.profiles.values()].some(
          (profile) =>
            profile.ownerUserId === person.id &&
            profile.agentId === body.agentId &&
            profile.roomId === body.roomId,
        ),
      "Exact owned input-control actor and binding required",
    );
    this.actorKinds.set(person.id, "human");
    this.operations.push({
      roomId: String(body.roomId),
      actorId: person.id,
      action: "input-control",
      operationId: String(body.operationId),
    });
    await this.save();
    return body;
  }
  async device(
    p: DeviceProfile,
    action: DeviceAction,
    fields: Body = {},
    credential = p.credential,
  ): Promise<DeviceResponse> {
    ensure(
      this.devices.profiles.get(p.name) === p && p.roomId && this.rooms.has(p.roomId),
      "Unowned workflow binding",
    );
    this.actorKinds.set(p.deviceId!, "device");
    const body = validateBody(action, {
      protocol: 1,
      agentId: p.agentId!,
      bindingEpoch: await this.epoch(p),
      ...fields,
    });
    if (
      typeof body.operationId === "string" &&
      !["poll", "admission", "admission-ack"].includes(action)
    )
      this.operations.push({
        roomId: p.roomId,
        actorId: p.deviceId!,
        action,
        operationId: body.operationId,
      });
    await this.save();
    const response = await fetch(`${this.stack.config.app}/api/workflow/${action}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const data = JSON.parse(text);
    if (response.status === 200) {
      projectEnvelope(action, data, response.status);
      this.capture(data);
      await this.save();
    }
    return { status: response.status, headers: response.headers, text, data };
  }
  async epoch(p: DeviceProfile) {
    ensure(p.agentId && this.devices.profiles.get(p.name) === p, "Unowned epoch lookup");
    const row = await this.stack.db.query(
      "select binding_epoch from device_binding_private.agents where id=$1 and device_id=$2 and room_id=$3",
      [p.agentId, p.deviceId, p.roomId],
    );
    return Number(row.rows[0]?.binding_epoch ?? 1);
  }
  async ready(p: DeviceProfile, reportedReady = true, operationId = randomUUID()) {
    return this.device(p, "ready", { operationId, reportedReady });
  }
  async read(s: Pick<WorkflowScene, "scope" | "owner">, person = s.owner, afterSequence = 0) {
    const response = await this.human(person, "read", { roomId: s.scope.roomId, afterSequence });
    ensure(response.status === 200, "Workflow read failed");
    return response.data.data as HistoryPage;
  }
  async history(s: Pick<WorkflowScene, "scope" | "owner">, person = s.owner) {
    let cursor = 0;
    const events: HistoryPage["events"] = [];
    let page: HistoryPage;
    do {
      page = await this.read(s, person, cursor);
      events.push(...page.events);
      ensure(page.nextCursor >= cursor, "History cursor moved backwards");
      cursor = page.nextCursor;
    } while (page.hasMore);
    return { ...page, events };
  }
  async start(s: WorkflowScene, operationId = randomUUID()) {
    const history = await this.read(s);
    const response = await this.human(s.owner, "start", {
      roomId: s.scope.roomId,
      operationId,
      originAgentId: s.origin.agentId!,
      peerAgentId: s.responder.agentId!,
      originEpoch: await this.epoch(s.origin),
      peerEpoch: await this.epoch(s.responder),
      expectedRoomRevision: history.roomRevision,
      publicText: "합성 공개 조사",
      confirmed: true,
    });
    ensure(response.status === 200, "Workflow start failed");
    return response.data.data as CycleAdmission;
  }
  async poll(p: DeviceProfile) {
    const r = await this.device(p, "poll");
    ensure(r.status === 200, "Workflow poll failed");
    return r.data.data as PollSnapshot;
  }
  async claim(p: DeviceProfile, requestId: string) {
    await this.ready(p);
    const r = await this.device(p, "claim", { operationId: randomUUID(), requestId });
    ensure(r.status === 200, "Workflow claim failed");
    return r.data.data as AttemptSnapshot;
  }
  identity(a: AttemptSnapshot) {
    return {
      operationId: randomUUID(),
      requestId: a.requestId,
      attemptId: a.attemptId,
      fence: a.fence,
    };
  }
  async intent(p: DeviceProfile, a: AttemptSnapshot) {
    const r = await this.device(p, "start-intent", this.identity(a));
    ensure(r.status === 200, "Start intent failed");
    return r.data.data as AttemptSnapshot;
  }
  async run(p: DeviceProfile, requestId: string) {
    return this.intent(p, await this.claim(p, requestId));
  }
  async question(p: DeviceProfile, a: AttemptSnapshot) {
    const r = await this.device(p, "question", {
      ...this.identity(a),
      publicText: "합성 공개 질문",
      confirmed: true,
    });
    ensure(r.status === 200, "Addressed question failed");
    return r.data.data as {
      cycleId: string;
      questionId: string | null;
      peerRequestId: string | null;
      accepted: boolean;
      cycleState: string;
    };
  }
  async complete(
    p: DeviceProfile,
    a: AttemptSnapshot,
    terminal: "COMPLETED" | "FAILED" | "INTERRUPTED" = "COMPLETED",
    publicText = "합성 공개 결과",
  ) {
    const r = await this.device(p, "complete", {
      ...this.identity(a),
      terminal,
      publicText: terminal === "COMPLETED" ? publicText : "",
    });
    ensure(r.status === 200, "Terminal report failed");
    return r.data.data as TerminalReceipt;
  }
  async expire(kind: "readiness" | "lease" | "cycle" | "question", id: string) {
    await assertOwnedStack(this.stack.config);
    ensure(
      [...this.stack.users].every((u) => u.length === 36),
      "Invalid fixture identity",
    );
    await this.save();
    const query =
      kind === "readiness"
        ? "select rd.agent_id id,rd.room_id from workflow_private.readiness rd join device_binding_private.agents a on a.id=rd.agent_id where rd.agent_id=$1 and a.owner_user_id=any($2::uuid[])"
        : kind === "lease"
          ? "select a.id,q.room_id from workflow_private.attempts a join workflow_private.requests q on q.id=a.request_id where a.id=$1 and q.owner_id=any($2::uuid[])"
          : kind === "cycle"
            ? "select id,room_id from workflow_private.cycles where id=$1 and origin_owner_id=any($2::uuid[])"
            : "select q.id,c.room_id from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id where q.id=$1 and c.origin_owner_id=any($2::uuid[])";
    const owned = await this.stack.db.query(query, [id, [...this.stack.users]]);
    ensure(
      owned.rowCount === 1 && this.rooms.has(owned.rows[0].room_id),
      "Refusing an unowned timestamp",
    );
    const key =
      kind === "readiness"
        ? "agentId"
        : kind === "lease"
          ? "attemptId"
          : kind === "cycle"
            ? "cycleId"
            : "questionId";
    ensure(
      kind === "readiness"
        ? [...this.devices.profiles.values()].some((p) => p.agentId === id)
        : this.identities.get(key)?.has(id),
      "Timestamp identity was not recorded",
    );
    const statements = {
      readiness:
        "update workflow_private.readiness set valid_until=clock_timestamp()-interval '1 second' where agent_id=$1 and room_id=$2",
      lease:
        "update workflow_private.attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1 and request_id in (select id from workflow_private.requests where room_id=$2)",
      cycle:
        "update workflow_private.cycles set deadline=clock_timestamp()-interval '1 second' where id=$1 and room_id=$2",
      question:
        "update workflow_private.questions set deadline=clock_timestamp()-interval '1 second' where id=$1 and cycle_id in (select id from workflow_private.cycles where room_id=$2)",
    };
    await this.stack.db.query(statements[kind], [id, owned.rows[0].room_id]);
  }
  async count(roomId: string) {
    ensure(this.rooms.has(roomId), "Unowned workflow count");
    const r = await this.stack.db.query(
      "select (select count(*)::int from workflow_private.requests where room_id=$1) requests,(select count(*)::int from workflow_private.attempts a join workflow_private.requests r on r.id=a.request_id where r.room_id=$1) attempts,(select count(*)::int from public.workflow_events where room_id=$1) events,(select sum(runs_reserved)::int from workflow_private.cycles where room_id=$1) budget",
      [roomId],
    );
    return r.rows[0] as {
      requests: number;
      attempts: number;
      events: number;
      budget: number | null;
    };
  }
  async recoverOperations() {
    await assertOwnedStack(this.stack.config);
    for (const op of this.operations) {
      const organizationId = this.rooms.get(op.roomId);
      ensure(
        organizationId && this.stack.organizations.has(organizationId),
        "Unowned operation recovery scope",
      );
      const human = [
        "speak",
        "start",
        "interrupt",
        "pause",
        "resume",
        "ask",
        "cancel",
        "input-control",
      ].includes(op.action);
      ensure(
        this.actorKinds.get(op.actorId) === (human ? "human" : "device"),
        "Unowned operation recovery actor",
      );
      const found = await this.stack.db.query(
        "select x.result from workflow_private.receipts x join public.rooms r on r.id=x.room_id where x.room_id=$1 and r.organization_id=$2 and x.actor_id=$3 and x.actor_kind=$4 and x.operation_id=$5 and x.action=$6",
        [
          op.roomId,
          organizationId,
          op.actorId,
          human ? "human" : "device",
          op.operationId,
          op.action,
        ],
      );
      for (const row of found.rows) this.capture(row.result);
    }
    await this.save();
  }
  async close() {
    const failures: Error[] = [];
    try {
      await this.recoverOperations();
      await this.save();
    } catch (e) {
      failures.push(safe(e, "recovery"));
    }
    try {
      await this.devices.close();
    } catch (e) {
      failures.push(safe(e, "cleanup"));
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned workflow cleanup failed; private diagnostics withheld",
      );
  }
}
export async function workflowCase(label: string, run: (f: WorkflowFixture) => Promise<void>) {
  let f: WorkflowFixture | undefined;
  const failures: Error[] = [];
  try {
    f = await WorkflowFixture.open(label);
    await run(f);
  } catch (e) {
    failures.push(safe(e, "assertion"));
  }
  try {
    await f?.close();
  } catch (e) {
    failures.push(safe(e, "cleanup"));
  }
  if (failures.length)
    throw new AggregateError(failures, "Owned workflow check failed; private diagnostics withheld");
}
export async function runWorkflowBrowserParent() {
  const fixture = await WorkflowFixture.open("browser");
  const token = secret();
  const scenes = new Map<string, WorkflowScene | HumanDirectScene>();
  const directTargets = new Map<string, DeviceProfile[]>();
  const people = new Map<string, FixturePerson>();
  const active = new Map<string, AttemptSnapshot>();
  const steps = new Map<string, Set<string>>();
  const sourceScenes = new SourceBrowserRegistry<WorkflowScene>({
    async prepare(label) {
      await assertOwnedStack(fixture.stack.config);
      const scene = await fixture.scene(label);
      const admission = await fixture.start(scene);
      const attempt = await fixture.run(scene.origin, admission.requestId!);
      const questionOperationId = randomUUID();
      const source = sourceFixtureAutoManifest(questionOperationId);
      await uploadFixtureSource(fixture, scene, attempt, source);
      const asked = await fixture.device(scene.origin, "question", {
        ...fixture.identity(attempt),
        operationId: questionOperationId,
        publicText: "합성 공개 질문",
        confirmed: true,
      });
      ensure(asked.status === 200, "Owned source question failed");
      const questionId = (asked.data.data as { questionId: string }).questionId;
      const question = (await fixture.history(scene)).events.find(
        (event) => event.kind === "QUESTION" && event.questionId === questionId,
      );
      ensure(question, "Owned source question event missing");
      const recipient = await sourceRead(fixture, scene, question.eventId);
      ensure(
        recipient.state === "NO_SOURCE" && recipient.target?.agentId === scene.responder.agentId,
        "Owned source question recipient mismatch",
      );
      await fixture.complete(scene.origin, attempt, "COMPLETED", "당시 저장소의 공개 답변");
      const event = (await fixture.history(scene)).events.find(
        (item) => item.senderKind === "AGENT" && item.publicText === "당시 저장소의 공개 답변",
      );
      ensure(event, "Owned source terminal event missing");
      const original = await sourceRead(fixture, scene, event.eventId);
      ensure(original.manifestHash === source.manifestHash, "Owned source manifest mismatch");
      await fixture.stack.db.query(
        "update device_binding_private.agents set session_alias='Later source session' where id=$1 and device_id=$2 and room_id=$3",
        [scene.origin.agentId, scene.origin.deviceId, scene.scope.roomId],
      );
      const outsider = await scene.outsider.web.post(
        "/api/investigations/source-read",
        validateBody("source-read", {
          protocol: 1,
          roomId: scene.scope.roomId,
          eventId: event.eventId,
          afterIndex: null,
        }),
      );
      ensure(outsider.status === 403, "Owned source outsider access was not refused");
      return {
        state: scene,
        publicScene: {
          roomId: scene.scope.roomId,
          owner: { id: scene.owner.id, displayName: scene.owner.displayName },
          observer: { id: scene.observer.id, displayName: scene.observer.displayName },
          eventId: event.eventId,
          question: { eventId: question.eventId, publicText: question.publicText },
          original,
          recipient,
        },
      };
    },
    async entry(scene, id) {
      const person = [scene.owner, scene.observer].find((person) => person.id === id);
      ensure(person && fixture.stack.users.has(person.id), "Unowned source browser entry");
      const entry = fixture.stack.entryForBrowser(person);
      return {
        code: entry.code,
        cookies: entry.cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
      };
    },
    async dispose(scene) {
      // The parent fixture owns DB/device cleanup in its final close; revoke this registry scope now.
      ensure(
        fixture.rooms.get(scene.scope.roomId) === scene.scope.organizationId,
        "Unowned source browser cleanup",
      );
    },
  });
  const server = createServer(async (req, res) => {
    try {
      ensure(
        req.method === "POST" && typeof req.headers.authorization === "string",
        "Invalid broker request",
      );
      const got = Buffer.from(req.headers.authorization.slice(7)),
        expected = Buffer.from(token);
      ensure(
        req.headers.authorization.startsWith("Bearer ") &&
          got.length === expected.length &&
          timingSafeEqual(got, expected),
        "Invalid broker authority",
      );
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const part of req) {
        size += part.length;
        ensure(size <= 4096, "Oversized broker request");
        chunks.push(part);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, string>;
      let data: unknown;
      if (["/source-setup", "/source-code", "/source-dispose"].includes(req.url ?? "")) {
        data = await sourceScenes.dispatch(req.url!.slice(1), input);
      } else if (req.url === "/setup") {
        ensure(
          Object.keys(input).length === 1 &&
            /^(?:desktop|mobile)-(?:history|control|input-pause|direct-single|direct-multiple|direct-actor|direct-cookie|direct-history)$/.test(
              input.scene,
            ) &&
            !scenes.has(input.scene),
          "Invalid fixed scene",
        );
        if (input.scene.includes("-direct-")) {
          const installed = await fixture.stack.db.query(
            "select to_regprocedure('public.workflow_human_ask(jsonb)') is not null installed",
          );
          ensure(
            installed.rows[0].installed,
            "Direct browser migration requires supervising installation",
          );
          const s = await fixture.directScene(input.scene);
          const actorCase = input.scene.endsWith("actor") || input.scene.endsWith("cookie");
          if (actorCase)
            await fixture.stack.join(
              s.outsider,
              await fixture.stack.invite(s.owner, s.scope.roomId),
              "두 번째 질문자",
            );
          const targets = [s.responder];
          if (input.scene.endsWith("multiple")) {
            const second = await fixture.devices.register(
              await fixture.devices.connected(s.owner, s.scope, `${input.scene}-second`),
            );
            await fixture.ready(second);
            targets.push(second);
          }
          directTargets.set(input.scene, targets);
          scenes.set(input.scene, s);
          steps.set(input.scene, new Set());
          for (const p of [s.owner, s.requester, s.observer]) people.set(p.id, p);
          if (actorCase) people.set(s.outsider.id, s.outsider);
          data = {
            roomId: s.scope.roomId,
            targetAgentIds: targets.map((target) => target.agentId!),
            requester: { id: s.requester.id, displayName: s.requester.displayName },
            observer: { id: s.observer.id, displayName: s.observer.displayName },
            ...(actorCase
              ? { actorB: { id: s.outsider.id, displayName: s.outsider.displayName } }
              : {}),
          };
        } else {
          const s = await fixture.scene(input.scene);
          scenes.set(input.scene, s);
          steps.set(input.scene, new Set());
          for (const p of [s.owner, s.peer, s.observer]) people.set(p.id, p);
          data = {
            roomId: s.scope.roomId,
            owner: { id: s.owner.id, displayName: s.owner.displayName },
            observer: { id: s.observer.id, displayName: s.observer.displayName },
          };
        }
      } else if (req.url === "/code") {
        ensure(Object.keys(input).length === 1 && people.has(input.id), "Unowned broker person");
        const p = people.get(input.id)!;
        data = fixture.stack.entryForBrowser(p);
      } else if (req.url === "/input-drive") {
        ensure(
          Object.keys(input).length === 2 &&
            /^(?:desktop|mobile)-input-pause$/.test(input.scene) &&
            scenes.has(input.scene) &&
            ["ack-pause", "ack-resume"].includes(input.step),
          "Invalid owned input driver",
        );
        const scene = scenes.get(input.scene)!;
        ensure(!("requester" in scene), "Not an owned paired scene");
        const seen = steps.get(input.scene)!;
        ensure(!seen.has(input.step), "Repeated input driver step");
        const response = await fixture.device(scene.origin, "admission");
        ensure(response.status === 200, "Input driver state unavailable");
        const state = response.data.data as { revision: number; paused: boolean };
        ensure(
          state.paused === (input.step === "ack-pause"),
          "Input driver desired state mismatch",
        );
        const ack = await fixture.device(scene.origin, "admission-ack", {
          revision: state.revision,
          paused: state.paused,
        });
        ensure(ack.status === 200, "Input driver ACK failed");
        seen.add(input.step);
        data = { applied: true };
      } else if (req.url === "/direct-drive") {
        ensure(
          Object.keys(input).length === 2 &&
            scenes.has(input.scene) &&
            directTargets.has(input.scene) &&
            [
              "ready",
              "offline",
              "replace",
              "replace-completed",
              "detach-completed",
              "answer",
              "start",
              "ack",
              "terminal",
              "actor-check",
            ].includes(input.step),
          "Invalid fixed direct driver",
        );
        const scene = scenes.get(input.scene)!;
        ensure("requester" in scene, "Not a direct scene");
        const targets = directTargets.get(input.scene)!;
        const seen = steps.get(input.scene)!;
        ensure(!seen.has(input.step), "Repeated direct driver step");
        // A logout revokes the requester's native session. Inspect the same
        // owned room as its still-authenticated owner during the final audit.
        const history = await fixture.history(
          scene,
          input.step === "actor-check" ? scene.owner : scene.requester,
        );
        if (["ready", "offline", "replace"].includes(input.step)) {
          ensure(history.cycle === null, "Target update after direct admission refused");
          if (input.step === "ready") for (const target of targets) await fixture.ready(target);
          if (input.step === "offline") await fixture.ready(targets[0], false);
          if (input.step === "replace") {
            const target = targets[0];
            const response = await fixture.devices.request(
              "replace",
              {
                operationId: randomUUID(),
                agentId: target.agentId!,
                expectedEpoch: await fixture.epoch(target),
                repositoryAlias: "새 직접 저장소",
                sessionAlias: "새 직접 세션",
                runtime: "codex",
                branch: "main",
                commit: "unknown",
                dirty: "unknown",
              },
              target.credential,
            );
            ensure(response.status === 200, "Owned direct replacement failed");
            await fixture.ready(target);
          }
          data = { state: "READY", verification: "reported" };
        } else {
          ensure(
            history.cycle &&
              "mode" in history.cycle &&
              history.cycle.mode === "DIRECT" &&
              history.runs.length === 1,
            "No exact direct request",
          );
          const request = history.runs[0];
          const target = targets.find((profile) => profile.agentId === request.agentId);
          ensure(target, "Foreign direct target");
          if (["replace-completed", "detach-completed"].includes(input.step)) {
            ensure(
              input.scene.endsWith("-direct-history") &&
                seen.has("answer") &&
                request.state === "COMPLETED" &&
                request.cycleId === history.cycle.cycleId &&
                request.agentId === history.cycle.targetAgentId &&
                request.bindingEpoch === history.cycle.targetEpoch &&
                !active.has(input.scene) &&
                targets.length === 1 &&
                target === scene.responder &&
                fixture.devices.profiles.get(target.name) === target &&
                target.roomId === scene.scope.roomId &&
                target.organizationId === scene.scope.organizationId &&
                target.ownerUserId === scene.owner.id &&
                !!target.deviceId &&
                !!target.credential &&
                fixture.stack.users.has(scene.owner.id) &&
                fixture.stack.organizationOwners.get(scene.scope.organizationId) ===
                  scene.owner.id &&
                history.events.some(
                  (event) =>
                    event.kind === "ANSWER" &&
                    event.questionId === request.questionId &&
                    event.adoption === "ACCEPTED",
                ),
              "Unowned or incomplete direct history transition",
            );
            const count = await fixture.count(scene.scope.roomId);
            ensure(
              count.requests === 1 && count.attempts === 1 && count.budget === 1,
              "History transition requires exactly one completed run",
            );
            if (input.step === "replace-completed") {
              ensure(!seen.has("detach-completed"), "Replacement after detach refused");
              const epoch = await fixture.epoch(target);
              ensure(
                epoch === request.bindingEpoch,
                "Completed request target changed before replacement",
              );
              const response = await fixture.devices.request(
                "replace",
                {
                  operationId: randomUUID(),
                  agentId: target.agentId!,
                  expectedEpoch: epoch,
                  repositoryAlias: "완료 뒤 새 저장소",
                  sessionAlias: "완료 뒤 새 세션",
                  runtime: "codex",
                  branch: "main",
                  commit: "unknown",
                  dirty: "unknown",
                },
                target.credential,
              );
              ensure(response.status === 200, "Owned completed target replacement failed");
              ensure(
                (await fixture.epoch(target)) === epoch + 1,
                "Replacement did not advance the exact target epoch",
              );
              await fixture.ready(target);
            } else {
              ensure(seen.has("replace-completed"), "Detach requires the completed replacement");
              const response = await fixture.devices.human(scene.owner, "remove", {
                deviceId: target.deviceId!,
              });
              ensure(response.status === 200, "Owned completed device detach failed");
              const after = await fixture.history(scene, scene.requester);
              ensure(
                !after.bindings.some((binding) => binding.agentId === target.agentId),
                "Detached target remained bound",
              );
            }
            const finalHistory = await fixture.history(scene, scene.requester);
            const finalCount = await fixture.count(scene.scope.roomId);
            ensure(
              finalHistory.runs.length === 1 &&
                finalHistory.runs[0].requestId === request.requestId &&
                finalHistory.runs[0].state === "COMPLETED" &&
                finalCount.requests === 1 &&
                finalCount.attempts === 1 &&
                finalCount.budget === 1,
              "Completed target change altered the exact finished run",
            );
            data = { state: "COMPLETED", requests: 1 };
          } else if (input.step === "actor-check") {
            ensure(
              (input.scene.endsWith("actor") || input.scene.endsWith("cookie")) &&
                seen.has("answer") &&
                request.state === "COMPLETED",
              "Invalid fixed actor verification",
            );
            const count = await fixture.count(scene.scope.roomId);
            ensure(
              count.requests === 1 && count.attempts === 1 && count.budget === 1,
              "Actor switch created another run",
            );
            const controls = await fixture.stack.db.query(
              "select count(*)::int total from workflow_private.controls c join workflow_private.requests r on r.id=c.request_id where r.room_id=$1",
              [scene.scope.roomId],
            );
            ensure(controls.rows[0].total === 0, "Actor switch created a control");
            data = { state: "COMPLETED", requests: 1, controls: 0 };
          } else if (input.step === "answer" || input.step === "start") {
            ensure(
              request.state === "QUEUED" && !active.has(input.scene),
              "Direct driver cannot restart a run",
            );
            await fixture.ready(target);
            const attempt = await fixture.run(target, request.requestId);
            if (input.step === "answer") {
              const result = await fixture.complete(target, attempt, "COMPLETED", "한글 직접 답변");
              ensure(
                result.continuationRequestId === null && result.adoption === "ACCEPTED",
                "Direct answer was not adopted",
              );
              data = { state: "COMPLETED", requests: 1, verification: "reported" };
            } else {
              active.set(input.scene, attempt);
              data = { state: "RUNNING", verification: "reported" };
            }
          } else {
            const attempt = active.get(input.scene);
            ensure(
              attempt && attempt.requestId === request.requestId && seen.has("start"),
              "No matching direct active attempt",
            );
            const poll = await fixture.poll(target);
            ensure(
              poll.control &&
                poll.control.attemptId === attempt.attemptId &&
                poll.control.fence === attempt.fence,
              "No exact direct control",
            );
            if (input.step === "ack") {
              await fixture.device(target, "interrupt-ack", {
                ...fixture.identity(attempt),
                controlId: poll.control.controlId,
              });
              data = { state: "ACKNOWLEDGED" };
            } else {
              ensure(seen.has("ack"), "Terminal driver requires acknowledgement stage");
              await fixture.complete(target, attempt, "INTERRUPTED", "");
              data = { state: "INTERRUPTED" };
            }
          }
        }
        seen.add(input.step);
      } else if (req.url === "/drive") {
        ensure(
          Object.keys(input).length === 2 &&
            scenes.has(input.scene) &&
            !directTargets.has(input.scene) &&
            ["history", "start", "ack", "unknown", "terminal"].includes(input.step),
          "Invalid fixed driver step",
        );
        const seen = steps.get(input.scene)!;
        ensure(
          !seen.has(input.step) &&
            ((input.scene.endsWith("-history") && input.step === "history") ||
              (input.scene.endsWith("-control") &&
                ((input.step === "start" && seen.size === 0) ||
                  (input.step === "ack" && seen.has("start") && !seen.has("unknown")) ||
                  (input.step === "unknown" && seen.has("start")) ||
                  (input.step === "terminal" && seen.has("unknown"))))),
          "Invalid bounded driver transition",
        );
        seen.add(input.step);
        const s = scenes.get(input.scene)!;
        ensure("origin" in s, "Not a paired scene");
        if (input.step === "history" || input.step === "start") {
          await fixture.ready(s.origin);
          await fixture.ready(s.responder);
        }
        if (input.step === "history") {
          const admitted = await fixture.start(s);
          const a = await fixture.run(s.origin, admitted.requestId!);
          const q = await fixture.question(s.origin, a);
          const p = await fixture.run(s.responder, q.peerRequestId!);
          await fixture.complete(s.origin, a, "COMPLETED", "합성 공개 origin 결과");
          const done = await fixture.complete(s.responder, p);
          const continuation = await fixture.run(s.origin, done.continuationRequestId!);
          await fixture.complete(s.origin, continuation, "COMPLETED", "합성 공개 최종 결과");
          data = { state: "COMPLETED", verification: "reported" };
        } else if (input.step === "start") {
          const admitted = await fixture.start(s);
          active.set(input.scene, await fixture.run(s.origin, admitted.requestId!));
          data = { state: "RUNNING", verification: "reported" };
        } else {
          const a = active.get(input.scene);
          ensure(a, "No owned fixed run");
          if (input.step === "ack") {
            const poll = await fixture.poll(s.origin);
            ensure(poll.control, "No owned control");
            await fixture.device(s.origin, "interrupt-ack", {
              ...fixture.identity(a),
              controlId: poll.control.controlId,
            });
            data = { state: "ACKNOWLEDGED" };
          } else if (input.step === "unknown") {
            await fixture.expire("lease", a.attemptId);
            await fixture.poll(s.origin);
            data = { state: "UNKNOWN" };
          } else {
            const poll = await fixture.poll(s.origin);
            if (poll.control)
              await fixture.device(s.origin, "interrupt-ack", {
                ...fixture.identity(a),
                controlId: poll.control.controlId,
              });
            const result = await fixture.device(s.origin, "observe", {
              ...fixture.identity(a),
              terminal: "INTERRUPTED",
              publicText: "",
            });
            ensure(result.status === 200, "Owned terminal failed");
            data = { state: "INTERRUPTED" };
          }
        }
      } else throw new Error("Invalid workflow broker path");
      res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" })
        .end(JSON.stringify(data));
    } catch (error) {
      const frame =
        error instanceof Error
          ? error.stack?.match(/workflow-fixture\.(?:js|ts):(\d+):(\d+)/)
          : null;
      if (frame)
        process.stdout.write(
          JSON.stringify({
            source: "owned-workflow-broker",
            line: Number(frame[1]),
            column: Number(frame[2]),
          }) + "\n",
        );
      res
        .writeHead(500, { "Content-Type": "application/json" })
        .end('{"error":"Owned workflow broker failed"}');
    }
  });
  const browserArgs = [
    "node_modules/@playwright/test/cli.js",
    "test",
    "--config",
    "playwright.workflow.config.ts",
  ];
  if (process.argv.includes("--direct-browser-only")) {
    // Only this fixed test name is selectable; never forward caller-supplied patterns.
    browserArgs.push("--grep", "should show a direct question form without an own AI connection");
  } else if (process.argv.includes("--chat-browser-only")) {
    // A fixed regression subset, with no caller-selected pattern or broker action.
    browserArgs.push(
      "--grep",
      "should isolate unresolved direct intents|should retain saved direct identity",
    );
  }
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const env = {
      ...productEnvironment(),
      LOCAL_WORKFLOW_FIXTURE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      LOCAL_WORKFLOW_FIXTURE_TOKEN: token,
      ...authBrowserChildEnvironment,
    };
    const child = spawn(process.execPath, browserArgs, { env, stdio: "inherit" });
    process.exitCode = await new Promise<number>((r) => {
      child.on("exit", (c) => r(c ?? 1));
      child.on("error", () => r(1));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    try {
      await sourceScenes.close();
    } finally {
      await fixture.close();
    }
  }
}
if (process.argv.includes("--workflow-e2e-runner"))
  runWorkflowBrowserParent().catch(() => {
    process.stderr.write("Owned workflow browser setup failed; private diagnostics withheld\n");
    process.exitCode = 1;
  });

export type OwnInputUpgradeEvidence = {
  backendPid: number;
  paired: WorkflowScene;
  direct: HumanDirectScene;
  claimBody: Body;
  claimReceipt: unknown;
  terminalBody: Body;
  terminalReceipt: unknown;
  pairedHistory: HistoryPage;
  directHistory: HistoryPage;
  deviceHash: string;
  restoreHash: string;
};
export async function assertOwnInputUpgradePreconditions(f: WorkflowFixture) {
  await assertOwnedStack(f.stack.config);
  const schema = await f.stack.db.query(`select
    to_regnamespace('own_input_private') is null
      and to_regprocedure('public.workflow_device_admission(jsonb,text)') is null
      and to_regprocedure('public.workflow_device_admission_ack(jsonb,text)') is null
      and to_regprocedure('public.workflow_human_input_control(jsonb)') is null
      and to_regprocedure('public.workflow_human_input_state(jsonb)') is null
      and to_regprocedure('workflow_private.restore_011_original(text,jsonb)') is null absent,
    to_regclass('public.rooms') is not null
      and to_regprocedure('room_access_private.actor()') is not null
      and to_regprocedure('device_binding_private.connector(text,jsonb,text)') is not null
      and (select count(*) from pg_catalog.pg_constraint c join (values
        ('device_binding_private.workspaces', 'workspaces_device_id_registration_credential_hash_fkey'),
        ('device_binding_private.agents', 'agents_device_id_registration_credential_hash_fkey'),
        ('device_binding_private.agents', 'agents_device_id_replacement_credential_hash_fkey')
      ) receipt(table_name, constraint_name)
        on c.conrelid=to_regclass(receipt.table_name) and c.conname=receipt.constraint_name
        where c.contype='f' and c.convalidated and c.condeferrable and c.condeferred
          and c.confrelid=to_regclass('device_binding_private.credentials'))=3
      and to_regclass('workflow_private.attempts') is not null
      and to_regprocedure('workflow_private.device(text,jsonb,text)') is not null
      and to_regprocedure('workflow_private.restore(text,jsonb)') is not null
      and to_regprocedure('public.workflow_human_ask(jsonb)') is not null
      and to_regprocedure('workflow_private.human_actor(text,jsonb)') is not null
      and to_regprocedure('public.team_entry_status()') is not null
      and to_regclass('runtime_settings_private.configurations') is not null
      and to_regprocedure('public.runtime_settings_device(text,jsonb,text)') is not null original`);
  ensure(
    schema.rows[0].absent,
    "SQL011 already exists; refusing reset, downgrade or reapplication",
  );
  ensure(schema.rows[0].original, "Upgrade requires the existing owned 001–010 schema");
}
/** Capture on an owned 001–010 stack and warm the same backend's original core/restore. */
export async function captureOwnInputUpgradeEvidence(
  f: WorkflowFixture,
): Promise<OwnInputUpgradeEvidence> {
  await assertOwnInputUpgradePreconditions(f);
  const backendPid = Number((await f.stack.db.query("select pg_backend_pid() pid")).rows[0].pid);
  const paired = await f.scene("own-input-upgrade-paired"),
    admission = await f.start(paired);
  const claimBody = {
    protocol: 1,
    agentId: paired.origin.agentId!,
    bindingEpoch: await f.epoch(paired.origin),
    operationId: randomUUID(),
    requestId: admission.requestId!,
  };
  const claim = await f.device(paired.origin, "claim", claimBody);
  ensure(claim.status === 200, "Upgrade original claim failed");
  const leased = claim.data.data as AttemptSnapshot;
  await f.intent(paired.origin, leased);
  await f.expire("lease", leased.attemptId);
  await f.poll(paired.origin);
  const replay = await f.device(paired.origin, "claim", claimBody);
  ensure(
    replay.status === 200 && (replay.data.data as AttemptSnapshot).state === "UNKNOWN",
    "Upgrade original UNKNOWN evidence missing",
  );
  const direct = await f.directScene("own-input-upgrade-direct");
  const asked = await f.ask(direct);
  ensure(typeof asked.requestId === "string", "Upgrade direct admission missing");
  const started = await f.intent(
    direct.responder,
    await f.claim(direct.responder, asked.requestId),
  );
  const terminalBody = {
    protocol: 1,
    agentId: direct.responder.agentId!,
    bindingEpoch: started.bindingEpoch,
    ...f.identity(started),
    terminal: "COMPLETED",
    publicText: "합성 직접 질문 결론",
  };
  const terminal = await f.device(direct.responder, "complete", terminalBody);
  ensure(terminal.status === 200, "Upgrade direct terminal failed");
  const definitions = await f.stack.db.query(
    "select md5((select prosrc from pg_proc where oid='workflow_private.device(text,jsonb,text)'::regprocedure)) device_hash,md5((select prosrc from pg_proc where oid='workflow_private.restore(text,jsonb)'::regprocedure)) restore_hash",
  );
  const warmClaim = await f.stack.db.query(
    "select workflow_private.device('claim',$1::jsonb,$2::text) result",
    [JSON.stringify(claimBody), paired.origin.credential],
  );
  const warmRestore = await f.stack.db.query(
    "select workflow_private.restore('complete',$1::jsonb) result",
    [JSON.stringify(terminal.data.data)],
  );
  ensure(
    JSON.stringify(warmClaim.rows[0].result) === JSON.stringify(replay.data.data) &&
      JSON.stringify(warmRestore.rows[0].result) === JSON.stringify(terminal.data.data),
    "Upgrade warm original behavior differs",
  );
  return {
    backendPid,
    paired,
    direct,
    claimBody,
    claimReceipt: replay.data.data,
    terminalBody,
    terminalReceipt: terminal.data.data,
    pairedHistory: await f.history(paired),
    directHistory: await f.history(direct, direct.requester),
    deviceHash: definitions.rows[0].device_hash,
    restoreHash: definitions.rows[0].restore_hash,
  };
}
export async function verifyOwnInputUpgradeEvidence(
  f: WorkflowFixture,
  evidence: OwnInputUpgradeEvidence,
) {
  await assertOwnedStack(f.stack.config);
  ensure(
    Number((await f.stack.db.query("select pg_backend_pid() pid")).rows[0].pid) ===
      evidence.backendPid,
    "Upgrade verification requires the same warmed backend",
  );
  ensure(
    f.rooms.get(evidence.paired.scope.roomId) === evidence.paired.scope.organizationId &&
      f.rooms.get(evidence.direct.scope.roomId) === evidence.direct.scope.organizationId,
    "Exact owned upgrade rooms required",
  );
  const schema = await f.stack.db.query(
    "select to_regprocedure('public.workflow_device_admission(jsonb,text)') is not null installed,md5((select prosrc from pg_proc where oid='workflow_private.device(text,jsonb,text)'::regprocedure)) device_hash,md5((select prosrc from pg_proc where oid='workflow_private.restore_011_original(text,jsonb)'::regprocedure)) restore_hash",
  );
  ensure(
    schema.rows[0].installed &&
      schema.rows[0].device_hash === evidence.deviceHash &&
      schema.rows[0].restore_hash === evidence.restoreHash,
    "Additive upgrade must preserve the exact original core and restore bodies",
  );
  const warmClaim = await f.stack.db.query(
    "select workflow_private.device('claim',$1::jsonb,$2::text) result",
    [JSON.stringify(evidence.claimBody), evidence.paired.origin.credential],
  );
  const warmRestore = await f.stack.db.query(
    "select workflow_private.restore('complete',$1::jsonb) result",
    [JSON.stringify(evidence.terminalReceipt)],
  );
  const claim = await f.device(evidence.paired.origin, "claim", evidence.claimBody),
    terminal = await f.device(evidence.direct.responder, "complete", evidence.terminalBody);
  ensure(
    claim.status === 200 &&
      terminal.status === 200 &&
      JSON.stringify(claim.data.data) === JSON.stringify(evidence.claimReceipt) &&
      JSON.stringify(warmClaim.rows[0].result) === JSON.stringify(evidence.claimReceipt) &&
      JSON.stringify(terminal.data.data) === JSON.stringify(evidence.terminalReceipt) &&
      JSON.stringify(warmRestore.rows[0].result) === JSON.stringify(evidence.terminalReceipt),
    "Warm core and public receipt replays must preserve UNKNOWN and DIRECT terminal adoption",
  );
  for (const [scene, previous, person] of [
    [evidence.paired, evidence.pairedHistory, evidence.paired.owner],
    [evidence.direct, evidence.directHistory, evidence.direct.requester],
  ] as const) {
    const current = await f.history(scene, person);
    for (const field of ["events", "runs", "cycle", "roomRevision"] as const)
      ensure(
        JSON.stringify(current[field]) === JSON.stringify(previous[field]),
        "Upgrade must preserve shared history and revision",
      );
  }
  await f.recoverOperations();
}
/** Run explicitly on an existing owned 001–010 stack; never bootstrap or reset a stack. */
export async function runOwnInputUpgradeDriver(f: WorkflowFixture) {
  const evidence = await captureOwnInputUpgradeEvidence(f);
  const sql = await readFile(
    resolve("supabase/migrations/20261006001100-own-ai-input-pause.sql"),
    "utf8",
  );
  await assertOwnInputUpgradePreconditions(f);
  ensure(
    Number((await f.stack.db.query("select pg_backend_pid() pid")).rows[0].pid) ===
      evidence.backendPid,
    "Additive installation requires the same warmed backend",
  );
  try {
    await f.stack.db.query("begin");
    await f.stack.db.query("select device_binding_private.guard()");
    await assertOwnInputUpgradePreconditions(f);
    // Execute only the exact repository SQL011 inside this connection's installation transaction.
    await f.stack.db.query(sql);
    await f.stack.db.query("commit");
  } catch {
    await f.stack.db.query("rollback");
    throw new Error("Owned additive SQL011 installation failed; private diagnostics withheld");
  }
  await verifyOwnInputUpgradeEvidence(f, evidence);
}
