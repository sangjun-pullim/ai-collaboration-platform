import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { RuntimeError, stableJson, type ToolResult } from "./runtime-contracts.ts";

export interface ProviderEvent { method: string; params: Record<string, unknown> }
export interface ProviderTransport {
  initialize(): Promise<unknown>;
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  setToolHandler(handler: ((params: unknown, live: () => void) => Promise<ToolResult>) | null): void;
  close(): Promise<void>;
}
/** Preserve native user environment; exclude explicitly reserved product/fixture injection. */
export function providerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const reserved = new Set(["DATABASE_URL", "DIRECT_URL", "DB_PASSWORD", "JWT_SECRET", "GOTRUE_JWT_SECRET", "PGRST_JWT_SECRET", "SERVER_SECRET", "LOCAL_AUTH_TOKEN", "SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_JWT_SECRET", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "APP_ORIGIN"]);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !["LOCAL_ACCESS_", "LOCAL_DEVICE_", "LOCAL_WORKFLOW_", "AI_COLLAB_"].some(prefix => key.startsWith(prefix)) && !reserved.has(key)));
}

/** Executable gates supported by official rust-v0.159.1, all at the stable stage. */
export const executionGates = ["plugins", "apps", "hooks", "remote_plugin", "skill_mcp_dependency_install", "multi_agent", "multi_agent_v2", "image_generation", "in_app_browser", "browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use"] as const;
// Pinned official feature names. Unrelated native research/Code Mode features are observed, not disabled.
export const supportedFeatureStages: Readonly<Record<string, readonly string[]>> = Object.fromEntries([
  ..."daemon_auto_start shell_tool view_image sleep_tool secret_auth_storage unified_exec unified_exec_tty shell_snapshot content_item_kinds code_mode_host memories write_stdin_approval hooks enable_request_compression unbounded_connection_retries worktrees system_proxy_fallback multi_agent multi_agent_v2 apps tool_suggest recommended_plugins plugins in_app_browser in_app_chat in_app_dictation in_app_local_automation in_app_updates browser_use browser_use_full_cdp_access browser_use_external computer_use remote_plugin plugin_sharing image_generation skill_mcp_dependency_install skill_search mentions_v2 guardian_approval guardian_reuse_parent_compaction goals tool_call_mcp_elicitation auth_elicitation fast_mode realtime_conversation compaction_image_budget workspace_dependencies".split(" ").map(name => [name, ["stable"]]),
  ..."shell_zsh_fork powershell_shell_version shell_snapshot_v2 deferred_executor cwd_relative_turn_diffs executed_tool_call_metadata code_mode code_mode_prewarm code_mode_interrupt instant_interrupt code_mode_only standalone_web_search runtime_metrics external_agent_memory_import local_thread_store_compression background_paginated_rollout_migration chronicle apply_patch_streaming_events apply_patch_preserve_line_endings exec_permission_approvals request_permissions_tool windows_sandbox_service prefer_mxc api_key_model_discovery respect_system_proxy defer_mailbox_preemption agent_message_board psp enable_mcp_apps mcp_2026_07_28 codex_apps_mcp_2026_07_28 mcp_oauth_refresh_coordination use_xaa deferred_tool_world_state non_prefixed_mcp_tool_names executor_capability_discovery skip_host_skill_discovery omit_app_server_notification_media image_resize_notice unified_image_budget concurrent_reasoning_summaries default_mode_request_user_input send_message_to_user_async terminal_visualization_instructions guardian_enhanced_node_repl_transcripts guardian_node_repl_transcript_images guardianv2 token_budget context_management rollout_budget reasoning_effort_override current_time_reminder nonfatal_clock_read_errors bedrock_setup_wizard artifact step_model_switching retain_client_developer_messages use_agent_identity".split(" ").map(name => [name, ["underDevelopment"]]),
  ..."analytics_plan_history network_proxy".split(" ").map(name => [name, ["beta"]]),
  ..."transcript_v2 web_search_request web_search_cached use_legacy_landlock".split(" ").map(name => [name, ["deprecated"]]),
  ..."undo unified_exec_zsh_fork js_repl code_mode_buffered_exec js_repl_tools_only terminal_resize_reflow search_tool codex_git_commit sqlite local_thread_store_shared_compression apply_patch_freeform use_linux_sandbox_bwrap request_rule experimental_windows_sandbox elevated_windows_sandbox remote_models multi_agent_mode enable_fanout apps_mcp_path_override tool_search tool_search_always_defer_mcp_tools unavailable_dummy_tools plugin_hooks external_migration resize_all_images item_ids skill_env_var_dependency_prompt steer send_async_message guardianv2.thread_context guardian_ext collaboration_modes personality remote_control image_detail_original tui_app_server workspace_owner_usage_nudge responses_websockets responses_websockets_v2 remote_compaction_v2".split(" ").map(name => [name, ["removed"]]),
  ["prevent_idle_sleep", ["stable", "beta"]],
]);
const productionMethods = new Set(["initialize", "config/read", "configRequirements/read", "experimentalFeature/list", "model/list", "thread/start", "thread/name/set", "thread/read", "thread/resume", "turn/start", "turn/interrupt"]);
const policyFailure = () => new RuntimeError("POLICY_UNCONFIRMED");
const PREFLIGHT_BYTES = 65536;
function checkFeatureOutput(bytes: Buffer) {
  let output: string; try { output = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw policyFailure(); }
  const lines = output.trimEnd().split("\n"), names = new Set<string>(); if (!lines.length || lines.length > 256) throw policyFailure();
  for (const line of lines) {
    const row = line.match(/^([a-z][a-z0-9_.]{0,127})\s+(under development|experimental|stable|deprecated|removed)\s+(true|false)$/);
    if (!row || names.has(row[1])) throw policyFailure();
    const stage = row[2] === "under development" ? "underDevelopment" : row[2] === "experimental" ? "beta" : row[2];
    if (!Object.hasOwn(supportedFeatureStages, row[1]) || !supportedFeatureStages[row[1]].includes(stage)) throw policyFailure();
    names.add(row[1]);
    if ((executionGates as readonly string[]).includes(row[1]) && (stage !== "stable" || row[3] !== "false")) throw policyFailure();
  }
  if (executionGates.some(name => !names.has(name))) throw policyFailure();
}
async function reap(child: ChildProcessWithoutNullStreams, exit: Promise<void>) {
  const ended = async (ms: number) => { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); } finally { clearTimeout(timer); } };
  child.stdin.end();
  if (!await ended(250)) { child.kill("SIGTERM"); if (!await ended(1000)) { child.kill("SIGKILL"); if (!await ended(1000)) throw new RuntimeError("CLEANUP_INCOMPLETE"); } }
}
async function featurePreflight(executable: string, args: string[], root: string, environment: NodeJS.ProcessEnv, check: () => void, timeoutMs: number) {
  check(); const child = spawn(executable, args, { cwd: root, env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const exit = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined, liveTimer: ReturnType<typeof setInterval> | undefined;
  try {
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []; let stdout = 0, stderr = 0;
      const fail = () => reject(policyFailure());
      child.once("error", fail); child.stdin.on("error", fail);
      child.stdout.on("data", (data: Buffer) => { try { check(); stdout += data.length; if (stdout > PREFLIGHT_BYTES) fail(); else chunks.push(data); } catch (error) { reject(error); } });
      child.stderr.on("data", (data: Buffer) => { stderr += data.length; if (stderr > PREFLIGHT_BYTES) fail(); });
      child.once("close", code => code === 0 ? resolve(Buffer.concat(chunks)) : fail());
      timer = setTimeout(fail, Math.max(1, Math.min(timeoutMs, 10000)));
      liveTimer = setInterval(() => { try { check(); } catch (error) { reject(error); } }, 10);
      child.stdin.end();
    });
    check(); checkFeatureOutput(bytes); check();
  } finally { clearTimeout(timer); clearInterval(liveTimer); await reap(child, exit); }
  check();
}

const MAX_LINE = 1024 * 1024;
const MAX_JOBS = 64;
const failure = () => new RuntimeError("PROVIDER_UNAVAILABLE");
type Id = string | number;
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export class CodexTransport implements ProviderTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<Id, Pending>();
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private readonly rpcs = new Map<Id, { hash: string; result: Promise<ToolResult> }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private initialized = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private handler: ((params: unknown, live: () => void) => Promise<ToolResult>) | null = null;
  private readonly exit: Promise<void>;
  private stderrCount = 0;
  private readonly approvalDiagnostics = new Set<string>();
  private constructor(executable: string, args: string[], root: string, environment: NodeJS.ProcessEnv, private readonly timeoutMs = 10000, private readonly restricted = true) {
    this.child = spawn(executable, args, { cwd: root, env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.exit = new Promise(resolve => { this.child.once("close", () => { this.fail(); resolve(); }); });
    this.child.once("error", () => this.fail()); this.child.stdin.on("error", () => this.fail());
    this.child.stdout.on("data", (data: Buffer) => this.consume(data)); this.child.stdout.on("end", () => this.fail());
    this.child.stderr.on("data", (data: Buffer) => { this.stderrCount = Math.min(Number.MAX_SAFE_INTEGER, this.stderrCount + data.length); });
  }
  private static async admittedLaunch(executable: string, prefix: string[], root: string, overrides: string[], source: NodeJS.ProcessEnv, check: () => void, timeoutMs: number) {
    check(); if (overrides.length > 32 || overrides.some(value => Buffer.byteLength(value) > 65536) || Buffer.byteLength(stableJson(overrides)) > 131072) throw policyFailure();
    const environment = { ...providerEnvironment(source), CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" }, flags = overrides.flatMap(value => ["-c", value]);
    await featurePreflight(executable, [...prefix, ...flags, "features", "list"], root, environment, check, timeoutMs); check();
    // Separate official processes assume stable owner/managed configuration during admission.
    return new CodexTransport(executable, [...prefix, ...flags, "app-server", "--listen", "stdio://"], root, environment, timeoutMs);
  }
  static launch(root: string, overrides: string[], check: () => void) { return this.admittedLaunch("codex", [], root, overrides, process.env, check, 10000); }
  /** Constructor-only exact production launch replay with a synthetic executable. */
  static forTestLaunch(executable: string, prefix: string[], root: string, overrides: string[], environment: NodeJS.ProcessEnv, check: () => void, timeoutMs = 1000) { return this.admittedLaunch(executable, prefix, root, overrides, environment, check, timeoutMs); }
  /** Constructor-only injection: never accepted through product CLI/environment flags. */
  static forTest(executable: string, args: string[], root: string, environment: NodeJS.ProcessEnv = {}, timeoutMs = 1000) { return new CodexTransport(executable, args, root, providerEnvironment(environment), timeoutMs, false); }
  get childPid() { return this.child.pid; }
  get stderrBytes() { return this.stderrCount; }
  setToolHandler(handler: ((params: unknown, live: () => void) => Promise<ToolResult>) | null) { this.handler = handler; }
  onEvent(listener: (event: ProviderEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async initialize() {
    if (this.initialized || this.closed) throw failure();
    const response = await this.send("initialize", { clientInfo: { name: "ai-collab-owned", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    if (this.closed) throw failure(); await this.write({ method: "initialized", params: {} }); this.initialized = true; return response;
  }
  request(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs) {
    if (!this.initialized) return Promise.reject(failure()); return this.send(method, params, timeoutMs);
  }
  private send(method: string, params: Record<string, unknown>, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.restricted && !productionMethods.has(method)) return Promise.reject(policyFailure());
    if (this.closed || this.pending.size >= MAX_JOBS) return Promise.reject(failure());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(failure()); }, Math.max(1, Math.min(timeoutMs, 10000)));
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(() => { const pending = this.pending.get(id); if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(failure()); } });
    });
  }
  private write(value: unknown): Promise<void> {
    if (this.closed) return Promise.reject(failure()); const data = JSON.stringify(value) + "\n"; if (Buffer.byteLength(data) > MAX_LINE) return Promise.reject(failure());
    return new Promise((resolve, reject) => this.child.stdin.write(data, error => error ? reject(failure()) : resolve()));
  }
  private consume(data: Buffer) {
    if (this.closed) return;
    // A chunk may contain many valid bounded lines; do not require the chunk itself to be one line.
    let start = 0;
    for (let index = 0; index < data.length; index++) {
      if (data[index] !== 10) continue;
      const part = data.subarray(start, index); if (this.buffer.length + part.length > MAX_LINE) { this.fail(); return; }
      const line = Buffer.concat([this.buffer, part]); this.buffer = Buffer.alloc(0); start = index + 1;
      try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)); if (!object(value)) throw failure(); this.receive(value); } catch { this.fail(); return; }
    }
    const rest = data.subarray(start); if (this.buffer.length + rest.length > MAX_LINE) { this.fail(); return; } this.buffer = Buffer.concat([this.buffer, rest]);
  }
  private receive(value: Record<string, unknown>) {
    const id = value.id;
    if ((typeof id === "number" || typeof id === "string") && typeof value.method !== "string") {
      const pending = this.pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id);
      if (Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) pending.reject(failure()); else pending.resolve(value.result); return;
    }
    if (typeof value.method !== "string" || !object(value.params)) return;
    if (id !== undefined) {
      if (typeof id !== "string" && typeof id !== "number") { this.fail(); return; }
      const method = value.method; const params = value.params;
      if (method !== "item/tool/call" || !this.handler) {
        let result: unknown, kind: string | undefined;
        switch (method) {
          case "item/commandExecution/requestApproval": kind = "COMMAND"; result = { decision: "decline" }; break;
          case "item/fileChange/requestApproval": kind = "FILE_CHANGE"; result = { decision: "decline" }; break;
          case "execCommandApproval": case "applyPatchApproval": kind = "LEGACY_APPROVAL"; result = { decision: { denied: { rejection: "LOCAL_OWNER_APPROVAL_REQUIRED" } } }; break;
          case "item/permissions/requestApproval": kind = "PERMISSIONS"; result = { permissions: {}, scope: "turn" }; break;
          case "mcpServer/elicitation/request": kind = "ELICITATION"; result = { action: "decline" }; break;
          case "item/tool/requestUserInput": kind = "USER_INPUT"; break;
        }
        // Six fixed enum diagnostics per transport; no native parameters or authority inference.
        if (kind && !this.closed && !this.approvalDiagnostics.has(kind)) { this.approvalDiagnostics.add(kind); process.stderr.write(`LOCAL_OWNER_APPROVAL_REQUIRED:${kind}\n`); }
        if (this.closed || this.jobs.size >= MAX_JOBS) { this.fail(); return; }
        const job = this.write(result === undefined ? { id, error: { code: -32601, message: "TOOL_REJECTED" } } : { id, result }).catch(() => {});
        this.jobs.add(job); void job.finally(() => this.jobs.delete(job)); return;
      }
      const hash = stableJson({ method, params }); const prior = this.rpcs.get(id);
      if (prior && prior.hash !== hash || !prior && this.rpcs.size >= 256 || this.jobs.size >= MAX_JOBS) { void this.write({ id, result: rejectedTool() }).catch(() => {}); return; }
      const handler = this.handler;
      const live = () => { if (this.closed || this.handler !== handler) throw new RuntimeError("TOOL_REJECTED"); };
      const result = prior?.result ?? Promise.resolve().then(() => { live(); return handler(params, live); }).then(result => { live(); return result; }, () => rejectedTool());
      if (!prior) this.rpcs.set(id, { hash, result });
      const job = result.then(async result => { live(); await this.write({ id, result }); }).catch(() => {});
      this.jobs.add(job); void job.finally(() => this.jobs.delete(job)); return;
    }
    if (this.listeners.size > 64) { this.fail(); return; }
    for (const listener of this.listeners) { try { listener({ method: value.method, params: value.params }); } catch { this.fail(); } }
  }
  private fail() {
    this.closed = true; this.handler = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure()); } this.pending.clear();
  }
  close(): Promise<void> {
    this.closing ??= this.cleanup(); return this.closing;
  }
  private async cleanup() {
    this.fail(); this.child.stdin.end();
    const exited = async (milliseconds: number) => { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([this.exit.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), milliseconds); })]); } finally { clearTimeout(timer); } };
    if (!await exited(250)) { this.child.kill("SIGTERM"); if (!await exited(1000)) { this.child.kill("SIGKILL"); if (!await exited(1000)) throw new RuntimeError("CLEANUP_INCOMPLETE"); } }
    // Closed transport handlers cannot write after their late fulfillment; runner drains mutations separately.
    this.listeners.clear(); this.rpcs.clear();
  }
}
export function rejectedTool(): ToolResult { return { success: false, contentItems: [{ type: "inputText", text: "TOOL_REJECTED" }] }; }
