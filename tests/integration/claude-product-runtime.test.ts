import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { timelineEvents } from "../../src/features/investigation-coordinator/chat-presentation.ts";
import { ClaudeAdapter } from "../../packages/local-connector/src/claude/adapter.ts";
import { claudeProductCase, productAnswer } from "../helpers/claude-product-fixture.js";

import { SettingsManager } from "../../packages/local-connector/src/settings/manager.ts";
import { SettingsClient } from "../../packages/local-connector/src/settings/client.ts";
import {
  RuntimeError,
  type RuntimeAdapter,
} from "../../packages/local-connector/src/runtime-contracts.ts";

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
      const audit = structuredClone(history.events);
      const answers = timelineEvents(history.events).filter(
        (event) =>
          event.kind === "ANSWER" &&
          event.senderKind === "AGENT" &&
          event.publicText === productAnswer,
      );
      assert.equal(answers.length, 2);
      assert.ok(answers.every((event) => event.agentId === f.scene.responder.agentId));
      const requestIds = [first.snapshot!.requestId, current.attempts.at(-1)!.snapshot!.requestId];
      assert.equal(new Set(requestIds).size, 2);
      for (const requestId of requestIds)
        assert.equal(answers.filter((event) => event.requestId === requestId).length, 1);
      assert.deepEqual(history.events, audit);
      assert.equal(new Set(audit.map((event) => event.eventId)).size, audit.length);
      assert.ok(
        audit.every((event, index) => index === 0 || event.sequence > audit[index - 1].sequence),
      );
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
    const beforeReconnect = {
      inputs: f.inputs.length,
      launches: f.launches.length,
      transports: f.transports.length,
    };
    const reconnected = f.adapter();
    try {
      await reconnected.validate(record.context!, record.settings!, () => {});
      assert.deepEqual(
        { inputs: f.inputs.length, launches: f.launches.length, transports: f.transports.length },
        beforeReconnect,
      );
    } finally {
      await reconnected.close();
    }
    assert.equal(f.inputs.length, 1);
    f.assertRequesterWithoutAI();
  }),
);

test(
  "should close a proven pre-prepare failure through real HTTP and release a new setup",
  options,
  () =>
    claudeProductCase("setup-cleanup", async (f) => {
      const base = await f.requestFolder("codex");
      await f.driveFolder();
      const response = f.settings.accepted(
        await f.human(f.scene.owner, "list", { deviceId: base.deviceId }),
      );
      const catalog = response.catalog!,
        local = response.operation!.receipt!;
      const selection = {
        ...base,
        ...catalog.defaultSettings!,
        snapshotHash: catalog.snapshotHash,
      };
      f.settings.accepted(await f.human(f.scene.owner, "select-runtime", selection));
      const apply = {
        ...selection,
        localRootReference: local.localRootReference,
        repositoryAlias: local.repositoryAlias,
        sessionAlias: "검증 AI",
        expectedEpoch: response.currentBinding?.bindingEpoch ?? null,
      };
      f.settings.accepted(await f.human(f.scene.owner, "apply", apply));
      let closed = 0;
      const adapter: RuntimeAdapter = {
        capabilities: async () => {
          throw new RuntimeError("PROVIDER_UNAVAILABLE");
        },
        prepare: async () => assert.fail("Failed catalog must not prepare an AI"),
        validate: async () => assert.fail("Failed catalog must not validate an AI"),
        execute: async () => assert.fail("No AI input is authorized"),
        observe: async () => assert.fail("No AI input is authorized"),
        interrupt: async () => false,
        close: async () => {
          closed++;
        },
      };
      const manager = new SettingsManager(
        f.state,
        f.store,
        new SettingsClient(f.workflow.stack.config.app),
        { adapter: () => adapter },
      );
      const result = await manager.run({ once: true });
      assert.equal(result.state, "CANCELLED");
      assert.equal(closed, 1);
      const journal = (await f.store.read())!.journal!;
      const confirmed = f.settings.accepted(
        await f.human(f.scene.owner, "list", {
          deviceId: base.deviceId,
          operationId: base.operationId,
        }),
      );
      assert.equal(confirmed.operation!.state, "CANCELLED");
      assert.deepEqual(confirmed.operation!.receipt, journal.receipt);
      const replacement = await f.requestFolder("codex");
      assert.notEqual(replacement.operationId, base.operationId);
      assert.equal(f.inputs.length, 0);
    }),
);
