import assert from "node:assert/strict";
import test from "node:test";
import { digest, type NativeInputIntent, type TerminalEvidence } from "../src/runtime-contracts.ts";
import type { OwnedHistory } from "../src/claude/owned-history.ts";
import { NativeInputProof, NATIVE_TOOL_NAMES, OWNED_SERVER } from "../src/claude/input-proof.ts";
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

function rateLimitEvent(sessionId: string) {
  return {
    type: "rate_limit_event",
    uuid: uuid(),
    session_id: sessionId,
    rate_limit_info: {
      status: "allowed_warning",
      resetsAt: 2000000000,
      rateLimitType: "seven_day",
      utilization: 0.9,
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.5, resetsAt: 1900000000 },
        seven_day: { utilization: 0.9, resetsAt: 2000000000 },
      },
    },
  };
}

test("should observe native rate limits without adopting a terminal or new input authority", async () => {
  const f = await claudeFixture();
  let finalized = false;
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(f.assistant(input));
    await f.emit(rateLimitEvent(f.context.threadId));
    await f.emit({
      ...rateLimitEvent(f.context.threadId),
      rate_limit_info: { status: "rejected" },
    });
    await Promise.resolve();
    assert.equal(finalized, false);
    assert.equal(f.tools.length, 0);
    assert.equal(f.native.writes.length, 1);
    await f.emit(f.result(input));
  };
  try {
    const terminal = await f.execute().then((value) => {
      finalized = true;
      return value;
    });
    assert.equal(terminal.terminal, "COMPLETED");
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.controls.length, 0);
  } finally {
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

// Replays the captured 2.1.293 wire shape with synthetic IDs and repository content only.
test("should claim native MCP tool-use metadata against the same assistant input", async () => {
  const f = await claudeFixture();
  const adapter = f.createAdapter({ history: async () => nativeHistory(f) });
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    await f.emit(
      f.assistant(input, [
        {
          type: "tool_use",
          id: "native-read-call",
          name: NATIVE_TOOL_NAMES[0],
          input: { path: "public.txt" },
        },
      ]),
    );
    await f.emit({
      type: "control_request",
      request_id: "native-read-control",
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "read_workspace_file",
            arguments: { path: "public.txt" },
            _meta: { "claudecode/toolUseId": "native-read-call", progressToken: 2 },
          },
        },
      },
    });
    await f.emit(rateLimitEvent(f.context.threadId));
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
            tool_use_id: "native-read-call",
            content: [{ type: "text", text: "Evidence" }],
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
    assert.equal(terminal.nativeHistory?.state, "VERIFIED");
    await f.ack.promise;
    assert.equal(f.tools.length, 1);
    assert.equal(f.tools[0].threadId, f.context.threadId);
    assert.equal(f.tools[0].turnId, f.intent!.inputId);
    assert.equal(f.tools[0].callId, "native-read-call");
    assert.deepEqual(f.tools[0].arguments, { path: "public.txt" });
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.replies.length, 1);
  } finally {
    await adapter.close();
    await f.close();
  }
});

function inputProof() {
  const sessionId = uuid(),
    inputId = uuid(),
    prompt = "Synthetic owned input";
  const proof = new NativeInputProof(sessionId, inputId, digest(prompt));
  const input = {
    type: "user",
    uuid: inputId,
    session_id: sessionId,
    message: { role: "user", content: prompt },
  };
  const assistant = {
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
          id: "native-read-call",
          name: NATIVE_TOOL_NAMES[0],
          input: { path: "public.txt" },
        },
      ],
    },
  };
  proof.user(input);
  proof.assistant(assistant, true);
  const params: Record<string, unknown> = {
    name: "read_workspace_file",
    arguments: { path: "public.txt" },
    _meta: { "claudecode/toolUseId": "native-read-call", progressToken: 2 },
  };
  return { proof, sessionId, inputId, input, assistant, params };
}

for (const progressToken of [undefined, 2, -2, "progress-2"]) {
  test(`should correlate native metadata with ${progressToken === undefined ? "no optional" : typeof progressToken} progress token`, () => {
    const f = inputProof();
    f.params._meta = {
      "claudecode/toolUseId": "native-read-call",
      ...(progressToken === undefined ? {} : { progressToken }),
    };
    const call = f.proof.claim("control-1", f.params, true);
    assert.equal(call.toolId, "native-read-call");
    assert.equal(call.name, "read_workspace_file");
    assert.deepEqual(call.args, { path: "public.txt" });
    assert.equal(f.proof.canRespond("control-1"), true);
    assert.equal(f.proof.terminal, undefined);
  });
}
test("should retain explicit session and input metadata correlation", () => {
  const f = inputProof();
  f.params._meta = {
    session_id: f.sessionId,
    user_message_uuid: f.inputId,
    tool_use_id: "native-read-call",
  };
  assert.equal(f.proof.claim("control-1", f.params, true).toolId, "native-read-call");
});

test("should reject an allowed peer tool name attached to a read tool ID", () => {
  const f = inputProof();
  f.params.name = "ask_peer";
  f.params.arguments = {
    question: "What does the evidence say?",
    evidence: [{ path: "public.txt", startLine: 1, endLine: 1 }],
  };
  assert.throws(() => f.proof.claim("control-1", f.params, true), { code: "UNKNOWN" });
  assert.equal(f.proof.canRespond("control-1"), false);
});

for (const meta of [
  null,
  [],
  {},
  { progressToken: 2 },
  { "claudecode/toolUseId": "" },
  { "claudecode/toolUseId": 2 },
]) {
  test(`should reject malformed native tool metadata ${JSON.stringify(meta)}`, () => {
    const f = inputProof();
    f.params._meta = meta;
    assert.throws(() => f.proof.claim("control-1", f.params, true), { code: "UNKNOWN" });
    assert.equal(f.proof.canRespond("control-1"), false);
  });
}
for (const [name, change, code] of [
  [
    "mixed formats",
    (f: ReturnType<typeof inputProof>) =>
      (f.params._meta = {
        "claudecode/toolUseId": "native-read-call",
        session_id: f.sessionId,
        user_message_uuid: f.inputId,
        tool_use_id: "native-read-call",
      }),
    "UNKNOWN",
  ],
  [
    "unknown metadata",
    (f: ReturnType<typeof inputProof>) =>
      (f.params._meta = { "claudecode/toolUseId": "native-read-call", unknown: true }),
    "UNKNOWN",
  ],
  [
    "foreign tool ID",
    (f: ReturnType<typeof inputProof>) =>
      (f.params._meta = { "claudecode/toolUseId": "foreign-call", progressToken: 2 }),
    "UNKNOWN",
  ],
  [
    "foreign explicit session",
    (f: ReturnType<typeof inputProof>) =>
      (f.params._meta = {
        session_id: uuid(),
        user_message_uuid: f.inputId,
        tool_use_id: "native-read-call",
      }),
    "UNKNOWN",
  ],
  [
    "stale explicit input",
    (f: ReturnType<typeof inputProof>) =>
      (f.params._meta = {
        session_id: f.sessionId,
        user_message_uuid: uuid(),
        tool_use_id: "native-read-call",
      }),
    "UNKNOWN",
  ],
  [
    "unknown explicit field",
    (f: ReturnType<typeof inputProof>) =>
      (f.params._meta = {
        session_id: f.sessionId,
        user_message_uuid: f.inputId,
        tool_use_id: "native-read-call",
        extra: true,
      }),
    "UNKNOWN",
  ],
  [
    "wrong name",
    (f: ReturnType<typeof inputProof>) => (f.params.name = "read_file"),
    "TOOL_REJECTED",
  ],
  [
    "wrong arguments",
    (f: ReturnType<typeof inputProof>) => (f.params.arguments = { path: "another.txt" }),
    "UNKNOWN",
  ],
  ["closed input", (f: ReturnType<typeof inputProof>) => f.proof.seal(), "TOOL_REJECTED"],
  [
    "interrupted input",
    (f: ReturnType<typeof inputProof>) => f.proof.requestInterrupt(),
    "TOOL_REJECTED",
  ],
] as const)
  test(`should reject native MCP claim with ${name}`, () => {
    const f = inputProof();
    change(f);
    assert.throws(() => f.proof.claim("control-1", f.params, true), { code });
    assert.equal(f.proof.canRespond("control-1"), false);
    assert.equal(f.proof.terminal, undefined);
  });
for (const progressToken of [
  null,
  true,
  {},
  [],
  1.5,
  NaN,
  Infinity,
  "",
  "x".repeat(201),
  undefined,
]) {
  test(`should reject malformed native progress token ${String(progressToken).slice(0, 12)}`, () => {
    const f = inputProof();
    f.params._meta = { "claudecode/toolUseId": "native-read-call", progressToken };
    assert.throws(() => f.proof.claim("control-1", f.params, true), { code: "UNKNOWN" });
    assert.equal(f.proof.canRespond("control-1"), false);
  });
}
test("should reject duplicate controls and replayed tool IDs before another host callback", () => {
  const f = inputProof();
  f.proof.claim("control-1", f.params, true);
  assert.throws(() => f.proof.claim("control-1", f.params, true), { code: "TOOL_REJECTED" });
  assert.throws(() => f.proof.claim("control-2", f.params, true), { code: "UNKNOWN" });
  f.proof.responseWritten("control-1");
  assert.throws(() => f.proof.claim("control-3", f.params, true), { code: "UNKNOWN" });
});
test("should keep metadata claims tied to ACK identity and the current assistant input", () => {
  const f = inputProof();
  assert.throws(() => f.proof.claim("control-1", f.params, false), { code: "TOOL_REJECTED" });
  const unanchored = new NativeInputProof(f.sessionId, f.inputId, digest("Synthetic owned input"));
  assert.throws(() => unanchored.claim("control-1", f.params, true), { code: "TOOL_REJECTED" });
  unanchored.user(f.input);
  assert.throws(() => unanchored.claim("control-1", f.params, true), { code: "TOOL_REJECTED" });
  assert.throws(() => unanchored.assistant({ ...f.assistant, user_message_uuid: uuid() }, true), {
    code: "UNKNOWN",
  });
  const next = inputProof();
  next.params._meta = { "claudecode/toolUseId": "old-read-call", progressToken: 2 };
  assert.throws(() => next.proof.claim("control-1", next.params, true), { code: "UNKNOWN" });
});
test("should prevent progress token reuse across active calls and allow it after the original reply", () => {
  const f = inputProof();
  f.proof.claim("control-1", f.params, true);
  const second = {
    ...f.assistant,
    uuid: uuid(),
    message: {
      role: "assistant",
      model: "claude-test",
      content: [
        {
          type: "tool_use",
          id: "read-2",
          name: NATIVE_TOOL_NAMES[0],
          input: { path: "another.txt" },
        },
      ],
    },
  };
  f.proof.assistant(second, true);
  const params = {
    name: "read_workspace_file",
    arguments: { path: "another.txt" },
    _meta: { "claudecode/toolUseId": "read-2", progressToken: 2 },
  };
  assert.throws(() => f.proof.claim("control-2", params, true), { code: "UNKNOWN" });
  f.proof.responseWritten("control-1");
  assert.equal(f.proof.claim("control-2", params, true).toolId, "read-2");
});
test("should refuse late tool response publication after the current input closes", async () => {
  const f = inputProof();
  f.proof.claim("control-1", f.params, true);
  const held = deferred<Record<string, unknown>>();
  let calls = 0;
  const reply = f.proof.response("control-1", async () => {
    calls++;
    return held.promise;
  });
  f.proof.seal();
  held.resolve({ content: [{ type: "text", text: "late" }] });
  await reply;
  assert.equal(calls, 1);
  assert.equal(f.proof.canRespond("control-1"), false);
  assert.throws(() => f.proof.responseWritten("control-1"), { code: "TOOL_REJECTED" });
});

for (const [name, change] of [
  ["foreign session", (frame: Record<string, unknown>) => (frame.session_id = uuid())],
  ["invalid UUID", (frame: Record<string, unknown>) => (frame.uuid = "not-a-uuid")],
  ["unknown envelope field", (frame: Record<string, unknown>) => (frame.extra = true)],
  [
    "malformed status",
    (frame: Record<string, unknown>) => (frame.rate_limit_info = { status: ["allowed"] }),
  ],
  [
    "unknown status",
    (frame: Record<string, unknown>) => (frame.rate_limit_info = { status: "unlimited" }),
  ],
  [
    "malformed window type",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = { status: "allowed", rateLimitType: ["five_hour"] }),
  ],
  [
    "unknown info field",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = { status: "allowed", permission: "allow" }),
  ],
  [
    "invalid reset",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = { status: "allowed", resetsAt: -1 }),
  ],
  [
    "invalid utilization",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = { status: "allowed", utilization: Infinity }),
  ],
  [
    "invalid boolean",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = { status: "allowed", isUsingOverage: "false" }),
  ],
  [
    "unknown unified window",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = {
        status: "allowed",
        unifiedWindows: { unlimited: { utilization: 0.5, resetsAt: 2000000000 } },
      }),
  ],
  [
    "missing unified reset",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: 0.5 } },
      }),
  ],
  [
    "negative unified utilization",
    (frame: Record<string, unknown>) =>
      (frame.rate_limit_info = {
        status: "allowed",
        unifiedWindows: { five_hour: { utilization: -1, resetsAt: 2000000000 } },
      }),
  ],
] as const)
  test(`should reject rate-limit observation with ${name}`, () => {
    const f = inputProof();
    const frame: Record<string, unknown> = rateLimitEvent(f.sessionId);
    change(frame);
    assert.throws(() => f.proof.rateLimit(frame, true), { code: "UNKNOWN" });
    assert.equal(f.proof.terminal, undefined);
    assert.equal(f.proof.open, true);
  });
test("should reject unverified unacknowledged and sealed rate-limit observations", () => {
  const f = inputProof();
  const frame = rateLimitEvent(f.sessionId);
  assert.throws(() => f.proof.rateLimit(frame, false), { code: "UNKNOWN" });
  const unanchored = new NativeInputProof(f.sessionId, f.inputId, digest("Synthetic owned input"));
  assert.throws(() => unanchored.rateLimit(frame, true), { code: "UNKNOWN" });
  const closed = inputProof();
  closed.proof.seal();
  assert.throws(() => closed.proof.rateLimit(rateLimitEvent(closed.sessionId), true), {
    code: "UNKNOWN",
  });
});

test("should observe rate limits before the first assistant without creating input authority", () => {
  const f = inputProof();
  const proof = new NativeInputProof(f.sessionId, f.inputId, digest("Synthetic owned input"));
  proof.user(f.input);
  const before = proof.metadata();
  proof.rateLimit(rateLimitEvent(f.sessionId), true);
  assert.deepEqual(proof.metadata(), before);
  assert.equal(proof.terminal, undefined);
  assert.equal(proof.open, true);
  assert.equal(proof.receiptObserved, false);
  assert.equal(proof.interruptRequested, false);
  assert.throws(() => proof.claim("control-1", f.params, true), { code: "TOOL_REJECTED" });
  assert.throws(() => proof.assistant(f.assistant, false), { code: "UNKNOWN" });
  assert.throws(() => proof.assistant({ ...f.assistant, user_message_uuid: uuid() }, true), {
    code: "UNKNOWN",
  });
  assert.throws(() => proof.receipt({ still_queued: [] }), { code: "UNKNOWN" });
  assert.throws(
    () =>
      proof.result(
        {
          type: "result",
          uuid: uuid(),
          session_id: f.sessionId,
          num_turns: 1,
          subtype: "success",
          is_error: false,
          result: "unanchored",
        },
        true,
      ),
    { code: "UNKNOWN" },
  );
  assert.equal(proof.terminal, undefined);
});

test("should observe rate limits after interrupt without creating tool or interruption authority", () => {
  const f = inputProof();
  f.proof.claim("control-1", f.params, true);
  f.proof.requestInterrupt();
  const before = f.proof.metadata();
  f.proof.rateLimit(rateLimitEvent(f.sessionId), true);
  assert.deepEqual(f.proof.metadata(), before);
  assert.equal(f.proof.terminal, undefined);
  assert.equal(f.proof.open, false);
  assert.equal(f.proof.receiptObserved, false);
  assert.deepEqual(f.proof.cancellationReceipts(), []);
  assert.throws(() => f.proof.claim("control-2", f.params, true), { code: "TOOL_REJECTED" });
  assert.throws(() => f.proof.assistant(f.assistant, true), { code: "TOOL_REJECTED" });
  assert.throws(() => f.proof.receipt({ still_queued: [f.inputId] }), { code: "UNKNOWN" });
  const interrupted = {
    type: "result",
    uuid: uuid(),
    session_id: f.sessionId,
    num_turns: 1,
    subtype: "error_during_execution",
    is_error: true,
    terminal_reason: "aborted_tools",
  };
  assert.throws(() => f.proof.result(interrupted, true), { code: "UNKNOWN" });
  assert.equal(f.proof.terminal, undefined);
  f.proof.receipt({ still_queued: [] });
  f.proof.cancel({ type: "control_cancel_request", request_id: "control-1" });
  assert.equal(f.proof.result(interrupted, true).kind, "INTERRUPTED");
  assert.throws(() => f.proof.rateLimit(rateLimitEvent(f.sessionId), true), { code: "UNKNOWN" });
  const sealed = inputProof();
  sealed.proof.requestInterrupt();
  sealed.proof.seal();
  assert.throws(() => sealed.proof.rateLimit(rateLimitEvent(sealed.sessionId), true), {
    code: "UNKNOWN",
  });
});
test("should bound rate observations reject replay and preserve over-cap utilization without completion", () => {
  const f = inputProof();
  const frame = rateLimitEvent(f.sessionId);
  frame.rate_limit_info.utilization = 1.2;
  f.proof.rateLimit(frame, true);
  assert.throws(() => f.proof.rateLimit(frame, true), { code: "UNKNOWN" });
  assert.throws(
    () => f.proof.rateLimit({ ...frame, rate_limit_info: { status: "allowed" } }, true),
    { code: "UNKNOWN" },
  );
  for (let i = 1; i < 64; i++) f.proof.rateLimit({ ...frame, uuid: uuid() }, true);
  assert.throws(() => f.proof.rateLimit({ ...frame, uuid: uuid() }, true), {
    code: "RUNTIME_CAPACITY",
  });
  assert.equal(f.proof.terminal, undefined);
  assert.equal(f.proof.open, true);
});

const sdkRateOptionalCases: readonly [string, readonly unknown[], readonly unknown[]][] = [
  ["overageStatus", ["allowed", "allowed_warning", "rejected"], ["unlimited", 1, ["allowed"]]],
  [
    "overageResetsAt",
    [0, 2000000000, Number.MAX_SAFE_INTEGER],
    [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "2000000000"],
  ],
  [
    "overageDisabledReason",
    [
      "overage_not_provisioned",
      "org_level_disabled",
      "org_level_disabled_until",
      "out_of_credits",
      "seat_tier_level_disabled",
      "member_level_disabled",
      "seat_tier_zero_credit_limit",
      "group_zero_credit_limit",
      "member_zero_credit_limit",
      "org_service_level_disabled",
      "no_limits_configured",
      "fetch_error",
      "unknown",
    ],
    ["org_spend_cap_reached", "unlimited", true, ["unknown"]],
  ],
  ["overageInUse", [true, false], [0, 1, "false", [false]]],
  [
    "surpassedThreshold",
    [0, 0.5, 1.2, Number.MAX_SAFE_INTEGER],
    [-1, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, "0.5"],
  ],
  ["limitScope", ["service", "channel", "group_pool"], ["organization", true, ["group_pool"]]],
  ["errorCode", ["credits_required"], ["unknown", 1, ["credits_required"]]],
  ["canUserPurchaseCredits", [true, false], [0, 1, "true", [true]]],
  ["hasChargeableSavedPaymentMethod", [true, false], [0, 1, "false", [false]]],
];

for (const [key, accepted, rejected] of sdkRateOptionalCases) {
  test(`should observe official SDK rate-limit optional field ${key} without authority changes`, () => {
    const f = inputProof();
    const before = f.proof.metadata();
    for (const value of accepted) {
      const frame = rateLimitEvent(f.sessionId);
      f.proof.rateLimit(
        { ...frame, rate_limit_info: { ...frame.rate_limit_info, [key]: value } },
        true,
      );
      assert.deepEqual(f.proof.metadata(), before);
      assert.equal(f.proof.terminal, undefined);
      assert.equal(f.proof.interruptRequested, false);
      assert.equal(f.proof.receiptObserved, false);
      assert.equal(f.proof.open, true);
    }
    assert.throws(
      () =>
        f.proof.claim(
          "foreign-control",
          { ...f.params, _meta: { "claudecode/toolUseId": "foreign-call" } },
          true,
        ),
      { code: "UNKNOWN" },
    );
    assert.equal(f.proof.claim("owned-control", f.params, true).toolId, "native-read-call");
  });

  test(`should reject null unknown and malformed SDK rate-limit optional field ${key}`, () => {
    const f = inputProof();
    for (const value of [null, undefined, {}, ...rejected]) {
      const frame = rateLimitEvent(f.sessionId);
      assert.throws(
        () =>
          f.proof.rateLimit(
            { ...frame, rate_limit_info: { ...frame.rate_limit_info, [key]: value } },
            true,
          ),
        { code: "UNKNOWN" },
      );
      assert.equal(f.proof.terminal, undefined);
      assert.equal(f.proof.open, true);
    }
  });
}

test("should observe combined official subscription overage and group fields before the typed result", async () => {
  const f = await claudeFixture();
  let finalized = false;
  f.native.onInput = async (input) => {
    await f.emit(input);
    await f.emit(f.init());
    const frame = rateLimitEvent(f.context.threadId);
    await f.emit({
      ...frame,
      rate_limit_info: {
        ...frame.rate_limit_info,
        overageStatus: "rejected",
        overageResetsAt: 2000000000,
        overageDisabledReason: "group_zero_credit_limit",
        overageInUse: false,
        surpassedThreshold: 1.2,
        limitScope: "group_pool",
        errorCode: "credits_required",
        canUserPurchaseCredits: true,
        hasChargeableSavedPaymentMethod: false,
      },
    });
    assert.equal(finalized, false);
    assert.equal(f.tools.length, 0);
    assert.equal(f.native.writes.length, 1);
    assert.equal(f.native.controls.length, 0);
    await f.emit(f.assistant(input));
    await f.emit(f.result(input));
  };
  try {
    const terminal = await f.execute().then((value) => {
      finalized = true;
      return value;
    });
    assert.equal(terminal.terminal, "COMPLETED");
    assert.equal(f.native.writes.length, 1);
  } finally {
    await f.close();
  }
});
