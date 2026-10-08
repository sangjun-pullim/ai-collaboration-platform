import {
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  type NativeToolCancellation,
  type NativeInterruptionReceipt,
  type RepositoryToolPolicy,
} from "../runtime-contracts.ts";
import { isId as uuid } from "../contracts.ts";
import { validateToolArguments, isNativeRepositoryTool } from "../workspace/tool-contracts.ts";
import { validToolPolicy } from "../workspace/repository-access.ts";
import { object } from "./owned-history.ts";
import { isInterruptionUserContent } from "./native-interruption-records.ts";

export const OWNED_SERVER = scopedNamespace;
export const TOOL_NAMES = ["read_workspace_file", "ask_peer"] as const;
export const NATIVE_TOOL_NAMES = TOOL_NAMES.map((name) => `mcp__${OWNED_SERVER}__${name}`);

const efforts = ["low", "medium", "high", "xhigh", "max"];
const bounded = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max;
const exact = (frame: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(frame).length === keys.length && keys.every((key) => Object.hasOwn(frame, key));
const rateStatuses = ["allowed", "allowed_warning", "rejected"];
const rateWindows = ["five_hour", "seven_day", "seven_day_overage_included"];
const utilization = (value: unknown): boolean =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;
const resetTime = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const enumValue =
  (choices: readonly string[]) =>
  (value: unknown): boolean =>
    typeof value === "string" && choices.includes(value);
const booleanValue = (value: unknown): boolean => typeof value === "boolean";
// All public 0.3.293 SDK fields; unlisted internal fields remain fail-closed.
const rateInfoFields: Record<string, (value: unknown) => boolean> = {
  status: enumValue(rateStatuses),
  resetsAt: resetTime,
  rateLimitType: enumValue([...rateWindows, "seven_day_opus", "seven_day_sonnet", "overage"]),
  utilization,
  overageStatus: enumValue(rateStatuses),
  overageResetsAt: resetTime,
  overageDisabledReason: enumValue([
    "overage_not_provisioned",
    "org_level_disabled",
    "org_level_disabled_until",
    "out_of_credits",
    "seat_tier_level_disabled",
    "member_level_disabled",
    "seat_tier_zero_credit_limit",
    "group_zero_credit_limit",
    "member_zero_credit_limit",
    "org_service_level_disabled",
    "no_limits_configured",
    "fetch_error",
    "unknown",
  ]),
  isUsingOverage: booleanValue,
  overageInUse: booleanValue,
  surpassedThreshold: utilization,
  limitScope: enumValue(["service", "channel", "group_pool"]),
  errorCode: enumValue(["credits_required"]),
  canUserPurchaseCredits: booleanValue,
  hasChargeableSavedPaymentMethod: booleanValue,
};
function validRateLimitInfo(info: Record<string, unknown>): boolean {
  if (
    !Object.hasOwn(info, "status") ||
    Object.entries(info).some(
      ([key, value]) =>
        key !== "unifiedWindows" &&
        (!Object.hasOwn(rateInfoFields, key) || !rateInfoFields[key]!(value)),
    )
  )
    return false;
  if (Object.hasOwn(info, "unifiedWindows")) {
    const windows = object(info.unifiedWindows);
    if (Object.keys(windows).some((key) => !rateWindows.includes(key))) return false;
    for (const raw of Object.values(windows)) {
      const window = object(raw);
      if (
        !exact(window, ["utilization", "resetsAt"]) ||
        !utilization(window.utilization) ||
        !resetTime(window.resetsAt)
      )
        return false;
    }
  }
  return true;
}
// Canonical arguments also detect an exact synthetic replay with reordered keys.
const canonical = stableJson;

/** Connection identity belongs to Runtime; this validator has no connection state or I/O. */
export function nativeIdentity(
  frame: Record<string, unknown>,
  sessionId: string,
  root: string,
  version: string,
  allowedTools: readonly string[] = NATIVE_TOOL_NAMES,
): {
  model: string;
  effort: { status: "UNVERIFIED" } | { status: "OBSERVED"; value: string };
} {
  if (
    frame.type !== "system" ||
    frame.subtype !== "init" ||
    !uuid(frame.uuid) ||
    frame.session_id !== sessionId ||
    frame.cwd !== root ||
    frame.claude_code_version !== version ||
    frame.permissionMode !== "dontAsk" ||
    !bounded(frame.model) ||
    !Array.isArray(frame.tools) ||
    frame.tools.length < allowedTools.length ||
    frame.tools.length > allowedTools.length + 1 ||
    new Set(frame.tools).size !== frame.tools.length ||
    allowedTools.some((name) => !(frame.tools as unknown[]).includes(name)) ||
    frame.tools.some(
      (name: unknown) =>
        typeof name !== "string" || ![...allowedTools, "EndConversation"].includes(name),
    ) ||
    !Array.isArray(frame.plugins) ||
    frame.plugins.length ||
    (frame.plugin_errors !== undefined &&
      (!Array.isArray(frame.plugin_errors) || frame.plugin_errors.length)) ||
    !Array.isArray(frame.mcp_servers) ||
    frame.mcp_servers.length !== 1 ||
    frame.mcp_servers.some((raw: unknown) => {
      const server = object(raw);
      return (
        server.name !== OWNED_SERVER || server.source !== "sdk" || server.status !== "connected"
      );
    })
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  if (
    frame.effort !== undefined &&
    frame.effort !== null &&
    (typeof frame.effort !== "string" || !efforts.includes(frame.effort))
  )
    throw new RuntimeError("UNKNOWN");
  return {
    model: frame.model,
    effort:
      frame.effort == null
        ? { status: "UNVERIFIED" }
        : { status: "OBSERVED", value: frame.effort as string },
  };
}

interface Tool {
  name: string;
  args: Record<string, unknown>;
  argsHash: string;
  response?: Promise<Record<string, unknown>>;
  responseWritten: boolean;
  claimed: boolean;
}
interface Control {
  toolId: string;
  cancelled: boolean;
  cancelHash?: string;
  written: boolean;
  cancellation: Promise<void>;
  cancel: () => void;
  progressToken?: string | number;
}
const requestId = (value: unknown): value is string | number =>
  bounded(value) || (typeof value === "number" && Number.isSafeInteger(value));
export interface InputTerminal {
  kind: "COMPLETED" | "FAILED" | "INTERRUPTED";
  evidenceHash: string;
  text: string | null;
}

/** All per-input proof is kept here. No process, storage, budget, file or timer is created. */
export class NativeInputProof {
  #ack = false;
  #anchored = false;
  #open = true;
  #sealed = false;
  #terminal: InputTerminal | undefined;
  #interruptRequested = false;
  #interruptReceipt = false;
  readonly #tools = new Map<string, Tool>();
  readonly #controls = new Map<string, Control>();
  readonly #mcpControls = new Map<string | number, string>();
  readonly #commands = new Map<string, string>();
  readonly #rateLimits = new Map<string, string>();
  #progressCount = 0;
  #progressLast: { uuid: string; estimatedTokens: number; estimatedTokensDelta: number } | null =
    null;

  constructor(
    readonly sessionId: string,
    readonly inputId: string,
    readonly promptHash: string,
    private readonly allowedTools: readonly string[] = NATIVE_TOOL_NAMES,
    private readonly toolPolicy: RepositoryToolPolicy = {
      version: 1,
      mode: "SELECTED",
      peerAllowed: allowedTools.includes(`mcp__${OWNED_SERVER}__ask_peer`),
    },
  ) {
    if (
      !uuid(sessionId) ||
      !uuid(inputId) ||
      !/^[a-f0-9]{64}$/.test(promptHash) ||
      !validToolPolicy(toolPolicy)
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  get terminal(): InputTerminal | undefined {
    return this.#terminal && structuredClone(this.#terminal);
  }
  get receiptObserved(): boolean {
    return this.#interruptReceipt;
  }
  get interruptRequested(): boolean {
    return this.#interruptRequested;
  }
  get open(): boolean {
    return this.#open;
  }
  seal(): void {
    this.#open = false;
    this.#sealed = true;
  }

  private same(frame: Record<string, unknown>, stamped = false): void {
    if (
      this.#terminal ||
      frame.session_id !== this.sessionId ||
      frame.parent_tool_use_id != null ||
      (stamped && frame.user_message_uuid !== this.inputId) ||
      (frame.user_message_uuid !== undefined && frame.user_message_uuid !== this.inputId) ||
      (frame.user_message_uuids !== undefined &&
        (!Array.isArray(frame.user_message_uuids) ||
          frame.user_message_uuids.length !== 1 ||
          frame.user_message_uuids[0] !== this.inputId))
    ) {
      throw new RuntimeError("UNKNOWN");
    }
  }

  user(
    frame: Record<string, unknown>,
  ): "INPUT_ACK" | "NATIVE_TOOL_RESULT" | "NATIVE_INTERRUPTION_ADVISORY" {
    this.same(frame);
    if (frame.type !== "user" || !uuid(frame.uuid)) throw new RuntimeError("UNKNOWN");
    const message = object(frame.message);
    if (message.role !== "user") throw new RuntimeError("UNKNOWN");
    if (frame.uuid === this.inputId) {
      let content = message.content;
      if (Array.isArray(content) && content.length === 1 && content[0]?.type === "text")
        content = content[0].text;
      if (typeof content !== "string" || digest(content) !== this.promptHash || this.#ack) {
        throw new RuntimeError("UNKNOWN");
      }
      this.#ack = true;
      return "INPUT_ACK";
    }
    if (
      this.#anchored &&
      this.#interruptRequested &&
      isInterruptionUserContent(
        message,
        (id) =>
          [...this.#controls.values()].some(
            (control) => control.toolId === id && control.cancelled,
          ),
        this.#interruptReceipt || [...this.#controls.values()].some((control) => control.cancelled),
      )
    )
      return "NATIVE_INTERRUPTION_ADVISORY";
    if (
      !this.#anchored ||
      !Array.isArray(message.content) ||
      !message.content.length ||
      message.content.length > 64
    ) {
      throw new RuntimeError("UNKNOWN");
    }
    for (const raw of message.content) {
      const block = object(raw);
      if (
        block.type !== "tool_result" ||
        typeof block.tool_use_id !== "string" ||
        !this.#tools.get(block.tool_use_id)?.responseWritten
      )
        throw new RuntimeError("UNKNOWN");
    }
    return "NATIVE_TOOL_RESULT";
  }

  assistant(frame: Record<string, unknown>, identityVerified: boolean): string {
    this.same(frame, !this.#anchored);
    if (!identityVerified || !this.#ack || frame.type !== "assistant") {
      throw new RuntimeError("UNKNOWN");
    }
    const message = object(frame.message);
    if (
      message.role !== "assistant" ||
      !bounded(message.model) ||
      !Array.isArray(message.content) ||
      message.content.length > 64 ||
      !uuid(frame.uuid)
    )
      throw new RuntimeError("UNKNOWN");
    this.#anchored = true;
    for (const raw of message.content) {
      const block = object(raw);
      if (block.type === "tool_use") {
        if (
          !this.#open ||
          !bounded(block.id) ||
          typeof block.name !== "string" ||
          !this.allowedTools.includes(block.name)
        ) {
          throw new RuntimeError("TOOL_REJECTED");
        }
        const args = validateToolArguments(
          this.toolPolicy.mode,
          null,
          this.toolPolicy.peerAllowed,
          block.name.replace(`mcp__${OWNED_SERVER}__`, ""),
          block.input,
        );
        const hash = digest(canonical(args));
        const old = this.#tools.get(block.id);
        if (old && (old.name !== block.name || old.argsHash !== hash))
          throw new RuntimeError("TOOL_REJECTED");
        if (!old) {
          if (this.#tools.size >= 64) throw new RuntimeError("RUNTIME_CAPACITY");
          this.#tools.set(block.id, {
            name: block.name,
            args: structuredClone(args),
            argsHash: hash,
            responseWritten: false,
            claimed: false,
          });
        }
      } else if (
        !["text", "thinking", "redacted_thinking"].includes(String(block.type)) ||
        typeof block.type !== "string"
      ) {
        throw new RuntimeError("UNKNOWN");
      }
    }
    return message.model;
  }

  claim(
    controlId: string,
    params: Record<string, unknown>,
    identityVerified: boolean,
    mcpRequestId?: string | number,
  ): {
    toolId: string;
    name: string;
    args: Record<string, unknown>;
    cancellation: Promise<void>;
  } {
    if (
      !identityVerified ||
      !this.#ack ||
      !this.#anchored ||
      !this.#open ||
      this.#terminal ||
      this.#interruptRequested ||
      !bounded(controlId) ||
      this.#controls.has(controlId) ||
      typeof params.name !== "string" ||
      !this.allowedTools.includes(`mcp__${OWNED_SERVER}__${params.name}`)
    )
      throw new RuntimeError("TOOL_REJECTED");
    if (
      mcpRequestId !== undefined &&
      (!requestId(mcpRequestId) || this.#mcpControls.has(mcpRequestId))
    )
      throw new RuntimeError("UNKNOWN");
    const args = validateToolArguments(
      this.toolPolicy.mode,
      null,
      this.toolPolicy.peerAllowed,
      params.name,
      params.arguments,
    );
    const argsHash = digest(canonical(args));
    let toolId: string;
    let progressToken: string | number | undefined;
    if (params._meta !== undefined) {
      const meta = object(params._meta);
      if (Object.hasOwn(meta, "claudecode/toolUseId")) {
        if (
          !exact(
            meta,
            Object.hasOwn(meta, "progressToken")
              ? ["claudecode/toolUseId", "progressToken"]
              : ["claudecode/toolUseId"],
          ) ||
          !bounded(meta["claudecode/toolUseId"]) ||
          (Object.hasOwn(meta, "progressToken") &&
            !bounded(meta.progressToken) &&
            !Number.isSafeInteger(meta.progressToken))
        )
          throw new RuntimeError("UNKNOWN");
        toolId = meta["claudecode/toolUseId"];
        progressToken = meta.progressToken as string | number | undefined;
      } else {
        if (
          !exact(meta, ["session_id", "user_message_uuid", "tool_use_id"]) ||
          meta.session_id !== this.sessionId ||
          meta.user_message_uuid !== this.inputId ||
          !bounded(meta.tool_use_id)
        )
          throw new RuntimeError("UNKNOWN");
        toolId = meta.tool_use_id;
      }
    } else {
      const matches = [...this.#tools].filter(
        ([, tool]) =>
          !tool.response &&
          tool.name === `mcp__${OWNED_SERVER}__${params.name}` &&
          tool.argsHash === argsHash,
      );
      if (matches.length !== 1) throw new RuntimeError("UNKNOWN");
      toolId = matches[0]![0];
    }
    const tool = this.#tools.get(toolId);
    if (
      !tool ||
      tool.claimed ||
      tool.name !== `mcp__${OWNED_SERVER}__${params.name}` ||
      tool.argsHash !== argsHash ||
      (progressToken !== undefined &&
        [...this.#controls.values()].some(
          (control) =>
            !control.written && !control.cancelled && control.progressToken === progressToken,
        ))
    ) {
      throw new RuntimeError("UNKNOWN");
    }
    if (this.#controls.size >= 64) throw new RuntimeError("RUNTIME_CAPACITY");
    let cancel!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancel = resolve;
    });
    tool.claimed = true;
    this.#controls.set(controlId, {
      toolId,
      cancellation,
      cancel,
      cancelled: false,
      written: false,
      progressToken,
    });
    if (mcpRequestId !== undefined) this.#mcpControls.set(mcpRequestId, controlId);
    return { toolId, name: params.name, args: structuredClone(args), cancellation };
  }

  response(
    controlId: string,
    create: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const tool = this.#tools.get(this.#controls.get(controlId)!.toolId)!;
    return (tool.response ??= create());
  }
  canRespond(controlId: string): boolean {
    const control = this.#controls.get(controlId);
    return (
      !!control &&
      !control.cancelled &&
      !control.written &&
      this.#open &&
      !this.#terminal &&
      !this.#interruptRequested
    );
  }
  responseWritten(controlId: string): void {
    if (!this.canRespond(controlId)) throw new RuntimeError("TOOL_REJECTED");
    const control = this.#controls.get(controlId)!;
    control.written = true;
    this.#tools.get(control.toolId)!.responseWritten = true;
  }
  cancelled(controlId: string): boolean {
    return this.#controls.get(controlId)?.cancelled ?? false;
  }

  requestInterrupt(): void {
    if (this.#terminal || !this.#open || this.#interruptRequested)
      throw new RuntimeError("UNKNOWN");
    this.#interruptRequested = true;
    this.#open = false;
  }
  receipt(receipt: Record<string, unknown>): NativeInterruptionReceipt {
    if (
      !this.#interruptRequested ||
      this.#interruptReceipt ||
      !exact(
        receipt,
        Object.hasOwn(receipt, "cancelled") ? ["still_queued", "cancelled"] : ["still_queued"],
      ) ||
      !Array.isArray(receipt.still_queued) ||
      receipt.still_queued.length ||
      (receipt.cancelled !== undefined &&
        (!Array.isArray(receipt.cancelled) ||
          receipt.cancelled.length > 1 ||
          receipt.cancelled.some((id: unknown) => id !== this.inputId)))
    ) {
      throw new RuntimeError("UNKNOWN");
    }
    this.#interruptReceipt = true;
    const cancelled = receipt.cancelled === undefined ? [] : [...(receipt.cancelled as string[])];
    return {
      stillQueued: [],
      cancelled,
      responseHash: digest(stableJson({ still_queued: [], cancelled })),
    };
  }
  cancel(frame: Record<string, unknown>): void {
    const control =
      typeof frame.request_id === "string" ? this.#controls.get(frame.request_id) : undefined;
    const tool = control && this.#tools.get(control.toolId);
    if (
      !exact(frame, ["type", "request_id"]) ||
      frame.type !== "control_cancel_request" ||
      !this.#interruptRequested ||
      this.#terminal ||
      !control ||
      control.cancelled ||
      control.written ||
      !tool ||
      tool.responseWritten ||
      !isNativeRepositoryTool(tool.name)
    )
      throw new RuntimeError("UNKNOWN");
    control.cancelled = true;
    control.cancelHash = digest(stableJson(frame));
    control.cancel();
  }

  cancelMcp(message: Record<string, unknown>): string {
    const params = object(message.params);
    if (
      !exact(message, ["jsonrpc", "method", "params"]) ||
      message.jsonrpc !== "2.0" ||
      message.method !== "notifications/cancelled" ||
      !exact(params, Object.hasOwn(params, "reason") ? ["requestId", "reason"] : ["requestId"]) ||
      !requestId(params.requestId) ||
      (Object.hasOwn(params, "reason") &&
        (typeof params.reason !== "string" || Buffer.byteLength(params.reason) > 2048))
    )
      throw new RuntimeError("UNKNOWN");
    const controlId = this.#mcpControls.get(params.requestId);
    if (controlId === undefined) throw new RuntimeError("UNKNOWN");
    // Normalize only a native notification matched to this input's claimed read request.
    // The stored cancellation hash remains the existing canonical control representation.
    this.cancel({ type: "control_cancel_request", request_id: controlId });
    return controlId;
  }

  cancellationReceipts(): NativeToolCancellation[] {
    return [...this.#controls.entries()]
      .filter(([, c]) => c.cancelled)
      .map(([controlId, c]) => {
        const tool = this.#tools.get(c.toolId)!;
        return {
          callId: c.toolId,
          controlId,
          cancelHash: c.cancelHash!,
          payloadHash: digest(
            stableJson({
              threadId: this.sessionId,
              turnId: this.inputId,
              callId: c.toolId,
              namespace: scopedNamespace,
              tool: tool.name.replace(`mcp__${scopedNamespace}__`, ""),
              arguments: tool.args,
            }),
          ),
        };
      });
  }

  progress(frame: Record<string, unknown>, identityVerified: boolean): void {
    if (
      !exact(frame, [
        "type",
        "subtype",
        "estimated_tokens",
        "estimated_tokens_delta",
        "user_message_uuid",
        "uuid",
        "session_id",
      ]) ||
      frame.type !== "system" ||
      frame.subtype !== "thinking_tokens" ||
      !identityVerified ||
      this.#terminal ||
      frame.session_id !== this.sessionId ||
      frame.user_message_uuid !== this.inputId ||
      !uuid(frame.uuid)
    ) {
      throw new RuntimeError("UNKNOWN");
    }
    if (
      !Number.isSafeInteger(frame.estimated_tokens) ||
      Number(frame.estimated_tokens) < 0 ||
      !Number.isSafeInteger(frame.estimated_tokens_delta)
    )
      throw new RuntimeError("UNKNOWN");
    if (this.#progressCount >= 65536) throw new RuntimeError("RUNTIME_CAPACITY");
    this.#progressCount++;
    this.#progressLast = {
      uuid: frame.uuid,
      estimatedTokens: frame.estimated_tokens as number,
      estimatedTokensDelta: frame.estimated_tokens_delta as number,
    };
  }
  rateLimit(frame: Record<string, unknown>, identityVerified: boolean): void {
    this.same(frame);
    if (
      !identityVerified ||
      !this.#ack ||
      this.#sealed ||
      (!this.#open && !this.#interruptRequested) ||
      !exact(frame, ["type", "rate_limit_info", "uuid", "session_id"]) ||
      frame.type !== "rate_limit_event" ||
      !uuid(frame.uuid) ||
      this.#rateLimits.has(frame.uuid) ||
      !validRateLimitInfo(object(frame.rate_limit_info))
    )
      throw new RuntimeError("UNKNOWN");
    if (this.#rateLimits.size >= 64) throw new RuntimeError("RUNTIME_CAPACITY");
    // A status observation never supplies input, tool, interruption or terminal authority.
    this.#rateLimits.set(frame.uuid, digest(stableJson(frame)));
  }
  command(frame: Record<string, unknown>): void {
    const keys = ["type", "command_uuid", "state", "uuid", "session_id"];
    if (
      !exact(frame, keys) ||
      frame.type !== "command_lifecycle" ||
      frame.session_id !== this.sessionId ||
      frame.command_uuid !== this.inputId ||
      !uuid(frame.uuid) ||
      typeof frame.state !== "string" ||
      !["queued", "started", "completed", "cancelled", "discarded", "refused"].includes(frame.state)
    ) {
      throw new RuntimeError("UNKNOWN");
    }
    const hash = digest(JSON.stringify(keys.map((key) => frame[key])));
    const old = this.#commands.get(frame.uuid);
    if (old !== undefined && old !== hash) throw new RuntimeError("UNKNOWN");
    if (old === undefined && this.#commands.size >= 16) throw new RuntimeError("RUNTIME_CAPACITY");
    this.#commands.set(frame.uuid, hash);
  }
  metadata(): {
    progress: {
      count: number;
      last: { uuid: string; estimatedTokens: number; estimatedTokensDelta: number } | null;
    };
    commands: number;
  } {
    return {
      progress: {
        count: this.#progressCount,
        last: this.#progressLast && { ...this.#progressLast },
      },
      commands: this.#commands.size,
    };
  }

  result(frame: Record<string, unknown>, identityVerified: boolean): InputTerminal {
    this.same(frame);
    this.#open = false;
    if (
      !identityVerified ||
      !this.#ack ||
      !this.#anchored ||
      frame.type !== "result" ||
      !uuid(frame.uuid) ||
      !Number.isSafeInteger(frame.num_turns) ||
      Number(frame.num_turns) < 1 ||
      Number(frame.num_turns) > 64 ||
      (frame.queued_turn_count !== undefined && frame.queued_turn_count !== 0) ||
      frame.resume_reason !== undefined ||
      frame.local_command !== undefined
    )
      throw new RuntimeError("UNKNOWN");
    let kind: InputTerminal["kind"];
    let text: string | null = null;
    if (
      frame.subtype === "success" &&
      frame.is_error === false &&
      (frame.terminal_reason === undefined || frame.terminal_reason === "completed") &&
      bounded(frame.result, 65536) &&
      frame.result.trim() &&
      [...this.#tools.values()].every((tool) => tool.responseWritten) &&
      [...this.#controls.values()].every((control) => control.written)
    ) {
      kind = "COMPLETED";
      text = frame.result;
    } else if (
      this.#interruptRequested &&
      frame.subtype === "error_during_execution" &&
      frame.is_error === true &&
      typeof frame.terminal_reason === "string" &&
      ["aborted_tools", "aborted_streaming"].includes(frame.terminal_reason) &&
      [...this.#controls.values()].every((control) => control.written || control.cancelled) &&
      [...this.#tools].every(
        ([id, tool]) =>
          tool.responseWritten ||
          [...this.#controls.values()].some(
            (control) => control.toolId === id && control.cancelled,
          ),
      )
    ) {
      kind = "INTERRUPTED";
    } else if (
      !this.#interruptRequested &&
      !["aborted_tools", "aborted_streaming"].includes(String(frame.terminal_reason)) &&
      frame.is_error === true &&
      typeof frame.subtype === "string" &&
      [
        "error_during_execution",
        "error_max_turns",
        "error_max_budget_usd",
        "error_max_structured_output_retries",
      ].includes(frame.subtype) &&
      Array.isArray(frame.errors) &&
      frame.errors.length > 0 &&
      frame.errors.length <= 16 &&
      frame.errors.every((error: unknown) => bounded(error, 4096)) &&
      [...this.#tools.values()].every((tool) => tool.responseWritten) &&
      [...this.#controls.values()].every((control) => control.written)
    ) {
      kind = "FAILED";
    } else throw new RuntimeError("UNKNOWN");
    this.#terminal = { kind, text, evidenceHash: digest(stableJson(frame)) };
    return structuredClone(this.#terminal);
  }
}
