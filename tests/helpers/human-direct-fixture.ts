import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkflowFixture, type HumanDirectScene } from "./workflow-fixture.js";
import { OwnedFakeAdapter } from "./owned-runtime-fixture.js";
import { ensure } from "./local-access-stack.js";
import { StateStore } from "../../packages/local-connector/src/state-store.ts";
import { RuntimeStore } from "../../packages/local-connector/src/runtime-store.ts";
import { Connector } from "../../packages/local-connector/src/cli.ts";
import { CentralClient } from "../../packages/local-connector/src/central-client.ts";
import { WorkflowClient } from "../../packages/local-connector/src/workflow-client.ts";
import { WorkflowRunner, type RunnerOptions } from "../../packages/local-connector/src/workflow-runner.ts";
import type { PublicBinding } from "../../packages/local-connector/src/contracts.ts";
import type { Body, DeviceAction } from "../../src/features/investigation-coordinator/contracts.ts";

export async function requireHumanDirectMigration(workflow: WorkflowFixture) {
  const installed = await workflow.stack.db.query(`select
    to_regprocedure('public.workflow_human_ask(jsonb)') is not null admission,
    to_regprocedure('public.workflow_human_cancel(jsonb)') is not null cancellation,
    exists(select 1 from information_schema.columns where table_schema='workflow_private'
      and table_name='cycles' and column_name='mode') modes`);
  ensure(Object.values(installed.rows[0]).every(value => value === true),
    "Human direct migration requires supervising additive installation");
}

/** One real Auth participant without a connector; only the owner creates a runtime. */
export class HumanDirectRuntimeFixture {
  readonly adapter = new OwnedFakeAdapter();
  readonly requests: { action: DeviceAction; body: Body }[] = [];
  loseResponse?: (action: DeviceAction) => boolean;
  beforeFetch?: (action: DeviceAction, body: Body, credential: string) => Promise<void>;
  private constructor(readonly workflow: WorkflowFixture, readonly scene: HumanDirectScene,
    readonly state: StateStore, readonly runtime: RuntimeStore, readonly connector: Connector) {}

  static async open(workflow: WorkflowFixture, label: string) {
    await requireHumanDirectMigration(workflow);
    const scene = await workflow.directScene(label);
    const profile = scene.responder;
    const state = new StateStore(join(workflow.devices.root, "state"), profile.name);
    const root = join(workflow.devices.root, `direct-public-${randomUUID()}`);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, "public-context.txt"), "합성 직접 질문의 선택 근거\n", { mode: 0o644 });
    await state.transaction(async () => {
      const saved = await state.read();
      ensure(saved && saved.mappings[0].agentId === profile.agentId, "Missing exact responder mapping");
      saved.mappings[0].root = root;
      await state.write(saved);
    });
    const runtime = new RuntimeStore(state.dir, profile.name, profile.agentId!);
    const connector = new Connector(state, new CentralClient(workflow.stack.config.app));
    const fixture = new HumanDirectRuntimeFixture(workflow, scene, state, runtime, connector);
    try {
      await fixture.runner().prepare({ choice: "default", files: ["public-context.txt"],
        handoff: "선택한 공개 근거로 직접 질문에 답하세요.", confirmed: true, autoQuestionsConfirmed: true });
      await workflow.devices.refresh(profile);
      await fixture.run();
      return fixture;
    } catch (error) {
      await fixture.close();
      throw error;
    }
  }

  runner(options: RunnerOptions = {}) {
    const fetcher: typeof fetch = async (url, init) => {
      ensure(String(url).startsWith(`${this.workflow.stack.config.app}/api/workflow/`) && init?.method === "POST",
        "Unexpected direct runtime transport");
      const action = String(url).split("/").at(-1)! as DeviceAction;
      const body = JSON.parse(String(init.body)) as Body;
      ensure(body.agentId === this.scene.responder.agentId, "Unowned direct runtime body");
      this.requests.push({ action, body });
      if (body.operationId) this.workflow.operations.push({ roomId: this.scene.scope.roomId,
        actorId: this.scene.responder.deviceId!, action, operationId: String(body.operationId) });
      await this.workflow.save();
      const credential = new Headers(init.headers).get("Authorization")!.slice(7);
      await this.beforeFetch?.(action, body, credential);
      const response = await fetch(url, init);
      const json = await response.clone().json().catch(() => null);
      if (response.status === 200 && json?.data) {
        // Recover exact IDs through the existing private receipt ledger, never a public log.
        await this.workflow.captureResponse(json);
      }
      return this.loseResponse?.(action) ? Response.error() : response;
    };
    return new WorkflowRunner(this.state, this.runtime,
      new WorkflowClient(this.workflow.stack.config.app, fetcher), this.adapter, {
        rotate: check => this.connector.rotate(check),
        bindings: async credential => (await this.connector.client.call("bindings", {}, credential)).bindings as PublicBinding[],
        replace: input => this.connector.replace(input),
      }, { pollIntervalMs: 20, leaseIntervalMs: 200, ...options });
  }

  async run(options: RunnerOptions = {}) {
    const result = await this.runner(options).run({ once: true });
    await this.workflow.devices.refresh(this.scene.responder);
    return result;
  }

  async close() {
    await this.adapter.close();
    await this.workflow.devices.refresh(this.scene.responder);
  }
}
