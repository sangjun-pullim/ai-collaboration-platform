import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowFixture, type HumanDirectScene } from "./workflow-fixture.js";
import { RuntimeSettingsFixture } from "./runtime-settings-fixture.js";
import { OwnedFakeAdapter, runtimeGate } from "./owned-runtime-fixture.js";
import { ensure, type FixturePerson } from "./local-access-stack.js";
import { requireHumanDirectMigration } from "./human-direct-fixture.js";
import { ClaudeAdapter } from "../../packages/local-connector/src/claude/adapter.ts";
import {
  OWNED_SERVER,
  NATIVE_TOOL_NAMES,
} from "../../packages/local-connector/src/claude/input-proof.ts";
import { nativeToolNames } from "../../packages/local-connector/src/workspace/tool-contracts.ts";
import type { ClaudePolicy } from "../../packages/local-connector/src/claude/policy.ts";
import type { OwnedHistory } from "../../packages/local-connector/src/claude/owned-history.ts";
import type { Launch, Cleanup } from "../../packages/local-connector/src/claude/transport.ts";
import { StateStore } from "../../packages/local-connector/src/state-store.ts";
import { RuntimeStore } from "../../packages/local-connector/src/runtime-store.ts";
import { SettingsStore } from "../../packages/local-connector/src/settings/store.ts";
import { SettingsClient } from "../../packages/local-connector/src/settings/client.ts";
import { SettingsManager } from "../../packages/local-connector/src/settings/manager.ts";
import { CentralClient } from "../../packages/local-connector/src/central-client.ts";
import { Connector } from "../../packages/local-connector/src/cli.ts";
import { WorkflowClient } from "../../packages/local-connector/src/workflow-client.ts";
import {
  WorkflowRunner,
  type RunnerOptions,
} from "../../packages/local-connector/src/workflow-runner.ts";
import { RuntimeFilePolicy } from "../../packages/local-connector/src/runtime-file-policy.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type RuntimeAdapter,
  type OwnedContext,
} from "../../packages/local-connector/src/runtime-contracts.ts";
import type { PublicBinding } from "../../packages/local-connector/src/contracts.ts";
import type { Body, DeviceAction } from "../../packages/local-connector/src/workflow-contracts.ts";
import type {
  Body as SettingsBody,
  HumanAction,
  Provider,
} from "../../packages/local-connector/src/settings/contracts.ts";

type Frame = Record<string, unknown>;
const version = "2.1.287";
const model = "claude-product-synthetic";
export const productAnswer = "선택한 공개 파일로 확인한 합성 제품 답변";
const evidence = "제품 fixture에서 선택한 공개 근거\n";

/** Frames imitate the protocol; no provider binary, personal history or experiment is used. */
class ProductTransport {
  private handler!: (frame: Frame, signal: AbortSignal) => Promise<void>;
  private failure!: (error: RuntimeError) => void;
  private readonly abort = new AbortController();
  private readonly jobs: Promise<void>[] = [];
  private input?: Frame;
  readonly replies: Frame[] = [];
  closed = false;
  constructor(
    readonly fixture: ClaudeProductFixture,
    readonly context: OwnedContext,
  ) {}
  setHandler(handler: ProductTransport["handler"], failure: ProductTransport["failure"]) {
    this.handler = handler;
    this.failure = failure;
  }
  async request(body: Frame) {
    if (body.subtype === "initialize")
      return { models: [{ value: model, supportsEffort: false, isDefault: true }] };
    ensure(body.subtype === "interrupt" && this.input, "Unexpected synthetic control");
    this.fixture.interrupts++;
    await this.emit({ type: "control_cancel_request", request_id: `control-${this.input.uuid}` });
    await this.emit(this.result(this.input, true));
    return { still_queued: [], cancelled: [this.input.uuid] };
  }
  async reply(_id: string, response: Frame) {
    this.replies.push(structuredClone(response));
  }
  async emit(frame: Frame) {
    if (frame.type !== "control_request" && frame.type !== "control_cancel_request") {
      const history = this.fixture.history(this.context);
      history.materialized = true;
      history.records.push(structuredClone(frame));
    }
    await this.handler(frame, this.abort.signal);
  }
  private result(input: Frame, interrupted = false): Frame {
    return {
      type: "result",
      uuid: randomUUID(),
      session_id: this.context.threadId,
      user_message_uuid: input.uuid,
      parent_tool_use_id: null,
      subtype: interrupted ? "error_during_execution" : "success",
      is_error: interrupted,
      num_turns: 1,
      ...(interrupted
        ? { terminal_reason: "aborted_tools", errors: ["Interrupted"] }
        : { result: productAnswer }),
    };
  }
  async write(input: Frame) {
    // This read observes the actual fsynced product journal before the fake stdin write.
    const record = await (await this.fixture.runtime()).read();
    const journal = record?.attempts.find((item) => item.nativeIntent?.inputId === input.uuid);
    ensure(
      journal?.nativeIntent && journal.state === "PROVIDER_INTENT",
      "Native input lacks durable intent",
    );
    ensure(
      journal.nativeIntent.sessionId === this.context.threadId &&
        journal.nativeIntent.promptHash === digest(String((input.message as Frame).content)),
      "Exact input intent differs",
    );
    this.fixture.inputs.push({
      sessionId: this.context.threadId,
      inputId: String(input.uuid),
      intent: structuredClone(journal.nativeIntent),
    });
    this.input = structuredClone(input);
    const job = this.respond(input).catch((error: unknown) =>
      this.failure(error instanceof RuntimeError ? error : new RuntimeError("UNKNOWN")),
    );
    this.jobs.push(job);
  }
  private async respond(input: Frame) {
    await this.emit(input);
    if (this.fixture.ackLoss) throw new RuntimeError("UNKNOWN");
    await this.emit({
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: this.context.threadId,
      cwd: this.context.root.path,
      claude_code_version: version,
      permissionMode: "dontAsk",
      model,
      tools: nativeToolNames(this.fixture.readMode ?? "SELECTED", false),
      plugins: [],
      mcp_servers: [{ name: OWNED_SERVER, source: "sdk", status: "connected" }],
    });
    if (this.fixture.readMode === "AUTO_CODE") {
      await this.automaticRepository(input);
      return;
    }
    const toolId = `tool-${input.uuid}`;
    await this.emit({
      type: "assistant",
      uuid: randomUUID(),
      session_id: this.context.threadId,
      user_message_uuid: input.uuid,
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        model,
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: NATIVE_TOOL_NAMES[0],
            input: { path: "public-context.txt" },
          },
        ],
      },
    });
    const acknowledged = await (await this.fixture.runtime()).read();
    const ackJournal = acknowledged?.attempts.find(
      (item) => item.nativeIntent?.inputId === input.uuid,
    );
    ensure(
      ackJournal?.native?.turnId === input.uuid &&
        acknowledged?.context?.materialization?.state === "MATERIALIZED",
      "ACK must be durable before tool approval",
    );
    await this.emit({
      type: "control_request",
      request_id: `control-${input.uuid}`,
      request: {
        subtype: "mcp_message",
        server_name: OWNED_SERVER,
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_workspace_file",
            arguments: { path: "public-context.txt" },
            _meta: {
              session_id: this.context.threadId,
              user_message_uuid: input.uuid,
              tool_use_id: toolId,
            },
          },
        },
      },
    });
    if (this.fixture.holdTool) return;
    const reply = this.replies.at(-1)?.mcp_response as Frame | undefined;
    const result = reply?.result as Frame | undefined;
    ensure(
      result?.isError === false && stableJson(result.content).includes(evidence.trim()),
      "Product file authority did not read the selected file",
    );
    await this.emit({
      type: "user",
      uuid: randomUUID(),
      session_id: this.context.threadId,
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolId,
            content: result.content,
            is_error: result.isError,
          },
        ],
      },
    });
    await this.emit({
      type: "assistant",
      uuid: randomUUID(),
      session_id: this.context.threadId,
      user_message_uuid: input.uuid,
      parent_tool_use_id: null,
      message: { role: "assistant", model, content: [{ type: "text", text: productAnswer }] },
    });
    await this.emit(this.result(input));
  }
  private async automaticRepository(input: Frame) {
    const calls = [
      ["list_workspace_files", {}],
      ["search_workspace", { query: "공개 근거" }],
      ["read_workspace_file", { path: "public-context.txt", offset: 0 }],
    ] as const;
    for (let index = 0; index < calls.length; index++) {
      const [name, args] = calls[index];
      const read = name === "read_workspace_file",
        toolId = read ? `tool-${input.uuid}` : `auto-${index}-${input.uuid}`;
      await this.emit({
        type: "assistant",
        uuid: randomUUID(),
        session_id: this.context.threadId,
        user_message_uuid: input.uuid,
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          model,
          content: [
            { type: "tool_use", id: toolId, name: `mcp__${OWNED_SERVER}__${name}`, input: args },
          ],
        },
      });
      const acknowledged = await (await this.fixture.runtime()).read();
      ensure(
        acknowledged?.attempts.some((attempt) => attempt.native?.turnId === input.uuid),
        "Automatic tool must follow durable ACK",
      );
      await this.emit({
        type: "control_request",
        request_id: read ? `control-${input.uuid}` : `auto-control-${index}-${input.uuid}`,
        request: {
          subtype: "mcp_message",
          server_name: OWNED_SERVER,
          message: {
            jsonrpc: "2.0",
            id: index + 1,
            method: "tools/call",
            params: {
              name,
              arguments: args,
              _meta: {
                session_id: this.context.threadId,
                user_message_uuid: input.uuid,
                tool_use_id: toolId,
              },
            },
          },
        },
      });
      if (read && this.fixture.holdTool) return;
      const response = this.replies.at(-1)?.mcp_response as Frame | undefined;
      const result = response?.result as Frame | undefined;
      ensure(
        result?.isError === false && Array.isArray(result.content),
        "Automatic repository callback failed",
      );
      if (read)
        ensure(
          stableJson(result.content).includes(evidence.trim()),
          "Automatic read did not return owned evidence",
        );
      await this.emit({
        type: "user",
        uuid: randomUUID(),
        session_id: this.context.threadId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolId, content: result.content, is_error: false },
          ],
        },
      });
    }
    await this.emit({
      type: "assistant",
      uuid: randomUUID(),
      session_id: this.context.threadId,
      user_message_uuid: input.uuid,
      parent_tool_use_id: null,
      message: { role: "assistant", model, content: [{ type: "text", text: productAnswer }] },
    });
    await this.emit(this.result(input));
  }
  async settleMessages() {
    await Promise.allSettled(this.jobs);
  }
  async close(): Promise<Cleanup> {
    this.abort.abort();
    await this.settleMessages();
    this.closed = true;
    return { code: "REAPED", reaped: true };
  }
}

/** Real owned Auth/DB/HTTP, actual product managers, and constructor-only synthetic Claude I/O. */
export class ClaudeProductFixture {
  readonly settings: RuntimeSettingsFixture;
  readonly store: SettingsStore;
  readonly connector: Connector;
  readonly histories = new Map<string, OwnedHistory>();
  readonly transports: ProductTransport[] = [];
  readonly inputs: { sessionId: string; inputId: string; intent: unknown }[] = [];
  readonly launches: { sessionId: string; resume: boolean }[] = [];
  readonly requests: { action: DeviceAction; body: Body }[] = [];
  readonly settingsOperations: { operationId: string; action: string; actorId: string }[] = [];
  readonly adapters: RuntimeAdapter[] = [];
  readonly toolEntered = runtimeGate();
  readonly toolRelease = runtimeGate();
  readMode?: "AUTO_CODE";
  ackLoss = false;
  holdTool = false;
  interrupts = 0;
  loseComplete = false;
  suppressRunner = false;
  private ledgerWrites: Promise<void> = Promise.resolve();
  private constructor(
    readonly workflow: WorkflowFixture,
    readonly scene: HumanDirectScene,
    readonly state: StateStore,
    readonly root: string,
  ) {
    this.settings = new RuntimeSettingsFixture(workflow);
    this.store = new SettingsStore(state);
    this.connector = new Connector(state, new CentralClient(workflow.stack.config.app));
  }
  static async open(workflow: WorkflowFixture, label: string) {
    const settings = new RuntimeSettingsFixture(workflow);
    await settings.requireMigration();
    await requireHumanDirectMigration(workflow);
    const owner = await workflow.stack.person(`${label}-owner`),
      requester = await workflow.stack.person(`${label}-requester`),
      observer = await workflow.stack.person(`${label}-observer`),
      outsider = await workflow.stack.person(`${label}-outsider`);
    const scope = await workflow.stack.bootstrap(owner);
    workflow.rooms.set(scope.roomId, scope.organizationId);
    await workflow.save();
    await workflow.stack.join(
      requester,
      await workflow.stack.invite(owner, scope.roomId),
      "질문 참가자",
    );
    await workflow.stack.join(
      observer,
      await workflow.stack.invite(owner, scope.roomId, "observer"),
      "관찰자",
    );
    const responder = await workflow.devices.connected(owner, scope, `${label}-responder`);
    ensure(
      !responder.agentId && !responder.workspaceId,
      "First profile must not be legacy registered",
    );
    const state = new StateStore(join(workflow.devices.root, "state"), responder.name);
    ensure((await state.read())?.mappings.length === 0, "First profile must have no mapping");
    const root = join(workflow.devices.root, `claude-public-${randomUUID()}`);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "public-context.txt"), evidence, { mode: 0o644 });
    const fixture = new ClaudeProductFixture(
      workflow,
      { owner, requester, observer, outsider, scope, responder },
      state,
      root,
    );
    await fixture.saveLedger();
    fixture.assertRequesterWithoutAI();
    return fixture;
  }
  assertRequesterWithoutAI() {
    ensure(
      ![...this.workflow.devices.profiles.values()].some(
        (profile) => profile.ownerUserId === this.scene.requester.id,
      ),
      "Requester must have no device or AI",
    );
  }
  async saveLedger() {
    const job = this.ledgerWrites.then(async () => {
      await this.workflow.save();
      const temporary = join(this.workflow.devices.root, `.claude-product-${randomUUID()}.tmp`);
      const target = join(
        this.workflow.devices.root,
        `claude-product-${this.scene.responder.name}.json`,
      );
      let handle;
      try {
        handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(
          JSON.stringify({
            namespace: this.workflow.stack.namespace,
            rooms: [...this.workflow.rooms],
            users: [...this.workflow.stack.users],
            deviceId: this.scene.responder.deviceId,
            ownerUserId: this.scene.owner.id,
            operations: this.settingsOperations,
          }),
        );
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        const parent = await open(
          this.workflow.devices.root,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await parent.sync();
        } finally {
          await parent.close();
        }
      } finally {
        await handle?.close();
        await rm(temporary, { force: true });
      }
    });
    this.ledgerWrites = job.catch(() => {});
    await job;
  }
  async recordSettings(action: string, body: SettingsBody, actorId: string) {
    if (typeof body.operationId === "string")
      this.settingsOperations.push({ action, operationId: body.operationId, actorId });
    await this.saveLedger();
  }
  async human(person: FixturePerson, action: HumanAction, body: SettingsBody) {
    ensure(this.workflow.stack.users.has(person.id), "Unowned settings actor");
    await this.recordSettings(action, body, person.id);
    return this.settings.human(person, action, body);
  }
  history(context: OwnedContext) {
    let history = this.histories.get(context.threadId);
    if (!history) {
      history = {
        materialized: false,
        sessionId: context.threadId,
        root: context.root.path,
        records: [],
      };
      this.histories.set(context.threadId, history);
    }
    return history;
  }
  adapter(
    reserveCatalog?: Parameters<
      NonNullable<
        import("../../packages/local-connector/src/settings/manager.ts").SettingsManagerOptions["adapter"]
      >
    >[1],
  ): RuntimeAdapter {
    const policy: ClaudePolicy = {
      version,
      fingerprint: digest("constructor-only-product-fixture-policy"),
      admit: async (root, check) => {
        ensure(root === this.root, "Unowned synthetic root");
        check();
      },
      assertLive: (root, check) => {
        ensure(root === this.root, "Unowned synthetic root");
        check();
      },
      launch: (context, _settings, _tools, resume): Launch => {
        this.launches.push({ sessionId: context.threadId, resume });
        return {
          executable: "fixture-never-executed",
          cwd: context.root.path,
          args: [resume ? "fixture-resume" : "fixture-reservation"],
          env: {},
        };
      },
    };
    const adapter = new ClaudeAdapter({
      policy,
      reserveCatalog,
      history: async (context, check) => {
        check();
        return structuredClone(this.history(context));
      },
      transport: (launch) => {
        // The durable reservation is resolved only from the owned settings/runtime journals.
        const context = this.currentLaunchContext;
        ensure(context && launch.cwd === this.root, "Missing durable synthetic launch reservation");
        const transport = new ProductTransport(this, context);
        this.transports.push(transport);
        return transport;
      },
    });
    // Keep the same authority object so the real adapter's interrupt identity remains exact.
    const execute = adapter.execute.bind(adapter);
    adapter.execute = async (authority, settings, payload, beforeSubmit) => {
      this.currentLaunchContext = authority.context;
      if (this.holdTool) {
        const tool = authority.tool;
        authority.tool = async (call) => {
          const result = await tool(call);
          this.toolEntered.release();
          await this.toolRelease.promise;
          return result;
        };
      }
      return execute(authority, settings, payload, beforeSubmit);
    };
    this.adapters.push(adapter);
    return adapter;
  }
  private currentLaunchContext?: OwnedContext;
  manager() {
    const fetcher: typeof fetch = async (url, init) => {
      ensure(
        String(url).startsWith(`${this.workflow.stack.config.app}/api/runtime-settings/`) &&
          init?.method === "POST",
        "Unexpected settings transport",
      );
      const action = String(url).split("/").at(-1)!;
      await this.recordSettings(
        action,
        JSON.parse(String(init.body)) as SettingsBody,
        this.scene.responder.deviceId!,
      );
      return fetch(url, init);
    };
    return new SettingsManager(
      this.state,
      this.store,
      new SettingsClient(this.workflow.stack.config.app, fetcher),
      {
        pollIntervalMs: 20,
        folder: async () => ({
          status: "SELECTED",
          root: this.readMode
            ? await RuntimeFilePolicy.root(this.root)
            : (await RuntimeFilePolicy.select(this.root, ["public-context.txt"], () => {})).root,
        }),
        confirm: async () => ({
          confirmed: true,
          repositoryAlias: "합성 공개 저장소",
          files: this.readMode
            ? []
            : [
                ...(await RuntimeFilePolicy.select(this.root, ["public-context.txt"], () => {}))
                  .files,
              ],
          ...(this.readMode ? { readMode: this.readMode } : {}),
          handoff: "선택한 공개 파일만 읽어 답하세요.",
        }),
        adapter: (provider, reserve) => {
          if (provider === "codex") {
            const fake = new OwnedFakeAdapter();
            this.adapters.push(fake);
            return fake;
          }
          return this.adapter(async (...args) => {
            const context = await reserve(...args);
            this.currentLaunchContext = context;
            return context;
          });
        },
        runner: (_pointer, store) => ({
          run: async (options) => {
            await this.workflow.devices.refresh(this.scene.responder);
            return this.suppressRunner ? { ready: false } : this.runner(store).run(options);
          },
        }),
      },
    );
  }
  async runtime(): Promise<RuntimeStore> {
    const pointer = (await this.store.read())?.current;
    ensure(pointer, "No applied owned generation");
    return this.store.generationStore(pointer.agentId, pointer.generation);
  }
  runner(store: RuntimeStore, options: RunnerOptions = {}) {
    const fetcher: typeof fetch = async (url, init) => {
      ensure(
        String(url).startsWith(`${this.workflow.stack.config.app}/api/workflow/`) &&
          init?.method === "POST",
        "Unexpected product workflow transport",
      );
      const action = String(url).split("/").at(-1)! as DeviceAction;
      const body = JSON.parse(String(init.body)) as Body;
      this.requests.push({ action, body });
      ensure(body.agentId === this.scene.responder.agentId, "Unowned product workflow binding");
      const credential = new Headers(init.headers).get("Authorization")!.slice(7);
      const response = await this.workflow.device(this.scene.responder, action, body, credential);
      if (this.loseComplete && action === "complete") {
        this.loseComplete = false;
        return Response.error();
      }
      return new Response(response.text, { status: response.status, headers: response.headers });
    };
    return new WorkflowRunner(
      this.state,
      store,
      new WorkflowClient(this.workflow.stack.config.app, fetcher),
      this.adapter(),
      {
        rotate: (check) => this.connector.rotate(check),
        bindings: async (credential) =>
          (await this.connector.client.call("bindings", {}, credential))
            .bindings as PublicBinding[],
        replace: (input) => this.connector.replace(input),
      },
      { pollIntervalMs: 20, leaseIntervalMs: 200, ...options },
    );
  }
  async driveFolder() {
    return this.manager().run({ once: true });
  }
  async requestFolder(provider: Provider = "claude") {
    const current = this.settings.accepted(
      await this.human(this.scene.owner, "list", { deviceId: this.scene.responder.deviceId! }),
    );
    const body = {
      deviceId: this.scene.responder.deviceId!,
      operationId: randomUUID(),
      expectedConfigRevision: current.configRevision,
      runtime: provider,
    };
    this.settings.accepted(await this.human(this.scene.owner, "select-folder", body));
    return body;
  }
  async configure() {
    const base = await this.requestFolder();
    await this.driveFolder();
    const response = this.settings.accepted(
      await this.human(this.scene.owner, "list", { deviceId: base.deviceId }),
    );
    const catalog = response.catalog!,
      receipt = response.operation!.receipt!;
    ensure(catalog && receipt.localRootReference, "Missing observed catalog");
    const selected = { ...base, model, effort: null, snapshotHash: catalog.snapshotHash };
    this.settings.accepted(await this.human(this.scene.owner, "select-runtime", selected));
    const apply = {
      ...selected,
      ...(receipt.readMode ? { readMode: receipt.readMode } : {}),
      localRootReference: receipt.localRootReference,
      repositoryAlias: receipt.repositoryAlias!,
      sessionAlias: "제품 Claude AI",
      expectedEpoch: response.currentBinding?.bindingEpoch ?? null,
    };
    this.settings.accepted(await this.human(this.scene.owner, "apply", apply));
    await this.driveApply();
    return { base, selected, apply };
  }
  async driveApply() {
    // The manager persists APPLIED before its runner callback; refresh the public fixture IDs there.
    const manager = this.manager();
    const status = await manager.run({ once: true });
    await this.workflow.devices.refresh(this.scene.responder);
    return status;
  }
  async run(options: RunnerOptions = {}) {
    return this.runner(await this.runtime(), options).run({ once: true });
  }
  async close() {
    this.toolRelease.release();
    const failures: unknown[] = [];
    for (const adapter of this.adapters)
      try {
        await adapter.close();
      } catch {
        failures.push(new Error("Owned synthetic adapter cleanup failed"));
      }
    try {
      await this.saveLedger();
    } catch {
      failures.push(new Error("Owned product fixture ledger failed"));
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Owned product cleanup failed; private diagnostics withheld",
      );
  }
}
export async function claudeProductCase(
  label: string,
  run: (fixture: ClaudeProductFixture) => Promise<void>,
) {
  const workflow = await WorkflowFixture.open(`claude-product-${label}`);
  let fixture: ClaudeProductFixture | undefined;
  const failures: Error[] = [];
  try {
    fixture = await ClaudeProductFixture.open(workflow, label);
    await run(fixture);
  } catch {
    failures.push(new Error("Owned Claude product assertion failed; private diagnostics withheld"));
  } finally {
    try {
      await fixture?.close();
    } catch {
      failures.push(new Error("Owned Claude product runtime cleanup failed"));
    }
    try {
      await workflow.close();
    } catch {
      failures.push(new Error("Owned Claude product stack cleanup failed"));
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Owned Claude product checks failed; private diagnostics withheld",
    );
}
