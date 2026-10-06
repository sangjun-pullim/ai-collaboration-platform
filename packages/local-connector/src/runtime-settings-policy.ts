import {
  RuntimeError,
  type Capabilities,
  type ModelCapability,
  type RequestedSettings,
  type RuntimeProvider,
} from "./runtime-contracts.ts";

export function supportsEffort(
  provider: RuntimeProvider,
  model: ModelCapability,
  effort: string | null,
): boolean {
  return effort === null
    ? provider === "claude" && model.efforts.length === 0 && model.defaultEffort === null
    : model.efforts.includes(effort);
}

/** Missing legacy runtime metadata refers only to the existing Codex format. */
export function selectRuntimeSettings(
  capability: Capabilities,
  choice: RequestedSettings | "default",
  provider: RuntimeProvider = capability.runtime ?? "codex",
): RequestedSettings {
  const selected = choice === "default" ? capability.defaultSettings : choice;
  if (
    (capability.runtime !== undefined && capability.runtime !== provider) ||
    !selected ||
    !capability.models.some(
      (model) => model.model === selected.model && supportsEffort(provider, model, selected.effort),
    )
  )
    throw new RuntimeError("UNSUPPORTED_SETTINGS");
  return { model: selected.model, effort: selected.effort };
}
