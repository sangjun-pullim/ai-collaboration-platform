import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runnerFixture, deferred, settleRunnerJobs } from "./runner-fixture.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import {
  RuntimeError,
  scopedNamespace,
  type AttemptAuthority,
  type RuntimeRecord,
  type ToolCall,
  type ToolResult,
} from "../src/runtime-contracts.ts";

function fileCallback(authority: AttemptAuthority, turnId: string, callId = "small-file-read") {
  return {
    threadId: authority.context.threadId,
    turnId,
    namespace: scopedNamespace,
    callId,
    tool: "read_workspace_file",
    arguments: { path: "public.txt" },
  };
}

test("should read a small selected file while a lease response remains in flight", async (t) => {
  const f = await runnerFixture({ pollIntervalMs: 5, leaseIntervalMs: 50 }),
    providerEntered = deferred(),
    leaseEntered = deferred(),
    releaseLease = deferred(),
    callbackFinished = deferred();
  const runtime = f.runner();
  const reservations = (runtime as unknown as { capacityReservations: Map<string, number> })
    .capacityReservations;
  let run: Promise<unknown> | undefined,
    leaseId: string | undefined,
    leaseResponseReturned = false,
    callbackError: unknown,
    result: ToolResult | undefined,
    beforeBytes = 0,
    callbackFinishedWhileHeld = false;
  try {
    const content = "Small selected public file evidence.\n\n";
    assert.equal(Buffer.byteLength(content), 38);
    await writeFile(join(f.root, "public.txt"), content);
    const policy = await RuntimeFilePolicy.select(f.root, ["public.txt"]);
    const record = (await f.store.read())!;
    record.settings!.files = [...policy.files];
    await f.store.write(record);

    f.faults.before = async (action) => {
      if (action !== "lease" || leaseId) return;
      await providerEntered.promise;
      const attempt = (await f.store.read())!.attempts.at(-1)!;
      assert.equal(attempt.state, "ACKNOWLEDGED");
      assert.ok(attempt.native);
      assert.equal(attempt.snapshot!.state, "EXECUTING");
      assert.equal(f.adapter.starts, 1);
    };
    f.faults.after = async (action, body, result) => {
      if (action !== "lease" || leaseId) return;
      const attempt = (await f.store.read())!.attempts.at(-1)!;
      assert.equal(attempt.state, "ACKNOWLEDGED");
      assert.ok(attempt.native);
      assert.equal(f.adapter.starts, 1);
      assert.equal((result as AttemptAuthority["attempt"]).state, "EXECUTING");
      leaseId = String(body.operationId);
      leaseEntered.resolve();
      await releaseLease.promise;
      leaseResponseReturned = true;
    };
    f.adapter.executeHook = async (authority) => {
      providerEntered.resolve();
      try {
        await leaseEntered.promise;
        await settleRunnerJobs(runtime);
        const before = (await f.store.read())!;
        const attempt = before.attempts.at(-1)!;
        assert.equal(f.adapter.starts, 1);
        assert.equal(attempt.state, "ACKNOWLEDGED");
        assert.ok(attempt.native);
        assert.equal(before.settings!.files[0].size, 38);
        assert.equal(leaseResponseReturned, false);
        assert.equal(reservations.get(leaseId!), 131072);
        const lease = before.operations.find((operation) => operation.operationId === leaseId)!;
        assert.equal(lease.action, "lease");
        assert.equal(lease.state, "TRANSMITTED");
        assert.equal(lease.result, null);
        beforeBytes = Buffer.byteLength(JSON.stringify(before));
        try {
          result = await authority.tool(fileCallback(authority, attempt.native.turnId));
        } finally {
          assert.equal(leaseResponseReturned, false);
          assert.equal(reservations.get(leaseId!), 131072);
          const held = (await f.store.read())!.operations.find(
            (operation) => operation.operationId === leaseId,
          )!;
          assert.equal(held.state, "TRANSMITTED");
          assert.equal(held.result, null);
          callbackFinishedWhileHeld = true;
        }
        assert.equal(result.success, true);
        assert.equal(result.contentItems.length, 1);
        assert.equal(result.contentItems[0].type, "inputText");
        assert.ok(result.contentItems[0].text === content);
      } catch (error) {
        callbackError = error;
        throw error;
      } finally {
        callbackFinished.resolve();
      }
    };
    f.queue();
    run = runtime.run({ once: true });
    try {
      await Promise.race([
        Promise.all([providerEntered.promise, callbackFinished.promise]),
        run.then(() => assert.fail("SYNTHETIC_RUN_FINISHED_BEFORE_FILE_CALLBACK")),
      ]);
      assert.equal(leaseResponseReturned, false);
      assert.equal(callbackFinishedWhileHeld, true);
    } finally {
      providerEntered.resolve();
      releaseLease.resolve();
      await run;
    }
    const after = (await f.store.read())!;
    const errorCode = callbackError instanceof RuntimeError ? callbackError.code : null;
    t.diagnostic(
      JSON.stringify({
        selectedFileBytes: 38,
        recordBytes: beforeBytes,
        heldLeaseBytes: 131072,
        callbackFinishedWhileHeld,
        callbackErrorCode: errorCode,
        state: after.attempts.at(-1)!.state,
        reason: after.attempts.at(-1)!.reason,
      }),
    );
    if (callbackError !== undefined) throw callbackError;
    assert.equal(after.attempts.at(-1)!.state, "UPLOADED");
    assert.equal(after.attempts.at(-1)!.terminal!.terminal, "COMPLETED");
    assert.equal(after.attempts.at(-1)!.receipt!.adoption, "ACCEPTED");
    assert.equal(after.attempts.at(-1)!.toolCalls.length, 1);
    assert.equal(after.attempts.at(-1)!.toolCalls[0].result!.success, true);
    assert.equal(f.requests.filter((request) => request.action === "complete").length, 1);
  } finally {
    providerEntered.resolve();
    releaseLease.resolve();
    try {
      await run;
      await settleRunnerJobs(runtime);
    } finally {
      await f.close();
      await assert.rejects(access(f.directory), { code: "ENOENT" });
      t.diagnostic(JSON.stringify({ ownedFixtureRemoved: true, runSettled: run !== undefined }));
    }
  }
});

type FileFixture = Awaited<ReturnType<typeof runnerFixture>>;
interface FileCapacityProbe {
  record: RuntimeRecord;
  capacityReservations: Map<string, number>;
}
interface FileScenario {
  f: FileFixture;
  probe: FileCapacityProbe;
  authority: AttemptAuthority;
  turnId: string;
  toolReservations: number[];
  assertHeld(): Promise<void>;
  releaseAndCommitLease(): Promise<void>;
}

async function withSelectedFile(
  t: TestContext,
  content: string,
  work: (scenario: FileScenario) => Promise<void>,
) {
  const options = { pollIntervalMs: 5, leaseIntervalMs: 50 };
  const f = await runnerFixture(options),
    providerEntered = deferred(),
    leaseEntered = deferred(),
    releaseLease = deferred(),
    leaseCommitted = deferred(),
    workFinished = deferred(),
    releaseProvider = deferred();
  const runtime = f.runner(f.adapter, options);
  const probe = runtime as unknown as FileCapacityProbe;
  const toolReservations: number[] = [];
  const originalSet = probe.capacityReservations.set;
  const originalWrite = f.store.write;
  let leaseId: string | undefined,
    leaseResponseReturned = false,
    run: Promise<unknown> | undefined,
    workError: unknown;
  try {
    await writeFile(join(f.root, "public.txt"), content);
    const policy = await RuntimeFilePolicy.select(f.root, ["public.txt"]);
    const record = (await f.store.read())!;
    record.settings!.files = [...policy.files];
    await f.store.write(record);
    probe.capacityReservations.set = function (key, bytes) {
      if (key.startsWith("tool:")) toolReservations.push(bytes);
      return originalSet.call(this, key, bytes);
    };
    f.store.write = async (next, check) => {
      await originalWrite.call(f.store, next, check);
      const lease = next.operations.find((operation) => operation.operationId === leaseId);
      if (
        lease?.state === "CONFIRMED" &&
        JSON.stringify(next.attempts.at(-1)!.snapshot) === JSON.stringify(lease.result)
      )
        leaseCommitted.resolve();
    };
    f.faults.before = async (action) => {
      if (action !== "lease" || leaseId) return;
      await providerEntered.promise;
      const attempt = (await f.store.read())!.attempts.at(-1)!;
      assert.equal(attempt.state, "ACKNOWLEDGED");
      assert.ok(attempt.native);
      assert.equal(attempt.snapshot!.state, "EXECUTING");
      assert.equal(f.adapter.starts, 1);
    };
    f.faults.after = async (action, body, result) => {
      if (action !== "lease" || leaseId) return;
      const attempt = (await f.store.read())!.attempts.at(-1)!;
      assert.equal(attempt.state, "ACKNOWLEDGED");
      assert.ok(attempt.native);
      assert.equal(f.adapter.starts, 1);
      assert.equal((result as AttemptAuthority["attempt"]).state, "EXECUTING");
      leaseId = String(body.operationId);
      leaseEntered.resolve();
      await releaseLease.promise;
      leaseResponseReturned = true;
    };
    const assertHeld = async () => {
      assert.equal(leaseResponseReturned, false);
      assert.equal(probe.capacityReservations.get(leaseId!), 131072);
      const saved = (await f.store.read())!;
      const lease = saved.operations.find((operation) => operation.operationId === leaseId)!;
      assert.equal(lease.action, "lease");
      assert.equal(lease.state, "TRANSMITTED");
      assert.equal(lease.result, null);
    };
    f.adapter.executeHook = async (authority) => {
      providerEntered.resolve();
      try {
        await leaseEntered.promise;
        await settleRunnerJobs(runtime);
        const attempt = (await f.store.read())!.attempts.at(-1)!;
        assert.equal(attempt.state, "ACKNOWLEDGED");
        assert.equal(f.adapter.starts, 1);
        assert.ok(attempt.native);
        await assertHeld();
        await work({
          f,
          probe,
          authority,
          turnId: attempt.native.turnId,
          toolReservations,
          assertHeld,
          releaseAndCommitLease: async () => {
            options.leaseIntervalMs = 6000;
            releaseLease.resolve();
            await leaseCommitted.promise;
            await settleRunnerJobs(runtime);
            assert.equal(leaseResponseReturned, true);
            assert.equal(probe.capacityReservations.has(leaseId!), false);
            assert.equal(
              (await f.store.read())!.operations.find(
                (operation) => operation.operationId === leaseId,
              )!.state,
              "CONFIRMED",
            );
          },
        });
      } catch (error) {
        workError = error;
        throw error;
      } finally {
        workFinished.resolve();
        await releaseProvider.promise;
      }
    };
    f.queue();
    run = runtime.run({ once: true });
    try {
      await Promise.race([
        workFinished.promise,
        run.then(() => assert.fail("SYNTHETIC_RUN_FINISHED_BEFORE_FILE_CALLBACK")),
      ]);
    } finally {
      providerEntered.resolve();
      releaseLease.resolve();
      releaseProvider.resolve();
      await run;
    }
    if (workError !== undefined) throw workError;
    const after = (await f.store.read())!;
    assert.equal(after.attempts.at(-1)!.state, "UPLOADED");
    assert.equal(after.attempts.at(-1)!.terminal!.terminal, "COMPLETED");
    assert.equal(after.attempts.at(-1)!.receipt!.adoption, "ACCEPTED");
    assert.equal(f.requests.filter((request) => request.action === "complete").length, 1);
  } finally {
    providerEntered.resolve();
    releaseLease.resolve();
    releaseProvider.resolve();
    try {
      await run;
      await settleRunnerJobs(runtime);
    } finally {
      probe.capacityReservations.set = originalSet;
      f.store.write = originalWrite;
      await f.close();
      await assert.rejects(access(f.directory), { code: "ENOENT" });
      t.diagnostic(JSON.stringify({ ownedFixtureRemoved: true, runSettled: run !== undefined }));
    }
  }
}

test("should reserve selected file bytes across encoding and size boundaries", async (t) => {
  const cases = [
    { content: "", size: 0, reserved: 4096 },
    { content: "한🙂é\n", size: 10, reserved: 4156 },
    { content: '"\\\t\r\n'.repeat(100), size: 500, reserved: 7096 },
    { content: "x".repeat(65536), size: 65536, reserved: 397312 },
  ];
  for (const input of cases) {
    await t.test(
      `should bound persisted bytes for a ${input.size} byte selected file`,
      async (t) => {
        assert.equal(Buffer.byteLength(input.content), input.size);
        await withSelectedFile(t, input.content, async (scenario) => {
          const { f, authority, turnId, toolReservations } = scenario;
          // Every code unit uses the longest JSON escape accepted in a callback identifier.
          const callId = "\u0001".repeat(512);
          assert.equal(callId.length, 512);
          if (input.size === 65536) {
            await assert.rejects(authority.tool(fileCallback(authority, turnId, "maximum-held")), {
              code: "RUNTIME_CAPACITY",
            });
            assert.equal(toolReservations.at(-1), 397312);
            await scenario.assertHeld();
            await scenario.releaseAndCommitLease();
          }
          const beforeDiskBytes = (await stat(f.store.file)).size;
          const result = await authority.tool(fileCallback(authority, turnId, callId));
          assert.equal(result.success, true);
          assert.ok(result.contentItems[0].text === input.content);
          assert.equal(toolReservations.at(-1), input.reserved);
          if (input.size !== 65536) await scenario.assertHeld();
          const after = (await f.store.read())!;
          const entry = after.attempts.at(-1)!.toolCalls[0];
          assert.equal(after.attempts.at(-1)!.toolCalls.length, 1);
          assert.equal(entry.callId, callId);
          assert.equal(entry.payloadHash.length, 64);
          assert.equal(entry.operationId, null);
          assert.equal(entry.result!.contentItems.length, 1);
          const metadata = {
            ...entry,
            result: {
              ...entry.result!,
              contentItems: [{ ...entry.result!.contentItems[0], text: "" }],
            },
          };
          const metadataBytes = Buffer.byteLength(JSON.stringify(metadata)) + 1;
          assert.equal(metadataBytes, 3260);
          assert.ok(metadataBytes <= 4096);
          const diskGrowth = (await stat(f.store.file)).size - beforeDiskBytes;
          assert.equal(diskGrowth, Buffer.byteLength(JSON.stringify(entry)));
          assert.ok(diskGrowth <= input.reserved);
          t.diagnostic(
            JSON.stringify({
              selectedFileBytes: input.size,
              toolReservedBytes: toolReservations.at(-1),
              diskGrowthBytes: diskGrowth,
              metadataWithCommaBytes: metadataBytes,
            }),
          );
        });
      },
    );
  }
});

test("should preserve conservative reservations for invalid file calls", async (t) => {
  const invalidArguments: unknown[] = [
    null,
    [],
    {},
    { path: "public.txt", extra: true },
    { path: 38 },
    { path: "unselected.txt" },
    { path: "./public.txt" },
  ];
  await withSelectedFile(t, "Small selected public file evidence.\n\n", async (scenario) => {
    const { f, probe, authority, turnId, toolReservations } = scenario;
    const diskBefore = await readFile(f.store.file);
    for (const [index, args] of invalidArguments.entries()) {
      const call = {
        ...fileCallback(authority, turnId, `invalid-held-${index}`),
        arguments: args,
      };
      await assert.rejects(authority.tool(call), { code: "RUNTIME_CAPACITY" });
      assert.equal(toolReservations.at(-1), 397312);
      await scenario.assertHeld();
    }
    const invalidSizes: unknown[] = [-1, 0.5, 65537, NaN, Infinity, undefined, "38"];
    for (const [index, size] of invalidSizes.entries()) {
      // This scoped memory fault is introduced only after ACK and is never persisted.
      const snapshot = probe.record.settings!.files[0];
      const originalSize = snapshot.size;
      try {
        Object.assign(snapshot, { size });
        await assert.rejects(
          authority.tool(fileCallback(authority, turnId, `invalid-size-${index}`)),
          { code: "RUNTIME_CAPACITY" },
        );
        assert.equal(toolReservations.at(-1), 397312);
      } finally {
        snapshot.size = originalSize;
      }
      assert.equal(probe.record.settings!.files[0].size, 38);
      await scenario.assertHeld();
      assert.ok((await readFile(f.store.file)).equals(diskBefore));
    }
    assert.equal((await f.store.read())!.attempts.at(-1)!.toolCalls.length, 0);
    await scenario.releaseAndCommitLease();
    for (const [index, args] of invalidArguments.entries()) {
      await assert.rejects(
        authority.tool({
          ...fileCallback(authority, turnId, `invalid-released-${index}`),
          arguments: args,
        }),
        { code: "TOOL_REJECTED" },
      );
      assert.equal(toolReservations.at(-1), 397312);
    }
    const question: ToolCall = {
      ...fileCallback(authority, turnId, "peer-question"),
      tool: "ask_peer",
      arguments: {
        question: "What does the selected evidence show?",
        evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
      },
    };
    const questionResult = await authority.tool(question);
    assert.equal(questionResult.success, true);
    assert.equal(toolReservations.at(-1), 8192);
    assert.strictEqual(await authority.tool(question), questionResult);
    assert.equal(f.questionCount(), 1);
    assert.equal(
      (await f.store.read())!.operations.filter((op) => op.action === "question").length,
      1,
    );
  });
});

test("should retain file drift and duplicate callback checks with sized reservations", async (t) => {
  const content = "Small selected public file evidence.\n\n";
  await withSelectedFile(t, content, async (scenario) => {
    const { f, authority, turnId, toolReservations } = scenario;
    const originalRead = RuntimeFilePolicy.prototype.read;
    let reads = 0;
    RuntimeFilePolicy.prototype.read = async function (...args) {
      reads++;
      return originalRead.apply(this, args);
    };
    try {
      const call = fileCallback(authority, turnId, "duplicate-file");
      const [first, second] = await Promise.all([authority.tool(call), authority.tool(call)]);
      assert.strictEqual(first, second);
      // A fresh callback reads once for assertUnchanged and once for its actual result.
      assert.equal(reads, 2);
      assert.deepEqual(toolReservations, [4324]);
      await scenario.assertHeld();
      const diskAfterRead = await readFile(f.store.file);
      assert.strictEqual(await authority.tool(call), first);
      assert.equal(reads, 2);
      assert.ok((await readFile(f.store.file)).equals(diskAfterRead));
      await assert.rejects(authority.tool({ ...call, arguments: { path: "unselected.txt" } }), {
        code: "TOOL_REJECTED",
      });
      assert.equal(reads, 2);
      assert.deepEqual(toolReservations, [4324]);
      await writeFile(join(f.root, "public.txt"), "Changed selected public file.\n");
      assert.strictEqual(await authority.tool(call), first);
      assert.equal(reads, 2);
      await assert.rejects(authority.tool(fileCallback(authority, turnId, "drifted-file")), {
        code: "SNAPSHOT_CHANGED",
      });
      assert.equal(reads, 3);
      assert.deepEqual(toolReservations, [4324, 4324]);
      await scenario.assertHeld();
      assert.ok((await readFile(f.store.file)).equals(diskAfterRead));
      assert.equal((await f.store.read())!.attempts.at(-1)!.toolCalls.length, 1);
    } finally {
      RuntimeFilePolicy.prototype.read = originalRead;
    }
  });
});
