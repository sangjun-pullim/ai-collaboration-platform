import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ClaudeAdapter } from "../../packages/local-connector/src/claude/adapter.ts";
import { claudeProductCase, productAnswer } from "../helpers/claude-product-fixture.js";

const options = { timeout: 300000 };
// These are real owned Auth/DB/HTTP cases with fake frames, never official CLI acceptance.
test("should keep default product Claude blocked without reviewed native policy", async () => {
  let launches = 0;
  const adapter = new ClaudeAdapter({
    transport: () => {
      launches++;
      throw new Error("Forbidden native launch");
    },
  });
  await assert.rejects(
    adapter.capabilities("/fixture-not-opened", () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
  assert.equal(launches, 0);
  await adapter.close();
});

test(
  "should apply a first Claude generation and resume exact history with one answer per input",
  options,
  () =>
    claudeProductCase("answer-resume", async (f) => {
      assert.equal((await f.state.read())!.mappings.length, 0);
      await f.configure();
      const store = await f.runtime(),
        prepared = (await store.read())!;
      assert.equal(prepared.version, 2);
      assert.equal(prepared.context!.materialization!.state, "RESERVED");
      assert.equal(prepared.settings!.requested.effort, null);
      assert.equal(f.inputs.length, 0);
      assert.equal((await f.store.read())!.journal!.phase, "APPLIED");
      const nativeId = prepared.context!.threadId;
      f.loseComplete = true;
      await f.workflow.ask(f.scene);
      await f.run();
      const recovered = await f.run();
      assert.equal(recovered.state, "UPLOADED");
      assert.equal(f.inputs.length, 1);
      const attempts = (await store.read())!.attempts;
      const first = attempts.at(-1)!;
      assert.equal(first.state, "UPLOADED");
      assert.equal(first.native!.threadId, nativeId);
      assert.equal(first.nativeIntent!.inputId, first.native!.turnId);
      assert.equal(first.terminal!.terminal, "COMPLETED");
      assert.equal(first.toolCalls.length, 1);
      assert.ok(first.toolCalls[0].result!.success);
      const complete = f.requests.filter((r) => r.action === "complete");
      assert.ok(complete.length >= 2);
      assert.deepEqual(complete[0].body, complete[1].body);
      await f.workflow.ask(f.scene, randomUUID(), "같은 제품 기록에 다음 질문");
      assert.equal((await f.run()).state, "UPLOADED");
      assert.equal(f.inputs.length, 2);
      assert.equal(f.inputs[1].sessionId, nativeId);
      assert.notEqual(f.inputs[1].inputId, f.inputs[0].inputId);
      assert.ok(f.launches.some((launch) => launch.sessionId === nativeId && launch.resume));
      const current = (await store.read())!;
      assert.equal(current.context!.materialization!.state, "MATERIALIZED");
      assert.equal(current.context!.ownedTurns.length, 2);
      const history = await f.workflow.history(f.scene, f.scene.requester);
      const answers = history.events.filter(
        (event) => event.senderKind === "AGENT" && event.publicText === productAnswer,
      );
      assert.equal(answers.length, 2);
      assert.ok(answers.every((event) => event.agentId === f.scene.responder.agentId));
      f.assertRequesterWithoutAI();
      assert.ok(f.transports.every((transport) => transport.closed));
    }),
);

test(
  "should retain an exact reserved UNKNOWN input after ACK loss without retransmission",
  options,
  () =>
    claudeProductCase("ack-loss", async (f) => {
      await f.configure();
      f.ackLoss = true;
      await f.workflow.ask(f.scene);
      assert.equal((await f.run()).state, "UNKNOWN");
      const store = await f.runtime(),
        unknown = (await store.read())!.attempts.at(-1)!;
      assert.equal(unknown.native, null);
      assert.ok(unknown.nativeIntent);
      assert.equal((await store.read())!.context!.materialization!.state, "RESERVED");
      const before = {
        inputs: f.inputs.length,
        launches: f.launches.length,
        intent: unknown.nativeIntent,
      };
      await f.workflow.expire("lease", unknown.snapshot!.attemptId);
      await f.workflow.poll(f.scene.responder);
      const observed = await f.runner(store).observe();
      assert.equal(observed.state, "UNKNOWN");
      assert.equal(f.inputs.length, before.inputs);
      assert.equal(f.launches.length, before.launches);
      assert.deepEqual((await store.read())!.attempts.at(-1)!.nativeIntent, before.intent);
      const history = await f.workflow.history(f.scene, f.scene.requester);
      assert.equal(
        history.events.filter(
          (event) => event.senderKind === "AGENT" && event.publicText === productAnswer,
        ).length,
        0,
      );
      f.assertRequesterWithoutAI();
      assert.ok(f.transports.every((transport) => transport.closed));
    }),
);

test("should interrupt a held product file tool and suppress its late reply", options, () =>
  claudeProductCase("held-tool", async (f) => {
    await f.configure();
    f.holdTool = true;
    const admission = await f.workflow.ask(f.scene);
    const running = f.run();
    try {
      await f.toolEntered.promise;
      const journal = (await (await f.runtime()).read())!.attempts.at(-1)!;
      assert.equal(journal.toolCalls.length, 1);
      assert.equal(journal.toolCalls[0].result!.success, true);
      const history = await f.workflow.read(f.scene, f.scene.requester);
      const cancellation = await f.workflow.human(f.scene.requester, "cancel", {
        roomId: f.scene.scope.roomId,
        operationId: randomUUID(),
        requestId: admission.requestId!,
        expectedRoomRevision: history.roomRevision,
      });
      assert.equal(cancellation.status, 200);
      const deadline = Date.now() + 10000;
      while (f.interrupts === 0 && Date.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      assert.equal(f.interrupts, 1);
      assert.equal(f.transports.at(-1)!.replies.length, 0);
    } finally {
      f.toolRelease.release();
    }
    const stopped = await running;
    assert.equal(stopped.terminal, "INTERRUPTED");
    if (stopped.state === "TERMINAL") await f.run();
    assert.equal(f.inputs.length, 1);
    assert.equal(f.transports.at(-1)!.replies.length, 0);
    assert.ok(f.requests.some((request) => request.action === "interrupt-ack"));
    assert.ok(f.transports.every((transport) => transport.closed));
    const record = (await (await f.runtime()).read())!;
    assert.equal(record.context!.ownedTurns.at(-1)!.toolCancellations!.length, 1);
    await f.adapters.at(-1)!.validate(record.context!, record.settings!, () => {});
    assert.equal(f.inputs.length, 1);
    f.assertRequesterWithoutAI();
  }),
);
