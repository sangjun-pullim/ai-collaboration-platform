import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const gates = [
  "plugins",
  "apps",
  "hooks",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "multi_agent",
  "multi_agent_v2",
  "image_generation",
  "in_app_browser",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
];
const argv = process.argv.slice(2),
  official = argv.includes("features") || argv.includes("app-server");
const snapshot = {
  kind: argv.includes("features") ? "PREFLIGHT" : "APP_SERVER",
  pid: process.pid,
  argv,
  cwd: process.cwd(),
  environment: Object.fromEntries(
    [
      "OPENAI_API_KEY",
      "MCP_AUTH_TOKEN",
      "HTTP_PROXY",
      "CODEX_HOME",
      "DATABASE_URL",
      "LOCAL_ACCESS_ADMIN_KEY",
      "AI_COLLAB_SECRET",
      "CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  ),
};
if (official && process.env.SYNTHETIC_AUDIT_FILE)
  appendFileSync(process.env.SYNTHETIC_AUDIT_FILE, JSON.stringify(snapshot) + "\n", {
    mode: 0o600,
  });
if (argv.includes("features")) {
  const mode = process.env.SYNTHETIC_PREFLIGHT_MODE ?? "valid";
  let rows = gates.map(
    (name) => `${name} stable ${mode === "true" && name === "plugins" ? "true" : "false"}`,
  );
  if (mode === "missing") rows = rows.filter((row) => !row.startsWith("plugins "));
  if (mode === "duplicate") rows.push(rows[0]);
  if (mode === "unsupported") rows[0] = "plugins removed false";
  if (mode === "malformed") rows[0] = "plugins stable 0";
  if (mode === "unknown") rows.push("SYNTHETIC_UNKNOWN stable false");
  if (mode === "oversized") process.stdout.write("x".repeat(65537));
  else if (mode === "stderr-oversized") process.stderr.write("x".repeat(65537));
  else if (mode === "error") {
    process.stderr.write("SYNTHETIC_PRIVATE_PREFLIGHT_ERROR\n");
    process.exitCode = 1;
  } else if (mode === "stall-ignore") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else if (mode === "late") setTimeout(() => process.stdout.write(rows.join("\n") + "\n"), 500);
  else process.stdout.write(rows.join("\n") + "\n");
} else {
  const mode = process.argv[2] ?? "echo";
  const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
  if (mode === "term-ignore") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  }
  const nativePending = new Set();
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      emit({ id: message.id, result: { userAgent: "codex/0.159.1" } });
      return;
    }
    if (message.method === "initialized") return;
    if (official && message.method === "config/read") {
      emit({ id: message.id, result: snapshot });
      return;
    }
    if (message.method === "fixture/nativeCallbacks") {
      for (const request of message.params.requests) nativePending.add(request.id);
      emit({ id: message.id, result: {} });
      for (const request of message.params.requests) emit(request);
      return;
    }
    if (nativePending.has(message.id)) {
      emit({
        method: "fixture/nativeReceipt",
        params: {
          id: message.id,
          ...(message.result === undefined ? { error: message.error } : { result: message.result }),
        },
      });
      return;
    }
    if (message.method === "fixture/environment") {
      emit({
        id: message.id,
        result: Object.fromEntries(
          message.params.keys
            .filter((key) => process.env[key] !== undefined)
            .map((key) => [key, process.env[key]]),
        ),
      });
      return;
    }
    if (message.method === "fixture/oversized") {
      process.stdout.write("x".repeat(1024 * 1024 + 1));
      return;
    }
    if (message.method === "fixture/stall") return;
    if (message.method === "fixture/tool") {
      emit({ id: message.id, result: {} });
      const call = {
        id: "rpc-one",
        method: "item/tool/call",
        params: {
          threadId: "thread",
          turnId: "turn",
          callId: "call",
          namespace: "ai_collaboration_scoped",
          tool: "ask_peer",
          arguments: { question: "synthetic" },
        },
      };
      emit(call);
      emit(call);
      return;
    }
    if (message.method === "fixture/error") {
      process.stderr.write("Synthetic private diagnostics\n");
      emit({ id: message.id, error: { code: -1, message: "Synthetic private provider failure" } });
      return;
    }
    if (message.method) {
      emit({ id: message.id, result: message.params });
      return;
    }
    if (message.id === "rpc-one")
      emit({ method: "fixture/receipt", params: { success: message.result?.success === true } });
  });
}
