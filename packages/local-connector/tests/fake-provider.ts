import { capabilities } from "./runtime-fixture.ts";
import type { ProviderEvent, ProviderTransport } from "../src/codex-transport.ts";
import { codexVersion, RuntimeError, type ToolResult } from "../src/runtime-contracts.ts";
export function hookDiscovery(cwd: string, hooks: unknown[] = []) {
  return { data: [{ cwd, hooks, errors: [], warnings: [] }] };
}
export function discoveredHook(overrides: Record<string, unknown> = {}) {
  return { currentHash: "synthetic-source-hash", displayOrder: 0, enabled: true, eventName: "sessionStart", isManaged: false, key: "synthetic-hook", source: "user", sourcePath: "/synthetic/private/hooks.json", timeoutSec: 10, trustStatus: "trusted", handlerType: "command", command: "synthetic-private-command", matcher: null, ...overrides };
}
const gates = ["plugins", "apps", "hooks", "remote_plugin", "skill_mcp_dependency_install", "multi_agent", "multi_agent_v2", "image_generation", "in_app_browser", "browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use"];
export function effectivePolicy() {
  return { config: { approval_policy: "never", sandbox_mode: "read-only", approvals_reviewer: "user", apps: { _default: { default_tools_approval_mode: "writes", approvals_reviewer: "user" } }, mcp_servers: {}, plugins: {},
    features: { shell_tool: true, memories: true, code_mode: true, ...Object.fromEntries(gates.map(name => [name, false])) }, agents: { enabled: false }, notify: [], developer_instructions: "SYNTHETIC_PERSONAL", project_doc_max_bytes: 32768, skills: { include_instructions: true }, memories: { use_memories: true }, hooks: { SessionStart: [], state: { bookkeeping: true } },
  } as Record<string, unknown>, layers: [{ name: { type: "user", file: "/synthetic/private/config.toml" }, version: "synthetic-v1", config: {} }], origins: {} };
}
// Independently parse the small literal TOML argv subset used by task permission maps.
function parseOverride(input: string): unknown {
  let index = 0;
  const space = () => { while (/\s/.test(input[index] ?? "") && index < input.length) index++; };
  const quoted = () => { const start = index++; while (index < input.length) { if (input[index++] === "\\") index++; else if (input[index - 1] === '"') return JSON.parse(input.slice(start, index)); } throw new Error("SYNTHETIC_BAD_TOML"); };
  const value = (): unknown => {
    space(); if (input.startsWith("[]", index)) { index += 2; return []; } if (input[index] === '"') return quoted();
    if (input[index] === "{") { index++; const entries: [string, unknown][] = []; space(); while (input[index] !== "}") { if (input[index] !== '"') throw new Error("SYNTHETIC_BAD_TOML"); const key = quoted(); space(); if (input[index++] !== "=") throw new Error("SYNTHETIC_BAD_TOML"); entries.push([key, value()]); space(); if (input[index] === ",") { index++; space(); } else if (input[index] !== "}") throw new Error("SYNTHETIC_BAD_TOML"); } index++; return Object.fromEntries(entries); }
    if (input.startsWith("true", index)) { index += 4; return true; } if (input.startsWith("false", index)) { index += 5; return false; }
    throw new Error("SYNTHETIC_BAD_TOML");
  };
  const result = value(); space(); if (index !== input.length) throw new Error("SYNTHETIC_BAD_TOML"); return result;
}
function mergePolicy(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const result = base && typeof base === "object" && !Array.isArray(base) ? structuredClone(base) as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(patch)) Object.defineProperty(result, key, { value: mergePolicy(result[key], value), enumerable: true, writable: true, configurable: true });
  return result;
}
export class FakeProvider implements ProviderTransport {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  policy = effectivePolicy(); required: unknown = { requirements: null };
  listeners = new Set<(event: ProviderEvent) => void>();
  handler: ((params: unknown, live: () => void) => Promise<ToolResult>) | null = null;
  closed = false;
  response?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
  thread: Record<string, unknown> = {};
  constructor(readonly storedThreads = new Map<string, Record<string, unknown>>()) {}
  installed: unknown = { marketplaces: [], marketplaceLoadErrors: [] };
  pluginDetails = new Map<string, unknown>();
  preflights: string[][] = []; serverStarts = 0;
  launch(overrides: string[]) {
    this.preflights.push([...overrides]);
    const required = (this.required as { requirements: { featureRequirements?: Record<string, unknown> } | null }).requirements?.featureRequirements;
    if (required && gates.some(name => required[name] === true)) throw new RuntimeError("POLICY_UNCONFIRMED");
    this.closed = false; this.serverStarts++;
    for (const override of overrides) { const index = override.indexOf("="); const key = override.slice(0, index); if (index < 1 || key.includes(".")) throw new Error("SYNTHETIC_BAD_TOML_KEY"); this.policy.config = mergePolicy(this.policy.config, { [key]: parseOverride(override.slice(index + 1)) }) as Record<string, unknown>; }
    return this;
  }
  async initialize() { return { userAgent: `codex/${codexVersion}` }; }
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params }); const injected = await this.response?.(method, params); if (injected !== undefined) return injected;
    if (method === "config/read") return structuredClone(this.policy);
    if (method === "configRequirements/read") return structuredClone(this.required);
    if (method === "hooks/list") return hookDiscovery((params.cwds as string[])[0]);
    if (method === "plugin/installed") return structuredClone(this.installed);
    if (method === "plugin/read") { const detail = this.pluginDetails.get(String(params.pluginName)); if (!detail) throw new Error("SYNTHETIC_MISSING_PLUGIN"); return structuredClone(detail); }
    if (method === "experimentalFeature/list") {
      const names = [...gates, "shell_tool", "memories", "code_mode"];
      const data = names.map(name => ({ name, stage: name === "code_mode" ? "underDevelopment" : "stable", enabled: this.policy.config.features ? (this.policy.config.features as Record<string, boolean>)[name] ?? false : false, defaultEnabled: false, displayName: null, description: null, announcement: null }));
      return { data, nextCursor: null };
    }
    if (method === "model/list") return { data: capabilities().models.map(m => ({ id: m.id, model: m.model, defaultReasoningEffort: m.defaultEffort, isDefault: m.isDefault, supportedReasoningEfforts: m.efforts.map(reasoningEffort => ({ reasoningEffort })) })), nextCursor: null };
    if (method === "thread/start") { this.thread = { id: "synthetic-thread", cwd: params.cwd, status: { type: "idle" }, turns: [], historyMode: "legacy", model: params.model, modelProvider: "openai", reasoningEffort: (params.config as Record<string, unknown>).model_reasoning_effort }; return { thread: this.thread, model: this.thread.model, modelProvider: "openai", reasoningEffort: this.thread.reasoningEffort }; }
    if (method === "thread/name/set") {
      if (params.threadId !== this.thread.id || typeof params.name !== "string") throw new RuntimeError("CONTEXT_UNCONFIRMED");
      this.thread.name = params.name; this.storedThreads.set(String(this.thread.id), structuredClone(this.thread)); return {};
    }
    if (method === "thread/read" || method === "thread/resume") {
      const stored = this.storedThreads.get(String(params.threadId)); if (!stored) throw new RuntimeError("CONTEXT_UNCONFIRMED");
      if (method === "thread/resume" && this.thread.id !== params.threadId) this.thread = { ...structuredClone(stored), status: { type: "idle" } };
      const thread = this.thread.id === params.threadId ? this.thread : { ...structuredClone(stored), status: { type: "notLoaded" } };
      return { thread, model: thread.model, modelProvider: "openai", reasoningEffort: thread.reasoningEffort };
    }
    if (method === "turn/interrupt") return {};
    throw new Error("SYNTHETIC_UNSUPPORTED");
  }
  emit(method: string, params: Record<string, unknown>) { for (const listener of this.listeners) listener({ method, params }); }
  onEvent(listener: (event: ProviderEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  setToolHandler(handler: ((params: unknown, live: () => void) => Promise<ToolResult>) | null) { this.handler = handler; }
  async close() { this.closed = true; this.handler = null; }
}
