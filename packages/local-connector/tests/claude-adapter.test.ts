import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeAdapter } from "../src/claude/adapter.ts";
import { OWNED_SERVER, NATIVE_TOOL_NAMES } from "../src/claude/input-proof.ts";
import { proveOwnedHistory } from "../src/claude/history-proof.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type NativeObservation,
  type NativeInterruption,
} from "../src/runtime-contracts.ts";
import { uuid } from "./runtime-fixture.ts";
import {
  claudeFixture as fixture,
  deferred,
  models,
  interruptionProof,
  streamingAbort,
} from "./claude-runtime-fixture.ts";
test("should require reviewed policy before any Claude child or input", async () => {
  const adapter = new ClaudeAdapter({
    transport: () => {
      throw new Error("must not spawn");
    },
  });
  await assert.rejects(
    adapter.capabilities("/synthetic", () => {}),
    { code: "POLICY_UNCONFIRMED" },
  );
});
test("should reserve a context before creation without submitting a native input", async () => {
  const f = await fixture();
  try {
    let reserved = false;
    const context = await f.adapter.prepare(
      f.context.root,
      f.settings,
      uuid(),
      1,
      () => {},
      async (created) => {
        assert.equal(created.materialization?.state, "RESERVED");
        reserved = true;
      },
    );
    assert.equal(reserved, true);
    assert.equal(context.ownedTurns.length, 0);
    assert.equal(f.starts, 0);
    assert.equal(f.native.writes.length, 0);
  } finally {
    await f.close();
  }
});
test("should send no input or spawn after input intent persistence fails", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.execute(async () => {
        throw new RuntimeError("UNSAFE_STORAGE");
      }),
      { code: "UNSAFE_STORAGE" },
    );
    assert.equal(f.starts, 0);
    assert.equal(f.native.writes.length, 0);
  } finally {
    await f.close();
  }
});
test("should accept delayed exact system init and persist ACK before terminal", async () => {
  const f = await fixture();
  try {
    const terminal = await f.execute();
    await f.ack.promise;
    assert.equal(terminal.terminal, "COMPLETED");
    assert.equal(terminal.turnId, f.intent!.inputId);
    assert.equal(terminal.nativeInitHash, digest(stableJson(f.history.records[1])));
    assert.equal(f.starts, 1);
    assert.equal(f.native.writes.length, 1);
  } finally {
    await f.close();
  }
});
test("should reject mismatched delayed identity and preserve an unconfirmed input", async () => {
  const f = await fixture();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit({ ...f.init(), cwd: "/foreign" });
  };
  try {
    await assert.rejects(f.execute(), { code: "CONTEXT_UNCONFIRMED" });
    assert.equal(f.native.writes.length, 1);
  } finally {
    await f.close();
  }
});
test("should deliver only product-authorized read tools after exact assistant correlation", async () => {
  const f = await fixture();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(
      f.assistant(input, [
        {
          type: "tool_use",
          id: "owned-tool",
          name: NATIVE_TOOL_NAMES[0],
          input: { path: "public.txt" },
        },
      ]),
    );
    await f.emit({
      type: "control_request",
      request_id: "owned-control",
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_workspace_file",
            arguments: { path: "public.txt" },
            _meta: {
              session_id: f.context.threadId,
              user_message_uuid: input.uuid,
              tool_use_id: "owned-tool",
            },
          },
        },
      },
    });
    await f.emit({
      type: "user",
      uuid: uuid(),
      session_id: f.context.threadId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "owned-tool",
            content: [{ type: "text", text: "Evidence" }],
            is_error: false,
          },
        ],
      },
    });
    await f.emit(f.result(input));
  };
  try {
    assert.equal((await f.execute()).terminal, "COMPLETED");
    assert.equal(f.tools.length, 1);
    assert.equal(f.tools[0].tool, "read_workspace_file");
    assert.equal(f.native.replies.length, 1);
  } finally {
    await f.close();
  }
});
test("should reject a tool control without its exact assistant tool-use", async () => {
  const f = await fixture();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit({
      type: "control_request",
      request_id: "foreign-control",
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_workspace_file", arguments: { path: "public.txt" } },
        },
      },
    });
  };
  try {
    await assert.rejects(f.execute(), { code: "TOOL_REJECTED" });
    assert.equal(f.tools.length, 0);
  } finally {
    await f.close();
  }
});
test("should prove the full exact input history after ACK loss without another native input", async () => {
  const f = await fixture();
  try {
    const terminal = await f.execute();
    const native: NativeObservation = {
      threadId: f.context.threadId,
      turnId: f.intent!.inputId,
      intent: f.intent,
      toolCalls: [],
    };
    const observed = await f.adapter.observe(f.context, f.settings, native, () => {});
    assert.equal(observed!.terminal, "COMPLETED");
    assert.equal(observed!.finalItems[0].hash, terminal.finalItems[0].hash);
    assert.equal(f.native.writes.length, 1);
    f.history.records.unshift({ ...f.history.records[0], uuid: uuid() });
    await assert.rejects(
      f.adapter.observe(f.context, f.settings, native, () => {}),
      { code: "CONTEXT_UNCONFIRMED" },
    );
    assert.equal(f.native.writes.length, 1);
  } finally {
    await f.close();
  }
});
test("should reject changed closed history before reusing a materialized context", async () => {
  const f = await fixture();
  try {
    const terminal = await f.execute();
    f.context.materialization = {
      ...f.context.materialization!,
      state: "MATERIALIZED",
      initHash: terminal.nativeInitHash!,
    };
    f.context.ownedTurns.push({
      turnId: f.intent!.inputId,
      terminal: "COMPLETED",
      ...(f.intent!.toolPolicy ? { toolPolicy: structuredClone(f.intent!.toolPolicy) } : {}),
      promptHash: f.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: [],
    });
    assert.equal(proveOwnedHistory(f.context, f.history, "2.1.287"), null);
    f.history.records[f.history.records.length - 1].result = "Forged answer";
    assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.287"), {
      code: "CONTEXT_UNCONFIRMED",
    });
  } finally {
    await f.close();
  }
});
test("should retain UNKNOWN on owned child cleanup failure despite a terminal", async () => {
  const f = await fixture();
  f.native.cleanupFailed = true;
  try {
    await assert.rejects(f.execute(), { code: "CLEANUP_INCOMPLETE" });
  } finally {
    await f.adapter.close().catch(() => {});
    await f.f.close();
  }
});
test("should cancel a held read tool without replying after an exact interrupt", async () => {
  const f = await fixture(),
    entered = deferred<void>(),
    held = deferred<import("../src/runtime-contracts.ts").ToolResult>(),
    closedBeforeReceipt = deferred<void>();
  f.authority.tool = async () => {
    entered.resolve();
    return held.promise;
  };
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(
      f.assistant(input, [
        {
          type: "tool_use",
          id: "held-tool",
          name: NATIVE_TOOL_NAMES[0],
          input: { path: "public.txt" },
        },
      ]),
    );
    await f.emit({
      type: "control_request",
      request_id: "held-control",
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_workspace_file",
            arguments: { path: "public.txt" },
            _meta: {
              session_id: f.context.threadId,
              user_message_uuid: input.uuid,
              tool_use_id: "held-tool",
            },
          },
        },
      },
    });
  };
  f.native.onInterrupt = async () => {
    await f.emit({ type: "control_cancel_request", request_id: "held-control" });
    await f.emit(
      f.result(f.native.writes[0], {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: ["Interrupted"],
      }),
    );
    await closedBeforeReceipt.promise;
    return { still_queued: [], cancelled: [f.intent!.inputId] };
  };
  try {
    const execution = f.execute();
    void execution.then(
      () => closedBeforeReceipt.resolve(),
      () => closedBeforeReceipt.resolve(),
    );
    await entered.promise;
    assert.equal(await f.adapter.interrupt(f.authority), true);
    const terminal = await execution;
    assert.equal(terminal.terminal, "INTERRUPTED");
    f.context.materialization = {
      ...f.context.materialization!,
      state: "MATERIALIZED",
      initHash: terminal.nativeInitHash!,
    };
    f.context.ownedTurns.push({
      turnId: terminal.turnId,
      terminal: "INTERRUPTED",
      ...(f.intent!.toolPolicy ? { toolPolicy: structuredClone(f.intent!.toolPolicy) } : {}),
      promptHash: f.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: [],
      toolCancellations: terminal.toolCancellations,
    });
    await f.adapter.validate(f.context, f.settings, () => {});
    const native = {
      threadId: f.context.threadId,
      turnId: f.intent!.inputId,
      intent: f.intent,
      toolCalls: [],
      toolCancellations: f.cancellations,
    };
    assert.equal(
      (await f.adapter.observe(f.context, f.settings, native, () => {}))!.terminal,
      "INTERRUPTED",
    );
    const original = f.context.ownedTurns[0].toolCancellations![0];
    original.payloadHash = digest("foreign tool payload");
    await assert.rejects(
      f.adapter.validate(f.context, f.settings, () => {}),
      { code: "CONTEXT_UNCONFIRMED" },
    );
    original.payloadHash = f.cancellations[0].payloadHash;
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.replies.length, 0);
    held.resolve({ success: true, contentItems: [{ type: "inputText", text: "Late evidence" }] });
    await Promise.resolve();
    assert.equal(f.native.replies.length, 0);
    f.native.onInput = async (input) => {
      await f.emit(input);
      await f.emit(f.init());
      await f.emit(f.assistant(input));
      await f.emit(f.result(input));
    };
    const resumed = await f.execute();
    assert.equal(resumed.terminal, "COMPLETED");
    assert.equal(resumed.threadId, terminal.threadId);
    assert.notEqual(resumed.turnId, terminal.turnId);
    assert.equal(f.native.writes.length, 2);
  } finally {
    held.resolve({ success: false, contentItems: [] });
    await f.close();
  }
});
test("should preserve normal completion racing a failed interrupt receipt", async () => {
  const f = await fixture(),
    entered = deferred<void>();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(f.assistant(input));
    entered.resolve();
  };
  f.native.onInterrupt = async () => {
    await f.emit(f.result(f.native.writes[0]));
    throw new RuntimeError("RUNTIME_CLOSED");
  };
  try {
    const execution = f.execute();
    await entered.promise;
    assert.equal(await f.adapter.interrupt(f.authority), false);
    assert.equal((await execution).terminal, "COMPLETED");
  } finally {
    await f.close();
  }
});

test("should preserve coalesced assistant and terminal frames while the durable ACK is pending", async () => {
  const f = await fixture(),
    gate = deferred<void>(),
    entered = deferred<void>();
  const acknowledge = f.authority.ack;
  f.authority.ack = async (...args) => {
    entered.resolve();
    await gate.promise;
    await acknowledge(...args);
  };
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await Promise.all([f.emit(f.assistant(input)), f.emit(f.result(input))]);
  };
  try {
    const execution = f.execute();
    await entered.promise;
    gate.resolve();
    assert.equal((await execution).terminal, "COMPLETED");
    assert.equal(f.native.writes.length, 1);
  } finally {
    gate.resolve();
    await f.close();
  }
});

for (const beforeAssistant of [false, true]) {
  test(`should preserve coalesced rate before ${beforeAssistant ? "assistant" : "terminal"} while the durable ACK is pending`, async () => {
    const f = await fixture(),
      gate = deferred<void>(),
      received = deferred<void>();
    const acknowledge = f.authority.ack;
    let acknowledged = false,
      finalized = false;
    f.authority.ack = async (...args) => {
      await gate.promise;
      await acknowledge(...args);
      acknowledged = true;
    };
    f.native.onInput = async (input) => {
      await f.emit(input);
      await f.emit(f.init());
      const rate = {
        type: "rate_limit_event",
        uuid: uuid(),
        session_id: f.context.threadId,
        rate_limit_info: {
          status: "allowed_warning",
          overageStatus: "rejected",
          limitScope: "group_pool",
        },
      };
      const first = beforeAssistant ? rate : f.assistant(input);
      const second = beforeAssistant ? f.assistant(input) : rate;
      const jobs = Promise.all([f.emit(first), f.emit(second), f.emit(f.result(input))]);
      received.resolve();
      await jobs;
    };
    try {
      const execution = f.execute().then((value) => {
        finalized = true;
        return value;
      });
      await received.promise;
      await Promise.resolve();
      assert.equal(acknowledged, false);
      assert.equal(finalized, false);
      assert.equal(f.tools.length, 0);
      assert.equal(f.native.replies.length, 0);
      assert.equal(f.native.controls.length, 0);
      gate.resolve();
      assert.equal((await execution).terminal, "COMPLETED");
      assert.equal(acknowledged, true);
      assert.equal(f.native.writes.length, 1);
      assert.equal(f.tools.length, 0);
    } finally {
      gate.resolve();
      await f.close();
    }
  });
}

test("should reject a rate arriving after a coalesced terminal even while the durable ACK is pending", async () => {
  const f = await fixture(),
    gate = deferred<void>(),
    received = deferred<void>();
  const acknowledge = f.authority.ack;
  f.authority.ack = async (...args) => {
    await gate.promise;
    await acknowledge(...args);
  };
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    const jobs = Promise.all([
      f.emit(f.assistant(input)),
      f.emit(f.result(input)),
      f.emit({
        type: "rate_limit_event",
        uuid: uuid(),
        session_id: f.context.threadId,
        rate_limit_info: { status: "allowed" },
      }),
    ]);
    received.resolve();
    await jobs;
  };
  try {
    const execution = f.execute();
    const rejected = assert.rejects(execution, { code: "UNKNOWN" });
    await received.promise;
    gate.resolve();
    await rejected;
    assert.equal(f.tools.length, 0);
    assert.equal(f.native.writes.length, 1);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("should reject coalesced rate and terminal when durable ACK storage fails", async () => {
  const f = await fixture(),
    gate = deferred<void>(),
    received = deferred<void>();
  f.authority.ack = async () => {
    await gate.promise;
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  };
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    const jobs = Promise.all([
      f.emit(f.assistant(input)),
      f.emit({
        type: "rate_limit_event",
        uuid: uuid(),
        session_id: f.context.threadId,
        rate_limit_info: { status: "allowed" },
      }),
      f.emit(f.result(input)),
    ]);
    received.resolve();
    await jobs;
  };
  try {
    const rejected = assert.rejects(f.execute(), { code: "CONTEXT_UNCONFIRMED" });
    await received.promise;
    gate.resolve();
    await rejected;
    assert.equal(f.tools.length, 0);
    assert.equal(f.native.replies.length, 0);
    assert.equal(f.native.controls.length, 0);
    assert.equal(f.native.writes.length, 1);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("should reject a changed native catalog before submitting the reserved input", async () => {
  const f = await fixture();
  f.native.request = async (body) =>
    body.subtype === "initialize"
      ? {
          models: [
            ...models.models,
            { value: "new-model", supportsEffort: false, isDefault: false },
          ],
        }
      : f.native.onInterrupt();
  try {
    await assert.rejects(f.execute(), { code: "UNSUPPORTED_SETTINGS" });
    assert.equal(f.native.writes.length, 0);
  } finally {
    await f.close();
  }
});

test("should retain UNKNOWN for a typed streaming abort without durable interruption evidence", async () => {
  const f = await fixture();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(f.assistant(input));
    await f.emit(
      f.result(input, {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        errors: ["Interrupted"],
      }),
    );
  };
  try {
    await f.execute().catch(() => {});
    const observed = await f.adapter
      .observe(
        f.context,
        f.settings,
        {
          threadId: f.context.threadId,
          turnId: f.intent!.inputId,
          intent: f.intent,
          toolCalls: [],
        },
        () => {},
      )
      .catch((error: unknown) => {
        assert.equal((error as RuntimeError).code, "UNKNOWN");
        return null;
      });
    assert.equal(observed, null);
    assert.equal(f.native.writes.length, 1);
  } finally {
    await f.close();
  }
});

async function streamingFixture() {
  const f = await fixture(),
    entered = deferred<void>();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.ack.promise;
    await f.emit(f.assistant(input));
    entered.resolve();
  };
  const execution = f.execute();
  void execution.catch(() => {});
  await entered.promise;
  return Object.assign(f, { execution });
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function closeStreaming(f: Awaited<ReturnType<typeof streamingFixture>>) {
  await f.emit(f.result(f.native.writes[0], streamingAbort)).catch(() => {});
  await f.execution.catch(() => {});
  await f.close();
}

test("should recover a tool-free interrupted input from its exact durable intent", async () => {
  const f = await streamingFixture();
  f.native.onInterrupt = async () => ({ still_queued: [], cancelled: [f.intent!.inputId] });
  let recovery: ClaudeAdapter | undefined;
  try {
    assert.equal(await f.adapter.interrupt(f.authority), true);
    await f.emit(f.result(f.native.writes[0], streamingAbort));
    const terminal = await f.execution;
    assert.equal(terminal.terminal, "INTERRUPTED");
    const proof = interruptionProof(f.intent!, {
      still_queued: [],
      cancelled: [f.intent!.inputId],
    });
    assert.deepEqual(terminal.nativeInterruption, proof);
    recovery = f.createAdapter();
    const candidate = {
      threadId: f.context.threadId,
      turnId: f.intent!.inputId,
      intent: f.intent,
      toolCalls: [],
      nativeInterruption: proof,
    };
    const observed = await recovery.observe(f.context, f.settings, candidate, () => {});
    assert.equal(observed!.terminal, "INTERRUPTED");
    assert.deepEqual(observed!.nativeInterruption, proof);
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.controls.length, 1);
  } finally {
    await recovery?.close();
    await closeStreaming(f);
  }
});

test("should validate the recovered closed history without a candidate", async () => {
  const f = await streamingFixture();
  let recovery: ClaudeAdapter | undefined;
  try {
    await f.adapter.interrupt(f.authority);
    await f.emit(f.result(f.native.writes[0], streamingAbort));
    const terminal = await f.execution;
    const proof = interruptionProof(f.intent!);
    f.context.materialization = {
      ...f.context.materialization!,
      state: "MATERIALIZED",
      initHash: terminal.nativeInitHash!,
    };
    f.context.ownedTurns.push({
      turnId: f.intent!.inputId,
      terminal: "INTERRUPTED",
      ...(f.intent!.toolPolicy ? { toolPolicy: structuredClone(f.intent!.toolPolicy) } : {}),
      promptHash: f.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: [],
      nativeInterruption: proof,
    });
    recovery = f.createAdapter();
    await recovery.validate(f.context, f.settings, () => {});
    assert.equal(proveOwnedHistory(f.context, f.history, "2.1.287"), null);
    assert.equal(f.native.writes.length, 1);
    for (const change of [
      (p: NativeInterruption) => {
        p.intent.attemptId = uuid();
      },
      (p: NativeInterruption) => {
        p.intent.scope.bindingEpoch++;
        p.intentHash = digest(stableJson(p.intent));
      },
      (p: NativeInterruption) => {
        p.intentHash = digest("foreign");
      },
      (p: NativeInterruption) => {
        p.requestHash = digest("foreign request");
      },
    ]) {
      const forged = structuredClone(f.context);
      change(forged.ownedTurns[0].nativeInterruption!);
      await assert.rejects(
        recovery.validate(forged, f.settings, () => {}),
        { code: "CONTEXT_UNCONFIRMED" },
      );
    }
  } finally {
    await recovery?.close();
    await closeStreaming(f);
  }
});

test("should persist interruption intent before native control and send no control after storage failure", async () => {
  for (const fails of [false, true]) {
    const f = await streamingFixture();
    let saves = 0;
    f.authority.interruption = async (proof) => {
      saves++;
      assert.equal(f.native.controls.length, proof.receipt ? 1 : 0);
      assert.deepEqual(
        proof,
        interruptionProof(f.intent!, proof.receipt ? { still_queued: [] } : undefined),
      );
      if (fails) throw new RuntimeError("UNSAFE_STORAGE");
      return "SAVED";
    };
    try {
      const interrupted = f.adapter.interrupt(f.authority);
      if (fails) await assert.rejects(interrupted, { code: "UNSAFE_STORAGE" });
      else assert.equal(await interrupted, true);
      assert.equal(saves, fails ? 1 : 2);
      assert.equal(f.native.controls.length, fails ? 0 : 1);
      assert.equal(f.native.writes.length, 1);
    } finally {
      await closeStreaming(f);
    }
  }
});

test("should coalesce repeated interruption calls for the same active input", async () => {
  const f = await streamingFixture(),
    receipt = deferred<unknown>();
  f.native.onInterrupt = () => receipt.promise;
  try {
    const first = f.adapter.interrupt(f.authority),
      second = f.adapter.interrupt(f.authority);
    void first.catch(() => {});
    void second.catch(() => {});
    await nextTurn();
    assert.equal(f.native.controls.length, 1);
    assert.equal(f.interruptions.length, 1);
    receipt.resolve({ still_queued: [] });
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(f.interruptions.length, 2);
    assert.equal(f.native.writes.length, 1);
  } finally {
    receipt.resolve({ still_queued: [] });
    await closeStreaming(f);
  }
});

for (const phase of ["intent", "receipt"] as const)
  for (const fails of [false, true]) {
    test(`should await already started ${phase} storage before sealing a received terminal when storage ${fails ? "fails" : "succeeds"}`, async () => {
      const f = await streamingFixture(),
        gate = deferred<void>();
      let saves = 0,
        terminalSettled = false;
      f.authority.interruption = async (proof) => {
        saves++;
        if ((phase === "intent" && !proof.receipt) || (phase === "receipt" && proof.receipt)) {
          await gate.promise;
          if (fails) throw new RuntimeError("UNSAFE_STORAGE");
        }
        return "SAVED";
      };
      const interrupted = f.adapter.interrupt(f.authority);
      void interrupted.catch(() => {});
      try {
        await nextTurn();
        assert.equal(saves, phase === "intent" ? 1 : 2);
        const result = f.emit(f.result(f.native.writes[0], streamingAbort));
        void result.catch(() => {});
        void f.execution.then(
          () => {
            terminalSettled = true;
          },
          () => {
            terminalSettled = true;
          },
        );
        await nextTurn();
        assert.equal(terminalSettled, false);
        gate.resolve();
        if (fails) {
          await assert.rejects(interrupted, { code: "UNSAFE_STORAGE" });
          await assert.rejects(f.execution, { code: "UNSAFE_STORAGE" });
          await result.catch(() => {});
        } else {
          await result;
          assert.equal((await f.execution).terminal, "INTERRUPTED");
          await interrupted;
        }
        assert.equal(f.native.controls.length, phase === "intent" ? 0 : 1);
      } finally {
        gate.resolve();
        await interrupted.catch(() => {});
        await closeStreaming(f);
      }
    });
  }

test("should preserve terminal-before-receipt without waiting for a future receipt or changing closed proof", async () => {
  const f = await streamingFixture(),
    receipt = deferred<unknown>();
  f.native.onInterrupt = () => receipt.promise;
  let interrupted: Promise<boolean> | undefined;
  try {
    interrupted = f.adapter.interrupt(f.authority);
    await nextTurn();
    await f.emit(f.result(f.native.writes[0], streamingAbort));
    const terminal = await f.execution,
      before = structuredClone(terminal);
    assert.equal(terminal.terminal, "INTERRUPTED");
    assert.deepEqual(terminal.nativeInterruption, interruptionProof(f.intent!));
    assert.equal(f.interruptions.length, 1);
    receipt.resolve({ still_queued: [], cancelled: [f.intent!.inputId] });
    assert.equal(await interrupted, true);
    assert.deepEqual(terminal, before);
    assert.equal(f.interruptions.length, 1);
    assert.equal(f.native.controls.length, 1);
  } finally {
    receipt.resolve({ still_queued: [] });
    await interrupted?.catch(() => {});
    await closeStreaming(f);
  }
});

test("should preserve receipt-before-terminal without adopting receipt as terminal evidence", async () => {
  const f = await streamingFixture();
  let settled = false;
  void f.execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    assert.equal(await f.adapter.interrupt(f.authority), true);
    await nextTurn();
    assert.equal(settled, false);
    assert.deepEqual(f.interruptions, [
      interruptionProof(f.intent!),
      interruptionProof(f.intent!, { still_queued: [] }),
    ]);
    await f.emit(f.result(f.native.writes[0], streamingAbort));
    assert.equal((await f.execution).terminal, "INTERRUPTED");
  } finally {
    await closeStreaming(f);
  }
});

test("should reject foreign or changed interruption evidence in the exact owned history", async () => {
  const f = await streamingFixture();
  let recovery: ClaudeAdapter | undefined;
  try {
    await f.adapter.interrupt(f.authority);
    await f.emit(f.result(f.native.writes[0], streamingAbort));
    await f.execution;
    recovery = f.createAdapter();
    const exact = interruptionProof(f.intent!, {
      still_queued: [],
      cancelled: [f.intent!.inputId],
    });
    for (const change of [
      (p: NativeInterruption) => {
        p.intent.inputId = uuid();
        p.intentHash = digest(stableJson(p.intent));
      },
      (p: NativeInterruption) => {
        p.intent.attemptId = uuid();
        p.intentHash = digest(stableJson(p.intent));
      },
      (p: NativeInterruption) => {
        p.intent.fence++;
        p.intentHash = digest(stableJson(p.intent));
      },
      (p: NativeInterruption) => {
        p.intentHash = digest("foreign intent");
      },
      (p: NativeInterruption) => {
        p.requestHash = digest("foreign request");
      },
      (p: NativeInterruption) => {
        p.receipt!.cancelled = [uuid()];
        p.receipt!.responseHash = digest(
          stableJson({ still_queued: [], cancelled: p.receipt!.cancelled }),
        );
      },
      (p: NativeInterruption) => {
        p.receipt!.responseHash = digest("foreign receipt");
      },
    ]) {
      const proof = structuredClone(exact);
      change(proof);
      await assert.rejects(
        recovery.observe(
          f.context,
          f.settings,
          {
            threadId: f.context.threadId,
            turnId: f.intent!.inputId,
            intent: f.intent,
            nativeInterruption: proof,
            toolCalls: [],
          },
          () => {},
        ),
        { code: "CONTEXT_UNCONFIRMED" },
      );
    }
    assert.equal(f.native.writes.length, 1);
  } finally {
    await recovery?.close();
    await closeStreaming(f);
  }
});

import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
import { nativeToolNames, repositoryTools } from "../src/workspace/tool-contracts.ts";

test("should advertise automatic tools and preserve exact policy through init tools and closed history", async () => {
  const f = await fixture();
  f.settings.files = [];
  f.settings.repositoryAccess = createRepositoryAccess(
    f.context.generation,
    f.context.root,
    uuid(),
    uuid(),
  );
  f.native.onInput = async (input) => {
    await f.emit({ ...f.init(), tools: nativeToolNames("AUTO_CODE", false) });
    await f.emit(input);
    await f.emit({
      type: "control_request",
      request_id: "list-tools",
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: { jsonrpc: "2.0", id: 0, method: "tools/list" },
      },
    });
    let index = 0;
    for (const [name, args] of [
      ["list_workspace_files", {}],
      ["search_workspace", { query: "function", directory: "src" }],
      [
        "read_workspace_file",
        { path: "src/unselected.ts", offset: 3, expectedHash: "a".repeat(64) },
      ],
    ] as const) {
      const toolId = `auto-${index++}`;
      await f.emit(
        f.assistant(input, [
          { type: "tool_use", id: toolId, name: `mcp__${OWNED_SERVER}__${name}`, input: args },
        ]),
      );
      await f.emit({
        type: "control_request",
        request_id: `control-${toolId}`,
        request: {
          subtype: "mcp_message",
          server_name: OWNED_SERVER,
          message: {
            jsonrpc: "2.0",
            id: index,
            method: "tools/call",
            params: {
              name,
              arguments: args,
              _meta: {
                session_id: f.context.threadId,
                user_message_uuid: input.uuid,
                tool_use_id: toolId,
              },
            },
          },
        },
      });
      await f.emit({
        type: "user",
        uuid: uuid(),
        session_id: f.context.threadId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolId,
              content: [{ type: "text", text: "Evidence" }],
              is_error: false,
            },
          ],
        },
      });
    }
    await f.emit(f.result(input));
  };
  try {
    const terminal = await f.execute();
    assert.deepEqual(f.intent!.toolPolicy, { version: 1, mode: "AUTO_CODE", peerAllowed: false });
    assert.deepEqual(
      f.tools.map((tool) => tool.tool),
      ["list_workspace_files", "search_workspace", "read_workspace_file"],
    );
    const advertised = f.native.replies[0] as { mcp_response: { result: { tools: unknown[] } } };
    assert.deepEqual(advertised.mcp_response.result.tools, repositoryTools("AUTO_CODE", [], false));
    f.context.materialization = {
      ...f.context.materialization!,
      state: "MATERIALIZED",
      initHash: terminal.nativeInitHash!,
    };
    f.context.ownedTurns.push({
      turnId: terminal.turnId,
      terminal: terminal.terminal,
      toolPolicy: structuredClone(f.intent!.toolPolicy),
      promptHash: f.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: f.tools.map((call) => ({
        callId: call.callId,
        payloadHash: digest(stableJson(call)),
        responseHash: digest(
          stableJson({ content: [{ type: "text", text: "Evidence" }], isError: false }),
        ),
      })),
    });
    assert.equal(proveOwnedHistory(f.context, f.history, "2.1.287", undefined, f.settings), null);
    assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.287"), {
      code: "CONTEXT_UNCONFIRMED",
    });
    const forged = structuredClone(f.context);
    forged.ownedTurns[0].toolPolicy!.peerAllowed = true;
    assert.throws(
      () =>
        proveOwnedHistory(
          forged,
          f.history,
          "2.1.287",
          {
            threadId: f.context.threadId,
            turnId: f.intent!.inputId,
            intent: f.intent,
            toolCalls: [],
          },
          f.settings,
        ),
      { code: "CONTEXT_UNCONFIRMED" },
    );
  } finally {
    await f.close();
  }
});

test("should withhold peer advertising for explicit origin denial and peer Claude inputs", async () => {
  for (const denial of ["authority", "absent-authority", "consent", "PEER"] as const) {
    const f = await fixture();
    Object.assign(f.authority.attempt.payload, {
      requestKind: denial === "PEER" ? "PEER" : "CONTINUATION",
      questionId: uuid(),
      replyText: denial === "PEER" ? null : "Verified answer",
    });
    f.authority.peerTools = denial === "absent-authority" ? undefined : denial !== "authority";
    if (denial === "consent") f.settings.autoQuestionsConfirmed = false;
    f.native.onInput = async (input) => {
      await f.emit(input);
      await f.emit(f.init());
      await f.emit(
        f.assistant(input, [
          {
            type: "tool_use",
            id: "forbidden-peer",
            name: `mcp__${OWNED_SERVER}__ask_peer`,
            input: {
              question: "Question",
              evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
            },
          },
        ]),
      );
    };
    try {
      await assert.rejects(f.execute(), { code: "TOOL_REJECTED" });
      assert.equal(f.intent!.toolPolicy!.peerAllowed, false);
      assert.equal(f.tools.length, 0);
    } finally {
      await f.close();
    }
  }
});

test("should verify selected history paths against immutable settings even for legacy descriptors", async () => {
  const f = await fixture();
  try {
    const terminal = await f.execute();
    const input = f.native.writes[0],
      callId = "foreign-selected-file";
    const args = { path: "src/unselected.ts" };
    const call = {
      threadId: f.context.threadId,
      turnId: f.intent!.inputId,
      callId,
      namespace: OWNED_SERVER,
      tool: "read_workspace_file",
      arguments: args,
    };
    const content = [{ type: "text", text: "Unselected evidence" }];
    f.history.records.splice(
      f.history.records.length - 1,
      0,
      f.assistant(input, [
        {
          type: "tool_use",
          id: callId,
          name: `mcp__${OWNED_SERVER}__read_workspace_file`,
          input: args,
        },
      ]),
      {
        type: "user",
        uuid: uuid(),
        session_id: f.context.threadId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: callId, content, is_error: false }],
        },
      },
    );
    f.context.materialization = {
      ...f.context.materialization!,
      state: "MATERIALIZED",
      initHash: terminal.nativeInitHash!,
    };
    f.context.ownedTurns.push({
      turnId: terminal.turnId,
      terminal: terminal.terminal,
      promptHash: f.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: [
        {
          callId,
          payloadHash: digest(stableJson(call)),
          responseHash: digest(stableJson({ content, isError: false })),
        },
      ],
    });
    assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.287", undefined, f.settings), {
      code: "TOOL_REJECTED",
    });
  } finally {
    await f.close();
  }
});

for (const kind of ["CONTINUATION", "RESUME"] as const)
  test(`should preserve peer advertisement and callback for an authorized ${kind} origin role`, async () => {
    const f = await fixture();
    Object.assign(f.authority.attempt.payload, {
      requestKind: kind,
      questionId: kind === "CONTINUATION" ? uuid() : null,
      replyText: kind === "CONTINUATION" ? "Verified peer answer" : null,
    });
    f.authority.peerTools = true;
    f.native.onInput = async (input) => {
      await f.emit(input);
      assert.equal(f.intent!.toolPolicy!.peerAllowed, true);
      await f.emit({ ...f.init(), tools: [...NATIVE_TOOL_NAMES] });
      await f.emit(
        f.assistant(input, [
          {
            type: "tool_use",
            id: "role-peer",
            name: NATIVE_TOOL_NAMES[1],
            input: {
              question: "Follow-up",
              evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
            },
          },
        ]),
      );
      await f.native.emit({
        type: "control_request",
        request_id: "role-control",
        request: {
          subtype: "mcp_message",
          server_name: OWNED_SERVER,
          message: {
            jsonrpc: "2.0",
            id: "role-rpc",
            method: "tools/call",
            params: {
              name: "ask_peer",
              arguments: {
                question: "Follow-up",
                evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
              },
              _meta: {
                session_id: f.context.threadId,
                user_message_uuid: input.uuid,
                tool_use_id: "role-peer",
              },
            },
          },
        },
      });
      await f.emit({
        type: "user",
        uuid: uuid(),
        session_id: f.context.threadId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "role-peer",
              content: [{ type: "text", text: "Evidence" }],
              is_error: false,
            },
          ],
        },
      });
      await f.emit(f.result(input));
    };
    try {
      const terminal = await f.execute();
      assert.equal(terminal.terminal, "COMPLETED");
      assert.equal(f.tools.length, 1);
    } finally {
      await f.close();
    }
  });
