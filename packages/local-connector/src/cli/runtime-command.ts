import { ConnectionError } from "../contracts.ts";
import { createProviderAdapter, type ProviderAdapterOptions } from "../provider-adapter.ts";
import { RuntimeFilePolicy } from "../runtime-file-policy.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";

export async function untilStopped<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    return await run(controller.signal);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function runRuntimeCommand(
  command: string,
  options: Record<string, string>,
  required: (key: string) => string,
  runner: () => Promise<WorkflowRunner>,
  adapterOptions?: ProviderAdapterOptions,
): Promise<unknown> {
  if (command === "runtime-capabilities") {
    const provider = options.runtime ?? "codex";
    if (provider !== "codex" && provider !== "claude") throw new ConnectionError("INVALID_BODY");
    if (!adapterOptions) throw new ConnectionError("INVALID_BODY");
    const adapter = createProviderAdapter(provider, adapterOptions);
    try {
      const policy = await RuntimeFilePolicy.select(required("root"), []);
      const capabilities = await adapter.capabilities(policy.root.path, () => {});
      return {
        provider,
        version: capabilities.version,
        models: capabilities.models,
        defaultSettings: capabilities.defaultSettings,
        policy: capabilities.policy,
        accountEligibility: "UNVERIFIED",
        finalInputIsolation: "UNVERIFIED",
      };
    } finally {
      await adapter.close();
    }
  }
  const runtime = await runner();
  if (command === "runtime-status") return runtime.status();
  if (command === "runtime-observe") return runtime.observe();
  if (command === "runtime-run")
    return untilStopped((signal) => runtime.run({ once: options.once === "yes", signal }));
  if (command !== "runtime-prepare") throw new ConnectionError("INVALID_BODY");
  if (options["confirm-new-context"] !== "yes" || options["confirm-public"] !== "yes")
    throw new ConnectionError("INVALID_BODY");
  if (options["runtime-default"] === "yes" && (options.model || options.effort))
    throw new ConnectionError("INVALID_BODY");
  if (options.runtime && options.runtime !== "codex") throw new ConnectionError("INVALID_BODY");
  const choice =
    options["runtime-default"] === "yes"
      ? ("default" as const)
      : { model: required("model"), effort: required("effort") };
  let files: unknown;
  try {
    files = JSON.parse(options.files ?? "[]");
  } catch {
    throw new ConnectionError("INVALID_BODY");
  }
  if (!Array.isArray(files) || !files.every((path) => typeof path === "string"))
    throw new ConnectionError("INVALID_BODY");
  return runtime.prepare({
    root: options.root,
    choice,
    files,
    handoff: options.handoff ?? "",
    confirmed: true,
    autoQuestionsConfirmed: options["confirm-auto-questions"] === "yes",
  });
}
