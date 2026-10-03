import { ProbeError, digest, object, uuid } from "./owned-probe-store.js";
import { NATIVE_TOOL_NAMES, OWNED_SERVER, TOOL_NAMES, NATIVE_VERSION } from "./task-policy.js";

const efforts = ["low", "medium", "high", "xhigh", "max"];
const bounded = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const exact = (frame: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(frame).length === keys.length && keys.every(key => Object.hasOwn(frame, key));
// Canonical arguments also detect an exact synthetic replay with reordered keys.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => {
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)));
  }
  return entry;
});

/** Connection identity belongs to Runtime; this validator has no connection state or I/O. */
export function nativeIdentity(frame: Record<string, unknown>, sessionId: string, root: string): {
  model: string; effort: { status: "UNVERIFIED" } | { status: "OBSERVED"; value: string };
} {
  if (frame.type !== "system" || frame.subtype !== "init" || !uuid(frame.uuid) || frame.session_id !== sessionId || frame.cwd !== root || frame.claude_code_version !== NATIVE_VERSION ||
      frame.permissionMode !== "dontAsk" || !bounded(frame.model) ||
      !Array.isArray(frame.tools) || frame.tools.length < 2 || frame.tools.length > 3 ||
      new Set(frame.tools).size !== frame.tools.length || NATIVE_TOOL_NAMES.some(name => !(frame.tools as unknown[]).includes(name)) ||
      frame.tools.some((name: unknown) => typeof name !== "string" || ![...NATIVE_TOOL_NAMES, "EndConversation"].includes(name)) ||
      !Array.isArray(frame.plugins) || frame.plugins.length ||
      frame.plugin_errors !== undefined && (!Array.isArray(frame.plugin_errors) || frame.plugin_errors.length) ||
      !Array.isArray(frame.mcp_servers) || frame.mcp_servers.length !== 1 || frame.mcp_servers.some((raw: unknown) => {
        const server = object(raw);
        return server.name !== OWNED_SERVER || server.source !== "sdk" || server.status !== "connected";
      })) throw new ProbeError("NATIVE_IDENTITY");
  if (frame.effort !== undefined && frame.effort !== null &&
      (typeof frame.effort !== "string" || !efforts.includes(frame.effort))) throw new ProbeError("PROTOCOL_REJECTED");
  return { model: frame.model, effort: frame.effort == null ? { status: "UNVERIFIED" } :
    { status: "OBSERVED", value: frame.effort as string } };
}

interface Tool {
  name: string; args: Record<string, unknown>; argsHash: string;
  response?: Promise<Record<string, unknown>>;
  responseWritten: boolean;
}
interface Control {
  toolId: string; cancelled: boolean; written: boolean;
  cancellation: Promise<void>; cancel: () => void;
}
export interface InputTerminal { kind: "COMPLETED" | "INTERRUPTED"; evidenceHash: string; text: string | null }

/** All per-input proof is kept here. No process, storage, budget, file or timer is created. */
export class NativeInputProof {
  #ack = false;
  #anchored = false;
  #open = true;
  #terminal: InputTerminal | undefined;
  #interruptRequested = false;
  #interruptReceipt = false;
  readonly #tools = new Map<string, Tool>();
  readonly #controls = new Map<string, Control>();
  readonly #commands = new Map<string, string>();
  #progressCount = 0;
  #progressLast: { uuid: string; estimatedTokens: number; estimatedTokensDelta: number } | null = null;

  constructor(readonly sessionId: string, readonly inputId: string, readonly promptHash: string) {
    if (!uuid(sessionId) || !uuid(inputId) || !/^[a-f0-9]{64}$/.test(promptHash)) throw new ProbeError("NATIVE_IDENTITY");
  }
  get terminal(): InputTerminal | undefined { return this.#terminal && structuredClone(this.#terminal); }
  get receiptObserved(): boolean { return this.#interruptReceipt; }
  get interruptRequested(): boolean { return this.#interruptRequested; }
  get open(): boolean { return this.#open; }
  seal(): void { this.#open = false; }

  private same(frame: Record<string, unknown>, stamped = false): void {
    if (this.#terminal || frame.session_id !== this.sessionId || frame.parent_tool_use_id != null ||
        stamped && frame.user_message_uuid !== this.inputId ||
        frame.user_message_uuid !== undefined && frame.user_message_uuid !== this.inputId ||
        frame.user_message_uuids !== undefined && (!Array.isArray(frame.user_message_uuids) ||
          frame.user_message_uuids.length !== 1 || frame.user_message_uuids[0] !== this.inputId)) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
  }

  user(frame: Record<string, unknown>): "INPUT_ACK" | "NATIVE_TOOL_RESULT" {
    this.same(frame);
    if (frame.type !== "user" || !uuid(frame.uuid)) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    const message = object(frame.message);
    if (message.role !== "user") throw new ProbeError("PROTOCOL_REJECTED");
    if (frame.uuid === this.inputId) {
      let content = message.content;
      if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text") content = content[0].text;
      if (typeof content !== "string" || digest(content) !== this.promptHash || this.#ack) {
        throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
      }
      this.#ack = true;
      return "INPUT_ACK";
    }
    if (!this.#anchored || !Array.isArray(message.content) || !message.content.length || message.content.length > 64) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    for (const raw of message.content) {
      const block = object(raw);
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string" ||
          !this.#tools.get(block.tool_use_id)?.responseWritten) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    return "NATIVE_TOOL_RESULT";
  }

  assistant(frame: Record<string, unknown>, identityVerified: boolean): string {
    this.same(frame, !this.#anchored);
    if (!identityVerified || !this.#ack || frame.type !== "assistant") {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    const message = object(frame.message);
    if (message.role !== "assistant" || !bounded(message.model) || !Array.isArray(message.content) ||
        message.content.length > 64 || !uuid(frame.uuid)) throw new ProbeError("PROTOCOL_REJECTED");
    this.#anchored = true;
    for (const raw of message.content) {
      const block = object(raw);
      if (block.type === "tool_use") {
        if (!this.#open || !bounded(block.id) || typeof block.name !== "string" || !NATIVE_TOOL_NAMES.includes(block.name)) {
          throw new ProbeError("TOOL_REJECTED");
        }
        const args = object(block.input);
        const hash = digest(canonical(args));
        const old = this.#tools.get(block.id);
        if (old && (old.name !== block.name || old.argsHash !== hash)) throw new ProbeError("TOOL_REJECTED");
        if (!old) {
          if (this.#tools.size >= 64) throw new ProbeError("PROTOCOL_LIMIT");
          this.#tools.set(block.id, { name: block.name, args: structuredClone(args), argsHash: hash, responseWritten: false });
        }
      } else if (!["text", "thinking", "redacted_thinking"].includes(String(block.type)) || typeof block.type !== "string") {
        throw new ProbeError("PROTOCOL_REJECTED");
      }
    }
    return message.model;
  }

  claim(controlId: string, params: Record<string, unknown>, identityVerified: boolean): {
    toolId: string; name: string; args: Record<string, unknown>; cancellation: Promise<void>;
  } {
    if (!identityVerified || !this.#ack || !this.#anchored || !this.#open || this.#terminal ||
        this.#interruptRequested || !bounded(controlId) || this.#controls.has(controlId) ||
        typeof params.name !== "string" || !TOOL_NAMES.includes(params.name as typeof TOOL_NAMES[number])) throw new ProbeError("TOOL_REJECTED");
    const args = object(params.arguments);
    if (Object.keys(args).length !== 1 ||
        params.name === "read_selected_file" && !bounded(args.path, 2048) ||
        params.name === "ask_peer" && !bounded(args.question, 2048)) throw new ProbeError("TOOL_REJECTED");
    const argsHash = digest(canonical(args));
    let toolId: string;
    if (params._meta !== undefined) {
      const meta = object(params._meta);
      if (meta.session_id !== this.sessionId || meta.user_message_uuid !== this.inputId || !bounded(meta.tool_use_id)) {
        throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
      }
      toolId = meta.tool_use_id;
    } else {
      const matches = [...this.#tools].filter(([, tool]) => !tool.response &&
        tool.name === `mcp__${OWNED_SERVER}__${params.name}` && tool.argsHash === argsHash);
      if (matches.length !== 1) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
      toolId = matches[0]![0];
    }
    const tool = this.#tools.get(toolId);
    if (!tool || tool.name !== `mcp__${OWNED_SERVER}__${params.name}` || tool.argsHash !== argsHash) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    if (this.#controls.size >= 64) throw new ProbeError("PROTOCOL_LIMIT");
    let cancel!: () => void;
    const cancellation = new Promise<void>(resolve => { cancel = resolve; });
    this.#controls.set(controlId, { toolId, cancellation, cancel, cancelled: false, written: false });
    return { toolId, name: params.name, args: structuredClone(args), cancellation };
  }

  response(controlId: string, create: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const tool = this.#tools.get(this.#controls.get(controlId)!.toolId)!;
    return tool.response ??= create();
  }
  canRespond(controlId: string): boolean {
    const control = this.#controls.get(controlId);
    return !!control && !control.cancelled && !control.written && this.#open && !this.#terminal && !this.#interruptRequested;
  }
  responseWritten(controlId: string): void {
    if (!this.canRespond(controlId)) throw new ProbeError("TOOL_REJECTED");
    const control = this.#controls.get(controlId)!;
    control.written = true;
    this.#tools.get(control.toolId)!.responseWritten = true;
  }
  cancelled(controlId: string): boolean { return this.#controls.get(controlId)?.cancelled ?? false; }

  requestInterrupt(): void {
    if (this.#terminal || !this.#open || this.#interruptRequested) throw new ProbeError("INPUT_UNRESOLVED");
    this.#interruptRequested = true;
    this.#open = false;
  }
  receipt(receipt: Record<string, unknown>): void {
    if (!this.#interruptRequested || this.#interruptReceipt || !Array.isArray(receipt.still_queued) || receipt.still_queued.length ||
        receipt.cancelled !== undefined && (!Array.isArray(receipt.cancelled) || receipt.cancelled.some((id: unknown) => id !== this.inputId))) {
      throw new ProbeError("PROTOCOL_REJECTED");
    }
    this.#interruptReceipt = true;
  }
  cancel(frame: Record<string, unknown>): void {
    const control = typeof frame.request_id === "string" ? this.#controls.get(frame.request_id) : undefined;
    const tool = control && this.#tools.get(control.toolId);
    if (!exact(frame, ["type", "request_id"]) || frame.type !== "control_cancel_request" || !this.#interruptRequested ||
        this.#terminal || !control || control.cancelled || control.written || !tool || tool.responseWritten ||
        tool.name !== NATIVE_TOOL_NAMES[0]) throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    control.cancelled = true;
    control.cancel();
  }

  progress(frame: Record<string, unknown>, identityVerified: boolean): void {
    if (!exact(frame, ["type", "subtype", "estimated_tokens", "estimated_tokens_delta", "user_message_uuid", "uuid", "session_id"]) ||
        frame.type !== "system" || frame.subtype !== "thinking_tokens" || !identityVerified || this.#terminal ||
        frame.session_id !== this.sessionId || frame.user_message_uuid !== this.inputId || !uuid(frame.uuid)) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    if (!Number.isSafeInteger(frame.estimated_tokens) || Number(frame.estimated_tokens) < 0 ||
        !Number.isSafeInteger(frame.estimated_tokens_delta)) throw new ProbeError("PROTOCOL_REJECTED");
    if (this.#progressCount >= 65536) throw new ProbeError("PROTOCOL_LIMIT");
    this.#progressCount++;
    this.#progressLast = { uuid: frame.uuid, estimatedTokens: frame.estimated_tokens as number,
      estimatedTokensDelta: frame.estimated_tokens_delta as number };
  }
  command(frame: Record<string, unknown>): void {
    const keys = ["type", "command_uuid", "state", "uuid", "session_id"];
    if (!exact(frame, keys) || frame.type !== "command_lifecycle" || frame.session_id !== this.sessionId ||
        frame.command_uuid !== this.inputId || !uuid(frame.uuid) || typeof frame.state !== "string" ||
        !["queued", "started", "completed", "cancelled", "discarded", "refused"].includes(frame.state)) {
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    }
    const hash = digest(JSON.stringify(keys.map(key => frame[key])));
    const old = this.#commands.get(frame.uuid);
    if (old !== undefined && old !== hash) throw new ProbeError("PROTOCOL_REJECTED");
    if (old === undefined && this.#commands.size >= 16) throw new ProbeError("PROTOCOL_LIMIT");
    this.#commands.set(frame.uuid, hash);
  }
  metadata(): { progress: { count: number; last: { uuid: string; estimatedTokens: number; estimatedTokensDelta: number } | null }; commands: number } {
    return { progress: { count: this.#progressCount, last: this.#progressLast && { ...this.#progressLast } }, commands: this.#commands.size };
  }

  result(frame: Record<string, unknown>, identityVerified: boolean): InputTerminal {
    this.same(frame);
    this.#open = false;
    if (!identityVerified || !this.#ack || !this.#anchored || frame.type !== "result" || !uuid(frame.uuid) ||
        !Number.isSafeInteger(frame.num_turns) || Number(frame.num_turns) < 1 || Number(frame.num_turns) > 64 ||
        frame.queued_turn_count !== undefined && frame.queued_turn_count !== 0 || frame.resume_reason !== undefined ||
        frame.local_command !== undefined) throw new ProbeError("TERMINAL_UNCONFIRMED");
    let kind: InputTerminal["kind"];
    let text: string | null = null;
    if (frame.subtype === "success" && frame.is_error === false &&
        (frame.terminal_reason === undefined || frame.terminal_reason === "completed") &&
        bounded(frame.result, 65536) && frame.result.trim() && [...this.#tools.values()].every(tool => tool.responseWritten) &&
        [...this.#controls.values()].every(control => control.written)) {
      kind = "COMPLETED"; text = frame.result;
    } else if (this.#interruptRequested && frame.subtype === "error_during_execution" && frame.is_error === true &&
        typeof frame.terminal_reason === "string" && ["aborted_tools", "aborted_streaming"].includes(frame.terminal_reason)) {
      kind = "INTERRUPTED";
    } else throw new ProbeError("TERMINAL_UNCONFIRMED");
    this.#terminal = { kind, text, evidenceHash: digest(JSON.stringify(frame)) };
    return structuredClone(this.#terminal);
  }
}
