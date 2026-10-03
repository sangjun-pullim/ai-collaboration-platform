import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowFixture, type WorkflowScene } from "./workflow-fixture.js";
import { ensure } from "./local-access-stack.js";
import type { DeviceProfile } from "./device-binding-fixture.js";
import { Connector } from "../../packages/local-connector/src/cli.ts";
import { CentralClient } from "../../packages/local-connector/src/central-client.ts";
import { WorkflowClient } from "../../packages/local-connector/src/workflow-client.ts";
import { StateStore } from "../../packages/local-connector/src/state-store.ts";
import { RuntimeStore } from "../../packages/local-connector/src/runtime-store.ts";
import {
  WorkflowRunner,
  type RunnerOptions,
} from "../../packages/local-connector/src/workflow-runner.ts";
import {
  RuntimeError,
  digest,
  scopedNamespace,
  type AttemptAuthority,
  type Capabilities,
  type OwnedContext,
  type RootIdentity,
  type RuntimeAdapter,
  type RuntimeSettings,
  type SettingsObservation,
  type TerminalEvidence,
} from "../../packages/local-connector/src/runtime-contracts.ts";
import { RuntimeFilePolicy } from "../../packages/local-connector/src/runtime-file-policy.ts";
import type {
  Body,
  DeviceAction,
  RequestPayload,
} from "../../packages/local-connector/src/workflow-contracts.ts";
import type { PublicBinding } from "../../packages/local-connector/src/contracts.ts";

const capability: Capabilities = {
  version: "0.159.1",
  models: [
    {
      id: "owned-synthetic",
      model: "owned-synthetic",
      efforts: ["low", "high"],
      defaultEffort: "low",
      isDefault: true,
    },
  ],
  defaultSettings: { model: "owned-synthetic", effort: "low" },
  snapshotHash: digest("owned-synthetic-v1"),
  policy: "CONFIRMED",
};
function observed(settings: RuntimeSettings): SettingsObservation {
  return {
    requested: settings.requested,
    thread: {
      model: settings.requested.model,
      provider: "openai",
      effort: settings.requested.effort,
    },
    turn: {
      requestedModel: settings.requested.model,
      requestedEffort: settings.requested.effort,
      model: settings.requested.model,
      rerouted: false,
      effortVerification: "UNVERIFIED",
    },
  };
}
export function runtimeGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export class OwnedFakeAdapter implements RuntimeAdapter {
  starts = 0;
  preparations = 0;
  resumes = 0;
  interrupts = 0;
  question = false;
  crash: "before-ack" | "after-ack" | null = null;
  hold: ReturnType<typeof runtimeGate> | null = null;
  entered = runtimeGate();
  terminal: TerminalEvidence | null = null;
  afterAck?: (authority: AttemptAuthority, turnId: string) => Promise<void>;
  private current: {
    authority: AttemptAuthority;
    interrupted: ReturnType<typeof runtimeGate>;
  } | null = null;
  async capabilities(_root: string, check: () => void) {
    check();
    return structuredClone(capability);
  }
  async prepare(
    root: RootIdentity,
    _settings: RuntimeSettings,
    generation: string,
    epoch: number,
    check: () => void,
    onCreated: (context: OwnedContext) => Promise<void> = async () => {},
  ): Promise<OwnedContext> {
    check();
    this.preparations++;
    const context: OwnedContext = {
      ownership: "CONNECTOR_CREATED",
      generation,
      threadId: randomUUID(),
      root,
      epoch,
      level: "L1",
      ownedTurns: [],
    };
    await onCreated(context);
    check();
    return context;
  }
  async validate(context: OwnedContext, settings: RuntimeSettings, check: () => void) {
    check();
    ensure(context.ownership === "CONNECTOR_CREATED", "Unowned synthetic context");
    await new RuntimeFilePolicy(context.root, settings.files).assertUnchanged(check);
    check();
    if (context.ownedTurns.length) this.resumes++;
    return observed(settings);
  }
  async execute(
    authority: AttemptAuthority,
    settings: RuntimeSettings,
    payload: RequestPayload,
    beforeSubmit: () => Promise<void>,
  ) {
    await this.validate(authority.context, settings, () => authority.assertLive());
    await beforeSubmit();
    authority.assertLive();
    this.starts++;
    if (this.crash === "before-ack") throw new RuntimeError("UNKNOWN");
    const turnId = randomUUID(),
      interrupted = runtimeGate();
    const active = { authority, interrupted };
    this.current = active;
    try {
      await authority.ack(authority.context.threadId, turnId);
      authority.assertLive();
      this.entered.release();
      if (this.crash === "after-ack") throw new RuntimeError("UNKNOWN");
      await this.afterAck?.(authority, turnId);
      authority.assertLive();
      const read = await authority.tool({
        namespace: scopedNamespace,
        tool: "read_workspace_file",
        callId: randomUUID(),
        threadId: authority.context.threadId,
        turnId,
        arguments: { path: "public-context.txt" },
      });
      authority.assertLive();
      ensure(read.success, "Owned public read failed");
      if (this.question && payload.requestKind === "ORIGIN") {
        const call = {
          namespace: scopedNamespace,
          tool: "ask_peer",
          callId: randomUUID(),
          threadId: authority.context.threadId,
          turnId,
          arguments: {
            question: "선택한 공개 파일의 근거를 확인해 주세요.",
            evidence: [{ path: "public-context.txt", startLine: 1, endLine: 1 }],
          },
        };
        const receipt = await authority.tool(call);
        authority.assertLive();
        ensure(
          receipt.contentItems[0]?.text === "accepted/pending",
          "Owned question receipt failed",
        );
        const duplicate = await authority.tool(call);
        authority.assertLive();
        ensure(
          JSON.stringify(receipt) === JSON.stringify(duplicate),
          "Owned question replay changed",
        );
      }
      let stopped = false;
      if (this.hold)
        stopped = await Promise.race([
          this.hold.promise.then(() => false),
          interrupted.promise.then(() => true),
        ]);
      authority.assertLive();
      const privateText = stopped
        ? ""
        : `합성 공개 ${payload.requestKind} 결과: ${read.contentItems[0].text.trim()}`;
      const evidence: TerminalEvidence = {
        threadId: authority.context.threadId,
        turnId,
        terminal: stopped ? "INTERRUPTED" : "COMPLETED",
        privateText,
        publicText: "",
        finalItems: privateText ? [{ id: randomUUID(), hash: digest(privateText) }] : [],
        textProof: privateText ? "FINAL_ANSWER" : "UNCONFIRMED",
        observation: observed(settings),
      };
      this.terminal = evidence;
      return evidence;
    } finally {
      this.current = null;
    }
  }
  async interrupt(authority: AttemptAuthority) {
    if (this.current?.authority !== authority) return false;
    this.interrupts++;
    this.current.interrupted.release();
    return true;
  }
  async observe(
    context: OwnedContext,
    _settings: RuntimeSettings,
    native: { threadId: string; turnId: string },
    check: () => void,
  ) {
    check();
    return this.terminal?.threadId === context.threadId && this.terminal.turnId === native.turnId
      ? this.terminal
      : null;
  }
  async close() {
    this.current?.interrupted.release();
  }
}
export type OwnedRuntimeBinding = {
  profile: DeviceProfile;
  state: StateStore;
  runtime: RuntimeStore;
  adapter: OwnedFakeAdapter;
  connector: Connector;
};
const diagnosticCodes = new Set([
  "INVALID_RUNTIME",
  "UNSAFE_STORAGE",
  "RUNTIME_BUSY",
  "POLICY_UNCONFIRMED",
  "UNSUPPORTED_SETTINGS",
  "CONTEXT_UNCONFIRMED",
  "SNAPSHOT_CHANGED",
  "TOOL_REJECTED",
  "PUBLIC_TEXT_REJECTED",
  "AUTHORITY_LOST",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
  "CLEANUP_INCOMPLETE",
  "RUNTIME_CLOSED",
  "INVALID_BODY",
  "BODY_TOO_LARGE",
  "UNSAFE_ORIGIN",
  "FORBIDDEN",
  "UNAUTHENTICATED",
  "NOT_FOUND",
  "CONFLICT",
  "QUOTA",
  "UNAVAILABLE",
  "ERR_ASSERTION",
]);
const diagnosticStates = new Set([
  "UPLOADED",
  "TERMINAL",
  "RUNNING",
  "IDLE",
  "UNKNOWN",
  "NOT_STARTED",
  "LOCAL_NOT_TRANSMITTED",
  "SERVER_ABANDONED",
  "INTERRUPTED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "ABANDONED",
  "LEASED",
  "EXECUTING",
  "CLAIM_PENDING",
  "CLAIMED",
  "SERVER_INTENT_PENDING",
  "SERVER_INTENT_CONFIRMED",
  "PROVIDER_INTENT",
  "ACKNOWLEDGED",
  "PENDING",
  "TRANSMITTED",
  "CONFIRMED",
  "CLOSED",
  "PREPARING",
  "PREPARED",
  "UNPREPARED",
  "ACTIVE",
  "PAUSING",
  "PAUSED",
  "REQUESTED",
  "FINAL_ANSWER",
  "UNCONFIRMED",
  "PROVIDER_PENDING",
  "PROVIDER_CREATED",
  "CANDIDATE",
  "REPLACE_PENDING",
]);
const diagnosticActions = new Set([
  "ready",
  "poll",
  "claim",
  "start-intent",
  "lease",
  "question",
  "complete",
  "interrupt-ack",
  "observe",
]);
const diagnosticMutations = new Set([
  "operation-intent",
  "operation-transmitted",
  "operation-receipt",
  "prepare-intent",
  "prepare-created",
  "prepare-candidate",
  "replace-intent",
  "prepare-finalize",
  "claim-intent",
  "claimed",
  "native-ack",
  "server-intent",
  "server-intent-confirmed",
  "provider-intent",
  "lease",
  "tool-receipt",
  "question-call-intent",
  "question-call-receipt",
  "terminal-evidence",
  "publication-receipt",
  "claim-recovery",
  "intent-recovery",
  "legacy-claim-association",
  "unstarted-closure",
  "unknown",
  "mapping-invalidated",
  "ready",
  "not-ready",
]);
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const diagnosticEnum = (value: unknown, allowed: Set<string>) =>
  value === null || value === undefined
    ? "NONE"
    : typeof value === "string" && allowed.has(value)
      ? value
      : "WITHHELD";
const diagnosticCode = (error: unknown) => {
  const code = record(error).code;
  return typeof code === "string" && diagnosticCodes.has(code) ? code : "UNCONFIRMED";
};
class OwnedRuntimeFailure extends Error {}
function safeFailure(error: unknown, stage: "setup" | "assertion" | "cleanup"): Error {
  if (error instanceof OwnedRuntimeFailure) return error;
  if (error instanceof AggregateError)
    return new AggregateError(
      error.errors.slice(0, 8).map((item) => safeFailure(item, stage)),
      `Owned runtime ${stage} failed; private values withheld`,
    );
  const frames =
    error instanceof Error
      ? error.stack
          ?.split("\n")
          .slice(1)
          .map((line) =>
            line.match(
              /\/(owned-codex-workflow\.test|owned-runtime-fixture|workflow-fixture|device-binding-fixture|local-access-stack|workflow-runner|runtime-store)\.(?:js|ts):(\d+):(\d+)(?:\)|$)/,
            ),
          )
          .filter((frame): frame is RegExpMatchArray => !!frame)
          .slice(0, 2)
      : undefined;
  const code = diagnosticCode(error);
  const states = new Set([
    "UPLOADED",
    "TERMINAL",
    "RUNNING",
    "IDLE",
    "UNKNOWN",
    "INTERRUPTED",
    "COMPLETED",
    "RUNTIME_BUSY",
  ]);
  const value = (input: unknown) =>
    (typeof input === "number" && Number.isSafeInteger(input)) || typeof input === "boolean"
      ? String(input)
      : typeof input === "string" && states.has(input)
        ? input
        : "WITHHELD";
  const assertion =
    code === "ERR_ASSERTION" && error instanceof Error && "actual" in error && "expected" in error
      ? ` actual=${value(error.actual)} expected=${value(error.expected)}`
      : "";
  return new OwnedRuntimeFailure(
    `Owned runtime ${stage} failed code=${code}${assertion}${frames?.length ? ` at ${frames.map((frame) => `${frame[1]}:${frame[2]}:${frame[3]}`).join(" <- ")}` : ""}; private values withheld`,
  );
}
export class OwnedRuntimeFixture {
  readonly bindings = new Map<string, OwnedRuntimeBinding>();
  readonly requests: { action: string; body: Body }[] = [];
  private readonly diagnosticTrace: Record<string, unknown>[] = [];
  private note(
    binding: OwnedRuntimeBinding,
    phase:
      | "FETCH"
      | "RESPONSE"
      | "LOST_RESPONSE"
      | "TRANSPORT_FAILURE"
      | "MUTATION"
      | "RUN_RESULT"
      | "RUN_FAILURE",
    fields: Record<string, unknown>,
  ) {
    const role =
      binding.profile.agentId === this.scene.origin.agentId
        ? "ORIGIN"
        : binding.profile.agentId === this.scene.responder.agentId
          ? "PEER"
          : "WITHHELD";
    // Only callers' fixed enums/counts enter this local trace, never body/header/error text.
    this.diagnosticTrace.push({ role, phase, ...fields });
    if (this.diagnosticTrace.length > 64) this.diagnosticTrace.shift();
  }
  async diagnostics() {
    const bindings: Record<string, unknown>[] = [];
    for (const binding of [...this.bindings.values()].slice(0, 2)) {
      const role =
        binding.profile.agentId === this.scene.origin.agentId
          ? "ORIGIN"
          : binding.profile.agentId === this.scene.responder.agentId
            ? "PEER"
            : "WITHHELD";
      try {
        const saved = await binding.runtime.read(),
          attempts = saved?.attempts ?? [],
          operations = saved?.operations ?? [];
        const counts = new Map<string, number>();
        for (const op of operations) {
          const key = `${diagnosticEnum(op.action, diagnosticActions)}:${diagnosticEnum(op.state, diagnosticStates)}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        bindings.push({
          role,
          ready: saved?.ready === true,
          preparation: diagnosticEnum(saved?.preparation?.state, diagnosticStates),
          attempts: attempts.slice(-4).map((attempt) => ({
            state: diagnosticEnum(attempt.state, diagnosticStates),
            reason: diagnosticEnum(attempt.reason, diagnosticCodes),
            serverState: diagnosticEnum(attempt.snapshot?.state, diagnosticStates),
            terminal: diagnosticEnum(attempt.terminal?.terminal, diagnosticStates),
            textProof: diagnosticEnum(attempt.terminal?.textProof, diagnosticStates),
            nativeAck: !!attempt.native,
            receipt: !!attempt.receipt,
            claimLinked: !!attempt.claimOperationId,
            unstartedProof: diagnosticEnum(attempt.unstartedClosure?.kind, diagnosticStates),
          })),
          operations: [...counts].slice(0, 40).map(([kind, count]) => ({ kind, count })),
        });
      } catch (error) {
        bindings.push({ role, readCode: diagnosticCode(error) });
      }
    }
    return { bindings, trace: [...this.diagnosticTrace] };
  }
  beforeFetch?: (action: string, body: Body, credential: string) => Promise<void>;
  loseResponse?: (action: string, body: Body) => boolean;
  private constructor(
    readonly workflow: WorkflowFixture,
    readonly scene: WorkflowScene,
  ) {}
  static async open(label: string) {
    const workflow = await WorkflowFixture.open(`runtime-${label}`);
    try {
      const fixture = new OwnedRuntimeFixture(workflow, await workflow.scene());
      for (const [index, profile] of [fixture.scene.origin, fixture.scene.responder].entries()) {
        await workflow.poll(profile);
        const state = new StateStore(join(workflow.devices.root, "state"), profile.name),
          root = join(workflow.devices.root, `owned-public-${index}`);
        await mkdir(root, { mode: 0o700 });
        await writeFile(join(root, "public-context.txt"), `합성 선택 근거 ${index + 1}\n`, {
          mode: 0o644,
        });
        await state.transaction(async () => {
          const saved = await state.read();
          ensure(saved && saved.mappings[0].agentId === profile.agentId, "Missing owned binding");
          saved.mappings[0].root = root;
          await state.write(saved);
        });
        const runtime = new RuntimeStore(state.dir, profile.name, profile.agentId!),
          adapter = new OwnedFakeAdapter(),
          connector = new Connector(state, new CentralClient(workflow.stack.config.app));
        const binding = { profile, state, runtime, adapter, connector };
        fixture.bindings.set(profile.agentId!, binding);
        await fixture.runner(binding).prepare({
          choice: { model: "owned-synthetic", effort: index ? "high" : "low" },
          files: ["public-context.txt"],
          handoff: "사용자가 선택한 공개 근거만 조사하세요.",
          confirmed: true,
          autoQuestionsConfirmed: true,
        });
        await workflow.devices.refresh(profile);
      }
      return fixture;
    } catch (error) {
      const failures = [safeFailure(error, "setup")];
      try {
        await workflow.close();
      } catch (cleanup) {
        failures.push(safeFailure(cleanup, "cleanup"));
      }
      throw new AggregateError(failures, "Owned runtime setup failed; private values withheld");
    }
  }
  get origin() {
    return this.bindings.get(this.scene.origin.agentId!)!;
  }
  get peer() {
    return this.bindings.get(this.scene.responder.agentId!)!;
  }
  private capture(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        typeof item === "string" &&
        [
          "cycleId",
          "requestId",
          "attemptId",
          "questionId",
          "controlId",
          "continuationRequestId",
          "peerRequestId",
        ].includes(key)
      ) {
        const field =
          key === "continuationRequestId" || key === "peerRequestId" ? "requestId" : key;
        const set = this.workflow.identities.get(field) ?? new Set<string>();
        set.add(item);
        this.workflow.identities.set(field, set);
      } else if (item && typeof item === "object") this.capture(item);
    }
  }
  runner(binding: OwnedRuntimeBinding, options: RunnerOptions = {}) {
    const fetcher: typeof fetch = async (url, init) => {
      ensure(
        String(url).startsWith(`${this.workflow.stack.config.app}/api/workflow/`) &&
          init?.method === "POST",
        "Unexpected owned workflow transport",
      );
      const action = String(url).split("/").at(-1)! as DeviceAction,
        body = JSON.parse(String(init.body)) as Body;
      ensure(body.agentId === binding.profile.agentId, "Unowned runtime body");
      this.requests.push({ action, body });
      if (body.operationId)
        this.workflow.operations.push({
          roomId: this.scene.scope.roomId,
          actorId: binding.profile.deviceId!,
          action,
          operationId: String(body.operationId),
        });
      await this.workflow.save();
      const credential = new Headers(init.headers).get("Authorization")!.slice(7);
      const safeAction = diagnosticEnum(action, diagnosticActions);
      this.note(binding, "FETCH", { action: safeAction });
      try {
        await this.beforeFetch?.(action, body, credential);
        const response = await fetch(url, init);
        const json = await response
            .clone()
            .json()
            .catch(() => null),
          data = record(record(json).data),
          attempt = record(data.attempt),
          control = record(data.control);
        this.note(binding, "RESPONSE", {
          action: safeAction,
          status: response.status,
          code: diagnosticCode(record(json).error),
          state: diagnosticEnum(data.state, diagnosticStates),
          terminal: diagnosticEnum(data.terminal, diagnosticStates),
          roomMode: diagnosticEnum(data.roomMode, diagnosticStates),
          attempt: diagnosticEnum(attempt.state, diagnosticStates),
          control: diagnosticEnum(control.state, diagnosticStates),
          queued: !!data.queuedRequest,
        });
        if (response.status === 200) {
          this.capture(json);
          await this.workflow.save();
        }
        if (this.loseResponse?.(action, body)) {
          this.note(binding, "LOST_RESPONSE", { action: safeAction });
          return Response.error();
        }
        return response;
      } catch (error) {
        this.note(binding, "TRANSPORT_FAILURE", {
          action: safeAction,
          code: diagnosticCode(error),
        });
        throw error;
      }
    };
    return new WorkflowRunner(
      binding.state,
      binding.runtime,
      new WorkflowClient(this.workflow.stack.config.app, fetcher),
      binding.adapter,
      {
        rotate: (check) => binding.connector.rotate(check),
        bindings: async (credential) =>
          (await binding.connector.client.call("bindings", {}, credential))
            .bindings as PublicBinding[],
        replace: (input) => binding.connector.replace(input),
      },
      {
        pollIntervalMs: 20,
        leaseIntervalMs: 200,
        ...options,
        beforeMutation: async (kind) => {
          this.note(binding, "MUTATION", { kind: diagnosticEnum(kind, diagnosticMutations) });
          await options.beforeMutation?.(kind);
        },
      },
    );
  }
  async run(binding: OwnedRuntimeBinding, options: RunnerOptions = {}) {
    try {
      const result = await this.runner(binding, options).run({ once: true });
      this.note(binding, "RUN_RESULT", {
        state: diagnosticEnum(result.state, diagnosticStates),
        code: diagnosticEnum(result.error, diagnosticCodes),
        terminal: diagnosticEnum(result.terminal, diagnosticStates),
      });
      await this.workflow.devices.refresh(binding.profile);
      return result;
    } catch (error) {
      this.note(binding, "RUN_FAILURE", { code: diagnosticCode(error) });
      throw error;
    }
  }
  async start() {
    await this.run(this.origin);
    await this.run(this.peer);
    return this.workflow.start(this.scene);
  }
  async close() {
    for (const binding of this.bindings.values()) {
      await binding.adapter.close();
      await this.workflow.devices.refresh(binding.profile);
    }
    await this.workflow.close();
  }
}
export async function ownedRuntimeCase(
  label: string,
  run: (fixture: OwnedRuntimeFixture) => Promise<void>,
) {
  let fixture: OwnedRuntimeFixture | undefined;
  const failures: Error[] = [];
  const failure = async (error: unknown, stage: "assertion" | "cleanup") => {
    const safe = safeFailure(error, stage);
    let summary = "";
    try {
      if (fixture) summary = ` diagnostics=${JSON.stringify(await fixture.diagnostics())}`;
    } catch {
      summary = " diagnostics=UNCONFIRMED";
    }
    failures.push(
      new AggregateError(
        [safe],
        `Owned runtime ${stage} failed${summary}; private values withheld`,
      ),
    );
  };
  try {
    fixture = await OwnedRuntimeFixture.open(label);
    await run(fixture);
  } catch (error) {
    await failure(error, "assertion");
  }
  try {
    await fixture?.close();
  } catch (error) {
    await failure(error, "cleanup");
  }
  if (failures.length)
    throw new AggregateError(failures, "Owned runtime check failed; private values withheld");
}
