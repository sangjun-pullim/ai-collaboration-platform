import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runnerFixture } from "./runner-fixture.ts";
import { RuntimeError, scopedNamespace } from "../src/runtime-contracts.ts";

test("should execute only the selected responder and never continue automatically", async () => {
  const fixture = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 100 });
  try {
    const request = fixture.queue("PEER");
    fixture.adapter.executeHook = async (authority) => {
      const saved = (await fixture.store.read())!.attempts.at(-1)!;
      assert.equal(saved.snapshot!.payload.requestKind, "PEER");
      await assert.rejects(
        authority.tool({
          namespace: scopedNamespace,
          tool: "ask_peer",
          threadId: authority.context.threadId,
          turnId: saved.native!.turnId,
          callId: randomUUID(),
          arguments: {
            question: "No recursive direct question",
            evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
          },
        }),
        { code: "TOOL_REJECTED" },
      );
    };
    assert.equal((await fixture.runner().run({ once: true })).state, "UPLOADED");
    assert.equal(fixture.adapter.starts, 1);
    assert.equal(fixture.questionCount(), 0);
    assert.equal(
      fixture.requests.some((item) => item.action === "question"),
      false,
    );
    const saved = (await fixture.store.read())!;
    assert.equal(saved.attempts.length, 1);
    assert.equal(saved.attempts[0].requestId, request.requestId);
    assert.equal(saved.attempts[0].receipt!.continuationRequestId, null);
    const beforePoll = fixture.requests.length;
    // A quiescent runner reports its retained last receipt, not an erased IDLE status.
    assert.equal((await fixture.runner().run({ once: true })).state, "UPLOADED");
    assert.equal(fixture.poll().queuedRequest, null);
    assert.equal(
      fixture.requests
        .slice(beforePoll)
        .some((item) => ["claim", "start-intent", "question", "complete"].includes(item.action)),
      false,
    );
    assert.deepEqual((await fixture.store.read())!.attempts, saved.attempts);
    assert.equal(fixture.adapter.starts, 1);
  } finally {
    await fixture.close();
  }
});

test("should retain ambiguous direct attempts without automatic retry", async () => {
  const fixture = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 100 });
  try {
    fixture.queue("PEER");
    fixture.adapter.executeHook = async () => {
      throw new RuntimeError("UNKNOWN");
    };
    assert.equal((await fixture.runner().run({ once: true })).state, "UNKNOWN");
    fixture.unknown();
    assert.equal((await fixture.runner().run({ once: true })).state, "UNKNOWN");
    assert.equal(fixture.adapter.starts, 1);
    const saved = (await fixture.store.read())!;
    assert.equal(saved.attempts[0].native !== null, true);
    assert.equal(saved.attempts[0].terminal, null);
    assert.equal(fixture.requests.filter((item) => item.action === "start-intent").length, 1);
    assert.equal(
      fixture.requests.some((item) => item.action === "question"),
      false,
    );
  } finally {
    await fixture.close();
  }
});

test("should recover the exact responder terminal outbox without a new native start", async () => {
  const fixture = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 100 });
  let lost = false;
  try {
    fixture.queue("PEER");
    fixture.faults.after = async (action, _body, _result, response) => {
      if (action === "complete" && !lost) {
        lost = true;
        response.destroy();
      }
    };
    assert.equal((await fixture.runner().run({ once: true })).state, "TERMINAL");
    const terminal = (await fixture.store.read())!.attempts[0].terminal;
    assert.equal((await fixture.runner().run({ once: true })).state, "UPLOADED");
    const complete = fixture.requests.filter((item) => item.action === "complete");
    assert.equal(complete.length, 2);
    assert.deepEqual(complete[1].body, complete[0].body);
    assert.deepEqual((await fixture.store.read())!.attempts[0].terminal, terminal);
    assert.equal(fixture.adapter.starts, 1);
  } finally {
    await fixture.close();
  }
});
