import { randomUUID } from "node:crypto";
import {
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  claudeInterruptRequest,
  type AttemptAuthority,
  type Capabilities,
  type NativeInputIntent,
  type NativeInterruption,
  type NativeObservation,
  type OwnedContext,
  type RootIdentity,
  type RuntimeAdapter,
  type RuntimeSettings,
  type SettingsObservation,
  type TerminalEvidence,
} from "../runtime-contracts.ts";
import { isId, isHash } from "../contracts.ts";
import { repositoryMode } from "../workspace/repository-access.ts";
import {
  isOriginRoleRequestKind,
  nativeToolNames,
  repositoryTools,
  validateToolArguments,
} from "../workspace/tool-contracts.ts";
import { RuntimeFilePolicy } from "../runtime-file-policy.ts";
import { selectRuntimeSettings } from "../runtime-settings-policy.ts";
import { capabilityHash, projectCapability } from "../settings/contracts.ts";
import type { RequestPayload } from "../workflow-contracts.ts";
import { NativeInputProof, nativeIdentity, OWNED_SERVER } from "./input-proof.ts";
import { object, type OwnedHistory } from "./owned-history.ts";
import { requireClaudePolicy, type ClaudePolicy } from "./policy.ts";
import { proveOwnedHistory } from "./history-proof.ts";
import { checkpointNativeHistory } from "./native-history-proof.ts";
import { ClaudeTransport, type Launch, type TransportOptions } from "./transport.ts";

type Transport = Pick<
  ClaudeTransport,
  "setHandler" | "request" | "reply" | "write" | "close" | "settleMessages"
>;
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: RuntimeError) => void;
};
function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"], reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
async function awaitTool(
  pending: Promise<Record<string, unknown>>,
  cancellation: Promise<void>,
  signal?: AbortSignal,
) {
  let abort!: () => void;
  const stopped = new Promise<null>((resolve) => {
    abort = () => resolve(null);
  });
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([pending, cancellation.then(() => null), stopped]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
export interface ClaudeAdapterOptions {
  policy?: ClaudePolicy;
  /** Persisted before even the zero-input catalog child is created. */
  reserveCatalog?: (root: string, version: string, fingerprint: string) => Promise<OwnedContext>;
  /** Profile startup barriers apply to new UUIDs, never to child-free history observation. */
  beforeContextCreation?: () => void;
  history?: (context: OwnedContext, check: () => void) => Promise<OwnedHistory>;
  transport?: (launch: Launch, check: () => void) => Transport;
  transportOptions?: TransportOptions;
}
type Active = {
  authority: AttemptAuthority;
  settings: RuntimeSettings;
  intent: NativeInputIntent;
  proof: NativeInputProof;
  identity: Deferred<string>;
  ack: Promise<void> | null;
  cancellationsWritten: Promise<void>;
  interruptionWrites: Promise<void>;
  nativeInterruption?: NativeInterruption;
  interrupting?: Promise<boolean>;
  terminalReceived: boolean;
  done: Deferred<TerminalEvidence>;
  observedModel: string | null;
  initHash: string | null;
  tools: readonly string[];
  liveFrames: Record<string, unknown>[];
  liveBytes: number;
  historyOverflow: boolean;
  toolReceipts: Map<
    string,
    NonNullable<OwnedContext["ownedTurns"][number]["toolReceipts"]>[number]
  >;
};

/** Product authority owns tools, input durability and publication; native CLI owns generation. */
export class ClaudeAdapter implements RuntimeAdapter {
  private transport: Transport | undefined;
  private active: Active | undefined;
  private closed = false;
  private failure: RuntimeError | undefined;
  private catalog: { root: string; value: Capabilities } | undefined;
  private catalogContext: OwnedContext | undefined;
  private catalogCheck: (() => void) | undefined;
  private transportCleanup: Promise<void> | undefined;
  private cleanup: Promise<void> | undefined;
  private drift: ReturnType<typeof setInterval> | undefined;
  private historyFormat: OwnedHistory["format"];
  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  private policy() {
    return requireClaudePolicy(this.options.policy);
  }
  private live(root: string, check: () => void) {
    if (this.closed) throw this.failure ?? new RuntimeError("RUNTIME_CLOSED");
    check();
    this.policy().assertLive(root, check);
    check();
  }
  private async admit(root: string, check: () => void) {
    check();
    await this.policy().admit(root, check);
    this.live(root, check);
  }
  private context(context: OwnedContext) {
    const policy = this.policy(),
      m = context.materialization;
    if (
      context.provider !== "claude" ||
      !isId(context.threadId) ||
      !m ||
      m.version !== policy.version ||
      m.policyFingerprint !== policy.fingerprint ||
      (m.state === "RESERVED"
        ? m.initHash !== null || context.ownedTurns.length !== 0
        : !isHash(m.initHash))
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  private async connect(
    context: OwnedContext,
    settings: RuntimeSettings | null,
    tools: readonly string[],
    resume: boolean,
    check: () => void,
  ) {
    this.context(context);
    this.live(context.root.path, check);
    if (this.transport) throw new RuntimeError("RUNTIME_BUSY");
    const launch = this.policy().launch(context, settings, tools, resume);
    if (launch.cwd !== context.root.path || !Array.isArray(launch.args))
      throw new RuntimeError("POLICY_UNCONFIRMED");
    this.live(context.root.path, check);
    this.transport =
      this.options.transport?.(launch, check) ??
      new ClaudeTransport(launch, check, this.options.transportOptions);
    this.transport.setHandler(
      (frame, signal) => this.message(frame, signal),
      (error) => this.fail(error),
    );
    this.drift = setInterval(() => {
      try {
        this.live(context.root.path, check);
      } catch (error) {
        this.fail(error);
      }
    }, 100);
    const response = object(
      await this.transport.request({ subtype: "initialize", sdkMcpServers: [OWNED_SERVER] }),
    );
    this.live(context.root.path, check);
    return response;
  }
  async capabilities(root: string, check: () => void): Promise<Capabilities> {
    await this.admit(root, check);
    if (this.catalog?.root === root) return structuredClone(this.catalog.value);
    if (!this.options.reserveCatalog) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const policy = this.policy();
    const context = await this.options.reserveCatalog(root, policy.version, policy.fingerprint);
    this.context(context);
    if (context.root.path !== root || context.materialization!.state !== "RESERVED")
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    this.catalogContext = context;
    this.catalogCheck = check;
    try {
      const response = await this.connect(
        context,
        null,
        nativeToolNames("SELECTED", false),
        false,
        check,
      );
      const projected = this.observedCapability(response);
      this.live(root, check);
      const value: Capabilities = { ...projected, policy: "CONFIRMED" };
      this.catalog = { root, value };
      return structuredClone(value);
    } finally {
      await this.closeTransport();
      this.catalogContext = undefined;
      this.catalogCheck = undefined;
    }
  }
  private observedCapability(response: Record<string, unknown>) {
    const models = this.models(response);
    const defaults = models.find((model) => model.isDefault);
    const contents = {
      runtime: "claude" as const,
      version: this.policy().version,
      models,
      defaultSettings:
        defaults && (defaults.efforts.length === 0 || defaults.defaultEffort !== null)
          ? { model: defaults.model, effort: defaults.defaultEffort }
          : null,
      policy: "verified" as const,
    };
    return projectCapability({ ...contents, snapshotHash: capabilityHash(contents) });
  }
  private models(response: Record<string, unknown>): Capabilities["models"] {
    if (
      !Array.isArray(response.models) ||
      response.models.length === 0 ||
      response.models.length > 256
    )
      throw new RuntimeError("UNSUPPORTED_SETTINGS");
    return response.models.map((raw) => {
      const m = object(raw),
        levels = m.supportedEffortLevels;
      if (
        typeof m.value !== "string" ||
        !m.value ||
        (m.supportsEffort !== undefined && typeof m.supportsEffort !== "boolean") ||
        (levels !== undefined &&
          (!Array.isArray(levels) ||
            levels.length > 12 ||
            levels.some((v) => typeof v !== "string")))
      )
        throw new RuntimeError("UNSUPPORTED_SETTINGS");
      if (m.supportsEffort === true && (!Array.isArray(levels) || levels.length === 0))
        throw new RuntimeError("UNSUPPORTED_SETTINGS");
      if (m.supportsEffort === false && Array.isArray(levels) && levels.length > 0)
        throw new RuntimeError("UNSUPPORTED_SETTINGS");
      return {
        id: m.value,
        model: m.value,
        efforts: Array.isArray(levels) ? ([...levels] as string[]) : [],
        defaultEffort: typeof m.defaultEffort === "string" ? m.defaultEffort : null,
        isDefault: m.isDefault === true,
      };
    });
  }
  async prepare(
    root: RootIdentity,
    settings: RuntimeSettings,
    generation: string,
    epoch: number,
    check: () => void,
    onCreated?: (context: OwnedContext) => Promise<void>,
  ): Promise<OwnedContext> {
    repositoryMode(settings, { generation, root });
    await this.admit(root.path, check);
    this.options.beforeContextCreation?.();
    check();
    if (settings.provider !== "claude" || settings.capabilities.runtime !== "claude" || !onCreated)
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    this.assertSettings(settings);
    await new RuntimeFilePolicy(root, settings.files).assertUnchanged(check);
    const context: OwnedContext = {
      ownership: "CONNECTOR_CREATED",
      provider: "claude",
      root: structuredClone(root),
      generation,
      epoch,
      threadId: randomUUID(),
      level: "L1",
      ownedTurns: [],
      materialization: {
        state: "RESERVED",
        version: this.policy().version,
        policyFingerprint: this.policy().fingerprint,
        initHash: null,
      },
    };
    // A host reservation can be durable without creating a native transcript or submitting input.
    await onCreated(structuredClone(context));
    this.live(root.path, check);
    return context;
  }
  private assertSettings(settings: RuntimeSettings) {
    if (
      settings.provider !== "claude" ||
      settings.capabilities.runtime !== "claude" ||
      settings.capabilities.version !== this.policy().version
    )
      throw new RuntimeError("UNSUPPORTED_SETTINGS");
    try {
      projectCapability({ ...settings.capabilities, runtime: "claude", policy: "verified" });
    } catch {
      throw new RuntimeError("UNSUPPORTED_SETTINGS");
    }
    selectRuntimeSettings(settings.capabilities, settings.requested, "claude");
  }
  private report(settings: RuntimeSettings, model: string | null): SettingsObservation {
    return {
      requested: structuredClone(settings.requested),
      thread: { model, provider: "anthropic", effort: null },
      turn: {
        requestedModel: settings.requested.model,
        requestedEffort: settings.requested.effort,
        model,
        rerouted: model !== null && model !== settings.requested.model,
        effortVerification: "UNVERIFIED",
      },
    };
  }
  async validate(
    context: OwnedContext,
    settings: RuntimeSettings,
    check: () => void,
  ): Promise<SettingsObservation> {
    repositoryMode(settings, context);
    await this.admit(context.root.path, check);
    this.context(context);
    if (settings.provider !== "claude" || settings.capabilities.version !== this.policy().version)
      throw new RuntimeError("UNSUPPORTED_SETTINGS");
    this.assertSettings(settings);
    await new RuntimeFilePolicy(context.root, settings.files).assertUnchanged(check);
    this.live(context.root.path, check);
    if (context.materialization!.state === "MATERIALIZED") {
      if (!this.options.history) throw new RuntimeError("CONTEXT_UNCONFIRMED");
      const history = await this.options.history(context, check);
      this.historyFormat = history.format;
      this.live(context.root.path, check);
      proveOwnedHistory(context, history, this.policy().version, undefined, settings);
    }
    return this.report(settings, null);
  }
  async execute(
    authority: AttemptAuthority,
    settings: RuntimeSettings,
    payload: RequestPayload,
    beforeSubmit: (intent?: NativeInputIntent) => Promise<void>,
  ): Promise<TerminalEvidence> {
    const check = () => authority.assertLive();
    await this.validate(authority.context, settings, check);
    if (this.active || this.transport) throw new RuntimeError("RUNTIME_BUSY");
    if (authority.context.materialization!.state === "RESERVED" && this.options.history) {
      const history = await this.options.history(authority.context, check);
      this.historyFormat = history.format;
      if (history.materialized || history.records.length)
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
    }
    const toolPolicy = {
      version: 1 as const,
      mode: repositoryMode(settings, authority.context),
      peerAllowed:
        isOriginRoleRequestKind(payload.requestKind) &&
        authority.peerTools === true &&
        settings.autoQuestionsConfirmed,
    };
    const tools = nativeToolNames(toolPolicy.mode, toolPolicy.peerAllowed);
    const prompt = stableJson({
      task: payload,
      handoff: settings.handoff,
      selectedFiles: settings.files.map((f) => f.path),
      toolPolicy,
      repositoryEvidence:
        toolPolicy.mode === "AUTO_CODE"
          ? "Only returned repository matches/excerpts are read evidence. Relative paths and whole-file hashes may be shared. Repository tools are read-only and exclude secrets, authentication, personal instructions and outside paths."
          : "Selected unchanged public files.",
    });
    const intent: NativeInputIntent = {
      provider: "claude",
      sessionId: authority.context.threadId,
      inputId: randomUUID(),
      promptHash: digest(prompt),
      generation: authority.context.generation,
      scope: structuredClone(authority.scope),
      attemptId: authority.attempt.attemptId,
      fence: authority.attempt.fence,
      policyFingerprint: this.policy().fingerprint,
      toolPolicy,
    };
    await beforeSubmit(intent);
    this.live(authority.context.root.path, check);
    const active: Active = {
      authority,
      settings,
      intent,
      tools,
      proof: new NativeInputProof(
        intent.sessionId,
        intent.inputId,
        intent.promptHash,
        tools,
        toolPolicy,
      ),
      identity: deferred<string>(),
      ack: null,
      cancellationsWritten: Promise.resolve(),
      interruptionWrites: Promise.resolve(),
      terminalReceived: false,
      done: deferred<TerminalEvidence>(),
      observedModel: null,
      initHash: null,
      liveFrames: [],
      liveBytes: 0,
      historyOverflow: false,
      toolReceipts: new Map(),
    };
    this.active = active;
    let evidence: TerminalEvidence;
    try {
      const initialized = await this.connect(
        authority.context,
        settings,
        tools,
        authority.context.materialization!.state === "MATERIALIZED",
        check,
      );
      const observed = this.observedCapability(initialized);
      if (observed.snapshotHash !== settings.capabilities.snapshotHash)
        throw new RuntimeError("UNSUPPORTED_SETTINGS");
      this.live(authority.context.root.path, check);
      await this.transport!.write({
        type: "user",
        uuid: intent.inputId,
        session_id: intent.sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: prompt },
      });
      evidence = await active.done.promise;
    } catch (error) {
      this.fail(error);
      throw this.failure;
    } finally {
      await this.closeTransport();
      this.active = undefined;
    }
    if (this.historyFormat === "claude-jsonl-v1") {
      this.live(authority.context.root.path, check);
      try {
        const history = await this.options.history!(authority.context, check);
        evidence.nativeHistory = active.historyOverflow
          ? { state: "UNVERIFIED", reason: "HISTORY_REJECTED" }
          : checkpointNativeHistory(
              authority.context,
              history,
              this.policy().version,
              active.intent,
              active.liveFrames,
              [...active.toolReceipts.values()],
            );
      } catch {
        // A confirmed live terminal remains publishable even when its resume file is unavailable.
        evidence.nativeHistory = { state: "UNVERIFIED", reason: "HISTORY_REJECTED" };
      }
      this.live(authority.context.root.path, check);
    }
    return evidence;
  }
  private retainMessage(active: Active, frame: Record<string, unknown>) {
    if (active.historyOverflow) return;
    const bytes = Buffer.byteLength(stableJson(frame));
    if (active.liveFrames.length >= 4096 || active.liveBytes + bytes > 16 * 1024 * 1024) {
      active.historyOverflow = true;
      active.liveFrames = [];
      return;
    }
    active.liveBytes += bytes;
    active.liveFrames.push(structuredClone(frame));
  }
  private async message(frame: Record<string, unknown>, _signal: AbortSignal): Promise<void> {
    const active = this.active,
      context = active?.authority.context ?? this.catalogContext;
    if (!context) throw new RuntimeError("UNKNOWN");
    const check = active ? () => active.authority.assertLive() : this.catalogCheck!;
    this.live(context.root.path, check);
    if (frame.type === "control_request") {
      await this.control(frame, active, _signal);
      return;
    }
    if (frame.type === "system" && frame.subtype === "init") {
      nativeIdentity(
        frame,
        context.threadId,
        context.root.path,
        this.policy().version,
        active?.tools ?? nativeToolNames("SELECTED", false),
      );
      if (active) {
        if (active.initHash) throw new RuntimeError("UNKNOWN");
        active.initHash = digest(stableJson(frame));
        active.identity.resolve(active.initHash);
      }
      return;
    }
    if (!active) throw new RuntimeError("UNKNOWN");
    if (frame.type === "user") {
      if (active.proof.user(frame) === "INPUT_ACK") {
        active.ack = active.identity.promise.then((hash) =>
          active.authority.ack(active.intent.sessionId, active.intent.inputId, hash),
        );
        void active.ack.catch((error) => this.fail(error));
      }
      this.retainMessage(active, frame);
      return;
    }
    if (frame.type === "control_cancel_request") {
      active.proof.cancel(frame);
      const cancellation = active.proof
        .cancellationReceipts()
        .find((c) => c.controlId === frame.request_id)!;
      if (!active.authority.cancelledTool) throw new RuntimeError("CONTEXT_UNCONFIRMED");
      // Fence each exact call immediately; only its durable write joins the terminal barrier.
      const written = active.authority.cancelledTool(cancellation);
      active.cancellationsWritten = Promise.all([active.cancellationsWritten, written]).then(
        () => {},
      );
      await active.cancellationsWritten;
      return;
    }
    if (frame.type === "system" && frame.subtype === "thinking_tokens") {
      active.proof.progress(frame, active.initHash !== null);
      return;
    }
    if (frame.type === "command_lifecycle") {
      active.proof.command(frame);
      return;
    }
    if (frame.type === "rate_limit_event") {
      if (!active.ack || active.terminalReceived) throw new RuntimeError("UNKNOWN");
      // Validate advisory arrival before any later terminal can seal this input.
      // Completion still joins durable ACK storage and the live authority barrier.
      active.proof.rateLimit(frame, active.initHash !== null);
      await active.ack;
      this.live(context.root.path, check);
      return;
    }
    if (frame.type === "result") {
      active.terminalReceived = true;
      // Only stores already started at receipt can delay the terminal; future RPC replies cannot.
      await active.interruptionWrites;
      active.proof.seal();
    }
    if (!active.ack) throw new RuntimeError("UNKNOWN");
    await active.ack;
    this.live(context.root.path, check);
    if (frame.type === "assistant") {
      active.observedModel = active.proof.assistant(frame, active.initHash !== null);
      this.retainMessage(active, frame);
      return;
    }
    if (frame.type !== "result") throw new RuntimeError("UNKNOWN");
    await active.cancellationsWritten;
    const terminal = active.proof.result(frame, active.initHash !== null);
    active.done.resolve({
      threadId: active.intent.sessionId,
      turnId: active.intent.inputId,
      terminal: terminal.kind,
      privateText: terminal.text ?? "",
      publicText: "",
      textProof: terminal.kind === "COMPLETED" ? "FINAL_ANSWER" : "UNCONFIRMED",
      finalItems: [{ id: String(frame.uuid), hash: terminal.evidenceHash }],
      observation: this.report(active.settings, active.observedModel),
      nativeInitHash: active.initHash!,
      toolCancellations: active.proof.cancellationReceipts(),
      ...(active.nativeInterruption
        ? { nativeInterruption: structuredClone(active.nativeInterruption) }
        : {}),
    });
  }
  private async control(
    frame: Record<string, unknown>,
    active: Active | undefined,
    signal?: AbortSignal,
  ) {
    const request = object(frame.request),
      mcp = object(request.message);
    if (
      typeof frame.request_id !== "string" ||
      request.subtype !== "mcp_message" ||
      request.server_name !== OWNED_SERVER ||
      mcp.jsonrpc !== "2.0"
    )
      throw new RuntimeError("TOOL_REJECTED");
    if (mcp.method === "notifications/initialized") {
      if (mcp.id !== undefined) throw new RuntimeError("UNKNOWN");
      await this.transport!.reply(frame.request_id, {
        mcp_response: { jsonrpc: "2.0", id: 0, result: {} },
      });
      return;
    }
    if (!(
      typeof mcp.id === "string" ||
      (typeof mcp.id === "number" && Number.isSafeInteger(mcp.id))
    ))
      throw new RuntimeError("UNKNOWN");
    let result: Record<string, unknown>;
    if (mcp.method === "initialize") {
      const params = object(mcp.params);
      if (!["2025-11-25", "2024-11-05"].includes(String(params.protocolVersion)))
        throw new RuntimeError("UNKNOWN");
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: OWNED_SERVER, version: "0.1.0" },
      };
    } else if (mcp.method === "tools/list") {
      result = {
        tools: active
          ? repositoryTools(
              active.intent.toolPolicy!.mode,
              active.settings.files,
              active.intent.toolPolicy!.peerAllowed,
            )
          : repositoryTools("SELECTED", [], false),
      };
    } else if (mcp.method === "tools/call") {
      if (!active?.ack) throw new RuntimeError("TOOL_REJECTED");
      await active.ack;
      active.authority.assertLive();
      const claim = active.proof.claim(
        frame.request_id,
        object(mcp.params),
        active.initHash !== null,
      );
      validateToolArguments(
        repositoryMode(active.settings, active.authority.context),
        active.settings.files,
        active.intent.toolPolicy!.peerAllowed,
        claim.name,
        claim.args,
      );
      const pending = active.proof.response(frame.request_id, async () => {
        const value = await active.authority.tool({
          threadId: active.intent.sessionId,
          turnId: active.intent.inputId,
          callId: claim.toolId,
          namespace: scopedNamespace,
          tool: claim.name,
          arguments: claim.args,
        });
        return {
          content: value.contentItems.map((item) => ({ type: "text", text: item.text })),
          isError: !value.success,
        };
      });
      const response = await awaitTool(pending, claim.cancellation, signal);
      if (response === null) return;
      if (!active.proof.canRespond(frame.request_id)) return;
      active.authority.assertLive();
      await this.transport!.reply(frame.request_id, {
        mcp_response: { jsonrpc: "2.0", id: mcp.id, result: response },
      });
      active.proof.responseWritten(frame.request_id);
      active.toolReceipts.set(claim.toolId, {
        callId: claim.toolId,
        payloadHash: digest(
          stableJson({
            threadId: active.intent.sessionId,
            turnId: active.intent.inputId,
            callId: claim.toolId,
            namespace: scopedNamespace,
            tool: claim.name,
            arguments: claim.args,
          }),
        ),
        responseHash: digest(stableJson(response)),
      });
      return;
    } else throw new RuntimeError("TOOL_REJECTED");
    await this.transport!.reply(frame.request_id, {
      mcp_response: { jsonrpc: "2.0", id: mcp.id, result },
    });
  }
  async interrupt(authority: AttemptAuthority): Promise<boolean> {
    const active = this.active;
    if (!active || active.authority !== authority || !this.transport || active.proof.terminal)
      return false;
    if (active.interrupting) return active.interrupting;
    if (active.terminalReceived) return false;
    active.interrupting = this.interruptInput(active, this.transport).catch((error) => {
      if (this.hasTerminal(active, "COMPLETED")) return false;
      this.fail(error);
      throw error;
    });
    return active.interrupting;
  }
  private async persistInterruption(active: Active, proof: NativeInterruption): Promise<boolean> {
    if (!active.authority.interruption) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    let saved = false;
    // Install the barrier before invoking storage, which may synchronously deliver a terminal.
    const write = active.interruptionWrites.then(async () => {
      const outcome = await active.authority.interruption!(structuredClone(proof));
      if (outcome === "CLOSED") return;
      if (outcome !== "SAVED") throw new RuntimeError("CONTEXT_UNCONFIRMED");
      active.nativeInterruption = structuredClone(proof);
      if (!proof.receipt) active.proof.requestInterrupt();
      saved = true;
    });
    active.interruptionWrites = write;
    void write.catch(() => {});
    await write;
    return saved;
  }
  private async interruptInput(active: Active, transport: Transport): Promise<boolean> {
    const proof: NativeInterruption = {
      intent: structuredClone(active.intent),
      intentHash: digest(stableJson(active.intent)),
      requestHash: digest(stableJson(claudeInterruptRequest)),
    };
    if (!(await this.persistInterruption(active, proof))) return false;
    if (active.terminalReceived) return (await active.done.promise).terminal === "INTERRUPTED";
    if (this.active !== active) throw new RuntimeError("RUNTIME_CLOSED");
    // Owned cleanup storage does not reopen ordinary input, tools, or native control authority.
    active.authority.assertLive();
    let receipt: Record<string, unknown>;
    try {
      receipt = object(await transport.request(claudeInterruptRequest));
    } catch (error) {
      if (this.hasTerminal(active, "COMPLETED")) return false;
      throw error;
    }
    if (this.hasTerminal(active, "COMPLETED")) return false;
    const confirmed = active.proof.receipt(receipt);
    if (active.terminalReceived) return (await active.done.promise).terminal === "INTERRUPTED";
    await this.persistInterruption(active, { ...proof, receipt: confirmed });
    // The exact interrupted input remains valid when terminal cleanup wins the receipt race.
    return this.active === active || this.hasTerminal(active, "INTERRUPTED");
  }
  private hasTerminal(active: Active, kind: "COMPLETED" | "INTERRUPTED") {
    return active.proof.terminal?.kind === kind;
  }
  async observe(
    context: OwnedContext,
    settings: RuntimeSettings,
    native: NativeObservation,
    check: () => void,
  ): Promise<TerminalEvidence | null> {
    repositoryMode(settings, context);
    await this.admit(context.root.path, check);
    this.context(context);
    if (
      !native.intent ||
      native.intent.sessionId !== context.threadId ||
      native.threadId !== context.threadId ||
      native.turnId !== native.intent.inputId ||
      native.intent.generation !== context.generation ||
      native.intent.policyFingerprint !== this.policy().fingerprint ||
      !this.options.history
    )
      return null;
    const history = await this.options.history(context, check);
    this.live(context.root.path, check);
    const result = proveOwnedHistory(context, history, this.policy().version, native, settings);
    if (!result) return null;
    return {
      threadId: context.threadId,
      turnId: native.turnId,
      terminal: result.terminal.kind,
      privateText: result.terminal.text ?? "",
      publicText: "",
      finalItems: [{ id: result.id, hash: result.terminal.evidenceHash }],
      textProof: result.terminal.kind === "COMPLETED" ? "FINAL_ANSWER" : "UNCONFIRMED",
      observation: this.report(settings, result.model),
      nativeInitHash: result.initHash,
      toolCancellations: structuredClone(native.toolCancellations ?? []),
      ...(native.nativeInterruption
        ? { nativeInterruption: structuredClone(native.nativeInterruption) }
        : {}),
    };
  }

  private fail(error: unknown) {
    if (this.failure) return;
    this.failure = error instanceof RuntimeError ? error : new RuntimeError("UNKNOWN");
    this.closed = true;
    this.active?.proof.seal();
    this.active?.identity.reject(this.failure);
    this.active?.done.reject(this.failure);
  }
  private async closeTransport() {
    if (this.drift) clearInterval(this.drift);
    this.drift = undefined;
    const transport = this.transport;
    if (!transport) return;
    this.transportCleanup ??= (async () => {
      try {
        const cleanup = await transport.close();
        if (!cleanup.reaped || cleanup.code !== "REAPED") {
          this.fail(new RuntimeError("CLEANUP_INCOMPLETE"));
          throw new RuntimeError("CLEANUP_INCOMPLETE");
        }
      } finally {
        if (this.transport === transport) this.transport = undefined;
      }
    })();
    try {
      await this.transportCleanup;
    } finally {
      this.transportCleanup = undefined;
    }
  }
  close(): Promise<void> {
    this.cleanup ??= (async () => {
      this.fail(new RuntimeError("RUNTIME_CLOSED"));
      await this.closeTransport();
    })();
    return this.cleanup;
  }
}
