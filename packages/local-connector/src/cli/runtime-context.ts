import { RuntimeStore } from "../runtime-store.ts";
import { createProviderAdapter } from "../provider-adapter.ts";
import type { StateStore } from "../state-store.ts";
import { RuntimeError } from "../runtime-contracts.ts";
import { WorkflowRunner, type RuntimeConnections } from "../workflow-runner.ts";
import { WorkflowClient } from "../workflow-client.ts";
import { SettingsStore, type GenerationPointer } from "../settings/store.ts";

export function configuredRunner(
  profile: StateStore,
  origin: string,
  options: RuntimeConnections,
  pointer: GenerationPointer,
  runtime: RuntimeStore,
): WorkflowRunner {
  const adapter = createProviderAdapter(pointer.provider, { profile });
  return new WorkflowRunner(profile, runtime, new WorkflowClient(origin), adapter, options);
}

/** Resolve only the current generation; retained histories never become fresh executions. */
export async function currentRunner(
  profile: StateStore,
  origin: string,
  options: RuntimeConnections,
  settings: SettingsStore,
  agentId: string,
): Promise<WorkflowRunner> {
  const state = await settings.read();
  if (state?.current) {
    const pointer = state.current;
    if (pointer.agentId !== agentId) throw new RuntimeError("AUTHORITY_LOST");
    const runtime = pointer.legacy
      ? new RuntimeStore(profile.dir, profile.profile, agentId)
      : settings.generationStore(agentId, pointer.generation);
    return configuredRunner(profile, origin, options, pointer, runtime);
  }
  const mapping = (await profile.read())?.mappings.find((m) => m.agentId === agentId);
  if (mapping?.formatVersion === 2) throw new RuntimeError("CONTEXT_UNCONFIRMED");
  return new WorkflowRunner(
    profile,
    new RuntimeStore(profile.dir, profile.profile, agentId),
    new WorkflowClient(origin),
    createProviderAdapter("codex", { profile }),
    options,
  );
}
