import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

// This fixture models stream-json, not native Claude implementation or policy precedence.
const mode = process.env.FAKE_MODE ?? "normal";
const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf(argv.includes("--resume") ? "--resume" : "--session-id") + 1];
const directory = process.env.FAKE_NATIVE_DIR;
const history = join(directory, `${sessionId}.jsonl`);
const logPath = process.env.FAKE_LOG;
const pending = new Map();
let input;
let replies = 0;
let fileText = "";
let priorText = "";
let replayInitialize;
let replayRequestId;
let hostInitialize;
let handshakeStage = 0;
let heldControlId;

mkdirSync(directory, { recursive: true, mode: 0o700 });
if (existsSync(history)) {
  const records = readFileSync(history, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  priorText = records.filter((record) => record.type === "result").at(-1)?.result ?? "";
}
function log(event, data = {}) { appendFileSync(logPath, JSON.stringify({ event, ...data }) + "\n", { mode: 0o600 }); }
function send(frame, persist = false) {
  if (persist && mode !== "no-materialize") appendFileSync(history, JSON.stringify(frame) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify(frame) + "\n");
}
function response(id, payload) {
  send({ type: "control_response", response: { subtype: "success", request_id: id, response: payload } });
}
function malformed(value) {
  return mode.endsWith("-array") ? [value] : { value };
}
function initialize(frame) {
  log("launch", { argv, cwd: process.cwd(), env: {
    SYNTHETIC_USER_KEY: process.env.SYNTHETIC_USER_KEY,
    LOCAL_ACCESS_ADMIN: process.env.LOCAL_ACCESS_ADMIN,
    DATABASE_URL: process.env.DATABASE_URL,
  } });
  if (mode === "oversize") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
  if (mode === "invalid-utf8") { process.stdout.write(Buffer.from([255, 10])); return; }
  if (mode === "stderr-oversize") { process.stderr.write("x".repeat(1024 * 1024 + 1)); return; }
  if (mode === "hold-control") return;
  if (mode.startsWith("replay-control")) {
    replayInitialize = frame.request_id;
    replayRequestId = randomUUID();
    send({ type: "control_request", request_id: replayRequestId, request: {
      subtype: "mcp_message", server_name: "owned_probe", message: {
        jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" },
      },
    } });
    return;
  }
  if (mode !== "no-init" && mode !== "input-init" && mode !== "early-assistant") {
    const init = {
      type: "system", subtype: "init", uuid: randomUUID(), session_id: mode === "wrong-session" ? randomUUID() : sessionId,
      cwd: mode === "wrong-cwd" ? "/SYNTHETIC_OTHER_ROOT" : process.cwd(), claude_code_version: "2.1.287",
      permissionMode: "dontAsk", model: "synthetic-alias", tools: ["mcp__owned_probe__read_selected_file", "mcp__owned_probe__ask_peer"],
      plugins: [], mcp_servers: [{ name: "owned_probe", source: "sdk", status: "connected" }],
    };
    if (mode === "null-effort") init.effort = null;
    if (mode === "effort-high") init.effort = "high";
    if (mode === "bad-effort") init.effort = "unrecognized";
    if (mode.startsWith("init-effort-")) init.effort = malformed("high");
    if (mode.startsWith("init-tool-")) init.tools[0] = malformed(init.tools[0]);
    if (mode === "end-inventory") init.tools.push("EndConversation");
    if (mode === "wrong-permission") init.permissionMode = "default";
    if (mode === "plugin-error") init.plugin_errors = ["SYNTHETIC_PLUGIN_ERROR"];
    send(init, true);
  }
  if (mode === "startup-turn") send({ type: "assistant", session_id: sessionId, user_message_uuid: randomUUID(), message: { content: [] } });
  if (mode === "unknown-response-subtype") {
    send({ type: "control_response", response: { subtype: "SYNTHETIC_UNKNOWN", request_id: frame.request_id } });
    return;
  }
  const efforts = mode.startsWith("catalog-effort-") ? [malformed("high")] : ["high"];
  response(frame.request_id, { commands: [], agents: [], output_style: "default", available_output_styles: [],
    account: {}, models: [{ value: "synthetic-alias", resolvedModel: "synthetic-wire-model",
      displayName: "Synthetic", description: "No external model", supportsEffort: true, supportedEffortLevels: efforts }] });
  if (mode === "official-handshake") handshake("initialize");
  if (mode === "exit-after-init") setTimeout(() => process.exit(0), 10);
}
function result(interrupted = false) {
  if (mode.startsWith("terminal-reason-")) interrupted = true;
  const frame = {
    type: "result", subtype: interrupted ? "error_during_execution" : "success", is_error: interrupted,
    uuid: randomUUID(), session_id: sessionId, user_message_uuid: input.uuid,
    num_turns: mode === "model-less" ? 0 : 1, terminal_reason: interrupted ? "aborted_tools" : "completed",
    queued_turn_count: 0, result: `SYNTHETIC_FINAL:${fileText}:${priorText}`, modelUsage: {},
  };
  if (mode === "foreign-result") frame.user_message_uuid = randomUUID();
  if (mode === "missing-terminal-reason" || mode === "official-success") delete frame.terminal_reason;
  if (mode === "official-success") frame.num_turns = 2;
  if (mode.startsWith("turns-")) frame.num_turns = Number(mode.slice(6));
  if (mode === "unsolicited-abort") { frame.subtype = "error_during_execution"; frame.is_error = true; frame.terminal_reason = "aborted_tools"; }
  if (mode === "optional-linkage") delete frame.user_message_uuid;
  if (mode === "resume-reason") frame.resume_reason = "automatic";
  if (mode.startsWith("terminal-reason-")) frame.terminal_reason = malformed("aborted_tools");
  log("result", { interrupted });
  send(frame, true);
  if (mode === "terminal-command") send({ type: "command_lifecycle", command_uuid: input.uuid,
    state: "cancelled", uuid: randomUUID(), session_id: sessionId });
}
function call(name, args, toolId) {
  const id = randomUUID();
  const requestId = randomUUID();
  pending.set(requestId, { name, id });
  if (name === "read_selected_file") heldControlId = requestId;
  const frame = { type: "control_request", request_id: requestId, request: {
    subtype: "mcp_message", server_name: "owned_probe", message: {
      jsonrpc: "2.0", id, method: "tools/call", params: { name: mode.startsWith("mcp-tool-") ? malformed(name) : name, arguments: args, _meta: {
        // Native correlation metadata is explicitly synthetic and NOT a claimed official field.
        session_id: mode === "foreign-tool-session" ? randomUUID() : sessionId,
        user_message_uuid: mode === "bad-correlation" ? randomUUID() : input.uuid,
        tool_use_id: mode === "foreign-tool-id" ? "synthetic-unowned-tool" : toolId,
      } },
    },
  } };
  if (["no-meta", "official-handshake", "ambiguous-tools", "changed-args"].includes(mode)) delete frame.request.message.params._meta;
  if (mode === "changed-args") frame.request.message.params.arguments = { path: "SYNTHETIC_FOREIGN.txt" };
  send(frame);
  if (mode === "early-cancel" && name === "read_selected_file") send({ type: "control_cancel_request", request_id: requestId });
  if (mode === "reply-race" && name === "ask_peer") setTimeout(() => result(), 5);
}
function handshake(method) {
  const requestId = randomUUID();
  const id = method === "notifications/initialized" ? undefined : handshakeStage + 1;
  pending.set(requestId, { method, id });
  send({ type: "control_request", request_id: requestId, request: { subtype: "mcp_message", server_name: "owned_probe",
    message: { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method,
      ...(method === "initialize" ? { params: { protocolVersion: "2025-11-25" } } : {}) } } });
}
function user(frame) {
  input = frame;
  log("input", { uuid: frame.uuid });
  if (mode === "input-init") send({ type: "system", subtype: "init", uuid: randomUUID(), session_id: sessionId,
    cwd: process.cwd(), claude_code_version: "2.1.287", permissionMode: "dontAsk", model: "synthetic-alias",
    tools: ["mcp__owned_probe__read_selected_file", "mcp__owned_probe__ask_peer"],
    plugins: [], mcp_servers: [{ name: "owned_probe", source: "sdk", status: "connected" }] }, true);
  if (mode === "lose-ack") return;
  const ack = structuredClone(frame);
  if (mode === "forged-ack") ack.message.content = "SYNTHETIC_FORGED_PROMPT";
  if (mode === "wrong-ack-role") ack.message.role = "assistant";
  send(ack, true);
  if (mode === "duplicate-ack") send(ack);
  if (mode === "informational") {
    send({ type: "system", subtype: "thinking_tokens", estimated_tokens: 3, estimated_tokens_delta: 3,
      session_id: sessionId, user_message_uuid: frame.uuid, uuid: randomUUID() });
    send({ type: "command_lifecycle", command_uuid: frame.uuid, state: "started", uuid: randomUUID(), session_id: sessionId });
  }
  if (mode === "no-terminal") return;
  const blocks = [
    { type: "tool_use", id: "synthetic-read", name: "mcp__owned_probe__read_selected_file", input: { path: "owned-fixture.txt" } },
    { type: "tool_use", id: "synthetic-question", name: "mcp__owned_probe__ask_peer", input: { question: "synthetic question" } },
  ];
  if (mode === "ambiguous-tools") blocks.push({ ...blocks[0], id: "synthetic-read-two" });
  if (mode.startsWith("assistant-tool-")) blocks[0].name = malformed(blocks[0].name);
  const assistant = { type: "assistant", uuid: randomUUID(), session_id: sessionId, user_message_uuid: frame.uuid,
    parent_tool_use_id: null, message: { role: "assistant", model: "synthetic-wire-model", content: blocks } };
  if (mode === "missing-anchor") delete assistant.user_message_uuid;
  send(assistant, true);
  if (mode === "optional-linkage" || mode === "foreign-later-link") {
    const later = { type: "assistant", uuid: randomUUID(), session_id: sessionId,
      message: { role: "assistant", model: "synthetic-wire-model", content: [{ type: "text", text: "SYNTHETIC_LATER" }] } };
    if (mode === "foreign-later-link") later.user_message_uuid = randomUUID();
    send(later, true);
  }
  if (mode === "late-tool") {
    result();
    call("read_selected_file", { path: "owned-fixture.txt" }, "synthetic-read");
    return;
  }
  call("read_selected_file", { path: "owned-fixture.txt" }, "synthetic-read");
  if (mode === "duplicate-call") call("read_selected_file", { path: "owned-fixture.txt" }, "synthetic-read");
}
function receive(frame) {
  if (frame.type === "control_request") {
    if (frame.request.subtype === "initialize") initialize(frame);
    else if (frame.request.subtype === "interrupt") {
      log("interrupt");
      if (mode === "natural-race") result();
      response(frame.request_id, { still_queued: [], cancelled: [] });
      if (mode.startsWith("held-cancel")) {
        const cancellation = { type: "control_cancel_request", request_id: mode === "held-cancel-foreign" ? randomUUID() : heldControlId };
        if (mode === "held-cancel-extra") cancellation.extra = true;
        send(cancellation);
        if (mode === "held-cancel-duplicate") send(cancellation);
      }
      if (mode !== "interrupt-ack-only" && mode !== "natural-race" && mode !== "held-cancel-no-result") result(true);
    }
  } else if (frame.type === "user") user(frame);
  else if (frame.type === "control_response") {
    if (mode.startsWith("replay-control")) {
      if (frame.response.request_id !== replayRequestId) throw new Error("SYNTHETIC_FOREIGN_RESPONSE");
      const echo = structuredClone(frame);
      if (mode === "replay-control-mutated") echo.response.response.mcp_response.result.changed = true;
      if (mode === "replay-control-unknown-id") echo.response.request_id = randomUUID();
      if (mode === "replay-control-reordered") {
        echo.response = Object.fromEntries(Object.entries(echo.response).reverse());
      }
      send(echo);
      if (mode === "replay-control-duplicate") send(echo);
      response(replayInitialize, { commands: [], models: [] });
      return;
    }
    const request = pending.get(frame.response.request_id);
    if (!request) return;
    pending.delete(frame.response.request_id);
    if (request.method) {
      const mcp = frame.response.response.mcp_response;
      if (!mcp || frame.response.response.mcp_message || mcp.jsonrpc !== "2.0" ||
          mcp.id !== (request.id ?? 0)) throw new Error("SYNTHETIC_WRONG_MCP_ENVELOPE");
      if (request.method === "initialize" && mcp.result.protocolVersion !== "2025-11-25" ||
          request.method === "tools/list" && mcp.result.tools.length !== 2) throw new Error("SYNTHETIC_WRONG_MCP_RESULT");
      log("handshake", { method: request.method, id: mcp.id });
      handshakeStage++;
      if (handshakeStage === 1) handshake("notifications/initialized");
      else if (handshakeStage === 2) handshake("tools/list");
      return;
    }
    if (mode === "official-handshake") {
      const mcp = frame.response.response.mcp_response;
      if (!mcp || frame.response.response.mcp_message || mcp.jsonrpc !== "2.0" || mcp.id !== request.id ||
          !Array.isArray(mcp.result.content)) throw new Error("SYNTHETIC_WRONG_CALL_ENVELOPE");
    }
    log("tool-response", { name: request.name });
    if (mode === "native-tool-result") send({ type: "user", uuid: randomUUID(), session_id: sessionId,
      message: { role: "user", content: [{ type: "tool_result",
        tool_use_id: request.name === "read_selected_file" ? "synthetic-read" : "synthetic-question", content: "SYNTHETIC_NATIVE_RESULT" }] } }, true);
    if (request.name === "read_selected_file") fileText = (frame.response.response.mcp_response ?? frame.response.response.mcp_message).result.content[0].text;
    replies++;
    const expected = mode === "duplicate-call" ? 2 : 1;
    if (replies === expected) call("ask_peer", { question: "synthetic question" }, "synthetic-question");
    else if (replies === expected + 1 && mode !== "natural-race") result();
  }
}
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => { try { receive(JSON.parse(line)); } catch { process.exitCode = 2; lines.close(); } });
if (mode === "ignore-close") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else lines.on("close", () => process.exit(0));
// Ensure fixture log exists without leaking real environment values.
writeFileSync(logPath, "", { mode: 0o600 });
