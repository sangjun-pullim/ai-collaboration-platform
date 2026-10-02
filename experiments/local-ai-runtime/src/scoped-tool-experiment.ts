import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { CodexRuntime, type RuntimeExecutionOptions } from "./codex-runtime.js";
import {
  ExperimentPolicyError, ExperimentStore, type ExperimentManifest, type ManifestRepository, type RunState,
} from "./experiment-policy.js";
import {
  SCOPED_DISABLED_FEATURES, SCOPED_TOOL_NAMESPACE, StdioClient, type DynamicToolHandler, type RuntimeClient,
  type RuntimeEvent, type ToolCallContext, type ToolCallResult,
} from "./stdio-client.js";
import { isWorkspacePath, WorkspaceFilePolicy } from "./workspace-file-policy.js";

const PROMPT = [
  `Use ${SCOPED_TOOL_NAMESPACE}.read_workspace_file to read public-context.txt and tool-proof.txt in this synthetic workspace.`,
  `Use ${SCOPED_TOOL_NAMESPACE}.ask_peer once to send peer-fixture a short synthetic question with public-context.txt evidence.`,
  "Your final answer must contain only the exact text read from tool-proof.txt, with no added characters.",
].join("\n");

export const SCOPED_TOOL_SPECS = [
  {
    type: "namespace", name: SCOPED_TOOL_NAMESPACE,
    description: "Read public synthetic workspace files and record questions for the local peer-fixture.",
    tools: [
      {
        type: "function", name: "read_workspace_file", description: "Read one allowlisted public synthetic text file.",
        inputSchema: { type: "object", properties: { path: { type: "string", enum: ["public-context.txt", "tool-proof.txt"] } }, required: ["path"], additionalProperties: false },
      },
      {
        type: "function", name: "ask_peer", description: "Record a structured question for the local peer-fixture; no other AI is invoked.",
        inputSchema: {
          type: "object", properties: {
            target: { type: "string", enum: ["peer-fixture"] }, question: { type: "string", minLength: 1, maxLength: 2000 },
            evidence: { type: "array", maxItems: 4, items: { type: "object", properties: {
              path: { type: "string", enum: ["public-context.txt", "tool-proof.txt"] },
              startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 },
            }, required: ["path", "startLine", "endLine"], additionalProperties: false } },
          }, required: ["target", "question", "evidence"], additionalProperties: false,
        },
      },
    ],
  },
] as const;

export interface PeerQuestion {
  readonly target: "peer-fixture";
  readonly question: string;
  readonly evidence: readonly { readonly path: string; readonly startLine: number; readonly endLine: number }[];
}

export function validatePeerQuestion(value: unknown): PeerQuestion {
  const args = record(value);
  if (!exactKeys(args, ["target", "question", "evidence"]) || args.target !== "peer-fixture" ||
      typeof args.question !== "string" || args.question.trim().length === 0 || args.question.length > 2000 ||
      args.question.includes("\0") || !Array.isArray(args.evidence) || args.evidence.length > 4) throw rejected();
  const evidence = args.evidence.map((value: unknown) => {
    const item = record(value);
    if (!exactKeys(item, ["path", "startLine", "endLine"]) || !isWorkspacePath(item.path) ||
        !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine) ||
        Number(item.startLine) < 1 || Number(item.endLine) < Number(item.startLine)) throw rejected();
    return { path: item.path, startLine: Number(item.startLine), endLine: Number(item.endLine) };
  });
  return { target: "peer-fixture", question: args.question, evidence };
}

export function assertScopedPolicy(response: unknown): void {
  const config = record(record(response).config);
  const disabledMap = (value: unknown) => isRecord(value) && Object.values(value).every((entry) => isRecord(entry) && entry.enabled === false);
  const apps = record(config.apps);
  const directNamespaces = record(record(config.features).code_mode).direct_only_tool_namespaces;
  if (config.approval_policy !== "never" || config.sandbox_mode !== "read-only" ||
      !disabledMap(config.mcp_servers) || !disabledMap(config.plugins) ||
      record(apps._default).enabled !== false || Object.entries(apps).some(([key, value]) => key !== "_default" && record(value).enabled !== false) ||
      config.web_search !== "disabled" || record(config.agents).enabled !== false ||
      record(config.shell_environment_policy).inherit !== "none" ||
      !Array.isArray(directNamespaces) || directNamespaces.length !== 1 || directNamespaces[0] !== SCOPED_TOOL_NAMESPACE ||
      SCOPED_DISABLED_FEATURES.some((name) => record(config.features)[name] !== false)) {
    throw new ExperimentPolicyError("TOOL_POLICY_UNCONFIRMED");
  }
}

export interface ScopedToolResult {
  readonly state: RunState;
  readonly policyVerified: boolean;
  readonly readCallbacks: number;
  readonly peerCallbacks: number;
  readonly fileMarkerMatched: boolean;
  readonly success: boolean;
  readonly unverified: readonly string[];
}

export interface ScopedToolOptions {
  /** Deterministic injection seams never accept CLI input. */
  readonly clientFactory?: (cwd: string, handler: DynamicToolHandler) => RuntimeClient;
  readonly markerFactory?: () => string;
  readonly beforePreparation?: () => Promise<void>;
  readonly beforeToolCommit?: (tool: string) => Promise<void>;
  readonly ackWaitMs?: number;
}

type ExecutionOptions = Omit<RuntimeExecutionOptions, "prompt">;

export class ScopedToolExperiment {
  readonly #runtime: CodexRuntime;
  readonly #cancellation = new AbortController();
  readonly #operations = new Set<Promise<ScopedToolResult>>();
  #attempt: ToolAttempt | undefined;
  #preparing = false;

  public constructor(private readonly options: ScopedToolOptions = {}) {
    this.#runtime = new CodexRuntime((cwd) => {
      const attempt = this.#attempt;
      if (attempt === undefined || attempt.root !== cwd) throw rejected();
      const raw = options.clientFactory?.(cwd, attempt.handle) ?? StdioClient.launchScopedCodex({
        cwd, experimentalApi: true, dynamicToolHandler: attempt.handle,
      });
      return attempt.wrap(raw);
    });
  }

  public assertAdmission(): void { this.#runtime.assertAdmission(); }

  public async shutdown(): Promise<void> {
    this.#cancellation.abort();
    await this.#runtime.shutdown();
    const outcomes = await Promise.allSettled([...this.#operations]);
    // The caller of each operation receives its own error; shutdown waits for lock cleanup.
    void outcomes;
  }

  public runNew(store: ExperimentStore, options: ExecutionOptions): Promise<ScopedToolResult> {
    return this.#track(this.#execute(store, "run", options));
  }
  public resume(store: ExperimentStore, options: ExecutionOptions): Promise<ScopedToolResult> {
    return this.#track(this.#execute(store, "resume", options));
  }

  #track(operation: Promise<ScopedToolResult>): Promise<ScopedToolResult> {
    this.#operations.add(operation);
    void operation.then(() => this.#operations.delete(operation), () => this.#operations.delete(operation));
    return operation;
  }

  async #execute(store: ExperimentStore, operation: "run" | "resume", options: ExecutionOptions): Promise<ScopedToolResult> {
    this.assertAdmission();
    if (this.#preparing) throw new ExperimentPolicyError("TOOL_EXPERIMENT_BUSY");
    this.#preparing = true;
    try { return await store.withLock(async (manifest) => {
      this.assertAdmission();
      if (this.#attempt !== undefined) throw new ExperimentPolicyError("TOOL_EXPERIMENT_BUSY");
      if (manifest.root !== store.root || manifest.contextMarkerHash !== undefined ||
          (operation === "run" ? manifest.state !== "READY" : manifest.state !== "COMPLETED")) {
        throw new ExperimentPolicyError(operation === "run" ? "RUN_NOT_ALLOWED" : "RESUME_NOT_ALLOWED");
      }
      const policy = new WorkspaceFilePolicy(store.root);
      if (this.options.beforePreparation !== undefined) await this.#runtime.prepare(Promise.resolve().then(this.options.beforePreparation));
      this.assertAdmission();
      const marker = this.options.markerFactory?.() ?? randomBytes(24).toString("hex");
      policy.replaceProof(marker, () => this.assertAdmission());
      this.assertAdmission();
      const attempt = new ToolAttempt(manifest, policy, hash(marker), this.#cancellation.signal, this.options);
      this.#attempt = attempt;
      // Reuse runtime lifecycle inside the already-held store lock; do not reacquire SQLite.
      let current = manifest;
      const locked: ManifestRepository = {
        manifestPath: store.manifestPath,
        withLock: async (fn) => await fn(current),
        save: async (value) => { await store.save(value); current = value; },
      };
      try {
        const result = operation === "run"
          ? await this.#runtime.runNew(locked, { ...options, prompt: PROMPT })
          : await this.#runtime.resume(locked, { ...options, prompt: PROMPT });
        return attempt.result(result.state);
      } finally { attempt.close(); this.#attempt = undefined; }
    }); } finally { this.#preparing = false; }
  }
}

class ToolAttempt {
  public readonly root: string;
  readonly #calls = new Map<string, { key: string; result: Promise<ToolCallResult> }>();
  readonly #events: RuntimeEvent[] = [];
  readonly #terminals = new Set<string>();
  #threadId: string | undefined;
  #turnId: string | undefined;
  #pendingTurn = false;
  #closed = false;
  #ackResolve: (() => void) | undefined;
  #ack: Promise<void> = Promise.resolve();
  #readCount = 0;
  #proofReads = 0;
  #peerRecords: PeerQuestion[] = [];
  #policyVerified = false;

  public constructor(
    private readonly manifest: ExperimentManifest,
    private readonly policy: WorkspaceFilePolicy,
    private readonly markerHash: string,
    private readonly cancellation: AbortSignal,
    private readonly options: ScopedToolOptions,
  ) { this.root = manifest.root; }

  public close(): void { this.#closed = true; this.#ackResolve?.(); }

  public wrap(raw: RuntimeClient): RuntimeClient {
    const unsubscribe = raw.onEvent((event) => {
      if (this.#closed) return;
      this.#events.push(event);
      if (event.kind === "turn/completed" && event.threadId === this.#threadId && event.turnId !== undefined) this.#terminals.add(event.turnId);
      if (event.kind === "transport/error") this.close();
    });
    return {
      get childPid() { return raw.childPid; },
      get stderrBytes() { return raw.stderrBytes; },
      onEvent: (listener) => raw.onEvent(listener),
      initialize: async () => {
        const initialized = await raw.initialize();
        this.#assertOpen();
        assertScopedPolicy(await raw.request("config/read", { includeLayers: false }));
        this.#assertOpen();
        this.#policyVerified = true;
        return initialized;
      },
      request: async (method, params, timeoutMs) => {
        this.#assertOpen();
        if (method === "thread/start" || method === "thread/resume") {
          if (!this.#policyVerified) throw new ExperimentPolicyError("TOOL_POLICY_UNCONFIRMED");
          const response = await raw.request(method, method === "thread/start" ? { ...params, dynamicTools: SCOPED_TOOL_SPECS } : params, timeoutMs);
          this.#assertOpen();
          const thread = record(record(response).thread);
          if (typeof thread.id !== "string" || thread.id.length === 0 || typeof thread.cwd !== "string" ||
              realpathSync(thread.cwd) !== this.root || thread.cwd !== this.root ||
              (method === "thread/resume" && thread.id !== this.manifest.threadLocator)) throw new ExperimentPolicyError("TOOL_THREAD_MISMATCH");
          this.#threadId = thread.id;
          return response;
        }
        if (method === "turn/start") {
          if (params.threadId !== this.#threadId || this.#threadId === undefined || this.#pendingTurn || this.#turnId !== undefined) throw rejected();
          this.#pendingTurn = true;
          this.#ack = new Promise<void>((resolve) => { this.#ackResolve = resolve; });
          try {
            const response = await raw.request(method, params, timeoutMs);
            this.#assertOpen();
            const turn = record(record(response).turn);
            if (typeof turn.id !== "string" || turn.id.length === 0) throw rejected();
            this.#turnId = turn.id;
            return response;
          } finally { this.#pendingTurn = false; this.#ackResolve?.(); }
        }
        return await raw.request(method, params, timeoutMs);
      },
      close: async () => { this.close(); unsubscribe(); await raw.close(); },
    };
  }

  public readonly handle: DynamicToolHandler = async (params, context) => {
    try {
      const call = record(params);
      if (typeof call.threadId !== "string" || typeof call.turnId !== "string" || typeof call.callId !== "string" ||
          call.callId.length === 0 || call.callId.length > 256 || typeof call.tool !== "string" ||
          call.namespace !== SCOPED_TOOL_NAMESPACE ||
          !Object.keys(call).every((key) => ["threadId", "turnId", "callId", "tool", "arguments", "namespace"].includes(key))) throw rejected();
      if (!this.#pendingTurn && this.#turnId === undefined) throw rejected();
      if (this.#pendingTurn) await waitForAck(this.#ack, context.signal, Math.min(this.options.ackWaitMs ?? 500, 1000));
      this.#assertCall(call, context);
      const key = canonical({ tool: call.tool, arguments: call.arguments });
      const existing = this.#calls.get(call.callId);
      if (existing !== undefined) {
        if (existing.key !== key) throw rejected();
        const result = await existing.result;
        this.#assertCall(call, context);
        return result;
      }
      if (this.#calls.size >= 32) throw rejected();
      const result = this.#perform(call, context).catch(() => failure());
      this.#calls.set(call.callId, { key, result });
      const value = await result;
      this.#assertCall(call, context);
      return value;
    } catch { return failure(); }
  };

  async #perform(call: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
    this.#assertCall(call, context);
    const args = record(call.arguments);
    if (call.tool === "read_workspace_file") {
      if (!exactKeys(args, ["path"]) || !isWorkspacePath(args.path)) throw rejected();
      const content = this.policy.read(args.path);
      if (this.options.beforeToolCommit !== undefined) await this.options.beforeToolCommit(call.tool);
      this.#assertCall(call, context);
      this.#readCount++;
      if (args.path === "tool-proof.txt") this.#proofReads++;
      return success(content);
    }
    if (call.tool === "ask_peer") {
      const question = validatePeerQuestion(call.arguments);
      for (const evidence of question.evidence) {
        const lines = this.policy.read(evidence.path).split("\n");
        if (evidence.endLine > lines.length) throw rejected();
      }
      if (this.options.beforeToolCommit !== undefined) await this.options.beforeToolCommit(call.tool);
      this.#assertCall(call, context);
      this.#peerRecords.push(question);
      return success("FIXTURE_QUESTION_RECORDED");
    }
    throw rejected();
  }

  #assertOpen(): void { if (this.#closed || this.cancellation.aborted) throw rejected(); }
  #assertCall(call: Record<string, unknown>, context: ToolCallContext): void {
    this.#assertOpen();
    if (!context.isActive() || context.signal.aborted || call.threadId !== this.#threadId ||
        this.#turnId === undefined || call.turnId !== this.#turnId || this.#terminals.has(this.#turnId)) throw rejected();
  }

  public result(state: RunState): ScopedToolResult {
    const terminalIndex = this.#events.findIndex((event) => event.kind === "turn/completed" &&
      event.threadId === this.#threadId && event.turnId === this.#turnId);
    const final = terminalIndex < 0 ? undefined : this.#events.slice(0, terminalIndex).filter((event) =>
      event.kind === "item/completed" && event.threadId === this.#threadId && event.turnId === this.#turnId && event.phase === "final_answer").at(-1);
    const matched = this.#proofReads > 0 && final?.textHash === this.markerHash;
    return {
      state, policyVerified: this.#policyVerified, readCallbacks: this.#readCount, peerCallbacks: this.#peerRecords.length,
      fileMarkerMatched: matched,
      success: state === "COMPLETED" && this.#policyVerified && this.#readCount >= 2 && this.#peerRecords.length === 1 && matched,
      unverified: ["peer-ai", "durable-delivery", "two-device-roundtrip", "provider-account-eligibility", ...(!matched ? ["current-turn-final-answer"] : [])],
    };
  }
}

async function waitForAck(ack: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let abort: () => void = () => undefined;
  try {
    await Promise.race([ack, new Promise<never>((_, reject) => {
      abort = () => reject(rejected());
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(abort, timeoutMs);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
function success(text: string): ToolCallResult { return { success: true, contentItems: [{ type: "inputText", text }] }; }
function failure(): ToolCallResult { return { success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_REJECTED" }] }; }
function rejected(): ExperimentPolicyError { return new ExperimentPolicyError("TOOL_CALL_REJECTED"); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return keys.length === Object.keys(value).length && keys.every((key) => Object.hasOwn(value, key)); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
