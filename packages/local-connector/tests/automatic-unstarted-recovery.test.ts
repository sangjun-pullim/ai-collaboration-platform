import test from "node:test";
import assert from "node:assert/strict";
import { runnerFixture } from "./runner-fixture.ts";
import { WorkflowError } from "../src/workflow-contracts.ts";
import type { WorkflowClient } from "../src/workflow-client.ts";
import { SyntheticAdapter } from "./runner-fixture.ts";
import { RuntimeError } from "../src/runtime-contracts.ts";

function clientOf(runner: ReturnType<Awaited<ReturnType<typeof runnerFixture>>["runner"]>) {
  return (runner as unknown as { client: WorkflowClient }).client;
}

test("should restore server readiness before claiming after transient admission failure", async () => {
  const f = await runnerFixture();
  const runner = f.runner();
  const client = (runner as unknown as { client: WorkflowClient }).client;
  const call = client.call.bind(client);
  const controller = new AbortController();
  let admissions = 0;
  let reportedReady = false;
  const readinessAtClaim: boolean[] = [];
  client.call = async (action, body, ...args) => {
    if (action === "admission" && ++admissions === 2) throw new WorkflowError("UNAVAILABLE");
    if (action === "claim") {
      readinessAtClaim.push(reportedReady);
      // Match the production SQL readiness prerequisite omitted by the old fixture.
      if (!reportedReady) throw new WorkflowError("CONFLICT");
    }
    const result = await call(action, body, ...args);
    if (action === "ready") {
      reportedReady = body.reportedReady === true;
      if (!reportedReady && readinessAtClaim.length === 0) f.queue();
    }
    if (action === "complete") controller.abort();
    return result;
  };
  try {
    await runner.run({ signal: controller.signal }).catch((error: { code?: string }) => {
      if (error.code !== "RUNTIME_CLOSED") throw error;
    });
    assert.deepEqual(readinessAtClaim, [true]);
  } finally {
    runner.stop();
    await f.close();
  }
});

test("should recover a cancelled unstarted claim and accept only the next new question", async () => {
  const f = await runnerFixture();
  try {
    const old = f.queue();
    const first = f.runner();
    const original = clientOf(first).call.bind(clientOf(first));
    clientOf(first).call = async (action, body, ...args) => {
      if (action === "claim") throw new WorkflowError("CONFLICT");
      return original(action, body, ...args);
    };
    await first.run({ once: true });
    const before = (await f.store.read())!;
    const claim = before.operations.find((op) => op.action === "claim")!;
    assert.equal(before.attempts[0].state, "UNKNOWN");
    assert.equal(claim.state, "TRANSMITTED");
    const next = f.queue();
    const adapter = new SyntheticAdapter();
    const second = f.runner(adapter);
    const secondCall = clientOf(second).call.bind(clientOf(second));
    clientOf(second).call = async (action, body, ...args) => {
      if (action === "claim" && body.requestId === old.requestId) {
        assert.deepEqual(body, claim.body);
        throw new WorkflowError("REQUEST_CANCELLED");
      }
      return secondCall(action, body, ...args);
    };
    await second.run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(after.attempts[0].requestId, old.requestId);
    assert.equal(after.attempts[0].state, "NOT_STARTED");
    assert.deepEqual(after.attempts[0].unstartedClosure, {
      kind: "SERVER_REQUEST_CANCELLED",
      claimOperationId: claim.operationId,
    });
    assert.equal(
      after.operations.find((op) => op.operationId === claim.operationId)!.state,
      "CLOSED",
    );
    assert.equal(after.attempts[0].snapshot, null);
    assert.equal(after.attempts[0].native, null);
    assert.equal(after.attempts[1].requestId, next.requestId);
    assert.equal(after.attempts[1].state, "UPLOADED");
    assert.equal(adapter.starts, 1);
    assert.equal(f.adapter.starts, 0);
    for (const mutate of [
      (v: typeof after) => {
        v.attempts[0].unstartedClosure!.claimOperationId = next.requestId;
      },
      (v: typeof after) => {
        v.attempts[0].native = { threadId: next.requestId, turnId: next.requestId };
      },
      (v: typeof after) => {
        v.attempts[0].snapshot = structuredClone(v.attempts[1].snapshot);
      },
      (v: typeof after) => {
        v.attempts[0].nativeIntent = { ...v.attempts[1].nativeIntent! };
      },
    ]) {
      const tampered = structuredClone(after);
      mutate(tampered);
      await assert.rejects(async () => f.store.write(tampered));
    }
  } finally {
    await f.close();
  }
});

test("should retain unknown evidence when cancellation proof cannot be obtained", async () => {
  for (const code of ["CONFLICT", "UNAVAILABLE", "FORBIDDEN"] as const) {
    const f = await runnerFixture();
    try {
      f.queue();
      const first = f.runner();
      const original = clientOf(first).call.bind(clientOf(first));
      clientOf(first).call = async (action, body, ...args) => {
        if (action === "claim") throw new WorkflowError("CONFLICT");
        return original(action, body, ...args);
      };
      await first.run({ once: true });
      const adapter = new SyntheticAdapter();
      const second = f.runner(adapter);
      const secondCall = clientOf(second).call.bind(clientOf(second));
      clientOf(second).call = async (action, body, ...args) => {
        if (action === "claim") throw new WorkflowError(code);
        return secondCall(action, body, ...args);
      };
      await assert.rejects(() => second.run({ once: true }));
      assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
      assert.equal(adapter.starts, 0);
    } finally {
      await f.close();
    }
  }
});

test("should retry cancellation closure after an uncommitted local write failure", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    const runner = f.runner(f.adapter, {
      beforeMutation: async (kind) => {
        if (kind === "unstarted-closure") throw new RuntimeError("UNKNOWN");
      },
    });
    const original = clientOf(runner).call.bind(clientOf(runner));
    clientOf(runner).call = async (action, body, ...args) => {
      if (action === "claim") throw new WorkflowError("REQUEST_CANCELLED");
      return original(action, body, ...args);
    };
    await runner.run({ once: true });
    const before = (await f.store.read())!;
    assert.equal(before.attempts[0].state, "UNKNOWN");
    assert.equal(before.attempts[0].unstartedClosure, undefined);
    const retry = f.runner(new SyntheticAdapter());
    const call = clientOf(retry).call.bind(clientOf(retry));
    clientOf(retry).call = async (action, body, ...args) => {
      if (action === "claim") throw new WorkflowError("REQUEST_CANCELLED");
      return call(action, body, ...args);
    };
    await retry.run({ once: true });
    assert.equal((await f.store.read())!.attempts[0].state, "NOT_STARTED");
  } finally {
    await f.close();
  }
});

test("should create no claim intent when readiness publication fails", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    const runner = f.runner();
    const call = clientOf(runner).call.bind(clientOf(runner));
    clientOf(runner).call = async (action, body, ...args) => {
      if (action === "ready") throw new WorkflowError("UNAVAILABLE");
      return call(action, body, ...args);
    };
    await assert.rejects(() => runner.run({ once: true }));
    assert.equal((await f.store.read())!.attempts.length, 0);
    assert.equal(f.adapter.starts, 0);
  } finally {
    await f.close();
  }
});

test("should not execute an old queued question while recovering its original claim", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    const first = f.runner();
    const initial = clientOf(first).call.bind(clientOf(first));
    clientOf(first).call = async (action, body, ...args) => {
      if (action === "claim") throw new WorkflowError("CONFLICT");
      return initial(action, body, ...args);
    };
    await first.run({ once: true });
    const before = (await f.store.read())!;
    const claim = before.operations.find((op) => op.action === "claim")!;
    const adapter = new SyntheticAdapter();
    const retry = f.runner(adapter);
    const call = clientOf(retry).call.bind(clientOf(retry));
    clientOf(retry).call = async (action, body, ...args) => {
      if (action === "claim") assert.deepEqual(body, claim.body);
      return call(action, body, ...args);
    };
    await retry.run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(after.attempts[0].state, "UNKNOWN");
    assert.equal(after.attempts[0].unstartedClosure, undefined);
    assert.equal(adapter.starts, 0);
  } finally {
    await f.close();
  }
});
