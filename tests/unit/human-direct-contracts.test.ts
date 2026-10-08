import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as web from "../../src/features/investigation-coordinator/contracts.ts";
import * as local from "../../packages/local-connector/src/workflow-contracts.ts";

const fixture = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const paired = JSON.parse(readFileSync("tests/fixtures/workflow-contracts.json", "utf8"));
const ask = "ask" as web.Action;
const cancel = "cancel" as web.Action;

test("should admit a human question without a requester device or agent", () => {
  for (const contract of [web, local]) {
    assert.deepEqual(contract.validateBody(ask, fixture.ask), fixture.ask);
    assert.deepEqual(contract.projectResponse(ask, fixture.admission), fixture.admission);
    assert.deepEqual(contract.projectHistory(fixture.history), fixture.history);
    assert.deepEqual(contract.validateBody(cancel, fixture.cancel), fixture.cancel);
    assert.deepEqual(contract.projectResponse(cancel, fixture.cancelResult), fixture.cancelResult);
  }
});

test("should preserve paired workflow and peer wire compatibility", () => {
  const webSource = readFileSync("src/features/investigation-coordinator/contracts.ts", "utf8");
  const localSource = readFileSync("packages/local-connector/src/workflow-contracts.ts", "utf8");
  const webImport = '"./source-contracts.ts"';
  const localImport = '"./workflow/source-contracts.ts"';
  assert.equal(webSource.split(webImport).length, 3);
  assert.equal(localSource.split(localImport).length, 3);
  assert.equal(localSource.replaceAll(localImport, webImport), webSource);
  for (const entry of paired.cases) {
    assert.deepEqual(
      web.validateBody(entry.action, entry.body),
      local.validateBody(entry.action, entry.body),
    );
    assert.deepEqual(web.projectResponse(entry.action, entry.response), entry.response);
    assert.deepEqual(local.projectResponse(entry.action, entry.response), entry.response);
  }
  const peer = structuredClone(
    paired.cases.find((entry: { action: string }) => entry.action === "claim").response,
  );
  peer.payload.requestKind = "PEER";
  peer.payload.questionId = fixture.history.events[0].questionId;
  for (const contract of [web, local]) {
    assert.deepEqual(contract.projectResponse("claim", peer), peer);
    assert.throws(() => contract.projectResponse("claim", { ...peer, mode: "DIRECT" }), {
      code: "UNAVAILABLE",
    });
  }
});

test("should reject observer forged actors and invalid direct targets", () => {
  for (const contract of [web, local]) {
    for (const extra of [
      "originAgentId",
      "originEpoch",
      "ownerId",
      "actor",
      "root",
      "nativeSessionId",
    ]) {
      assert.throws(
        () => contract.validateBody(ask, { ...fixture.ask, [extra]: "SYNTHETIC_FORGED" }),
        { code: "INVALID_BODY" },
      );
    }
    for (const publicText of ["", " \n", "\ud800", "\udfff", "한".repeat(3000)]) {
      assert.throws(() => contract.validateBody(ask, { ...fixture.ask, publicText }), {
        code: "INVALID_BODY",
      });
    }
    assert.throws(
      () => contract.validateBody(ask, { ...fixture.ask, publicText: "x".repeat(16385) }),
      { code: "BODY_TOO_LARGE" },
    );
    for (const targetEpoch of [0, -1, "1", Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => contract.validateBody(ask, { ...fixture.ask, targetEpoch }), {
        code: "INVALID_BODY",
      });
    }
    assert.throws(() => contract.validateBody(ask, { ...fixture.ask, confirmed: false }), {
      code: "INVALID_BODY",
    });
    assert.equal(
      contract.validateBody(ask, { ...fixture.ask, publicText: "  한글 질문 😀  " }).publicText,
      "한글 질문 😀",
    );
  }
});

test("should refuse mixed direct summaries and forged human question events", () => {
  for (const contract of [web, local]) {
    for (const patch of [
      { originAgentId: fixture.ask.targetAgentId },
      { generation: 2 },
      { runsReserved: 2 },
      { peerRoundsReserved: 1 },
      { canInterrupt: "true" },
      { targetEpoch: null },
    ]) {
      const page = structuredClone(fixture.history);
      Object.assign(page.cycle, patch);
      assert.throws(() => contract.projectHistory(page), { code: "UNAVAILABLE" });
    }
    for (const patch of [
      { requestKind: "ORIGIN" },
      { adoption: "ACCEPTED" },
      { questionId: null },
      { bindingEpoch: null },
      { runState: "QUEUED" },
      { replyTo: fixture.history.events[0].questionId },
    ]) {
      const page = structuredClone(fixture.history);
      Object.assign(page.events[0], patch);
      assert.throws(() => contract.projectHistory(page), { code: "UNAVAILABLE" });
    }
    assert.throws(
      () =>
        contract.projectResponse(cancel, {
          controlId: null,
          requestId: fixture.cancel.requestId,
          state: "NO_ACTIVE_RUN",
        }),
      { code: "UNAVAILABLE" },
    );
  }
});
