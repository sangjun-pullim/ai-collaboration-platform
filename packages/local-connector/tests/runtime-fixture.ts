import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexVersion, digest, type Capabilities, type RuntimeScope, type RuntimeSettings, type OwnedContext, type SettingsObservation } from "../src/runtime-contracts.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import { RuntimeStore, runtimeRecord } from "../src/runtime-store.ts";
export const uuid = () => randomUUID();
export function capabilities(): Capabilities {
  const models = [{ id: "test-a", model: "test-a", efforts: ["low", "high"], defaultEffort: "low", isDefault: true }, { id: "test-b", model: "test-b", efforts: ["medium"], defaultEffort: "medium", isDefault: false }];
  return { version: codexVersion, models, defaultSettings: { model: "test-a", effort: "low" }, snapshotHash: digest(JSON.stringify(models)), policy: "CONFIRMED" };
}
export function observation(settings: RuntimeSettings): SettingsObservation { return { requested: settings.requested, thread: { model: settings.requested.model, provider: "openai", effort: settings.requested.effort }, turn: { requestedModel: settings.requested.model, requestedEffort: settings.requested.effort, model: null, rerouted: false, effortVerification: "UNVERIFIED" } }; }
export async function runtimeFixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "owned-runtime-unit-")); const root = join(directory, "repository"); const stateDir = join(directory, "state");
  await mkdir(root); await mkdir(stateDir, { mode: 0o700 }); await writeFile(join(root, "public.txt"), "Selected public evidence.\n", { mode: 0o644 });
  const scope: RuntimeScope = { server: "http://127.0.0.1:7777", deviceId: uuid(), organizationId: uuid(), roomId: uuid(), agentId: uuid(), bindingEpoch: 1 };
  const policy = await RuntimeFilePolicy.select(root, ["public.txt"]);
  const settings: RuntimeSettings = { provider: "codex", requested: { model: "test-a", effort: "low" }, capabilities: capabilities(), files: [...policy.files], handoff: "Investigate selected public evidence.", publicScopeConfirmed: true, autoQuestionsConfirmed: true };
  const context: OwnedContext = { ownership: "CONNECTOR_CREATED", generation: uuid(), threadId: uuid(), root: policy.root, epoch: 1, level: "L1", ownedTurns: [] };
  const store = new RuntimeStore(stateDir, "one", scope.agentId); const record = { ...runtimeRecord(scope), settings, context };
  return { directory, root, stateDir, scope, policy, settings, context, store, record, close: () => rm(directory, { recursive: true, force: true }) };
}
