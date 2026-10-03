import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync } from "node:fs";
import { ApprovalBudget, OwnedProbeStore, ProbeError, digest, object, readPrivate,
  type Command, type InputIntent, type Refusal } from "./owned-probe-store.js";
import { NativeTransport, type Cleanup, type Launch, type TransportOptions } from "./native-transport.js";
import { TaskPolicy, SelectedFiles, OWNED_SERVER, TOOL_NAMES } from "./task-policy.js";

import { NativeInputProof, nativeIdentity } from "./native-input-proof.js";

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
  proof: NativeInputProof;
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
  #defaults: DefaultObservation = {
    requestedModel: null, initializedModel: null, observedModel: null,
    effort: { status: "UNVERIFIED" }, models: [],
  };

  constructor(readonly store: OwnedProbeStore, readonly budget: ApprovalBudget, readonly policy: TaskPolicy,
    readonly files: SelectedFiles, private readonly executable: string, private readonly environment: NodeJS.ProcessEnv,
    private readonly options: RuntimeOptions = {}) {}

  get defaults(): DefaultObservation { return structuredClone(this.#defaults); }
  get interruptReceiptObserved(): boolean { return this.#active?.proof.receiptObserved ?? false; }
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
    if (state.cleanup === "CLEANUP_INCOMPLETE" || state.cleanup === "NOT_STARTED" &&
        (state.initialized || state.fileSnapshotHash !== null || state.inputs.length > 0)) throw new ProbeError("CLEANUP_INCOMPLETE");
    if (resume) await this.verifyHistory(false);
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
    this.store.update((s) => {
      const hash = digest(JSON.stringify(this.files.snapshots()));
      s.fileSnapshotHash = hash;
      s.evidence.push({ kind: "FILE_SNAPSHOTS", hash });
      s.cleanup = "NOT_STARTED";
    });
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
      // Identity may arrive after first input; it is still required before assistant/tool/result.
      this.assertLive();
    } catch (error) {
      this.fail(error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED");
      await this.close();
      throw this.#failure;
    }
  }

  async probeZero(): Promise<"PERSISTED_ZERO"> {
    this.assertLive();
    if (!this.#initSeen) throw new ProbeError("NATIVE_IDENTITY");
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
    if (!proof.records.some(record => record.type === "system" && record.subtype === "init")) throw new ProbeError("HISTORY_UNCONFIRMED");
    let userCount = 0;
    for (const record of proof.records) {
      if (record.session_id !== s.sessionId || (record.cwd !== undefined && record.cwd !== s.root) ||
          !protocolString(record.type, ["system", "user", "assistant", "result"])) throw new ProbeError("HISTORY_UNCONFIRMED");
      if (record.type !== "system") userCount++;
      if (zero && record.type !== "system") throw new ProbeError("HISTORY_UNCONFIRMED");
      if (record.type === "system" && record.subtype !== "init") throw new ProbeError("HISTORY_UNCONFIRMED");
    }
    // INPUT_METADATA is appended in the same durable update as each terminal.
    // Its position plus the immutable input terminal supplies the observed result order.
    const historyTypes: Record<string, string> = {
      NATIVE_INIT: "system", INPUT_ACK: "user", ASSISTANT_OBSERVATION: "assistant", NATIVE_TOOL_RESULT: "user",
    };
    let recordIndex = 0;
    let inputIndex = 0;
    for (const evidence of s.evidence) {
      let expectedType = historyTypes[evidence.kind];
      let expectedHash = evidence.hash;
      if (evidence.kind === "INPUT_METADATA") {
        const terminal = s.inputs[inputIndex++]?.terminal;
        if (!terminal) throw new ProbeError("HISTORY_UNCONFIRMED");
        expectedType = "result";
        expectedHash = terminal.evidenceHash;
      }
      if (expectedType === undefined) continue;
      const record = proof.records[recordIndex++];
      if (!record || record.type !== expectedType || digest(JSON.stringify(record)) !== expectedHash) {
        throw new ProbeError("HISTORY_UNCONFIRMED");
      }
    }
    if (recordIndex !== proof.records.length || inputIndex !== s.inputs.length) throw new ProbeError("HISTORY_UNCONFIRMED");
    const lastResultIndex = proof.records.findLastIndex(record => record.type === "result");
    if (!zero && s.inputs.length) {
      const last = s.inputs.at(-1)!;
      const terminal = proof.records[lastResultIndex];
      if (!last.terminal || !terminal || terminal.type !== "result" ||
          terminal.user_message_uuid !== undefined && terminal.user_message_uuid !== last.inputId ||
          digest(JSON.stringify(terminal)) !== last.terminal.evidenceHash) throw new ProbeError("HISTORY_UNCONFIRMED");
    }
    if (!zero && s.inputs.length) {
      const last = s.inputs.at(-1)!;
      const ackIndex = proof.records.findLastIndex(record => record.type === "user" && record.uuid === last.inputId);
      if (ackIndex < 0) throw new ProbeError("HISTORY_UNCONFIRMED");
      try {
        const inputProof = new NativeInputProof(s.sessionId, last.inputId, last.promptHash);
        inputProof.user(proof.records[ackIndex]!);
        let anchored = false;
        for (const record of proof.records.slice(ackIndex + 1, lastResultIndex)) {
          if (record.type === "assistant") { inputProof.assistant(record, true); anchored = true; }
          else if (record.type === "system" && record.subtype === "init") continue;
          else if (record.type !== "user") throw new ProbeError("HISTORY_UNCONFIRMED");
          else {
            const message = object(record.message);
            if (message.role !== "user" || !Array.isArray(message.content) ||
                !message.content.length || message.content.some((raw: unknown) => object(raw).type !== "tool_result") ||
                record.user_message_uuid !== undefined && record.user_message_uuid !== last.inputId) throw new ProbeError("HISTORY_UNCONFIRMED");
          }
        }
        if (!anchored) throw new ProbeError("HISTORY_UNCONFIRMED");
      } catch { throw new ProbeError("HISTORY_UNCONFIRMED"); }
    }
    this.store.record("NATIVE_HISTORY", proof);
    this.store.update((value) => { value.persistence = userCount ? "PERSISTED_HISTORY" : "PERSISTED_ZERO"; });
  }

  async input(command: Command, prompt: string): Promise<"COMPLETED" | "INTERRUPTED"> {
    this.assertLive();
    if (!this.#transport || this.#active || !prompt || Buffer.byteLength(prompt) > 65536) {
      throw new ProbeError("INPUT_UNRESOLVED");
    }
    let resolve!: Active["resolve"];
    let reject!: Active["reject"];
    const promise = new Promise<"COMPLETED" | "INTERRUPTED">((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    try {
      const intent = await this.budget.consume(this.store, command, prompt, () => this.assertLive());
      this.assertLive();
      this.#active = { intent, proof: new NativeInputProof(this.store.read().sessionId, intent.inputId, intent.promptHash), resolve, reject, promise };
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
    if (!this.#active || this.#active.proof.terminal || !this.#transport) throw new ProbeError("INPUT_UNRESOLVED");
    this.#active.proof.requestInterrupt();
    const receipt = object(await this.#transport.request({ subtype: "interrupt", cancel_queued: true }));
    this.assertLive();
    this.#active.proof.receipt(receipt);
    this.store.record("INTERRUPT_RECEIPT", receipt);
  }

  private async message(frame: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    try {
      this.assertLive();
      // Terminal arrival seals tools synchronously, even if its proof is subsequently refused.
      if (frame.type === "result" && this.#active) this.#active.proof.seal();
      if (frame.type === "system" && frame.subtype === "init") this.observeInit(frame);
      else if (frame.type === "user") this.observeUser(frame);
      else if (frame.type === "assistant") this.observeAssistant(frame);
      else if (frame.type === "result") this.observeResult(frame);
      else if (frame.type === "system" && frame.subtype === "thinking_tokens") {
        if (!this.#active) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
        this.#active.proof.progress(frame, this.#initSeen);
      } else if (frame.type === "command_lifecycle") {
        if (!this.#active) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
        this.#active.proof.command(frame);
      } else if (frame.type === "control_cancel_request") {
        if (!this.#active) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
        this.#active.proof.cancel(frame);
      } else if (frame.type === "control_request") {
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
    if (this.#initSeen) throw new ProbeError("NATIVE_IDENTITY");
    const identity = nativeIdentity(frame, s.sessionId, s.root);
    this.#defaults.initializedModel = identity.model;
    this.#defaults.effort = identity.effort;
    this.store.record("NATIVE_INIT", frame);
    this.store.update((value) => { value.initialized = true; });
    this.#initSeen = true;
    return;
  }

  private observeUser(frame: Record<string, unknown>): void {
    const active = this.#active;
    if (!active) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    const kind = active.proof.user(frame);
    if (kind === "INPUT_ACK") this.store.update((s) => { s.inputs.at(-1)!.phase = "ACK"; });
    this.store.record(kind, frame);
  }

  private observeAssistant(frame: Record<string, unknown>): void {
    if (!this.#active) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    this.#defaults.observedModel = this.#active.proof.assistant(frame, this.#initSeen);
    this.store.record("ASSISTANT_OBSERVATION", frame);
  }

  private observeResult(frame: Record<string, unknown>): void {
    const active = this.#active;
    if (!active) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    const terminal = active.proof.result(frame, this.#initSeen);
    this.assertLive();
    this.store.update((s) => {
      const input = s.inputs.find((i) => i.inputId === active.intent.inputId)!;
      input.phase = terminal.kind;
      input.terminal = terminal;
      s.evidence.push({ kind: "INPUT_METADATA", hash: digest(JSON.stringify(active.proof.metadata())) });
    });
    this.assertLive();
    active.resolve(terminal.kind);
  }

  private async control(frame: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    if (!boundedString(frame.request_id) || !this.#transport) throw new ProbeError("PROTOCOL_REJECTED");
    const request = object(frame.request);
    if (request.subtype !== "mcp_message" || request.server_name !== OWNED_SERVER) throw new ProbeError("TOOL_REJECTED");
    const mcp = object(request.message);
    if (mcp.jsonrpc !== "2.0") throw new ProbeError("PROTOCOL_REJECTED");
    if (mcp.method === "notifications/initialized") {
      if (mcp.id !== undefined) throw new ProbeError("PROTOCOL_REJECTED");
      await this.#transport.reply(frame.request_id, { mcp_response: { jsonrpc: "2.0", id: 0, result: {} } });
      this.assertLive();
      return;
    }
    if ((typeof mcp.id !== "string" && typeof mcp.id !== "number") ||
        typeof mcp.id === "number" && !Number.isSafeInteger(mcp.id)) throw new ProbeError("PROTOCOL_REJECTED");
    let result: Record<string, unknown>;
    let responding: Active | undefined;
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
      if (!active || !this.policy.callbackProven) throw new ProbeError("TOOL_REJECTED");
      const claim = active.proof.claim(frame.request_id, object(mcp.params), this.#initSeen);
      try {
        result = await active.proof.response(frame.request_id, () => this.tool(claim.name, claim.args, active, signal, claim.cancellation));
      } catch (error) {
        if (active.proof.cancelled(frame.request_id) || active.proof.interruptRequested &&
            error instanceof ProbeError && error.code === "TOOL_REJECTED") return;
        throw error;
      }
      this.assertLive();
      if (!active.proof.canRespond(frame.request_id)) return;
      responding = active;
    } else throw new ProbeError("TOOL_REJECTED");
    this.assertLive();
    await this.#transport.reply(frame.request_id, { mcp_response: { jsonrpc: "2.0", id: mcp.id, result } });
    this.assertLive();
    if (responding) responding.proof.responseWritten(frame.request_id);
  }

  private async tool(name: string, args: Record<string, unknown>, active: Active, signal: AbortSignal, cancellation: Promise<void>): Promise<Record<string, unknown>> {
    const check = () => {
      this.assertLive();
      if (!active.proof.open || active.proof.terminal || this.#active !== active) throw new ProbeError("TOOL_REJECTED");
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
    if (this.options.toolResponseGate) await abortable(Promise.race([
      this.options.toolResponseGate(name, signal),
      cancellation.then(() => { throw new ProbeError("TOOL_REJECTED"); }),
    ]), signal);
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
      this.#active.proof.seal();
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
      if (!this.#closed || !this.#transport?.reaped || !this.#active?.proof.terminal ||
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
        // A runtime that never spawned cannot overwrite a prior cleanup or UNKNOWN record.
        if (this.#transport) this.store.update((s) => { s.cleanup = cleanup.code; });
        return cleanup;
      })();
    }
    return this.#closing;
  }
}
