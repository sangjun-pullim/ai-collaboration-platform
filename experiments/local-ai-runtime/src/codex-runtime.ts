import { realpath } from "node:fs/promises";
import {
  ExperimentPolicyError,
  assertResumeAllowed,
  startAttempt,
  transitionManifest,
  type ExperimentManifest,
  type ManifestRepository,
  type RunState,
} from "./experiment-policy.js";
import {
  StdioClient,
  type RuntimeClient,
  type RuntimeEvent,
} from "./stdio-client.js";

const DEFAULT_TURN_DEADLINE_MS = 120_000;
const MAX_TURN_DEADLINE_MS = 600_000;
const DEFAULT_TERMINAL_WAIT_MS = 10_000;

export interface RuntimeExecutionOptions {
  readonly model: string;
  readonly prompt: string;
  readonly deadlineMs?: number;
  readonly terminalWaitMs?: number;
  readonly interruptAfterMs?: number;
}

export interface PublicRuntimeResult {
  readonly cliVersion: "0.1.0";
  readonly protocolVersion: "app-server-v2";
  readonly connectionLevel: "initialized" | "new-thread" | "resumed-thread";
  readonly state: RunState;
  readonly transitions: readonly RunState[];
  readonly eventKinds: readonly string[];
  readonly success: boolean;
  readonly contextMarkerMatched?: boolean;
  readonly interruptAcknowledgement?: "received" | "failed" | "unconfirmed";
  readonly unverified: readonly string[];
}

export type RuntimeClientFactory = (cwd: string) => RuntimeClient;

export class CodexRuntime {
  readonly #activeClients = new Set<RuntimeClient>();
  readonly #cancellation = new AbortController();

  public constructor(
    private readonly clientFactory: RuntimeClientFactory = (cwd) => StdioClient.launchCodex({ cwd }),
  ) {}

  public async probe(cwd: string): Promise<PublicRuntimeResult> {
    this.assertAdmission();
    const canonicalRoot = await this.prepare(realpath(cwd));
    this.assertAdmission();
    const client = this.clientFactory(canonicalRoot);
    this.#activeClients.add(client);
    try {
      await this.prepare(client.initialize());
      return {
        cliVersion: "0.1.0",
        protocolVersion: "app-server-v2",
        connectionLevel: "initialized",
        state: "READY",
        transitions: ["READY"],
        eventKinds: [],
        success: true,
        unverified: ["model-call", "turn-terminal", "provider-permissions"],
      };
    } finally {
      await client.close();
      this.#activeClients.delete(client);
    }
  }

  public async shutdown(): Promise<void> {
    this.#cancellation.abort();
    const results = await Promise.allSettled([...this.#activeClients].map(async (client) => await client.close()));
    if (results.some((result) => result.status === "rejected")) {
      throw new ExperimentPolicyError("RUNTIME_CLEANUP_FAILED");
    }
  }

  public assertAdmission(): void {
    if (this.#cancellation.signal.aborted) throw new ExperimentPolicyError("RUNTIME_SHUTDOWN");
  }

  public async prepare<T>(promise: Promise<T>): Promise<T> {
    // The rejection handler is attached even when cancellation has already happened.
    const value = await awaitPreparation(promise, this.#cancellation.signal);
    this.assertAdmission();
    return value;
  }

  public async runNew(
    repository: ManifestRepository,
    options: RuntimeExecutionOptions,
  ): Promise<PublicRuntimeResult> {
    this.assertAdmission();
    return await this.#withAdmissionLock(repository, async (manifest) => {
      this.assertAdmission();
      if (manifest.state !== "READY") {
        throw new ExperimentPolicyError("RUN_NOT_ALLOWED");
      }
      return await this.#execute(repository, manifest, "run", options);
    });
  }

  public async resume(
    repository: ManifestRepository,
    options: RuntimeExecutionOptions,
  ): Promise<PublicRuntimeResult> {
    this.assertAdmission();
    return await this.#withAdmissionLock(repository, async (manifest) => {
      this.assertAdmission();
      const canonicalRoot = await this.prepare(realpath(manifest.root));
      assertResumeAllowed(manifest, canonicalRoot);
      return await this.#execute(repository, manifest, "resume", options);
    });
  }

  async #withAdmissionLock<T>(
    repository: ManifestRepository,
    operation: (manifest: ExperimentManifest) => Promise<T>,
  ): Promise<T> {
    this.assertAdmission();
    return await new Promise<T>((resolve, reject) => {
      let admitted = false;
      const onAbort = () => {
        if (!admitted) {
          this.#cancellation.signal.removeEventListener("abort", onAbort);
          reject(new ExperimentPolicyError("RUNTIME_SHUTDOWN"));
        }
      };
      this.#cancellation.signal.addEventListener("abort", onAbort, { once: true });
      // Cancellation races only lock preparation. Once admitted, await journaling and cleanup.
      const held = Promise.resolve().then(async () => {
        this.assertAdmission();
        return await repository.withLock(async (manifest) => {
          this.assertAdmission();
          admitted = true;
          this.#cancellation.signal.removeEventListener("abort", onAbort);
          return await operation(manifest);
        });
      });
      void held.then(
        (value) => { this.#cancellation.signal.removeEventListener("abort", onAbort); resolve(value); },
        (error: unknown) => { this.#cancellation.signal.removeEventListener("abort", onAbort); reject(error); },
      );
    });
  }

  async #execute(
    repository: ManifestRepository,
    initialManifest: ExperimentManifest,
    operation: "run" | "resume",
    options: RuntimeExecutionOptions,
  ): Promise<PublicRuntimeResult> {
    const deadlineMs = boundedDeadline(options.deadlineMs);
    const terminalWaitMs = Math.min(options.terminalWaitMs ?? DEFAULT_TERMINAL_WAIT_MS, DEFAULT_TERMINAL_WAIT_MS);
    this.assertAdmission();
    const client = this.clientFactory(initialManifest.root);
    this.#activeClients.add(client);
    let manifest = initialManifest;
    let turnCallStarted = false;
    let intentRecorded = false;
    const observedEvents: RuntimeEvent[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = client.onEvent((event) => {
      observedEvents.push(event);
      wake?.();
      wake = undefined;
    });
    const onShutdown = () => { wake?.(); wake = undefined; };
    this.#cancellation.signal.addEventListener("abort", onShutdown);
    const persistOutcome = async () => {
      await repository.save(manifest);
      await client.close();
      // A matching terminal can arrive while UNKNOWN is being written or stdin is closing.
      const terminal = manifest.state === "UNKNOWN" && manifest.threadLocator !== undefined && manifest.turnLocator !== undefined
        ? findTerminal(observedEvents, manifest.threadLocator, manifest.turnLocator) : undefined;
      if (terminal !== undefined) {
        manifest = terminalManifest(manifest, terminal, observedEvents, operation);
        await repository.save(manifest);
      }
    };

    try {
      await this.prepare(client.initialize());
      this.assertAdmission();
      const threadLocator =
        operation === "run"
          ? await this.#startThread(client, initialManifest.root, options.model)
          : await this.#resumeThread(client, initialManifest, options.model);

      if (operation === "run") {
        manifest = {
          ...manifest,
          threadLocator,
          verifiedAt: new Date().toISOString(),
        };
        await repository.save(manifest);
        this.assertAdmission();
      }

      const deadlineAt = new Date(Date.now() + deadlineMs);
      manifest = startAttempt(manifest, operation, deadlineAt);
      this.assertAdmission();
      await repository.save(manifest);
      intentRecorded = true;
      this.assertAdmission();

      turnCallStarted = true;
      const turnResponsePromise = client.request("turn/start", {
        threadId: threadLocator,
        input: [{ type: "text", text: options.prompt, text_elements: [] }],
        cwd: initialManifest.root,
        model: options.model,
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });

      const turnResponse = await raceUntil(turnResponsePromise, deadlineAt.getTime(), this.#cancellation.signal);
      if (turnResponse.timedOut) {
        manifest = transitionManifest(manifest, "UNKNOWN", {
          eventKinds: eventKinds(observedEvents),
        });
        await persistOutcome();
        return publicResult(manifest, operation);
      }

      const turnLocator = extractTurnLocator(turnResponse.value);
      if (turnLocator === undefined) {
        manifest = transitionManifest(manifest, "UNKNOWN", {
          eventKinds: eventKinds(observedEvents),
        });
        await persistOutcome();
        return publicResult(manifest, operation);
      }

      manifest = transitionManifest(manifest, "RUNNING", {
        turnLocator,
        eventKinds: eventKinds(observedEvents),
      });
      await repository.save(manifest);

      let interruptSent = false;
      let interruptTerminalDeadline: number | undefined;
      let acknowledgement: "received" | "failed" | "unconfirmed" = "unconfirmed";
      const result = () => ({
        ...publicResult(manifest, operation),
        ...(interruptSent ? { interruptAcknowledgement: acknowledgement } : {}),
      });
      const interruptAt =
        options.interruptAfterMs === undefined
          ? Number.POSITIVE_INFINITY
          : Date.now() + Math.max(0, options.interruptAfterMs);

      while (true) {
        const terminal = findTerminal(observedEvents, threadLocator, turnLocator);
        if (terminal !== undefined) {
          manifest = terminalManifest(manifest, terminal, observedEvents, operation);
          await persistOutcome();
          return result();
        }
        if (this.#cancellation.signal.aborted || observedEvents.some((event) => event.kind === "transport/error")) {
          manifest = transitionManifest(manifest, "UNKNOWN", {
            eventKinds: eventKinds(observedEvents),
          });
          await persistOutcome();
          return result();
        }

        const now = Date.now();
        if (!interruptSent && (now >= interruptAt || now >= deadlineAt.getTime())) {
          interruptSent = true;
          interruptTerminalDeadline = now + terminalWaitMs;
          manifest = transitionManifest(manifest, "INTERRUPT_REQUESTED", {
            eventKinds: eventKinds(observedEvents),
          });
          await repository.save(manifest);
          this.assertAdmission();
          // ACK is observed independently; it never supplies or overwrites terminal evidence.
          void client.request("turn/interrupt", { threadId: threadLocator, turnId: turnLocator }).then(
            () => { acknowledgement = "received"; wake?.(); wake = undefined; },
            () => { acknowledgement = "failed"; wake?.(); wake = undefined; },
          );
          continue;
        }

        if (interruptTerminalDeadline !== undefined && Date.now() >= interruptTerminalDeadline) {
          manifest = transitionManifest(manifest, "UNKNOWN", {
            eventKinds: eventKinds(observedEvents),
          });
          await persistOutcome();
          return result();
        }

        const nextDeadline = Math.min(
          interruptSent ? Number.POSITIVE_INFINITY : deadlineAt.getTime(),
          interruptSent ? Number.POSITIVE_INFINITY : interruptAt,
          interruptTerminalDeadline ?? Number.POSITIVE_INFINITY,
        );
        await waitForEvent(() => {
          wake = undefined;
        }, (resolver) => {
          wake = resolver;
        }, nextDeadline);
      }
    } catch (error) {
      if (turnCallStarted || intentRecorded) {
        const terminal = manifest.threadLocator !== undefined && manifest.turnLocator !== undefined
          ? findTerminal(observedEvents, manifest.threadLocator, manifest.turnLocator) : undefined;
        if (terminal !== undefined) {
          manifest = terminalManifest(manifest, terminal, observedEvents, operation);
          await persistOutcome();
          return publicResult(manifest, operation);
        }
        manifest = transitionManifest(manifest, "UNKNOWN", { eventKinds: eventKinds(observedEvents) });
        await persistOutcome();
        if (manifest.state !== "UNKNOWN") return publicResult(manifest, operation);
      }
      throw error;
    } finally {
      unsubscribe();
      this.#cancellation.signal.removeEventListener("abort", onShutdown);
      await client.close();
      this.#activeClients.delete(client);
    }
  }

  async #startThread(client: RuntimeClient, cwd: string, model: string): Promise<string> {
    this.assertAdmission();
    const response = await this.prepare(client.request("thread/start", {
      cwd,
      model,
      approvalPolicy: "never",
      sandbox: "read-only",
    }));
    const locator = extractThreadLocator(response);
    if (locator === undefined) {
      throw new Error("THREAD_START_FAILED");
    }
    return locator;
  }

  async #resumeThread(
    client: RuntimeClient,
    manifest: ExperimentManifest,
    model: string,
  ): Promise<string> {
    if (manifest.threadLocator === undefined) {
      throw new ExperimentPolicyError("RESUME_NOT_ALLOWED");
    }
    this.assertAdmission();
    const response = await this.prepare(client.request("thread/resume", {
      threadId: manifest.threadLocator,
      cwd: manifest.root,
      model,
      approvalPolicy: "never",
      sandbox: "read-only",
    }));
    const locator = extractThreadLocator(response);
    if (locator !== manifest.threadLocator) {
      throw new ExperimentPolicyError("RESUME_THREAD_MISMATCH");
    }
    return locator;
  }
}

function boundedDeadline(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TURN_DEADLINE_MS;
  }
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TURN_DEADLINE_MS) {
    throw new ExperimentPolicyError("INVALID_DEADLINE");
  }
  return value;
}

function extractThreadLocator(value: unknown): string | undefined {
  const response = asRecord(value);
  const thread = asRecord(response.thread);
  return typeof thread.id === "string" ? thread.id : undefined;
}

function extractTurnLocator(value: unknown): string | undefined {
  const response = asRecord(value);
  const turn = asRecord(response.turn);
  return typeof turn.id === "string" ? turn.id : undefined;
}

function findTerminal(
  events: readonly RuntimeEvent[],
  threadLocator: string,
  turnLocator: string,
): RuntimeEvent | undefined {
  return events.find(
    (event) =>
      event.kind === "turn/completed" &&
      event.threadId === threadLocator &&
      event.turnId === turnLocator &&
      (event.status === "completed" || event.status === "failed" || event.status === "interrupted"),
  );
}

function terminalManifest(
  manifest: ExperimentManifest,
  event: RuntimeEvent,
  events: readonly RuntimeEvent[],
  operation: "run" | "resume",
): ExperimentManifest {
  const states: Record<string, RunState> = {
    completed: "COMPLETED",
    failed: "FAILED",
    interrupted: "INTERRUPTED",
  };
  const state = states[event.status ?? ""];
  if (state === undefined) {
    return transitionManifest(manifest, "UNKNOWN", { eventKinds: eventKinds(events) });
  }
  const markerMatched =
    operation === "resume" && manifest.contextMarkerHash !== undefined
      ? events.some(
          (candidate) =>
            candidate.threadId === manifest.threadLocator &&
            candidate.turnId === manifest.turnLocator &&
            candidate.textHash === manifest.contextMarkerHash,
        )
      : manifest.contextMarkerMatched;
  return transitionManifest(manifest, state, {
    eventKinds: eventKinds(events),
    contextMarkerMatched: markerMatched,
  });
}

function eventKinds(events: readonly RuntimeEvent[]): readonly string[] {
  return [...new Set(events.map((event) => event.kind))];
}

function publicResult(manifest: ExperimentManifest, operation: "run" | "resume"): PublicRuntimeResult {
  const result: PublicRuntimeResult = {
    cliVersion: "0.1.0",
    protocolVersion: "app-server-v2",
    connectionLevel: operation === "run" ? "new-thread" : "resumed-thread",
    state: manifest.state,
    transitions: manifest.transitions,
    eventKinds: manifest.eventKinds,
    success: manifest.state === "COMPLETED",
    unverified: ["read-scope-outside-root", "external-tools", "provider-account-eligibility"],
    ...(operation === "resume" ? { contextMarkerMatched: manifest.contextMarkerMatched ?? false } : {}),
  };
  return result;
}

async function raceUntil<T>(
  promise: Promise<T>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<{ readonly timedOut: false; readonly value: T } | { readonly timedOut: true }> {
  const remaining = Math.max(0, deadlineAt - Date.now());
  let timer: NodeJS.Timeout | undefined;
  try {
    return await awaitPreparation(Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ readonly timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), remaining);
      }),
    ]), signal);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function awaitPreparation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new ExperimentPolicyError("RUNTIME_SHUTDOWN"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

async function waitForEvent(
  clear: () => void,
  register: (resolver: () => void) => void,
  deadlineAt: number,
): Promise<void> {
  const remaining = Math.max(0, deadlineAt - Date.now());
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      clear();
      resolve();
    }, remaining);
    register(() => {
      clearTimeout(timer);
      clear();
      resolve();
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
