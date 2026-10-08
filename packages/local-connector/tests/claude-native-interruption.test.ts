import assert from "node:assert/strict";
import test from "node:test";
import { NativeInputProof, NATIVE_TOOL_NAMES, OWNED_SERVER } from "../src/claude/input-proof.ts";
import { checkpointNativeHistory } from "../src/claude/native-history-proof.ts";
import { capabilityHash } from "../src/settings/contracts.ts";
import {
  digest,
  stableJson,
  claudeInterruptRequest,
  type NativeInputIntent,
  type TerminalEvidence,
} from "../src/runtime-contracts.ts";
import {
  claudeFixture,
  nativeConversationHistory,
  interruptionProof,
  deferred,
} from "./claude-runtime-fixture.ts";
import { uuid } from "./runtime-fixture.ts";

async function interruptedConversation() {
  const f = await claudeFixture();
  const inputId = uuid(),
    prompt = "Synthetic interrupted read";
  const input = {
    type: "user",
    uuid: inputId,
    session_id: f.context.threadId,
    message: { role: "user", content: prompt },
  };
  const assistant = f.assistant(input, [
    {
      type: "tool_use",
      id: "owned-read",
      name: NATIVE_TOOL_NAMES[0],
      input: { path: "public.txt" },
    },
  ]);
  const intent: NativeInputIntent = {
    provider: "claude",
    sessionId: f.context.threadId,
    inputId,
    promptHash: digest(prompt),
    generation: f.context.generation,
    scope: f.authority.scope,
    attemptId: uuid(),
    fence: 1,
    policyFingerprint: f.context.materialization!.policyFingerprint,
  };
  const cancelledResult = {
    type: "user",
    uuid: uuid(),
    session_id: f.context.threadId,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "owned-read",
          is_error: true,
          content: "Synthetic native cancellation explanation",
        },
      ],
    },
  };
  const marker = {
    type: "user",
    uuid: uuid(),
    session_id: f.context.threadId,
    message: {
      role: "user",
      content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    },
  };
  const live = [input, assistant, cancelledResult, marker];
  const history = nativeConversationHistory(
    { ...f.history, materialized: true, records: live },
    "2.1.293",
  );
  const cancellation = {
    callId: "owned-read",
    controlId: "owned-control",
    cancelHash: digest(stableJson({ type: "control_cancel_request", request_id: "owned-control" })),
    payloadHash: digest(
      stableJson({
        threadId: f.context.threadId,
        turnId: inputId,
        callId: "owned-read",
        namespace: "ai_collaboration_scoped",
        tool: "read_workspace_file",
        arguments: { path: "public.txt" },
      }),
    ),
  };
  const terminal = {
    terminal: "INTERRUPTED",
    nativeInterruption: interruptionProof(intent, { still_queued: [] }),
    toolCancellations: [cancellation],
  } as Pick<TerminalEvidence, "terminal" | "nativeInterruption" | "toolCancellations">;
  const proof = new NativeInputProof(intent.sessionId, intent.inputId, intent.promptHash);
  proof.user(input);
  proof.assistant(assistant, true);
  proof.claim(
    "owned-control",
    {
      name: "read_workspace_file",
      arguments: { path: "public.txt" },
      _meta: { "claudecode/toolUseId": "owned-read" },
    },
    true,
    7,
  );
  proof.requestInterrupt();
  proof.cancelMcp({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } });
  return { f, intent, live, history, terminal, proof, cancelledResult, marker, cancellation };
}

test("should keep native cancellation records advisory after the matching typed interruption", async () => {
  const x = await interruptedConversation();
  try {
    assert.equal(x.proof.user(x.cancelledResult), "NATIVE_INTERRUPTION_ADVISORY");
    assert.equal(x.proof.user(x.marker), "NATIVE_INTERRUPTION_ADVISORY");
    assert.equal(x.proof.terminal, undefined);
    assert.equal(x.proof.receiptObserved, false);
    const checkpoint = checkpointNativeHistory(
      x.f.context,
      x.history,
      "2.1.293",
      x.intent,
      x.live,
      [],
      x.terminal,
    );
    assert.equal(checkpoint.state, "VERIFIED");
  } finally {
    await x.f.close();
  }
});

test("should bind stored native cancellation records without requiring their stdout replay", async () => {
  const x = await interruptedConversation();
  try {
    assert.equal(
      checkpointNativeHistory(
        x.f.context,
        x.history,
        "2.1.293",
        x.intent,
        x.live.slice(0, 2),
        [],
        x.terminal,
      ).state,
      "VERIFIED",
    );
  } finally {
    await x.f.close();
  }
});

test("should checkpoint and reopen an interrupted native MCP read after owned cleanup", async () => {
  const f = await claudeFixture();
  const entered = deferred<void>();
  const held = deferred<import("../src/runtime-contracts.ts").ToolResult>();
  f.settings.capabilities.version = "2.1.293";
  const { snapshotHash: previousHash, ...capability } = f.settings.capabilities;
  void previousHash;
  f.settings.capabilities.snapshotHash = capabilityHash({
    ...capability,
    runtime: "claude",
    policy: "verified",
  });
  f.context.materialization!.version = "2.1.293";
  const adapter = f.createAdapter({
    policy: {
      version: "2.1.293",
      fingerprint: f.context.materialization!.policyFingerprint,
      admit: async (_root, check) => check(),
      assertLive: (_root, check) => check(),
      launch: (owned) => ({ executable: "fixture-only", cwd: owned.root.path, args: [], env: {} }),
    },
    history: async () => nativeConversationHistory(f.history, "2.1.293"),
  });
  f.authority.tool = async () => {
    entered.resolve();
    return held.promise;
  };
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit({ ...f.init(), claude_code_version: "2.1.293" });
    await f.emit(
      f.assistant(input, [
        {
          type: "tool_use",
          id: "owned-read",
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
          id: 7,
          method: "tools/call",
          params: {
            name: "read_workspace_file",
            arguments: { path: "public.txt" },
            _meta: { "claudecode/toolUseId": "owned-read" },
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
        message: { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } },
      },
    });
    for (const content of [
      [
        {
          type: "tool_result",
          tool_use_id: "owned-read",
          is_error: true,
          content: "Synthetic native cancellation explanation",
        },
      ],
      [{ type: "text", text: "[Request interrupted by user for tool use]" }],
    ])
      await f.emit({
        type: "user",
        uuid: uuid(),
        session_id: f.context.threadId,
        message: { role: "user", content },
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
    const terminal = await executing;
    assert.equal(terminal.terminal, "INTERRUPTED");
    assert.equal(terminal.nativeHistory?.state, "VERIFIED");
    assert.equal(
      f.native.replies.some((reply) =>
        JSON.stringify(reply).includes("Synthetic native cancellation explanation"),
      ),
      false,
    );
    assert.equal(terminal.toolCancellations?.length, 1);
    f.context.materialization!.state = "MATERIALIZED";
    f.context.materialization!.initHash = terminal.nativeInitHash!;
    f.context.ownedTurns.push({
      turnId: f.intent!.inputId,
      terminal: terminal.terminal,
      promptHash: f.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: [],
      toolPolicy: f.intent!.toolPolicy,
      nativeHistory: terminal.nativeHistory,
      nativeInterruption: terminal.nativeInterruption,
      toolCancellations: terminal.toolCancellations,
    });
    await adapter.validate(f.context, f.settings, () => {});
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.controls.length, 1);
  } finally {
    held.resolve({ success: false, contentItems: [] });
    await adapter.close();
    await f.close();
  }
});

for (const [label, change] of [
  [
    "normal completion",
    (x: Awaited<ReturnType<typeof interruptedConversation>>) => {
      x.terminal.terminal = "COMPLETED";
    },
  ],
  [
    "missing durable interruption",
    (x: Awaited<ReturnType<typeof interruptedConversation>>) => {
      delete x.terminal.nativeInterruption;
    },
  ],
  [
    "foreign cancellation payload",
    (x: Awaited<ReturnType<typeof interruptedConversation>>) => {
      x.cancellation.payloadHash = digest("foreign");
    },
  ],
  [
    "foreign cancellation hash",
    (x: Awaited<ReturnType<typeof interruptedConversation>>) => {
      x.cancellation.cancelHash = digest("foreign");
    },
  ],
  [
    "foreign interruption input",
    (x: Awaited<ReturnType<typeof interruptedConversation>>) => {
      x.terminal.nativeInterruption!.intent.inputId = uuid();
      x.terminal.nativeInterruption!.intentHash = digest(
        stableJson(x.terminal.nativeInterruption!.intent),
      );
    },
  ],
  [
    "foreign interruption request",
    (x: Awaited<ReturnType<typeof interruptedConversation>>) => {
      x.terminal.nativeInterruption!.requestHash = digest(
        stableJson({ ...claudeInterruptRequest, cancel_queued: false }),
      );
    },
  ],
] as const) {
  test(`should reject native interruption records with ${label}`, async () => {
    const x = await interruptedConversation();
    try {
      change(x);
      assert.equal(
        checkpointNativeHistory(x.f.context, x.history, "2.1.293", x.intent, x.live, [], x.terminal)
          .state,
        "UNVERIFIED",
      );
    } finally {
      await x.f.close();
    }
  });
}
