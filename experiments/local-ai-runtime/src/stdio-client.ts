import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = 1024 * 1024;

type JsonRpcId = number | string;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface JsonObject {
  readonly [key: string]: unknown;
}

export interface RuntimeEvent {
  readonly kind: string;
  readonly threadId?: string;
  readonly turnId?: string;
  readonly status?: string;
  readonly textHash?: string;
  readonly phase?: "commentary" | "final_answer";
}

export interface ToolCallContext {
  readonly signal: AbortSignal;
  isActive(): boolean;
}

export interface ToolCallResult {
  readonly success: boolean;
  readonly contentItems: readonly { readonly type: "inputText"; readonly text: string }[];
}

export type DynamicToolHandler = (params: unknown, context: ToolCallContext) => Promise<ToolCallResult>;

export const SCOPED_TOOL_NAMESPACE = "ai_collaboration_scoped";

export const SCOPED_DISABLED_FEATURES = [
  "shell_tool", "unified_exec", "apps", "browser_use", "browser_use_external",
  "browser_use_full_cdp_access", "computer_use", "image_generation", "view_image",
  "code_mode_host", "multi_agent", "memories", "skill_mcp_dependency_install",
  "workspace_dependencies",
] as const;

export const SCOPED_PROCESS_OVERRIDES = [
  'approval_policy="never"', 'sandbox_mode="read-only"',
  "apps._default.enabled=false", 'web_search="disabled"', "agents.enabled=false",
  'shell_environment_policy.inherit="none"',
  `features.code_mode.direct_only_tool_namespaces=["${SCOPED_TOOL_NAMESPACE}"]`,
  ...SCOPED_DISABLED_FEATURES.map((name) => `features.${name}=false`),
] as const;

export interface StdioClientOptions {
  readonly cwd: string;
  readonly requestTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly experimentalApi?: boolean;
  readonly dynamicToolHandler?: DynamicToolHandler;
  readonly toolTimeoutMs?: number;
}

export interface TestProcessOptions extends StdioClientOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

export class RuntimeTransportError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "RuntimeTransportError";
  }
}

export interface RuntimeClient {
  initialize(): Promise<unknown>;
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown>;
  onEvent(listener: (event: RuntimeEvent) => void): () => void;
  close(): Promise<void>;
  readonly stderrBytes: number;
  readonly childPid: number | undefined;
}

export class StdioClient implements RuntimeClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #requestTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #listeners = new Set<(event: RuntimeEvent) => void>();
  readonly #experimentalApi: boolean;
  readonly #toolHandler: DynamicToolHandler | undefined;
  readonly #toolTimeoutMs: number;
  readonly #toolCalls = new Map<JsonRpcId, { controller: AbortController; params: unknown }>();
  readonly #seenToolRpcIds = new Set<JsonRpcId>();
  #nextId = 1;
  #stdoutBuffer = Buffer.alloc(0);
  #initialized = false;
  #closing = false;
  #closed = false;
  #stderrBytes = 0;
  #fatalError: RuntimeTransportError | undefined;

  private constructor(
    executable: string,
    args: readonly string[],
    options: StdioClientOptions,
    env?: NodeJS.ProcessEnv,
  ) {
    this.#experimentalApi = options.experimentalApi === true;
    this.#toolHandler = this.#experimentalApi ? options.dynamicToolHandler : undefined;
    this.#toolTimeoutMs = Math.max(1, Math.min(options.toolTimeoutMs ?? 2_000, 2_000));
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#child = spawn(executable, [...args], {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    this.#child.stdin.on("error", () => this.#fail("RUNTIME_WRITE_ERROR"));
    this.#child.stdout.on("end", () => this.#fail("RUNTIME_EOF"));
    this.#child.stderr.on("data", (chunk: Buffer) => {
      this.#stderrBytes += chunk.byteLength;
    });
    this.#child.once("error", () => this.#fail("RUNTIME_SPAWN_ERROR"));
    this.#child.once("exit", () => {
      this.#closed = true;
      this.#fail("RUNTIME_EXIT");
    });
  }

  public static launchCodex(options: StdioClientOptions): StdioClient {
    return new StdioClient("codex", ["app-server"], options, process.env);
  }

  public static launchScopedCodex(options: StdioClientOptions): StdioClient {
    const args = ["app-server", ...SCOPED_PROCESS_OVERRIDES.flatMap((value) => ["-c", value])];
    return new StdioClient("codex", args, options, process.env);
  }

  /** This injection seam exists only for deterministic subprocess tests. */
  public static launchForTest(options: TestProcessOptions): StdioClient {
    return new StdioClient(options.executable, options.args, options, options.env);
  }

  public get childPid(): number | undefined {
    return this.#child.pid;
  }

  public get stderrBytes(): number {
    return this.#stderrBytes;
  }

  public async initialize(): Promise<unknown> {
    if (this.#initialized) {
      throw new RuntimeTransportError("ALREADY_INITIALIZED");
    }
    const result = await this.#sendRequest(
      "initialize",
      {
        clientInfo: { name: "local-ai-runtime-spike", version: "0.1.0" },
        capabilities: { experimentalApi: this.#experimentalApi },
      },
      this.#requestTimeoutMs,
      true,
    );
    await this.#write({ method: "initialized", params: {} });
    this.#initialized = true;
    return result;
  }

  public request(method: string, params: JsonObject, timeoutMs = this.#requestTimeoutMs): Promise<unknown> {
    if (!this.#initialized) {
      return Promise.reject(new RuntimeTransportError("HANDSHAKE_REQUIRED"));
    }
    return this.#sendRequest(method, params, timeoutMs, false);
  }

  public onEvent(listener: (event: RuntimeEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    if (!this.#closing) {
      this.#closing = true;
      this.#cancelToolCalls();
      this.#rejectPending(new RuntimeTransportError("RUNTIME_CLOSED"));
      this.#child.stdin.end();
    }
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      this.#closed = true;
      return;
    }
    // Allow a bounded stdin-EOF shutdown so the final initialized notification is consumed.
    let exited = await this.#waitForExit(this.#closeTimeoutMs);
    if (!exited && this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      exited = await this.#waitForExit(this.#closeTimeoutMs);
    }
    if (!exited && this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await this.#waitForExit(this.#closeTimeoutMs);
    }
    this.#closed = true;
  }

  async #sendRequest(
    method: string,
    params: JsonObject,
    timeoutMs: number,
    allowBeforeInitialize: boolean,
  ): Promise<unknown> {
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (this.#closing || this.#closed) {
      throw new RuntimeTransportError("RUNTIME_CLOSED");
    }
    if (!allowBeforeInitialize && !this.#initialized) {
      throw new RuntimeTransportError("HANDSHAKE_REQUIRED");
    }

    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new RuntimeTransportError("REQUEST_TIMEOUT");
        reject(error);
        this.#fail(error.code);
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      void this.#write({ id, method, params }).catch(() => this.#fail("RUNTIME_WRITE_ERROR"));
    });
  }

  async #write(message: JsonObject): Promise<void> {
    if (this.#closing || this.#closed) {
      throw new RuntimeTransportError("RUNTIME_CLOSED");
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, (error) => {
        if (error === null || error === undefined) {
          resolve();
        } else {
          reject(new RuntimeTransportError("RUNTIME_WRITE_ERROR"));
        }
      });
    });
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#closed || this.#fatalError !== undefined) {
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    if (this.#stdoutBuffer.byteLength > MAX_LINE_BYTES && !this.#stdoutBuffer.includes(0x0a)) {
      this.#fail("RUNTIME_LINE_TOO_LARGE");
      return;
    }

    let newline = this.#stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.byteLength > MAX_LINE_BYTES) {
        this.#fail("RUNTIME_LINE_TOO_LARGE");
        return;
      }
      if (line.byteLength > 0) {
        this.#consumeLine(line.toString("utf8"));
      }
      if (this.#fatalError !== undefined) {
        return;
      }
      newline = this.#stdoutBuffer.indexOf(0x0a);
    }
  }

  #consumeLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      this.#fail("RUNTIME_MALFORMED_JSON");
      return;
    }
    if (!isObject(message)) {
      this.#fail("RUNTIME_INVALID_MESSAGE");
      return;
    }

    if (isRpcId(message.id) && typeof message.method === "string") {
      this.#handleServerRequest(message.id, message.method, message.params);
      return;
    }
    if (isRpcId(message.id)) {
      this.#handleResponse(message.id, message);
      return;
    }
    if (typeof message.method === "string") {
      const event = summarizeNotification(message.method, message.params);
      if (event.kind === "turn/completed") {
        for (const call of this.#toolCalls.values()) {
          const params = isObject(call.params) ? call.params : {};
          if (params.threadId === event.threadId && params.turnId === event.turnId) call.controller.abort();
        }
      }
      this.#emitEvent(event);
      return;
    }
    this.#fail("RUNTIME_INVALID_MESSAGE");
  }

  #handleResponse(id: JsonRpcId, message: JsonObject): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new RuntimeTransportError("RPC_ERROR"));
      return;
    }
    pending.resolve(message.result);
  }

  #handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    if (method === "item/tool/call" && this.#toolHandler !== undefined) {
      this.#handleToolCall(id, params);
      return;
    }
    let result: JsonObject;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: "decline" };
        break;
      case "item/permissions/requestApproval":
        result = { permissions: {}, scope: "turn", strictAutoReview: true };
        break;
      default:
        void this.#write({ id, error: { code: -32601, message: "Unsupported server request" } })
          .catch(() => this.#fail("RUNTIME_WRITE_ERROR"));
        this.#fail("UNSUPPORTED_SERVER_REQUEST");
        return;
    }
    void this.#write({ id, result }).catch(() => this.#fail("RUNTIME_WRITE_ERROR"));
  }

  #handleToolCall(id: JsonRpcId, params: unknown): void {
    if (this.#closing || this.#closed || this.#seenToolRpcIds.has(id)) return;
    if (this.#seenToolRpcIds.size >= 256) { this.#fail("TOOL_CALLBACK_LIMIT"); return; }
    this.#seenToolRpcIds.add(id);
    const failure: ToolCallResult = { success: false, contentItems: [{ type: "inputText", text: "TOOL_CALL_REJECTED" }] };
    if (this.#toolCalls.size >= 2) {
      void this.#write({ id, result: failure }).catch(() => this.#fail("RUNTIME_WRITE_ERROR"));
      return;
    }
    const controller = new AbortController();
    this.#toolCalls.set(id, { controller, params });
    const active = () => !controller.signal.aborted && !this.#closing && !this.#closed;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<ToolCallResult>((resolve) => {
      onAbort = () => resolve(failure);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => controller.abort(), this.#toolTimeoutMs);
    });
    // Both handlers remain attached after cancellation, collecting late rejection.
    const handled = Promise.resolve().then(() => {
      if (!active()) return failure;
      return this.#toolHandler!(params, { signal: controller.signal, isActive: active });
    }).then((result) => active() ? result : failure, () => failure);
    void Promise.race([handled, aborted]).then(async (result) => {
      if (!this.#closing && !this.#closed) await this.#write({ id, result: active() ? result : failure });
    }).catch(() => this.#fail("RUNTIME_WRITE_ERROR")).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      controller.abort();
      this.#toolCalls.delete(id);
    });
  }

  #cancelToolCalls(): void {
    for (const call of this.#toolCalls.values()) call.controller.abort();
  }

  #emitEvent(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  #fail(code: string): void {
    if (this.#fatalError !== undefined || this.#closing) {
      return;
    }
    this.#cancelToolCalls();
    this.#fatalError = new RuntimeTransportError(code);
    this.#emitEvent({ kind: "transport/error", status: code });
    this.#rejectPending(this.#fatalError);
    this.#closing = true;
    this.#child.stdin.end();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return true;
    }
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function summarizeNotification(method: string, params: unknown): RuntimeEvent {
  const object = isObject(params) ? params : {};
  const turn = isObject(object.turn) ? object.turn : {};
  const item = isObject(object.item) ? object.item : {};
  const knownMethods = new Set([
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "error",
  ]);
  const event: {
    kind: string;
    threadId?: string;
    turnId?: string;
    status?: string;
    textHash?: string;
    phase?: "commentary" | "final_answer";
  } = { kind: knownMethods.has(method) ? method : "other" };
  if (typeof object.threadId === "string") {
    event.threadId = object.threadId;
  }
  const turnId = typeof object.turnId === "string" ? object.turnId : turn.id;
  if (typeof turnId === "string") {
    event.turnId = turnId;
  }
  if (typeof turn.status === "string") {
    event.status = turn.status;
  }
  if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string") {
    if (item.phase === "commentary" || item.phase === "final_answer") event.phase = item.phase;
    event.textHash = createHash("sha256").update(item.text).digest("hex");
  }
  return event;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
