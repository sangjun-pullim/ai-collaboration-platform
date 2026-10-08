import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ProbeError, object, type Refusal } from "./owned-probe-store.js";

export interface Launch { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }
export interface TransportOptions {
  requestMs?: number;
  probeMs?: number;
  lineBytes?: number;
  pendingLimit?: number;
  // Constructor-only timing/failure seams; never exposed as CLI flags.
  closeMs?: readonly [number, number, number];
}
interface Pending { resolve: (value: unknown) => void; reject: (error: ProbeError) => void; timer: NodeJS.Timeout }
export type MessageHandler = (message: Record<string, unknown>, signal: AbortSignal) => Promise<void>;
export interface Cleanup { reaped: boolean; code: "REAPED" | "CLEANUP_INCOMPLETE" }

/** Direct stock CLI transport. No SDK wrapper or shell is involved. */
export class NativeTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, Pending>();
  readonly #incomingControls = new Set<string>();
  readonly #expectedReplays = new Map<string, Record<string, unknown>>();
  readonly #responseReplayEnabled: boolean;
  #replayedResponses = 0;
  readonly #jobs = new Set<Promise<void>>();
  readonly #abort = new AbortController();
  readonly #options: Required<TransportOptions>;
  readonly #exited: Promise<void>;
  #resolveExit!: () => void;
  #exit = false;
  #closed = false;
  #failure: ProbeError | undefined;
  #buffer = Buffer.alloc(0);
  #stderrBytes = 0;
  #handler: MessageHandler = async () => {};
  #failureHandler: (error: ProbeError) => void = () => {};
  #shutdown: Promise<Cleanup> | undefined;
  readonly #deadline: NodeJS.Timeout;

  constructor(launch: Launch, private readonly check: () => void, options: TransportOptions = {}) {
    this.#options = {
      requestMs: Math.min(options.requestMs ?? 10000, 10000), probeMs: Math.min(options.probeMs ?? 60000, 60000),
      lineBytes: Math.min(options.lineBytes ?? 1024 * 1024, 1024 * 1024), pendingLimit: Math.min(options.pendingLimit ?? 32, 32),
      closeMs: [Math.min(options.closeMs?.[0] ?? 250, 250), Math.min(options.closeMs?.[1] ?? 1000, 1000),
        Math.min(options.closeMs?.[2] ?? 1000, 1000)],
    };
    if (Object.values(this.#options).some((v) => typeof v === "number" && (!Number.isSafeInteger(v) || v < 1)) ||
        this.#options.closeMs.some((v) => !Number.isSafeInteger(v) || v < 1)) {
      throw new ProbeError("INVALID_ARGUMENT");
    }
    check();
    this.#responseReplayEnabled = launch.args.includes("--replay-user-messages");
    this.#child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd, env: launch.env, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
    this.#exited = new Promise((resolve) => { this.#resolveExit = resolve; });
    this.#child.stdout.on("data", (bytes: Buffer) => this.consume(bytes));
    this.#child.stderr.on("data", (bytes: Buffer) => {
      this.#stderrBytes += bytes.length;
      if (this.#stderrBytes > this.#options.lineBytes) this.fail("PROTOCOL_LIMIT");
    });
    this.#child.stdin.on("error", () => this.fail("TRANSPORT_CLOSED"));
    this.#child.on("error", () => {
      this.fail("TRANSPORT_CLOSED");
      if (this.#child.pid === undefined) this.markExited();
    });
    this.#child.on("close", () => {
      this.markExited();
      if (!this.#closed) this.fail(this.#buffer.length ? "PROTOCOL_REJECTED" : "TRANSPORT_CLOSED");
    });
    this.#deadline = setTimeout(() => this.fail("PROTOCOL_TIMEOUT"), this.#options.probeMs);
  }

  get signal(): AbortSignal { return this.#abort.signal; }
  get reaped(): boolean { return this.#exit; }
  get pendingCount(): number { return this.#pending.size; }
  get replayedResponseCount(): number { return this.#replayedResponses; }
  async settleMessages(): Promise<void> {
    await Promise.all([...this.#jobs]);
    this.assertLive();
  }
  setHandler(handler: MessageHandler, failure: (error: ProbeError) => void): void {
    this.#handler = handler;
    this.#failureHandler = failure;
    if (this.#failure) failure(this.#failure);
  }

  assertLive(): void {
    if (this.#closed) throw this.#failure ?? new ProbeError("TRANSPORT_CLOSED");
    this.check();
  }

  private markExited(): void { this.#exit = true; this.#resolveExit(); }

  private consume(bytes: Buffer): void {
    if (this.#closed) return;
    try {
      this.assertLive();
      this.#buffer = Buffer.concat([this.#buffer, bytes]);
      let index: number;
      while ((index = this.#buffer.indexOf(10)) >= 0) {
        if (index > this.#options.lineBytes) throw new ProbeError("PROTOCOL_LIMIT");
        const line = this.#buffer.subarray(0, index);
        this.#buffer = this.#buffer.subarray(index + 1);
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(line);
        const frame = object(JSON.parse(decoded));
        this.assertLive();
        if (frame.type === "control_response") this.response(frame);
        else {
          if (this.#responseReplayEnabled && frame.type === "control_request") {
            if (typeof frame.request_id !== "string" || this.#pending.has(frame.request_id) ||
                this.#incomingControls.has(frame.request_id) || this.#expectedReplays.has(frame.request_id)) {
              throw new ProbeError("PROTOCOL_REJECTED");
            }
            if (this.#incomingControls.size + this.#expectedReplays.size >= this.#options.pendingLimit) {
              throw new ProbeError("PROTOCOL_LIMIT");
            }
            this.#incomingControls.add(frame.request_id);
          }
          if (this.#jobs.size >= 32) throw new ProbeError("PROTOCOL_LIMIT");
          const job = Promise.resolve().then(async () => {
            this.assertLive();
            await this.#handler(frame, this.signal);
            this.assertLive();
          }).catch((error: unknown) => {
            if (!this.#closed) this.fail(error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED");
          });
          this.#jobs.add(job);
          void job.finally(() => this.#jobs.delete(job));
        }
      }
      if (this.#buffer.length > this.#options.lineBytes) throw new ProbeError("PROTOCOL_LIMIT");
    } catch (error) { this.fail(error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED"); }
  }

  private response(frame: Record<string, unknown>): void {
    const response = object(frame.response);
    if (typeof response.request_id !== "string") throw new ProbeError("PROTOCOL_REJECTED");
    const pending = this.#pending.get(response.request_id);
    if (!pending) {
      // The stock CLI replays host answers with --replay-user-messages.
      // Ignore only a single exact answer to a request observed from this child.
      const sent = this.#expectedReplays.get(response.request_id);
      if (!this.#responseReplayEnabled || !sent || !isDeepStrictEqual(sent, frame)) {
        throw new ProbeError("PROTOCOL_REJECTED");
      }
      this.#expectedReplays.delete(response.request_id);
      this.#replayedResponses++;
      return;
    }
    // Keep the request rejectable by fail() until its response discriminator is valid.
    if (response.subtype !== "success" && response.subtype !== "error") throw new ProbeError("PROTOCOL_REJECTED");
    this.#pending.delete(response.request_id);
    clearTimeout(pending.timer);
    if (response.subtype === "success") pending.resolve(response.response);
    else pending.reject(new ProbeError("PROTOCOL_REJECTED"));
  }

  async write(frame: unknown): Promise<void> {
    this.assertLive();
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > this.#options.lineBytes) {
      this.fail("PROTOCOL_LIMIT");
      throw new ProbeError("PROTOCOL_LIMIT");
    }
    if (this.#responseReplayEnabled && typeof frame === "object" && frame !== null &&
        !Array.isArray(frame) && "type" in frame && frame.type === "control_response") {
      const sent = object(JSON.parse(line));
      const response = object(sent.response);
      if (typeof response.request_id !== "string" || !this.#incomingControls.has(response.request_id) ||
          (response.subtype !== "success" && response.subtype !== "error")) {
        throw new ProbeError("PROTOCOL_REJECTED");
      }
      this.#incomingControls.delete(response.request_id);
      // Copy the wire value so later caller mutation cannot change the replay check.
      this.#expectedReplays.set(response.request_id, sent);
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(this.#failure ?? new ProbeError("TRANSPORT_CLOSED")); };
      const cleanup = () => this.signal.removeEventListener("abort", onAbort);
      this.signal.addEventListener("abort", onAbort, { once: true });
      this.#child.stdin.write(line, (error) => {
        cleanup();
        if (error) reject(new ProbeError("TRANSPORT_CLOSED")); else resolve();
      });
    });
    this.assertLive();
  }

  async request(request: Record<string, unknown>): Promise<unknown> {
    this.assertLive();
    if (this.#pending.size >= this.#options.pendingLimit) {
      this.fail("PROTOCOL_LIMIT");
      throw new ProbeError("PROTOCOL_LIMIT");
    }
    const id = randomUUID();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => this.fail("PROTOCOL_TIMEOUT"), this.#options.requestMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    // Observe rejection even if write fails before request() begins awaiting the response.
    void result.catch(() => {});
    try {
      await this.write({ type: "control_request", request_id: id, request });
      this.assertLive();
      const value = await result;
      this.assertLive();
      return value;
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) { clearTimeout(pending.timer); this.#pending.delete(id); pending.reject(new ProbeError("TRANSPORT_CLOSED")); }
      throw error;
    }
  }

  async reply(requestId: string, response: Record<string, unknown>): Promise<void> {
    await this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    this.assertLive();
  }

  fail(code: Refusal): void {
    if (this.#closed) return;
    this.#failure = new ProbeError(code);
    this.seal();
    try { this.#failureHandler(this.#failure); } catch { /* The transport still owns cleanup. */ }
    void this.close();
  }

  private seal(): void {
    this.#closed = true;
    clearTimeout(this.#deadline);
    this.#abort.abort();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#failure ?? new ProbeError("TRANSPORT_CLOSED"));
    }
    this.#pending.clear();
    this.#incomingControls.clear();
    this.#expectedReplays.clear();
  }

  close(): Promise<Cleanup> {
    if (!this.#shutdown) {
      this.seal();
      this.#shutdown = this.cleanup();
    }
    return this.#shutdown;
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.#exit) return true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    if (timer) clearTimeout(timer);
    return this.#exit;
  }

  private async cleanup(): Promise<Cleanup> {
    const [grace, term, kill] = this.#options.closeMs;
    this.#child.stdin.end();
    if (!await this.waitExit(grace)) {
      try { this.#child.kill("SIGTERM"); } catch { /* Continue bounded reap; never report a signal as exit. */ }
      if (!await this.waitExit(term)) {
        try { this.#child.kill("SIGKILL"); } catch { /* Cleanup status remains independent of input status. */ }
        await this.waitExit(kill);
      }
    }
    // Abort-aware handlers finish before caller can release its session lock.
    let drained = this.#jobs.size === 0;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.#jobs]).then(() => { drained = true; }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 1000); }),
    ]);
    if (timer) clearTimeout(timer);
    return { reaped: this.#exit, code: this.#exit && drained ? "REAPED" : "CLEANUP_INCOMPLETE" };
  }
}
