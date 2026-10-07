import assert from "node:assert/strict";
import test from "node:test";
import { digest, type NativeInputIntent, type TerminalEvidence } from "../src/runtime-contracts.ts";
import type { OwnedHistory } from "../src/claude/owned-history.ts";
import { NATIVE_TOOL_NAMES, OWNED_SERVER } from "../src/claude/input-proof.ts";
import { uuid } from "./runtime-fixture.ts";
import {
  claudeFixture,
  deferred,
  nativeConversationHistory,
  streamingAbort,
} from "./claude-runtime-fixture.ts";

for (const matches of [true, false]) {
  test(`should ${matches ? "verify" : "reject"} native history tool results against the host reply`, async () => {
    const f = await claudeFixture();
    const adapter = f.createAdapter({ history: async () => nativeHistory(f) });
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
              content: [{ type: "text", text: matches ? "Evidence" : "Forged evidence" }],
              is_error: false,
            },
          ],
        },
      });
      await f.emit(f.result(input));
    };
    try {
      const terminal = await adapter.execute(
        f.authority,
        f.settings,
        f.authority.attempt.payload,
        async (intent) => {
          assert.ok(intent);
          f.captureIntent(intent);
        },
      );
      assert.equal(terminal.terminal, "COMPLETED");
      assert.equal(terminal.nativeHistory?.state, matches ? "VERIFIED" : "UNVERIFIED");
      assert.equal(f.native.writes.length, 1);
    } finally {
      await adapter.close();
      await f.close();
    }
  });
}

function nativeHistory(f: Awaited<ReturnType<typeof claudeFixture>>): OwnedHistory {
  return nativeConversationHistory(f.history, "2.1.287");
}
function closeTurn(
  f: Awaited<ReturnType<typeof claudeFixture>>,
  terminal: TerminalEvidence,
  intent: NativeInputIntent,
) {
  f.context.materialization!.state = "MATERIALIZED";
  f.context.materialization!.initHash = terminal.nativeInitHash!;
  f.context.ownedTurns.push({
    turnId: intent.inputId,
    terminal: terminal.terminal,
    promptHash: intent.promptHash,
    resultHash: terminal.finalItems[0].hash,
    toolReceipts: [],
    nativeHistory: terminal.nativeHistory,
    toolPolicy: intent.toolPolicy,
    ...(terminal.nativeInterruption ? { nativeInterruption: terminal.nativeInterruption } : {}),
    ...(terminal.toolCancellations ? { toolCancellations: terminal.toolCancellations } : {}),
  });
}

test("should checkpoint a native reply and resume the next question in the same context", async () => {
  const f = await claudeFixture();
  const adapter = f.createAdapter({ history: async () => nativeHistory(f) });
  const execute = () =>
    adapter.execute(f.authority, f.settings, f.authority.attempt.payload, async (intent) => {
      assert.ok(intent);
      f.captureIntent(intent);
    });
  try {
    // ACK writes the host record, not this authority clone; the first checkpoint must still work.
    const first = await execute();
    assert.equal(f.context.materialization!.state, "RESERVED");
    assert.equal(first.terminal, "COMPLETED");
    assert.equal(first.nativeHistory?.state, "VERIFIED");
    closeTurn(f, first, f.intent!);
    const originalSession = f.context.threadId;
    const second = await execute();
    assert.equal(second.terminal, "COMPLETED");
    assert.equal(second.nativeHistory?.state, "VERIFIED");
    assert.equal(first.threadId, originalSession);
    assert.equal(second.threadId, originalSession);
    assert.notEqual(first.turnId, second.turnId);
    closeTurn(f, second, f.intent!);
    await adapter.validate(f.context, f.settings, () => {});
    assert.equal(f.native.writes.length, 2);
  } finally {
    await adapter.close();
    await f.close();
  }
});

for (const problem of ["missing", "read rejected", "different live content"] as const) {
  test(`should preserve a live reply when native history is ${problem}`, async () => {
    const f = await claudeFixture();
    let reads = 0;
    const adapter = f.createAdapter({
      history: async () => {
        const history = nativeHistory(f);
        if (++reads === 1) return history;
        if (problem === "read rejected") throw new Error("synthetic unavailable history");
        if (problem === "missing") return { ...history, materialized: false, records: [] };
        (history.records[1].message as Record<string, unknown>).content = [
          { type: "text", text: "different" },
        ];
        return history;
      },
    });
    try {
      const terminal = await adapter.execute(
        f.authority,
        f.settings,
        f.authority.attempt.payload,
        async (intent) => {
          assert.ok(intent);
          f.captureIntent(intent);
        },
      );
      assert.equal(terminal.terminal, "COMPLETED");
      assert.equal(terminal.privateText, "Answer");
      assert.equal(terminal.textProof, "FINAL_ANSWER");
      assert.equal(terminal.nativeHistory?.state, "UNVERIFIED");
      closeTurn(f, terminal, f.intent!);
      await assert.rejects(
        adapter.execute(f.authority, f.settings, f.authority.attempt.payload, async () =>
          assert.fail("must not send a new input"),
        ),
        problem === "read rejected"
          ? /synthetic unavailable history/
          : { code: "CONTEXT_UNCONFIRMED" },
      );
      assert.equal(f.native.writes.length, 1);
    } finally {
      await adapter.close();
      await f.close();
    }
  });
}

test("should keep a native assistant without a durable terminal unknown", async () => {
  const f = await claudeFixture();
  const adapter = f.createAdapter({ history: async () => nativeHistory(f) });
  try {
    const terminal = await adapter.execute(
      f.authority,
      f.settings,
      f.authority.attempt.payload,
      async (intent) => {
        assert.ok(intent);
        f.captureIntent(intent);
      },
    );
    f.context.materialization!.state = "MATERIALIZED";
    f.context.materialization!.initHash = terminal.nativeInitHash!;
    assert.equal(
      await adapter.observe(
        f.context,
        f.settings,
        {
          threadId: f.context.threadId,
          turnId: f.intent!.inputId,
          intent: f.intent,
        },
        () => {},
      ),
      null,
    );
    assert.equal(f.native.writes.length, 1);
    assert.equal(digest(terminal.privateText), digest("Answer"));
  } finally {
    await adapter.close();
    await f.close();
  }
});

test("should checkpoint an exact interrupted native input without replaying it", async () => {
  const f = await claudeFixture();
  const adapter = f.createAdapter({ history: async () => nativeHistory(f) });
  const entered = deferred<void>();
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(f.assistant(input));
    entered.resolve();
  };
  const executing = adapter.execute(
    f.authority,
    f.settings,
    f.authority.attempt.payload,
    async (intent) => {
      assert.ok(intent);
      f.captureIntent(intent);
    },
  );
  void executing.catch(() => {});
  try {
    await entered.promise;
    assert.equal(await adapter.interrupt(f.authority), true);
    await f.emit(f.result(f.native.writes[0], streamingAbort));
    const terminal = await executing;
    assert.equal(terminal.terminal, "INTERRUPTED");
    assert.equal(terminal.nativeHistory?.state, "VERIFIED");
    assert.equal(terminal.privateText, "");
    closeTurn(f, terminal, f.intent!);
    await adapter.validate(f.context, f.settings, () => {});
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.controls.length, 1);
  } finally {
    await adapter.close();
    await f.close();
  }
});
