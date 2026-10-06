import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  type AttemptAuthority,
  type ToolCall,
  type ToolResult,
} from "../src/runtime-contracts.ts";
import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
import { RepositoryReader } from "../src/workspace/repository-reader.ts";
import { runnerFixture, SyntheticAdapter } from "./runner-fixture.ts";
import { capabilityHash } from "../src/settings/contracts.ts";
import { uuid } from "./runtime-fixture.ts";

function automatic(record: import("../src/runtime-contracts.ts").RuntimeRecord) {
  record.version = 2;
  const caps = record.settings!.capabilities;
  const { snapshotHash, ...contents } = caps;
  void snapshotHash;
  caps.runtime = "codex";
  caps.snapshotHash = capabilityHash({ ...contents, runtime: "codex", policy: "verified" });
  record.settings!.files = [];
  record.settings!.repositoryAccess = createRepositoryAccess(
    record.context!.generation,
    record.context!.root,
    uuid(),
    uuid(),
  );
}
function call(
  authority: AttemptAuthority,
  name: string,
  args: unknown,
  id: string = uuid(),
): ToolCall {
  return {
    threadId: authority.context.threadId,
    turnId: (authority as unknown as { turn?: string }).turn ?? "",
    callId: id,
    namespace: scopedNamespace,
    tool: name,
    arguments: args,
  };
}
async function ownedCall(
  f: Awaited<ReturnType<typeof runnerFixture>>,
  authority: AttemptAuthority,
  name: string,
  args: unknown,
  id: string = uuid(),
) {
  const input = call(authority, name, args, id);
  input.turnId = (await f.store.read())!.attempts[0].native!.turnId;
  return input;
}

test("should persist automatic intent before I/O and exact returned observations before delivery", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter();
  const delivered: ToolResult[] = [];
  const original = RepositoryReader.prototype.read;
  const injected = mock.method(
    RepositoryReader.prototype,
    "read",
    async function (this: RepositoryReader, args: Parameters<typeof original>[0]) {
      const saved = (await f.store.read())!.attempts[0].toolCalls.at(-1)!;
      assert.ok(saved.repositoryIntent);
      assert.equal(saved.result, null);
      assert.equal(saved.repositoryObservation, undefined);
      return original.call(this, args);
    },
  );
  try {
    await writeFile(join(f.root, "unselected.ts"), "const evidence = 1;\n", { mode: 0o644 });
    adapter.executeHook = async (authority) => {
      for (const [tool, args] of [
        ["list_workspace_files", {}],
        ["search_workspace", { query: "evidence" }],
        ["read_workspace_file", { path: "unselected.ts" }],
      ] as const) {
        const input = await ownedCall(f, authority, tool, args);
        const result = await authority.tool(input);
        delivered.push(result);
        const saved = (await f.store.read())!.attempts[0].toolCalls.at(-1)!;
        assert.deepEqual(saved.result, result);
        assert.equal(saved.repositoryObservation!.resultHash, digest(stableJson(result)));
        assert.equal(saved.repositoryIntent!.argumentsHash, digest(stableJson(args)));
        assert.ok(Buffer.byteLength(result.contentItems[0].text) <= 8192);
        assert.deepEqual(await authority.tool(input), result);
      }
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(delivered.length, 3);
    const calls = (await f.store.read())!.attempts[0].toolCalls;
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].repositoryObservation!.files, []);
    assert.equal(calls[1].repositoryObservation!.files.length, 2);
    assert.equal(calls[2].repositoryObservation!.files[0].hash, digest("const evidence = 1;\n"));
    assert.equal(injected.mock.callCount(), 1);
  } finally {
    injected.mock.restore();
    await f.close();
  }
});

for (const failure of ["tool-call-intent", "tool-receipt"] as const)
  test(`should preserve automatic evidence when ${failure} fails without substituting a new read`, async () => {
    const f = await runnerFixture(
        {
          beforeMutation: async (kind) => {
            if (kind === failure) throw new RuntimeError("UNSAFE_STORAGE");
          },
        },
        automatic,
      ),
      adapter = new SyntheticAdapter();
    const original = RepositoryReader.prototype.read;
    const injected = mock.method(RepositoryReader.prototype, "read", original);
    let invocation: ToolCall | undefined,
      checked = false;
    try {
      adapter.executeHook = async (authority) => {
        invocation = await ownedCall(f, authority, "read_workspace_file", { path: "public.txt" });
        await assert.rejects(authority.tool(invocation), { code: "UNSAFE_STORAGE" });
        await assert.rejects(authority.tool(invocation));
        checked = true;
        throw new RuntimeError("UNKNOWN");
      };
      f.queue();
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UNKNOWN");
      assert.equal(checked, true);
      const disk = (await f.store.read())!;
      assert.equal(injected.mock.callCount(), failure === "tool-call-intent" ? 0 : 1);
      assert.equal(disk.attempts[0].toolCalls.length, failure === "tool-call-intent" ? 0 : 1);
      if (failure === "tool-receipt") {
        assert.equal(disk.attempts[0].toolCalls[0].result, null);
        assert.ok(disk.attempts[0].toolCalls[0].repositoryIntent);
      }
      await assert.rejects(
        f.runner(new SyntheticAdapter()).prepare({
          choice: "default",
          files: ["public.txt"],
          handoff: "Replacement",
          confirmed: true,
          autoQuestionsConfirmed: false,
        }),
        { code: "RUNTIME_BUSY" },
      );
      assert.equal(f.requests.filter((request) => request.action === "replace").length, 0);
      const bytes = await readFile(f.store.file);
      await f.runner(new SyntheticAdapter()).observe();
      assert.equal(injected.mock.callCount(), failure === "tool-call-intent" ? 0 : 1);
      assert.deepEqual(await readFile(f.store.file), bytes);
    } finally {
      injected.mock.restore();
      await f.close();
    }
  });

for (const kind of ["ORIGIN", "CONTINUATION", "RESUME"] as const)
  test(`should persist exact pre-send peer evidence for a claimed ${kind} origin role`, async () => {
    const f = await runnerFixture({}, automatic),
      adapter = new SyntheticAdapter();
    const original = RepositoryReader.prototype.read,
      readers = new Set<RepositoryReader>();
    const injected = mock.method(
      RepositoryReader.prototype,
      "read",
      async function (this: RepositoryReader, args: Parameters<typeof original>[0]) {
        readers.add(this);
        return original.call(this, args);
      },
    );
    let proof: unknown;
    try {
      await writeFile(join(f.root, "unselected.ts"), "const evidence = 1;\nconst second = 2;\n", {
        mode: 0o644,
      });
      f.faults.before = async (action, body) => {
        if (action !== "question") return;
        const disk = (await f.store.read())!,
          row = disk.attempts[0].toolCalls.at(-1)!;
        const op = disk.operations.find((item) => item.operationId === row.operationId)!;
        assert.equal(row.result, null);
        assert.equal(row.repositoryObservation, undefined);
        assert.ok(row.peerEvidenceObservation);
        assert.deepEqual(op.body, body);
        assert.equal(op.payloadHash, digest(stableJson({ action: "question", body })));
        proof = structuredClone(row.peerEvidenceObservation);
      };
      adapter.executeHook = async (authority) => {
        assert.equal(authority.peerTools, true);
        await authority.tool(
          await ownedCall(f, authority, "read_workspace_file", { path: "unselected.ts" }),
        );
        const input = await ownedCall(f, authority, "ask_peer", {
          question: "Review evidence",
          evidence: [{ path: "unselected.ts", startLine: 2, endLine: 2 }],
        });
        assert.equal((await authority.tool(input)).success, true);
        assert.equal((await authority.tool(input)).success, true);
      };
      f.queue(kind);
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
      assert.equal(readers.size, 1);
      assert.equal(injected.mock.callCount(), 2);
      assert.equal(f.questionCount(), 1);
      const row = (await f.store.read())!.attempts[0].toolCalls.at(-1)!;
      assert.deepEqual(row.peerEvidenceObservation, proof);
      assert.equal(row.peerEvidenceObservation!.files[0].lineCount, 3);
      assert.equal(row.peerEvidenceObservation!.files[0].startLine, 2);
      assert.equal(row.peerEvidenceObservation!.files[0].byteStart, 0);
      assert.equal(
        row.peerEvidenceObservation!.files[0].excerptHash,
        digest("const evidence = 1;\nconst second = 2;\n"),
      );
      const before = (await f.store.read())!,
        sourceBytes = await readFile(f.store.file),
        attempt = structuredClone(before.attempts[0]),
        questionOperation = before.operations.find((op) => op.operationId === row.operationId)!;
      assert.ok(questionOperation);
      assert.equal(questionOperation.action, "question");
      assert.ok(row.result);
      assert.ok(row.peerEvidenceObservation);
      const compacted = await f.store.compact(before),
        archiveFile = join(
          f.store.dir,
          "archives",
          f.store.agentId,
          `${compacted.archives![0].hash}.json`,
        ),
        archiveBytes = await readFile(archiveFile);
      assert.deepEqual(archiveBytes, sourceBytes);
      assert.equal(digest(archiveBytes), compacted.archives![0].hash);
      const archived = JSON.parse(archiveBytes.toString()) as typeof before;
      assert.deepEqual(archived.attempts[0], attempt);
      assert.deepEqual(archived.attempts[0].toolCalls.at(-1)!.peerEvidenceObservation, proof);
      assert.deepEqual(
        archived.operations.find((op) => op.operationId === row.operationId),
        questionOperation,
      );
      const restored = (await f.store.read())!;
      assert.deepEqual(restored, compacted);
      assert.deepEqual(restored.settings, before.settings);
      assert.deepEqual(restored.context, before.context);
      assert.deepEqual(await f.store.lastAttempt(restored), attempt);
      await f.store.write(restored);
      assert.deepEqual(await readFile(archiveFile), archiveBytes);
      assert.equal(injected.mock.callCount(), 2);
      assert.equal(f.questionCount(), 1);
    } finally {
      injected.mock.restore();
      await f.close();
    }
  });

for (const failure of ["question-call-intent", "question-call-receipt", "response-loss"] as const)
  test(`should preserve automatic peer evidence across ${failure} with no recovery reread`, async () => {
    const f = await runnerFixture(
        {
          beforeMutation: async (kind) => {
            if (kind === failure) throw new RuntimeError("UNSAFE_STORAGE");
          },
        },
        automatic,
      ),
      adapter = new SyntheticAdapter();
    const injected = mock.method(
      RepositoryReader.prototype,
      "read",
      RepositoryReader.prototype.read,
    );
    let lost = false,
      checked = false;
    try {
      if (failure === "response-loss")
        f.faults.after = async (action, _body, _result, response) => {
          if (action === "question" && !lost) {
            lost = true;
            response.destroy();
          }
        };
      adapter.executeHook = async (authority) => {
        const input = await ownedCall(f, authority, "ask_peer", {
          question: "Review evidence",
          evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
        });
        await assert.rejects(authority.tool(input));
        await assert.rejects(authority.tool(input));
        checked = true;
        throw new RuntimeError("UNKNOWN");
      };
      f.queue();
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UNKNOWN");
      assert.equal(checked, true);
      assert.equal(f.questionCount(), failure === "question-call-intent" ? 0 : 1);
      const before = (await f.store.read())!,
        saved = before.attempts[0].toolCalls[0];
      if (failure === "question-call-intent") assert.equal(saved, undefined);
      else {
        assert.ok(saved.peerEvidenceObservation);
        assert.equal(saved.result, null);
      }
      const hashes = before.operations
        .filter((item) => item.action === "question")
        .map((item) => [item.operationId, item.payloadHash, item.body]);
      await f.runner(new SyntheticAdapter()).observe();
      assert.equal(injected.mock.callCount(), 1);
      assert.equal(f.questionCount(), failure === "question-call-intent" ? 0 : 1);
      const after = (await f.store.read())!;
      assert.deepEqual(
        after.operations
          .filter((item) => item.action === "question")
          .map((item) => [item.operationId, item.payloadHash, item.body]),
        hashes,
      );
      assert.deepEqual(
        after.attempts[0].toolCalls[0]?.peerEvidenceObservation,
        saved?.peerEvidenceObservation,
      );
    } finally {
      injected.mock.restore();
      await f.close();
    }
  });

for (const refusal of ["PEER", "consent", "range", "offset"] as const)
  test(`should reject automatic ${refusal} input before unauthorized work`, async () => {
    const f = await runnerFixture({}, (record) => {
        automatic(record);
        if (refusal === "consent") record.settings!.autoQuestionsConfirmed = false;
      }),
      adapter = new SyntheticAdapter();
    const injected = mock.method(
      RepositoryReader.prototype,
      "read",
      RepositoryReader.prototype.read,
    );
    try {
      adapter.executeHook = async (authority) => {
        const input = await ownedCall(
          f,
          authority,
          refusal === "offset" ? "read_workspace_file" : "ask_peer",
          refusal === "offset"
            ? { path: "public.txt", offset: 2097153 }
            : {
                question: "Review evidence",
                evidence: [
                  { path: "public.txt", startLine: 1, endLine: refusal === "range" ? 3 : 1 },
                ],
              },
        );
        await assert.rejects(authority.tool(input), { code: "TOOL_REJECTED" });
      };
      f.queue(refusal === "PEER" ? "PEER" : "ORIGIN");
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
      assert.equal(f.questionCount(), 0);
      assert.equal(injected.mock.callCount(), refusal === "range" ? 1 : 0);
      assert.equal((await f.store.read())!.attempts[0].toolCalls.length, 0);
    } finally {
      injected.mock.restore();
      await f.close();
    }
  });

import { deferred } from "./runner-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { claudeHarness, streamingAbort } from "./claude-runtime-fixture.ts";
import { nativeToolNames } from "../src/workspace/tool-contracts.ts";

for (const storage of ["saved", "failed"] as const)
  test(
    `should immediately fence both Claude automatic calls while the first cancellation is ${storage}`,
    { timeout: 6000 },
    async () => {
      const readA = deferred(),
        readB = deferred(),
        releaseA = deferred(),
        releaseB = deferred(),
        saving = deferred(),
        releaseSave = deferred(),
        cancellationB = deferred(),
        resumedB = deferred();
      let cancellationWrites = 0,
        current: AttemptAuthority | undefined,
        corePath = "",
        coreB = 0,
        finished = false;
      const f = await runnerFixture(
        {
          drainTimeoutMs: 20,
          beforeMutation: async (kind) => {
            if (kind !== "native-tool-cancellation" || ++cancellationWrites !== 1) return;
            saving.resolve();
            await releaseSave.promise;
            if (storage === "failed") throw new RuntimeError("UNSAFE_STORAGE");
          },
        },
        (record) => {
          Object.assign(record, claudeRecord(record));
          record.settings!.files = [];
          record.settings!.autoQuestionsConfirmed = false;
          record.settings!.repositoryAccess = createRepositoryAccess(
            record.context!.generation,
            record.context!.root,
            uuid(),
            uuid(),
          );
        },
      );
      const h = claudeHarness(f, f.record),
        execute = h.adapter.execute.bind(h.adapter);
      h.adapter.execute = (authority, settings, payload, beforeSubmit) => {
        current = authority;
        return execute(authority, settings, payload, async (intent) => {
          assert.ok(intent);
          h.captureIntent(intent);
          await beforeSubmit(intent);
        });
      };
      const original = RepositoryReader.prototype.read;
      // Count entry to the original read operation, before readSafeFile can perform any I/O.
      const core = RepositoryReader.prototype as unknown as {
        run: (operation: (check: () => void) => Promise<unknown>) => Promise<unknown>;
      };
      const originalRun = core.run;
      const probe = mock.method(
        core,
        "run",
        function (this: RepositoryReader, operation: Parameters<typeof originalRun>[0]) {
          const path = corePath;
          return originalRun.call(this, async (check) => {
            if (path === "second.txt") coreB++;
            return operation(check);
          });
        },
      );
      const injected = mock.method(
        RepositoryReader.prototype,
        "read",
        async function (this: RepositoryReader, args: Parameters<typeof original>[0]) {
          if (args.path === "second.txt") {
            readB.resolve();
            await releaseB.promise;
          }
          corePath = args.path;
          const reading = original.call(this, args);
          corePath = "";
          let result: Awaited<ReturnType<typeof original>>;
          try {
            result = await reading;
          } finally {
            if (args.path === "second.txt") resumedB.resolve();
          }
          if (args.path === "public.txt") {
            readA.resolve();
            await releaseA.promise;
          }
          return result;
        },
      );
      const rpcs: Promise<void>[] = [],
        cancellations: Promise<void>[] = [];
      h.native.onInput = async (input) => {
        await h.emit(input);
        await h.emit({ ...h.init(), tools: nativeToolNames("AUTO_CODE", false) });
        for (const [id, path] of [
          ["A", "public.txt"],
          ["B", "second.txt"],
        ]) {
          await h.emit(
            h.assistant(input, [
              {
                type: "tool_use",
                id,
                name: "mcp__ai_collaboration_scoped__read_workspace_file",
                input: { path },
              },
            ]),
          );
          const rpc = h.native.emit({
            type: "control_request",
            request_id: `control-${id}`,
            request: {
              subtype: "mcp_message",
              server_name: "ai_collaboration_scoped",
              message: {
                jsonrpc: "2.0",
                id: `rpc-${id}`,
                method: "tools/call",
                params: {
                  name: "read_workspace_file",
                  arguments: { path },
                  _meta: {
                    session_id: h.context.threadId,
                    user_message_uuid: input.uuid,
                    tool_use_id: id,
                  },
                },
              },
            },
          });
          void rpc.catch(() => {});
          rpcs.push(rpc);
          await (id === "A" ? readA.promise : readB.promise);
        }
      };
      h.native.onInterrupt = async () => {
        const first = h.native.emit({ type: "control_cancel_request", request_id: "control-A" });
        void first.catch(() => {});
        cancellations.push(first);
        await saving.promise;
        const second = h.native.emit({ type: "control_cancel_request", request_id: "control-B" });
        void second.catch(() => {});
        cancellations.push(second);
        cancellationB.resolve();
        await Promise.all(cancellations);
        return { still_queued: [], cancelled: [h.intent!.inputId] };
      };
      let run: ReturnType<ReturnType<typeof f.runner>["run"]> | undefined,
        interrupt: Promise<boolean> | undefined;
      try {
        await writeFile(join(f.root, "second.txt"), "Second evidence\n", { mode: 0o644 });
        f.queue();
        run = f.runner(h.adapter).run({ once: true });
        void run.catch(() => {});
        await readB.promise;
        const intents = structuredClone((await f.store.read())!.attempts[0].toolCalls);
        assert.equal(intents.length, 2);
        assert.ok(intents.every((row) => row.repositoryIntent && row.result === null));
        interrupt = h.adapter.interrupt(current!);
        void interrupt.catch(() => {});
        await cancellationB.promise;
        releaseB.resolve();
        await resumedB.promise;
        assert.equal(coreB, 0);
        assert.equal(cancellationWrites, 1);
        assert.equal(h.native.replies.length, 0);
        releaseSave.resolve();
        if (storage === "failed") {
          await assert.rejects(interrupt, { code: "UNSAFE_STORAGE" });
          releaseA.resolve();
          assert.equal((await run).state, "UNKNOWN");
        } else {
          assert.equal(await interrupt, true);
          await h.emit(h.result(h.native.writes[0], streamingAbort));
          assert.equal((await run).state, "UPLOADED");
          releaseA.resolve();
        }
        await Promise.all(rpcs);
        const before = (await f.store.read())!;
        assert.deepEqual(before.attempts[0].toolCalls, intents);
        assert.equal(
          before.attempts[0].toolCancellations?.length ?? 0,
          storage === "saved" ? 2 : 0,
        );
        assert.ok(before.attempts[0].toolCalls.every((row) => !row.repositoryObservation));
        assert.equal(h.native.replies.length, 0);
        const recovery = h.createAdapter();
        try {
          await f.runner(recovery).observe();
        } finally {
          await recovery.close();
        }
        assert.deepEqual((await f.store.read())!.attempts[0].toolCalls, intents);
        assert.equal(injected.mock.callCount(), 2);
        assert.equal(coreB, 0);
        assert.equal(h.native.writes.length, 1);
        assert.equal(h.native.replies.length, 0);
        finished = true;
      } finally {
        releaseB.resolve();
        releaseSave.resolve();
        releaseA.resolve();
        if (!finished) h.native.failure(new RuntimeError("UNKNOWN"));
        await Promise.allSettled([...rpcs, ...cancellations]);
        await interrupt?.catch(() => {});
        await run?.catch(() => {});
        injected.mock.restore();
        probe.mock.restore();
        await h.close();
        await f.close();
      }
    },
  );

for (const boundary of ["intent", "read", "cancellation-save"] as const)
  test(
    `should fence the real Claude runner automatic call at ${boundary} without awaiting its read`,
    { timeout: 6000 },
    async () => {
      const entered = deferred(),
        release = deferred(),
        claimed = deferred(),
        beginTool = deferred(),
        cancellationDone = deferred();
      const f = await runnerFixture(
        {
          drainTimeoutMs: 20,
          beforeMutation: async (kind) => {
            if (boundary === "intent" && kind === "tool-call-intent") {
              entered.resolve();
              await release.promise;
            }
            if (boundary === "cancellation-save" && kind === "native-tool-cancellation")
              throw new RuntimeError("UNSAFE_STORAGE");
          },
        },
        (record) => {
          Object.assign(record, claudeRecord(record));
          record.settings!.files = [];
          record.settings!.autoQuestionsConfirmed = false;
          record.settings!.repositoryAccess = createRepositoryAccess(
            record.context!.generation,
            record.context!.root,
            uuid(),
            uuid(),
          );
        },
      );
      const h = claudeHarness(f, f.record),
        execute = h.adapter.execute.bind(h.adapter);
      let current: AttemptAuthority | undefined;
      h.adapter.execute = (authority, settings, payload, beforeSubmit) => {
        current = authority;
        const tool = authority.tool;
        authority.tool = async (input) => {
          claimed.resolve();
          await beginTool.promise;
          return tool(input);
        };
        return execute(authority, settings, payload, async (intent) => {
          assert.ok(intent);
          h.captureIntent(intent);
          await beforeSubmit(intent);
        });
      };
      const original = RepositoryReader.prototype.read;
      const injected = mock.method(
        RepositoryReader.prototype,
        "read",
        async function (this: RepositoryReader, args: Parameters<typeof original>[0]) {
          const found = await original.call(this, args);
          entered.resolve();
          await release.promise;
          return found;
        },
      );
      let rpc: Promise<void> | undefined;
      h.native.onInput = async (input) => {
        await h.emit(input);
        await h.emit({ ...h.init(), tools: nativeToolNames("AUTO_CODE", false) });
        await h.emit(
          h.assistant(input, [
            {
              type: "tool_use",
              id: "auto-read",
              name: "mcp__ai_collaboration_scoped__read_workspace_file",
              input: { path: "public.txt" },
            },
          ]),
        );
        rpc = h.native.emit({
          type: "control_request",
          request_id: "auto-control",
          request: {
            subtype: "mcp_message",
            server_name: "ai_collaboration_scoped",
            message: {
              jsonrpc: "2.0",
              id: "auto-rpc",
              method: "tools/call",
              params: {
                name: "read_workspace_file",
                arguments: { path: "public.txt" },
                _meta: {
                  session_id: h.context.threadId,
                  user_message_uuid: input.uuid,
                  tool_use_id: "auto-read",
                },
              },
            },
          },
        });
        void rpc.catch(() => {});
      };
      h.native.onInterrupt = async () => {
        beginTool.resolve();
        await entered.promise;
        try {
          await h.native.emit({ type: "control_cancel_request", request_id: "auto-control" });
          cancellationDone.resolve();
        } catch (error) {
          cancellationDone.reject(error as Error);
          throw error;
        }
        return { still_queued: [], cancelled: [h.intent!.inputId] };
      };
      void cancellationDone.promise.catch(() => {});
      f.queue();
      const run = f.runner(h.adapter).run({ once: true });
      void run.catch(() => {});
      try {
        await claimed.promise;
        const interrupt = h.adapter.interrupt(current!);
        void interrupt.catch(() => {});
        await entered.promise;
        if (boundary === "intent") release.resolve();
        if (boundary === "cancellation-save") {
          await assert.rejects(cancellationDone.promise, { code: "UNSAFE_STORAGE" });
          await interrupt.catch(() => {});
          release.resolve();
          assert.equal((await run).state, "UNKNOWN");
        } else {
          await cancellationDone.promise;
          assert.equal(await interrupt, true);
          const disk = (await f.store.read())!;
          assert.ok(disk.attempts[0].toolCalls[0].repositoryIntent);
          assert.equal(disk.attempts[0].toolCancellations!.length, 1);
          assert.equal(disk.attempts[0].toolCalls[0].result, null);
          await h.emit(h.result(h.native.writes[0], streamingAbort));
          assert.equal((await run).state, "UPLOADED");
          release.resolve();
        }
        await rpc;
        const before = (await f.store.read())!;
        assert.ok(before.attempts[0].toolCalls[0].repositoryIntent);
        assert.equal(before.attempts[0].toolCalls[0].result, null);
        assert.equal(before.attempts[0].toolCalls[0].repositoryObservation, undefined);
        assert.equal(
          before.attempts[0].toolCancellations?.length ?? 0,
          boundary === "cancellation-save" ? 0 : 1,
        );
        assert.equal(injected.mock.callCount(), boundary === "intent" ? 0 : 1);
        assert.equal(h.native.replies.length, 0);
        const recovery = h.createAdapter();
        try {
          await f.runner(recovery).observe();
        } finally {
          await recovery.close();
        }
        const after = (await f.store.read())!;
        assert.deepEqual(after.attempts[0].toolCalls, before.attempts[0].toolCalls);
        assert.equal(injected.mock.callCount(), boundary === "intent" ? 0 : 1);
        assert.equal(h.native.writes.length, 1);
        assert.equal(h.native.replies.length, 0);
      } finally {
        beginTool.resolve();
        release.resolve();
        await rpc?.catch(() => {});
        await run.catch(() => {});
        injected.mock.restore();
        await h.close();
        await f.close();
      }
    },
  );

test("should count failed distinct automatic calls after dedup without resetting the budget", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter();
  const injected = mock.method(RepositoryReader.prototype, "read", RepositoryReader.prototype.read);
  try {
    adapter.executeHook = async (authority) => {
      const first = await ownedCall(
        f,
        authority,
        "read_workspace_file",
        { path: "../outside.ts" },
        "denied-0",
      );
      await assert.rejects(authority.tool(first), { code: "TOOL_REJECTED" });
      for (let i = 1; i < 256; i++)
        await assert.rejects(authority.tool({ ...first, callId: `denied-${i}` }), {
          code: "TOOL_REJECTED",
        });
      await assert.rejects(authority.tool(first), { code: "TOOL_REJECTED" });
      await assert.rejects(authority.tool({ ...first, arguments: { path: "public.txt" } }), {
        code: "TOOL_REJECTED",
      });
      await assert.rejects(
        authority.tool({ ...first, callId: "denied-256", arguments: { path: "public.txt" } }),
        { code: "RUNTIME_CAPACITY" },
      );
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(injected.mock.callCount(), 0);
    assert.equal((await f.store.read())!.attempts[0].toolCalls.length, 0);
  } finally {
    injected.mock.restore();
    await f.close();
  }
});

test("should reserve four automatic slots before intent storage and keep a failed fifth call deduplicated", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter(),
    entered = deferred(),
    release = deferred();
  const original = RepositoryReader.prototype.read;
  let reads = 0;
  const injected = mock.method(
    RepositoryReader.prototype,
    "read",
    async function (this: RepositoryReader, args: Parameters<typeof original>[0]) {
      const found = await original.call(this, args);
      if (++reads === 4) entered.resolve();
      await release.promise;
      return found;
    },
  );
  try {
    adapter.executeHook = async (authority) => {
      const first = await ownedCall(
        f,
        authority,
        "read_workspace_file",
        { path: "public.txt" },
        "concurrent-0",
      );
      const jobs = Array.from({ length: 4 }, (_, index) =>
        authority.tool({ ...first, callId: `concurrent-${index}` }),
      );
      void Promise.allSettled(jobs);
      await entered.promise;
      assert.equal((await f.store.read())!.attempts[0].toolCalls.length, 4);
      const fifth = { ...first, callId: "concurrent-4" };
      await assert.rejects(authority.tool(fifth), { code: "RUNTIME_BUSY" });
      release.resolve();
      await Promise.all(jobs);
      await assert.rejects(authority.tool(fifth), { code: "RUNTIME_BUSY" });
      await authority.tool({ ...first, callId: "concurrent-5" });
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(injected.mock.callCount(), 5);
  } finally {
    release.resolve();
    injected.mock.restore();
    await f.close();
  }
});

test("should reserve the full escaped automatic result and observation before I/O", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter();
  const injected = mock.method(RepositoryReader.prototype, "read", RepositoryReader.prototype.read);
  try {
    await writeFile(join(f.root, "escaped.ts"), '\\"\t\n'.repeat(10000), { mode: 0o644 });
    adapter.executeHook = async (authority) => {
      const input = await ownedCall(
        f,
        authority,
        "read_workspace_file",
        { path: "escaped.ts" },
        '\\"\t'.repeat(170),
      );
      const result = await authority.tool(input);
      const row = (await f.store.read())!.attempts[0].toolCalls[0];
      assert.ok(Buffer.byteLength(result.contentItems[0].text) <= 8192);
      assert.ok(Buffer.byteLength(JSON.stringify(row)) < 80896);
      assert.equal(
        row.repositoryObservation!.files[0].excerptHash,
        digest(Buffer.from(JSON.parse(result.contentItems[0].text).text)),
      );
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(injected.mock.callCount(), 1);
  } finally {
    injected.mock.restore();
    await f.close();
  }
});

test("should explore more than thirty two files and read code larger than the selected file bound", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter();
  try {
    for (let index = 0; index < 40; index++)
      await writeFile(
        join(f.root, `module-${index}.ts`),
        `export const value${index} = ${index};\n`,
        { mode: 0o644 },
      );
    await writeFile(
      join(f.root, "large.ts"),
      "const automaticEvidence = 1;\n" + "// public evidence\n".repeat(6000),
      { mode: 0o644 },
    );
    adapter.executeHook = async (authority) => {
      assert.equal(authority.peerTools, false);
      const listed = JSON.parse(
        (await authority.tool(await ownedCall(f, authority, "list_workspace_files", {})))
          .contentItems[0].text,
      );
      assert.equal(listed.entries.length, 42);
      const found = JSON.parse(
        (
          await authority.tool(
            await ownedCall(f, authority, "search_workspace", { query: "automaticEvidence" }),
          )
        ).contentItems[0].text,
      );
      assert.equal(found.matches[0].path, "large.ts");
      const first = JSON.parse(
        (
          await authority.tool(
            await ownedCall(f, authority, "read_workspace_file", { path: "large.ts" }),
          )
        ).contentItems[0].text,
      );
      assert.ok(first.size > 65536);
      assert.ok(first.nextOffset > 0);
      const second = JSON.parse(
        (
          await authority.tool(
            await ownedCall(f, authority, "read_workspace_file", {
              path: "large.ts",
              offset: first.nextOffset,
              expectedHash: first.hash,
            }),
          )
        ).contentItems[0].text,
      );
      assert.equal(second.hash, first.hash);
      assert.equal(second.byteStart, first.byteEnd);
      assert.equal(second.excerptHash, digest(Buffer.from(second.text)));
    };
    f.queue("PEER");
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(f.questionCount(), 0);
  } finally {
    await f.close();
  }
});

test(
  "should charge whole-file peer verification to the same reader byte budget as returned code",
  { timeout: 10000 },
  async () => {
    const f = await runnerFixture({}, automatic),
      adapter = new SyntheticAdapter();
    try {
      await writeFile(join(f.root, "budget.ts"), "// safe\n".repeat(262144).slice(0, -1), {
        mode: 0o644,
      });
      adapter.executeHook = async (authority) => {
        for (let index = 0; index < 12; index++)
          await authority.tool(
            await ownedCall(f, authority, "read_workspace_file", { path: "budget.ts" }),
          );
        await authority.tool(
          await ownedCall(f, authority, "ask_peer", {
            question: "Review bounded evidence",
            evidence: Array.from({ length: 4 }, (_, index) => ({
              path: "budget.ts",
              startLine: index + 1,
              endLine: index + 1,
            })),
          }),
        );
        await assert.rejects(
          authority.tool(
            await ownedCall(f, authority, "read_workspace_file", { path: "budget.ts" }),
          ),
          { code: "RUNTIME_CAPACITY" },
        );
      };
      f.queue();
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
      assert.equal(f.questionCount(), 1);
      const rows = (await f.store.read())!.attempts[0].toolCalls;
      assert.equal(rows.length, 14);
      assert.ok(rows.at(-1)!.repositoryIntent);
      assert.equal(rows.at(-1)!.result, null);
    } finally {
      await f.close();
    }
  },
);

test("should inspect secret material beyond the returned peer fragment before any question intent", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter();
  try {
    await writeFile(
      join(f.root, "unsafe.ts"),
      "// safe\n".repeat(10000) + "\npassword=synthetic-private-secret\n",
      { mode: 0o644 },
    );
    adapter.executeHook = async (authority) => {
      await assert.rejects(
        authority.tool(
          await ownedCall(f, authority, "ask_peer", {
            question: "Review evidence",
            evidence: [{ path: "unsafe.ts", startLine: 1, endLine: 1 }],
          }),
        ),
        { code: "TOOL_REJECTED" },
      );
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(f.questionCount(), 0);
    assert.equal((await f.store.read())!.attempts[0].toolCalls.length, 0);
  } finally {
    await f.close();
  }
});

async function waitFor(check: () => Promise<boolean>) {
  for (let index = 0; index < 200; index++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("SYNTHETIC_owned_storage_boundary_not_reached");
}

test(
  "should reject capacity before automatic I/O and preserve a real pending lease reservation",
  { timeout: 10000 },
  async () => {
    const options = { pollIntervalMs: 5, leaseIntervalMs: 60000 };
    const f = await runnerFixture(options, automatic),
      adapter = new SyntheticAdapter(),
      entered = deferred(),
      release = deferred();
    const runner = f.runner(adapter);
    const injected = mock.method(
      RepositoryReader.prototype,
      "read",
      RepositoryReader.prototype.read,
    );
    try {
      await writeFile(join(f.root, "capacity.ts"), "// safe evidence\n".repeat(1000), {
        mode: 0o644,
      });
      f.faults.before = async (action) => {
        if (action === "lease") {
          entered.resolve();
          await release.promise;
        }
      };
      adapter.executeHook = async (authority) => {
        while (Buffer.byteLength(await readFile(f.store.file)) < 350000)
          await authority.tool(
            await ownedCall(f, authority, "read_workspace_file", { path: "capacity.ts" }),
          );
        options.leaseIntervalMs = 1;
        await entered.promise;
        const before = (await f.store.read())!,
          lease = before.operations.filter((op) => op.action === "lease").at(-1)!;
        const reservations = (runner as unknown as { capacityReservations: Map<string, number> })
          .capacityReservations;
        assert.equal(reservations.get(lease.operationId), 131072);
        const reads = injected.mock.callCount(),
          calls = before.attempts[0].toolCalls.length;
        await assert.rejects(
          authority.tool(
            await ownedCall(f, authority, "read_workspace_file", { path: "capacity.ts" }),
          ),
          { code: "RUNTIME_CAPACITY" },
        );
        assert.equal(injected.mock.callCount(), reads);
        assert.equal((await f.store.read())!.attempts[0].toolCalls.length, calls);
        assert.equal(reservations.get(lease.operationId), 131072);
        options.leaseIntervalMs = 60000;
        release.resolve();
        await waitFor(async () => !reservations.has(lease.operationId));
        await authority.tool(
          await ownedCall(f, authority, "read_workspace_file", { path: "capacity.ts" }),
        );
      };
      f.queue();
      assert.equal((await runner.run({ once: true })).state, "UPLOADED");
    } finally {
      release.resolve();
      injected.mock.restore();
      await f.close();
    }
  },
);

for (const loss of ["generation", "scope", "fence", "lease", "credential"] as const)
  test(`should deny automatic ${loss} authority loss before code I/O`, async () => {
    const f = await runnerFixture({ pollIntervalMs: 60000, leaseIntervalMs: 60000 }, automatic),
      adapter = new SyntheticAdapter();
    const injected = mock.method(
      RepositoryReader.prototype,
      "read",
      RepositoryReader.prototype.read,
    );
    let checked = false;
    try {
      adapter.executeHook = async (authority) => {
        const input = await ownedCall(f, authority, "read_workspace_file", { path: "public.txt" });
        const context = structuredClone(authority.context),
          scope = structuredClone(authority.scope),
          snapshot = structuredClone(authority.attempt);
        if (loss === "generation") authority.context.generation = uuid();
        if (loss === "scope") authority.scope.bindingEpoch++;
        if (loss === "fence") authority.attempt.fence++;
        if (loss === "lease")
          authority.attempt.leaseExpiresAt = new Date(Date.now() - 1).toISOString();
        const profile = (await f.profile.read())!;
        if (loss === "credential") {
          const expired = structuredClone(profile);
          expired.credentialExpiresAt = new Date(Date.now() - 1000).toISOString();
          await f.profile.transaction(() => f.profile.write(expired));
        }
        try {
          await assert.rejects(authority.tool(input), {
            code: loss === "credential" || loss === "fence" ? "AUTHORITY_LOST" : "TOOL_REJECTED",
          });
        } finally {
          authority.context = context;
          authority.scope = scope;
          authority.attempt = snapshot;
          if (loss === "credential") await f.profile.transaction(() => f.profile.write(profile));
        }
        checked = true;
      };
      f.queue();
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
      assert.equal(checked, true);
      assert.equal(injected.mock.callCount(), 0);
    } finally {
      injected.mock.restore();
      await f.close();
    }
  });

test("should withhold automatic tools from an empty legacy selected scope", async () => {
  const f = await runnerFixture({}, (record) => {
      record.settings!.files = [];
    }),
    adapter = new SyntheticAdapter();
  const injected = mock.method(RepositoryReader.prototype, "read", RepositoryReader.prototype.read);
  try {
    adapter.executeHook = async (authority) => {
      await assert.rejects(
        authority.tool(await ownedCall(f, authority, "list_workspace_files", {})),
        { code: "TOOL_REJECTED" },
      );
      await assert.rejects(
        authority.tool(
          await ownedCall(f, authority, "read_workspace_file", { path: "public.txt" }),
        ),
        { code: "TOOL_REJECTED" },
      );
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(injected.mock.callCount(), 0);
  } finally {
    injected.mock.restore();
    await f.close();
  }
});

test("should preserve nullable automatic intent after terminal and reject its late result and stale callback", async () => {
  const f = await runnerFixture({ drainTimeoutMs: 20 }, automatic),
    adapter = new SyntheticAdapter(),
    entered = deferred(),
    release = deferred();
  const original = RepositoryReader.prototype.read;
  const injected = mock.method(
    RepositoryReader.prototype,
    "read",
    async function (this: RepositoryReader, args: Parameters<typeof original>[0]) {
      const value = await original.call(this, args);
      entered.resolve();
      await release.promise;
      return value;
    },
  );
  let pending: Promise<ToolResult> | undefined,
    input: ToolCall | undefined,
    authority: AttemptAuthority | undefined;
  try {
    adapter.executeHook = async (current) => {
      authority = current;
      input = await ownedCall(f, current, "read_workspace_file", { path: "public.txt" });
      pending = current.tool(input);
      void pending.catch(() => {});
      await entered.promise;
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    const bytes = await readFile(f.store.file);
    release.resolve();
    await assert.rejects(pending!);
    await assert.rejects(authority!.tool(input!));
    assert.deepEqual(await readFile(f.store.file), bytes);
    const row = (await f.store.read())!.attempts[0].toolCalls[0];
    assert.ok(row.repositoryIntent);
    assert.equal(row.result, null);
    assert.equal(row.repositoryObservation, undefined);
    assert.equal(injected.mock.callCount(), 1);
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    injected.mock.restore();
    await f.close();
  }
});

test("should accept the last line of a two MiB newline-only file while keeping byte bounds at two MiB", async () => {
  const f = await runnerFixture({}, automatic),
    adapter = new SyntheticAdapter();
  try {
    await writeFile(join(f.root, "lines.txt"), "\n".repeat(2097152), { mode: 0o644 });
    adapter.executeHook = async (authority) => {
      await authority.tool(
        await ownedCall(f, authority, "ask_peer", {
          question: "Review the final empty line",
          evidence: [{ path: "lines.txt", startLine: 2097153, endLine: 2097153 }],
        }),
      );
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    const file = (await f.store.read())!.attempts[0].toolCalls[0].peerEvidenceObservation!.files[0];
    assert.equal(file.lineCount, 2097153);
    assert.equal(file.startLine, 2097153);
    assert.equal(file.endLine, 2097153);
    assert.ok(file.byteEnd <= 2097152);
    assert.equal(f.questionCount(), 1);
  } finally {
    await f.close();
  }
});
