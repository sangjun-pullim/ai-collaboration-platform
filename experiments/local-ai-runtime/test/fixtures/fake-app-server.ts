import { appendFileSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal";
const scopedNamespace = "ai_collaboration_scoped";
if (scenario === "tools-cli-driver") {
  await runToolsDriver();
  process.exit(process.exitCode ?? 0);
}
const tracePath = process.env.FAKE_TRACE_PATH;
const sharedStatePath = process.env.FAKE_SHARED_STATE;
let toolIndex = 0;
let toolRpc = 0;
let toolPending = new Map<string, { callId: string; tool: string; args: unknown }>();
let toolMarker = "unavailable";
let toolsInitializedOptIn = false;
let codeModeConfig: Record<string, unknown> = {};
let codeModeVisibleTools: { name: string; namespace?: string }[] = [];
let initialized = false;
let approvalIndex = 0;
const approvalResponses: unknown[] = [];

if (scenario === "ignoreSigterm") {
  process.on("SIGTERM", () => undefined);
}

trace({ type: "startup", cwd: process.cwd(), pid: process.pid });
if (process.env.FAKE_STDERR_SECRET !== undefined) {
  process.stderr.write(process.env.FAKE_STDERR_SECRET);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("close", () => {
  if (scenario === "terminalOnShutdown") {
    const timer = setInterval(() => {
      try {
        readFileSync(process.env.TERMINAL_GATE!);
        clearInterval(timer);
        sendTerminal("completed");
      } catch { /* Wait until the client is persisting UNKNOWN. */ }
    }, 5);
  }
});
input.on("line", (line) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(line) as Record<string, unknown>;
  } catch {
    process.exitCode = 2;
    return;
  }
  trace({ type: "received", message });
  handle(message);
});

function handle(message: Record<string, unknown>): void {
  if (message.method === "initialize" && isId(message.id)) {
    toolsInitializedOptIn = asRecord(asRecord(message.params).capabilities).experimentalApi === true;
    send({ id: message.id, result: { userAgent: "fake/1", codexHome: "/secret/fake", platformFamily: "unix", platformOs: "test" } });
    return;
  }
  if (message.method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized && typeof message.method === "string") {
    if (isId(message.id)) {
      send({ id: message.id, error: { code: -32000, message: "not initialized" } });
    }
    return;
  }

  if (scenario.startsWith("tools-") && handleTools(message)) return;

  if (scenario === "fragmented" && (message.method === "alpha" || message.method === "beta")) {
    queueFragmented(message);
    return;
  }
  if (message.method === "malformed" && isId(message.id)) {
    process.stdout.write("{not-json}\n");
    return;
  }
  if (message.method === "oversized" && isId(message.id)) {
    process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
    return;
  }
  if (message.method === "timeout") {
    return;
  }
  if (message.method === "exit" || scenario === "earlyExit") {
    process.exit(17);
  }

  if (message.method === "thread/start" && isId(message.id)) {
    if (scenario === "delayedThreadNoTerminal") {
      setTimeout(() => send({ id: message.id, result: { thread: { id: "thread-1" } } }), 80);
    } else {
      send({ id: message.id, result: { thread: { id: "thread-1" } } });
    }
    return;
  }
  if (message.method === "thread/resume" && isId(message.id)) {
    const params = asRecord(message.params);
    if (scenario === "resumeFailure") {
      send({ id: message.id, error: { code: -32010, message: "synthetic resume failure" } });
    } else {
      send({ id: message.id, result: { thread: { id: params.threadId } } });
    }
    return;
  }
  if (message.method === "turn/start" && isId(message.id)) {
    handleTurnStart(message.id, asRecord(message.params));
    return;
  }
  if (message.method === "turn/interrupt" && isId(message.id)) {
    if (scenario.startsWith("terminalBeforeAck")) {
      sendTerminal(scenario.includes("Interrupted") ? "interrupted" : "completed");
      if (scenario.endsWith("Error")) {
        send({ id: message.id, error: { code: -32001, message: "synthetic ACK error" } });
      }
      return;
    }
    if (scenario === "delayedAckNoTerminal") {
      setTimeout(() => {
        trace({ type: "interrupt-ack", timestampMs: Date.now() });
        send({ id: message.id, result: {} });
      }, 350);
      return;
    }
    if (scenario === "ackErrorBeforeTerminal") {
      send({ id: message.id, error: { code: -32001, message: "synthetic ACK error" } });
      setTimeout(() => sendTerminal("completed"), 10);
      return;
    }
    send({ id: message.id, result: {} });
    if (scenario === "interruptNaturalComplete") {
      sendTerminal("completed");
    } else if (scenario === "interruptFailed") {
      sendTerminal("failed");
    } else if (scenario === "interruptInterrupted") {
      sendTerminal("interrupted");
    }
    return;
  }
  if (isId(message.id) && message.method === undefined) {
    approvalResponses.push(message);
    trace({ type: "approval-response", message });
    if (scenario === "approvals") {
      sendNextApproval();
    }
    return;
  }
  if (isId(message.id)) {
    send({ id: message.id, result: { ok: true } });
  }
}

function handleTurnStart(id: string | number, params: Record<string, unknown>): void {
  if (scenario === "lostStartResponse") {
    setTimeout(() => process.exit(18), 20);
    return;
  }
  if (scenario === "exitAfterTurn") {
    process.exit(19);
  }
  if (scenario === "earlyEvents") {
    send({ method: "turn/completed", params: terminalParams("other-turn", "failed") });
    sendFragmented({ method: "turn/completed", params: terminalParams("turn-1", "completed") });
    setTimeout(() => {
      send({ id, result: turnResult() });
      send({ method: "turn/completed", params: terminalParams("turn-1", "failed") });
    }, 10);
    return;
  }

  send({ id, result: turnResult() });
  if (scenario === "closedStdin" || scenario === "unknownRequestClosedStdin") {
    input.close();
    closeSync(0);
    setInterval(() => undefined, 1_000);
    if (scenario === "unknownRequestClosedStdin") {
      send({ id: "closed-input-request", method: "unknown/request", params: {} });
    } else {
      send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1" } });
    }
    return;
  }
  if (scenario === "approvals") {
    sendNextApproval();
    return;
  }
  if (scenario === "unknownRequest") {
    send({ id: "server-unknown", method: "unknown/request", params: {} });
    return;
  }
  if (
    scenario.startsWith("terminalBeforeAck") ||
    scenario === "terminalOnShutdown" ||
    scenario === "delayedAckNoTerminal" ||
    scenario === "ackErrorBeforeTerminal" ||
    scenario === "noTerminal" ||
    scenario === "interruptNaturalComplete" ||
    scenario === "interruptFailed" ||
    scenario === "interruptInterrupted" ||
    scenario === "interruptNoTerminal" ||
    scenario === "delayedThreadNoTerminal" ||
    scenario === "crashWait" ||
    scenario === "ignoreSigterm"
  ) {
    return;
  }

  const prompt = extractPrompt(params);
  const marker = prompt.match(/marker exactly: ([a-f0-9]+)/)?.[1];
  if (marker !== undefined && sharedStatePath !== undefined) {
    writeFileSync(sharedStatePath, marker, { encoding: "utf8", mode: 0o600 });
  }
  const responseMarker =
    marker ?? (sharedStatePath === undefined ? undefined : readFileSync(sharedStatePath, "utf8").trim());
  if (scenario === "wrongTurnMarker" && responseMarker !== undefined) {
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "other-turn",
        item: { type: "agentMessage", text: responseMarker },
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "wrong marker" },
      },
    });
    sendTerminal("completed");
    return;
  }
  if (responseMarker !== undefined) {
    send({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: responseMarker },
      },
    });
  }
  sendTerminal("completed");
}

function sendNextApproval(): void {
  const requests = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ];
  const method = requests[approvalIndex];
  approvalIndex += 1;
  if (method === undefined) {
    sendTerminal("completed");
    return;
  }
  send({ id: `approval-${approvalIndex}`, method, params: { synthetic: true } });
}

function queueFragmented(message: Record<string, unknown>): void {
  const delay = message.method === "alpha" ? 15 : 2;
  setTimeout(() => {
    sendFragmented({ id: message.id, result: { method: message.method } });
    if (message.method === "beta") {
      setTimeout(
        () => process.stdout.write(`${JSON.stringify({ method: "item/completed", params: { item: { type: "reasoning" } } })}\r\n`),
        4,
      );
    }
  }, delay);
}

function sendTerminal(status: "completed" | "failed" | "interrupted"): void {
  send({ method: "turn/completed", params: terminalParams("turn-1", status) });
}

function terminalParams(turnId: string, status: string): Record<string, unknown> {
  return { threadId: "thread-1", turn: { id: turnId, status, items: [] } };
}

function turnResult(): Record<string, unknown> {
  return { turn: { id: "turn-1", status: "inProgress", items: [] } };
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendFragmented(message: unknown): void {
  const line = `${JSON.stringify(message)}\r\n`;
  const first = Math.max(1, Math.floor(line.length / 3));
  const second = Math.max(first + 1, Math.floor((line.length * 2) / 3));
  process.stdout.write(line.slice(0, first));
  setTimeout(() => process.stdout.write(line.slice(first, second)), 1);
  setTimeout(() => process.stdout.write(line.slice(second)), 2);
}

function extractPrompt(params: Record<string, unknown>): string {
  const input = Array.isArray(params.input) ? params.input : [];
  const first = asRecord(input[0]);
  return typeof first.text === "string" ? first.text : "";
}

function trace(value: unknown): void {
  if (tracePath !== undefined) {
    appendFileSync(tracePath, `${JSON.stringify({ timestampMs: Date.now(), ...asRecord(value) })}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}


function safeToolConfig(): Record<string, unknown> {
  return {
    approval_policy: "never", sandbox_mode: "read-only", mcp_servers: {}, plugins: {},
    apps: { _default: { enabled: false } }, web_search: "disabled", agents: { enabled: false },
    shell_environment_policy: { inherit: "none" }, features: { ...Object.fromEntries([
      "shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
      "computer_use", "image_generation", "view_image", "code_mode_host", "multi_agent", "memories",
      "skill_mcp_dependency_install", "workspace_dependencies",
    ].map((name) => [name, false])), code_mode: { enabled: false, direct_only_tool_namespaces: [scopedNamespace] } },
  };
}

async function runToolsDriver(): Promise<void> {
  // Keep the fixture IPC channel alive while a deliberately unresolved gate is awaiting SIGINT.
  process.on("message", () => undefined);
  const [{ ExperimentStore }, { ScopedToolExperiment }, { StdioClient }, { main }, { fileURLToPath }] = await Promise.all([
    import("../../src/experiment-policy.js"), import("../../src/scoped-tool-experiment.js"),
    import("../../src/stdio-client.js"), import("../../src/tools-cli.js"), import("node:url"),
  ]);
  const owned = await ExperimentStore.openOwned(process.env.TEST_MANIFEST!);
  const gate = async () => {
    process.send?.("tool-gate-entered");
    await new Promise<void>(() => undefined);
  };
  const runtime = new ScopedToolExperiment({
    markerFactory: () => "b".repeat(48),
    ...(process.env.TEST_TOOL_DRIVER_GATE === "callback" ? { beforeToolCommit: gate } : { beforePreparation: gate }),
    clientFactory: (cwd, handler) => StdioClient.launchForTest({
      executable: process.execPath, args: [fileURLToPath(import.meta.url), "tools-normal"], cwd,
      env: process.env, experimentalApi: true, dynamicToolHandler: handler,
      requestTimeoutMs: 300, closeTimeoutMs: 30,
    }),
  });
  process.argv.splice(2, process.argv.length, "run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api");
  await main({ runtime, createStore: async () => owned });
}

function handleTools(message: Record<string, unknown>): boolean {
  if (message.method === "config/read") {
    const config = safeToolConfig();
    const patch = asRecord(JSON.parse(process.env.FAKE_TOOL_POLICY_PATCH ?? "{}"));
    for (const [key, value] of Object.entries(patch)) {
      if (value === "DELETE") delete config[key]; else config[key] = value;
    }
    if (scenario === "tools-codeModeOnly") codeModeConfig = config;
    if (scenario === "tools-beforeTurn") sendTool({ namespace: scopedNamespace, callId: "before-turn", tool: "read_workspace_file", arguments: { path: "tool-proof.txt" } });
    send({ id: message.id, result: { config } });
    return true;
  }
  if (message.method === "tools/callbacks") {
    send({ id: message.id, result: {} });
    const calls = JSON.parse(process.env.FAKE_TOOL_CALLS ?? '[{"namespace":"ai_collaboration_scoped","callId":"direct","tool":"read_workspace_file","arguments":{"path":"public-context.txt"}}]') as Record<string, unknown>[];
    for (const call of calls) sendTool(call);
    return true;
  }
  if (message.method === "tools/terminal") {
    send({ id: message.id, result: {} });
    sendTerminal("completed");
    return true;
  }
  if (message.method === "tools/closeInput") {
    closeSync(0);
    send({ id: message.id, result: {} });
    return true;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    const params = asRecord(message.params);
    if (message.method === "thread/start" && (!toolsInitializedOptIn || !Array.isArray(params.dynamicTools) ||
        (scenario !== "tools-codeModeOnly" && !isScopedRegistration(params.dynamicTools)))) {
      send({ id: message.id, error: { code: -32000, message: "dynamic tools missing" } });
    } else {
      if (scenario === "tools-codeModeOnly" && message.method === "thread/start") {
        codeModeVisibleTools = directToolsInCodeModeOnly(params.dynamicTools, codeModeConfig);
        trace({ type: "model-tools", toolMode: "code_mode_only",
          codeModeHost: asRecord(codeModeConfig.features).code_mode_host, tools: codeModeVisibleTools });
      }
      send({ id: message.id, result: { thread: {
        id: scenario === "tools-threadMismatch" ? "foreign-thread" : message.method === "thread/resume" ? params.threadId : "thread-1",
        cwd: scenario === "tools-cwdMismatch" ? "/" : process.cwd(),
      } } });
    }
    return true;
  }
  if (message.method === "turn/start") {
    if (scenario === "tools-crash") { process.exit(19); }
    if (scenario === "tools-early" || scenario === "tools-ackLost") {
      nextTool();
      if (scenario === "tools-early") setTimeout(() => send({ id: message.id, result: turnResult() }), 45);
    } else {
      send({ id: message.id, result: turnResult() });
      nextTool();
    }
    return true;
  }
  if (typeof message.id === "string" && message.method === undefined && toolPending.has(message.id)) {
    const pending = toolPending.get(message.id)!;
    toolPending.delete(message.id);
    trace({ type: "tool-response", callId: pending.callId, tool: pending.tool, args: pending.args, message });
    if (pending.callId === "before-turn") return true;
    const result = asRecord(message.result);
    if (pending.tool === "read_workspace_file" && asRecord(pending.args).path === "tool-proof.txt" && result.success === true) {
      const first = asRecord((result.contentItems as unknown[])[0]);
      toolMarker = String(first.text);
    }
    if (scenario === "tools-direct" || scenario === "tools-ackLost" || scenario.startsWith("tools-terminalGate")) return true;
    if (toolPending.size === 0) nextTool();
    return true;
  }
  return false;
}

function sendTool(call: Record<string, unknown>): void {
  const id = `tool-rpc-${++toolRpc}`;
  const params: Record<string, unknown> = { threadId: "thread-1", turnId: "turn-1", ...call };
  toolPending.set(id, { callId: String(params.callId), tool: String(params.tool), args: params.arguments });
  trace({ type: "tool-call", params });
  send({ id, method: "item/tool/call", params });
}

function isScopedRegistration(specs: unknown[]): boolean {
  if (specs.length !== 1) return false;
  const namespace = asRecord(specs[0]);
  if (namespace.type !== "namespace" || namespace.name !== scopedNamespace || !Array.isArray(namespace.tools) || namespace.tools.length !== 2) return false;
  return namespace.tools.every((value, index) => {
    const tool = asRecord(value);
    return tool.type === "function" && tool.name === ["read_workspace_file", "ask_peer"][index] &&
      typeof tool.description === "string" && asRecord(tool.inputSchema).type === "object" &&
      asRecord(tool.inputSchema).additionalProperties === false;
  });
}

function directToolsInCodeModeOnly(specs: unknown, config: Record<string, unknown>): { name: string; namespace?: string }[] {
  const directOnly = asRecord(asRecord(config.features).code_mode).direct_only_tool_namespaces;
  const namespaces = new Set(Array.isArray(directOnly) ? directOnly.filter((value): value is string => typeof value === "string") : []);
  const visible: { name: string; namespace?: string }[] = [];
  if (!Array.isArray(specs)) return visible;
  for (const value of specs) {
    const spec = asRecord(value);
    const namespace = spec.type === "namespace" && typeof spec.name === "string" ? spec.name : undefined;
    const functions = spec.type === "namespace" && Array.isArray(spec.tools) ? spec.tools : [spec];
    for (const value of functions) {
      const fn = asRecord(value);
      if (fn.type !== "function" || typeof fn.name !== "string" || typeof fn.description !== "string" ||
          asRecord(fn.inputSchema).type !== "object") continue;
      // rust-v0.159.1 spec_plan: a configured namespace becomes DirectModelOnly,
      // bypassing deferral and CodeModeOnly hiding. Other dynamic functions stay nested.
      // Apps and the host feature do not grant this direct exposure.
      if (!namespaces.has(namespace ?? "functions")) continue;
      if (!visible.some((tool) => tool.name === fn.name && tool.namespace === namespace)) {
        visible.push({ name: fn.name, ...(namespace === undefined ? {} : { namespace }) });
      }
    }
  }
  return visible;
}

function nextTool(): void {
  const publicRead = { namespace: scopedNamespace, callId: "public", tool: "read_workspace_file", arguments: { path: "public-context.txt" } };
  const proofRead = { namespace: scopedNamespace, callId: "proof", tool: "read_workspace_file", arguments: { path: "tool-proof.txt" } };
  const peer = { namespace: scopedNamespace, callId: "peer", tool: "ask_peer", arguments: { target: "peer-fixture", question: "Is this public synthetic context?", evidence: [{ path: "public-context.txt", startLine: 1, endLine: 1 }] } };
  let script: Record<string, unknown>[][] = [[publicRead], [proofRead], [peer]];
  if (scenario === "tools-codeModeOnly") {
    script = script.map((calls) => calls.flatMap((call) => {
      const tool = codeModeVisibleTools.find((tool) => tool.name === call.tool);
      return tool === undefined ? [] : [{ ...call, namespace: tool.namespace }];
    })).filter((calls) => calls.length > 0);
  }
  if (scenario === "tools-duplicates") script = [[publicRead, publicRead], [{ ...publicRead, arguments: { path: "tool-proof.txt" } }], [proofRead], [peer, peer]];
  if (scenario === "tools-conflictingTool") script = [[publicRead], [{ ...peer, callId: "public" }], [proofRead], [peer]];
  if (scenario === "tools-cross") script = [[{ ...publicRead, threadId: "foreign" }], [{ ...publicRead, turnId: "old-turn" }], [publicRead], [proofRead], [peer]];
  if (scenario === "tools-limit") script = Array.from({ length: 33 }, (_, i) => [{ ...publicRead, callId: `unique-${i}` }]);
  if (scenario === "tools-terminalGate") script = [[peer]];
  if (scenario === "tools-terminalGateRead") script = [[proofRead]];
  if (process.env.FAKE_TOOL_SCRIPT !== undefined) script = JSON.parse(process.env.FAKE_TOOL_SCRIPT) as Record<string, unknown>[][];
  if (scenario === "tools-resumeUnsupported") script = [];
  const calls = script[toolIndex++];
  if (calls !== undefined) {
    for (const call of calls) sendTool(call);
    if (scenario.startsWith("tools-terminalGate")) setTimeout(() => sendTerminal("completed"), 20);
    return;
  }
  let marker = toolMarker;
  if (scenario === "tools-resumeUnsupported" && sharedStatePath !== undefined) marker = readFileSync(sharedStatePath, "utf8");
  if (sharedStatePath !== undefined && scenario !== "tools-resumeUnsupported") writeFileSync(sharedStatePath, marker, { mode: 0o600 });
  const agent = (text: string, phase?: string, turnId = "turn-1") => send({ method: "item/completed", params: {
    threadId: "thread-1", turnId, item: { type: "agentMessage", text, ...(phase === undefined ? {} : { phase }) },
  } });
  if (scenario === "tools-commentary") { agent(marker, "commentary"); agent("wrong", "final_answer"); }
  else if (scenario === "tools-missingPhase") agent(marker);
  else if (scenario === "tools-staleFinal") { agent(marker, "final_answer", "old-turn"); agent("wrong", "final_answer"); }
  else if (scenario === "tools-finalOverwrite") { agent(marker, "final_answer"); agent("wrong", "final_answer"); }
  else if (scenario === "tools-afterTerminal") { sendTerminal("completed"); agent(marker, "final_answer"); return; }
  else agent(marker, "final_answer");
  sendTerminal("completed");
  if (scenario === "tools-cross") setTimeout(() => sendTool({ ...peer, callId: "late-peer" }), 1);
}
