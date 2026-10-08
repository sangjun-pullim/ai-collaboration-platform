import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { NativeInputProof, nativeIdentity } from "../src/native-input-proof.js";
import { ProbeError, digest } from "../src/owned-probe-store.js";

const code = (expected: string) => (error: unknown) => error instanceof ProbeError && error.code === expected;
function fixture() {
  const sessionId = randomUUID(); const inputId = randomUUID(); const prompt = "SYNTHETIC_PROOF_PROMPT";
  const proof = new NativeInputProof(sessionId, inputId, digest(prompt));
  const ack = { type: "user", uuid: inputId, session_id: sessionId, parent_tool_use_id: null,
    message: { role: "user", content: prompt } };
  const assistant = (content: Record<string, unknown>[] = []) => ({ type: "assistant", uuid: randomUUID(),
    session_id: sessionId, user_message_uuid: inputId, message: { role: "assistant", model: "synthetic-model", content } });
  const tool = (id = "synthetic-file", name = "read_selected_file", args: Record<string, unknown> = { path: "owned-fixture.txt" }) =>
    ({ type: "tool_use", id, name: `mcp__owned_probe__${name}`, input: args });
  const result = (extra: Record<string, unknown> = {}) => ({ type: "result", subtype: "success", is_error: false,
    uuid: randomUUID(), session_id: sessionId, num_turns: 2, result: "SYNTHETIC_ANSWER", ...extra });
  const anchor = (content: Record<string, unknown>[] = []) => { proof.user(ack); proof.assistant(assistant(content), true); };
  const progress = (extra: Record<string, unknown> = {}) => ({ type: "system", subtype: "thinking_tokens",
    estimated_tokens: 4, estimated_tokens_delta: -1, session_id: sessionId, user_message_uuid: inputId, uuid: randomUUID(), ...extra });
  const command = (extra: Record<string, unknown> = {}) => ({ type: "command_lifecycle", command_uuid: inputId,
    state: "started", uuid: randomUUID(), session_id: sessionId, ...extra });
  return { sessionId, inputId, proof, ack, assistant, tool, result, anchor, progress, command };
}

test("should verify the exact native inventory without granting EndConversation execution", () => {
  const f = fixture();
  const init = { type: "system", subtype: "init", uuid: randomUUID(), session_id: f.sessionId, cwd: "/SYNTHETIC_ROOT",
    claude_code_version: "2.1.287", permissionMode: "dontAsk", model: "synthetic-alias",
    tools: ["mcp__owned_probe__read_selected_file", "mcp__owned_probe__ask_peer", "EndConversation"],
    plugins: [], plugin_errors: [], mcp_servers: [{ name: "owned_probe", status: "connected", source: "sdk" }] };
  assert.deepEqual(nativeIdentity(init, f.sessionId, "/SYNTHETIC_ROOT"), { model: "synthetic-alias", effort: { status: "UNVERIFIED" } });
  for (const extra of [{ permissionMode: "default" }, { plugin_errors: ["synthetic-error"] }, { plugins: ["synthetic-plugin"] },
    { tools: [...init.tools, "Bash"] }, { tools: [init.tools[0], init.tools[0]] }, { mcp_servers: [] },
    { session_id: randomUUID() }, { cwd: "/SYNTHETIC_FOREIGN" }, { claude_code_version: "2.1.286" }]) {
    assert.throws(() => nativeIdentity({ ...init, ...extra }, f.sessionId, "/SYNTHETIC_ROOT"), code("NATIVE_IDENTITY"));
  }
  f.proof.user(f.ack);
  assert.throws(() => f.proof.assistant(f.assistant([{ type: "tool_use", id: "end", name: "EndConversation", input: {} }]), true), code("TOOL_REJECTED"));
});

test("should verify prompt role and hash before granting input acknowledgement", () => {
  for (const message of [{ role: "assistant", content: "SYNTHETIC_PROOF_PROMPT" }, { role: "user", content: "SYNTHETIC_FORGED" }]) {
    const f = fixture(); assert.throws(() => f.proof.user({ ...f.ack, message }));
    assert.throws(() => f.proof.assistant(f.assistant(), true), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
  const f = fixture();
  assert.equal(f.proof.user({ ...f.ack, message: { role: "user", content: [{ type: "text", text: "SYNTHETIC_PROOF_PROMPT" }] } }), "INPUT_ACK");
  assert.throws(() => f.proof.user(f.ack), code("TOOL_CORRELATION_UNCONFIRMED"));
});

test("should require the first assistant anchor and reject any later foreign UUID", () => {
  const f = fixture(); f.proof.user(f.ack);
  const unlinked: Record<string, unknown> = f.assistant(); delete unlinked.user_message_uuid;
  assert.throws(() => f.proof.assistant(unlinked, true), code("TOOL_CORRELATION_UNCONFIRMED"));
  assert.throws(() => f.proof.assistant(f.assistant(), false), code("TOOL_CORRELATION_UNCONFIRMED"));
  f.proof.assistant(f.assistant(), true);
  assert.equal(f.proof.assistant(unlinked, true), "synthetic-model");
  for (const extra of [{ user_message_uuid: randomUUID() }, { user_message_uuids: [randomUUID()] }, { parent_tool_use_id: "external" }]) {
    assert.throws(() => f.proof.assistant({ ...unlinked, ...extra }, true), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
});

test("should distinguish user tool results from input acknowledgements", async () => {
  const f = fixture(); f.anchor([f.tool()]);
  const userResult = { type: "user", uuid: randomUUID(), session_id: f.sessionId,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "synthetic-file", content: "SYNTHETIC_CONTENT" }] } };
  assert.throws(() => f.proof.user(userResult), code("TOOL_CORRELATION_UNCONFIRMED"));
  f.proof.claim("control", { name: "read_selected_file", arguments: { path: "owned-fixture.txt" } }, true);
  await f.proof.response("control", async () => ({ content: [] }));
  assert.throws(() => f.proof.user(userResult), code("TOOL_CORRELATION_UNCONFIRMED"));
  f.proof.responseWritten("control");
  assert.equal(f.proof.user(userResult), "NATIVE_TOOL_RESULT");
  assert.throws(() => f.proof.user({ ...userResult, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "foreign" }] } }), code("TOOL_CORRELATION_UNCONFIRMED"));
});

test("should require one unconsumed native call and validate optional synthetic metadata", () => {
  const f = fixture(); f.anchor([f.tool("one"), f.tool("two")]);
  assert.throws(() => f.proof.claim("ambiguous", { name: "read_selected_file", arguments: { path: "owned-fixture.txt" } }, true), code("TOOL_CORRELATION_UNCONFIRMED"));
  const g = fixture(); g.anchor([g.tool()]);
  for (const meta of [{ session_id: randomUUID(), user_message_uuid: g.inputId, tool_use_id: "synthetic-file" },
    { session_id: g.sessionId, user_message_uuid: randomUUID(), tool_use_id: "synthetic-file" },
    { session_id: g.sessionId, user_message_uuid: g.inputId, tool_use_id: "foreign" }]) {
    assert.throws(() => g.proof.claim(randomUUID(), { name: "read_selected_file", arguments: { path: "owned-fixture.txt" }, _meta: meta }, true), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
  assert.throws(() => g.proof.claim("changed", { name: "read_selected_file", arguments: { path: "foreign.txt" } }, true), code("TOOL_CORRELATION_UNCONFIRMED"));
  assert.equal(g.proof.claim("valid", { name: "read_selected_file", arguments: { path: "owned-fixture.txt" } }, true).toolId, "synthetic-file");
});

test("should reuse exact synthetic duplicate promises without another callback", async () => {
  const f = fixture(); f.anchor([f.tool()]); let callbacks = 0;
  const params = { name: "read_selected_file", arguments: { path: "owned-fixture.txt" },
    _meta: { session_id: f.sessionId, user_message_uuid: f.inputId, tool_use_id: "synthetic-file" } };
  f.proof.claim("first", params, true);
  const first = f.proof.response("first", async () => { callbacks++; return { content: [] }; });
  f.proof.claim("second", params, true);
  const second = f.proof.response("second", async () => { callbacks++; return { content: [] }; });
  assert.equal(first, second); await first; assert.equal(callbacks, 1);
  f.proof.responseWritten("first");
  f.proof.responseWritten("second");
  assert.equal(f.proof.result(f.result(), true).kind, "COMPLETED");
});

test("should refuse tool and control limits without expanding input authority", () => {
  const f = fixture(); f.anchor(Array.from({ length: 64 }, (_, i) => f.tool(`tool-${i}`)));
  assert.throws(() => f.proof.assistant(f.assistant([f.tool("overflow")]), true), code("PROTOCOL_LIMIT"));
  const g = fixture(); g.anchor([g.tool()]);
  const params = { name: "read_selected_file", arguments: { path: "owned-fixture.txt" },
    _meta: { session_id: g.sessionId, user_message_uuid: g.inputId, tool_use_id: "synthetic-file" } };
  for (let i = 0; i < 64; i++) g.proof.claim(`control-${i}`, params, true);
  assert.throws(() => g.proof.claim("overflow", params, true), code("PROTOCOL_LIMIT"));
  assert.throws(() => g.proof.claim("foreign-tool", { name: "Bash", arguments: {} }, true), code("TOOL_REJECTED"));
});

test("should retain only progress count and last value with exact bounded fields", () => {
  const f = fixture(); const frame = f.progress();
  for (const extra of [{ foreign: true }, { session_id: randomUUID() }, { user_message_uuid: randomUUID() }, { uuid: "bad" }]) {
    assert.throws(() => f.proof.progress({ ...frame, ...extra }, true), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
  for (const extra of [{ estimated_tokens: -1 }, { estimated_tokens: 1.5 }, { estimated_tokens_delta: 0.5 }, { estimated_tokens_delta: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => f.proof.progress({ ...frame, ...extra }, true), code("PROTOCOL_REJECTED"));
  }
  assert.throws(() => f.proof.progress(frame, false), code("TOOL_CORRELATION_UNCONFIRMED"));
  for (let i = 0; i < 65536; i++) f.proof.progress(frame, true);
  assert.deepEqual(f.proof.metadata(), { progress: { count: 65536,
    last: { uuid: frame.uuid, estimatedTokens: 4, estimatedTokensDelta: -1 } }, commands: 0 });
  assert.throws(() => f.proof.progress(frame, true), code("PROTOCOL_LIMIT"));
  assert.throws(() => f.proof.assistant(f.assistant(), true), code("TOOL_CORRELATION_UNCONFIRMED"));
});

test("should bound canonical command duplicates and preserve terminal after metadata", () => {
  const f = fixture();
  for (const state of ["queued", "started", "completed", "cancelled", "discarded", "refused"]) f.proof.command(f.command({ state }));
  const frame = f.command(); f.proof.command(frame);
  f.proof.command(Object.fromEntries(Object.entries(frame).reverse()));
  assert.equal(f.proof.metadata().commands, 7);
  assert.throws(() => f.proof.command({ ...frame, state: "completed" }), code("PROTOCOL_REJECTED"));
  for (const extra of [{ state: "other" }, { command_uuid: randomUUID() }, { session_id: randomUUID() }, { extra: 1 }, { uuid: "bad" }]) {
    assert.throws(() => f.proof.command({ ...frame, ...extra }), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
  for (let i = 7; i < 16; i++) f.proof.command(f.command());
  assert.throws(() => f.proof.command(f.command()), code("PROTOCOL_LIMIT"));
  const g = fixture(); g.anchor(); const terminal = g.proof.result(g.result(), true);
  g.proof.command(g.command({ state: "cancelled" })); assert.deepEqual(g.proof.terminal, terminal);
  assert.throws(() => g.proof.progress(g.progress(), true), code("TOOL_CORRELATION_UNCONFIRMED"));
});

test("should treat cancellation as held file metadata rather than a response or terminal", async () => {
  const f = fixture(); f.anchor([f.tool()]);
  const claim = f.proof.claim("held", { name: "read_selected_file", arguments: { path: "owned-fixture.txt" } }, true);
  assert.throws(() => f.proof.cancel({ type: "control_cancel_request", request_id: "held" }), code("TOOL_CORRELATION_UNCONFIRMED"));
  f.proof.requestInterrupt();
  for (const frame of [{ type: "control_cancel_request", request_id: "foreign" }, { type: "control_cancel_request", request_id: "held", extra: 1 }]) {
    assert.throws(() => f.proof.cancel(frame), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
  f.proof.cancel({ type: "control_cancel_request", request_id: "held" }); await claim.cancellation;
  assert.equal(f.proof.terminal, undefined); assert.equal(f.proof.canRespond("held"), false);
  assert.throws(() => f.proof.responseWritten("held"), code("TOOL_REJECTED"));
  assert.throws(() => f.proof.cancel({ type: "control_cancel_request", request_id: "held" }), code("TOOL_CORRELATION_UNCONFIRMED"));
  assert.equal(f.proof.result(f.result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_tools" }), true).kind, "INTERRUPTED");
});

test("should reject cancellation of peer or completed file responses", async () => {
  for (const name of ["read_selected_file", "ask_peer"]) {
    const f = fixture(); const args = name === "ask_peer" ? { question: "synthetic" } : { path: "owned-fixture.txt" };
    f.anchor([f.tool("tool", name, args)]); f.proof.claim("control", { name, arguments: args }, true);
    if (name === "read_selected_file") { await f.proof.response("control", async () => ({})); f.proof.responseWritten("control"); }
    f.proof.requestInterrupt();
    assert.throws(() => f.proof.cancel({ type: "control_cancel_request", request_id: "control" }), code("TOOL_CORRELATION_UNCONFIRMED"));
  }
});

test("should require identity acknowledgement anchor bounds and explicit host abort intent", () => {
  for (const extra of [{ num_turns: 0 }, { num_turns: 65 }, { num_turns: 1.5 }, { num_turns: Number.MAX_SAFE_INTEGER + 1 },
    { queued_turn_count: 1 }, { resume_reason: "auto" }, { local_command: "command" }, { uuid: "bad" },
    { terminal_reason: ["completed"] }, { subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }]) {
    const f = fixture(); f.anchor(); assert.throws(() => f.proof.result(f.result(extra), true), code("TERMINAL_UNCONFIRMED"));
  }
  for (const stage of ["identity", "ack", "anchor"]) {
    const f = fixture();
    if (stage !== "ack") f.proof.user(f.ack);
    if (stage === "identity") f.proof.assistant(f.assistant(), true);
    assert.throws(() => f.proof.result(f.result(), stage !== "identity"), code("TERMINAL_UNCONFIRMED"));
  }
  const f = fixture(); f.anchor(); f.proof.requestInterrupt();
  f.proof.receipt({ still_queued: [], cancelled: [] }); assert.equal(f.proof.terminal, undefined);
  assert.throws(() => f.proof.receipt({ still_queued: [], cancelled: [] }), code("PROTOCOL_REJECTED"));
  assert.equal(f.proof.result(f.result({ subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming" }), true).kind, "INTERRUPTED");
});

test("should preserve natural completion racing interrupt with optional result linkage", () => {
  for (const terminal_reason of [undefined, "completed"]) {
    const f = fixture(); f.anchor(); f.proof.requestInterrupt();
    assert.equal(f.proof.result(f.result({ terminal_reason }), true).kind, "COMPLETED");
  }
  const f = fixture(); f.anchor();
  assert.throws(() => f.proof.result(f.result({ user_message_uuid: randomUUID() }), true), code("TOOL_CORRELATION_UNCONFIRMED"));
});


test("should seal an incomplete response queue on terminal arrival", async () => {
  const f = fixture(); f.anchor([f.tool()]);
  const params = { name: "read_selected_file", arguments: { path: "owned-fixture.txt" },
    _meta: { session_id: f.sessionId, user_message_uuid: f.inputId, tool_use_id: "synthetic-file" } };
  f.proof.claim("first", params, true); await f.proof.response("first", async () => ({}));
  f.proof.claim("second", params, true); f.proof.responseWritten("first");
  assert.throws(() => f.proof.result(f.result(), true), code("TERMINAL_UNCONFIRMED"));
  assert.equal(f.proof.canRespond("second"), false);
  assert.throws(() => f.proof.responseWritten("second"), code("TOOL_REJECTED"));
});
