import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as web from "../../src/features/investigation-coordinator/contracts.ts";
import * as local from "../../packages/local-connector/src/workflow-contracts.ts";
test("should agree on workflow contracts across web and local clients", () => {
  const fixture = JSON.parse(readFileSync("tests/fixtures/workflow-contracts.json", "utf8")) as {
    cases: { action: web.Action; body: web.Body; response: unknown }[];
    cycleResume: web.Body;
  };
  assert.equal(fixture.cases.length, 15);
  assert.deepEqual(web.humanActions, local.humanActions);
  assert.deepEqual(web.deviceActions, local.deviceActions);
  for (const c of fixture.cases) {
    assert.deepEqual(web.validateBody(c.action, c.body), local.validateBody(c.action, c.body));
    assert.deepEqual(
      web.projectResponse(c.action, c.response),
      local.projectResponse(c.action, c.response),
    );
    for (const contract of [web, local]) {
      assert.throws(() => contract.validateBody(c.action, { ...c.body, actor: "forged" }), {
        code: "INVALID_BODY",
      });
      assert.throws(
        () =>
          contract.projectResponse(c.action, {
            ...(c.response as object),
            providerError: "secret",
          }),
        { code: "UNAVAILABLE" },
      );
      assert.throws(
        () =>
          contract.projectEnvelope(
            c.action,
            { ok: false, error: { code: "CONFLICT", message: "raw" } },
            409,
          ),
        { code: "UNAVAILABLE" },
      );
    }
  }
  for (const contract of [web, local]) {
    assert.deepEqual(contract.validateBody("resume", fixture.cycleResume), fixture.cycleResume);
    assert.throws(() => contract.validateBody("resume", { ...fixture.cycleResume, mode: "room" }), {
      code: "INVALID_BODY",
    });
    assert.throws(() =>
      contract.validateBody("speak", { ...fixture.cases[1].body, publicText: "😀".repeat(4001) }),
    );
    assert.throws(
      () => contract.validateBody("complete", { ...fixture.cases[12].body, terminal: "FAILED" }),
      { code: "INVALID_BODY" },
    );
    const cursor = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    cursor.highWaterSequence = 2;
    cursor.hasMore = false;
    assert.throws(() => contract.projectResponse("read", cursor), { code: "UNAVAILABLE" });
    const roomEvent = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    Object.assign(roomEvent.events[0], {
      kind: "ROOM_PAUSED",
      senderKind: "SYSTEM",
      publicText: "",
      roomMode: "ACTIVE",
    });
    assert.throws(() => contract.projectResponse("read", roomEvent), { code: "UNAVAILABLE" });
    const interrupt = structuredClone(
      fixture.cases.find((c) => c.action === "interrupt")!.response,
    ) as { requestId: string | null; state: string };
    interrupt.requestId = null;
    interrupt.state = "REQUESTED";
    assert.throws(() => contract.projectResponse("interrupt", interrupt), { code: "UNAVAILABLE" });
    assert.throws(
      () =>
        contract.validateBody("speak", { ...fixture.cases[1].body, publicText: " ".repeat(16385) }),
      { code: "BODY_TOO_LARGE" },
    );
    const ready = structuredClone(fixture.cases.find((c) => c.action === "ready")!.response) as {
      reportedReady: boolean;
      validUntil: string | null;
    };
    ready.reportedReady = false;
    assert.throws(() => contract.projectResponse("ready", ready), { code: "UNAVAILABLE" });
    const badCycle = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    (badCycle.cycle as web.CycleSummary).peerAgentId = (
      badCycle.cycle as web.CycleSummary
    ).originAgentId;
    assert.throws(() => contract.projectResponse("read", badCycle), { code: "UNAVAILABLE" });
    const badRun = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    badRun.runs[0].requestKind = "PEER";
    badRun.runs[0].questionId = null;
    assert.throws(() => contract.projectResponse("read", badRun), { code: "UNAVAILABLE" });
    const badBinding = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    badBinding.bindings[0].validUntil = null;
    assert.throws(() => contract.projectResponse("read", badBinding), { code: "UNAVAILABLE" });
    const badQuestion = structuredClone(
      fixture.cases.find((c) => c.action === "question")!.response,
    ) as {
      accepted: boolean;
      questionId: string | null;
      peerRequestId: string | null;
      cycleState: web.CycleState;
    };
    badQuestion.accepted = false;
    badQuestion.questionId = null;
    badQuestion.peerRequestId = null;
    badQuestion.cycleState = "ACTIVE";
    assert.throws(() => contract.projectResponse("question", badQuestion), { code: "UNAVAILABLE" });
    const h = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    h.bindings[0].runtime = "claude";
    assert.deepEqual(contract.projectResponse("read", h), h);
    (h.bindings[0] as unknown as Record<string, unknown>).runtime = "unknown-provider";
    assert.throws(() => contract.projectResponse("read", h), { code: "UNAVAILABLE" });
    const a = structuredClone(fixture.cases[8].response) as web.AttemptSnapshot;
    (a.payload as unknown as Record<string, unknown>).nativeSession = "private";
    assert.throws(() => contract.projectResponse("claim", a), { code: "UNAVAILABLE" });
    const agentSpeech = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    Object.assign(agentSpeech.events[0], {
      senderKind: "AGENT",
      cycleId: agentSpeech.cycle!.cycleId,
      requestId: "00000000-0000-4000-8000-000000000006",
      agentId: agentSpeech.bindings[0].agentId,
      bindingEpoch: 1,
      requestKind: "ORIGIN",
      adoption: "ACCEPTED",
    });
    assert.deepEqual(contract.projectResponse("read", agentSpeech), agentSpeech);
    agentSpeech.events[0].adoption = "PENDING";
    assert.throws(() => contract.projectResponse("read", agentSpeech), { code: "UNAVAILABLE" });
    const bad = structuredClone(fixture.cases[0].response) as web.HistoryPage;
    bad.events[0].kind = "RUN_STATE";
    assert.throws(() => contract.projectResponse("read", bad), { code: "UNAVAILABLE" });
  }
});

test("should agree on exact input control actions without changing old v1 responses", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const state = {
    agentId: id,
    bindingEpoch: 1,
    revision: 1,
    paused: false,
    appliedRevision: null,
    appliedEpoch: null,
    appliedAt: null,
  };
  const cases: [web.Action, web.Body, unknown][] = [
    ["input-state", { protocol: 1, roomId: id }, { roomId: id, bindings: [state] }],
    [
      "input-control",
      {
        protocol: 1,
        roomId: id,
        expectedUserId: id,
        operationId: id,
        agentId: id,
        bindingEpoch: 1,
        expectedRevision: 1,
        paused: true,
      },
      state,
    ],
    ["admission", { protocol: 1, agentId: id, bindingEpoch: 1 }, state],
    [
      "admission-ack",
      { protocol: 1, agentId: id, bindingEpoch: 1, revision: 1, paused: false },
      state,
    ],
  ];
  for (const [action, body, response] of cases)
    for (const contract of [web, local]) {
      assert.deepEqual(contract.validateBody(action, body), body);
      assert.deepEqual(contract.projectResponse(action, response), response);
      assert.throws(() => contract.validateBody(action, { ...body, actor: id }), {
        code: "INVALID_BODY",
      });
    }
  for (const contract of [web, local]) {
    assert.throws(
      () => contract.projectResponse("input-state", { roomId: id, bindings: [state, state] }),
      { code: "UNAVAILABLE" },
    );
    for (const wrong of [
      { ...state, appliedAt: new Date().toISOString() },
      { ...state, appliedRevision: 2, appliedEpoch: 1, appliedAt: new Date().toISOString() },
    ])
      assert.throws(() => contract.projectResponse("admission", wrong), { code: "UNAVAILABLE" });
  }
});
