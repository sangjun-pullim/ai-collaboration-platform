import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  workflowCase,
  type WorkflowFixture,
  type HumanDirectScene,
} from "../helpers/workflow-fixture.js";
import { runtimeGate } from "../helpers/owned-runtime-fixture.js";
import {
  HumanDirectRuntimeFixture,
  requireHumanDirectMigration,
} from "../helpers/human-direct-fixture.js";
import { assertActorPreconditionSchema } from "../helpers/human-direct-upgrade-fixture.js";
import type { DeviceResponse } from "../helpers/device-binding-fixture.js";
import { assertOwnedStack } from "../helpers/local-access-stack.js";
import { digest, scopedNamespace } from "../../packages/local-connector/src/runtime-contracts.ts";
import {
  projectResponse,
  type DirectCycleSummary,
  type Body,
} from "../../src/features/investigation-coordinator/contracts.ts";

const options = { timeout: 300000 };
function accepted(response: DeviceResponse) {
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  return response.data.data as Record<string, unknown>;
}
function refused(response: DeviceResponse, status: number) {
  assert.equal(response.status, status);
  assert.equal(response.data.ok, false);
  assert.deepEqual(Object.keys(response.data.error as object), ["code"]);
}
async function fields(
  f: WorkflowFixture,
  s: HumanDirectScene,
  operationId = randomUUID(),
): Promise<Body> {
  const page = await f.read(s, s.requester);
  return {
    roomId: s.scope.roomId,
    operationId,
    expectedUserId: s.requester.id,
    targetAgentId: s.responder.agentId!,
    targetEpoch: await f.epoch(s.responder),
    expectedRoomRevision: page.roomRevision,
    publicText: "한글 직접 질문",
    confirmed: true,
  };
}
async function cancel(
  f: WorkflowFixture,
  s: HumanDirectScene,
  requestId: string,
  person = s.requester,
  operationId = randomUUID(),
) {
  const page = await f.read(s, person);
  return f.human(person, "cancel", {
    roomId: s.scope.roomId,
    operationId,
    requestId,
    expectedRoomRevision: page.roomRevision,
  });
}
async function noRequesterDevice(f: WorkflowFixture, s: HumanDirectScene) {
  assert.equal(f.stack.users.has(s.requester.id), true);
  assert.equal(
    [...f.devices.profiles.values()].some((profile) => profile.ownerUserId === s.requester.id),
    false,
  );
  const rows = await f.stack.db.query(
    `select
    (select count(*)::int from device_binding_private.devices where owner_user_id=$1) devices,
    (select count(*)::int from device_binding_private.workspaces where owner_user_id=$1) workspaces,
    (select count(*)::int from device_binding_private.agents where owner_user_id=$1) agents,
    (select role from public.room_members where room_id=$2 and user_id=$1) role`,
    [s.requester.id, s.scope.roomId],
  );
  assert.deepEqual(rows.rows[0], { devices: 0, workspaces: 0, agents: 0, role: "participant" });
}

test("should admit a human question without a requester device or agent", options, () =>
  workflowCase("direct-admit", async (f) => {
    await requireHumanDirectMigration(f);
    const s = await f.directScene();
    await noRequesterDevice(f, s);
    const admitted = await f.ask(s);
    const h = await f.history(s, s.requester);
    const cy = h.cycle as DirectCycleSummary;
    assert.equal(cy.mode, "DIRECT");
    assert.equal(cy.targetAgentId, s.responder.agentId);
    assert.equal(cy.generation, 1);
    assert.equal(cy.runsReserved, 1);
    assert.equal(cy.peerRoundsReserved, 0);
    assert.equal(cy.canInterrupt, true);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].requestKind, "PEER");
    assert.equal(h.runs[0].requestId, admitted.requestId);
    const question = h.events.find((event) => event.kind === "QUESTION")!;
    assert.equal(question.senderKind, "HUMAN");
    assert.equal(question.senderAlias, "질문 참가자");
    assert.equal(question.agentId, s.responder.agentId);
    assert.equal(question.requestKind, "PEER");
    assert.equal(question.questionId, h.runs[0].questionId);
    assert.equal(question.requestId, admitted.requestId);
    assert.equal(
      h.bindings.every((binding) => !binding.owned),
      true,
    );
    const stored = await f.stack.db.query(
      `select c.origin_agent_id, c.origin_epoch, c.origin_owner_id=$3 requester,
    q.source, q.origin_request_id, q.origin_epoch question_origin_epoch, q.requester_user_id=$3 question_requester,
    g.origin_epoch generation_origin_epoch,
    (select count(*)::int from workflow_private.requests where cycle_id=c.id and kind<>'PEER') other_runs
    from workflow_private.cycles c join workflow_private.questions q on q.cycle_id=c.id
    join workflow_private.generations g on g.cycle_id=c.id where c.id=$1 and c.room_id=$2`,
      [admitted.cycleId, s.scope.roomId, s.requester.id],
    );
    assert.deepEqual(stored.rows[0], {
      origin_agent_id: null,
      origin_epoch: null,
      requester: true,
      source: "HUMAN",
      origin_request_id: null,
      question_origin_epoch: null,
      question_requester: true,
      generation_origin_epoch: null,
      other_runs: 0,
    });
    await noRequesterDevice(f, s);
  }),
);

test(
  "should answer own AI questions in shared history and allow a follow-up after completion",
  options,
  () =>
    workflowCase("direct-own-answer", async (workflow) => {
      const f = await HumanDirectRuntimeFixture.open(workflow, "own-answer");
      const own = { ...f.scene, requester: f.scene.owner };
      try {
        for (const text of ["내 AI 공유 질문", "내 AI 후속 질문"]) {
          const body = { ...(await fields(workflow, own)), publicText: text };
          const admission = accepted(await workflow.human(own.requester, "ask", body));
          assert.deepEqual(accepted(await workflow.human(own.requester, "ask", body)), admission);
          const before = await workflow.history(own, own.requester);
          assert.equal(
            before.bindings.find((binding) => binding.agentId === own.responder.agentId)?.owned,
            true,
          );
          assert.equal(
            before.runs.find((run) => run.requestId === admission.requestId)?.state,
            "QUEUED",
          );
          assert.equal((await f.run()).state, "UPLOADED");
          const ownerHistory = await workflow.history(own, own.requester);
          const observerHistory = await workflow.history(own, own.observer);
          const colleagueHistory = await workflow.history(own, f.scene.requester);
          assert.deepEqual(observerHistory.events, ownerHistory.events);
          assert.deepEqual(colleagueHistory.events, ownerHistory.events);
          const question = ownerHistory.events.find(
            (event) => event.kind === "QUESTION" && event.requestId === admission.requestId,
          )!;
          assert.equal(question.senderKind, "HUMAN");
          assert.equal(question.publicText, text);
          assert.equal(question.agentId, own.responder.agentId);
          assert.equal(
            ownerHistory.runs.find((run) => run.requestId === admission.requestId)?.state,
            "COMPLETED",
          );
          assert.ok(
            ownerHistory.events.some(
              (event) =>
                event.kind === "ANSWER" &&
                event.requestId === admission.requestId &&
                event.adoption === "ACCEPTED",
            ),
          );
          const attempt = (await f.runtime.read())!.attempts.find(
            (attempt) => attempt.requestId === admission.requestId,
          )!;
          assert.equal(attempt.receipt!.continuationRequestId, null);
        }
        assert.equal(f.adapter.starts, 2);
        for (const action of ["poll", "claim", "start-intent", "complete"])
          assert.ok(f.requests.some((request) => request.action === action));
        assert.equal((await workflow.history(own, own.requester)).runs.length, 2);
      } finally {
        await f.close();
      }
    }),
);

test(
  "should cancel queued and executing own AI questions and admit a follow-up only after terminal",
  options,
  () =>
    workflowCase("direct-own-cancel", async (workflow) => {
      const f = await HumanDirectRuntimeFixture.open(workflow, "own-cancel");
      const own = { ...f.scene, requester: f.scene.owner };
      try {
        const queued = await workflow.ask(own);
        assert.equal(accepted(await cancel(workflow, own, queued.requestId!)).state, "REQUESTED");
        assert.equal(
          (await workflow.read(own)).runs.find((run) => run.requestId === queued.requestId)?.state,
          "CANCELLED",
        );
        assert.equal(f.adapter.starts, 0);
        const executing = await workflow.ask(own);
        f.adapter.hold = runtimeGate();
        const publish = runtimeGate();
        f.beforeFetch = async (action) => {
          if (action === "complete") await publish.promise;
        };
        const running = f.run();
        try {
          await f.adapter.entered.promise;
          assert.equal(
            accepted(await cancel(workflow, own, executing.requestId!)).state,
            "REQUESTED",
          );
          refused(await workflow.human(own.requester, "ask", await fields(workflow, own)), 409);
          publish.release();
          assert.equal((await running).state, "UPLOADED");
        } finally {
          publish.release();
          f.adapter.hold.release();
          await running;
        }
        assert.equal(f.adapter.interrupts, 1);
        assert.equal(
          (await workflow.read(own)).runs.find((run) => run.requestId === executing.requestId)
            ?.state,
          "INTERRUPTED",
        );
        f.adapter.hold = null;
        f.beforeFetch = undefined;
        const follow = await workflow.ask(own);
        assert.equal((await f.run()).state, "UPLOADED");
        assert.equal(
          (await workflow.read(own)).runs.find((run) => run.requestId === follow.requestId)?.state,
          "COMPLETED",
        );
        assert.equal(f.adapter.starts, 2);
      } finally {
        await f.close();
      }
    }),
);

test("should preserve own AI admission guards and reject pairing two same-owner AIs", options, () =>
  workflowCase("direct-own-denials", async (f) => {
    await requireHumanDirectMigration(f);
    const original = await f.directScene("own-denials");
    const s = { ...original, requester: original.owner };
    const body = await fields(f, s);
    const noEffect = async (run: () => Promise<void>) => {
      const before = await directEffects(f, s);
      await run();
      assert.deepEqual(await directEffects(f, s), before);
    };
    await noEffect(async () => {
      for (const person of [s.observer, s.outsider])
        refused(await f.human(person, "ask", { ...body, expectedUserId: person.id }), 403);
      refused(
        await f.human(s.owner, "ask", { ...body, expectedUserId: original.requester.id }),
        403,
      );
      refused(await f.human(s.owner, "ask", { ...body, targetAgentId: randomUUID() }), 403);
      const other = await f.directScene("own-foreign");
      refused(
        await f.human(s.owner, "ask", { ...body, targetAgentId: other.responder.agentId! }),
        403,
      );
      refused(await f.human(s.owner, "ask", { ...body, targetEpoch: 99 }), 409);
      refused(await f.human(s.owner, "ask", { ...body, expectedRoomRevision: 99 }), 409);
    });
    for (const expired of [false, true]) {
      await f.ready(s.responder, expired);
      if (expired) await f.expire("readiness", s.responder.agentId!);
      await noEffect(async () => refused(await f.human(s.owner, "ask", body), 409));
    }
    await f.ready(s.responder);
    const sameOwner = await f.devices.register(
      await f.devices.connected(s.owner, s.scope, "own-pair-peer"),
    );
    await f.ready(sameOwner);
    await noEffect(async () =>
      refused(
        await f.human(s.owner, "start", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          originAgentId: s.responder.agentId!,
          peerAgentId: sameOwner.agentId!,
          originEpoch: await f.epoch(s.responder),
          peerEpoch: await f.epoch(sameOwner),
          expectedRoomRevision: (await f.read(s)).roomRevision,
          publicText: "동일 소유 AI 조사 거부",
          confirmed: true,
        }),
        403,
      ),
    );
    accepted(
      await f.human(s.owner, "pause", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        expectedRoomRevision: (await f.read(s)).roomRevision,
      }),
    );
    await noEffect(async () => refused(await f.human(s.owner, "ask", await fields(f, s)), 409));
  }),
);

test("should preserve paired workflow and peer wire compatibility", options, () =>
  workflowCase("direct-paired-regression", async (f) => {
    await requireHumanDirectMigration(f);
    const s = await f.scene();
    const admitted = await f.start(s);
    const origin = await f.run(s.origin, admitted.requestId!);
    const question = await f.question(s.origin, origin);
    const peer = await f.run(s.responder, question.peerRequestId!);
    assert.deepEqual(projectResponse("start-intent", peer), peer);
    assert.deepEqual(
      Object.keys(peer.payload).sort(),
      [
        "requestId",
        "cycleId",
        "agentId",
        "bindingEpoch",
        "roomRevision",
        "requestKind",
        "questionId",
        "publicText",
        "replyText",
        "deadline",
      ].sort(),
    );
    assert.equal((await f.complete(s.responder, peer)).adoption, "PENDING");
    const receipt = await f.complete(s.origin, origin);
    assert.ok(receipt.continuationRequestId);
    await f.complete(s.origin, await f.run(s.origin, receipt.continuationRequestId));
    const page = await f.history(s);
    assert.equal(Object.hasOwn(page.cycle!, "mode"), false);
    assert.deepEqual(page.runs.map((run) => run.requestKind).sort(), [
      "CONTINUATION",
      "ORIGIN",
      "PEER",
    ]);
    assert.deepEqual(
      page.events.filter((event) => event.kind === "ANSWER").map((event) => event.adoption),
      ["PENDING", "ACCEPTED"],
    );
  }),
);

test("should reject observer forged actors and invalid direct targets", options, () =>
  workflowCase("direct-denials", async (f) => {
    await requireHumanDirectMigration(f);
    const s = await f.directScene();
    const body = await fields(f, s);
    for (const person of [s.observer, s.outsider])
      refused(await f.human(person, "ask", { ...body, expectedUserId: person.id }), 403);
    const other = await f.directScene("foreign");
    refused(
      await f.human(s.requester, "ask", { ...body, targetAgentId: other.responder.agentId! }),
      403,
    );
    refused(await f.human(s.requester, "ask", { ...body, targetEpoch: 99 }), 409);
    await f.ready(s.responder, false);
    refused(await f.human(s.requester, "ask", body), 409);
    await f.ready(s.responder);
    await f.expire("readiness", s.responder.agentId!);
    refused(await f.human(s.requester, "ask", body), 409);
    for (const extra of [
      { actor: "forged" },
      { ownerId: s.requester.id },
      { root: "/SYNTHETIC_PRIVATE" },
      { originAgentId: s.responder.agentId },
      { publicText: "\ud800" },
      { publicText: "한".repeat(3000) },
    ]) {
      const response = await s.requester.web.post("/api/investigations/ask", {
        protocol: 1,
        ...body,
        ...extra,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error: { code: "INVALID_BODY" } });
    }
    const rpc = await s.requester.web
      .dataClient()
      .rpc("workflow_human_ask", { p_body: { protocol: 1, ...body, actor: "forged" } });
    assert.equal(rpc.error?.message, "INVALID_BODY");
    const malformed = await s.requester.web.request("/api/investigations/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: f.stack.config.app },
      body: new Uint8Array([0xff]),
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { ok: false, error: { code: "INVALID_BODY" } });
    const oversized = await s.requester.web.post("/api/investigations/ask", {
      protocol: 1,
      ...body,
      publicText: "x".repeat(17000),
    });
    assert.equal(oversized.status, 400);
    assert.equal((await f.count(s.scope.roomId)).requests, 0);
  }),
);

test("should replay the same direct admission without executing twice", options, () =>
  workflowCase("direct-replay", async (f) => {
    await requireHumanDirectMigration(f);
    const s = await f.directScene();
    const body = await fields(f, s);
    const responses = await Promise.all([
      f.human(s.requester, "ask", body),
      f.human(s.requester, "ask", body),
    ]);
    const first = accepted(responses[0]);
    assert.deepEqual(accepted(responses[1]), first);
    const count = await f.count(s.scope.roomId);
    assert.equal(count.requests, 1);
    assert.deepEqual(accepted(await f.human(s.requester, "ask", body)), first);
    assert.deepEqual(await f.count(s.scope.roomId), count);
    refused(await f.human(s.requester, "ask", { ...body, publicText: "다른 질문" }), 409);
    const alternate = await f.devices.register(
      await f.devices.connected(s.owner, s.scope, "alternate-target"),
    );
    refused(await f.human(s.requester, "ask", { ...body, targetAgentId: alternate.agentId! }), 409);
    const h = await f.history(s, s.requester);
    assert.deepEqual((await f.read(s, s.requester)).events, h.events);
    assert.equal((await f.read(s, s.requester, h.nextCursor)).events.length, 0);
    for (const reverse of [false, true]) {
      const raced = await f.directScene(`pause-${reverse}`);
      // Both orderings enter the same real guard/scope/room lock chain.
      const raceBody = await fields(f, raced);
      const jobs = [
        () => f.human(raced.requester, "ask", raceBody),
        () =>
          f.human(raced.owner, "pause", {
            roomId: raced.scope.roomId,
            operationId: randomUUID(),
            expectedRoomRevision: 1,
          }),
      ];
      if (reverse) jobs.reverse();
      const result = await Promise.all(jobs.map((job) => job()));
      assert.equal(
        result.every((response) => [200, 409].includes(response.status)),
        true,
      );
      const final = await f.read(raced, raced.requester);
      assert.equal(final.roomMode, "PAUSED");
      assert.equal(
        final.runs.every((run) => run.state === "CANCELLED"),
        true,
      );
      assert.ok((await f.count(raced.scope.roomId)).requests <= 1);
    }
    for (const reverse of [false, true]) {
      const paired = await f.scene(`start-${reverse}`);
      const pairBody = {
        roomId: paired.scope.roomId,
        operationId: randomUUID(),
        originAgentId: paired.origin.agentId!,
        peerAgentId: paired.responder.agentId!,
        originEpoch: 1,
        peerEpoch: 1,
        expectedRoomRevision: 1,
        publicText: "경합",
        confirmed: true,
      };
      const directBody = {
        roomId: paired.scope.roomId,
        operationId: randomUUID(),
        targetAgentId: paired.responder.agentId!,
        targetEpoch: 1,
        expectedRoomRevision: 1,
        publicText: "직접 경합",
        confirmed: true,
      };
      const jobs = [
        () => f.human(paired.owner, "start", pairBody),
        () => f.human(paired.owner, "ask", directBody),
      ];
      if (reverse) jobs.reverse();
      assert.deepEqual(
        (await Promise.all(jobs.map((job) => job()))).map((response) => response.status).sort(),
        [200, 409],
      );
      assert.equal((await f.count(paired.scope.roomId)).requests, 1);
    }
  }),
);

test("should execute only the selected responder and never continue automatically", options, () =>
  workflowCase("direct-runner", async (workflow) => {
    const f = await HumanDirectRuntimeFixture.open(workflow, "one-responder");
    try {
      await noRequesterDevice(workflow, f.scene);
      const admitted = await workflow.ask(f.scene);
      f.adapter.afterAck = async (authority, turnId) => {
        await assert.rejects(
          authority.tool({
            namespace: scopedNamespace,
            tool: "ask_peer",
            callId: randomUUID(),
            threadId: authority.context.threadId,
            turnId,
            arguments: {
              question: "재귀 질문 금지",
              evidence: [{ path: "public-context.txt", startLine: 1, endLine: 1 }],
            },
          }),
          { code: "TOOL_REJECTED" },
        );
        refused(
          await workflow.device(f.scene.responder, "question", {
            ...workflow.identity(authority.attempt),
            publicText: "재귀 질문 금지",
            confirmed: true,
          }),
          409,
        );
      };
      let lost = false;
      f.loseResponse = (action) => (action === "complete" && !lost ? ((lost = true), true) : false);
      assert.equal((await f.run()).state, "TERMINAL");
      const durable = (await f.runtime.read())!.attempts[0];
      assert.ok(durable.terminal);
      assert.equal(durable.receipt, null);
      assert.equal((await f.run()).state, "UPLOADED");
      const publications = f.requests.filter((request) => request.action === "complete");
      assert.equal(publications.length, 2);
      assert.deepEqual(publications[0].body, publications[1].body);
      assert.equal(f.adapter.starts, 1);
      assert.equal(
        f.requests.every((request) => request.body.agentId === f.scene.responder.agentId),
        true,
      );
      assert.equal(
        f.requests.some((request) => request.action === "question"),
        false,
      );
      const h = await workflow.history(f.scene, f.scene.requester);
      assert.equal(h.runs.length, 1);
      assert.equal(h.runs[0].requestId, admitted.requestId);
      assert.equal(h.runs[0].requestKind, "PEER");
      assert.equal(h.runs[0].state, "COMPLETED");
      assert.deepEqual(
        h.events.filter((event) => event.kind === "ANSWER").map((event) => event.adoption),
        ["PENDING", "ACCEPTED"],
      );
      const saved = (await f.runtime.read())!;
      assert.equal(saved.attempts[0].receipt!.continuationRequestId, null);
      const body = f.requests.find((request) => request.action === "complete")!.body;
      accepted(await workflow.device(f.scene.responder, "complete", body));
      assert.deepEqual((await workflow.history(f.scene, f.scene.requester)).events, h.events);
      const beforePoll = f.requests.length;
      assert.equal((await f.run()).state, "UPLOADED");
      assert.equal(
        f.requests
          .slice(beforePoll)
          .some((request) =>
            ["claim", "start-intent", "question", "complete"].includes(request.action),
          ),
        false,
      );
      assert.deepEqual((await f.runtime.read())!.attempts, saved.attempts);
      assert.equal(f.adapter.starts, 1);
      await noRequesterDevice(workflow, f.scene);
    } finally {
      await f.close();
    }
  }),
);

test("should protect direct results after requester or target revocation", options, () =>
  workflowCase("direct-revocation", async (f) => {
    await requireHumanDirectMigration(f);
    for (const cause of ["membership", "role", "revision", "deadline"]) {
      const s = await f.directScene(cause);
      const admission = await f.ask(s);
      const attempt = await f.run(s.responder, admission.requestId!);
      if (cause === "membership")
        await s.owner.web.mutate("revoke-room-member", {
          roomId: s.scope.roomId,
          userId: s.requester.id,
        });
      if (cause === "role") {
        await assertOwnedStack(f.stack.config);
        assert.equal(f.rooms.has(s.scope.roomId) && f.stack.users.has(s.requester.id), true);
        const changed = await f.stack.db.query(
          "update public.room_members set role='observer' where room_id=$1 and user_id=$2 and role='participant' returning user_id",
          [s.scope.roomId, s.requester.id],
        );
        assert.equal(changed.rowCount, 1);
      }
      if (cause === "revision")
        accepted(
          await f.human(s.owner, "pause", {
            roomId: s.scope.roomId,
            operationId: randomUUID(),
            expectedRoomRevision: 1,
          }),
        );
      if (cause === "deadline") await f.expire("cycle", admission.cycleId);
      const result = await f.complete(s.responder, attempt);
      assert.equal(result.adoption, "HISTORICAL");
      assert.equal(result.continuationRequestId, null);
      assert.equal(
        (await f.history(s)).events.some(
          (event) => event.kind === "ANSWER" && event.adoption === "ACCEPTED",
        ),
        false,
      );
      if (cause === "membership" || cause === "role") {
        refused(
          await f.human(s.requester, "ask", {
            roomId: s.scope.roomId,
            operationId: randomUUID(),
            targetAgentId: s.responder.agentId!,
            targetEpoch: 1,
            expectedRoomRevision: 1,
            publicText: "권한 상실",
            confirmed: true,
          }),
          403,
        );
      }
    }
    const rotating = await HumanDirectRuntimeFixture.open(f, "rotating-responder");
    try {
      await f.ask(rotating.scene);
      const original = (await rotating.state.read())!.credential!;
      const entered = runtimeGate(),
        release = runtimeGate();
      let delayed = false;
      rotating.beforeFetch = async (action, _body, credential) => {
        if (action === "complete" && credential === original && !delayed) {
          delayed = true;
          entered.release();
          await release.promise;
        }
      };
      const running = rotating.run();
      try {
        await entered.promise;
        await rotating.state.transaction(() => rotating.connector.rotate());
      } finally {
        release.release();
      }
      assert.equal((await running).state, "UPLOADED");
      const complete = rotating.requests.filter((request) => request.action === "complete");
      assert.equal(complete.length, 2);
      assert.deepEqual(complete[0].body, complete[1].body);
      assert.equal(rotating.adapter.starts, 1);
      await noRequesterDevice(f, rotating.scene);
    } finally {
      await rotating.close();
    }
    const outbox = await HumanDirectRuntimeFixture.open(f, "revoked-outbox");
    try {
      await f.ask(outbox.scene);
      let lost = false;
      outbox.loseResponse = (action) =>
        action === "complete" && !lost ? ((lost = true), true) : false;
      assert.equal((await outbox.run()).state, "TERMINAL");
      const before = (await outbox.runtime.read())!.attempts[0];
      assert.ok(before.terminal);
      assert.equal(before.receipt, null);
      accepted(
        await f.devices.human(outbox.scene.owner, "revoke", {
          deviceId: outbox.scene.responder.deviceId!,
        }),
      );
      refused(
        await f.device(
          outbox.scene.responder,
          "complete",
          outbox.requests.find((request) => request.action === "complete")!.body,
        ),
        401,
      );
      const result = await outbox.run().catch(() => ({ state: "REFUSED" }));
      assert.notEqual(result.state, "UPLOADED");
      const after = (await outbox.runtime.read())!.attempts[0];
      assert.deepEqual(after.terminal, before.terminal);
      assert.deepEqual(after.native, before.native);
      assert.equal(after.receipt, null);
      assert.equal(outbox.adapter.starts, 1);
    } finally {
      await outbox.close();
    }
    const revoked = await f.directScene("target-revoked");
    const admission = await f.ask(revoked);
    const attempt = await f.run(revoked.responder, admission.requestId!);
    accepted(
      await f.devices.human(revoked.owner, "revoke", { deviceId: revoked.responder.deviceId! }),
    );
    refused(
      await f.device(revoked.responder, "complete", {
        ...f.identity(attempt),
        terminal: "COMPLETED",
        publicText: "권한 없는 업로드",
      }),
      401,
    );
    const epoch = await f.directScene("target-epoch");
    const previous = await f.ask(epoch);
    const finished = await f.run(epoch.responder, previous.requestId!);
    await f.complete(epoch.responder, finished);
    accepted(
      await f.devices.request(
        "replace",
        {
          operationId: randomUUID(),
          agentId: epoch.responder.agentId!,
          expectedEpoch: 1,
          repositoryAlias: "새 공개 저장소",
          sessionAlias: "새 공개 세션",
          branch: "main",
          commit: "unknown",
          dirty: "unknown",
          runtime: "codex",
        },
        epoch.responder.credential,
      ),
    );
    refused(
      await f.device(epoch.responder, "complete", {
        ...f.identity(finished),
        bindingEpoch: 1,
        terminal: "COMPLETED",
        publicText: "옛 epoch 업로드",
      }),
      403,
    );
  }),
);

test(
  "should cancel only the caller's direct request or their owned responder request",
  options,
  () =>
    workflowCase("direct-cancel", async (f) => {
      await requireHumanDirectMigration(f);
      const s = await f.directScene();
      await f.stack.join(s.outsider, await f.stack.invite(s.owner, s.scope.roomId), "다른 참가자");
      const admitted = await f.ask(s);
      refused(await cancel(f, s, admitted.requestId!, s.outsider), 403);
      refused(
        await f.human(s.observer, "cancel", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          requestId: admitted.requestId!,
          expectedRoomRevision: 1,
        }),
        403,
      );
      const operationId = randomUUID();
      const first = accepted(await cancel(f, s, admitted.requestId!, s.requester, operationId));
      const count = await f.count(s.scope.roomId);
      assert.deepEqual(
        accepted(await cancel(f, s, admitted.requestId!, s.requester, operationId)),
        first,
      );
      assert.deepEqual(await f.count(s.scope.roomId), count);
      assert.equal((await f.read(s)).runs[0].state, "CANCELLED");
      assert.equal(accepted(await cancel(f, s, admitted.requestId!)).state, "NO_ACTIVE_RUN");
      const live = await f.directScene("active-cancel");
      const run = await f.run(live.responder, (await f.ask(live)).requestId!);
      accepted(await cancel(f, live, run.requestId, live.owner));
      const poll = await f.poll(live.responder);
      assert.ok(poll.control);
      assert.equal(poll.control.attemptId, run.attemptId);
      assert.equal(poll.control.fence, run.fence);
      accepted(
        await f.device(live.responder, "interrupt-ack", {
          ...f.identity(run),
          controlId: poll.control.controlId,
        }),
      );
      assert.equal((await f.read(live)).runs[0].state, "RUNNING");
      refused(
        await f.device(live.responder, "interrupt-ack", {
          ...f.identity(run),
          fence: run.fence + 1,
          controlId: poll.control.controlId,
        }),
        409,
      );
      refused(await f.human(live.requester, "ask", await fields(f, live)), 409);
      await f.complete(live.responder, run, "INTERRUPTED");
      assert.equal((await f.read(live)).runs[0].state, "INTERRUPTED");
      const natural = await f.directScene("natural-cancel");
      const naturalRun = await f.run(natural.responder, (await f.ask(natural)).requestId!);
      const race = await Promise.all([
        cancel(f, natural, naturalRun.requestId),
        f.complete(natural.responder, naturalRun),
      ]);
      accepted(race[0]);
      assert.equal(race[1].terminal, "COMPLETED");
      const paired = await f.scene("paired-denial");
      const pair = await f.start(paired);
      refused(
        await f.human(paired.owner, "cancel", {
          roomId: paired.scope.roomId,
          operationId: randomUUID(),
          requestId: pair.requestId!,
          expectedRoomRevision: 1,
        }),
        403,
      );
      refused(
        await f.human(s.requester, "cancel", {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          requestId: naturalRun.requestId,
          expectedRoomRevision: 1,
        }),
        403,
      );
    }),
);

test("should retain ambiguous direct attempts without automatic retry", options, () =>
  workflowCase("direct-unknown", async (workflow) => {
    for (const crash of ["before-ack", "after-ack"] as const) {
      const f = await HumanDirectRuntimeFixture.open(workflow, crash);
      try {
        const admission = await workflow.ask(f.scene);
        f.adapter.crash = crash;
        assert.equal((await f.run()).state, "UNKNOWN");
        const saved = (await f.runtime.read())!,
          attempt = saved.attempts[0];
        assert.equal(attempt.requestId, admission.requestId);
        assert.equal(attempt.native !== null, crash === "after-ack");
        await workflow.expire("lease", attempt.snapshot!.attemptId);
        assert.equal((await workflow.poll(f.scene.responder)).attempt?.state, "UNKNOWN");
        assert.equal((await f.run()).state, "UNKNOWN");
        refused(
          await workflow.human(f.scene.requester, "ask", await fields(workflow, f.scene)),
          409,
        );
        await assert.rejects(
          f.runner().prepare({
            choice: "default",
            files: ["public-context.txt"],
            handoff: "새 맥락",
            confirmed: true,
            autoQuestionsConfirmed: true,
          }),
          { code: "RUNTIME_BUSY" },
        );
        accepted(
          await workflow.human(f.scene.owner, "pause", {
            roomId: f.scene.scope.roomId,
            operationId: randomUUID(),
            expectedRoomRevision: 1,
          }),
        );
        const page = await workflow.read(f.scene);
        refused(
          await workflow.human(f.scene.requester, "resume", {
            roomId: f.scene.scope.roomId,
            operationId: randomUUID(),
            mode: "room",
            expectedRoomRevision: page.roomRevision,
          }),
          409,
        );
        assert.equal(f.adapter.starts, 1);
        if (crash === "after-ack") {
          const settings = saved.settings!;
          const text = "합성 동일 owned turn 종결";
          f.adapter.terminal = {
            threadId: attempt.native!.threadId,
            turnId: attempt.native!.turnId,
            terminal: "COMPLETED",
            privateText: text,
            publicText: "",
            textProof: "FINAL_ANSWER",
            finalItems: [{ id: "synthetic-final", hash: digest(text) }],
            observation: {
              requested: settings.requested,
              thread: {
                model: settings.requested.model,
                provider: "openai",
                effort: settings.requested.effort,
              },
              turn: {
                requestedModel: settings.requested.model,
                requestedEffort: settings.requested.effort,
                model: settings.requested.model,
                rerouted: false,
                effortVerification: "UNVERIFIED",
              },
            },
          };
          assert.equal((await f.runner().observe()).state, "UPLOADED");
          assert.equal((await f.runtime.read())!.attempts[0].receipt!.adoption, "HISTORICAL");
          assert.equal(f.adapter.starts, 1);
        }
      } finally {
        await f.close();
      }
    }
  }),
);

test("should upgrade legacy workflow storage without fabricating an origin", options, () =>
  workflowCase("direct-upgrade", async (f) => {
    await requireHumanDirectMigration(f);
    const pair = await f.scene("legacy-data");
    const old = await f.start(pair);
    await f.complete(pair.origin, await f.run(pair.origin, old.requestId!));
    const legacy = await f.stack.db.query(
      "select mode,origin_agent_id is not null origin_present,origin_epoch is not null epoch_present from workflow_private.cycles where id=$1 and room_id=$2",
      [old.cycleId, pair.scope.roomId],
    );
    assert.deepEqual(legacy.rows[0], {
      mode: "AI_PAIR",
      origin_present: true,
      epoch_present: true,
    });
    const s = await f.directScene();
    const admission = await f.ask(s);
    await assertOwnedStack(f.stack.config);
    const rejectStorage = async (sql: string, values: unknown[]) => {
      const before = await f.count(s.scope.roomId);
      await f.stack.db.query("begin");
      try {
        await assert.rejects(
          async () => {
            await f.stack.db.query(sql, values);
            await f.stack.db.query("set constraints all immediate");
          },
          (error: unknown) => {
            const failure = error as { code?: string; message?: string };
            return failure.code === "P0001"
              ? failure.message === "CONFLICT"
              : ["23514", "23502", "23503", "23505"].includes(failure.code ?? "");
          },
        );
      } finally {
        await f.stack.db.query("rollback");
      }
      assert.deepEqual(await f.count(s.scope.roomId), before);
    };
    await rejectStorage(
      "update workflow_private.cycles set origin_agent_id=$3 where id=$1 and room_id=$2",
      [admission.cycleId, s.scope.roomId, s.responder.agentId],
    );
    await rejectStorage(
      "update workflow_private.cycles set mode='AI_PAIR' where id=$1 and room_id=$2",
      [admission.cycleId, s.scope.roomId],
    );
    await rejectStorage(
      "update workflow_private.generations set origin_epoch=1 where cycle_id=$1",
      [admission.cycleId],
    );
    await rejectStorage(
      "update workflow_private.questions set requester_user_id=$2 where cycle_id=$1",
      [admission.cycleId, s.owner.id],
    );
    await rejectStorage("update workflow_private.requests set kind='ORIGIN' where cycle_id=$1", [
      admission.cycleId,
    ]);
    await rejectStorage("delete from workflow_private.questions where cycle_id=$1", [
      admission.cycleId,
    ]);
    await rejectStorage(
      "update workflow_private.generations set origin_epoch=null where cycle_id=$1",
      [old.cycleId],
    );
    await rejectStorage(
      "update public.workflow_events set binding_epoch=null where room_id=$1 and kind='QUESTION'",
      [s.scope.roomId],
    );
    await rejectStorage(
      `insert into workflow_private.questions(cycle_id,source,requester_user_id,origin_request_id,
    generation,revision,origin_epoch,peer_epoch,public_text,deadline)
    select cycle_id,source,requester_user_id,origin_request_id,generation,revision,origin_epoch,peer_epoch,public_text,deadline
    from workflow_private.questions where cycle_id=$1`,
      [admission.cycleId],
    );
    await rejectStorage(
      `insert into workflow_private.requests(room_id,cycle_id,generation,device_id,agent_id,owner_id,
    owner_alias,session_alias,binding_epoch,revision,kind,question_id,public_text,reply_text,deadline)
    select room_id,cycle_id,generation,device_id,agent_id,owner_id,owner_alias,session_alias,binding_epoch,revision,
      'CONTINUATION',question_id,public_text,'SYNTHETIC_FORBIDDEN_CONTINUATION',deadline
    from workflow_private.requests where cycle_id=$1`,
      [admission.cycleId],
    );
    const publicClient = s.requester.web.dataClient();
    assert.equal(
      (await publicClient.from("workflow_events").select("*").eq("room_id", s.scope.roomId)).error,
      null,
    );
    assert.equal(
      (await publicClient.schema("workflow_private").from("questions").select("*")).error !== null,
      true,
    );
    assert.equal(
      (await publicClient.from("workflow_events").insert({ room_id: s.scope.roomId })).error !==
        null,
      true,
    );
    const anonymous = createClient(f.stack.config.api, f.stack.config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    assert.equal(
      (
        await anonymous.rpc("workflow_human_ask", {
          p_body: { protocol: 1, ...(await fields(f, s)) },
        })
      ).error !== null,
      true,
    );
    const serialized = JSON.stringify(await f.history(s, s.requester));
    for (const privateValue of [
      s.requester.id,
      s.responder.credential!,
      f.devices.root,
      "requester_user_id",
      "origin_owner_id",
      "nativeSession",
      "credentialHash",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  }),
);

async function directEffects(f: WorkflowFixture, s: HumanDirectScene) {
  assert.equal(f.rooms.get(s.scope.roomId), s.scope.organizationId);
  const result = await f.stack.db.query(
    `select
    (select jsonb_agg(r order by r.id) from workflow_private.requests r where r.room_id=$1) requests,
    (select jsonb_agg(c order by c.id) from workflow_private.cycles c where c.room_id=$1) cycles,
    (select jsonb_agg(q order by q.id) from workflow_private.questions q
      join workflow_private.cycles c on c.id=q.cycle_id where c.room_id=$1) questions,
    (select jsonb_agg(c order by c.id) from workflow_private.controls c
      join workflow_private.requests r on r.id=c.request_id where r.room_id=$1) controls,
    (select jsonb_agg(x order by x.actor_kind,x.actor_id,x.operation_id)
      from workflow_private.receipts x where x.room_id=$1) receipts,
    (select jsonb_agg(e order by e.sequence) from public.workflow_events e where e.room_id=$1) events`,
    [s.scope.roomId],
  );
  return result.rows[0];
}

test("should reject a stale direct actor precondition after a cookie change", options, () =>
  workflowCase("direct-actor", async (f) => {
    await requireHumanDirectMigration(f);
    const s = await f.directScene();
    await f.stack.join(s.outsider, await f.stack.invite(s.owner, s.scope.roomId), "다른 참가자");
    const body = await fields(f, s);
    const noEffect = async (run: () => Promise<void>) => {
      const before = await directEffects(f, s);
      await run();
      assert.deepEqual(await directEffects(f, s), before);
    };
    // B has valid participant permissions and the same ready target; only the actor is stale.
    await noEffect(async () => refused(await f.human(s.outsider, "ask", body), 403));
    const admission = accepted(await f.human(s.requester, "ask", body));
    assert.equal(typeof admission.requestId, "string");
    const requestId = admission.requestId as string;
    await f.complete(s.responder, await f.run(s.responder, requestId));
    assert.equal((await f.read(s, s.requester)).roomRevision, body.expectedRoomRevision);
    assert.equal(await f.epoch(s.responder), body.targetEpoch);
    // The original operation cannot become B's fresh run after A's terminal.
    await noEffect(async () => refused(await f.human(s.outsider, "ask", body), 403));
    await noEffect(async () => {
      const { expectedUserId: omitted, ...missing } = body;
      void omitted;
      for (const invalid of [
        missing,
        { ...body, expectedUserId: null },
        { ...body, expectedUserId: [s.requester.id] },
        { ...body, expectedUserId: "invalid" },
        { ...body, actorId: s.requester.id },
      ]) {
        const rpc = await s.requester.web
          .dataClient()
          .rpc("workflow_human_ask", { p_body: { protocol: 1, ...invalid } });
        assert.equal(rpc.error?.message, "INVALID_BODY");
      }
      const response = await fetch(`${f.stack.config.app}/api/investigations/ask`, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: { Origin: f.stack.config.app, "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: 1, ...body }),
      });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { ok: false, error: { code: "UNAUTHENTICATED" } });
      // Exercise the SQL precondition too, without a JWT subject or browser cookie.
      await f.stack.db.query("begin");
      try {
        await f.stack.db.query("set local role authenticated");
        await f.stack.db.query(
          "select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)",
        );
        await assert.rejects(
          f.stack.db.query("select public.workflow_human_ask($1::jsonb)", [
            JSON.stringify({ protocol: 1, ...body }),
          ]),
          (error: unknown) => {
            const failure = error as { code?: string; message?: string };
            return failure.code === "P0001" && failure.message === "UNAUTHENTICATED";
          },
        );
      } finally {
        await f.stack.db.query("rollback");
      }
    });
    await f.ready(s.responder);
    const queued = await f.ask(s);
    assert.equal(typeof queued.requestId, "string");
    const cancelBody = {
      roomId: s.scope.roomId,
      operationId: randomUUID(),
      requestId: queued.requestId!,
      expectedRoomRevision: (await f.read(s, s.requester)).roomRevision,
      expectedUserId: s.requester.id,
    };
    await noEffect(async () => {
      refused(await f.human(s.owner, "cancel", cancelBody), 403);
      refused(await f.human(s.outsider, "cancel", cancelBody), 403);
      // A matching freshness field never grants B the requester's cancel permission.
      refused(
        await f.human(s.outsider, "cancel", { ...cancelBody, expectedUserId: s.outsider.id }),
        403,
      );
      const { expectedUserId: omitted, ...missing } = cancelBody;
      void omitted;
      for (const invalid of [
        missing,
        { ...cancelBody, expectedUserId: null },
        { ...cancelBody, expectedUserId: [s.owner.id] },
        { ...cancelBody, actorId: s.owner.id },
      ]) {
        const rpc = await s.owner.web
          .dataClient()
          .rpc("workflow_human_cancel", { p_body: { protocol: 1, ...invalid } });
        assert.equal(rpc.error?.message, "INVALID_BODY");
      }
    });
    // The owner can cancel only with their own current actor precondition.
    assert.equal(
      accepted(await f.human(s.owner, "cancel", { ...cancelBody, expectedUserId: s.owner.id }))
        .state,
      "REQUESTED",
    );
  }),
);

test("should preserve existing direct receipts when adding the actor precondition", options, () =>
  workflowCase("direct-actor-schema", async (f) => {
    await requireHumanDirectMigration(f);
    const s = await f.directScene();
    const body = await fields(f, s);
    const first = accepted(
      await f.human(s.requester, "ask", { ...body, publicText: "  한글 직접 질문  " }),
    );
    const before = await directEffects(f, s);
    assert.deepEqual(accepted(await f.human(s.requester, "ask", body)), first);
    assert.deepEqual(await directEffects(f, s), before);
    const canonical: Body = { protocol: 1, ...body };
    const hash = await f.stack.db.query(
      `select payload_hash=encode(extensions.digest(
    ($4::jsonb-'expectedUserId')::text,'sha256'),'hex') unchanged
    from workflow_private.receipts where room_id=$1 and actor_kind='human' and actor_id=$2 and operation_id=$3`,
      [s.scope.roomId, s.requester.id, body.operationId, JSON.stringify(canonical)],
    );
    assert.deepEqual(hash.rows, [{ unchanged: true }]);
    await assertActorPreconditionSchema(f, s);
    const { expectedUserId: omitted, ...oldBody } = canonical;
    void omitted;
    const missing = await s.requester.web
      .dataClient()
      .rpc("workflow_human_ask", { p_body: oldBody });
    assert.equal(missing.error?.message, "INVALID_BODY");

    // Find a bounded original-body size that exceeds 16KiB only before removing expectedUserId.
    const sizeBody = { ...canonical, operationId: randomUUID(), publicText: "" };
    const size = await f.stack.db.query(
      `with candidates as (
    select n,jsonb_set($1::jsonb,'{publicText}',to_jsonb(repeat(chr(1),n))) body
      from generate_series(2600,2750) n)
    select body from candidates where octet_length(body::text)>16384
      and octet_length((body-'expectedUserId')::text)<=16384 order by n limit 1`,
      [JSON.stringify(sizeBody)],
    );
    assert.equal(size.rowCount, 1);
    const denied = await s.requester.web
      .dataClient()
      .rpc("workflow_human_ask", { p_body: size.rows[0].body });
    assert.equal(denied.error?.message, "BODY_TOO_LARGE");
    assert.deepEqual(await directEffects(f, s), before);
  }),
);

test(
  "should reuse speech receipts across response loss and legacy or actor-bound callers",
  options,
  () =>
    workflowCase("speech-delivery-receipts", async (f) => {
      await requireHumanDirectMigration(f);
      const s = await f.directScene();
      for (const actorFirst of [false, true]) {
        const legacy = {
          roomId: s.scope.roomId,
          operationId: randomUUID(),
          publicText: "합성 전송 복구 발언",
        };
        const bound = { ...legacy, expectedUserId: s.requester.id };
        const first = accepted(await f.human(s.requester, "speak", actorFirst ? bound : legacy));
        const before = await directEffects(f, s);
        assert.deepEqual(
          accepted(await f.human(s.requester, "speak", actorFirst ? legacy : bound)),
          first,
        );
        assert.deepEqual(accepted(await f.human(s.requester, "speak", bound)), first);
        assert.deepEqual(await directEffects(f, s), before);
        const rows = await f.stack.db.query(
          `select
          (select count(*)::int from public.workflow_events where room_id=$1 and event_id=$4) events,
          count(*)::int receipts,
          bool_and(payload_hash=encode(extensions.digest(($5::jsonb)::text,'sha256'),'hex')) unchanged
         from workflow_private.receipts
         where room_id=$1 and actor_kind='human' and actor_id=$2 and operation_id=$3 and action='speak'`,
          [
            s.scope.roomId,
            s.requester.id,
            legacy.operationId,
            first.eventId,
            JSON.stringify({ protocol: 1, ...legacy }),
          ],
        );
        assert.deepEqual(rows.rows, [{ events: 1, receipts: 1, unchanged: true }]);
        refused(await f.human(s.requester, "speak", { ...bound, publicText: "다른 본문" }), 409);
      }
    }),
);

test(
  "should reject mismatched speech actors and malformed optional actor shapes without side effects",
  options,
  () =>
    workflowCase("speech-delivery-actor", async (f) => {
      await requireHumanDirectMigration(f);
      const s = await f.directScene();
      await f.stack.join(s.outsider, await f.stack.invite(s.owner, s.scope.roomId), "다른 참가자");
      const body = {
        protocol: 1,
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        publicText: "계정 격리 발언",
        expectedUserId: s.requester.id,
      };
      const before = await directEffects(f, s);
      refused(await f.human(s.outsider, "speak", body), 403);
      const stale = await s.outsider.web.dataClient().rpc("workflow_human_speak", { p_body: body });
      assert.equal(stale.error?.message, "FORBIDDEN");
      for (const invalid of [
        ...[null, [], 1, "invalid"].map((expectedUserId) => ({ ...body, expectedUserId })),
        { ...body, actorId: s.requester.id },
      ]) {
        const result = await s.requester.web
          .dataClient()
          .rpc("workflow_human_speak", { p_body: invalid });
        assert.equal(result.error?.message, "INVALID_BODY");
      }
      refused(await f.human(s.observer, "speak", { ...body, expectedUserId: s.observer.id }), 403);
      assert.deepEqual(await directEffects(f, s), before);
      await f.stack.db.query("begin");
      try {
        await f.stack.db.query("set local role authenticated");
        await f.stack.db.query(
          "select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true)",
        );
        await assert.rejects(
          f.stack.db.query("select public.workflow_human_speak($1::jsonb)", [JSON.stringify(body)]),
          (failure: unknown) => (failure as { message?: string }).message === "UNAUTHENTICATED",
        );
      } finally {
        await f.stack.db.query("rollback");
      }
    }),
);
