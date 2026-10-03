import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ownedRuntimeCase, runtimeGate } from "../helpers/owned-runtime-fixture.js";
import type {
  ResumeResult,
  AttemptSnapshot,
} from "../../packages/local-connector/src/workflow-contracts.ts";
import { RuntimeError, digest } from "../../packages/local-connector/src/runtime-contracts.ts";
const options = { timeout: 300000 };

test(
  "should recover only proof-closed unstarted claims with immutable old receipts and a higher server fence",
  options,
  async () => {
    for (const crash of ["before-transmission", "response-loss", "claimed"])
      await ownedRuntimeCase(`unstarted-${crash}`, async (f) => {
        const admitted = await f.start();
        let failed = false;
        if (crash === "response-loss")
          f.loseResponse = (action) =>
            action === "claim" && !failed ? ((failed = true), true) : false;
        assert.equal(
          (
            await f.run(f.origin, {
              beforeMutation: async (kind) => {
                if (failed) return;
                const last = (await f.origin.runtime.read())!.attempts.at(-1);
                if (
                  (crash === "claimed" && kind === "server-intent") ||
                  (crash === "before-transmission" &&
                    kind === "operation-intent" &&
                    last?.state === "CLAIM_PENDING")
                ) {
                  failed = true;
                  throw new RuntimeError("UNKNOWN");
                }
              },
            })
          ).state,
          "UNKNOWN",
        );
        const before = (await f.origin.runtime.read())!,
          old = before.attempts.at(-1)!;
        assert.equal(old.requestId, admitted.requestId);
        assert.ok(old.claimOperationId);
        assert.equal(f.origin.adapter.starts, 0);
        assert.equal(old.native, null);
        let previousFence = 0;
        if (crash !== "before-transmission") {
          const leased =
            old.snapshot ?? ((await f.workflow.poll(f.scene.origin)).attempt as AttemptSnapshot);
          assert.ok(leased);
          assert.equal(leased.requestId, admitted.requestId);
          assert.equal(leased.state, "LEASED");
          assert.equal(leased.startIntentAt, null);
          previousFence = leased.fence;
          // Existing expiry helper verifies recorded fixture identity/owner/room, then uses bound SQL parameters.
          await f.workflow.expire("lease", leased.attemptId);
          const swept = await f.workflow.poll(f.scene.origin);
          assert.equal(swept.attempt, null);
          assert.equal(swept.queuedRequest?.requestId, admitted.requestId);
        }
        f.loseResponse = undefined;
        assert.equal((await f.run(f.origin)).state, "UPLOADED");
        assert.equal(f.origin.adapter.starts, 1);
        const saved = (await f.origin.runtime.read())!,
          closed = saved.attempts[0],
          current = saved.attempts[1];
        assert.equal(saved.attempts.length, 2);
        assert.equal(closed.state, "NOT_STARTED");
        assert.equal(
          closed.unstartedClosure?.kind,
          crash === "before-transmission" ? "LOCAL_NOT_TRANSMITTED" : "SERVER_ABANDONED",
        );
        assert.deepEqual(closed.snapshot, old.snapshot);
        assert.notEqual(current.claimOperationId, closed.claimOperationId);
        assert.equal(current.requestId, admitted.requestId);
        assert.ok(current.snapshot!.fence > previousFence);
        for (const operation of before.operations.filter(
          (o) => o.action !== "ready" && o.state === "CONFIRMED",
        ))
          assert.deepEqual(
            saved.operations.find((o) => o.operationId === operation.operationId),
            operation,
          );
        const originalClaims = f.requests.filter(
          (r) => r.action === "claim" && r.body.operationId === closed.claimOperationId,
        );
        assert.equal(originalClaims.length, crash === "before-transmission" ? 0 : 2);
        if (originalClaims.length) assert.deepEqual(originalClaims[0].body, originalClaims[1].body);
        assert.equal(f.requests.filter((r) => r.action === "start-intent").length, 1);
      });
  },
);

test(
  "should recover an owned pre-provider start-intent loss and residual lease only after exact abandoned claim proof",
  options,
  () =>
    ownedRuntimeCase("unstarted-lease", async (f) => {
      const admitted = await f.start(),
        startRelease = runtimeGate();
      let leaseLost = false;
      f.beforeFetch = async (action) => {
        if (action === "start-intent") {
          await startRelease.promise;
          throw new RuntimeError("UNKNOWN");
        }
      };
      f.loseResponse = (action) => {
        if (action !== "lease") return false;
        leaseLost = true;
        startRelease.release();
        return true;
      };
      try {
        assert.equal(
          (await f.run(f.origin, { leaseIntervalMs: 5, pollIntervalMs: 5 })).state,
          "UNKNOWN",
        );
        assert.equal(leaseLost, true);
        assert.equal(f.origin.adapter.starts, 0);
        const before = (await f.origin.runtime.read())!,
          old = before.attempts[0],
          lease = before.operations.find((op) => op.action === "lease")!;
        assert.equal(old.requestId, admitted.requestId);
        assert.equal(old.snapshot!.startIntentAt, null);
        assert.equal(lease.state, "TRANSMITTED");
        const leased = (await f.workflow.poll(f.scene.origin)).attempt!;
        assert.equal(leased.attemptId, old.snapshot!.attemptId);
        assert.equal(leased.fence, old.snapshot!.fence);
        assert.equal(leased.state, "LEASED");
        assert.equal(leased.startIntentAt, null);
        await f.workflow.expire("lease", leased.attemptId);
        const swept = await f.workflow.poll(f.scene.origin);
        assert.equal(swept.attempt, null);
        assert.equal(swept.queuedRequest?.requestId, admitted.requestId);
        const calls = f.requests.length;
        f.beforeFetch = undefined;
        f.loseResponse = undefined;
        assert.equal((await f.run(f.origin)).state, "UPLOADED");
        assert.equal(f.origin.adapter.starts, 1);
        const after = (await f.origin.runtime.read())!;
        assert.equal(after.attempts[0].state, "NOT_STARTED");
        assert.equal(after.attempts[0].unstartedClosure?.kind, "SERVER_ABANDONED");
        assert.deepEqual(after.attempts[0].snapshot, old.snapshot);
        assert.ok(after.attempts[1].snapshot!.fence > leased.fence);
        assert.deepEqual(
          after.operations.find((op) => op.operationId === lease.operationId),
          { ...lease, state: "CLOSED" },
        );
        for (const op of before.operations.filter(
          (op) => op.state === "CONFIRMED" && op.action !== "ready",
        ))
          assert.deepEqual(
            after.operations.find((current) => current.operationId === op.operationId),
            op,
          );
        assert.equal(
          f.requests
            .slice(calls)
            .some(
              (request) =>
                request.body.operationId === lease.operationId ||
                (request.action === "start-intent" && request.body.attemptId === leased.attemptId),
            ),
          false,
        );
        const original = before.operations.find((op) => op.operationId === old.claimOperationId)!;
        assert.deepEqual(
          f.requests.slice(calls).find((request) => request.action === "claim")!.body,
          original.body,
        );
      } finally {
        startRelease.release();
      }
    }),
);

test("should complete an origin peer and continuation through the product runner", options, () =>
  ownedRuntimeCase("roundtrip", async (f) => {
    const admitted = await f.start();
    f.origin.adapter.question = true;
    assert.equal((await f.run(f.origin)).state, "UPLOADED");
    assert.equal((await f.run(f.peer)).state, "UPLOADED");
    assert.equal((await f.run(f.origin)).state, "UPLOADED");
    const history = await f.workflow.history(f.scene),
      runs = history.runs.filter((run) => run.cycleId === admitted.cycleId);
    assert.deepEqual(runs.map((run) => run.requestKind).sort(), ["CONTINUATION", "ORIGIN", "PEER"]);
    assert.ok(runs.every((run) => run.state === "COMPLETED"));
    const originRun = runs.find((run) => run.requestKind === "ORIGIN")!,
      peerRun = runs.find((run) => run.requestKind === "PEER")!,
      continuation = runs.find((run) => run.requestKind === "CONTINUATION")!;
    const questions = history.events.filter(
        (event) => event.cycleId === admitted.cycleId && event.kind === "QUESTION",
      ),
      answers = history.events.filter(
        (event) => event.cycleId === admitted.cycleId && event.kind === "ANSWER",
      );
    assert.equal(questions.length, 1);
    assert.equal(questions[0].requestKind, "ORIGIN");
    assert.equal(questions[0].requestId, originRun.requestId);
    assert.ok(questions[0].questionId);
    assert.equal(peerRun.questionId, questions[0].questionId);
    assert.equal(continuation.questionId, questions[0].questionId);
    // SQL006 records the pending peer answer and then its adoption into this continuation.
    assert.deepEqual(
      answers.map((event) => event.adoption),
      ["PENDING", "ACCEPTED"],
    );
    assert.ok(
      answers.every(
        (event) =>
          event.requestKind === "PEER" &&
          event.requestId === peerRun.requestId &&
          event.questionId === questions[0].questionId &&
          event.replyTo === questions[0].questionId,
      ),
    );
    assert.equal(answers[0].publicText, answers[1].publicText);
    assert.ok(answers[0].sequence < answers[1].sequence);
    const completed = f.requests.find(
      (request) => request.action === "complete" && request.body.requestId === peerRun.requestId,
    )!;
    const peerReceipt = (await f.peer.runtime.read())!.attempts.find(
      (attempt) => attempt.requestId === peerRun.requestId,
    )!.receipt!;
    assert.equal(peerReceipt.continuationRequestId, continuation.requestId);
    const replay = await f.workflow.device(f.scene.responder, "complete", completed.body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.data.data, peerReceipt);
    const replayed = await f.workflow.history(f.scene);
    assert.deepEqual(
      replayed.events.filter((event) => event.cycleId === admitted.cycleId),
      history.events.filter((event) => event.cycleId === admitted.cycleId),
    );
    assert.deepEqual(
      replayed.runs.filter((run) => run.cycleId === admitted.cycleId),
      runs,
    );
    const origin = (await f.origin.runtime.read())!,
      peer = (await f.peer.runtime.read())!;
    assert.equal(origin.context?.level, "L2");
    assert.equal(origin.settings?.requested.effort, "low");
    assert.equal(peer.settings?.requested.effort, "high");
    assert.equal(origin.attempts.length, 2);
    assert.ok(
      origin.attempts.every(
        (a) =>
          a.snapshot?.payload.cycleId === admitted.cycleId &&
          a.native?.threadId === origin.context?.threadId,
      ),
    );
    assert.equal(f.origin.adapter.starts + f.peer.adapter.starts, 3);
  }),
);
test(
  "should recover runner crashes and lost responses against the actual coordinator",
  options,
  () =>
    ownedRuntimeCase("crashes", async (f) => {
      await f.start();
      let lost = true;
      f.loseResponse = (action) => (action === "complete" && lost ? ((lost = false), true) : false);
      assert.equal((await f.run(f.origin)).state, "TERMINAL");
      const first = f.requests.find((r) => r.action === "complete")!;
      assert.equal((await f.run(f.origin)).state, "UPLOADED");
      assert.equal(f.origin.adapter.starts, 1);
      const complete = f.requests.filter((r) => r.action === "complete");
      assert.deepEqual(complete[0].body, complete[1].body);
      assert.equal(first.body.operationId, complete[1].body.operationId);
      await f.start();
      f.origin.adapter.crash = "after-ack";
      assert.equal((await f.run(f.origin)).state, "UNKNOWN");
      const saved = (await f.origin.runtime.read())!,
        last = saved.attempts.at(-1)!;
      await f.workflow.expire("lease", last.snapshot!.attemptId);
      await f.workflow.poll(f.scene.origin);
      assert.equal((await f.run(f.origin)).state, "UNKNOWN");
      assert.equal(f.origin.adapter.starts, 2);
      const observed = {
        threadId: last.native!.threadId,
        turnId: last.native!.turnId,
        terminal: "COMPLETED" as const,
        privateText: "합성 관찰 종결",
        publicText: "",
        finalItems: [{ id: "synthetic-final", hash: digest("합성 관찰 종결") }],
        textProof: "FINAL_ANSWER" as const,
        observation: saved.attempts[0].terminal!.observation,
      };
      f.origin.adapter.terminal = observed;
      assert.equal((await f.runner(f.origin).observe()).state, "UPLOADED");
      assert.equal(f.origin.adapter.starts, 2);
    }),
);
test(
  "should reject stale runner authority after rotation pause replacement or revocation",
  options,
  () =>
    ownedRuntimeCase("authority", async (f) => {
      await f.start();
      const old = (await f.origin.state.read())!.credential!,
        entered = runtimeGate(),
        release = runtimeGate();
      let delayed = false;
      f.beforeFetch = async (action, _body, credential) => {
        if (action === "complete" && credential === old && !delayed) {
          delayed = true;
          entered.release();
          await release.promise;
        }
      };
      const run = f.run(f.origin);
      await entered.promise;
      await f.origin.state.transaction(() => f.origin.connector.rotate());
      await f.workflow.devices.refresh(f.scene.origin);
      release.release();
      assert.equal((await run).state, "UPLOADED");
      const retries = f.requests.filter((r) => r.action === "complete");
      assert.deepEqual(retries[0].body, retries[1].body);
      const pausedCycle = await f.start();
      f.origin.adapter.hold = runtimeGate();
      f.origin.adapter.entered = runtimeGate();
      const pausedRun = f.run(f.origin);
      await f.origin.adapter.entered.promise;
      const history = await f.workflow.read(f.scene);
      const pause = await f.workflow.human(f.scene.owner, "pause", {
        roomId: f.scene.scope.roomId,
        expectedRoomRevision: history.roomRevision,
        operationId: randomUUID(),
      });
      assert.equal(pause.status, 200);
      const stopped = await pausedRun;
      assert.equal(stopped.terminal, "INTERRUPTED");
      assert.ok(f.requests.some((r) => r.action === "interrupt-ack"));
      // A durable terminal is not yet a central completion receipt. Recover its exact outbox first.
      const startsBeforeRecovery = f.origin.adapter.starts;
      if (stopped.state === "TERMINAL") assert.equal((await f.run(f.origin)).state, "UPLOADED");
      else assert.equal(stopped.state, "UPLOADED");
      assert.equal(f.origin.adapter.starts, startsBeforeRecovery);
      const paused = await f.workflow.read(f.scene),
        pausedPoll = await f.workflow.poll(f.scene.origin);
      assert.equal(paused.roomMode, "PAUSED");
      assert.equal(paused.cycle?.cycleId, pausedCycle.cycleId);
      assert.equal(paused.cycle?.state, "HUMAN_INPUT_REQUIRED");
      assert.equal(pausedPoll.queuedRequest, null);
      assert.equal(pausedPoll.attempt, null);
      assert.equal(pausedPoll.control, null);
      // Reopening the room alone preserves the paused cycle; explicitly finish a same-cycle RESUME.
      const reopened = await f.workflow.human(f.scene.owner, "resume", {
        roomId: f.scene.scope.roomId,
        mode: "room",
        expectedRoomRevision: paused.roomRevision,
        operationId: randomUUID(),
      });
      assert.equal(reopened.status, 200);
      await f.run(f.origin);
      await f.run(f.peer);
      f.origin.adapter.hold = null;
      const resumeHistory = await f.workflow.read(f.scene);
      const resumed = await f.workflow.human(f.scene.owner, "resume", {
        roomId: f.scene.scope.roomId,
        mode: "cycle",
        cycleId: pausedCycle.cycleId,
        originAgentId: f.scene.origin.agentId!,
        peerAgentId: f.scene.responder.agentId!,
        originEpoch: await f.workflow.epoch(f.scene.origin),
        peerEpoch: await f.workflow.epoch(f.scene.responder),
        expectedRoomRevision: resumeHistory.roomRevision,
        operationId: randomUUID(),
        publicText: "합성 동일 cycle 명시적 종결 조사",
        confirmed: true,
      });
      assert.equal(resumed.status, 200);
      const resumedCycle = resumed.data.data as unknown as ResumeResult;
      assert.equal(resumedCycle.cycleId, pausedCycle.cycleId);
      assert.equal(resumedCycle.accepted, true);
      const queuedResume = await f.workflow.poll(f.scene.origin);
      assert.equal(queuedResume.queuedRequest?.requestKind, "RESUME");
      assert.equal(queuedResume.queuedRequest?.cycleId, pausedCycle.cycleId);
      const preparations = f.origin.adapter.preparations;
      await assert.rejects(
        f.runner(f.origin).prepare({
          choice: "default",
          files: ["public-context.txt"],
          handoff: "합성 아직 대기 중인 맥락",
          confirmed: true,
          autoQuestionsConfirmed: true,
        }),
        { code: "RUNTIME_BUSY" },
      );
      assert.equal(f.origin.adapter.preparations, preparations);
      assert.equal((await f.run(f.origin)).state, "UPLOADED");
      const finishedCycle = await f.workflow.read(f.scene);
      assert.equal(finishedCycle.cycle?.cycleId, pausedCycle.cycleId);
      assert.equal(finishedCycle.cycle?.state, "COMPLETED");
      assert.equal((await f.workflow.poll(f.scene.origin)).queuedRequest, null);
      assert.equal(
        (await f.workflow.devices.request("heartbeat", {}, f.scene.responder.credential)).status,
        200,
      );
      await f.runner(f.origin).prepare({
        choice: "default",
        files: ["public-context.txt"],
        handoff: "합성 새 공개 맥락",
        confirmed: true,
        autoQuestionsConfirmed: true,
      });
      assert.equal((await f.origin.runtime.read())!.scope.bindingEpoch, 3);
      const revoke = await f.workflow.devices.human(f.scene.owner, "revoke", {
        deviceId: f.scene.origin.deviceId,
      });
      assert.equal(revoke.status, 200);
      await assert.rejects(f.run(f.origin));
      assert.equal(
        (await f.workflow.devices.request("heartbeat", {}, f.scene.responder.credential)).status,
        200,
      );
    }),
);
test("should preserve safe claims under concurrent runner and session admission", options, () =>
  ownedRuntimeCase("admission", async (f) => {
    await f.start();
    f.origin.adapter.hold = runtimeGate();
    f.origin.adapter.entered = runtimeGate();
    const first = f.run(f.origin);
    await f.origin.adapter.entered.promise;
    await assert.rejects(f.run(f.origin), { code: "RUNTIME_BUSY" });
    const context = (await f.origin.runtime.read())!.context!;
    await assert.rejects(
      f.peer.runtime.sessionLocked(context.threadId, async () => {}),
      { code: "RUNTIME_BUSY" },
    );
    f.origin.adapter.hold.release();
    assert.equal((await first).state, "UPLOADED");
    assert.equal(f.origin.adapter.starts, 1);
    const counts = await f.workflow.count(f.scene.scope.roomId);
    assert.equal(counts.attempts, 1);
  }),
);
