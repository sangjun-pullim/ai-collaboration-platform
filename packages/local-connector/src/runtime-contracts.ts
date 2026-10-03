import { createHash } from "node:crypto";
import type { AttemptSnapshot, Body, DeviceAction, RequestPayload, Terminal, TerminalReceipt } from "./workflow-contracts.ts";

export const runtimeVersion = 1 as const;
export const codexVersion = "0.159.1";
export const scopedNamespace = "ai_collaboration_scoped";
export type RuntimeCode = "RUNTIME_CAPACITY" | "INVALID_RUNTIME" | "UNSAFE_STORAGE" | "RUNTIME_BUSY" | "POLICY_UNCONFIRMED" | "UNSUPPORTED_SETTINGS" | "CONTEXT_UNCONFIRMED" | "SNAPSHOT_CHANGED" | "TOOL_REJECTED" | "PUBLIC_TEXT_REJECTED" | "AUTHORITY_LOST" | "PROVIDER_UNAVAILABLE" | "UNKNOWN" | "CLEANUP_INCOMPLETE" | "RUNTIME_CLOSED";
export class RuntimeError extends Error { constructor(readonly code: RuntimeCode) { super(code); } }
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
export interface RuntimeScope { server: string; deviceId: string; organizationId: string; roomId: string; agentId: string; bindingEpoch: number }
export interface RequestedSettings { model: string; effort: string }
export interface ModelCapability { id: string; model: string; efforts: string[]; defaultEffort: string; isDefault: boolean }
export interface Capabilities { version: typeof codexVersion; models: ModelCapability[]; defaultSettings: RequestedSettings | null; snapshotHash: string; policy: "CONFIRMED" }
export interface SettingsObservation {
  requested: RequestedSettings;
  thread: { model: string | null; provider: string; effort: string | null };
  turn: { requestedModel: string; requestedEffort: string; model: string | null; rerouted: boolean; effortVerification: "UNVERIFIED" };
}
export interface RootIdentity { path: string; dev: number; ino: number; uid: number }
export interface FileSnapshot { path: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; hash: string }
export interface OwnedContext {
  ownership: "CONNECTOR_CREATED"; generation: string; threadId: string; root: RootIdentity; epoch: number;
  level: "L1" | "L2"; ownedTurns: { turnId: string; terminal: Terminal }[];
}
export interface RuntimeSettings { provider: "codex"; requested: RequestedSettings; capabilities: Capabilities; files: FileSnapshot[]; handoff: string; publicScopeConfirmed: true; autoQuestionsConfirmed: boolean }
export type JournalState = "CLAIM_PENDING" | "CLAIMED" | "SERVER_INTENT_PENDING" | "SERVER_INTENT_CONFIRMED" | "PROVIDER_INTENT" | "ACKNOWLEDGED" | "RUNNING" | "TERMINAL" | "UPLOADED" | "UNKNOWN" | "NOT_STARTED";
export interface TerminalEvidence {
  threadId: string; turnId: string; terminal: Terminal; privateText: string; publicText: string;
  finalItems: { id: string; hash: string }[]; textProof: "FINAL_ANSWER" | "UNCONFIRMED"; observation: SettingsObservation;
}
export interface RuntimeOperation {
  operationId: string; action: DeviceAction; body: Body; payloadHash: string;
  state: "PENDING" | "TRANSMITTED" | "CONFIRMED" | "CLOSED"; result: unknown | null;
}
export interface AttemptJournal {
  requestId: string; scope: RuntimeScope; generation: string; state: JournalState;
  claimOperationId?: string;
  unstartedClosure?: { kind: "LOCAL_NOT_TRANSMITTED"; claimOperationId: string } | { kind: "SERVER_ABANDONED"; claimOperationId: string; snapshot: AttemptSnapshot };
  snapshot: AttemptSnapshot | null; native: { threadId: string; turnId: string } | null;
  terminal: TerminalEvidence | null; receipt: TerminalReceipt | null; reason: RuntimeCode | null;
  toolCalls: { callId: string; payloadHash: string; operationId: string | null; result: ToolResult | null }[];
}
export interface PreparationJournal {
  operationId: string; previousEpoch: number; generation: string; settings: RuntimeSettings;
  candidate: OwnedContext | null; state: "PROVIDER_PENDING" | "PROVIDER_CREATED" | "CANDIDATE" | "REPLACE_PENDING";
}
export interface RuntimeArchiveReference {
  hash: string;
  requestIds: string[];
}
export interface RuntimeLastArchive {
  hash: string;
  attemptId: string;
}
export interface RuntimeRecord {
  version: 1; scope: RuntimeScope; settings: RuntimeSettings | null; context: OwnedContext | null;
  archives?: RuntimeArchiveReference[]; lastArchive?: RuntimeLastArchive;
  ready: boolean; preparation: PreparationJournal | null; attempts: AttemptJournal[]; operations: RuntimeOperation[];
}
export interface ToolResult { success: boolean; contentItems: { type: "inputText"; text: string }[] }
export interface ToolCall { threadId: string; turnId: string; callId: string; namespace: string; tool: string; arguments: unknown }
export interface AttemptAuthority {
  scope: RuntimeScope; context: OwnedContext; attempt: AttemptSnapshot; signal: AbortSignal;
  assertLive(): void; ack(threadId: string, turnId: string): Promise<void>;
  tool(call: ToolCall): Promise<ToolResult>;
}
export interface RuntimeAdapter {
  capabilities(root: string, assertLive: () => void): Promise<Capabilities>;
  prepare(root: RootIdentity, settings: RuntimeSettings, generation: string, epoch: number, assertLive: () => void, onCreated?: (context: OwnedContext) => Promise<void>): Promise<OwnedContext>;
  validate(context: OwnedContext, settings: RuntimeSettings, assertLive: () => void): Promise<SettingsObservation>;
  execute(authority: AttemptAuthority, settings: RuntimeSettings, payload: RequestPayload, beforeSubmit: () => Promise<void>): Promise<TerminalEvidence>;
  interrupt(authority: AttemptAuthority): Promise<boolean>;
  observe(context: OwnedContext, settings: RuntimeSettings, native: { threadId: string; turnId: string }, assertLive: () => void): Promise<TerminalEvidence | null>;
  close(): Promise<void>;
}

/** Cancellation closes admission permanently. It does not undo already transmitted operations. */
export class RuntimeAdmission {
  readonly controller = new AbortController();
  private generation = 0;
  private paused = 0;
  private jobs = new Set<Promise<unknown>>();
  get signal() { return this.controller.signal; }
  get closed() { return this.signal.aborted; }
  assert() { if (this.closed) throw new RuntimeError("RUNTIME_CLOSED"); }
  assertTool() { this.assert(); if (this.paused) throw new RuntimeError("TOOL_REJECTED"); }
  pause() { this.assert(); this.paused++; }
  resume() { this.assert(); this.paused = Math.max(0, this.paused - 1); }
  close() { if (!this.closed) { this.generation++; this.controller.abort(); } }
  track<T>(run: () => Promise<T>): Promise<T> {
    this.assert(); const generation = this.generation;
    const job = Promise.resolve().then(() => { this.assert(); return run(); }).then(value => {
      this.assert(); if (generation !== this.generation) throw new RuntimeError("RUNTIME_CLOSED"); return value;
    });
    this.jobs.add(job); void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job)); return job;
  }
  async wait<T>(run: () => Promise<T>): Promise<T> {
    const job = this.track(run);
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([job, new Promise<T>((_resolve, reject) => {
        abort = () => reject(new RuntimeError("RUNTIME_CLOSED"));
        if (this.closed) abort(); else this.signal.addEventListener("abort", abort, { once: true });
      })]);
    } finally { if (abort) this.signal.removeEventListener("abort", abort); }
  }
  async drain(timeoutMs = 2000): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.allSettled([...this.jobs]).then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
}
