import { Client } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { workflowCase, WorkflowFixture, type WorkflowScene } from "../helpers/workflow-fixture.js";
import {
  digest,
  assertDeviceMigrationSources,
  frozenAccessMigrations,
  type DeviceResponse,
  type DeviceProfile,
} from "../helpers/device-binding-fixture.js";
import { assertOwnedConfig, assertOwnedStack } from "../helpers/local-access-stack.js";
function good(r: DeviceResponse) {
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  return r.data.data as Record<string, unknown>;
}
function denied(r: DeviceResponse, status: number) {
  assert.equal(r.status, status);
  assert.equal(r.data.ok, false);
  assert.deepEqual(Object.keys(r.data), ["ok", "error"]);
  assert.equal(r.headers.get("cache-control")?.includes("no-store"), true);
}
async function pause(f: WorkflowFixture, s: WorkflowScene) {
  const h = await f.read(s);
  return good(
    await f.human(s.owner, "pause", {
      roomId: s.scope.roomId,
      operationId: randomUUID(),
      expectedRoomRevision: h.roomRevision,
    }),
  );
}
async function resumeRoom(f: WorkflowFixture, s: WorkflowScene, person = s.owner) {
  const h = await f.read(s);
  return f.human(person, "resume", {
    roomId: s.scope.roomId,
    operationId: randomUUID(),
    mode: "room",
    expectedRoomRevision: h.roomRevision,
  });
}
async function resumeCycle(f: WorkflowFixture, s: WorkflowScene, person = s.owner) {
  const h = await f.read(s);
  return f.human(person, "resume", {
    roomId: s.scope.roomId,
    operationId: randomUUID(),
    mode: "cycle",
    cycleId: h.cycle!.cycleId,
    originAgentId: s.origin.agentId!,
    peerAgentId: s.responder.agentId!,
    originEpoch: await f.epoch(s.origin),
    peerEpoch: await f.epoch(s.responder),
    expectedRoomRevision: h.roomRevision,
    publicText: "같은 예산의 명시적 재개",
    confirmed: true,
  });
}
async function replace(f: WorkflowFixture, p: DeviceProfile) {
  return f.devices.request(
    "replace",
    {
      operationId: randomUUID(),
      agentId: p.agentId!,
      expectedEpoch: await f.epoch(p),
      repositoryAlias: "새 공개 저장소",
      branch: "main",
      commit: "unknown",
      dirty: "unknown",
      sessionAlias: "새 공개 세션",
      runtime: "codex",
    },
    p.credential,
  );
}
async function exchange(f: WorkflowFixture, s: WorkflowScene, answerFirst: boolean | "concurrent") {
  const admitted = await f.start(s);
  const origin = await f.run(s.origin, admitted.requestId!);
  const q = await f.question(s.origin, origin);
  const peer = await f.run(s.responder, q.peerRequestId!);
  let continuation: string | null;
  if (answerFirst === "concurrent") {
    const results = await Promise.all([
      f.complete(s.origin, origin),
      f.complete(s.responder, peer),
    ]);
    const continuations = results
      .map((r) => r.continuationRequestId)
      .filter((id): id is string => id !== null);
    assert.equal(continuations.length, 1);
    continuation = continuations[0];
  } else if (answerFirst) {
    const done = await f.complete(s.responder, peer);
    assert.equal(done.adoption, "PENDING");
    assert.equal(done.continuationRequestId, null);
    continuation = (await f.complete(s.origin, origin)).continuationRequestId;
  } else {
    assert.equal((await f.complete(s.origin, origin)).continuationRequestId, null);
    continuation = (await f.complete(s.responder, peer)).continuationRequestId;
  }
  assert.ok(continuation);
  return { admitted, origin, q, peer, continuation };
}
const opts = { timeout: 180000 };
test(
  "should route an addressed question through one peer run and one current origin continuation",
  opts,
  () =>
    workflowCase("route", async (f) => {
      for (const answerFirst of [true, false, "concurrent"] as const) {
        const s = await f.scene(
          answerFirst === "concurrent"
            ? "concurrent"
            : answerFirst
              ? "answer-first"
              : "terminal-first",
        );
        const turn = await exchange(f, s, answerFirst);
        assert.equal((await f.poll(s.responder)).queuedRequest, null);
        const p = await f.poll(s.origin);
        assert.equal(p.queuedRequest?.requestId, turn.continuation);
        assert.equal((await f.read(s)).cycle?.state, "ACTIVE");
        const h = await f.read(s);
        denied(
          await f.human(s.owner, "start", {
            roomId: s.scope.roomId,
            operationId: randomUUID(),
            originAgentId: s.origin.agentId!,
            peerAgentId: s.responder.agentId!,
            originEpoch: 1,
            peerEpoch: 1,
            expectedRoomRevision: h.roomRevision,
            publicText: "중복 시작",
            confirmed: true,
          }),
          409,
        );
        const count = await f.count(s.scope.roomId);
        assert.equal(count.requests, 3);
        assert.equal(count.budget, 3);
        const run = await f.run(s.origin, turn.continuation);
        await f.complete(s.origin, run);
        assert.equal((await f.read(s)).cycle?.state, "COMPLETED");
        const history = await f.history(s, s.observer);
        assert.equal(history.events.filter((e) => e.kind === "QUESTION").length, 1);
        assert.equal(
          history.events.filter((e) => e.kind === "ANSWER" && e.adoption === "ACCEPTED").length,
          1,
        );
      }
    }),
);
test(
  "should finish a completed cycle and retire it only after confirmed execution termination",
  opts,
  () =>
    workflowCase("finish", async (f) => {
      const s = await f.scene();
      const first = await f.start(s);
      await f.complete(s.origin, await f.run(s.origin, first.requestId!));
      assert.equal((await f.read(s)).cycle?.state, "COMPLETED");
      const output = (await f.history(s)).events.find(
        (e) => e.kind === "SPEECH" && e.senderKind === "AGENT",
      );
      assert.equal(output?.requestId, first.requestId);
      assert.equal(output?.cycleId, first.cycleId);
      assert.equal(output?.publicText, "합성 공개 결과");
      assert.equal(output?.adoption, "ACCEPTED");
      assert.equal(output?.runState, null);
      const next = await f.start(s);
      assert.notEqual(next.cycleId, first.cycleId);
      const a = await f.run(s.origin, next.requestId!);
      await f.expire("lease", a.attemptId);
      assert.equal((await f.poll(s.origin)).attempt?.state, "UNKNOWN");
      await assert.rejects(f.start(s));
      good(
        await f.device(s.origin, "observe", {
          ...f.identity(a),
          terminal: "COMPLETED",
          publicText: "늦은 공개 완료",
        }),
      );
      const third = await f.start(s);
      assert.notEqual(third.cycleId, next.cycleId);
      await f.expire("cycle", third.cycleId);
      assert.equal((await f.read(s)).cycle?.state, "HUMAN_INPUT_REQUIRED");
      const retired = await f.start(s);
      assert.notEqual(retired.cycleId, third.cycleId);
    }),
);
test("should reopen a paused room without dispatching or resetting an investigation", opts, () =>
  workflowCase("room-resume", async (f) => {
    const s = await f.scene();
    await pause(f, s);
    assert.equal(good(await resumeRoom(f, s)).cycleId, null);
    assert.equal((await f.count(s.scope.roomId)).requests, 0);
    const first = await f.start(s);
    await pause(f, s);
    let h = await f.read(s);
    assert.equal(h.cycle?.state, "HUMAN_INPUT_REQUIRED");
    assert.equal(h.runs[0].state, "CANCELLED");
    const before = await f.count(s.scope.roomId);
    denied(await resumeRoom(f, s, s.observer), 403);
    good(await resumeRoom(f, s));
    assert.equal((await f.read(s)).cycle?.state, "HUMAN_INPUT_REQUIRED");
    assert.deepEqual((await f.count(s.scope.roomId)).requests, before.requests);
    denied(await resumeCycle(f, s, s.peer), 403);
    const resumed = good(await resumeCycle(f, s));
    assert.equal(resumed.cycleId, first.cycleId);
    h = await f.read(s);
    assert.equal(h.cycle?.generation, 2);
    assert.equal(h.cycle?.runsReserved, 2);
    await f.complete(s.origin, await f.run(s.origin, resumed.requestId as string));
    await pause(f, s);
    good(await resumeRoom(f, s));
    assert.equal((await f.read(s)).cycle?.state, "COMPLETED");
    const turn = await exchange(f, s, true);
    await pause(f, s);
    assert.equal((await f.read(s)).cycle?.state, "HUMAN_INPUT_REQUIRED");
    assert.equal(
      (await f.read(s)).runs.find((r) => r.requestId === turn.continuation)?.state,
      "CANCELLED",
    );
    good(await resumeRoom(f, s));
    const newStart = await f.start(s);
    assert.notEqual(newStart.cycleId, turn.admitted.cycleId);
    await f.expire("cycle", newStart.cycleId);
    await f.read(s);
    await pause(f, s);
    const exhausted = await f.read(s);
    good(await resumeRoom(f, s));
    assert.equal((await f.read(s)).cycle?.deadline, exhausted.cycle?.deadline);
    assert.equal((await f.read(s)).cycle?.runsReserved, exhausted.cycle?.runsReserved);
    assert.equal(good(await resumeCycle(f, s)).accepted, false);
    const unknownCycle = await f.start(s);
    const a = await f.run(s.origin, unknownCycle.requestId!);
    await f.expire("lease", a.attemptId);
    await f.poll(s.origin);
    await pause(f, s);
    denied(await resumeRoom(f, s), 409);
  }),
);
test("should record shared speech without dispatching automatic runs", opts, () =>
  workflowCase("speech", async (f) => {
    const s = await f.scene();
    good(
      await f.human(s.peer, "speak", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        publicText: "합성 공동 발언",
      }),
    );
    assert.equal((await f.count(s.scope.roomId)).requests, 0);
    assert.equal((await f.history(s, s.observer)).events[0].publicText, "합성 공동 발언");
    for (const person of [s.observer, s.outsider])
      denied(
        await f.human(person, "speak", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          publicText: "거절",
        }),
        403,
      );
    const other = await f.scene("other");
    denied(await f.human(other.owner, "read", { roomId: s.scope.roomId, afterSequence: 0 }), 403);
  }),
);
test("should deduplicate operations across actions and reject conflicting payloads", opts, () =>
  workflowCase("receipts", async (f) => {
    const s = await f.scene();
    const op = randomUUID();
    const fields = { roomId: s.scope.roomId, operationId: op, publicText: "한 번의 공동 발언" };
    const first = good(await f.human(s.owner, "speak", fields));
    const count = await f.count(s.scope.roomId);
    assert.deepEqual(good(await f.human(s.owner, "speak", fields)), first);
    assert.deepEqual(await f.count(s.scope.roomId), count);
    denied(await f.human(s.owner, "speak", { ...fields, publicText: "변경" }), 409);
    denied(
      await f.human(s.owner, "pause", {
        roomId: s.scope.roomId,
        operationId: op,
        expectedRoomRevision: 1,
      }),
      409,
    );
    const readyOp = randomUUID();
    const ready = good(await f.ready(s.origin, true, readyOp));
    await f.expire("readiness", s.origin.agentId!);
    assert.deepEqual(good(await f.ready(s.origin, true, readyOp)), ready);
    assert.equal((await f.poll(s.origin)).reportedReady, false);
    await f.ready(s.origin);
    const start = await f.start(s);
    const claimBody = { operationId: randomUUID(), requestId: start.requestId! };
    const claim = good(await f.device(s.origin, "claim", claimBody));
    const leaseBody = {
      operationId: randomUUID(),
      requestId: claim.requestId as string,
      attemptId: claim.attemptId as string,
      fence: claim.fence as number,
    };
    const lease = good(await f.device(s.origin, "lease", leaseBody));
    const counts = await f.count(s.scope.roomId);
    assert.deepEqual(good(await f.device(s.origin, "lease", leaseBody)), lease);
    assert.deepEqual(await f.count(s.scope.roomId), counts);
    denied(await f.device(s.origin, "start-intent", leaseBody), 409);
  }),
);
test("should claim one attempt and block concurrent execution across binding epochs", opts, () =>
  workflowCase("claim-race", async (f) => {
    const s = await f.scene();
    const start = await f.start(s);
    const results = await Promise.all([
      f.device(s.origin, "claim", { operationId: randomUUID(), requestId: start.requestId! }),
      f.device(s.origin, "claim", { operationId: randomUUID(), requestId: start.requestId! }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await f.count(s.scope.roomId)).attempts, 1);
    denied(
      await f.device(s.responder, "claim", {
        operationId: randomUUID(),
        requestId: start.requestId!,
      }),
      403,
    );
    denied(
      await f.device(s.origin, "claim", {
        operationId: randomUUID(),
        requestId: start.requestId!,
        bindingEpoch: 2,
      }),
      403,
    );
    denied(await replace(f, s.origin), 409);
    const other = await f.scene("tenant");
    denied(
      await f.device(other.origin, "claim", {
        operationId: randomUUID(),
        requestId: start.requestId!,
      }),
      403,
    );
  }),
);
test("should recover an expired unstarted lease without replaying a started request", opts, () =>
  workflowCase("lease", async (f) => {
    const s = await f.scene();
    const first = await f.start(s);
    const a = await f.claim(s.origin, first.requestId!);
    denied(
      await f.device(s.origin, "question", {
        ...f.identity(a),
        publicText: "의도 이전",
        confirmed: true,
      }),
      409,
    );
    assert.equal((await f.count(s.scope.roomId)).requests, 1);
    assert.equal((await f.read(s)).cycle?.peerRoundsReserved, 0);
    await f.expire("lease", a.attemptId);
    assert.equal((await f.poll(s.origin)).queuedRequest?.requestId, a.requestId);
    const next = await f.claim(s.origin, a.requestId);
    assert.equal(next.fence, a.fence + 1);
    assert.notEqual(next.attemptId, a.attemptId);
    assert.equal((await f.count(s.scope.roomId)).budget, 1);
    await f.intent(s.origin, next);
    await f.expire("lease", next.attemptId);
    const poll = await f.poll(s.origin);
    assert.equal(poll.attempt?.state, "UNKNOWN");
    assert.equal(poll.queuedRequest, null);
    denied(
      await f.device(s.origin, "claim", { operationId: randomUUID(), requestId: next.requestId }),
      409,
    );
    assert.equal((await f.count(s.scope.roomId)).attempts, 2);
  }),
);
test(
  "should reject stale fences and preserve unknown terminal observation without automatic continuation",
  opts,
  () =>
    workflowCase("fence", async (f) => {
      const s = await f.scene();
      const admitted = await f.start(s);
      const old = await f.claim(s.origin, admitted.requestId!);
      await f.expire("lease", old.attemptId);
      await f.poll(s.origin);
      const a = await f.run(s.origin, old.requestId);
      denied(
        await f.device(s.origin, "complete", {
          ...f.identity(old),
          terminal: "COMPLETED",
          publicText: "옛 fence",
        }),
        409,
      );
      const q = await f.question(s.origin, a);
      const peer = await f.run(s.responder, q.peerRequestId!);
      await f.complete(s.responder, peer);
      await f.expire("lease", a.attemptId);
      const poll = await f.poll(s.origin);
      assert.equal(poll.attempt?.state, "UNKNOWN");
      if (poll.control)
        denied(
          await f.device(s.origin, "interrupt-ack", {
            ...f.identity(old),
            controlId: poll.control.controlId,
          }),
          409,
        );
      const result = good(
        await f.device(s.origin, "observe", {
          ...f.identity(a),
          terminal: "COMPLETED",
          publicText: "늦은 종결 관찰",
        }),
      );
      assert.equal(result.adoption, "HISTORICAL");
      assert.equal(result.continuationRequestId, null);
      const lateOutput = (await f.history(s)).events.find(
        (e) => e.kind === "SPEECH" && e.requestId === a.requestId,
      );
      assert.equal(lateOutput?.publicText, "늦은 종결 관찰");
      assert.equal(lateOutput?.adoption, "HISTORICAL");
      assert.equal(lateOutput?.terminal, null);
      assert.equal((await f.poll(s.origin)).queuedRequest, null);
      assert.equal((await f.read(s)).cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal((await f.count(s.scope.roomId)).requests, 2);
    }),
);
test(
  "should reject late answers when either binding epoch or the room revision has changed",
  opts,
  () =>
    workflowCase("late", async (f) => {
      for (const mode of ["origin", "peer", "revision", "scope"]) {
        const s = await f.scene(mode);
        const admitted = await f.start(s);
        const a = await f.run(s.origin, admitted.requestId!);
        const q = await f.question(s.origin, a);
        const peer = await f.run(s.responder, q.peerRequestId!);
        if (mode === "peer") {
          const pending = await f.complete(s.responder, peer);
          assert.equal(pending.adoption, "PENDING");
          good(await replace(f, s.responder));
          const receipt = await f.complete(s.origin, a);
          assert.equal(receipt.adoption, "HISTORICAL");
          assert.equal(receipt.continuationRequestId, null);
          const h = await f.history(s);
          assert.equal(h.events.filter((e) => e.kind === "ANSWER").at(-1)?.adoption, "HISTORICAL");
          continue;
        }
        await f.complete(s.origin, a);
        if (mode === "origin") good(await replace(f, s.origin));
        else if (mode === "revision") await pause(f, s);
        else if (mode === "scope")
          await s.owner.web.mutate("revoke-room-member", {
            roomId: s.scope.roomId,
            userId: s.peer.id,
          });
        if (mode === "scope")
          denied(
            await f.device(s.responder, "complete", {
              ...f.identity(peer),
              terminal: "COMPLETED",
              publicText: "권한 취소 뒤",
            }),
            401,
          );
        else {
          const terminal = await f.complete(s.responder, peer);
          assert.equal(terminal.adoption, "HISTORICAL");
          assert.equal(terminal.continuationRequestId, null);
        }
        assert.equal((await f.poll(s.origin)).queuedRequest, null);
      }
    }),
);
test(
  "should reserve cycle budgets before admission and preserve them across recovery",
  { timeout: 300000 },
  () =>
    workflowCase("budget", async (f) => {
      const s = await f.scene();
      const initial = await f.start(s);
      let a = await f.run(s.origin, initial.requestId!);
      for (let round = 0; round < 5; round++) {
        const q = await f.question(s.origin, a);
        const p = await f.run(s.responder, q.peerRequestId!);
        await f.complete(s.origin, a);
        const receipt = await f.complete(s.responder, p);
        a = await f.run(s.origin, receipt.continuationRequestId!);
      }
      const history = await f.read(s);
      assert.equal(history.cycle?.runsReserved, 11);
      assert.equal(history.cycle?.peerRoundsReserved, 5);
      const before = await f.count(s.scope.roomId);
      const rejected = await f.question(s.origin, a);
      assert.equal(rejected.accepted, false);
      assert.equal((await f.count(s.scope.roomId)).requests, before.requests);
      assert.equal((await f.read(s)).cycle?.state, "HUMAN_INPUT_REQUIRED");
      await f.complete(s.origin, a);
      good(await resumeRoomAfterPause(f, s));
      const resume = good(await resumeCycle(f, s));
      assert.equal(resume.accepted, false);
      assert.equal((await f.read(s)).cycle?.runsReserved, 11);
      assert.equal((await f.read(s)).cycle?.deadline, history.cycle?.deadline);
      const timed = await f.scene("time");
      const cycle = await f.start(timed);
      const origin = await f.run(timed.origin, cycle.requestId!);
      const question = await f.question(timed.origin, origin);
      const row = await f.stack.db.query(
        "select q.deadline<=c.deadline within_cycle,q.deadline<=clock_timestamp()+interval '120 seconds' within_peer from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id where q.id=$1 and c.room_id=$2",
        [question.questionId, timed.scope.roomId],
      );
      assert.ok(row.rows[0].within_cycle && row.rows[0].within_peer);
      await f.expire("question", question.questionId!);
      assert.equal((await f.read(timed)).cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal((await f.count(timed.scope.roomId)).budget, 2);
    }),
);
async function resumeRoomAfterPause(f: WorkflowFixture, s: WorkflowScene) {
  await pause(f, s);
  return resumeRoom(f, s);
}
test(
  "should keep run scope revoked after device or membership removal and fresh invitation",
  opts,
  () =>
    workflowCase("revoke", async (f) => {
      for (const mode of ["device", "room", "group"]) {
        const s = await f.scene(mode);
        const admitted = await f.start(s);
        const a = await f.run(s.origin, admitted.requestId!);
        const q = await f.question(s.origin, a);
        const p = await f.run(s.responder, q.peerRequestId!);
        if (mode === "device")
          good(await f.devices.human(s.peer, "remove", { deviceId: s.responder.deviceId }));
        else
          await s.owner.web.mutate(
            `revoke-${mode}-member`,
            mode === "room"
              ? { roomId: s.scope.roomId, userId: s.peer.id }
              : { organizationId: s.scope.organizationId, userId: s.peer.id },
          );
        denied(await f.device(s.responder, "poll"), 401);
        denied(
          await f.device(s.responder, "complete", {
            ...f.identity(p),
            terminal: "COMPLETED",
            publicText: "취소 뒤",
          }),
          401,
        );
        const invitation = await f.stack.invite(s.owner, s.scope.roomId);
        if (mode === "device") {
          const rejoin = await s.peer.web.post("/api/access/join", {
            code: invitation,
            displayAlias: "질문 참가자",
          });
          assert.equal(rejoin.status, 409);
          assert.deepEqual(await rejoin.json(), { ok: false, error: { code: "ALREADY_MEMBER" } });
          const retained = await f.stack.db.query(
            "select m.status='active' membership_active,m.role='participant' participant_role,i.consumed_at is null and i.consumed_by is null invite_unconsumed from public.room_members m join room_access_private.room_invites i on i.organization_id=m.organization_id and i.room_id=m.room_id where m.organization_id=$1 and m.room_id=$2 and m.user_id=$3 and i.code_hash=$4 and i.issuer_user_id=$5",
            [s.scope.organizationId, s.scope.roomId, s.peer.id, digest(invitation), s.owner.id],
          );
          assert.equal(retained.rowCount, 1);
          assert.deepEqual(retained.rows[0], {
            membership_active: true,
            participant_role: true,
            invite_unconsumed: true,
          });
        } else await f.stack.join(s.peer, invitation);
        denied(await f.ready(s.responder), 401);
        denied(await f.device(s.responder, "poll"), 401);
        denied(
          await f.device(s.responder, "complete", {
            ...f.identity(p),
            terminal: "COMPLETED",
            publicText: "재초대 뒤",
          }),
          401,
        );
        await f.complete(s.origin, a);
        assert.equal((await f.poll(s.origin)).queuedRequest, null);
        const history = await f.read(s);
        assert.equal(history.cycle?.state, "HUMAN_INPUT_REQUIRED");
        assert.equal(history.runs.find((r) => r.requestId === p.requestId)?.state, "UNKNOWN");
        assert.equal((await f.devices.request("heartbeat", {}, s.origin.credential)).status, 200);
      }
    }),
);
test(
  "should preserve stable run ownership through credential rotation and gate binding replacement",
  opts,
  () =>
    workflowCase("rotation", async (f) => {
      const s = await f.scene();
      const admitted = await f.start(s);
      const a = await f.run(s.origin, admitted.requestId!);
      const old = s.origin.credential;
      denied(await replace(f, s.origin), 409);
      await f.devices.cli(s.origin.name, "rotate");
      await f.devices.refresh(s.origin);
      assert.equal(await f.epoch(s.origin), a.bindingEpoch);
      denied(await f.device(s.origin, "lease", f.identity(a), old), 401);
      good(await f.device(s.origin, "lease", f.identity(a)));
      await f.expire("lease", a.attemptId);
      await f.poll(s.origin);
      denied(await replace(f, s.origin), 409);
      good(
        await f.device(s.origin, "observe", {
          ...f.identity(a),
          terminal: "COMPLETED",
          publicText: "현재 키 종결",
        }),
      );
      good(await replace(f, s.origin));
      assert.equal(await f.epoch(s.origin), 2);
      assert.equal((await f.poll(s.origin)).reportedReady, false);
      assert.equal((await f.read(s)).cycle?.runsReserved, 1);
    }),
);
test(
  "should preserve shared history and unknown execution through physical owner deletion",
  { timeout: 300000 },
  () =>
    workflowCase("deletion", async (f) => {
      const healthy = await f.scene("deletion-healthy");
      const healthyStart = await f.start(healthy);
      const healthyRun = await f.run(healthy.origin, healthyStart.requestId!);
      await f.complete(healthy.origin, healthyRun);
      const healthyCounts = await f.count(healthy.scope.roomId);
      const healthyHistory = await f.history(healthy);
      async function ownerSurvives(s: WorkflowScene) {
        const row = await f.stack.db.query(
          "select exists(select 1 from auth.users where id=$1) owner_exists,exists(select 1 from public.rooms where id=$2 and organization_id=$3 and owner_user_id=$1) room_exists,exists(select 1 from public.room_members where room_id=$2 and organization_id=$3 and user_id=$1 and status='active') member_active,exists(select 1 from device_binding_private.devices where id=$4 and owner_user_id=$1 and room_id=$2 and organization_id=$3 and state='active') device_active,exists(select 1 from device_binding_private.agents where id=$5 and device_id=$4 and owner_user_id=$1 and room_id=$2 and state='active' and binding_epoch=1) binding_active",
          [s.owner.id, s.scope.roomId, s.scope.organizationId, s.origin.deviceId, s.origin.agentId],
        );
        assert.deepEqual(row.rows[0], {
          owner_exists: true,
          room_exists: true,
          member_active: true,
          device_active: true,
          binding_active: true,
        });
        assert.equal((await f.devices.request("heartbeat", {}, s.origin.credential)).status, 200);
      }
      async function healthySurvives() {
        await ownerSurvives(healthy);
        assert.deepEqual(await f.count(healthy.scope.roomId), healthyCounts);
        const history = await f.history(healthy);
        for (const key of [
          "events",
          "runs",
          "cycle",
          "roomMode",
          "roomRevision",
          "highWaterSequence",
          "nextCursor",
        ] as const)
          assert.deepEqual(history[key], healthyHistory[key]);
        const state = await f.stack.db.query(
          "select r.state request_state,a.state attempt_state,a.start_intent_at is not null intended,c.state cycle_state from workflow_private.requests r join workflow_private.attempts a on a.request_id=r.id join workflow_private.cycles c on c.id=r.cycle_id where r.id=$1 and r.room_id=$2 and a.id=$3",
          [healthyRun.requestId, healthy.scope.roomId, healthyRun.attemptId],
        );
        assert.equal(state.rowCount, 1);
        assert.deepEqual(state.rows[0], {
          request_state: "COMPLETED",
          attempt_state: "COMPLETED",
          intended: true,
          cycle_state: "COMPLETED",
        });
      }
      for (const mode of ["hard", "ban", "soft"]) {
        const s = await f.scene(mode);
        const reversed = {
          ...s,
          owner: s.peer,
          peer: s.owner,
          origin: s.responder,
          responder: s.origin,
        };
        const first = await f.start(reversed);
        const a = await f.run(reversed.origin, first.requestId!);
        const q = await f.question(reversed.origin, a);
        const p = await f.run(reversed.responder, q.peerRequestId!);
        await f.complete(reversed.responder, p);
        if (mode === "hard") await f.stack.deleteAccount(s.peer);
        else if (mode === "ban") await f.stack.disable(s.peer);
        else await f.stack.softDeleteAccount(s.peer);
        const history = await f.history(s);
        assert.ok(history.events.some((e) => e.kind === "QUESTION"));
        assert.ok(history.events.some((e) => e.kind === "ANSWER"));
        assert.equal(history.runs.find((r) => r.requestId === a.requestId)?.state, "UNKNOWN");
        assert.equal(history.cycle?.state, "HUMAN_INPUT_REQUIRED");
        denied(await f.device(reversed.origin, "poll"), 401);
        await ownerSurvives(s);
      }
      // Delete an executing peer while the room owner and origin remain live.
      const peerScene = await f.scene("hard-peer");
      const peerStart = await f.start(peerScene);
      const origin = await f.run(peerScene.origin, peerStart.requestId!);
      const question = await f.question(peerScene.origin, origin);
      const peerRun = await f.run(peerScene.responder, question.peerRequestId!);
      await f.stack.deleteAccount(peerScene.peer);
      await ownerSurvives(peerScene);
      denied(await f.ready(peerScene.responder), 401);
      denied(await f.device(peerScene.responder, "poll"), 401);
      denied(
        await f.device(peerScene.responder, "complete", {
          ...f.identity(peerRun),
          terminal: "COMPLETED",
          publicText: "삭제된 peer 결과",
        }),
        401,
      );
      const peerHistory = await f.history(peerScene);
      assert.equal(peerHistory.cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal(
        peerHistory.runs.find((r) => r.requestId === peerRun.requestId)?.state,
        "UNKNOWN",
      );
      assert.ok(
        peerHistory.events.some(
          (e) => e.kind === "QUESTION" && e.questionId === question.questionId,
        ),
      );
      assert.equal((await f.poll(peerScene.origin)).queuedRequest, null);
      const removedPeer = await f.stack.db.query(
        "select (select count(*)::int from auth.users where id=$1) users,(select count(*)::int from public.room_members where room_id=$2 and user_id=$1) members,(select count(*)::int from device_binding_private.devices where id=$3) devices,(select count(*)::int from device_binding_private.agents where id=$4) agents",
        [
          peerScene.peer.id,
          peerScene.scope.roomId,
          peerScene.responder.deviceId,
          peerScene.responder.agentId,
        ],
      );
      assert.deepEqual(removedPeer.rows[0], { users: 0, members: 0, devices: 0, agents: 0 });
      await healthySurvives();
      // A successful raced claim is only a lease; no start-intent is sent.
      const raced = await f.scene("delete-claim-race");
      const racedStart = await f.start(raced);
      const racedOrigin = await f.run(raced.origin, racedStart.requestId!);
      const racedQuestion = await f.question(raced.origin, racedOrigin);
      const beforeClaim = await f.stack.db.query(
        "select state from workflow_private.requests where id=$1 and room_id=$2 and owner_id=$3",
        [racedQuestion.peerRequestId, raced.scope.roomId, raced.peer.id],
      );
      assert.equal(beforeClaim.rowCount, 1);
      assert.equal(beforeClaim.rows[0].state, "QUEUED");
      await assertOwnedStack(f.stack.config);
      assert.ok(raced.peer.email.startsWith(`${f.stack.namespace}-`));
      assert.ok(f.stack.users.has(raced.peer.id));
      assert.equal(f.rooms.get(raced.scope.roomId), raced.scope.organizationId);
      assert.equal(f.stack.organizationOwners.get(raced.scope.organizationId), raced.owner.id);
      assert.notEqual(raced.peer.id, raced.owner.id);
      const ownedPeer = await f.stack.db.query(
        "select exists(select 1 from auth.users where id=$1 and email=$2) owned_user,exists(select 1 from public.organizations where id=$3 and owner_user_id=$4 and owner_user_id<>$1) owned_organization,exists(select 1 from public.rooms where id=$5 and organization_id=$3 and owner_user_id=$4 and owner_user_id<>$1) owned_room,exists(select 1 from public.room_members where organization_id=$3 and room_id=$5 and user_id=$1 and status='active') peer_member,exists(select 1 from device_binding_private.agents where id=$6 and device_id=$7 and owner_user_id=$1 and organization_id=$3 and room_id=$5 and state='active') peer_binding",
        [
          raced.peer.id,
          raced.peer.email,
          raced.scope.organizationId,
          raced.owner.id,
          raced.scope.roomId,
          raced.responder.agentId,
          raced.responder.deviceId,
        ],
      );
      assert.deepEqual(ownedPeer.rows[0], {
        owned_user: true,
        owned_organization: true,
        owned_room: true,
        peer_member: true,
        peer_binding: true,
      });
      await f.save();
      // Only the test parent opens these connections; credentials never leave this process.
      const holder = new Client({
        connectionString: f.stack.config.db,
        ssl: false,
        connectionTimeoutMillis: 3000,
        statement_timeout: 1000,
      });
      const observer = new Client({
        connectionString: f.stack.config.db,
        ssl: false,
        connectionTimeoutMillis: 3000,
        statement_timeout: 1000,
      });
      let transactionOpen = false;
      let pending:
        Promise<[PromiseSettledResult<DeviceResponse>, PromiseSettledResult<void>]> | undefined;
      let race: [PromiseSettledResult<DeviceResponse>, PromiseSettledResult<void>] | undefined;
      try {
        await holder.connect();
        await observer.connect();
        await holder.query("begin");
        transactionOpen = true;
        const locked = await holder.query(
          "select user_id=$2 peer_locked from public.organization_members where organization_id=$1 and user_id=$2 and status='active' for update",
          [raced.scope.organizationId, raced.peer.id],
        );
        assert.equal(locked.rowCount, 1);
        assert.equal(locked.rows[0].peer_locked, true);
        const backend = await holder.query("select pg_backend_pid() pid");
        const barrierPid = backend.rows[0].pid as number;
        assert.ok(Number.isInteger(barrierPid));
        pending = Promise.allSettled([
          f.device(raced.responder, "claim", {
            operationId: randomUUID(),
            requestId: racedQuestion.peerRequestId!,
          }),
          f.stack.deleteAccount(raced.peer),
        ]);
        const observationDeadline = Date.now() + 8000;
        let overlapping = false;
        while (Date.now() < observationDeadline) {
          // Return no query text, parameters, identities or credentials from pg_stat_activity.
          const waiting = await observer.query<{
            pid: number;
            path: number[];
            depth: number;
            wait_event_type: string;
            claim_query: boolean;
            delete_query: boolean;
          }>(
            `with recursive chain(pid,path,depth) as (
    select $1::integer,array[$1::integer],0
    union all
    select a.pid,c.path||a.pid,c.depth+1 from chain c join pg_catalog.pg_stat_activity a on c.pid=any(pg_catalog.pg_blocking_pids(a.pid))
    where c.depth<4 and a.datname=current_database() and a.state='active' and a.wait_event_type='Lock' and not a.pid=any(c.path)
   ) select c.pid,c.path,c.depth,a.wait_event_type,position('workflow_device_claim' in a.query)>0 claim_query,a.query ~* '^[[:space:]]*delete[[:space:]]+from[[:space:]]+("?auth"?[.])?"?users"?([[:space:]]|$)' delete_query from chain c join pg_catalog.pg_stat_activity a on a.pid=c.pid where c.depth>0 and a.state='active' and a.wait_event_type='Lock'`,
            [barrierPid],
          );
          const claimWaiters = waiting.rows.filter(
            (r) => r.claim_query && !r.delete_query && r.wait_event_type === "Lock",
          );
          const deleteWaiters = waiting.rows.filter(
            (r) => r.delete_query && !r.claim_query && r.wait_event_type === "Lock",
          );
          const validPath = (r: (typeof waiting.rows)[number]) =>
            r.path[0] === barrierPid &&
            r.path.at(-1) === r.pid &&
            r.depth === r.path.length - 1 &&
            r.depth >= 1 &&
            r.depth <= 4 &&
            new Set(r.path).size === r.path.length;
          // Either transaction may queue first; both must connect to the exact owned barrier.
          overlapping = claimWaiters.some(
            (c) => validPath(c) && deleteWaiters.some((d) => validPath(d) && c.pid !== d.pid),
          );
          if (overlapping) break;
          await delay(50);
        }
        assert.equal(
          overlapping,
          true,
          "Owned claim and physical delete must both wait on the parent barrier",
        );
        await holder.query("commit");
        transactionOpen = false;
      } finally {
        let cleanupFailed = false;
        if (transactionOpen) {
          try {
            await holder.query("rollback");
          } catch {
            cleanupFailed = true;
          }
        }
        const ended = await Promise.allSettled([holder.end(), observer.end()]);
        if (pending) race = await pending;
        if (cleanupFailed || ended.some((r) => r.status === "rejected"))
          throw new Error("Owned deletion barrier cleanup failed");
      }
      assert.ok(race);
      assert.equal(race[0].status, "fulfilled");
      assert.equal(race[1].status, "fulfilled");
      if (race[0].status !== "fulfilled" || race[1].status !== "fulfilled")
        throw new Error("Owned physical delete race failed");
      const claim = race[0].value;
      assert.ok(claim.status === 200 || claim.status === 401);
      if (claim.status === 200) {
        const leased = good(claim);
        assert.equal(leased.state, "LEASED");
        assert.equal(leased.requestId, racedQuestion.peerRequestId);
        assert.equal(leased.startIntentAt, null);
      } else denied(claim, 401);
      const raceHistory = await f.history(raced);
      assert.equal(raceHistory.cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal(
        raceHistory.runs.find((r) => r.requestId === racedQuestion.peerRequestId)?.state,
        "CANCELLED",
      );
      const finalRace = await f.stack.db.query(
        "select r.state request_state,(select count(*)::int from auth.users where id=$3) deleted_user,(select count(*)::int from device_binding_private.devices where id=$4) deleted_device,(select count(*)::int from workflow_private.requests where cycle_id=r.cycle_id and kind='CONTINUATION') continuations,(select count(*)::int from workflow_private.attempts where request_id=r.id) attempts,(select count(*)::int from workflow_private.attempts where request_id=r.id and state='ABANDONED' and start_intent_at is null) abandoned,(select count(*)::int from workflow_private.attempts where request_id=r.id and (start_intent_at is not null or state in ('LEASED','EXECUTING','UNKNOWN'))) active_or_started from workflow_private.requests r where r.id=$1 and r.room_id=$2",
        [racedQuestion.peerRequestId, raced.scope.roomId, raced.peer.id, raced.responder.deviceId],
      );
      assert.equal(finalRace.rowCount, 1);
      assert.deepEqual(finalRace.rows[0], {
        request_state: "CANCELLED",
        deleted_user: 0,
        deleted_device: 0,
        continuations: 0,
        attempts: claim.status === 200 ? 1 : 0,
        abandoned: claim.status === 200 ? 1 : 0,
        active_or_started: 0,
      });
      denied(await f.device(raced.responder, "poll"), 401);
      denied(
        await f.device(raced.responder, "claim", {
          operationId: randomUUID(),
          requestId: racedQuestion.peerRequestId!,
        }),
        401,
      );
      await ownerSurvives(raced);
      assert.equal((await f.poll(raced.origin)).queuedRequest, null);
      await healthySurvives();
      for (const mode of ["room", "organization"]) {
        const s = await f.scene(`cascade-${mode}`);
        const admitted = await f.start(s);
        const a = await f.run(s.origin, admitted.requestId!);
        const q = await f.question(s.origin, a);
        await f.run(s.responder, q.peerRequestId!);
        await pause(f, s);
        await f.poll(s.origin);
        await f.poll(s.responder);
        await assertOwnedStack(f.stack.config);
        assert.ok(s.owner.email.startsWith(`${f.stack.namespace}-`));
        assert.ok(f.stack.users.has(s.owner.id));
        assert.equal(f.rooms.get(s.scope.roomId), s.scope.organizationId);
        assert.equal(f.stack.organizationOwners.get(s.scope.organizationId), s.owner.id);
        const owned = await f.stack.db.query(
          "select r.id from public.rooms r join public.organizations o on o.id=r.organization_id join auth.users u on u.id=o.owner_user_id where r.id=$1 and o.id=$2 and r.owner_user_id=$3 and o.owner_user_id=$3 and u.email=$4",
          [s.scope.roomId, s.scope.organizationId, s.owner.id, s.owner.email],
        );
        assert.equal(owned.rowCount, 1);
        const captured = await f.stack.db.query(
          "select array(select id from workflow_private.cycles where room_id=$1) cycles,array(select id from workflow_private.requests where room_id=$1) requests,array(select a.id from workflow_private.attempts a join workflow_private.requests r on r.id=a.request_id where r.room_id=$1) attempts,array(select q.id from workflow_private.questions q join workflow_private.cycles c on c.id=q.cycle_id where c.room_id=$1) questions,array(select x.id from workflow_private.controls x join workflow_private.requests r on r.id=x.request_id where r.room_id=$1) controls,array(select event_id from public.workflow_events where room_id=$1) events",
          [s.scope.roomId],
        );
        const ids = captured.rows[0] as {
          cycles: string[];
          requests: string[];
          attempts: string[];
          questions: string[];
          controls: string[];
          events: string[];
        };
        for (const [key, values] of [
          ["cycleId", ids.cycles],
          ["requestId", ids.requests],
          ["attemptId", ids.attempts],
          ["questionId", ids.questions],
          ["controlId", ids.controls],
          ["eventId", ids.events],
        ] as const) {
          assert.ok(values.length > 0);
          const recorded = f.identities.get(key) ?? new Set<string>();
          for (const id of values) recorded.add(id);
          f.identities.set(key, recorded);
        }
        await f.save();
        const childrenQuery =
          "select (select count(*)::int from workflow_private.rooms where room_id=$1) rooms,(select count(*)::int from workflow_private.cycles where room_id=$1 or id=any($2::uuid[])) cycles,(select count(*)::int from workflow_private.generations where cycle_id=any($2::uuid[])) generations,(select count(*)::int from workflow_private.requests where room_id=$1 or id=any($3::uuid[])) requests,(select count(*)::int from workflow_private.attempts where id=any($4::uuid[])) attempts,(select count(*)::int from workflow_private.questions where id=any($5::uuid[])) questions,(select count(*)::int from workflow_private.controls where id=any($6::uuid[])) controls,(select count(*)::int from workflow_private.readiness where room_id=$1) readiness,(select count(*)::int from workflow_private.receipts where room_id=$1) receipts,(select count(*)::int from public.workflow_events where room_id=$1 or event_id=any($7::uuid[])) events,(select count(*)::int from public.workflow_runs where room_id=$1 or request_id=any($3::uuid[])) runs";
        const parameters = [
          s.scope.roomId,
          ids.cycles,
          ids.requests,
          ids.attempts,
          ids.questions,
          ids.controls,
          ids.events,
        ];
        const before = await f.stack.db.query(childrenQuery, parameters);
        assert.ok(Object.values(before.rows[0]).every((n) => Number(n) > 0));
        const deleted =
          mode === "room"
            ? await f.stack.db.query(
                "delete from public.rooms where id=$1 and organization_id=$2 and owner_user_id=$3 returning id",
                [s.scope.roomId, s.scope.organizationId, s.owner.id],
              )
            : await f.stack.db.query(
                "delete from public.organizations where id=$1 and owner_user_id=$2 returning id",
                [s.scope.organizationId, s.owner.id],
              );
        assert.equal(deleted.rowCount, 1);
        const children = await f.stack.db.query(childrenQuery, parameters);
        assert.deepEqual(children.rows[0], {
          rooms: 0,
          cycles: 0,
          generations: 0,
          requests: 0,
          attempts: 0,
          questions: 0,
          controls: 0,
          readiness: 0,
          receipts: 0,
          events: 0,
          runs: 0,
        });
        const parents = await f.stack.db.query(
          "select (select count(*)::int from public.rooms where id=$1) rooms,(select count(*)::int from public.organizations where id=$2) organizations,(select count(*)::int from auth.users where id=$3) owners,(select count(*)::int from public.room_members where room_id=$1) members,(select count(*)::int from device_binding_private.devices where room_id=$1) devices",
          [s.scope.roomId, s.scope.organizationId, s.owner.id],
        );
        assert.deepEqual(parents.rows[0], {
          rooms: 0,
          organizations: mode === "room" ? 1 : 0,
          owners: 1,
          members: 0,
          devices: 0,
        });
        denied(await f.device(s.origin, "poll"), 401);
        denied(await f.device(s.responder, "poll"), 401);
        await healthySurvives();
      }
      const fks = await f.stack.db.query(
        "select count(*)::int n from pg_constraint where connamespace='workflow_private'::regnamespace and contype='f' and confrelid='auth.users'::regclass",
      );
      assert.equal(fks.rows[0].n, 0);
    }),
);
test("should separate interrupt requests acknowledgements and confirmed room pause", opts, () =>
  workflowCase("control", async (f) => {
    const own = await f.scene("self");
    const ownStart = await f.start(own);
    const ownRun = await f.run(own.origin, ownStart.requestId!);
    const ownQuestion = await f.question(own.origin, ownRun);
    const otherRun = await f.run(own.responder, ownQuestion.peerRequestId!);
    good(
      await f.human(own.owner, "interrupt", {
        roomId: own.scope.roomId,
        operationId: randomUUID(),
        agentId: own.origin.agentId!,
        bindingEpoch: 1,
        expectedRoomRevision: 1,
      }),
    );
    assert.ok((await f.poll(own.origin)).control);
    assert.equal((await f.poll(own.responder)).control, null);
    assert.equal((await f.poll(own.responder)).attempt?.state, "EXECUTING");
    await f.complete(own.origin, ownRun, "INTERRUPTED");
    await f.complete(own.responder, otherRun);
    const s = await f.scene();
    const first = await f.start(s);
    const a = await f.run(s.origin, first.requestId!);
    denied(
      await f.human(s.peer, "interrupt", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        agentId: s.origin.agentId!,
        bindingEpoch: 1,
        expectedRoomRevision: 1,
      }),
      403,
    );
    const paused = await pause(f, s);
    assert.equal(paused.roomMode, "PAUSING");
    const poll = await f.poll(s.origin);
    assert.ok(poll.control);
    good(
      await f.device(s.origin, "interrupt-ack", {
        ...f.identity(a),
        controlId: poll.control.controlId,
      }),
    );
    assert.equal((await f.read(s)).roomMode, "PAUSING");
    denied(await resumeRoom(f, s), 409);
    await f.complete(s.origin, a, "INTERRUPTED");
    assert.equal((await f.read(s)).roomMode, "PAUSED");
    good(await resumeRoom(f, s));
    const next = await f.start(s);
    const run = await f.run(s.origin, next.requestId!);
    await Promise.all([pause(f, s), f.complete(s.origin, run)]);
    assert.equal((await f.read(s)).roomMode, "PAUSED");
    assert.equal(
      (await f.read(s)).runs.find((r) => r.requestId === run.requestId)?.state,
      "COMPLETED",
    );
  }),
);
test("should enforce live public event access and private device payload ownership", opts, () =>
  workflowCase("access", async (f) => {
    const s = await f.scene();
    const first = await f.start(s);
    const anon = createClient(f.stack.config.api, f.stack.config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const person = s.observer.web.dataClient();
    assert.equal(
      (await person.from("workflow_events").select("*").eq("room_id", s.scope.roomId)).error,
      null,
    );
    assert.equal((await anon.from("workflow_events").select("*")).error !== null, true);
    assert.equal(
      (await person.from("workflow_events").insert({ room_id: s.scope.roomId })).error !== null,
      true,
    );
    assert.equal(
      (await person.schema("workflow_private").from("requests").select("*")).error !== null,
      true,
    );
    const body = { protocol: 1, agentId: s.origin.agentId!, bindingEpoch: 1 };
    assert.ok(
      (
        await anon.rpc("workflow_device_poll", {
          p_body: body,
          p_secret: digest(s.origin.credential!),
        })
      ).error,
    );
    const allowed = await anon.rpc("workflow_device_poll", {
      p_body: body,
      p_secret: s.origin.credential,
    });
    assert.equal(allowed.error, null);
    assert.equal(allowed.data.queuedRequest.requestId, first.requestId);
    denied(
      await f.device(s.responder, "claim", {
        operationId: randomUUID(),
        requestId: first.requestId!,
      }),
      403,
    );
    await s.owner.web.mutate("revoke-room-member", {
      roomId: s.scope.roomId,
      userId: s.observer.id,
    });
    const rows = await person.from("workflow_events").select("*").eq("room_id", s.scope.roomId);
    assert.equal(rows.error, null);
    assert.equal(rows.data?.length, 0);
  }),
);
test(
  "should recover ordered history after duplicate delivery gaps and reconnect",
  { timeout: 300000 },
  () =>
    workflowCase("history", async (f) => {
      const s = await f.scene();
      for (let i = 0; i < 34; i++) {
        const admitted = await f.start(s);
        const a = await f.run(s.origin, admitted.requestId!);
        await f.complete(s.origin, a);
      }
      const history = await f.history(s);
      assert.equal(history.runs.length, 32);
      const states = new Map<string, string>();
      for (const e of history.events) {
        if (e.kind === "RUN_STATE") states.set(e.requestId!, e.runState!);
      }
      assert.equal(states.size, 34);
      assert.ok([...states.values()].every((v) => v === "COMPLETED"));
      assert.deepEqual(
        history.events.map((e) => e.sequence),
        Array.from({ length: history.events.length }, (_, i) => i + 1),
      );
      const first = await f.read(s);
      assert.equal(first.events.length, 16);
      assert.equal(first.nextCursor, first.events.at(-1)?.sequence);
      assert.ok(first.highWaterSequence > first.nextCursor);
      assert.equal(first.hasMore, true);
      assert.deepEqual((await f.read(s)).events, first.events);
      const next = await f.read(s, s.owner, first.nextCursor);
      assert.equal(next.events[0].sequence, first.nextCursor + 1);
      const empty = await f.read(s, s.owner, history.nextCursor);
      assert.equal(empty.nextCursor, history.nextCursor);
      assert.equal(empty.events.length, 0);
      await s.owner.web.mutate("revoke-room-member", {
        roomId: s.scope.roomId,
        userId: s.observer.id,
      });
      denied(await f.human(s.observer, "read", { roomId: s.scope.roomId, afterSequence: 0 }), 403);
    }),
);
test(
  "should keep coordinator secrets and runtime locators out of storage responses and artifacts",
  opts,
  () =>
    workflowCase("privacy", async (f) => {
      const s = await f.scene();
      const turn = await exchange(f, s, true);
      const history = await f.history(s, s.observer);
      const poll = await f.poll(s.origin);
      const events = await s.owner.web
        .dataClient()
        .from("workflow_events")
        .select("*")
        .eq("room_id", s.scope.roomId);
      const publicText = JSON.stringify({ history, poll, events: events.data });
      for (const value of [
        s.origin.credential!,
        s.origin.proof,
        s.origin.code,
        s.responder.credential!,
        f.stack.config.adminKey,
        "private-native-",
        f.devices.root,
        "providerError",
        "credentialHash",
        "proofHash",
        "nativeSession",
      ])
        assert.equal(publicText.includes(value), false);
      assert.ok(publicText.includes("합성 공개 질문"));
      assert.ok(publicText.includes("합성 공개 결과"));
      assert.ok(
        history.events.some(
          (e) =>
            e.kind === "SPEECH" &&
            e.senderKind === "AGENT" &&
            e.requestId === turn.origin.requestId &&
            e.adoption === "ACCEPTED",
        ),
      );
      const final = await f.run(s.origin, turn.continuation);
      const identity = {
        ...f.identity(final),
        terminal: "COMPLETED",
        publicText: "승인된 최종 공개 결과",
      };
      good(await f.device(s.origin, "complete", identity));
      good(await f.device(s.origin, "complete", identity));
      const finalHistory = await f.history(s);
      assert.equal(
        finalHistory.events.filter((e) => e.kind === "SPEECH" && e.requestId === final.requestId)
          .length,
        1,
      );
      assert.equal(
        finalHistory.events.find((e) => e.kind === "SPEECH" && e.requestId === final.requestId)
          ?.publicText,
        "승인된 최종 공개 결과",
      );
      const manifestFile = join(f.devices.root, "workflow-identity.json");
      assert.equal((await lstat(manifestFile)).mode & 0o777, 0o600);
      const manifest = await readFile(manifestFile, "utf8");
      for (const value of [
        s.origin.credential!,
        s.origin.proof,
        f.stack.config.adminKey,
        "nativeSession",
        "private-native-",
      ])
        assert.equal(manifest.includes(value), false);
      assert.ok(manifest.includes(turn.continuation));
      const raw = await s.owner.web.post("/api/investigations/start", {
        protocol: 1,
        providerError: "private",
      });
      assert.equal(raw.status, 400);
      assert.deepEqual(await raw.json(), { ok: false, error: { code: "INVALID_BODY" } });
    }),
);
test(
  "should refuse workflow fixture effects outside the owned stack and clean exact identities",
  opts,
  () =>
    workflowCase("guard", async (f) => {
      assert.equal(Object.keys(frozenAccessMigrations).length, 5);
      await assertDeviceMigrationSources();
      await assertOwnedStack(f.stack.config);
      for (const config of [
        { ...f.stack.config, project: "another-project" },
        { ...f.stack.config, api: "https://remote.example" },
        { ...f.stack.config, db: "postgresql://127.0.0.1:5432/postgres" },
      ])
        assert.throws(() => assertOwnedConfig(config));
      const healthy = await f.scene("healthy");
      const broken = await f.scene("fault");
      const admitted = await f.start(broken);
      const a = await f.run(broken.origin, admitted.requestId!);
      await f.expire("lease", a.attemptId);
      await f.poll(broken.origin);
      assert.equal((await f.read(broken)).runs[0].state, "UNKNOWN");
      await f.devices.cleanupPairing(broken.origin.name);
      assert.equal(
        (await f.devices.request("heartbeat", {}, healthy.origin.credential)).status,
        200,
      );
      assert.equal((await f.read(healthy)).roomMode, "ACTIVE");
      await assert.rejects(f.expire("lease", randomUUID()));
      const identity = JSON.parse(
        await readFile(join(f.devices.root, "workflow-identity.json"), "utf8"),
      );
      assert.ok(
        identity.operations.some((op: { roomId: string }) => op.roomId === broken.scope.roomId),
      );
      assert.ok(identity.records.attemptId.includes(a.attemptId));
    }),
);
