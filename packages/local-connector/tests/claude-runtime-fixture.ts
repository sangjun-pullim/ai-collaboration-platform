import assert from "node:assert/strict";
import { nativeToolNames } from "../src/workspace/tool-contracts.ts";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "../src/claude/adapter.ts";
import { OWNED_SERVER, NATIVE_TOOL_NAMES } from "../src/claude/input-proof.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type AttemptAuthority,
  type NativeInputIntent,
  type ToolCall,
} from "../src/runtime-contracts.ts";
import type { Launch, Cleanup } from "../src/claude/transport.ts";
import type { ClaudePolicy } from "../src/claude/policy.ts";
import type { OwnedHistory } from "../src/claude/owned-history.ts";
import { runtimeFixture, uuid } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";

export type Frame = Record<string, unknown>;
export const models = {
  models: [{ value: "claude-test", supportsEffort: false, isDefault: true }],
};
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export class FakeTransport {
  handler!: (frame: Frame, signal: AbortSignal) => Promise<void>;
  failure!: (error: RuntimeError) => void;
  readonly signal = new AbortController();
  readonly writes: Frame[] = [];
  readonly replies: unknown[] = [];
  readonly controls: Frame[] = [];
  readonly jobs: Promise<void>[] = [];
  cleanupFailed = false;
  onInput: (frame: Frame) => Promise<void> = async () => {};
  onInterrupt: () => Promise<unknown> = async () => ({ still_queued: [] });
  setHandler(handler: FakeTransport["handler"], failure: FakeTransport["failure"]) {
    this.handler = handler;
    this.failure = failure;
  }
  async request(body: Frame) {
    if (body.subtype === "initialize") return models;
    this.controls.push(structuredClone(body));
    return this.onInterrupt();
  }
  async reply(_id: string, response: unknown) {
    this.replies.push(response);
  }
  async write(frame: Frame) {
    this.writes.push(structuredClone(frame));
    const job = this.onInput(frame).catch((error) =>
      this.failure(error instanceof RuntimeError ? error : new RuntimeError("UNKNOWN")),
    );
    this.jobs.push(job);
  }
  async emit(frame: Frame) {
    try {
      await this.handler(frame, this.signal.signal);
    } catch (error) {
      this.failure(error instanceof RuntimeError ? error : new RuntimeError("UNKNOWN"));
      throw error;
    }
  }
  async settleMessages() {
    await Promise.allSettled(this.jobs);
  }
  async close(): Promise<Cleanup> {
    this.signal.abort();
    await this.settleMessages();
    return {
      code: this.cleanupFailed ? "CLEANUP_INCOMPLETE" : "REAPED",
      reaped: !this.cleanupFailed,
    };
  }
}
export function claudeHarness(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  record = claudeRecord(f.record),
  ownedHistory?: OwnedHistory,
) {
  const context = record.context!,
    settings = record.settings!;
  const native = new FakeTransport(),
    history: OwnedHistory = ownedHistory ?? {
      materialized: false,
      sessionId: context.threadId,
      root: f.root,
      records: [],
    };
  let starts = 0,
    intent: NativeInputIntent | undefined;
  const ack = deferred<void>(),
    tools: ToolCall[] = [];
  const payload = {
    requestId: uuid(),
    cycleId: uuid(),
    agentId: f.scope.agentId,
    bindingEpoch: 1,
    roomRevision: 1,
    requestKind: "ORIGIN" as const,
    questionId: null,
    publicText: "Question",
    replyText: null,
    deadline: new Date(Date.now() + 60000).toISOString(),
  };
  const interruptions: import("../src/runtime-contracts.ts").NativeInterruption[] = [];
  const cancellations: import("../src/runtime-contracts.ts").NativeToolCancellation[] = [];
  const authority: AttemptAuthority = {
    scope: f.scope,
    context,
    attempt: {
      requestId: payload.requestId,
      attemptId: uuid(),
      agentId: f.scope.agentId,
      bindingEpoch: 1,
      fence: 1,
      state: "EXECUTING",
      leaseExpiresAt: payload.deadline,
      startIntentAt: new Date().toISOString(),
      payload,
    },
    signal: new AbortController().signal,
    assertLive: () => {},
    ack: async (session, input, hash) => {
      assert.equal(session, context.threadId);
      assert.equal(input, intent!.inputId);
      assert.ok(hash);
      ack.resolve();
    },
    interruption: async (proof) => {
      interruptions.push(structuredClone(proof));
      return "SAVED";
    },
    cancelledTool: async (proof) => {
      cancellations.push(structuredClone(proof));
    },
    tool: async (call) => {
      tools.push(call);
      return { success: true, contentItems: [{ type: "inputText", text: "Evidence" }] };
    },
  };
  const policy: ClaudePolicy = {
    version: "2.1.287",
    fingerprint: context.materialization!.policyFingerprint,
    admit: async (_root, check) => check(),
    assertLive: (_root, check) => check(),
    launch: (owned) => ({
      executable: "fixture-only",
      cwd: owned.root.path,
      args: ["fixture-only"],
      env: {},
    }),
  };
  const createAdapter = (overrides: Partial<ClaudeAdapterOptions> = {}) =>
    new ClaudeAdapter({
      policy,
      history: async () => structuredClone(history),
      transport: (launch: Launch) => {
        assert.equal(launch.cwd, f.root);
        assert.ok(intent);
        starts++;
        return native;
      },
      ...overrides,
    });
  const adapter = createAdapter();
  const init = () => ({
    type: "system",
    subtype: "init",
    uuid: uuid(),
    session_id: context.threadId,
    cwd: f.root,
    claude_code_version: policy.version,
    permissionMode: "dontAsk",
    model: "claude-test",
    tools: intent?.toolPolicy
      ? nativeToolNames(intent.toolPolicy.mode, intent.toolPolicy.peerAllowed)
      : [NATIVE_TOOL_NAMES[0]],
    plugins: [],
    mcp_servers: [{ name: OWNED_SERVER, source: "sdk", status: "connected" }],
  });
  const assistant = (input: Frame, content: unknown[] = [{ type: "text", text: "Answer" }]) => ({
    type: "assistant",
    uuid: uuid(),
    session_id: context.threadId,
    user_message_uuid: input.uuid,
    parent_tool_use_id: null,
    message: { role: "assistant", model: "claude-test", content },
  });
  const result = (input: Frame, extra: Frame = {}) => ({
    type: "result",
    uuid: uuid(),
    session_id: context.threadId,
    user_message_uuid: input.uuid,
    parent_tool_use_id: null,
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "Answer",
    ...extra,
  });
  const emit = async (frame: Frame) => {
    if (frame.type !== "control_request" && frame.type !== "control_cancel_request") {
      history.materialized = true;
      history.records.push(structuredClone(frame));
    }
    await native.emit(frame);
  };
  native.onInput = async (input) => {
    await emit(input);
    await emit(init());
    await emit(assistant(input));
    await emit(result(input));
  };
  const execute = (before: (value: NativeInputIntent) => Promise<void> = async () => {}) =>
    adapter.execute(authority, settings, payload, async (value) => {
      assert.ok(value);
      intent = value;
      await before(value);
    });
  return {
    f,
    record,
    context,
    settings,
    authority,
    adapter,
    native,
    history,
    ack,
    tools,
    cancellations,
    interruptions,
    createAdapter,
    captureIntent: (value: NativeInputIntent) => {
      intent = value;
    },
    init,
    assistant,
    result,
    emit,
    execute,
    get intent() {
      return intent;
    },
    get starts() {
      return starts;
    },
    close: async () => {
      await adapter.close();
    },
  };
}

export function interruptionProof(
  intent: NativeInputIntent,
  receipt?: { still_queued: []; cancelled?: string[] },
): import("../src/runtime-contracts.ts").NativeInterruption {
  const proof: import("../src/runtime-contracts.ts").NativeInterruption = {
    intent: structuredClone(intent),
    intentHash: digest(stableJson(intent)),
    requestHash: digest(stableJson({ subtype: "interrupt", cancel_queued: true })),
  };
  if (receipt) {
    const cancelled = receipt.cancelled ?? [];
    proof.receipt = {
      stillQueued: [],
      cancelled,
      responseHash: digest(stableJson({ still_queued: [], cancelled })),
    };
  }
  return proof;
}
export const streamingAbort = {
  subtype: "error_during_execution",
  is_error: true,
  terminal_reason: "aborted_streaming",
  errors: ["Interrupted"],
};
export function nativeConversationHistory(history: OwnedHistory, version: string): OwnedHistory {
  let parentUuid: string | null = null;
  const records = history.records
    .filter((frame) => ["user", "assistant"].includes(String(frame.type)))
    .map((frame) => {
      const record = {
        type: frame.type,
        uuid: frame.uuid,
        message: structuredClone(frame.message),
        parentUuid,
        sessionId: history.sessionId,
        cwd: history.root,
        version,
        isSidechain: false,
      };
      parentUuid = String(frame.uuid);
      return record;
    });
  return { ...history, format: "claude-jsonl-v1", records };
}
export async function claudeFixture() {
  const f = await runtimeFixture();
  const h = claudeHarness(f);
  const close = h.close;
  return Object.assign(h, {
    close: async () => {
      await close();
      await f.close();
    },
  });
}
