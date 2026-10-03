import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync } from "node:fs";
import { ApprovalBudget, OwnedProbeStore, ProbeError, digest, object, readPrivate,
  type Command, type InputIntent, type Refusal } from "./owned-probe-store.js";
import { NativeTransport, type Cleanup, type Launch, type TransportOptions } from "./native-transport.js";
import { TaskPolicy, SelectedFiles, NATIVE_TOOL_NAMES, OWNED_SERVER, TOOL_NAMES } from "./task-policy.js";

export interface HistoryProof { materialized: boolean; sessionId: string; root: string; records: Record<string, unknown>[] }
export interface RuntimeOptions {
  launch?: (args: string[], resume: boolean) => Launch;
  transport?: TransportOptions;
  history?: () => Promise<HistoryProof>;
  toolResponseGate?: (name: string, signal: AbortSignal) => Promise<void>;
  driftMs?: number;
}
export interface DefaultObservation {
  requestedModel: null;
  initializedModel: string | null;
  observedModel: string | null;
  effort: { status: "UNVERIFIED" } | { status: "OBSERVED"; value: string };
  models: { value: string; resolvedModel: string | null; efforts: string[] | null }[];
}
interface Active {
  intent: InputIntent;
  ack: boolean;
  toolOpen: boolean;
  tools: Map<string, { name: string; argsHash: string }>;
  dispatched: Map<string, { hash: string; response: Promise<Record<string, unknown>> }>;
  responsesStarted: Set<string>;
  terminal: boolean;
  resolve: (value: "COMPLETED" | "INTERRUPTED") => void;
  reject: (error: ProbeError) => void;
  promise: Promise<"COMPLETED" | "INTERRUPTED">;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const protocolString = (value: unknown, accepted: readonly string[]): value is string =>
  typeof value === "string" && accepted.includes(value);
const boundedString = (v: unknown, max = 200): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Exact file only. No project/session listing, rename or native transcript injection. */
export async function readExactOwnedHistory(path: string, sessionId: string, root: string): Promise<HistoryProof> {
  if (basename(path) !== `${sessionId}.jsonl`) throw new ProbeError("HISTORY_UNCONFIRMED");
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { materialized: false, sessionId, root, records: [] };
    throw new ProbeError("HISTORY_UNCONFIRMED");
  }
  try {
    const bytes = readPrivate(path);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (decoded && !decoded.endsWith("\n")) throw new ProbeError("HISTORY_UNCONFIRMED");
    const records = decoded.split("\n").filter(Boolean).map((line) => object(JSON.parse(line)));
    if (records.length > 256) throw new ProbeError("HISTORY_UNCONFIRMED");
    return { materialized: true, sessionId, root, records };
  } catch { throw new ProbeError("HISTORY_UNCONFIRMED"); }
}

function abortable<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new ProbeError("RUNTIME_CLOSED")); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) { reject(new ProbeError("RUNTIME_CLOSED")); return; }
    signal.addEventListener("abort", abort, { once: true });
    job.then((value) => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
  });
}

export class NativeRuntime {
  #transport: NativeTransport | undefined;
  #closed = false;
  #failure: ProbeError | undefined;
  #active: Active | undefined;
  #initSeen = false;
  #drift: NodeJS.Timeout | undefined;
  #closing: Promise<Cleanup> | undefined;
  #interruptReceipt: unknown;
  #defaults: DefaultObservation = {
    requestedModel: null, initializedModel: null, observedModel: null,
    effort: { status: "UNVERIFIED" }, models: [],
  };

  constructor(readonly store: OwnedProbeStore, readonly budget: ApprovalBudget, readonly policy: TaskPolicy,
    readonly files: SelectedFiles, private readonly executable: string, private readonly environment: NodeJS.ProcessEnv,
    private readonly options: RuntimeOptions = {}) {}

  get defaults(): DefaultObservation { return structuredClone(this.#defaults); }
  get interruptReceiptObserved(): boolean { return this.#interruptReceipt !== undefined; }
  get reaped(): boolean { return this.#transport?.reaped ?? true; }

  assertLive(): void {
    if (this.#closed) throw this.#failure ?? new ProbeError("RUNTIME_CLOSED");
    this.store.assertLocked();
    this.policy.assertLive();
    this.files.assertUnchanged();
    const saved = this.store.read().fileSnapshotHash;
    if (saved !== null && saved !== digest(JSON.stringify(this.files.snapshots()))) throw new ProbeError("FILE_REJECTED");
  }

  async initialize(resume = false): Promise<void> {
    this.store.assertLocked();
    this.policy.admit();
    this.assertLive();
    if (this.#transport) throw new ProbeError("BUSY");
    const state = this.store.read();
    if (state.inputs.some((i) => !i.terminal)) throw new ProbeError("INPUT_UNRESOLVED");
    this.budget.assertResolved(this.store);
    if (resume) await this.verifyHistory(false);
    this.assertLive();
    this.store.update((s) => {
      const hash = digest(JSON.stringify(this.files.snapshots()));
      s.fileSnapshotHash = hash;
      s.evidence.push({ kind: "FILE_SNAPSHOTS", hash });
      s.cleanup = "NOT_STARTED";
    });
    this.assertLive();
    const args = this.policy.arguments(state.sessionId, resume);
    const launch = this.options.launch?.(args, resume) ?? {
      executable: this.executable, args, cwd: state.root, env: this.environment,
    };
    if (launch.executable !== process.execPath ||
        launch.args[0] !== fileURLToPath(new URL("../../test/fixtures/fake-claude.mjs", import.meta.url))) {
      throw new ProbeError("EXECUTION_PRECEDENCE_UNCONFIRMED");
    }
    this.assertLive();
    this.#transport = new NativeTransport(launch, () => this.assertLive(), this.options.transport);
    this.#transport.setHandler((frame, signal) => this.message(frame, signal), (error) => this.fail(error.code));
    this.#drift = setInterval(() => {
      try { this.assertLive(); } catch (error) { this.fail(error instanceof ProbeError ? error.code : "POLICY_DRIFT"); }
    }, Math.min(this.options.driftMs ?? 100, 100));
    try {
      const response = object(await this.#transport.request({ subtype: "initialize", sdkMcpServers: [OWNED_SERVER] }));
      await this.#transport.settleMessages();
      this.assertLive();
      if (!Array.isArray(response.models) || response.models.length > 128) throw new ProbeError("PROTOCOL_REJECTED");
      this.#defaults.models = response.models.map((raw) => {
        const model = object(raw);
        if (!boundedString(model.value) || (model.resolvedModel !== undefined && !boundedString(model.resolvedModel)) ||
            (model.supportsEffort !== undefined && typeof model.supportsEffort !== "boolean") ||
            (model.supportedEffortLevels !== undefined && (!Array.isArray(model.supportedEffortLevels) ||
            model.supportedEffortLevels.some((e: unknown) => !protocolString(e, EFFORTS))))) throw new ProbeError("PROTOCOL_REJECTED");
        return { value: model.value, resolvedModel: model.resolvedModel as string | undefined ?? null,
          efforts: model.supportedEffortLevels as string[] | undefined ?? null };
      });
      this.store.record("INITIALIZE_RESPONSE", response);
      // Some native hosts do not emit init until first input. Do not fabricate that ACK.
      if (!this.#initSeen) throw new ProbeError("NATIVE_IDENTITY");
      this.assertLive();
    } catch (error) {
      this.fail(error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED");
      await this.close();
      throw this.#failure;
    }
  }

  async probeZero(): Promise<"PERSISTED_ZERO"> {
    this.assertLive();
    await this.verifyHistory(true);
    this.assertLive();
    return "PERSISTED_ZERO";
  }

  private async verifyHistory(zero: boolean): Promise<void> {
    this.assertLive();
    if (!this.options.history) throw new ProbeError("HISTORY_UNCONFIRMED");
    const proof = await this.options.history();
    this.assertLive();
    const s = this.store.read();
    if (typeof proof.materialized !== "boolean" || proof.sessionId !== s.sessionId || proof.root !== s.root ||
        !Array.isArray(proof.records) || proof.records.length > 256) {
      throw new ProbeError("HISTORY_UNCONFIRMED");
    }
    if (!proof.materialized) {
      this.store.update((value) => { value.persistence = "NATIVE_NOT_MATERIALIZED"; });
      throw new ProbeError("NATIVE_NOT_MATERIALIZED");
    }
    let userCount = 0;
    for (const record of proof.records) {
      if (record.session_id !== s.sessionId || (record.cwd !== undefined && record.cwd !== s.root) ||
          !protocolString(record.type, ["system", "user", "assistant", "result"])) throw new ProbeError("HISTORY_UNCONFIRMED");
      if (record.type !== "system") userCount++;
      if (zero && record.type !== "system") throw new ProbeError("HISTORY_UNCONFIRMED");
      if (record.type === "system" && record.subtype !== "init") throw new ProbeError("HISTORY_UNCONFIRMED");
    }
    if (!zero && s.inputs.length) {
      const last = s.inputs.at(-1)!;
      const terminal = proof.records.at(-1);
      if (!last.terminal || !terminal || terminal.type !== "result" || terminal.user_message_uuid !== last.inputId ||
          digest(JSON.stringify(terminal)) !== last.terminal.evidenceHash) throw new ProbeError("HISTORY_UNCONFIRMED");
    }
    this.store.record("NATIVE_HISTORY", proof);
    this.store.update((value) => { value.persistence = userCount ? "PERSISTED_HISTORY" : "PERSISTED_ZERO"; });
  }

  async input(command: Command, prompt: string): Promise<"COMPLETED" | "INTERRUPTED"> {
    this.assertLive();
    if (!this.#initSeen || !this.#transport || this.#active || !prompt || Buffer.byteLength(prompt) > 65536) {
      throw new ProbeError("INPUT_UNRESOLVED");
    }
    let resolve!: Active["resolve"];
    let reject!: Active["reject"];
    const promise = new Promise<"COMPLETED" | "INTERRUPTED">((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    try {
      const intent = await this.budget.consume(this.store, command, prompt, () => this.assertLive());
      this.assertLive();
      this.#active = { intent, ack: false, toolOpen: true, tools: new Map(), dispatched: new Map(), responsesStarted: new Set(), terminal: false, resolve, reject, promise };
      // This intent is durable before writing. A failed write is ambiguous, never refunded.
      this.store.update((s) => { s.inputs.at(-1)!.phase = "TRANSMITTED"; });
      this.assertLive();
      await this.#transport.write({ type: "user", uuid: intent.inputId, session_id: this.store.read().sessionId,
        parent_tool_use_id: null, message: { role: "user", content: prompt } });
      this.assertLive();
      const result = await promise;
      this.assertLive();
      return result;
    } catch (error) {
      this.fail(error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED");
      throw this.#failure;
    }
  }

  async interrupt(): Promise<void> {
    this.assertLive();
    if (!this.#active || this.#active.terminal || !this.#transport) throw new ProbeError("INPUT_UNRESOLVED");
    this.#active.toolOpen = false;
    const receipt = object(await this.#transport.request({ subtype: "interrupt", cancel_queued: true }));
    this.assertLive();
    if (!Array.isArray(receipt.still_queued) || receipt.still_queued.some((v: unknown) => typeof v !== "string") ||
        (receipt.cancelled !== undefined && (!Array.isArray(receipt.cancelled) ||
        receipt.cancelled.some((v: unknown) => typeof v !== "string")))) throw new ProbeError("PROTOCOL_REJECTED");
    this.#interruptReceipt = receipt;
    this.store.record("INTERRUPT_RECEIPT", receipt);
  }

  private sameInput(frame: Record<string, unknown>): Active {
    const active = this.#active;
    const s = this.store.read();
    if (!active || active.terminal || frame.session_id !== s.sessionId ||
        frame.user_message_uuid !== active.intent.inputId ||
        (frame.user_message_uuids !== undefined && (!Array.isArray(frame.user_message_uuids) ||
          frame.user_message_uuids.length !== 1 || frame.user_message_uuids[0] !== active.intent.inputId)) ||
        frame.parent_tool_use_id !== undefined && frame.parent_tool_use_id !== null) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    return active;
  }

  private async message(frame: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    try {
      this.assertLive();
      // Terminal arrival seals tools synchronously, even if its proof is subsequently refused.
      if (frame.type === "result" && this.#active) this.#active.toolOpen = false;
      if (frame.type === "system" && frame.subtype === "init") this.observeInit(frame);
      else if (frame.type === "user") this.observeUser(frame);
      else if (frame.type === "assistant") this.observeAssistant(frame);
      else if (frame.type === "result") this.observeResult(frame);
      else if (frame.type === "control_request") {
        await this.control(frame, signal);
        this.assertLive();
      } else throw new ProbeError("PROTOCOL_REJECTED");
    } catch (error) {
      this.fail(error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED");
      throw this.#failure;
    }
  }

  private observeInit(frame: Record<string, unknown>): void {
    const s = this.store.read();
    if (frame.session_id !== s.sessionId || frame.cwd !== s.root || frame.claude_code_version !== "2.1.286" ||
        !boundedString(frame.model) || !Array.isArray(frame.tools) ||
        frame.tools.length !== NATIVE_TOOL_NAMES.length || new Set(frame.tools).size !== NATIVE_TOOL_NAMES.length ||
        frame.tools.some((name: unknown) => !protocolString(name, NATIVE_TOOL_NAMES)) ||
        !Array.isArray(frame.plugins) || frame.plugins.length || !Array.isArray(frame.mcp_servers) ||
        frame.mcp_servers.length !== 1 || frame.mcp_servers.some((raw: unknown) => {
          const mcp = object(raw);
          return mcp.name !== OWNED_SERVER || mcp.source !== "sdk" || mcp.status !== "connected";
        })) throw new ProbeError("NATIVE_IDENTITY");
    if (frame.effort !== undefined && frame.effort !== null && !protocolString(frame.effort, EFFORTS)) {
      throw new ProbeError("PROTOCOL_REJECTED");
    }
    this.#defaults.initializedModel = frame.model;
    this.#defaults.effort = frame.effort === undefined || frame.effort === null ? { status: "UNVERIFIED" } :
      { status: "OBSERVED", value: frame.effort };
    this.store.record("NATIVE_INIT", frame);
    this.store.update((value) => { value.initialized = true; });
    this.#initSeen = true;
    return;
  }

  private observeUser(frame: Record<string, unknown>): void {
    const active = this.#active;
    if (!active || frame.session_id !== this.store.read().sessionId || frame.uuid !== active.intent.inputId || active.terminal) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    active.ack = true;
    this.store.update((s) => { s.inputs.at(-1)!.phase = "ACK"; });
    this.store.record("INPUT_ACK", frame);
    return;
  }

  private observeAssistant(frame: Record<string, unknown>): void {
    const active = this.sameInput(frame);
    if (!active.ack) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    const message = object(frame.message);
    if (!boundedString(message.model) || !Array.isArray(message.content)) throw new ProbeError("PROTOCOL_REJECTED");
    this.#defaults.observedModel = message.model;
    for (const raw of message.content) {
      const block = object(raw);
      if (block.type === "tool_use") {
        if (!active.toolOpen || !boundedString(block.id) || !protocolString(block.name, NATIVE_TOOL_NAMES)) throw new ProbeError("TOOL_REJECTED");
        const tool = { name: block.name, argsHash: digest(JSON.stringify(object(block.input))) };
        const old = active.tools.get(block.id);
        if (old && JSON.stringify(old) !== JSON.stringify(tool)) throw new ProbeError("TOOL_REJECTED");
        active.tools.set(block.id, tool);
      } else if (block.type !== "text" && block.type !== "thinking" && block.type !== "redacted_thinking") {
        throw new ProbeError("PROTOCOL_REJECTED");
      }
    }
    this.store.record("ASSISTANT_OBSERVATION", frame);
    return;
  }

  private observeResult(frame: Record<string, unknown>): void {
    const active = this.sameInput(frame);
    if (!active.ack || !Number.isInteger(frame.num_turns) || Number(frame.num_turns) < 1 ||
        !boundedString(frame.uuid) || (frame.queued_turn_count !== undefined && frame.queued_turn_count !== 0) ||
        frame.local_command !== undefined) throw new ProbeError("TERMINAL_UNCONFIRMED");
    let kind: "COMPLETED" | "INTERRUPTED";
    let text: string | null = null;
    if (frame.subtype === "success" && frame.is_error === false && frame.terminal_reason === "completed" &&
        typeof frame.result === "string" && frame.result.trim() && Buffer.byteLength(frame.result) <= 65536) {
      kind = "COMPLETED";
      text = frame.result;
      if ([...active.tools.keys()].some((id) => !active.responsesStarted.has(id))) throw new ProbeError("TERMINAL_UNCONFIRMED");
    } else if (frame.subtype === "error_during_execution" && frame.is_error === true &&
        protocolString(frame.terminal_reason, ["aborted_streaming", "aborted_tools"])) kind = "INTERRUPTED";
    else throw new ProbeError("TERMINAL_UNCONFIRMED");
    active.toolOpen = false;
    this.assertLive();
    this.store.update((s) => {
      const input = s.inputs.find((i) => i.inputId === active.intent.inputId)!;
      input.phase = kind;
      input.terminal = { kind, evidenceHash: digest(JSON.stringify(frame)), text };
    });
    active.terminal = true;
    this.assertLive();
    active.resolve(kind);
    return;
  }

  private async control(frame: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (!boundedString(frame.request_id) || !this.#transport) throw new ProbeError("PROTOCOL_REJECTED");
    const request = object(frame.request);
    if (request.subtype !== "mcp_message" || request.server_name !== OWNED_SERVER) throw new ProbeError("TOOL_REJECTED");
    const mcp = object(request.message);
    if (mcp.jsonrpc !== "2.0") throw new ProbeError("PROTOCOL_REJECTED");
    if (mcp.method === "notifications/initialized") return;
    if ((typeof mcp.id !== "string" && typeof mcp.id !== "number") ||
        typeof mcp.id === "number" && !Number.isSafeInteger(mcp.id)) throw new ProbeError("PROTOCOL_REJECTED");
    let result: Record<string, unknown>;
    if (mcp.method === "initialize") {
      const parameters = object(mcp.params);
      if (parameters.protocolVersion !== "2025-11-25" && parameters.protocolVersion !== "2024-11-05") {
        throw new ProbeError("PROTOCOL_REJECTED");
      }
      result = { protocolVersion: parameters.protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: OWNED_SERVER, version: "0.1.0" } };
    } else if (mcp.method === "tools/list") {
      result = { tools: [
        { name: TOOL_NAMES[0], description: "Read a selected synthetic file", inputSchema: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
        { name: TOOL_NAMES[1], description: "Ask a synthetic peer", inputSchema: {
          type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false } },
      ] };
    } else if (mcp.method === "tools/call") {
      const active = this.#active;
      if (!active?.toolOpen || !active.ack || active.terminal || !this.policy.callbackProven) throw new ProbeError("TOOL_REJECTED");
      const params = object(mcp.params);
      if (!protocolString(params.name, TOOL_NAMES)) throw new ProbeError("TOOL_REJECTED");
      const args = object(params.arguments);
      // The metadata below is synthetic until root verifies a native version-specific correlation seam.
      const meta = object(params._meta);
      if (meta.session_id !== this.store.read().sessionId || meta.user_message_uuid !== active.intent.inputId ||
          !boundedString(meta.tool_use_id)) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
      const native = active.tools.get(meta.tool_use_id);
      if (!native || native.name !== `mcp__${OWNED_SERVER}__${params.name}` ||
          native.argsHash !== digest(JSON.stringify(args))) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
      const key = meta.tool_use_id;
      const hash = digest(JSON.stringify({ name: params.name, args }));
      const prior = active.dispatched.get(key);
      if (prior && prior.hash !== hash) throw new ProbeError("TOOL_REJECTED");
      if (active.dispatched.size >= 64) throw new ProbeError("PROTOCOL_LIMIT");
      const job = prior?.response ?? this.tool(params.name, args, active, signal);
      if (!prior) active.dispatched.set(key, { hash, response: job });
      result = await job;
      this.assertLive();
      if (!active.toolOpen || active.terminal || this.#active !== active) throw new ProbeError("TOOL_REJECTED");
      active.responsesStarted.add(key);
    } else throw new ProbeError("TOOL_REJECTED");
    this.assertLive();
    await this.#transport.reply(frame.request_id, { mcp_message: { jsonrpc: "2.0", id: mcp.id, result } });
    this.assertLive();
  }

  private async tool(name: string, args: Record<string, unknown>, active: Active, signal: AbortSignal): Promise<Record<string, unknown>> {
    const check = () => {
      this.assertLive();
      if (!active.toolOpen || active.terminal || this.#active !== active) throw new ProbeError("TOOL_REJECTED");
    };
    check();
    let text: string;
    if (name === "read_selected_file" && Object.keys(args).length === 1 && typeof args.path === "string") {
      text = this.files.read(args.path, check);
    } else if (name === "ask_peer" && Object.keys(args).length === 1 && boundedString(args.question, 2048)) {
      // This is deliberately a synthetic peer, not an AI-to-AI roundtrip.
      text = "SYNTHETIC_PEER_ACK";
    } else throw new ProbeError("TOOL_REJECTED");
    check();
    this.store.record("TOOL_CALLBACK", { inputId: active.intent.inputId, name, argsHash: digest(JSON.stringify(args)) });
    if (this.options.toolResponseGate) await abortable(this.options.toolResponseGate(name, signal), signal);
    check();
    return { content: [{ type: "text", text }] };
  }

  private fail(code: Refusal): void {
    if (this.#closed) return;
    this.#failure = new ProbeError(code);
    this.#closed = true;
    if (this.#drift) clearInterval(this.#drift);
    this.policy.close();
    if (this.#active) {
      this.#active.toolOpen = false;
      this.#active.reject(this.#failure);
    }
    try {
      this.store.update((s) => { for (const i of s.inputs) if (!i.terminal) i.phase = "UNKNOWN"; });
    } catch { /* An earlier durable intent remains unresolved even if persistence fails. */ }
    this.#transport?.fail(code);
  }

  replaceFixture(path: string, content: string): void {
    const check = () => {
      this.store.assertLocked();
      const s = this.store.read();
      if (!this.#closed || !this.#transport?.reaped || !this.#active?.terminal ||
          s.cleanup !== "REAPED" || s.inputs.some((i) => !i.terminal)) throw new ProbeError("FILE_REJECTED");
    };
    check();
    const snapshots = this.files.replaceOwnedFixture(path, content, true, false, check);
    check();
    this.store.update((s) => {
      const hash = digest(JSON.stringify(snapshots));
      s.fileSnapshotHash = hash;
      s.evidence.push({ kind: "FILE_SNAPSHOTS", hash });
    });
  }

  close(): Promise<Cleanup> {
    if (!this.#closing) {
      if (!this.#closed) this.fail("RUNTIME_CLOSED");
      this.#closing = (async () => {
        const cleanup = await this.#transport?.close() ?? { reaped: true, code: "REAPED" as const };
        this.store.update((s) => { s.cleanup = cleanup.code; });
        return cleanup;
      })();
    }
    return this.#closing;
  }
}
