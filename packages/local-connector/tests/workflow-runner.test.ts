import test from "node:test";
import assert from "node:assert/strict";
import { runnerFixture, deferred, SyntheticAdapter, settleRunnerJobs } from "./runner-fixture.ts";
import {
  scopedNamespace,
  RuntimeAdmission,
  digest,
  stableJson,
  type AttemptAuthority,
} from "../src/runtime-contracts.ts";
import { observation, uuid, appendFixtureCompletion } from "./runtime-fixture.ts";
import { RuntimeStore, assertRuntimeCapacity } from "../src/runtime-store.ts";
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ConnectionError } from "../src/contracts.ts";
import { RuntimeError } from "../src/runtime-contracts.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { FakeProvider } from "./fake-provider.ts";
import { WorkflowError, type AttemptSnapshot } from "../src/workflow-contracts.ts";

function callback(
  authority: AttemptAuthority,
  turnId: string,
  tool = "ask_peer",
  args: unknown = {
    question: "What does the selected evidence show?",
    evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
  },
  callId = "question-call",
) {
  return {
    threadId: authority.context.threadId,
    turnId,
    namespace: scopedNamespace,
    callId,
    tool,
    arguments: args,
  };
}

async function waitForSynthetic(check: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 160; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}
test(
  "should guard question operation intent after tool closure and never replay a stale question",
  { timeout: 10000 },
  async () => {
    for (const closure of ["control", "terminal"]) {
      const f = await runnerFixture({ pollIntervalMs: 5 }),
        entered = deferred(),
        release = deferred(),
        providerRelease = deferred();
      let pending: Promise<unknown> | undefined;
      const runtime = f.runner(f.adapter, {
        pollIntervalMs: 5,
        beforeMutation: async (kind) => {
          if (
            kind === "operation-intent" &&
            (await f.store.read())!.attempts[0]?.toolCalls.length
          ) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      f.queue();
      f.adapter.executeHook = async (authority) => {
        pending = authority.tool(
          callback(authority, (await f.store.read())!.attempts[0].native!.turnId),
        );
        void pending.catch(() => {});
        await providerRelease.promise;
      };
      const run = runtime.run({ once: true });
      try {
        await entered.promise;
        assert.equal((await f.store.read())!.attempts[0].toolCalls.length, 1);
        if (closure === "control") {
          f.adapter.terminal = "INTERRUPTED";
          f.control();
          await waitForSynthetic(
            () => f.adapter.interrupts > 0,
            "SYNTHETIC_TOOL_CONTROL_NOT_CLOSED",
          );
        } else {
          providerRelease.resolve();
          await waitForSynthetic(
            () => !(runtime as unknown as { toolOpen: boolean }).toolOpen,
            "SYNTHETIC_TOOL_TERMINAL_NOT_CLOSED",
          );
        }
        release.resolve();
        await assert.rejects(pending!, { code: "TOOL_REJECTED" });
        providerRelease.resolve();
        await run;
        const saved = (await f.store.read())!;
        assert.equal(
          saved.operations.some((o) => o.action === "question"),
          false,
        );
        assert.equal(f.questionCount(), 0);
        assert.equal(saved.attempts[0].state, "UPLOADED");
        await f.runner(new SyntheticAdapter()).run({ once: true });
        assert.equal(
          f.requests.some((r) => r.action === "question"),
          false,
        );
      } finally {
        runtime.stop();
        release.resolve();
        providerRelease.resolve();
        await run;
        await f.close();
      }
    }
  },
);
test(
  "should preserve pending rotation bytes after a late authority error and released runner lock",
  { timeout: 15000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1790848000000 });
    for (const status of [401, 403, 409]) {
      const f = await runnerFixture(),
        entered = deferred(),
        release = deferred(),
        providerEntered = deferred(),
        providerRelease = deferred(),
        runtime = f.runner(f.adapter, { pollIntervalMs: 5, drainTimeoutMs: 10 });
      f.queue();
      f.adapter.executeHook = async () => {
        providerEntered.resolve();
        await providerRelease.promise;
      };
      const client = f.connector.client,
        original = client.call.bind(client);
      client.call = async (...args) => {
        if (args[0] !== "rotate") return original(...args);
        entered.resolve();
        await release.promise;
        throw new ConnectionError(
          status === 401 ? "UNAUTHENTICATED" : status === 403 ? "FORBIDDEN" : "CONFLICT",
        );
      };
      const run = runtime.run({ once: true });
      try {
        await providerEntered.promise;
        const state = (await f.profile.read())!,
          operationId = uuid(),
          candidateCredential = "a".repeat(64);
        state.pending = {
          action: "rotate",
          body: { operationId, credentialHash: digest(candidateCredential) },
          secret: state.credential,
          candidateCredential,
          payloadHash: digest(
            JSON.stringify({ operationId, credentialHash: digest(candidateCredential) }),
          ),
        };
        await f.profile.transaction(() => f.profile.write(state));
        t.mock.timers.setTime(Date.now() + 6000);
        await entered.promise;
        runtime.stop();
        providerRelease.resolve();
        await run;
        const bytes = await readFile(f.profile.file);
        assert.equal((await f.profile.read())!.status, "connected");
        await f.store.locked(async () => {
          await f.store.sessionLocked(f.context.threadId, async () => {
            release.resolve();
            await waitForSynthetic(async () => {
              try {
                await f.profile.transaction(async () => {});
                return true;
              } catch {
                return false;
              }
            }, "SYNTHETIC_ROTATION_NOT_DRAINED");
            assert.deepEqual(await readFile(f.profile.file), bytes);
            assert.deepEqual((await f.profile.read())!.pending, state.pending);
          });
        });
      } finally {
        release.resolve();
        providerRelease.resolve();
        runtime.stop();
        client.call = original;
        await run.catch(() => {});
        await f.close();
      }
    }
  },
);
for (const crash of [
  "before-transmission",
  "pending-claim",
  "response-loss",
  "claimed",
  "pending-start",
]) {
  test(
    `should close only proof-safe ${crash} claim crashes and retain old evidence before a fresh higher fence`,
    { timeout: 15000 },
    async () => {
      const f = await runnerFixture();
      let fail = true;
      const runtime = f.runner(f.adapter, {
        beforeMutation: async (kind) => {
          if (
            fail &&
            ((crash === "claimed" && kind === "server-intent") ||
              (crash === "before-transmission" &&
                kind === "operation-intent" &&
                (await f.store.read())!.attempts.length > 0) ||
              (["pending-claim", "pending-start"].includes(crash) &&
                kind === "operation-transmitted" &&
                (await f.store.read())!.operations.at(-1)?.action ===
                  (crash === "pending-claim" ? "claim" : "start-intent")))
          ) {
            fail = false;
            throw new RuntimeError("UNKNOWN");
          }
        },
      });
      if (crash === "response-loss")
        f.faults.after = async (action, _body, _result, response) => {
          if (action === "claim" && fail) {
            fail = false;
            response.destroy();
          }
        };
      try {
        const payload = f.queue();
        await runtime.run({ once: true });
        const before = (await f.store.read())!;
        assert.equal(f.adapter.starts, 0);
        assert.equal(before.attempts[0].state, "UNKNOWN");
        if (!["before-transmission", "pending-claim"].includes(crash)) {
          f.expireUnstarted();
          assert.equal(f.poll().attempt, null);
        }
        const next = new SyntheticAdapter(),
          result = await f.runner(next).run({ once: true });
        assert.equal(result.state, "UPLOADED");
        assert.equal(next.starts, 1);
        const saved = (await f.store.read())!;
        assert.equal(saved.attempts.length, 2);
        assert.equal(saved.attempts[0].state, "NOT_STARTED");
        assert.equal(saved.attempts[1].requestId, payload.requestId);
        assert.deepEqual(saved.attempts[0].snapshot, before.attempts[0].snapshot);
        for (const op of before.operations.filter(
          (o) => o.state === "CONFIRMED" && o.action !== "ready",
        ))
          assert.deepEqual(
            saved.operations.find((o) => o.operationId === op.operationId),
            op,
          );
        assert.equal(f.requests.filter((r) => r.action === "start-intent").length, 1);
        if (!["before-transmission", "pending-claim"].includes(crash)) {
          const claims = f.requests.filter((r) => r.action === "claim");
          assert.deepEqual(claims[0].body, claims[1].body);
          assert.equal(claims.length, 3);
          const proof = saved.attempts[0].unstartedClosure;
          assert.equal(proof?.kind, "SERVER_ABANDONED");
          assert.ok(
            saved.attempts[1].snapshot!.fence >
              (proof?.kind === "SERVER_ABANDONED" ? proof.snapshot.fence : 0),
          );
        }
      } finally {
        runtime.stop();
        await f.close();
      }
    },
  );
}
async function claimedCrash(f: Awaited<ReturnType<typeof runnerFixture>>) {
  f.queue();
  await f
    .runner(f.adapter, {
      beforeMutation: async (kind) => {
        if (kind === "server-intent") throw new RuntimeError("UNKNOWN");
      },
    })
    .run({ once: true });
  const saved = (await f.store.read())!;
  assert.equal(saved.attempts[0].state, "UNKNOWN");
  assert.equal(f.adapter.starts, 0);
  return saved;
}
async function unstartedLeaseCrash(
  f: Awaited<ReturnType<typeof runnerFixture>>,
  state: "PENDING" | "TRANSMITTED",
) {
  const leaseEntered = deferred(),
    startRelease = deferred();
  f.faults.before = async (action) => {
    if (action === "start-intent") {
      await startRelease.promise;
      throw new RuntimeError("UNKNOWN");
    }
    if (action === "lease" && state === "TRANSMITTED") {
      leaseEntered.resolve();
      throw new RuntimeError("UNKNOWN");
    }
  };
  const runtime = f.runner(f.adapter, {
    pollIntervalMs: 5,
    leaseIntervalMs: 5,
    beforeMutation: async (kind) => {
      if (
        state === "PENDING" &&
        kind === "operation-transmitted" &&
        (await f.store.read())!.operations.some(
          (o) => o.action === "lease" && o.state === "PENDING",
        )
      ) {
        runtime.stop();
        leaseEntered.resolve();
        throw new RuntimeError("UNKNOWN");
      }
    },
  });
  f.queue();
  const run = runtime.run({ once: true });
  try {
    await leaseEntered.promise;
    startRelease.resolve();
    await run;
  } finally {
    startRelease.resolve();
    runtime.stop();
    await run;
    f.faults.before = undefined;
  }
  const saved = (await f.store.read())!,
    lease = saved.operations.find((o) => o.action === "lease")!;
  assert.equal(saved.attempts[0].state, "UNKNOWN");
  assert.equal(saved.attempts[0].snapshot!.startIntentAt, null);
  assert.equal(lease.state, state);
  assert.equal(f.poll().attempt!.state, "LEASED");
  assert.equal(f.adapter.starts, 0);
  return { saved, lease };
}
async function sealUnstartedLease(
  f: Awaited<ReturnType<typeof runnerFixture>>,
  before: Awaited<ReturnType<typeof unstartedLeaseCrash>>["saved"],
) {
  const claim = before.operations.find(
    (o) => o.operationId === before.attempts[0].claimOperationId,
  )!;
  const snapshot = (await f
    .runner()
    .client.call("claim", claim.body, (await f.profile.read())!.credential!)) as AttemptSnapshot;
  const prior = structuredClone(before);
  prior.attempts[0].state = "NOT_STARTED";
  prior.attempts[0].reason = null;
  prior.attempts[0].unstartedClosure = {
    kind: "SERVER_ABANDONED",
    claimOperationId: claim.operationId,
    snapshot,
  };
  for (const op of prior.operations) if (op.action === "start-intent") op.state = "CLOSED";
  await f.store.write(prior);
  return structuredClone(prior.attempts[0]);
}
for (const stage of ["PENDING", "TRANSMITTED", "SEALED"] as const) {
  test(
    `should close proof-linked ${stage} unstarted leases before a fresh higher fence`,
    { timeout: 15000 },
    async () => {
      const f = await runnerFixture();
      try {
        const { saved: before, lease } = await unstartedLeaseCrash(
          f,
          stage === "PENDING" ? "PENDING" : "TRANSMITTED",
        );
        f.expireUnstarted();
        let sealed = undefined as (typeof before.attempts)[0] | undefined;
        if (stage === "SEALED") {
          sealed = await sealUnstartedLease(f, before);
        }
        const count = f.requests.length,
          next = new SyntheticAdapter();
        assert.equal((await f.runner(next).run({ once: true })).state, "UPLOADED");
        const after = (await f.store.read())!,
          closed = after.operations.find((o) => o.operationId === lease.operationId)!;
        assert.deepEqual(closed, { ...lease, state: "CLOSED" });
        assert.equal(next.starts, 1);
        assert.equal(after.attempts[0].state, "NOT_STARTED");
        assert.deepEqual(after.attempts[0].snapshot, before.attempts[0].snapshot);
        if (sealed) assert.deepEqual(after.attempts[0], sealed);
        assert.ok(after.attempts[1].snapshot!.fence > before.attempts[0].snapshot!.fence);
        for (const op of before.operations.filter(
          (o) => o.state === "CONFIRMED" && o.action !== "ready",
        ))
          assert.deepEqual(
            after.operations.find((o) => o.operationId === op.operationId),
            op,
          );
        assert.equal(
          f.requests
            .slice(count)
            .some(
              (r) =>
                r.body.operationId === lease.operationId ||
                (r.action === "start-intent" && r.body.attemptId === lease.body.attemptId),
            ),
          false,
        );
        const revalidated = f.requests.slice(count).find((r) => r.action === "claim")!;
        assert.deepEqual(
          revalidated.body,
          before.operations.find((o) => o.operationId === before.attempts[0].claimOperationId)!
            .body,
        );
      } finally {
        await f.close();
      }
    },
  );
}
test(
  "should retain unstarted leases on foreign claim evidence poll absence or authority denial including sealed restarts",
  { timeout: 20000 },
  async () => {
    for (const sealed of [false, true])
      for (const invalid of [
        "requestId",
        "attemptId",
        "agentId",
        "bindingEpoch",
        "fence",
        "payload",
        "started",
        "poll-null",
        "revoked",
        "epoch",
      ]) {
        const f = await runnerFixture();
        try {
          const { saved, lease } = await unstartedLeaseCrash(f, "TRANSMITTED");
          if (sealed || invalid !== "poll-null") f.expireUnstarted();
          if (sealed) await sealUnstartedLease(f, saved);
          const protectedRecord = (await f.store.read())!,
            calls = f.requests.length;
          f.faults.after = async (action, _body, result) => {
            if (action !== "claim") return;
            const snapshot = result as AttemptSnapshot;
            if (["requestId", "attemptId", "agentId"].includes(invalid))
              Object.assign(snapshot, { [invalid]: uuid() });
            if (invalid === "bindingEpoch") snapshot.bindingEpoch++;
            if (invalid === "fence") snapshot.fence++;
            if (invalid === "payload") snapshot.payload.publicText = "SYNTHETIC_CHANGED";
            if (invalid === "started") snapshot.startIntentAt = new Date().toISOString();
            if (invalid === "poll-null" && sealed) snapshot.state = "LEASED";
          };
          if (invalid === "revoked") f.faults.revoked = true;
          if (invalid === "epoch") f.epoch(2);
          const next = new SyntheticAdapter();
          await f
            .runner(next)
            .run({ once: true })
            .catch(() => {});
          const after = (await f.store.read())!;
          assert.deepEqual(after.attempts, protectedRecord.attempts);
          assert.deepEqual(
            after.operations.find((o) => o.operationId === lease.operationId),
            lease,
          );
          for (const op of protectedRecord.operations.filter((o) => o.action !== "ready"))
            assert.deepEqual(
              after.operations.find((o) => o.operationId === op.operationId),
              op,
            );
          assert.equal(next.starts, 0);
          assert.equal(
            f.requests.slice(calls).some((r) => ["lease", "start-intent"].includes(r.action)),
            false,
          );
        } finally {
          await f.close();
        }
      }
  },
);
test("should preserve confirmed unstarted lease receipts while closing only unresolved renewals", async () => {
  const f = await runnerFixture();
  try {
    const { saved, lease } = await unstartedLeaseCrash(f, "TRANSMITTED");
    const operationId = uuid(),
      body = { ...lease.body, operationId };
    const receipt = await f
      .runner()
      .client.call("lease", body, (await f.profile.read())!.credential!);
    const confirmed = {
      operationId,
      action: "lease" as const,
      body,
      payloadHash: digest(stableJson({ action: "lease", body })),
      state: "CONFIRMED" as const,
      result: receipt,
    };
    saved.operations.push(confirmed);
    await f.store.write(saved);
    f.expireUnstarted();
    assert.equal((await f.runner(new SyntheticAdapter()).run({ once: true })).state, "UPLOADED");
    assert.deepEqual(
      (await f.store.read())!.operations.find((o) => o.operationId === operationId),
      confirmed,
    );
  } finally {
    await f.close();
  }
});
test(
  "should reject late old lease receipts after proof closure without rewriting sealed evidence",
  { timeout: 10000 },
  async () => {
    const f = await runnerFixture(),
      leaseEntered = deferred(),
      leaseRelease = deferred(),
      startRelease = deferred();
    const runtime = f.runner(f.adapter, {
      pollIntervalMs: 5,
      leaseIntervalMs: 5,
      drainTimeoutMs: 10,
    });
    f.faults.before = async (action) => {
      if (action === "start-intent") {
        await startRelease.promise;
        throw new RuntimeError("UNKNOWN");
      }
    };
    f.faults.after = async (action) => {
      if (action === "lease") {
        leaseEntered.resolve();
        await leaseRelease.promise;
      }
    };
    f.queue();
    const run = runtime.run({ once: true });
    try {
      await leaseEntered.promise;
      runtime.stop();
      startRelease.resolve();
      await run;
      const before = (await f.store.read())!,
        lease = before.operations.find((o) => o.action === "lease")!;
      assert.equal(lease.state, "TRANSMITTED");
      f.faults.before = undefined;
      f.faults.after = undefined;
      f.expireUnstarted();
      assert.equal((await f.runner(new SyntheticAdapter()).run({ once: true })).state, "UPLOADED");
      const bytes = await readFile(f.store.file);
      leaseRelease.resolve();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.deepEqual(await readFile(f.store.file), bytes);
      assert.deepEqual(
        (await f.store.read())!.operations.find((o) => o.operationId === lease.operationId),
        { ...lease, state: "CLOSED" },
      );
      assert.equal(f.adapter.starts, 0);
    } finally {
      runtime.stop();
      startRelease.resolve();
      leaseRelease.resolve();
      await run.catch(() => {});
      await f.close();
    }
  },
);
test(
  "should retain residual leases when provider intent exists without a native acknowledgement",
  { timeout: 10000 },
  async () => {
    const f = await runnerFixture(),
      leaseEntered = deferred(),
      leaseRelease = deferred(),
      ackFailed = deferred();
    f.adapter.validateHook = async () => {
      if (f.adapter.current) await leaseEntered.promise;
    };
    f.faults.after = async (action) => {
      if (action === "lease") {
        leaseEntered.resolve();
        await leaseRelease.promise;
      }
    };
    const runtime = f.runner(f.adapter, {
      pollIntervalMs: 5,
      leaseIntervalMs: 5,
      beforeMutation: async (kind) => {
        if (kind === "native-ack") {
          ackFailed.resolve();
          throw new RuntimeError("UNKNOWN");
        }
      },
    });
    f.queue();
    const run = runtime.run({ once: true });
    try {
      await ackFailed.promise;
      runtime.stop();
      leaseRelease.resolve();
      await run;
      const before = (await f.store.read())!,
        lease = before.operations.find((o) => o.action === "lease")!;
      assert.equal(before.attempts[0].native, null);
      assert.notEqual(before.attempts[0].snapshot!.startIntentAt, null);
      assert.equal(lease.state, "TRANSMITTED");
      assert.equal(f.adapter.starts, 1);
      const calls = f.requests.length,
        next = new SyntheticAdapter();
      await f.runner(next).run({ once: true });
      const after = (await f.store.read())!;
      assert.deepEqual(after.attempts, before.attempts);
      assert.deepEqual(
        after.operations.find((o) => o.operationId === lease.operationId),
        lease,
      );
      assert.equal(after.attempts[0].unstartedClosure, undefined);
      assert.equal(next.starts, 0);
      assert.equal(
        f.requests.slice(calls).some((r) => ["claim", "lease", "start-intent"].includes(r.action)),
        false,
      );
    } finally {
      runtime.stop();
      leaseRelease.resolve();
      await run.catch(() => {});
      await f.close();
    }
  },
);
test("should keep late old-fence callbacks and publication separate from a reclaimed request", async () => {
  const f = await runnerFixture();
  let old: AttemptAuthority | undefined;
  const first = f.runner(f.adapter, {
    beforeMutation: async (kind) => {
      if (kind === "server-intent") {
        old = (first as unknown as { active: AttemptAuthority }).active;
        throw new RuntimeError("UNKNOWN");
      }
    },
  });
  try {
    f.queue();
    await first.run({ once: true });
    const previous = (await f.store.read())!;
    assert.ok(old);
    f.expireUnstarted();
    const next = new SyntheticAdapter();
    next.executeHook = async (authority) => {
      await assert.rejects(old!.ack(f.context.threadId, "SYNTHETIC_OLD_ACK"), {
        code: "RUNTIME_CLOSED",
      });
      await assert.rejects(old!.tool(callback(old!, "SYNTHETIC_OLD_TURN")), {
        code: "RUNTIME_CLOSED",
      });
      const body = {
        protocol: 1,
        operationId: uuid(),
        agentId: f.scope.agentId,
        bindingEpoch: 1,
        requestId: old!.attempt.requestId,
        attemptId: old!.attempt.attemptId,
        fence: old!.attempt.fence,
        terminal: "COMPLETED",
        publicText: "SYNTHETIC_OLD_PUBLIC",
      };
      await assert.rejects(
        first.client.call("complete", body, (await f.profile.read())!.credential!),
        { code: "CONFLICT" },
      );
      assert.notEqual(authority.attempt.attemptId, old!.attempt.attemptId);
      assert.ok(authority.attempt.fence > old!.attempt.fence);
    };
    assert.equal((await f.runner(next).run({ once: true })).state, "UPLOADED");
    const saved = (await f.store.read())!;
    assert.equal(saved.attempts[0].state, "NOT_STARTED");
    assert.deepEqual(saved.attempts[0].snapshot, previous.attempts[0].snapshot);
    assert.equal(saved.attempts[0].native, null);
    assert.equal(saved.attempts[0].receipt, null);
    assert.equal(saved.attempts[1].receipt!.attemptId, saved.attempts[1].snapshot!.attemptId);
    assert.equal(next.starts, 1);
    assert.equal(f.questionCount(), 0);
  } finally {
    first.stop();
    await f.close();
  }
});
test(
  "should refuse poll absence mismatched abandoned proof and current authority loss without new provider starts",
  { timeout: 15000 },
  async () => {
    for (const invalid of [
      "poll-null",
      "different-attempt",
      "different-fence",
      "different-payload",
      "non-abandoned",
      "revoked",
      "epoch",
    ]) {
      const f = await runnerFixture();
      try {
        const before = await claimedCrash(f),
          id = before.attempts[0].claimOperationId!;
        if (invalid !== "poll-null") f.expireUnstarted();
        f.faults.after = async (action, body, result) => {
          if (invalid === "poll-null" && action === "poll")
            (result as { attempt: unknown }).attempt = null;
          if (action !== "claim" || body.operationId !== id) return;
          const proof = result as AttemptSnapshot;
          if (invalid === "different-attempt") proof.attemptId = uuid();
          if (invalid === "different-fence") proof.fence++;
          if (invalid === "different-payload") proof.payload.publicText = "SYNTHETIC_OTHER_PAYLOAD";
          if (invalid === "non-abandoned") proof.state = "LEASED";
        };
        if (invalid === "revoked") f.faults.revoked = true;
        if (invalid === "epoch") f.epoch(2);
        const next = new SyntheticAdapter(),
          run = f.runner(next).run({ once: true });
        if (["poll-null", "non-abandoned"].includes(invalid))
          assert.equal((await run).state, "UNKNOWN");
        else
          await assert.rejects(run, { code: invalid === "epoch" ? "CONFLICT" : "AUTHORITY_LOST" });
        const after = (await f.store.read())!;
        assert.equal(after.attempts.length, 1);
        assert.equal(after.attempts[0].state, "UNKNOWN");
        assert.equal(after.attempts[0].unstartedClosure, undefined);
        assert.deepEqual(after.attempts[0].snapshot, before.attempts[0].snapshot);
        assert.equal(next.starts, 0);
        assert.equal(
          f.requests.some((r) => r.action === "start-intent"),
          false,
        );
      } finally {
        await f.close();
      }
    }
  },
);
test("should refuse local untransmitted closure after revocation or profile epoch change", async () => {
  for (const invalid of ["revoked", "epoch"]) {
    const f = await runnerFixture();
    try {
      f.queue();
      await f
        .runner(f.adapter, {
          beforeMutation: async (kind) => {
            if (kind === "operation-intent" && (await f.store.read())!.attempts.length)
              throw new RuntimeError("UNKNOWN");
          },
        })
        .run({ once: true });
      if (invalid === "revoked") f.faults.revoked = true;
      else {
        const profile = (await f.profile.read())!;
        profile.mappings[0].bindingEpoch = 2;
        await f.profile.write(profile);
      }
      const next = new SyntheticAdapter();
      await assert.rejects(f.runner(next).run({ once: true }), { code: "AUTHORITY_LOST" });
      assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
      assert.equal((await f.store.read())!.attempts[0].unstartedClosure, undefined);
      assert.equal(next.starts, 0);
    } finally {
      await f.close();
    }
  }
});
test("should retain server start and provider intent ambiguity and reject late old acknowledgements", async () => {
  for (const crash of ["provider-intent", "native-ack"]) {
    const f = await runnerFixture();
    try {
      f.queue();
      await f
        .runner(f.adapter, {
          beforeMutation: async (kind) => {
            if (kind === crash) throw new RuntimeError("UNKNOWN");
          },
        })
        .run({ once: true });
      const before = (await f.store.read())!;
      assert.equal(before.attempts[0].state, "UNKNOWN");
      assert.ok(before.attempts[0].snapshot?.startIntentAt);
      const claimCount = f.requests.filter((r) => r.action === "claim").length,
        next = new SyntheticAdapter();
      assert.equal((await f.runner(next).run({ once: true })).state, "UNKNOWN");
      assert.equal(next.starts, 0);
      assert.equal(f.requests.filter((r) => r.action === "claim").length, claimCount);
      assert.deepEqual((await f.store.read())!.attempts[0], before.attempts[0]);
      if (f.adapter.current)
        await assert.rejects(f.adapter.current.ack(f.context.threadId, "SYNTHETIC_LATE_ACK"), {
          code: "RUNTIME_CLOSED",
        });
      assert.deepEqual((await f.store.read())!.attempts[0], before.attempts[0]);
    } finally {
      await f.close();
    }
  }
});
test("should preserve contradictory confirmed start evidence despite a null saved start timestamp", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    await f
      .runner(f.adapter, {
        beforeMutation: async (kind) => {
          if (kind === "provider-intent") throw new RuntimeError("UNKNOWN");
        },
      })
      .run({ once: true });
    const saved = (await f.store.read())!;
    saved.attempts[0].snapshot!.state = "LEASED";
    saved.attempts[0].snapshot!.startIntentAt = null;
    await assert.rejects(async () => f.store.write(saved), { code: "UNSAFE_STORAGE" });
    // A legacy contradictory snapshot must stay readable but can never authorize closure.
    await writeFile(f.store.file, JSON.stringify(saved), { mode: 0o600 });
    const calls = f.requests.length,
      next = new SyntheticAdapter();
    assert.equal((await f.runner(next).run({ once: true })).state, "UNKNOWN");
    assert.equal(next.starts, 0);
    assert.equal(
      f.requests.slice(calls).some((r) => ["claim", "start-intent", "lease"].includes(r.action)),
      false,
    );
    assert.equal((await f.store.read())!.attempts[0].unstartedClosure, undefined);
  } finally {
    await f.close();
  }
});
test("should associate only one original legacy claim operation and leave ambiguous legacy evidence unknown", async () => {
  for (const ambiguous of [false, true]) {
    const f = await runnerFixture();
    try {
      const legacy = await claimedCrash(f);
      delete legacy.attempts[0].claimOperationId;
      if (ambiguous) {
        const op = structuredClone(legacy.operations.find((o) => o.action === "claim")!);
        op.operationId = uuid();
        op.body.operationId = op.operationId;
        op.payloadHash = digest(stableJson({ action: op.action, body: op.body }));
        legacy.operations.push(op);
      }
      // Model a pre-upgrade v1 file; no runtime transition can erase an established claim identity.
      await writeFile(f.store.file, JSON.stringify(legacy), { mode: 0o600 });
      f.expireUnstarted();
      const next = new SyntheticAdapter(),
        result = await f.runner(next).run({ once: true }),
        saved = (await f.store.read())!;
      assert.equal(result.state, ambiguous ? "UNKNOWN" : "UPLOADED");
      assert.equal(next.starts, ambiguous ? 0 : 1);
      assert.equal(
        saved.attempts[0].claimOperationId,
        ambiguous ? undefined : legacy.operations.find((o) => o.action === "claim")!.operationId,
      );
      if (ambiguous) assert.deepEqual(saved.attempts[0], legacy.attempts[0]);
    } finally {
      await f.close();
    }
  }
});
test("should mark an unresolved provider journal unknown after recovering a stale process lock", async () => {
  const f = await runnerFixture();
  let killed: Buffer | undefined;
  try {
    f.queue();
    await f
      .runner(f.adapter, {
        beforeMutation: async (kind) => {
          if (kind === "native-ack") {
            killed = await readFile(f.store.file);
            throw new RuntimeError("UNKNOWN");
          }
        },
      })
      .run({ once: true });
    assert.ok(killed);
    await writeFile(f.store.file, killed, { mode: 0o600 });
    await writeFile(
      join(f.store.dir, `${f.scope.agentId}.lock`),
      JSON.stringify({ pid: 2147483647, token: uuid(), identity: digest(f.store.file) }),
      { mode: 0o600 },
    );
    const next = new SyntheticAdapter();
    assert.equal((await f.runner(next).run({ once: true })).state, "UNKNOWN");
    const saved = (await f.store.read())!;
    assert.equal(saved.ready, false);
    assert.equal(saved.attempts[0].state, "UNKNOWN");
    assert.equal(saved.attempts[0].reason, "UNKNOWN");
    assert.equal(next.starts, 0);
    assert.equal(saved.attempts[0].unstartedClosure, undefined);
  } finally {
    await f.close();
  }
});
test(
  "should bound original profile transaction with a real held lock under frozen backward wall time",
  { timeout: 10000 },
  async (t) => {
    const now = 1790848000000;
    t.mock.timers.enable({ apis: ["Date"], now });
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred();
    let cancelled = false;
    const held = f.profile.locked(async () => {
      entered.resolve();
      await release.promise;
    });
    let backward: ReturnType<typeof setTimeout> | undefined,
      watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      const started = performance.now();
      const job = f.profile.transaction(
        async () => {
          assert.fail("SYNTHETIC_LOCK_MUST_REFUSE");
        },
        () => {
          if (cancelled) throw new RuntimeError("RUNTIME_CLOSED");
        },
      );
      const rejected = assert.rejects(job, { code: "FORBIDDEN" });
      backward = setTimeout(() => t.mock.timers.setTime(now - 60000), 500);
      watchdog = setTimeout(() => {
        cancelled = true;
      }, 3000);
      await rejected;
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 1900 && elapsed < 2800, "SYNTHETIC_TRANSACTION_NOT_BOUNDED");
      assert.equal(f.requests.length, 0);
      assert.equal(f.adapter.starts, 0);
    } finally {
      clearTimeout(backward);
      clearTimeout(watchdog);
      cancelled = true;
      release.resolve();
      await held;
      await f.close();
    }
  },
);
test(
  "should close runner admission while the original profile transaction waits for its real lock",
  { timeout: 10000 },
  async () => {
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred(),
      runtime = f.runner();
    let released = false;
    const held = f.profile.locked(async () => {
      entered.resolve();
      await release.promise;
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined,
      stop: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      const job = runtime.run({ once: true }),
        rejected = assert.rejects(job, { code: "RUNTIME_CLOSED" });
      stop = setTimeout(() => runtime.stop(), 100);
      watchdog = setTimeout(() => {
        released = true;
        release.resolve();
      }, 750);
      await rejected;
      assert.equal(released, false);
      assert.equal(f.requests.length, 0);
      assert.equal(f.adapter.starts, 0);
    } finally {
      clearTimeout(stop);
      clearTimeout(watchdog);
      runtime.stop();
      release.resolve();
      await held;
      await f.close();
    }
  },
);
test("should retain a created private descriptor after materialization failure without automatic restart promotion", async () => {
  for (const stage of ["thread/name/set", "thread/read"]) {
    const f = await runnerFixture(),
      p = new FakeProvider(),
      a = new CodexAdapter({ transportFactory: () => p });
    p.response = (method) => {
      if (method === stage) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    };
    try {
      const input = {
        choice: "default" as const,
        files: ["public.txt"],
        handoff: "Public handoff",
        confirmed: true,
        autoQuestionsConfirmed: true,
      };
      await assert.rejects(f.runner(a).prepare(input), { code: "CONTEXT_UNCONFIRMED" });
      const saved = (await f.store.read())!;
      assert.equal(saved.preparation?.state, "PROVIDER_CREATED");
      assert.equal(saved.preparation!.candidate!.threadId, p.thread.id);
      assert.equal(saved.ready, false);
      const calls = p.calls.length,
        restartProvider = new FakeProvider(),
        restart = f.runner(new CodexAdapter({ transportFactory: () => restartProvider }));
      await assert.rejects(restart.prepare(input), { code: "UNKNOWN" });
      assert.equal(restartProvider.calls.length, 0);
      assert.equal(p.calls.length, calls);
      assert.deepEqual(await f.store.read(), saved);
      const status = await restart.status();
      assert.equal(status.ready, false);
      const publicData = JSON.stringify({ status, requests: f.requests });
      assert.ok(!publicData.includes(String(p.thread.id)));
      assert.ok(!publicData.includes(f.root));
      assert.equal(
        f.requests.some(
          (r) => r.action === "replace" || (r.action === "ready" && r.body.reportedReady === true),
        ),
        false,
      );
    } finally {
      await a.close();
      await f.close();
    }
  }
});
test("should fsync the owned creation descriptor before naming and retain it through finalization", async () => {
  const f = await runnerFixture(),
    p = new FakeProvider(),
    a = new CodexAdapter({ transportFactory: () => p });
  let observed = 0;
  p.response = async (method) => {
    if (method !== "thread/name/set") return;
    const saved = (await f.store.read())!;
    assert.equal(saved.preparation?.state, "PROVIDER_CREATED");
    assert.equal(saved.ready, false);
    assert.equal(saved.preparation!.candidate!.threadId, p.thread.id);
    assert.equal(saved.preparation!.candidate!.level, "L1");
    assert.deepEqual(saved.preparation!.candidate!.ownedTurns, []);
    observed++;
  };
  try {
    const result = await f.runner(a).prepare({
      choice: "default",
      files: ["public.txt"],
      handoff: "Public handoff",
      confirmed: true,
      autoQuestionsConfirmed: true,
    });
    assert.equal(observed, 1);
    assert.equal(result.bindingEpoch, 2);
    assert.equal(result.ready, false);
    const saved = (await f.store.read())!;
    assert.equal(saved.preparation, null);
    assert.equal(saved.context!.threadId, p.thread.id);
    assert.equal(p.calls.filter((c) => c.method === "thread/start").length, 1);
    assert.equal(
      p.calls.some((c) => c.method === "turn/start"),
      false,
    );
  } finally {
    await a.close();
    await f.close();
  }
});
test("should refuse unobserved or altered successful preparation results without replacing the recorded descriptor", async (t) => {
  for (const changed of ["unobserved", "thread", "root", "epoch", "generation", "turns"]) {
    const f = await runnerFixture(),
      adapter = new SyntheticAdapter();
    const prepare: SyntheticAdapter["prepare"] = async (
      root,
      _settings,
      generation,
      epoch,
      check,
      onCreated,
    ) => {
      check();
      const context = {
        ...structuredClone(f.context),
        root,
        generation,
        epoch,
        threadId: "SYNTHETIC_CREATED",
      };
      if (changed !== "unobserved") await onCreated!(structuredClone(context));
      check();
      if (changed === "thread") context.threadId = "SYNTHETIC_ALTERED";
      if (changed === "root") context.root.ino++;
      if (changed === "epoch") context.epoch++;
      if (changed === "generation") context.generation = uuid();
      if (changed === "turns")
        context.ownedTurns.push({ turnId: "SYNTHETIC_EXTRA", terminal: "COMPLETED" });
      return context;
    };
    t.mock.method(adapter, "prepare", prepare);
    try {
      await assert.rejects(
        f.runner(adapter).prepare({
          choice: "default",
          files: ["public.txt"],
          handoff: "Public handoff",
          confirmed: true,
          autoQuestionsConfirmed: true,
        }),
        { code: "UNKNOWN" },
      );
      const saved = (await f.store.read())!;
      assert.equal(
        saved.preparation!.state,
        changed === "unobserved" ? "PROVIDER_PENDING" : "PROVIDER_CREATED",
      );
      if (changed === "unobserved") assert.equal(saved.preparation!.candidate, null);
      else {
        assert.equal(saved.preparation!.candidate!.threadId, "SYNTHETIC_CREATED");
        assert.equal(saved.preparation!.candidate!.root.ino, f.policy.root.ino);
        assert.deepEqual(saved.preparation!.candidate!.ownedTurns, []);
      }
      assert.equal(
        f.requests.some(
          (r) => r.action === "replace" || (r.action === "ready" && r.body.reportedReady === true),
        ),
        false,
      );
    } finally {
      await f.close();
    }
  }
});
test(
  "should prevent naming and late descriptor mutation when the durable creation observer fails or closes",
  { timeout: 10000 },
  async () => {
    for (const close of [false, true]) {
      const f = await runnerFixture(),
        p = new FakeProvider(),
        a = new CodexAdapter({ transportFactory: () => p }),
        entered = deferred(),
        release = deferred();
      const runtime = f.runner(a, {
        drainTimeoutMs: 10,
        beforeMutation: async (kind) => {
          if (kind === "prepare-created") {
            entered.resolve();
            await release.promise;
            if (!close) throw new RuntimeError("UNKNOWN");
          }
        },
      });
      const job = runtime.prepare({
        choice: "default",
        files: ["public.txt"],
        handoff: "Public handoff",
        confirmed: true,
        autoQuestionsConfirmed: true,
      });
      const rejected = assert.rejects(job, { code: close ? "RUNTIME_CLOSED" : "UNKNOWN" });
      try {
        await entered.promise;
        assert.equal((await f.store.read())!.preparation!.state, "PROVIDER_PENDING");
        assert.equal(
          p.calls.some((c) => c.method === "thread/name/set"),
          false,
        );
        if (close) runtime.stop();
        else release.resolve();
        await rejected;
        const bytes = await readFile(f.store.file);
        await f.store.sessionLocked(f.context.threadId, async () => {
          release.resolve();
          await new Promise((resolve) => setTimeout(resolve, 30));
          assert.deepEqual(await readFile(f.store.file), bytes);
        });
        assert.equal(
          p.calls.some((c) => c.method === "thread/name/set" || c.method === "turn/start"),
          false,
        );
        assert.equal((await f.store.read())!.preparation!.candidate, null);
      } finally {
        release.resolve();
        runtime.stop();
        await job.catch(() => {});
        await a.close();
        await f.close();
      }
    }
  },
);
test(
  "should recover a refused profile lock after a forward wall clock jump within the elapsed retry window",
  { timeout: 10000 },
  async (t) => {
    const now = 1790848000000;
    t.mock.timers.enable({ apis: ["Date"], now });
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred(),
      runtime = f.runner();
    const transaction = f.profile.transaction.bind(f.profile);
    let attempts = 0,
      refusals = 0;
    const held = f.profile.locked(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      t.mock.method(
        f.profile,
        "transaction",
        async <T>(run: () => Promise<T>, check?: () => void) => {
          attempts++;
          if (attempts !== 1) return transaction(run, check);
          // Surface a real StateStore lock refusal at the runner's transaction boundary.
          try {
            return await f.profile.locked(run);
          } catch (error) {
            if (!(error instanceof ConnectionError && error.code === "FORBIDDEN")) throw error;
            refusals++;
            t.mock.timers.setTime(now + 3000);
            release.resolve();
            await held;
            throw error;
          }
        },
      );
      const started = performance.now(),
        result = await runtime.run({ once: true });
      assert.ok(performance.now() - started < 2000, "SYNTHETIC_PROFILE_RECOVERY_TOO_SLOW");
      assert.equal(refusals, 1);
      assert.ok(attempts >= 2);
      assert.equal(result.ready, true);
      const saved = (await f.store.read())!;
      assert.equal(saved.context!.generation, f.context.generation);
      assert.equal(saved.attempts.length, 0);
      assert.ok(
        saved.operations.some(
          (o) => o.action === "ready" && o.state === "CONFIRMED" && o.body.reportedReady === true,
        ),
      );
      assert.equal(f.adapter.starts, 0);
      assert.ok(f.requests.some((r) => r.action === "poll"));
    } finally {
      release.resolve();
      await held;
      runtime.stop();
      await f.close();
    }
  },
);
test(
  "should bound refused profile lock retries while the wall clock is frozen and moves backward",
  { timeout: 10000 },
  async (t) => {
    const now = 1790848000000;
    t.mock.timers.enable({ apis: ["Date"], now });
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred(),
      runtime = f.runner();
    let attempts = 0,
      job: Promise<unknown> | undefined;
    const held = f.profile.locked(async () => {
      entered.resolve();
      await release.promise;
    });
    let backward: ReturnType<typeof setTimeout> | undefined,
      watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      t.mock.method(f.profile, "transaction", async <T>(run: () => Promise<T>) => {
        attempts++;
        return f.profile.locked(run);
      });
      const started = performance.now();
      job = runtime.run({ once: true });
      const rejected = assert.rejects(job, { code: "FORBIDDEN" });
      // Real timers bound the pre-fix infinite retry without granting profile authority.
      backward = setTimeout(() => t.mock.timers.setTime(now - 60000), 500);
      watchdog = setTimeout(() => runtime.stop(), 3000);
      await rejected;
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 1900 && elapsed < 2800, "SYNTHETIC_PROFILE_RETRY_NOT_BOUNDED");
      assert.equal(Date.now(), now - 60000);
      assert.ok(attempts >= 2);
      assert.equal(f.requests.length, 0);
      assert.equal(f.adapter.starts, 0);
    } finally {
      clearTimeout(backward);
      clearTimeout(watchdog);
      runtime.stop();
      release.resolve();
      await held;
      await job?.catch(() => {});
      await f.close();
    }
  },
);
test(
  "should distinguish advancing virtual time through an unsettled readiness receipt from elapsed I/O",
  { timeout: 10000 },
  async (t) => {
    const now = 1790848000000;
    t.mock.timers.enable({ apis: ["Date"], now });
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred(),
      receiptEntered = deferred(),
      receiptRelease = deferred();
    let held = false,
      waitingReceipt = false;
    const times: number[] = [];
    const runtime = f.runner(f.adapter, {
      pollIntervalMs: 5,
      beforeMutation: async (kind) => {
        if (kind === "operation-receipt" && waitingReceipt && !held) {
          held = true;
          receiptEntered.resolve();
          await receiptRelease.promise;
        }
      },
    });
    f.queue();
    f.adapter.executeHook = async () => {
      entered.resolve();
      await release.promise;
    };
    f.faults.before = async (action) => {
      if (action === "ready") {
        if (f.adapter.starts) {
          await waitForSynthetic(
            () => Date.parse(f.adapter.current!.attempt.leaseExpiresAt) >= Date.now() + 30000,
            "SYNTHETIC_DIAGNOSTIC_LEASE_NOT_SETTLED",
          );
          waitingReceipt = true;
        }
        times.push(Date.now());
      }
    };
    const run = runtime.run({ once: true });
    try {
      await entered.promise;
      t.mock.timers.setTime(now + 6000);
      await waitForSynthetic(
        () => Date.parse(f.adapter.current!.attempt.leaseExpiresAt) >= now + 36000,
        "SYNTHETIC_DIAGNOSTIC_LEASE_NOT_RENEWED",
      );
      t.mock.timers.setTime(now + 15000);
      await receiptEntered.promise;
      const realStart = performance.now();
      t.mock.timers.setTime(now + 36000);
      await new Promise((resolve) => setTimeout(resolve, 10));
      receiptRelease.resolve();
      try {
        await waitForSynthetic(() => times.length >= 3, "SYNTHETIC_DIAGNOSTIC_READY_NOT_RESUMED");
      } catch (error) {
        const saved = (await f.store.read())!;
        t.diagnostic(
          JSON.stringify({
            kind: "SYNTHETIC_UNSETTLED_CLOCK_FAILURE",
            times: times.map((time) => time - now),
            aborted: f.adapter.current!.signal.aborted,
            leaseRemaining: Date.parse(f.adapter.current!.attempt.leaseExpiresAt) - Date.now(),
            state: saved.attempts[0].state,
            reason: saved.attempts[0].reason,
            operations: saved.operations
              .slice(-5)
              .map((o) => ({ action: o.action, state: o.state })),
          }),
        );
        throw error;
      }
      const gap = times[2] - times[1],
        elapsed = performance.now() - realStart;
      assert.ok(gap > 20000);
      assert.ok(elapsed < 20000);
      assert.equal(f.adapter.current!.signal.aborted, false);
      t.diagnostic(
        JSON.stringify({
          kind: "SYNTHETIC_UNSETTLED_CLOCK_OBSERVATION",
          logicalGap: gap,
          realElapsedMs: Math.round(elapsed),
          unconfirmedReadyWhileClockAdvanced: true,
        }),
      );
      release.resolve();
      await run;
      assert.equal((await f.store.read())!.attempts[0].state, "UPLOADED");
    } finally {
      runtime.stop();
      receiptRelease.resolve();
      release.resolve();
      await run;
      await f.close();
    }
  },
);
for (const stage of ["pre-submit preparation", "provider execution", "terminal publication"]) {
  test(`should refresh durable readiness within twenty seconds during held ${stage}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 6000 }),
      entered = deferred(),
      release = deferred();
    let run: Promise<unknown> | undefined;
    const times: number[] = [];
    const runtime = f.runner();
    try {
      f.queue();
      f.faults.before = async (action) => {
        if (action === "ready") times.push(Date.now());
        if (stage === "terminal publication" && action === "complete") {
          entered.resolve();
          await release.promise;
        }
      };
      if (stage === "pre-submit preparation")
        f.adapter.validateHook = async () => {
          if (f.adapter.validates === 2) {
            entered.resolve();
            await release.promise;
          }
        };
      if (stage === "provider execution")
        f.adapter.executeHook = async () => {
          entered.resolve();
          await release.promise;
        };
      run = runtime.run({ once: true });
      await entered.promise;
      const start = Date.now();
      assert.equal(times.length, 1);
      // No logical time passes through unfinished real fsync/IPC. Keep all external cadence assertions.
      for (let elapsed = 3000; elapsed <= 75000; elapsed += 3000) {
        await settleRunnerJobs(runtime);
        const polls = f.requests.filter((r) => r.action === "poll").length;
        t.mock.timers.setTime(start + elapsed);
        await waitForSynthetic(
          () => f.requests.filter((r) => r.action === "poll").length > polls,
          "SYNTHETIC_CONTROL_POLL_NOT_SETTLED",
        );
        if (elapsed % 6000 === 0)
          await waitForSynthetic(
            () => Date.parse(f.adapter.current!.attempt.leaseExpiresAt) >= Date.now() + 30000,
            "SYNTHETIC_LEASE_CHECKPOINT_NOT_SETTLED",
          );
        if (elapsed % 15000 === 0)
          await waitForSynthetic(
            () => times.at(-1)! === Date.now(),
            "SYNTHETIC_READY_CHECKPOINT_NOT_SETTLED",
          );
        await settleRunnerJobs(runtime);
      }
      await waitForSynthetic(
        () => times.length >= 5 && times.at(-1)! >= Date.now() - 20000,
        "SYNTHETIC_ACTIVE_READY_NOT_REFRESHED",
      );
      assert.ok(times.slice(1).every((time, index) => time - times[index] <= 20000));
      assert.equal(f.adapter.current!.signal.aborted, false);
      await waitForSynthetic(async () => {
        const saved = await f.store.read().catch(() => undefined),
          latest = f.requests.filter((r) => r.action === "ready").at(-1)!;
        return (
          !!saved?.operations.some(
            (o) => o.operationId === latest.body.operationId && o.state === "CONFIRMED",
          ) && Date.parse(f.adapter.current!.attempt.leaseExpiresAt) > Date.now() + 15000
        );
      }, "SYNTHETIC_RENEWAL_NOT_DURABLE");
      assert.ok(f.requests.filter((r) => r.action === "lease").length >= 5);
      assert.ok(f.requests.filter((r) => r.action === "poll").length >= 25);
      if (stage === "pre-submit preparation") assert.equal(f.adapter.starts, 0);
      release.resolve();
      await run;
      const saved = (await f.store.read())!;
      assert.equal(saved.attempts[0].state, "UPLOADED");
      const receipts = saved.operations.filter(
        (o) => o.action === "ready" && o.state === "CONFIRMED",
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].body.reportedReady, true);
    } finally {
      release.resolve();
      await run;
      await f.close();
    }
  });
}
test("should keep lease and control cadence while recovering one in-flight ready operation after rotation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await runnerFixture({ pollIntervalMs: 5 }),
    providerEntered = deferred(),
    providerRelease = deferred(),
    readyEntered = deferred(),
    readyRelease = deferred();
  const runtime = f.runner();
  let run: Promise<unknown> | undefined,
    blocked = false;
  try {
    f.queue();
    f.adapter.terminal = "INTERRUPTED";
    f.adapter.executeHook = async () => {
      providerEntered.resolve();
      await providerRelease.promise;
    };
    f.faults.before = async (action) => {
      if (action === "ready" && f.adapter.starts && !blocked) {
        blocked = true;
        readyEntered.resolve();
        await readyRelease.promise;
      }
    };
    run = runtime.run({ once: true });
    await providerEntered.promise;
    const start = Date.now();
    t.mock.timers.setTime(start + 15000);
    await readyEntered.promise;
    const sent = f.requests.filter((r) => r.action === "ready").at(-1)!;
    await waitForSynthetic(
      () => Date.parse(f.adapter.current!.attempt.leaseExpiresAt) > Date.now() + 15000,
      "SYNTHETIC_LEASE_BLOCKED_BY_READY",
    );
    t.mock.timers.setTime(start + 21000);
    await waitForSynthetic(
      () => Date.parse(f.adapter.current!.attempt.leaseExpiresAt) > Date.now() + 15000,
      "SYNTHETIC_LEASE_NOT_RENEWED",
    );
    f.control();
    await waitForSynthetic(
      () => f.requests.some((r) => r.action === "interrupt-ack"),
      "SYNTHETIC_CONTROL_BLOCKED_BY_READY",
    );
    assert.equal(f.requests.filter((r) => r.action === "ready").length, 2);
    const currentKey = await f.rotate();
    readyRelease.resolve();
    await waitForSynthetic(
      async () =>
        (await f.store.read().catch(() => undefined))?.operations.some(
          (o) => o.operationId === sent.body.operationId && o.state === "CONFIRMED",
        ) ?? false,
      "SYNTHETIC_READY_ROTATION_NOT_RECOVERED",
    );
    const recovered = f.requests.filter(
      (r) => r.action === "ready" && r.body.operationId === sent.body.operationId,
    );
    assert.equal(recovered.length, 2);
    assert.deepEqual(recovered[0].body, recovered[1].body);
    assert.notEqual(recovered[0].secret, recovered[1].secret);
    assert.equal(recovered[1].secret, currentKey);
    providerRelease.resolve();
    await run;
    assert.equal((await f.store.read())!.attempts[0].state, "UPLOADED");
  } finally {
    runtime.stop();
    readyRelease.resolve();
    providerRelease.resolve();
    await run;
    await f.close();
  }
});
for (const loss of ["closure", "revocation", "pause"]) {
  test(`should permanently close late readiness receipts after ${loss}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await runnerFixture({ pollIntervalMs: 5, drainTimeoutMs: 10 }),
      entered = deferred(),
      release = deferred(),
      readyEntered = deferred(),
      readyRelease = deferred();
    const runtime = f.runner();
    let run: Promise<unknown> | undefined,
      blocked = false;
    try {
      f.queue();
      f.adapter.executeHook = async () => {
        entered.resolve();
        await release.promise;
      };
      f.faults.after = async (action) => {
        if (action === "ready" && f.adapter.starts && !blocked) {
          blocked = true;
          readyEntered.resolve();
          await readyRelease.promise;
        }
      };
      run = runtime.run({ once: true });
      await entered.promise;
      t.mock.timers.setTime(Date.now() + 15000);
      await readyEntered.promise;
      const pending = f.requests.filter((r) => r.action === "ready").at(-1)!;
      if (loss === "closure") runtime.stop();
      else if (loss === "revocation") f.faults.revoked = true;
      else f.mode("PAUSED");
      await waitForSynthetic(
        () => f.adapter.current!.signal.aborted,
        "SYNTHETIC_READY_LOSS_NOT_CLOSED",
      );
      release.resolve();
      await run;
      const saved = (await f.store.read())!;
      assert.equal(saved.ready, false);
      assert.equal(saved.attempts[0].state, "UNKNOWN");
      assert.equal(
        saved.operations.find((o) => o.operationId === pending.body.operationId)!.state,
        "TRANSMITTED",
      );
      const bytes = await readFile(f.store.file),
        count = f.requests.filter((r) => r.action === "ready").length;
      await f.store.sessionLocked(f.context.threadId, async () => {
        readyRelease.resolve();
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.deepEqual(await readFile(f.store.file), bytes);
      });
      assert.equal(f.requests.filter((r) => r.action === "ready").length, count);
    } finally {
      runtime.stop();
      readyRelease.resolve();
      release.resolve();
      await run;
      await f.close();
    }
  });
}
test("should share the ready schedule across active completion and the outer idle loop", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await runnerFixture({ pollIntervalMs: 5 }),
    entered = deferred(),
    release = deferred();
  const runtime = f.runner();
  let run: Promise<unknown> | undefined;
  try {
    f.queue();
    f.adapter.executeHook = async () => {
      entered.resolve();
      await release.promise;
    };
    run = runtime.run();
    const finished = run.catch((error) => {
      assert.equal(error.code, "RUNTIME_CLOSED");
    });
    await entered.promise;
    t.mock.timers.setTime(Date.now() + 15000);
    await waitForSynthetic(
      async () =>
        (await f.store.read().catch(() => undefined))?.operations.some(
          (o) =>
            o.action === "ready" &&
            o.state === "CONFIRMED" &&
            o.operationId !== f.requests.find((r) => r.action === "ready")!.body.operationId,
        ) ?? false,
      "SYNTHETIC_SHARED_READY_NOT_REFRESHED",
    );
    release.resolve();
    await waitForSynthetic(
      async () => (await f.store.read().catch(() => undefined))?.attempts[0].state === "UPLOADED",
      "SYNTHETIC_ACTIVE_COMPLETION_NOT_UPLOADED",
    );
    const polls = f.requests.filter((r) => r.action === "poll").length;
    await waitForSynthetic(
      () => f.requests.filter((r) => r.action === "poll").length >= polls + 2,
      "SYNTHETIC_IDLE_LOOP_NOT_RESUMED",
    );
    assert.equal(f.requests.filter((r) => r.action === "ready").length, 2);
    runtime.stop();
    await finished;
  } finally {
    runtime.stop();
    release.resolve();
    await run?.catch(() => {});
    await f.close();
  }
});
test("should never report ready true when the initial confirmed scope is paused", async () => {
  const f = await runnerFixture();
  try {
    f.mode("PAUSED");
    const result = await f.runner().run({ once: true });
    assert.equal(result.ready, false);
    assert.equal(f.adapter.starts, 0);
    assert.ok(f.requests.some((r) => r.action === "ready"));
    assert.ok(
      f.requests.filter((r) => r.action === "ready").every((r) => r.body.reportedReady === false),
    );
  } finally {
    await f.close();
  }
});
test("should refuse stale active poll permission after a concurrent pause observation", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await runnerFixture({ pollIntervalMs: 5 }),
    entered = deferred(),
    release = deferred(),
    oldPoll = deferred(),
    pollRelease = deferred(),
    pauseSeen = deferred();
  const runtime = f.runner();
  let run: Promise<unknown> | undefined,
    delayed = false,
    due = Infinity;
  try {
    f.queue();
    f.adapter.terminal = "INTERRUPTED";
    f.adapter.executeHook = async () => {
      entered.resolve();
      await release.promise;
    };
    f.faults.after = async (action, _body, result) => {
      if (action !== "poll") return;
      const mode = (result as { roomMode: string }).roomMode;
      if (Date.now() >= due && mode === "ACTIVE" && !delayed) {
        delayed = true;
        oldPoll.resolve();
        await pollRelease.promise;
      } else if (mode === "PAUSING") pauseSeen.resolve();
    };
    run = runtime.run({ once: true });
    await entered.promise;
    due = Date.now() + 15000;
    t.mock.timers.setTime(due);
    await oldPoll.promise;
    f.mode("PAUSING");
    f.control();
    await pauseSeen.promise;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const count = f.requests.filter(
      (r) => r.action === "ready" && r.body.reportedReady === true,
    ).length;
    pollRelease.resolve();
    await waitForSynthetic(
      () => f.requests.some((r) => r.action === "ready" && r.body.reportedReady === false),
      "SYNTHETIC_PAUSED_READY_NOT_RECORDED",
    );
    await waitForSynthetic(
      () => f.requests.some((r) => r.action === "interrupt-ack"),
      "SYNTHETIC_PAUSED_CONTROL_NOT_ACKNOWLEDGED",
    );
    assert.equal(
      f.requests.filter((r) => r.action === "ready" && r.body.reportedReady === true).length,
      count,
    );
    assert.equal(f.adapter.current!.signal.aborted, false);
    release.resolve();
    await run;
    assert.equal((await f.store.read())!.attempts[0].terminal?.terminal, "INTERRUPTED");
  } finally {
    runtime.stop();
    pollRelease.resolve();
    release.resolve();
    await run;
    await f.close();
  }
});

test("should continue idle readiness at journal capacity while retaining the latest ready receipt", async () => {
  const f = await runnerFixture();
  try {
    for (let i = 0; i < 1024; i++) {
      const operationId = uuid(),
        body = {
          protocol: 1,
          agentId: f.scope.agentId,
          bindingEpoch: 1,
          operationId,
          reportedReady: true,
        };
      f.record.operations.push({
        operationId,
        action: "ready",
        body,
        payloadHash: digest(stableJson({ action: "ready", body })),
        state: "CONFIRMED",
        result: {
          agentId: f.scope.agentId,
          bindingEpoch: 1,
          reportedReady: true,
          validUntil: new Date(Date.now() + 60000).toISOString(),
          verification: "reported",
        },
      });
    }
    await f.store.write(f.record);
    for (let i = 0; i < 4; i++) {
      const before = (await f.store.read())!.operations.at(-1)!;
      f.faults.before = async (action) => {
        if (action === "ready")
          assert.deepEqual(
            (await f.store.read())!.operations.find((o) => o.operationId === before.operationId),
            before,
          );
      };
      await f.runner(new SyntheticAdapter()).run({ once: true });
      const saved = (await f.store.read())!,
        latest = f.requests.filter((r) => r.action === "ready").at(-1)!;
      assert.equal(saved.operations.length, 1);
      const receipt = saved.operations.find((o) => o.operationId === latest.body.operationId)!;
      assert.equal(receipt.state, "CONFIRMED");
      assert.deepEqual(receipt.body, latest.body);
      assert.equal((receipt.result as { reportedReady: boolean }).reportedReady, i > 0);
    }
  } finally {
    await f.close();
  }
});
test("should retain transmitted readiness after receipt persistence failure and recover the same operation", async () => {
  const f = await runnerFixture();
  try {
    const operationId = uuid(),
      body = {
        protocol: 1,
        agentId: f.scope.agentId,
        bindingEpoch: 1,
        operationId,
        reportedReady: false,
      };
    const previousReceipt = {
      operationId,
      action: "ready" as const,
      body,
      payloadHash: digest(stableJson({ action: "ready", body })),
      state: "CONFIRMED" as const,
      result: {
        agentId: f.scope.agentId,
        bindingEpoch: 1,
        reportedReady: false,
        validUntil: null,
        verification: "reported",
      },
    };
    f.record.operations.push(previousReceipt);
    await f.store.write(f.record);
    let fail = true;
    await assert.rejects(
      f
        .runner(f.adapter, {
          beforeMutation: async (kind) => {
            if (kind === "operation-receipt" && fail) {
              fail = false;
              throw new Error("SYNTHETIC_RECEIPT_FAILURE");
            }
          },
        })
        .run({ once: true }),
    );
    const before = (await f.store.read())!,
      pending = before.operations.find((o) => o.action === "ready" && o.state === "TRANSMITTED")!;
    assert.deepEqual(
      before.operations.find((o) => o.operationId === previousReceipt.operationId),
      previousReceipt,
    );
    assert.equal(pending.state, "TRANSMITTED");
    assert.equal(pending.result, null);
    f.faults.before = async (action, body) => {
      if (action === "ready" && body.operationId === pending.operationId) {
        const saved = (await f.store.read())!;
        assert.deepEqual(
          saved.operations.find((o) => o.operationId === pending.operationId),
          pending,
        );
        assert.deepEqual(
          saved.operations.find((o) => o.operationId === previousReceipt.operationId),
          previousReceipt,
        );
      }
    };
    await f.runner(new SyntheticAdapter()).run({ once: true });
    const retries = f.requests.filter(
      (r) => r.action === "ready" && r.body.operationId === pending.operationId,
    );
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0].body, retries[1].body);
    const saved = (await f.store.read())!,
      latest = f.requests.filter((r) => r.action === "ready").at(-1)!;
    assert.equal(saved.operations.length, 1);
    assert.equal(saved.operations[0].operationId, latest.body.operationId);
    assert.equal(saved.operations[0].state, "CONFIRMED");
  } finally {
    await f.close();
  }
});

test("should persist central and local intent before invoking a provider once", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.adapter.executeHook = async () => {
      const record = (await f.store.read())!;
      assert.equal(record.attempts[0].state, "ACKNOWLEDGED");
      assert.ok(
        record.operations.some((o) => o.action === "start-intent" && o.state === "CONFIRMED"),
      );
    };
    const result = await f.runner().run({ once: true });
    assert.equal(result.state, "UPLOADED");
    assert.equal(f.adapter.starts, 1);
    const a = (await f.store.read())!.attempts[0];
    assert.equal(a.receipt?.adoption, "ACCEPTED");
    assert.equal(a.terminal?.publicText, "Selected public conclusion.");
  } finally {
    await f.close();
  }
});
test("should finalize a prepared context after an idempotent epoch replacement", async () => {
  const f = await runnerFixture();
  try {
    let fail = true;
    const first = f.runner(f.adapter, {
      beforeMutation: async (kind) => {
        if (kind === "prepare-finalize" && fail) {
          fail = false;
          throw new Error("SYNTHETIC_CRASH");
        }
      },
    });
    await assert.rejects(
      first.prepare({
        choice: "default",
        files: ["public.txt"],
        handoff: "Public handoff",
        confirmed: true,
        autoQuestionsConfirmed: true,
      }),
    );
    const before = (await f.store.read())!;
    assert.equal(before.preparation?.state, "REPLACE_PENDING");
    const candidate = before.preparation!.candidate!;
    const nextAdapter = new SyntheticAdapter();
    const result = await f.runner(nextAdapter).prepare({
      choice: "default",
      files: [],
      handoff: "different input cannot replace pending intent",
      confirmed: true,
      autoQuestionsConfirmed: false,
    });
    assert.equal(result.bindingEpoch, 2);
    assert.equal(nextAdapter.prepares, 0);
    const saved = (await f.store.read())!;
    assert.equal(saved.context?.threadId, candidate.threadId);
    assert.equal(saved.preparation, null);
    assert.equal(f.requests.filter((r) => r.action === "replace").length, 1);
  } finally {
    await f.close();
  }
});
test("should reject tool callbacks outside the acknowledged live attempt", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.adapter.executeHook = async (authority) => {
      const a = (await f.store.read())!.attempts[0];
      await assert.rejects(authority.tool(callback(authority, "other-turn")), {
        code: "TOOL_REJECTED",
      });
      await assert.rejects(
        authority.tool({ ...callback(authority, a.native!.turnId), namespace: "other" }),
        { code: "TOOL_REJECTED" },
      );
      const result = await authority.tool(
        callback(
          authority,
          a.native!.turnId,
          "read_workspace_file",
          { path: "public.txt" },
          "read",
        ),
      );
      assert.equal(result.success, true);
    };
    await f.runner().run({ once: true });
    assert.equal(f.questionCount(), 0);
    const saved = f.adapter.current!;
    await assert.rejects(saved.tool(callback(saved, "stale")));
  } finally {
    await f.close();
  }
});
test("should deduplicate tool rpc ids and call ids without duplicating peer questions", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.adapter.executeHook = async (authority) => {
      const turn = (await f.store.read())!.attempts[0].native!.turnId;
      const call = callback(authority, turn);
      const [one, two] = await Promise.all([authority.tool(call), authority.tool(call)]);
      assert.deepEqual(one, two);
      assert.equal(one.contentItems[0].text, "accepted/pending");
      await assert.rejects(
        authority.tool({
          ...call,
          arguments: {
            question: "different",
            evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
          },
        }),
        { code: "TOOL_REJECTED" },
      );
    };
    await f.runner().run({ once: true });
    assert.equal(f.questionCount(), 1);
  } finally {
    await f.close();
  }
});
test("should continue leases and controls while preparation or provider execution waits", async () => {
  const f = await runnerFixture({ pollIntervalMs: 15, leaseIntervalMs: 15 });
  try {
    const held = deferred(),
      admitted = deferred();
    f.queue();
    f.adapter.validateHook = async () => {
      if (f.adapter.validates === 2) {
        admitted.resolve();
        await held.promise;
      }
    };
    const run = f.runner().run({ once: true });
    await admitted.promise;
    for (let i = 0; i < 100 && !f.requests.some((r) => r.action === "lease"); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(f.requests.some((r) => r.action === "lease"));
    assert.equal(f.adapter.starts, 0);
    held.resolve();
    await run;
    assert.equal(f.adapter.starts, 1);
  } finally {
    await f.close();
  }
});
test("should use rotated credentials without holding the profile lock for a whole run", async () => {
  const f = await runnerFixture({ pollIntervalMs: 15, leaseIntervalMs: 15 });
  try {
    const admitted = deferred(),
      held = deferred();
    f.queue();
    f.adapter.executeHook = async () => {
      admitted.resolve();
      await held.promise;
    };
    const run = f.runner().run({ once: true });
    await admitted.promise;
    const old = (await f.profile.read())!.credential;
    const next = await f.rotate();
    assert.notEqual(old, next);
    const status = await f.profile.transaction(() => f.connector.status());
    assert.equal(status.state, "registered");
    held.resolve();
    const result = await run;
    assert.equal(result.state, "UPLOADED");
    assert.ok(f.requests.some((r) => r.action === "complete" && r.secret === next));
  } finally {
    await f.close();
  }
});
test("should acknowledge interrupt delivery separately from terminal completion", async () => {
  const f = await runnerFixture({ pollIntervalMs: 10, leaseIntervalMs: 10 });
  try {
    const held = deferred(),
      admitted = deferred();
    f.queue();
    f.adapter.executeHook = async () => {
      admitted.resolve();
      await held.promise;
    };
    const run = f.runner().run({ once: true });
    await admitted.promise;
    f.control();
    for (let i = 0; i < 150 && !f.requests.some((r) => r.action === "interrupt-ack"); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(f.requests.some((r) => r.action === "interrupt-ack"));
    assert.equal((await f.store.read())!.attempts[0].terminal, null);
    f.adapter.terminal = "INTERRUPTED";
    held.resolve();
    await run;
    assert.equal((await f.store.read())!.attempts[0].terminal?.terminal, "INTERRUPTED");
  } finally {
    await f.close();
  }
});
test("should stop tool admission after scope lease or connection loss", async () => {
  const f = await runnerFixture({ pollIntervalMs: 10, leaseIntervalMs: 10 });
  try {
    const held = deferred(),
      admitted = deferred();
    f.queue();
    f.adapter.executeHook = async (authority) => {
      admitted.resolve();
      await held.promise;
      await assert.rejects(authority.tool(callback(authority, "late")));
    };
    const run = f.runner().run({ once: true });
    await admitted.promise;
    f.faults.revoked = true;
    for (let i = 0; i < 100 && !f.adapter.current!.signal.aborted; i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.adapter.current!.signal.aborted, true);
    held.resolve();
    await run;
    assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
    assert.equal(f.questionCount(), 0);
  } finally {
    await f.close();
  }
});
test("should persist terminal evidence before retrying publication", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    let lost = true;
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "complete" && lost) {
        lost = false;
        response.destroy();
        return true;
      }
    };
    const first = await f.runner().run({ once: true });
    assert.equal(first.state, "TERMINAL");
    const saved = (await f.store.read())!;
    assert.equal(saved.attempts[0].terminal?.textProof, "FINAL_ANSWER");
    const operation = saved.operations.find((o) => o.action === "complete")!;
    assert.equal(operation.state, "TRANSMITTED");
    const next = new SyntheticAdapter();
    const result = await f.runner(next).run({ once: true });
    assert.equal(result.state, "UPLOADED");
    assert.equal(next.starts, 0);
    const sent = f.requests.filter((r) => r.action === "complete");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body, sent[1].body);
  } finally {
    await f.close();
  }
});
for (const stage of ["in-flight", "new"]) {
  test(
    `should preserve exact terminal publication when a ${stage} lease conflicts after central completion`,
    { timeout: 10000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1790848000000 });
      const f = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 6000 });
      const providerEntered = deferred(),
        providerRelease = deferred(),
        leaseEntered = deferred(),
        leaseRelease = deferred(),
        committed = deferred(),
        responseRelease = deferred(),
        conflict = deferred(),
        pollEntered = deferred(),
        pollRelease = deferred();
      const runtime = f.runner();
      let run: Promise<unknown> | undefined,
        heldPoll = false;
      const call = runtime.client.call.bind(runtime.client);
      t.mock.method(runtime.client, "call", async (...args: Parameters<typeof call>) => {
        try {
          const result = await call(...args);
          if (stage === "new" && args[0] === "poll" && f.adapter.starts && !heldPoll) {
            heldPoll = true;
            pollEntered.resolve();
            await pollRelease.promise;
          }
          return result;
        } catch (error) {
          if (args[0] === "lease" && error instanceof WorkflowError && error.code === "CONFLICT")
            conflict.resolve();
          throw error;
        }
      });
      try {
        f.queue();
        f.adapter.executeHook = async () => {
          providerEntered.resolve();
          await providerRelease.promise;
        };
        f.faults.before = async (action) => {
          if (action === "lease" && stage === "in-flight") {
            leaseEntered.resolve();
            await leaseRelease.promise;
          }
        };
        f.faults.after = async (action) => {
          if (action === "complete") {
            committed.resolve();
            await responseRelease.promise;
          }
        };
        run = runtime.run({ once: true });
        await providerEntered.promise;
        if (stage === "in-flight") {
          t.mock.timers.setTime(Date.now() + 7000);
          await leaseEntered.promise;
        } else await pollEntered.promise;
        providerRelease.resolve();
        await committed.promise;
        assert.equal(f.poll().attempt?.state, "COMPLETED");
        const before = (await f.store.read())!;
        assert.equal(before.attempts[0].state, "TERMINAL");
        assert.equal(before.attempts[0].receipt, null);
        assert.equal(
          before.operations.find((op) => op.action === "complete")!.state,
          "TRANSMITTED",
        );
        if (stage === "new") {
          t.mock.timers.setTime(Date.now() + 7000);
          pollRelease.resolve();
        } else leaseRelease.resolve();
        await conflict.promise;
        responseRelease.resolve();
        const result = (await run) as { state: string };
        assert.equal(result.state, "UPLOADED");
        const saved = (await f.store.read())!,
          attempt = saved.attempts[0];
        assert.equal(attempt.terminal?.textProof, "FINAL_ANSWER");
        assert.equal(attempt.receipt?.attemptId, attempt.snapshot!.attemptId);
        assert.equal(attempt.receipt?.terminal, "COMPLETED");
        const complete = saved.operations.find((op) => op.action === "complete")!,
          lease = saved.operations.find((op) => op.action === "lease")!;
        assert.equal(complete.state, "CONFIRMED");
        assert.deepEqual(complete.result, attempt.receipt);
        assert.equal(lease.state, "CLOSED");
        assert.equal(lease.result, null);
        assert.equal(f.requests.filter((request) => request.action === "complete").length, 1);
        assert.equal(f.adapter.starts, 1);
        await assert.rejects(
          f.adapter.current!.tool(callback(f.adapter.current!, attempt.native!.turnId)),
          { code: "RUNTIME_CLOSED" },
        );
        assert.equal(f.questionCount(), 0);
      } finally {
        runtime.stop();
        providerRelease.resolve();
        leaseRelease.resolve();
        responseRelease.resolve();
        pollRelease.resolve();
        await run?.catch(() => {});
        await f.close();
      }
    },
  );
}
for (const outcome of ["persisted", "stopped", "failed"]) {
  test(
    `should close terminal renewal work before a delayed receipt mutation is ${outcome}`,
    { timeout: 10000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1790848000000 });
      const f = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 6000 }),
        providerEntered = deferred(),
        providerRelease = deferred(),
        leaseEntered = deferred(),
        leaseRelease = deferred(),
        receiptEntered = deferred(),
        receiptRelease = deferred(),
        conflict = deferred();
      let held = false,
        run: Promise<unknown> | undefined;
      const runtime = f.runner(f.adapter, {
        pollIntervalMs: 5,
        leaseIntervalMs: 6000,
        drainTimeoutMs: 10,
        beforeMutation: async (kind) => {
          if (
            kind === "operation-receipt" &&
            !held &&
            (await f.store.read())!.operations.some((op) => op.action === "complete")
          ) {
            held = true;
            receiptEntered.resolve();
            await receiptRelease.promise;
            if (outcome === "failed") throw new RuntimeError("UNKNOWN");
          }
        },
      });
      const call = runtime.client.call.bind(runtime.client);
      t.mock.method(runtime.client, "call", async (...args: Parameters<typeof call>) => {
        try {
          return await call(...args);
        } catch (error) {
          if (args[0] === "lease" && error instanceof WorkflowError && error.code === "CONFLICT")
            conflict.resolve();
          throw error;
        }
      });
      try {
        f.queue();
        f.adapter.executeHook = async () => {
          providerEntered.resolve();
          await providerRelease.promise;
        };
        f.faults.before = async (action) => {
          if (action === "lease") {
            leaseEntered.resolve();
            await leaseRelease.promise;
          }
        };
        run = runtime.run({ once: true });
        await providerEntered.promise;
        t.mock.timers.setTime(Date.now() + 7000);
        await leaseEntered.promise;
        providerRelease.resolve();
        await receiptEntered.promise;
        assert.equal(
          (await f.store.read())!.operations.find((op) => op.action === "complete")!.state,
          "TRANSMITTED",
        );
        leaseRelease.resolve();
        await conflict.promise;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(f.adapter.current!.signal.aborted, false);
        assert.equal(f.requests.filter((request) => request.action === "lease").length, 1);
        if (outcome === "stopped") runtime.stop();
        receiptRelease.resolve();
        await run;
        const saved = (await f.store.read())!,
          bytes = await readFile(f.store.file);
        assert.equal(saved.attempts[0].state, outcome === "persisted" ? "UPLOADED" : "TERMINAL");
        assert.equal(
          saved.operations.find((op) => op.action === "complete")!.state,
          outcome === "persisted" ? "CONFIRMED" : "TRANSMITTED",
        );
        assert.equal(saved.attempts[0].receipt !== null, outcome === "persisted");
        assert.equal(f.adapter.starts, 1);
        await f.store.sessionLocked(f.context.threadId, async () => {
          receiptRelease.resolve();
          await new Promise((resolve) => setTimeout(resolve, 25));
          assert.deepEqual(await readFile(f.store.file), bytes);
        });
      } finally {
        runtime.stop();
        providerRelease.resolve();
        leaseRelease.resolve();
        receiptRelease.resolve();
        await run?.catch(() => {});
        await f.close();
      }
    },
  );
}
for (const outcome of ["lost", "mismatched", "expired", "revoked"]) {
  test(
    `should retain terminal intent without adoption when a competing lease conflict has a ${outcome} publication`,
    { timeout: 10000 },
    async (t) => {
      t.mock.timers.enable({ apis: ["Date"], now: 1790848000000 });
      const f = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 6000 }),
        providerEntered = deferred(),
        providerRelease = deferred(),
        leaseEntered = deferred(),
        leaseRelease = deferred(),
        committed = deferred(),
        responseRelease = deferred(),
        conflict = deferred();
      const runtime = f.runner();
      let run: Promise<unknown> | undefined;
      const call = runtime.client.call.bind(runtime.client);
      t.mock.method(runtime.client, "call", async (...args: Parameters<typeof call>) => {
        try {
          return await call(...args);
        } catch (error) {
          if (args[0] === "lease" && error instanceof WorkflowError && error.code === "CONFLICT")
            conflict.resolve();
          throw error;
        }
      });
      try {
        f.queue();
        f.adapter.executeHook = async () => {
          providerEntered.resolve();
          await providerRelease.promise;
        };
        f.faults.before = async (action) => {
          if (action === "lease") {
            leaseEntered.resolve();
            await leaseRelease.promise;
          }
        };
        f.faults.after = async (action, _body, result, response) => {
          if (action === "complete") {
            committed.resolve();
            await responseRelease.promise;
            if (outcome === "lost") response.destroy();
            if (outcome === "mismatched") (result as { attemptId: string }).attemptId = uuid();
          }
        };
        run = runtime.run({ once: true });
        await providerEntered.promise;
        t.mock.timers.setTime(Date.now() + 7000);
        await leaseEntered.promise;
        providerRelease.resolve();
        await committed.promise;
        leaseRelease.resolve();
        await conflict.promise;
        if (outcome === "expired") t.mock.timers.setTime(Date.now() + 30000);
        if (outcome === "revoked") {
          f.faults.revoked = true;
          t.mock.timers.setTime(Date.now() + 15000);
          await waitForSynthetic(
            () => f.adapter.current!.signal.aborted,
            "SYNTHETIC_TERMINAL_REVOCATION_NOT_CLOSED",
          );
        }
        responseRelease.resolve();
        await run;
        const saved = (await f.store.read())!;
        assert.equal(saved.attempts[0].state, "TERMINAL");
        assert.equal(saved.attempts[0].receipt, null);
        assert.equal(saved.ready, false);
        assert.equal(saved.operations.find((op) => op.action === "complete")!.state, "TRANSMITTED");
        assert.equal(saved.operations.find((op) => op.action === "lease")!.state, "TRANSMITTED");
        assert.equal(f.adapter.starts, 1);
        await assert.rejects(
          f.adapter.current!.tool(callback(f.adapter.current!, saved.attempts[0].native!.turnId)),
          { code: "RUNTIME_CLOSED" },
        );
        if (outcome === "lost") {
          f.faults.after = undefined;
          const recovered = await f.runner(new SyntheticAdapter()).run({ once: true });
          assert.equal(recovered.state, "UPLOADED");
          const sent = f.requests.filter((request) => request.action === "complete");
          assert.equal(sent.length, 2);
          assert.deepEqual(sent[0].body, sent[1].body);
          assert.equal(f.adapter.starts, 1);
        }
      } finally {
        runtime.stop();
        providerRelease.resolve();
        leaseRelease.resolve();
        responseRelease.resolve();
        await run?.catch(() => {});
        await f.close();
      }
    },
  );
}
test("should keep unknown attempts blocked until matching read-only terminal evidence arrives", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.adapter.executeHook = async () => {
      throw new Error("SYNTHETIC_ACK_FAILURE");
    };
    await f.runner().run({ once: true });
    f.unknown();
    const saved = (await f.store.read())!,
      a = saved.attempts[0];
    assert.equal(a.state, "UNKNOWN");
    const next = new SyntheticAdapter();
    await f.runner(next).run({ once: true });
    assert.equal(next.starts, 0);
    next.observed = {
      threadId: "other",
      turnId: a.native!.turnId,
      terminal: "COMPLETED",
      privateText: "public",
      publicText: "",
      finalItems: [],
      textProof: "UNCONFIRMED",
      observation: observation(f.settings),
    };
    await assert.rejects(f.runner(next).observe());
    assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
    const observed = new SyntheticAdapter();
    observed.observed = { ...next.observed, threadId: a.native!.threadId };
    const result = await f.runner(observed).observe();
    assert.equal(result.state, "UPLOADED");
    assert.equal(observed.starts, 0);
    assert.equal(observed.validates, 0);
    assert.equal(f.requests.filter((r) => r.action === "observe").length, 1);
  } finally {
    await f.close();
  }
});
test("should revoke only resolved local runtime with expired credentials without weakening execution authority", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    assert.equal((await f.runner().run({ once: true })).state, "UPLOADED");
    const state = (await f.profile.read())!;
    state.status = "disconnected";
    state.credentialExpiresAt = new Date(Date.now() - 1000).toISOString();
    await f.profile.transaction(() => f.profile.write(state));
    const profile = await readFile(f.profile.file),
      calls = f.requests.length,
      adapter = new SyntheticAdapter();
    let closes = 0;
    adapter.close = async () => {
      closes++;
    };
    await assert.rejects(f.runner(adapter).run({ once: true }), { code: "AUTHORITY_LOST" });
    assert.equal((await f.runner(new SyntheticAdapter()).removeLocal()).state, "removed");
    assert.equal(await f.store.read(), undefined);
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.requests.length, calls);
    assert.equal(adapter.starts, 0);
    // The execution refusal still closes its own adapter; local deletion admits no provider callbacks.
    assert.equal(closes, 1);
  } finally {
    await f.close();
  }
});
test("should locally remove an immutable proof-closed unstarted journal despite an expired credential", async () => {
  const f = await runnerFixture();
  try {
    await claimedCrash(f);
    f.expireUnstarted();
    await assert.rejects(
      f
        .runner(new SyntheticAdapter(), {
          beforeMutation: async (kind) => {
            if (kind === "claim-intent") throw new RuntimeError("UNKNOWN");
          },
        })
        .run({ once: true }),
      { code: "UNKNOWN" },
    );
    const record = (await f.store.read())!;
    assert.equal(record.attempts[0].state, "NOT_STARTED");
    assert.equal(record.attempts.length, 1);
    assert.equal(record.attempts[0].unstartedClosure?.kind, "SERVER_ABANDONED");
    const state = (await f.profile.read())!;
    state.credentialExpiresAt = new Date(Date.now() - 1000).toISOString();
    await f.profile.transaction(() => f.profile.write(state));
    const calls = f.requests.length,
      adapter = new SyntheticAdapter();
    await f.runner(adapter).removeLocal();
    assert.equal(await f.store.read(), undefined);
    assert.equal(f.requests.length, calls);
    assert.equal(adapter.starts, 0);
    assert.equal(adapter.closed, false);
    assert.ok(await f.profile.read());
  } finally {
    await f.close();
  }
});
test(
  "should permanently refuse late local removal after closure and preserve replacement storage",
  { timeout: 10000 },
  async () => {
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred(),
      adapter = new SyntheticAdapter();
    let closes = 0,
      late: (() => Promise<void>) | undefined;
    adapter.close = async () => {
      closes++;
    };
    const runtime = f.runner(adapter);
    try {
      f.queue();
      await f.runner().run({ once: true });
      const profile = await readFile(f.profile.file),
        record = await readFile(f.store.file),
        calls = f.requests.length;
      const removal = runtime.guardLocalRemoval(async (proof) => {
        late = proof.remove;
        entered.resolve();
        await release.promise;
        await proof.remove();
      });
      void removal.catch(() => {});
      await entered.promise;
      runtime.stop();
      release.resolve();
      await assert.rejects(removal, { code: "RUNTIME_CLOSED" });
      assert.deepEqual(await readFile(f.profile.file), profile);
      assert.deepEqual(await readFile(f.store.file), record);
      await f.runner(new SyntheticAdapter()).removeLocal();
      await f.store.write({
        ...structuredClone(f.record),
        context: { ...f.context, generation: uuid(), threadId: uuid() },
      });
      const replacement = await readFile(f.store.file);
      await assert.rejects(async () => late!(), { code: "RUNTIME_CLOSED" });
      assert.deepEqual(await readFile(f.store.file), replacement);
      assert.equal(closes, 0);
      assert.equal(adapter.validates, 0);
      assert.equal(adapter.interrupts, 0);
      assert.equal(f.requests.length, calls);
    } finally {
      runtime.stop();
      release.resolve();
      await f.close();
    }
  },
);
test("should reject local unlink after closure during its final secure storage read", async (t) => {
  const f = await runnerFixture(),
    entered = deferred(),
    release = deferred(),
    runtime = f.runner(new SyntheticAdapter());
  try {
    f.queue();
    await f.runner().run({ once: true });
    const bytes = await readFile(f.store.file),
      profile = await readFile(f.profile.file);
    const original = f.store.read.bind(f.store);
    let reads = 0;
    const readMock = t.mock.method(f.store, "read", async () => {
      const record = await original();
      if (++reads === 4) {
        entered.resolve();
        await release.promise;
      }
      return record;
    });
    const removal = runtime.guardLocalRemoval((proof) => proof.remove());
    void removal.catch(() => {});
    await entered.promise;
    runtime.stop();
    release.resolve();
    await assert.rejects(removal, { code: "RUNTIME_CLOSED" });
    readMock.mock.restore();
    assert.ok(await original(), "SYNTHETIC_RESOLVED_RUNTIME_REMOVED_AFTER_CLOSURE");
    assert.deepEqual(await readFile(f.store.file), bytes);
    assert.deepEqual(await readFile(f.profile.file), profile);
  } finally {
    runtime.stop();
    release.resolve();
    await f.close();
  }
});
test("should retain binding and session locks until admitted local removal reads finish", async (t) => {
  const f = await runnerFixture(),
    entered = deferred(),
    release = deferred(),
    runtime = f.runner(new SyntheticAdapter());
  try {
    f.queue();
    await f.runner().run({ once: true });
    const bytes = await readFile(f.store.file),
      original = f.store.read.bind(f.store);
    let reads = 0;
    const readMock = t.mock.method(f.store, "read", async () => {
      const record = await original();
      if (++reads === 4) {
        entered.resolve();
        await release.promise;
      }
      return record;
    });
    const removal = runtime.guardLocalRemoval(async (proof) => {
      void proof.remove().catch(() => {});
      await entered.promise;
      return true;
    });
    await entered.promise;
    await assert.rejects(
      f.store.locked(async () => {}),
      { code: "RUNTIME_BUSY" },
    );
    await assert.rejects(
      f.store.sessionLocked(f.context.threadId, async () => {}),
      { code: "RUNTIME_BUSY" },
    );
    runtime.stop();
    release.resolve();
    await removal;
    readMock.mock.restore();
    assert.deepEqual(await readFile(f.store.file), bytes);
    await f.store.locked(async () => {
      await f.store.sessionLocked(f.context.threadId, async () => {});
    });
  } finally {
    runtime.stop();
    release.resolve();
    await f.close();
  }
});
test("should refuse final local file identity drift and a foreign runtime profile", async (t) => {
  const f = await runnerFixture();
  try {
    f.queue();
    await f.runner().run({ once: true });
    const profile = await readFile(f.profile.file),
      bytes = await readFile(f.store.file),
      original = f.store.read.bind(f.store);
    let reads = 0;
    const readMock = t.mock.method(f.store, "read", async () => {
      const record = await original();
      if (++reads === 4) {
        const replacement = `${f.store.file}.synthetic-replacement`;
        await writeFile(replacement, bytes, { mode: 0o600 });
        await rename(replacement, f.store.file);
      }
      return record;
    });
    await assert.rejects(
      f.runner(new SyntheticAdapter()).guardLocalRemoval((proof) => proof.remove()),
      { code: "UNSAFE_STORAGE" },
    );
    readMock.mock.restore();
    assert.deepEqual(await readFile(f.store.file), bytes);
    assert.deepEqual(await readFile(f.profile.file), profile);
    const wrong = f.runner(new SyntheticAdapter());
    Object.defineProperty(wrong, "store", {
      value: new RuntimeStore(f.stateDir, "foreign-profile", f.scope.agentId),
    });
    await assert.rejects(wrong.removeLocal(), { code: "UNSAFE_STORAGE" });
    assert.deepEqual(await readFile(f.profile.file), profile);
  } finally {
    await f.close();
  }
});
test("should revalidate profile and immutable runtime proof after an awaited local removal callback", async () => {
  for (const changed of ["profile", "runtime"]) {
    const f = await runnerFixture(),
      entered = deferred(),
      release = deferred(),
      adapter = new SyntheticAdapter();
    const runtime = f.runner(adapter);
    try {
      f.queue();
      await f.runner().run({ once: true });
      const calls = f.requests.length;
      const removal = runtime.guardLocalRemoval(async (proof) => {
        entered.resolve();
        await release.promise;
        await proof.remove();
      });
      void removal.catch(() => {});
      await entered.promise;
      if (changed === "profile") {
        const state = (await f.profile.read())!;
        state.deviceId = uuid();
        await f.profile.transaction(() => f.profile.write(state));
      } else {
        const record = (await f.store.read())!,
          operationId = uuid(),
          body = {
            protocol: 1,
            operationId,
            agentId: f.scope.agentId,
            bindingEpoch: 1,
            reportedReady: false,
          };
        record.operations.push({
          operationId,
          action: "ready",
          body,
          payloadHash: digest(stableJson({ action: "ready", body })),
          state: "PENDING",
          result: null,
        });
        await f.store.write(record);
      }
      const profile = await readFile(f.profile.file),
        record = await readFile(f.store.file);
      release.resolve();
      await assert.rejects(removal, { code: "AUTHORITY_LOST" });
      assert.deepEqual(await readFile(f.profile.file), profile);
      assert.deepEqual(await readFile(f.store.file), record);
      assert.equal(f.requests.length, calls);
      assert.equal(adapter.closed, false);
    } finally {
      runtime.stop();
      release.resolve();
      await f.close();
    }
  }
});
test("should guard local removal while the original profile transaction waits and reject an active consumer", async () => {
  const f = await runnerFixture(),
    entered = deferred(),
    release = deferred(),
    adapter = new SyntheticAdapter();
  const runtime = f.runner(adapter);
  try {
    f.queue();
    await f.runner().run({ once: true });
    const profile = await readFile(f.profile.file),
      record = await readFile(f.store.file),
      calls = f.requests.length;
    const lock = f.profile.locked(async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const removal = runtime.removeLocal();
    void removal.catch(() => {});
    await waitForSynthetic(
      () => (runtime as unknown as { lockHeld: boolean }).lockHeld,
      "SYNTHETIC_LOCAL_REMOVAL_NOT_LOCKED",
    );
    runtime.stop();
    await assert.rejects(removal, { code: "RUNTIME_CLOSED" });
    release.resolve();
    await lock;
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.deepEqual(await readFile(f.store.file), record);
    assert.equal(f.requests.length, calls);
    f.queue();
    const activeEntered = deferred(),
      activeRelease = deferred();
    f.adapter.executeHook = async () => {
      activeEntered.resolve();
      await activeRelease.promise;
    };
    const run = f.runner().run({ once: true });
    try {
      await activeEntered.promise;
      await assert.rejects(f.runner(new SyntheticAdapter()).removeLocal(), {
        code: "RUNTIME_BUSY",
      });
      assert.deepEqual(await readFile(f.profile.file), profile);
    } finally {
      activeRelease.resolve();
      await run;
    }
  } finally {
    runtime.stop();
    release.resolve();
    await f.close();
  }
});
test("should refuse replacement or local deletion while runtime evidence is unresolved", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    await assert.rejects(f.runner().assertReplaceable(), { code: "RUNTIME_BUSY" });
    f.adapter.executeHook = async () => {
      throw new Error("SYNTHETIC_PROVIDER_FAILURE");
    };
    await f.runner().run({ once: true });
    await assert.rejects(f.runner(new SyntheticAdapter()).removeLocal(), { code: "RUNTIME_BUSY" });
    assert.ok(await f.profile.read());
  } finally {
    await f.close();
  }
});
test("should preserve authority error priority for local removal with unresolved evidence", async () => {
  for (const mismatch of ["scope", "context"]) {
    const f = await runnerFixture();
    try {
      f.queue();
      f.adapter.executeHook = async () => {
        throw new Error("SYNTHETIC_PROVIDER_FAILURE");
      };
      await f.runner().run({ once: true });
      assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
      const originalProfile = await readFile(f.profile.file),
        record = await readFile(f.store.file);
      await assert.rejects(f.runner(new SyntheticAdapter()).removeLocal(), {
        code: "RUNTIME_BUSY",
      });
      assert.deepEqual(await readFile(f.profile.file), originalProfile);
      assert.deepEqual(await readFile(f.store.file), record);
      const state = (await f.profile.read())!;
      if (mismatch === "scope") state.deviceId = uuid();
      else state.mappings[0].nativeSessionId = uuid();
      await f.profile.transaction(() => f.profile.write(state));
      const profile = await readFile(f.profile.file),
        calls = f.requests.length,
        adapter = new SyntheticAdapter();
      await assert.rejects(f.runner(adapter).removeLocal(), { code: "AUTHORITY_LOST" });
      assert.deepEqual(await readFile(f.profile.file), profile);
      assert.deepEqual(await readFile(f.store.file), record);
      assert.equal(f.requests.length, calls);
      assert.equal(adapter.starts, 0);
      assert.equal(adapter.prepares, 0);
      assert.equal(adapter.validates, 0);
      assert.equal(adapter.interrupts, 0);
      assert.equal(adapter.closed, false);
    } finally {
      await f.close();
    }
  }
});
test("should remove a valid local mapping without a saved runtime", async () => {
  const f = await runnerFixture();
  try {
    const profile = await readFile(f.profile.file),
      calls = f.requests.length,
      adapter = new SyntheticAdapter(),
      result = { state: "removed", agentId: f.scope.agentId };
    await unlink(f.store.file);
    await assert.rejects(readFile(f.store.file), { code: "ENOENT" });
    assert.equal(await f.store.read(), undefined);
    let mutations = 0;
    const removed = await f.runner(adapter).guardLocalRemoval(async (proof) => {
      mutations++;
      proof.check();
      await proof.validate();
      await proof.remove();
      proof.check();
      return result;
    });
    assert.equal(removed, result);
    assert.equal(mutations, 1);
    await assert.rejects(readFile(f.store.file), { code: "ENOENT" });
    assert.equal(await f.store.read(), undefined);
    assert.deepEqual(await readFile(f.profile.file), profile);
    assert.equal(f.requests.length, calls);
    assert.equal(adapter.starts, 0);
    assert.equal(adapter.prepares, 0);
    assert.equal(adapter.validates, 0);
    assert.equal(adapter.interrupts, 0);
    assert.equal(adapter.closed, false);
  } finally {
    await f.close();
  }
});
test("should refuse a second local removal using the same proof", async () => {
  const f = await runnerFixture();
  try {
    const independent = await runnerFixture();
    try {
      const profile = await readFile(f.profile.file),
        independentProfile = await readFile(independent.profile.file),
        independentRecord = await readFile(independent.store.file),
        calls = f.requests.length,
        independentCalls = independent.requests.length,
        adapter = new SyntheticAdapter();
      assert.ok(await f.store.read());
      await f.runner(adapter).guardLocalRemoval(async (proof) => {
        await proof.remove();
        await assert.rejects(readFile(f.store.file), { code: "ENOENT" });
        await assert.rejects(proof.remove(), { code: "RUNTIME_CLOSED" });
        proof.check();
      });
      await assert.rejects(readFile(f.store.file), { code: "ENOENT" });
      assert.equal(await f.store.read(), undefined);
      assert.deepEqual(await readFile(f.profile.file), profile);
      assert.deepEqual(await readFile(independent.profile.file), independentProfile);
      assert.deepEqual(await readFile(independent.store.file), independentRecord);
      assert.equal(f.requests.length, calls);
      assert.equal(independent.requests.length, independentCalls);
      assert.equal(adapter.starts, 0);
      assert.equal(adapter.prepares, 0);
      assert.equal(adapter.validates, 0);
      assert.equal(adapter.interrupts, 0);
      assert.equal(adapter.closed, false);
    } finally {
      await independent.close();
    }
  } finally {
    await f.close();
  }
});
test("should journal shutdown and reap only the owned provider process", async () => {
  const f = await runnerFixture();
  try {
    const held = deferred(),
      admitted = deferred(),
      cancel = new AbortController();
    f.queue();
    f.adapter.executeHook = async () => {
      admitted.resolve();
      await held.promise;
    };
    const run = f.runner().run({ once: true, signal: cancel.signal });
    await admitted.promise;
    cancel.abort();
    held.resolve();
    await run;
    assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
    assert.ok(f.adapter.closed);
    assert.ok(f.adapter.interrupts > 0);
  } finally {
    await f.close();
  }
});
test("should retry in-flight workflow operations with the same payload after credential rotation", async (t) => {
  for (const target of ["poll", "lease", "complete"]) {
    const f = await runnerFixture({ pollIntervalMs: 10, leaseIntervalMs: 10 });
    try {
      f.queue();
      const old = (await f.profile.read())!.credential!;
      const request = deferred(),
        release = deferred();
      let delayed = false;
      f.faults.before = async (action, _body, secret) => {
        if (
          action === target &&
          secret === old &&
          !delayed &&
          (target !== "poll" || f.adapter.starts > 0)
        ) {
          delayed = true;
          request.resolve();
          await release.promise;
        }
      };
      if (target !== "complete")
        f.adapter.executeHook = async () => {
          await request.promise;
          await release.promise;
          await new Promise((r) => setTimeout(r, 50));
        };
      let lostRotation = true;
      f.faults.after = async (action, _body, _result, response) => {
        if (action === "rotate" && lostRotation) {
          lostRotation = false;
          response.destroy();
          return true;
        }
      };
      const runtime = f.runner(),
        run = runtime.run({ once: true });
      await request.promise;
      await assert.rejects(f.rotate());
      const rotation = (await f.profile.read())!.pending!;
      assert.equal(rotation.action, "rotate");
      release.resolve();
      const result = await run;
      if (result.state !== "UPLOADED") {
        const saved = (await f.store.read())!;
        t.diagnostic(
          JSON.stringify({
            kind: "SYNTHETIC_ROTATION_PUBLICATION_FAILURE",
            target,
            state: result.state,
            lossReason: (runtime as unknown as { lossReason: string | null }).lossReason,
            operations: saved.operations.map((o) => ({
              action: o.action,
              state: o.state,
              receipt: o.result !== null,
            })),
          }),
        );
      }
      assert.equal(result.state, "UPLOADED");
      const next = (await f.profile.read())!.credential!;
      const rotations = f.requests.filter((r) => r.action === "rotate");
      assert.equal(rotations.length, 2);
      assert.deepEqual(rotations[0].body, rotations[1].body);
      assert.equal(rotations[1].body.operationId, rotation.body.operationId);
      const sent = f.requests.filter((r) => r.action === target),
        first = sent.findIndex(
          (r) => r.secret === old && (target !== "poll" || sent.some((r) => r.secret === next)),
        );
      assert.ok(sent.some((r) => r.secret === next));
      const current = sent.find((r) => r.secret === next)!;
      assert.ok(sent.some((r) => r.secret === old && sameBody(r.body, current.body)));
      assert.ok(first >= 0);
    } finally {
      await f.close();
    }
  }
});
function sameBody(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
test("should drain or permanently close admitted asynchronous work before releasing runtime locks", async () => {
  const f = await runnerFixture({ drainTimeoutMs: 10 });
  try {
    const admitted = deferred(),
      release = deferred();
    f.queue();
    const runtime = f.runner(f.adapter, {
      drainTimeoutMs: 10,
      beforeMutation: async (kind) => {
        if (kind === "question-call-intent") {
          admitted.resolve();
          await release.promise;
        }
      },
    });
    f.adapter.executeHook = async (authority) => {
      const a = (await f.store.read())!.attempts[0];
      await authority.tool(callback(authority, a.native!.turnId));
    };
    const run = runtime.run({ once: true });
    await admitted.promise;
    runtime.stop();
    release.resolve();
    await run;
    assert.equal(f.questionCount(), 0);
    const saved = (await f.store.read())!;
    assert.equal(saved.attempts[0].state, "UNKNOWN");
    assert.equal(saved.attempts[0].toolCalls.length, 0);
    await f.store.sessionLocked(f.context.threadId, async () => {
      assert.ok(true);
    });
    const admission = new RuntimeAdmission(),
      late = deferred(),
      entered = deferred();
    const job = admission.track(async () => {
      entered.resolve();
      await late.promise;
      admission.assert();
    });
    await entered.promise;
    admission.close();
    assert.equal(await admission.drain(1), false);
    late.resolve();
    await assert.rejects(job);
    assert.equal(await admission.drain(10), true);
    const other = new RuntimeStore(f.stateDir, "two", uuid());
    await other.sessionLocked(f.context.threadId, async () => {});
  } finally {
    await f.close();
  }
});

test("should permanently close late native acknowledgements and preserve transmitted question receipts", async () => {
  for (const stage of ["native-ack", "question-response"]) {
    const f = await runnerFixture();
    const entered = deferred(),
      release = deferred();
    try {
      f.queue();
      const runtime = f.runner(f.adapter, {
        drainTimeoutMs: 10,
        beforeMutation: async (kind) => {
          if (stage === "native-ack" && kind === "native-ack") {
            entered.resolve();
            await release.promise;
          }
        },
      });
      if (stage === "question-response") {
        f.adapter.executeHook = async (authority) => {
          const a = (await f.store.read())!.attempts[0];
          await authority.tool(callback(authority, a.native!.turnId));
        };
        f.faults.after = async (action) => {
          if (action === "question") {
            entered.resolve();
            await release.promise;
          }
        };
      }
      const run = runtime.run({ once: true });
      await entered.promise;
      runtime.stop();
      await run;
      const saved = (await f.store.read())!;
      assert.equal(saved.attempts[0].state, "UNKNOWN");
      if (stage === "native-ack") assert.equal(saved.attempts[0].native, null);
      else {
        assert.equal(f.questionCount(), 1);
        assert.equal(saved.operations.find((o) => o.action === "question")?.state, "TRANSMITTED");
      }
      const before = await readFile(f.store.file);
      await f.store.sessionLocked(f.context.threadId, async () => {
        release.resolve();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(await readFile(f.store.file), before);
      });
      if (stage === "question-response") {
        await f.runner(new SyntheticAdapter()).run({ once: true });
        assert.equal(f.questionCount(), 1);
        assert.equal(
          (await f.store.read())!.operations.find((o) => o.action === "question")?.state,
          "CONFIRMED",
        );
      }
    } finally {
      release.resolve();
      await f.close();
    }
  }
});

test("should invalidate owned authority after a guarded arbitrary native mapping replacement", async () => {
  const f = await runnerFixture();
  try {
    await f.runner().guardMutation(() =>
      f.profile.transaction(() =>
        f.connector.replace({
          agentId: f.scope.agentId,
          root: f.root,
          nativeSessionId: "unverified-external-session",
          repositoryAlias: "Synthetic repository",
          sessionAlias: "Synthetic session",
          confirmed: true,
          metadata: {
            repositoryAlias: "Synthetic repository",
            branch: "unknown",
            commit: "unknown",
            dirty: "unknown",
          },
        }),
      ),
    );
    const record = (await f.store.read())!;
    assert.equal(record.scope.bindingEpoch, 2);
    assert.equal(record.context, null);
    assert.equal(record.settings, null);
    const adapter = new SyntheticAdapter();
    await assert.rejects(f.runner(adapter).run({ once: true }), { code: "CONTEXT_UNCONFIRMED" });
    assert.equal(adapter.starts, 0);
    const prepared = await f.runner(new SyntheticAdapter()).prepare({
      choice: "default",
      files: ["public.txt"],
      handoff: "Public confirmation",
      confirmed: true,
      autoQuestionsConfirmed: true,
    });
    assert.equal(prepared.bindingEpoch, 3);
    assert.notEqual((await f.store.read())!.context?.threadId, "unverified-external-session");
  } finally {
    await f.close();
  }
});

test("should publish a completed turn near the operation bound without repeating provider execution", async () => {
  for (const count of [1019, 1022]) {
    const f = await runnerFixture();
    try {
      f.queue();
      await f.runner().run({ once: true });
      const record = (await f.store.read())!;
      const prior = structuredClone(record.attempts[0]);
      while (record.operations.length < count) {
        const operationId = uuid();
        const body = {
          protocol: 1,
          agentId: f.scope.agentId,
          bindingEpoch: 1,
          operationId,
          requestId: prior.requestId,
          attemptId: prior.snapshot!.attemptId,
          fence: prior.snapshot!.fence,
        };
        record.operations.push({
          operationId,
          action: "lease",
          body,
          payloadHash: digest(stableJson({ action: "lease", body })),
          state: "CONFIRMED",
          result: structuredClone(prior.snapshot),
        });
      }
      await f.store.write(record);
      const payload = f.queue();
      const adapter = new SyntheticAdapter();
      await f.runner(adapter).run({ once: true });
      const after = (await f.store.read())!;
      assert.equal(adapter.starts, 1);
      assert.equal(
        after.attempts.find((a) => a.requestId === payload.requestId)?.state,
        "UPLOADED",
      );
      assert.equal(
        f.requests.filter((r) => r.action === "complete" && r.body.requestId === payload.requestId)
          .length,
        1,
      );
    } finally {
      await f.close();
    }
  }
});

test("should recover a full legacy terminal by archiving only completed request evidence", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    await f.runner().run({ once: true });
    f.queue();
    await f
      .runner(new SyntheticAdapter(), {
        beforeMutation: async (kind) => {
          if (
            kind === "operation-intent" &&
            (await f.store.read())!.attempts.at(-1)?.state === "TERMINAL"
          )
            throw new Error("SYNTHETIC_FULL_OUTBOX");
        },
      })
      .run({ once: true });
    const record = (await f.store.read())!;
    const terminal = structuredClone(record.attempts.at(-1)!);
    assert.equal(terminal.state, "TERMINAL");
    const old = record.attempts[0];
    while (record.operations.length < 1024) {
      const operationId = uuid();
      const body = {
        protocol: 1,
        agentId: f.scope.agentId,
        bindingEpoch: 1,
        operationId,
        requestId: old.requestId,
        attemptId: old.snapshot!.attemptId,
        fence: old.snapshot!.fence,
      };
      record.operations.push({
        operationId,
        action: "lease",
        body,
        payloadHash: digest(stableJson({ action: "lease", body })),
        state: "CONFIRMED",
        result: structuredClone(old.snapshot),
      });
    }
    await f.store.write(record);
    const original = await readFile(f.store.file);
    const adapter = new SyntheticAdapter();
    await f.runner(adapter).run({ once: true });
    const recovered = (await f.store.read())!;
    assert.equal(adapter.starts, 0);
    const uploaded = recovered.attempts.find((a) => a.requestId === terminal.requestId)!;
    assert.equal(uploaded.state, "UPLOADED");
    assert.deepEqual(uploaded.terminal, terminal.terminal);
    assert.deepEqual(uploaded.native, terminal.native);
    assert.deepEqual(
      await readFile(join(f.store.dir, "archives", f.scope.agentId, `${digest(original)}.json`)),
      original,
    );
  } finally {
    await f.close();
  }
});

test("should preserve the last public completion after idle journal compaction", async () => {
  const f = await runnerFixture();
  try {
    const seed = structuredClone(f.record);
    const older = appendFixtureCompletion(seed);
    const blocked = seed.operations.find((o) => o.body.requestId === older.requestId)!;
    blocked.state = "PENDING";
    blocked.result = null;
    const last = appendFixtureCompletion(seed);
    await writeFile(f.store.file, JSON.stringify(seed));
    const first = await f.store.compact(seed);
    assert.equal(first.attempts.length, 1);
    assert.equal((await f.store.lastAttempt(first))!.requestId, last.requestId);
    const closed = structuredClone(first);
    closed.operations.find((o) => o.operationId === blocked.operationId)!.state = "CLOSED";
    await f.store.write(closed);
    const second = await f.store.compact(closed);
    assert.deepEqual(second.lastArchive, first.lastArchive);
    assert.equal(second.attempts.length, 0);
    const adapter = new SyntheticAdapter();
    const runner = f.runner(adapter);
    const status = await runner.status();
    const idle = await runner.run({ once: true });
    for (const value of [status, idle]) {
      assert.equal(value.state, "UPLOADED");
      assert.ok("terminal" in value && "adoption" in value);
      assert.equal(value.terminal, last.terminal!.terminal);
      assert.equal(value.adoption, last.receipt!.adoption);
    }
    assert.equal(adapter.starts, 0);
    f.queue();
    const nextAdapter = new SyntheticAdapter();
    const current = await f.runner(nextAdapter).run({ once: true });
    assert.equal(nextAdapter.starts, 1);
    assert.equal(current.state, "UPLOADED");
    assert.equal((await f.store.read())!.lastArchive, undefined);
    assert.deepEqual(
      (await f.store.read())!.context!.ownedTurns.slice(0, 2),
      seed.context!.ownedTurns,
    );
  } finally {
    await f.close();
  }
});

test("should refuse provider input before attempt turn or serialized capacity exhaustion", async () => {
  for (const limit of [
    "attempt255",
    "attempt256",
    "turn255",
    "turn256",
    "bytes",
    "operations",
  ] as const) {
    const f = await runnerFixture();
    try {
      const record = structuredClone(f.record);
      if (limit.startsWith("attempt")) {
        const length = limit === "attempt255" ? 255 : 256;
        record.attempts = Array.from({ length }, () => {
          const claimOperationId = uuid();
          return {
            requestId: uuid(),
            scope: f.scope,
            generation: f.context.generation,
            claimOperationId,
            state: "NOT_STARTED",
            unstartedClosure: { kind: "LOCAL_NOT_TRANSMITTED", claimOperationId },
            snapshot: null,
            native: null,
            terminal: null,
            receipt: null,
            reason: null,
            toolCalls: [],
          };
        });
      }
      if (limit.startsWith("turn"))
        record.context!.ownedTurns = Array.from(
          { length: limit === "turn255" ? 255 : 256 },
          () => ({ turnId: uuid(), terminal: "COMPLETED" }),
        );
      if (limit === "bytes") record.settings!.handoff = "\u0001".repeat(65536);
      if (limit === "operations") {
        const done = appendFixtureCompletion(record, 1023);
        done.state = "TERMINAL";
        done.receipt = null;
      }
      await writeFile(f.store.file, JSON.stringify(record));
      f.queue();
      const adapter = new SyntheticAdapter();
      if (limit.endsWith("255")) {
        await f.runner(adapter).run({ once: true });
        assert.equal(adapter.starts, 1, limit);
      } else {
        await assert.rejects(
          f.runner(adapter).run({ once: true }),
          { code: "RUNTIME_CAPACITY" },
          limit,
        );
        assert.equal(adapter.starts, 0, limit);
      }
      assert.equal((await f.store.read())!.ready, false);
      if (limit === "turn256")
        assert.deepEqual((await f.store.read())!.context!.ownedTurns, record.context!.ownedTurns);
    } finally {
      await f.close();
    }
  }
});

test("should preserve exact peer outbox recovery and native history ownership", async () => {
  const f = await runnerFixture();
  try {
    f.queue("PEER");
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "complete") response.destroy();
    };
    const first = new SyntheticAdapter();
    await f.runner(first).run({ once: true });
    const before = (await f.store.read())!;
    assert.equal(first.starts, 1);
    assert.equal(before.attempts.at(-1)!.state, "TERMINAL");
    const original = before.operations.find((o) => o.action === "complete")!;
    f.faults.after = undefined;
    const second = new SyntheticAdapter();
    await f.runner(second).run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(second.starts, 0);
    const retry = f.requests.filter(
      (r) => r.action === "complete" && r.body.operationId === original.operationId,
    );
    assert.ok(retry.length >= 2);
    retry.forEach((request) => assert.deepEqual(request.body, original.body));
    assert.deepEqual(after.context!.ownedTurns, before.context!.ownedTurns);
    assert.deepEqual(after.attempts.at(-1)!.native, before.attempts.at(-1)!.native);
    const compacted = await f.store.compact(after);
    assert.deepEqual(compacted.context!.ownedTurns, before.context!.ownedTurns);
    assert.deepEqual(
      (await f.store.lastAttempt(compacted))!.terminal,
      before.attempts.at(-1)!.terminal,
    );
  } finally {
    await f.close();
  }
});

test("should stop repeated file callbacks before their results consume terminal reserves", async () => {
  const f = await runnerFixture();
  try {
    await writeFile(join(f.root, "public.txt"), "x".repeat(65536));
    const policy = await RuntimeFilePolicy.select(f.root, ["public.txt"]);
    const record = (await f.store.read())!;
    record.settings!.files = [...policy.files];
    await f.store.write(record);
    let accepted = 0,
      rejected = 0;
    const adapter = new SyntheticAdapter();
    adapter.executeHook = async (authority) => {
      const native = (await f.store.read())!.attempts.at(-1)!.native!;
      for (let index = 0; index < 12; index++) {
        try {
          const result = await authority.tool(
            callback(
              authority,
              native.turnId,
              "read_workspace_file",
              { path: "public.txt" },
              `file-${index}`,
            ),
          );
          assert.equal(result.contentItems[0].text.length, 65536);
          accepted++;
        } catch (error) {
          assert.equal((error as RuntimeError).code, "RUNTIME_CAPACITY");
          rejected++;
          break;
        }
      }
    };
    f.queue();
    await f.runner(adapter).run({ once: true });
    const after = (await f.store.read())!;
    assert.ok(accepted > 0 && rejected === 1);
    assert.equal(after.attempts.at(-1)!.toolCalls.length, accepted);
    assert.equal(after.attempts.at(-1)!.state, "UPLOADED");
    assert.equal(adapter.starts, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(after)) < 2 * 1024 * 1024);
  } finally {
    await f.close();
  }
});

test("should refuse provider admission at the archive reference bound without discarding evidence", async () => {
  const f = await runnerFixture();
  try {
    let record = (await f.store.read())!;
    for (let index = 0; index < 64; index++) {
      delete record.lastArchive;
      appendFixtureCompletion(record);
      await writeFile(f.store.file, JSON.stringify(record));
      record = await f.store.compact(record);
    }
    const references = structuredClone(record.archives);
    f.queue();
    const adapter = new SyntheticAdapter();
    await assert.rejects(f.runner(adapter).run({ once: true }), { code: "RUNTIME_CAPACITY" });
    assert.equal(adapter.starts, 0);
    const after = (await f.store.read())!;
    assert.equal(after.ready, false);
    assert.deepEqual(after.archives, references);
    assert.equal(after.context!.ownedTurns.length, 64);
  } finally {
    await f.close();
  }
});

test("should retain maximum escaped terminal evidence while a reserved lease response is in flight", async () => {
  const f = await runnerFixture();
  const leaseEntered = deferred(),
    releaseLease = deferred();
  try {
    const payload = f.queue("CONTINUATION");
    payload.publicText = "\u0001".repeat(4000);
    payload.replyText = "\u0001".repeat(4000);
    let leaseId: string | undefined;
    f.faults.before = async (action, body) => {
      if (action === "lease" && !leaseId) {
        leaseId = String(body.operationId);
        leaseEntered.resolve();
        await releaseLease.promise;
      }
      if (action === "complete") {
        assert.equal((await f.store.read())!.attempts.at(-1)!.state, "TERMINAL");
        releaseLease.resolve();
        await waitForSynthetic(
          async () =>
            (await f.store.read())!.operations.find((o) => o.operationId === leaseId)?.state ===
            "CONFIRMED",
          "reserved lease receipt must remain writable after the maximum terminal",
        );
      }
    };
    const adapter = new SyntheticAdapter();
    adapter.executeHook = async () => {
      await leaseEntered.promise;
    };
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => {
      const evidence = await execute(...args);
      const escaped = "\u0001".repeat(512);
      evidence.privateText = "\u0001".repeat(65536);
      evidence.finalItems = Array.from({ length: 256 }, () => ({
        id: escaped,
        hash: "a".repeat(64),
      }));
      evidence.observation = {
        requested: { model: escaped, effort: escaped },
        thread: { model: escaped, provider: escaped, effort: escaped },
        turn: {
          requestedModel: escaped,
          requestedEffort: escaped,
          model: escaped,
          rerouted: false,
          effortVerification: "UNVERIFIED",
        },
      };
      return evidence;
    };
    await f.runner(adapter, { pollIntervalMs: 5, leaseIntervalMs: 5 }).run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(adapter.starts, 1);
    assert.equal(after.attempts.at(-1)!.state, "UPLOADED");
    assert.equal(after.attempts.at(-1)!.terminal!.privateText.length, 65536);
    assert.equal(after.attempts.at(-1)!.terminal!.finalItems.length, 256);
    assert.ok(Buffer.byteLength(JSON.stringify(after)) < 2 * 1024 * 1024);
  } finally {
    releaseLease.resolve();
    await f.close();
  }
});

interface CapacityRunnerProbe {
  record: import("../src/runtime-contracts.ts").RuntimeRecord;
  lockHeld: boolean;
  capacityReservations: Map<string, number>;
  workflow(
    action: import("../src/workflow-contracts.ts").DeviceAction,
    body: import("../src/workflow-contracts.ts").Body,
  ): Promise<unknown>;
  operation(
    action: import("../src/workflow-contracts.ts").DeviceAction,
    fields: import("../src/workflow-contracts.ts").Body,
  ): Promise<import("../src/runtime-contracts.ts").RuntimeOperation>;
  transmit(
    operation: import("../src/runtime-contracts.ts").RuntimeOperation,
    guard?: () => void,
  ): Promise<unknown>;
  mutate(
    kind: string,
    update: (record: import("../src/runtime-contracts.ts").RuntimeRecord) => void,
    guard?: () => void,
    reservation?: unknown,
  ): Promise<void>;
  snapshotReservation(
    operation: import("../src/runtime-contracts.ts").RuntimeOperation,
    snapshot: AttemptSnapshot,
    journalId: string,
  ): unknown;
  assertOrdinaryCapacity(
    record?: import("../src/runtime-contracts.ts").RuntimeRecord,
    extraBytes?: number,
  ): void;
}

async function capacityLeaseFixture() {
  const f = await runnerFixture();
  const record = structuredClone(f.record);
  const attempt = appendFixtureCompletion(record, 6);
  attempt.state = "CLAIMED";
  attempt.native = null;
  attempt.terminal = null;
  attempt.receipt = null;
  record.operations.pop();
  const payload = attempt.snapshot!.payload;
  payload.requestKind = "CONTINUATION";
  payload.questionId = uuid();
  payload.publicText = "\u0001".repeat(4000);
  payload.replyText = "\u0001".repeat(4000);
  for (const operation of record.operations) operation.result = structuredClone(attempt.snapshot);
  await writeFile(f.store.file, JSON.stringify(record));
  await f.store.read();
  const runtime = f.runner();
  const probe = runtime as unknown as CapacityRunnerProbe;
  probe.record = structuredClone(record);
  probe.lockHeld = true;
  let responses = 0;
  probe.workflow = async (action) => {
    assert.equal(action, "lease");
    responses++;
    return structuredClone(attempt.snapshot);
  };
  const fields = {
    requestId: attempt.requestId,
    attemptId: attempt.snapshot!.attemptId,
    fence: attempt.snapshot!.fence,
  };
  return { ...f, runtime, probe, attempt, fields, responses: () => responses };
}

test("should commit a maximum lease receipt using only its remaining snapshot reservation", async (t) => {
  const f = await capacityLeaseFixture();
  try {
    await f.store.locked(async () => {
      const operation = await f.probe.operation("lease", f.fields);
      const admittedBytes = Buffer.byteLength(JSON.stringify(f.probe.record));
      const resultBytes = Buffer.byteLength(JSON.stringify(f.attempt.snapshot));
      const receiptProjection = structuredClone(f.probe.record);
      receiptProjection.operations.at(-1)!.state = "CONFIRMED";
      receiptProjection.operations.at(-1)!.result = structuredClone(f.attempt.snapshot);
      const receiptBytes = Buffer.byteLength(JSON.stringify(receiptProjection));
      assert.ok(receiptBytes + 65536 + 1536 * 1024 <= 2 * 1024 * 1024);
      t.diagnostic(
        JSON.stringify({
          case: "H1",
          admittedBytes,
          resultBytes,
          receiptBytes,
          futureSnapshotBytes: 65536,
        }),
      );
      await f.probe.transmit(operation);
      assert.equal(f.responses(), 1);
      assert.equal((await f.store.read())!.operations.at(-1)!.state, "CONFIRMED");
      assert.equal(f.probe.capacityReservations.get(operation.operationId), 65536);
    });
  } finally {
    await f.close();
  }
});

for (const failure of ["write-failure", "guard-before-commit", "guard-after-commit"] as const) {
  test(`should retain lease reservations until durable receipt proof during ${failure}`, async (t) => {
    const f = await capacityLeaseFixture();
    const entered = deferred(),
      release = deferred();
    try {
      await f.store.locked(async () => {
        const operation = await f.probe.operation("lease", f.fields);
        const original = f.store.write.bind(f.store);
        let cancelled = false;
        const guard = () => {
          if (cancelled) throw new RuntimeError("RUNTIME_CLOSED");
        };
        t.mock.method(
          f.store,
          "write",
          async (next: import("../src/runtime-contracts.ts").RuntimeRecord, check?: () => void) => {
            if (
              next.operations.find((candidate) => candidate.operationId === operation.operationId)
                ?.state !== "CONFIRMED"
            )
              return original(next, check);
            entered.resolve();
            await release.promise;
            if (failure === "write-failure") throw new RuntimeError("UNKNOWN");
            if (failure === "guard-before-commit") cancelled = true;
            await original(next, check);
            if (failure === "guard-after-commit") cancelled = true;
          },
        );
        const receipt = f.probe.transmit(operation, guard);
        const rejected = assert.rejects(receipt, {
          code: failure === "write-failure" ? "UNKNOWN" : "RUNTIME_CLOSED",
        });
        await entered.promise;
        assert.equal(f.probe.capacityReservations.get(operation.operationId), 131072);
        assert.equal((await f.store.read())!.operations.at(-1)!.state, "TRANSMITTED");
        assert.throws(() => f.probe.assertOrdinaryCapacity(undefined, 55000), {
          code: "RUNTIME_CAPACITY",
        });
        // A second writer waits behind the receipt commit. Its admission must see the disk proof,
        // including when the first writer's guard closes immediately after the atomic commit.
        const contender = f.probe.mutate(
          "lease",
          () => {},
          () => f.probe.assertOrdinaryCapacity(undefined, 55000),
        );
        const contenderResult =
          failure === "guard-after-commit"
            ? contender
            : assert.rejects(contender, { code: "RUNTIME_CAPACITY" });
        release.resolve();
        await rejected;
        await contenderResult;
        const committed = failure === "guard-after-commit";
        assert.equal(
          f.probe.capacityReservations.get(operation.operationId),
          committed ? 65536 : 131072,
        );
        const disk = (await f.store.read())!;
        assert.equal(disk.operations.at(-1)!.state, committed ? "CONFIRMED" : "TRANSMITTED");
        assert.deepEqual(f.probe.record, disk);
        assert.equal(f.responses(), 1);
      });
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

for (const committed of [false, true]) {
  test(`should release the remaining lease snapshot reservation only with durable snapshot proof ${committed}`, async (t) => {
    const f = await capacityLeaseFixture();
    try {
      await f.store.locked(async () => {
        const operation = await f.probe.operation("lease", f.fields);
        const refreshed = structuredClone(f.attempt.snapshot!);
        refreshed.leaseExpiresAt = new Date(
          Date.parse(refreshed.leaseExpiresAt) + 1000,
        ).toISOString();
        f.probe.workflow = async () => refreshed;
        await f.probe.transmit(operation);
        assert.equal(f.probe.capacityReservations.get(operation.operationId), 65536);
        const original = f.store.write.bind(f.store);
        let cancelled = false;
        const guard = () => {
          if (cancelled) throw new RuntimeError("RUNTIME_CLOSED");
        };
        t.mock.method(
          f.store,
          "write",
          async (next: import("../src/runtime-contracts.ts").RuntimeRecord, check?: () => void) => {
            assert.equal(f.probe.capacityReservations.get(operation.operationId), 65536);
            if (!committed) throw new RuntimeError("UNKNOWN");
            await original(next, check);
            cancelled = true;
          },
        );
        await assert.rejects(
          f.probe.mutate(
            "lease",
            (next) => {
              next.attempts.at(-1)!.snapshot = refreshed;
            },
            guard,
            f.probe.snapshotReservation(operation, refreshed, f.attempt.requestId),
          ),
          { code: committed ? "RUNTIME_CLOSED" : "UNKNOWN" },
        );
        assert.equal(
          f.probe.capacityReservations.get(operation.operationId),
          committed ? undefined : 65536,
        );
        const disk = (await f.store.read())!;
        assert.deepEqual(
          disk.attempts.at(-1)!.snapshot,
          committed ? refreshed : f.attempt.snapshot,
        );
        assert.deepEqual(f.probe.record, disk);
      });
    } finally {
      await f.close();
    }
  });
}

async function largeTerminalReadinessFixture() {
  const f = await runnerFixture();
  try {
    let originalReceipt: unknown;
    const adapter = new SyntheticAdapter();
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (...args) => {
      const evidence = await execute(...args);
      evidence.privateText = "\u0001".repeat(65536);
      evidence.finalItems = Array.from({ length: 256 }, () => ({
        id: "\u0001".repeat(512),
        hash: "a".repeat(64),
      }));
      return evidence;
    };
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "complete") {
        originalReceipt = structuredClone(_result);
        response.destroy();
      }
    };
    f.queue();
    await f.runner(adapter).run({ once: true });
    const before = (await f.store.read())!;
    const terminal = structuredClone(before.attempts.at(-1)!.terminal);
    const outbox = structuredClone(
      before.operations.find((operation) => operation.action === "complete")!,
    );
    assert.equal(before.attempts.at(-1)!.state, "TERMINAL");
    const operationId = uuid();
    const body = {
      protocol: 1,
      agentId: f.scope.agentId,
      bindingEpoch: 1,
      operationId,
      reportedReady: true,
    };
    const readiness: import("../src/runtime-contracts.ts").RuntimeOperation = {
      operationId,
      action: "ready",
      body,
      payloadHash: digest(stableJson({ action: "ready", body })),
      state: "TRANSMITTED",
      result: null,
    };
    before.operations.splice(
      before.operations.findIndex((operation) => operation.operationId === outbox.operationId),
      0,
      readiness,
    );
    await writeFile(f.store.file, JSON.stringify(before));
    await f.store.read();
    f.faults.after = undefined;
    return { ...f, before, terminal, outbox, readiness, originalReceipt };
  } catch (error) {
    await f.close();
    throw error;
  }
}

test("should recover the original large terminal outbox before a pending readiness intent", async (t) => {
  const f = await largeTerminalReadinessFixture();
  const { before, terminal, outbox, readiness } = f;
  try {
    const callStart = f.requests.length;
    const recoveryAdapter = new SyntheticAdapter();
    const calls: string[] = [];
    f.faults.before = async (action, actual) => {
      if (action === "complete") assert.deepEqual(actual, outbox.body);
      if (action === "ready" && actual.operationId === readiness.operationId) {
        assert.deepEqual(actual, readiness.body);
        assert.equal((await f.store.read())!.attempts.at(-1)!.state, "UPLOADED");
      }
      calls.push(action);
    };
    t.diagnostic(
      JSON.stringify({
        case: "H2",
        journalBytes: Buffer.byteLength(JSON.stringify(before)),
        terminalBytes: Buffer.byteLength(JSON.stringify(terminal)),
        pendingReadyOperationId: readiness.operationId,
        outboxOperationId: outbox.operationId,
      }),
    );
    const status = await f.runner(recoveryAdapter).run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(status.state, "UPLOADED");
    assert.equal(recoveryAdapter.starts, 0);
    assert.deepEqual(after.attempts.at(-1)!.terminal, terminal);
    assert.deepEqual(after.attempts.at(-1)!.receipt, f.originalReceipt);
    assert.deepEqual(
      after.operations.find((operation) => operation.operationId === outbox.operationId)!.result,
      f.originalReceipt,
    );
    assert.equal(
      after.operations.find((operation) => operation.operationId === outbox.operationId)!.state,
      "CONFIRMED",
    );
    const replay = f.requests
      .slice(callStart)
      .filter((request) => request.body.operationId === readiness.operationId);
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0].body, readiness.body);
    assert.ok(calls.indexOf("complete") < calls.indexOf("ready"));
    assert.equal(after.ready, false);
    assert.throws(() => assertRuntimeCapacity(before, true), { code: "RUNTIME_CAPACITY" });
    assert.throws(() => assertRuntimeCapacity(after, true), { code: "RUNTIME_CAPACITY" });
  } finally {
    await f.close();
  }
});

test("should replay an unresolved readiness receipt after exact terminal recovery without another provider run", async () => {
  const f = await largeTerminalReadinessFixture();
  try {
    const callStart = f.requests.length;
    let readinessReceipt: unknown;
    f.faults.after = async (action, body, result, response) => {
      if (action === "ready" && body.operationId === f.readiness.operationId) {
        readinessReceipt = structuredClone(result);
        response.destroy();
      }
    };
    const firstAdapter = new SyntheticAdapter();
    await assert.rejects(f.runner(firstAdapter).run({ once: true }), { code: "UNAVAILABLE" });
    const interrupted = (await f.store.read())!;
    assert.equal(firstAdapter.starts, 0);
    assert.equal(interrupted.attempts.at(-1)!.state, "UPLOADED");
    assert.deepEqual(interrupted.attempts.at(-1)!.terminal, f.terminal);
    assert.deepEqual(interrupted.attempts.at(-1)!.receipt, f.originalReceipt);
    assert.deepEqual(
      interrupted.operations.find((operation) => operation.operationId === f.outbox.operationId)!
        .result,
      f.originalReceipt,
    );
    const pending = interrupted.operations.find(
      (operation) => operation.operationId === f.readiness.operationId,
    )!;
    assert.equal(pending.state, "TRANSMITTED");
    assert.equal(pending.result, null);
    assert.deepEqual(pending.body, f.readiness.body);
    assert.equal(interrupted.ready, false);
    f.faults.after = undefined;
    let witnessedReceipt = false;
    const secondAdapter = new SyntheticAdapter();
    const status = await f
      .runner(secondAdapter, {
        beforeMutation: async (kind) => {
          if (kind !== "operation-intent") return;
          const disk = (await f.store.read())!;
          const confirmed = disk.operations.find(
            (operation) => operation.operationId === f.readiness.operationId,
          );
          if (confirmed?.state === "CONFIRMED") {
            assert.deepEqual(confirmed.body, f.readiness.body);
            assert.deepEqual(confirmed.result, readinessReceipt);
            witnessedReceipt = true;
          }
        },
      })
      .run({ once: true });
    assert.equal(secondAdapter.starts, 0);
    assert.equal(status.state, "UPLOADED");
    assert.equal(witnessedReceipt, true);
    const after = (await f.store.read())!;
    const last = (await f.store.lastAttempt(after))!;
    assert.deepEqual(last.terminal, f.terminal);
    assert.deepEqual(last.receipt, f.originalReceipt);
    const replays = f.requests
      .slice(callStart)
      .filter((request) => request.body.operationId === f.readiness.operationId);
    assert.equal(replays.length, 3);
    for (const request of replays) assert.deepEqual(request.body, f.readiness.body);
    assert.equal(after.ready, false);
  } finally {
    await f.close();
  }
});

test("should keep monitoring through a maximum continuation lease receipt and publish the completed turn", async () => {
  const f = await runnerFixture();
  try {
    const payload = f.queue("CONTINUATION");
    payload.publicText = "\u0001".repeat(4000);
    payload.replyText = "\u0001".repeat(4000);
    let leaseCount = 0;
    let boundaryLease: string | undefined;
    f.faults.before = async (action, body) => {
      if (action !== "lease") return;
      leaseCount++;
      if (leaseCount === 5) {
        const disk = (await f.store.read())!;
        assert.equal(
          disk.operations.filter(
            (operation) =>
              ["claim", "start-intent", "lease"].includes(operation.action) &&
              operation.state === "CONFIRMED",
          ).length,
          6,
        );
        boundaryLease = String(body.operationId);
      }
    };
    const adapter = new SyntheticAdapter();
    adapter.executeHook = async () => {
      await waitForSynthetic(async () => {
        if (!boundaryLease) return false;
        const disk = (await f.store.read())!;
        const confirmed = disk.operations.find(
          (operation) => operation.operationId === boundaryLease,
        );
        return (
          confirmed?.state === "CONFIRMED" &&
          stableJson(disk.attempts.at(-1)!.snapshot) === stableJson(confirmed.result)
        );
      }, "maximum continuation lease receipt and snapshot must commit before terminal");
    };
    const status = await f
      .runner(adapter, { pollIntervalMs: 5, leaseIntervalMs: 100 })
      .run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(adapter.starts, 1);
    assert.equal(status.state, "UPLOADED");
    assert.equal(after.attempts.at(-1)!.terminal!.terminal, "COMPLETED");
    assert.equal(
      after.operations.find((operation) => operation.operationId === boundaryLease)!.state,
      "CONFIRMED",
    );
    assert.equal(after.operations.filter((operation) => operation.action === "complete").length, 1);
    assert.equal(
      after.operations.find((operation) => operation.action === "complete")!.state,
      "CONFIRMED",
    );
  } finally {
    await f.close();
  }
});

test("should report paused readiness on restart without claiming or submitting new native input", async () => {
  const f = await runnerFixture();
  try {
    f.pauseInput(true);
    f.queue();
    await f.runner().run({ once: true });
    assert.equal(f.adapter.starts, 0);
    assert.equal(
      f.requests.some((r) => r.action === "claim"),
      false,
    );
    assert.equal(f.requests.find((r) => r.action === "ready")?.body.reportedReady, false);
    assert.equal(f.inputState().appliedRevision, 2);
    assert.equal(
      (await f.store.read())!.operations.some((op) =>
        ["admission", "admission-ack"].includes(op.action),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});
test("should seal only a transmitted claim explicitly denied by input pause", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.faults.before = async (action) => {
      if (action === "claim") f.pauseInput(true);
    };
    await f.runner().run({ once: true });
    const record = (await f.store.read())!,
      a = record.attempts[0];
    assert.equal(f.adapter.starts, 0);
    assert.equal(a.state, "NOT_STARTED");
    assert.deepEqual(a.unstartedClosure, {
      kind: "SERVER_INPUT_PAUSED",
      claimOperationId: a.claimOperationId,
    });
    assert.equal(
      record.operations.find((op) => op.operationId === a.claimOperationId)?.state,
      "CLOSED",
    );
    assert.equal(a.snapshot, null);
  } finally {
    await f.close();
  }
});
test("should recover exact lost denial after resume and never replay its sealed operation", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.faults.before = async (action) => {
      if (action === "claim") f.pauseInput(true);
    };
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "claim") response.destroy();
    };
    await f.runner().run({ once: true });
    const uncertain = (await f.store.read())!,
      claim = uncertain.operations.find((op) => op.action === "claim")!;
    assert.equal(uncertain.attempts[0].state, "UNKNOWN");
    assert.equal(claim.state, "TRANSMITTED");
    f.faults.before = undefined;
    f.faults.after = undefined;
    f.pauseInput(false);
    await f.runner(new SyntheticAdapter()).run({ once: true });
    const recovered = (await f.store.read())!;
    assert.equal(recovered.attempts[0].unstartedClosure?.kind, "SERVER_INPUT_PAUSED");
    assert.equal(recovered.attempts[1].state, "UPLOADED");
    assert.notEqual(recovered.attempts[1].claimOperationId, claim.operationId);
    const exact = f.requests.filter(
      (r) => r.action === "claim" && r.body.operationId === claim.operationId,
    );
    assert.equal(exact.length, 2);
    assert.deepEqual(exact[0].body, exact[1].body);
    await f.runner(new SyntheticAdapter()).run({ once: true });
    assert.equal(f.requests.filter((r) => r.body.operationId === claim.operationId).length, 2);
  } finally {
    await f.close();
  }
});
test("should preserve admitted native tools and terminal publication when input pause or ACK lookup fails", async () => {
  for (const failure of ["pause", "offline", "stale-ack"]) {
    const f = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 10 });
    try {
      f.queue();
      f.adapter.executeHook = async (authority) => {
        const reads = f.requests.filter((r) => r.action === "admission").length;
        if (failure === "pause") f.pauseInput(true);
        else if (failure === "stale-ack") {
          f.pauseInput(true);
          f.faults.before = async (action) => {
            if (action === "admission-ack") f.pauseInput(false);
          };
        } else
          f.faults.before = async (action) => {
            if (action === "admission" || action === "admission-ack") throw new Error(failure);
          };
        await waitForSynthetic(
          () => f.requests.filter((r) => r.action === "admission").length > reads,
          "active input read did not run",
        );
        const turn = (await f.store.read())!.attempts[0].native!.turnId;
        const result = await authority.tool(
          callback(
            authority,
            turn,
            "read_workspace_file",
            { path: "public.txt" },
            "paused-file-read",
          ),
        );
        assert.equal(result.success, true);
      };
      await f.runner().run({ once: true });
      assert.equal(f.adapter.starts, 1);
      assert.equal((await f.store.read())!.attempts[0].state, "UPLOADED");
      assert.equal(
        f.requests.some((r) => r.action === "complete"),
        true,
      );
    } finally {
      await f.close();
    }
  }
});
test("should keep prior successful claim recovery while paused without submitting a new native input", async () => {
  const f = await runnerFixture();
  try {
    f.queue();
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "claim") response.destroy();
    };
    await f.runner().run({ once: true });
    const original = (await f.store.read())!.operations.find((op) => op.action === "claim")!;
    f.faults.after = undefined;
    f.pauseInput(true);
    const adapter = new SyntheticAdapter();
    await f.runner(adapter).run({ once: true });
    const next = (await f.store.read())!;
    assert.equal(next.attempts[0].state, "UNKNOWN");
    assert.equal(next.attempts[0].unstartedClosure, undefined);
    assert.equal(adapter.starts, 0);
    assert.deepEqual(
      f.requests.filter((r) => r.action === "claim").map((r) => r.body),
      [original.body, original.body],
    );
  } finally {
    await f.close();
  }
});

test("should retain UNKNOWN before denial proof commit and adopt immutable closure after committed write failure", async () => {
  for (const boundary of ["before", "after"]) {
    const f = await runnerFixture();
    try {
      f.queue();
      f.faults.before = async (action) => {
        if (action === "claim") f.pauseInput(true);
      };
      const originalWrite = f.store.write.bind(f.store);
      let injected = false;
      if (boundary === "after")
        f.store.write = async (value, guard) => {
          await originalWrite(value, guard);
          if (
            !injected &&
            value.attempts.at(-1)?.unstartedClosure?.kind === "SERVER_INPUT_PAUSED"
          ) {
            injected = true;
            throw new RuntimeError("UNKNOWN");
          }
        };
      await f
        .runner(f.adapter, {
          beforeMutation: async (kind) => {
            if (boundary === "before" && kind === "unstarted-closure")
              throw new RuntimeError("UNKNOWN");
          },
        })
        .run({ once: true });
      const saved = (await f.store.read())!;
      assert.equal(f.adapter.starts, 0);
      assert.equal(saved.attempts[0].state, boundary === "before" ? "UNKNOWN" : "NOT_STARTED");
      assert.equal(
        saved.operations.find((o) => o.action === "claim")!.state,
        boundary === "before" ? "TRANSMITTED" : "CLOSED",
      );
      f.store.write = originalWrite;
      f.faults.before = undefined;
      await f.runner(new SyntheticAdapter()).run({ once: true });
      assert.equal(
        (await f.store.read())!.attempts[0].unstartedClosure?.kind,
        "SERVER_INPUT_PAUSED",
      );
    } finally {
      await f.close();
    }
  }
});
test("should never seal denial proof for a different action or malformed claim envelope", async () => {
  for (const failure of ["other-action", "malformed-envelope"]) {
    const f = await runnerFixture();
    try {
      f.queue();
      const runtime = f.runner();
      if (failure === "other-action") {
        const original = runtime.client.call.bind(runtime.client);
        runtime.client.call = async (action, ...args) => {
          if (action === "start-intent") throw new WorkflowError("INPUT_PAUSED");
          return original(action, ...args);
        };
      } else
        f.faults.after = async (action, _body, result) => {
          if (action === "claim") Object.assign(result as object, { claimDenied: "INPUT_PAUSED" });
        };
      await runtime.run({ once: true });
      const saved = (await f.store.read())!;
      assert.equal(saved.attempts[0].state, "UNKNOWN");
      assert.equal(saved.attempts[0].unstartedClosure, undefined);
      assert.equal(f.adapter.starts, 0);
    } finally {
      await f.close();
    }
  }
});
