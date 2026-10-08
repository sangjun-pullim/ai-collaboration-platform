import assert from "node:assert/strict";
import test from "node:test";
import { NativeInputProof, NATIVE_TOOL_NAMES, OWNED_SERVER } from "../src/claude/input-proof.ts";
import { digest, stableJson } from "../src/runtime-contracts.ts";
import { uuid } from "./runtime-fixture.ts";
import { claudeFixture, deferred } from "./claude-runtime-fixture.ts";

function cancellation(requestId: string | number, reason?: string) {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, ...(reason === undefined ? {} : { reason }) },
  };
}

function ownedRead(requestId: string | number = 1) {
  const sessionId = uuid(),
    inputId = uuid(),
    prompt = "Synthetic owned cancellation";
  const proof = new NativeInputProof(sessionId, inputId, digest(prompt));
  proof.user({
    type: "user",
    uuid: inputId,
    session_id: sessionId,
    message: { role: "user", content: prompt },
  });
  proof.assistant(
    {
      type: "assistant",
      uuid: uuid(),
      session_id: sessionId,
      user_message_uuid: inputId,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        model: "claude-test",
        content: [
          {
            type: "tool_use",
            id: "owned-tool",
            name: NATIVE_TOOL_NAMES[0],
            input: { path: "public.txt" },
          },
        ],
      },
    },
    true,
  );
  const params = {
    name: "read_workspace_file",
    arguments: { path: "public.txt" },
    _meta: { "claudecode/toolUseId": "owned-tool" },
  };
  proof.claim("owned-control", params, true, requestId);
  return { proof, sessionId, inputId, params };
}

for (const requestId of [1, "1"]) {
  test(`should cancel only the owned interrupted MCP read with a ${typeof requestId} request ID`, () => {
    const f = ownedRead(requestId);
    f.proof.requestInterrupt();
    assert.equal(f.proof.cancelMcp(cancellation(requestId, "Synthetic abort")), "owned-control");
    assert.equal(f.proof.cancelled("owned-control"), true);
    assert.equal(f.proof.canRespond("owned-control"), false);
    assert.equal(
      f.proof.cancellationReceipts()[0].cancelHash,
      digest(stableJson({ type: "control_cancel_request", request_id: "owned-control" })),
    );
    assert.throws(() => f.proof.cancelMcp(cancellation(requestId)), { code: "UNKNOWN" });
  });
}

test("should reject MCP cancellation before a durable interruption intent", () => {
  const f = ownedRead();
  assert.throws(() => f.proof.cancelMcp(cancellation(1)), { code: "UNKNOWN" });
  assert.equal(f.proof.cancelled("owned-control"), false);
});

for (const [label, change] of [
  [
    "foreign request",
    (f: ReturnType<typeof cancellation>) => {
      f.params.requestId = 2;
    },
  ],
  [
    "different request ID type",
    (f: ReturnType<typeof cancellation>) => {
      f.params.requestId = "1";
    },
  ],
  [
    "extra message field",
    (f: ReturnType<typeof cancellation>) => {
      Object.assign(f, { inputId: uuid() });
    },
  ],
  [
    "extra parameter",
    (f: ReturnType<typeof cancellation>) => {
      Object.assign(f.params, { inputId: uuid() });
    },
  ],
  [
    "oversized reason",
    (f: ReturnType<typeof cancellation>) => {
      f.params.reason = "x".repeat(2049);
    },
  ],
  [
    "invalid request ID",
    (f: ReturnType<typeof cancellation>) => {
      f.params.requestId = 1.5;
    },
  ],
] as const) {
  test(`should reject a ${label} without cancelling an owned tool`, () => {
    const f = ownedRead(),
      frame = cancellation(1);
    f.proof.requestInterrupt();
    change(frame);
    assert.throws(() => f.proof.cancelMcp(frame), { code: "UNKNOWN" });
    assert.equal(f.proof.cancelled("owned-control"), false);
  });
}

test("should reject duplicate MCP request IDs and cancellation after replying", () => {
  const f = ownedRead();
  assert.throws(() => f.proof.claim("foreign-control", f.params, true, 1), { code: "UNKNOWN" });
  f.proof.responseWritten("owned-control");
  f.proof.requestInterrupt();
  assert.throws(() => f.proof.cancelMcp(cancellation(1)), { code: "UNKNOWN" });
  assert.equal(f.proof.cancelled("owned-control"), false);
});

test("should fence a held read when Claude sends the native MCP cancellation notification", async () => {
  const f = await claudeFixture(),
    entered = deferred<void>(),
    held = deferred<import("../src/runtime-contracts.ts").ToolResult>();
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
          id: 7,
          method: "tools/call",
          params: {
            name: "read_workspace_file",
            arguments: { path: "public.txt" },
            _meta: { "claudecode/toolUseId": "held-tool" },
          },
        },
      },
    });
  };
  f.native.onInterrupt = async () => {
    await f.emit({
      type: "control_request",
      request_id: "notification-control",
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: cancellation(7, "Synthetic abort"),
      },
    });
    await f.emit(
      f.result(f.native.writes[0], {
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_tools",
        errors: ["Interrupted"],
      }),
    );
    return { still_queued: [], cancelled: [f.intent!.inputId] };
  };
  try {
    const executing = f.execute();
    void executing.catch(() => {});
    await entered.promise;
    assert.equal(await f.adapter.interrupt(f.authority), true);
    const terminal = await executing;
    assert.equal(terminal.terminal, "INTERRUPTED");
    assert.equal(terminal.toolCancellations?.length, 1);
    assert.equal(f.cancellations[0].controlId, "held-control");
    assert.equal(f.native.writes.length, 1);
    held.resolve({ success: true, contentItems: [{ type: "inputText", text: "Late evidence" }] });
    await f.native.settleMessages();
    assert.equal(
      f.native.replies.some((reply: unknown) => JSON.stringify(reply).includes("Late evidence")),
      false,
    );
  } finally {
    held.resolve({ success: false, contentItems: [] });
    await f.close();
  }
});

for (const timing of ["after result receipt", "during ACK await"]) {
  test(`should reject late MCP cancellation ${timing} before extending terminal evidence`, async () => {
    const f = await claudeFixture();
    const readsEntered = deferred<void>(),
      firstStored = deferred<void>(),
      secondStored = deferred<void>();
    const firstSeen = deferred<void>(),
      observed = deferred<void>(),
      finishControl = deferred<void>();
    const held = deferred<import("../src/runtime-contracts.ts").ToolResult>();
    let reads = 0,
      stores = 0,
      lateRejected = false;
    f.authority.tool = async () => {
      if (++reads === 2) readsEntered.resolve();
      return held.promise;
    };
    f.authority.cancelledTool = async (proof) => {
      f.cancellations.push(structuredClone(proof));
      if (++stores === 1) {
        firstSeen.resolve();
        await firstStored.promise;
      } else await secondStored.promise;
    };
    const notify = (id: number) => ({
      type: "control_request",
      request_id: `notification-${id}`,
      request: { subtype: "mcp_message", server_name: OWNED_SERVER, message: cancellation(id) },
    });
    f.native.onInput = async (input) => {
      await f.emit(input);
      await f.emit(f.init());
      await f.emit(
        f.assistant(
          input,
          [1, 2].map((id) => ({
            type: "tool_use",
            id: `held-tool-${id}`,
            name: NATIVE_TOOL_NAMES[0],
            input: { path: "public.txt" },
          })),
        ),
      );
      for (const id of [1, 2]) {
        void f
          .emit({
            type: "control_request",
            request_id: `held-control-${id}`,
            request: {
              subtype: "mcp_message",
              server_name: OWNED_SERVER,
              message: {
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name: "read_workspace_file",
                  arguments: { path: "public.txt" },
                  _meta: { "claudecode/toolUseId": `held-tool-${id}` },
                },
              },
            },
          })
          .catch(() => {});
      }
    };
    f.native.onInterrupt = async () => {
      void f.emit(notify(1)).catch(() => {});
      await firstSeen.promise;
      const late = () => {
        void f.emit(notify(2)).catch(() => {
          lateRejected = true;
        });
      };
      if (timing === "during ACK await") late();
      void f
        .emit(
          f.result(f.native.writes[0], {
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_tools",
            errors: ["Interrupted"],
          }),
        )
        .catch(() => {});
      if (timing === "after result receipt") late();
      await new Promise<void>((resolve) => setImmediate(resolve));
      observed.resolve();
      await finishControl.promise;
      return { still_queued: [], cancelled: [f.intent!.inputId] };
    };
    try {
      const executing = f.execute();
      void executing.catch(() => {});
      await readsEntered.promise;
      const interrupting = f.adapter.interrupt(f.authority);
      void interrupting.catch(() => {});
      await observed.promise;
      assert.equal(lateRejected, true);
      assert.equal(stores, 1);
      firstStored.resolve();
      finishControl.resolve();
      const outcomes = await Promise.allSettled([executing, interrupting]);
      assert.equal(outcomes[0].status, "rejected");
      assert.equal(f.cancellations.length, 1);
      assert.equal(f.native.writes.length, 1);
    } finally {
      firstStored.resolve();
      secondStored.resolve();
      finishControl.resolve();
      held.resolve({ success: false, contentItems: [] });
      await f.close();
    }
  });
}
