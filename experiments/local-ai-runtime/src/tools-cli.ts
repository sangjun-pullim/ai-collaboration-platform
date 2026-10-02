import { ExperimentPolicyError, ExperimentStore } from "./experiment-policy.js";
import { ScopedToolExperiment, type ScopedToolResult } from "./scoped-tool-experiment.js";
import { RuntimeTransportError } from "./stdio-client.js";

export interface ToolsCliDependencies {
  readonly runtime?: ScopedToolExperiment;
  readonly createStore?: typeof ExperimentStore.create;
  readonly findStore?: typeof ExperimentStore.openById;
}
export interface ToolsCliOutput {
  readonly ok: boolean;
  readonly experimentId?: string;
  readonly result?: ScopedToolResult;
  readonly error?: string;
}

export async function runToolsCli(argv: readonly string[], dependencies: ToolsCliDependencies = {}): Promise<ToolsCliOutput> {
  let args: ReturnType<typeof parse>;
  try { args = parse(argv); } catch (error) { return failure(error); }
  const runtime = dependencies.runtime ?? new ScopedToolExperiment();
  let store: ExperimentStore | undefined;
  let output: ToolsCliOutput;
  try {
    runtime.assertAdmission();
    // Await owned storage I/O rather than returning while creation/cleanup is unresolved.
    store = args.command === "run"
      ? await (dependencies.createStore ?? ExperimentStore.create)()
      : await (dependencies.findStore ?? ExperimentStore.openById)(args.experimentId!);
    runtime.assertAdmission();
    const execution = { model: args.model, ...(args.deadlineMs === undefined ? {} : { deadlineMs: args.deadlineMs }) };
    const result = args.command === "run" ? await runtime.runNew(store, execution) : await runtime.resume(store, execution);
    output = { ok: result.success, experimentId: store.experimentId, result };
  } catch (error) {
    output = { ...failure(error), ...(store === undefined ? {} : { experimentId: store.experimentId }) };
  }
  try { await runtime.shutdown(); } catch { output = { ...output, ok: false, error: "RUNTIME_CLEANUP_FAILED" }; }
  return output;
}

function parse(argv: readonly string[]) {
  const values = [...argv];
  const command = values.shift();
  if (command !== "run" && command !== "resume") throw new ExperimentPolicyError("UNKNOWN_COMMAND");
  let allow = false;
  let model: string | undefined;
  let account: string | undefined;
  let experimentId: string | undefined;
  let deadlineMs: number | undefined;
  const seen = new Set<string>();
  while (values.length > 0) {
    const flag = values.shift()!;
    if (seen.has(flag)) throw new ExperimentPolicyError("DUPLICATE_ARGUMENT");
    seen.add(flag);
    if (flag === "--allow-model-call") { allow = true; continue; }
    if (!["--model", "--account-route", "--experiment-id", "--deadline-ms"].includes(flag)) throw new ExperimentPolicyError("UNKNOWN_ARGUMENT");
    const value = values.shift();
    if (value === undefined || value.startsWith("--") || value.length === 0) throw new ExperimentPolicyError("ARGUMENT_VALUE_REQUIRED");
    switch (flag) {
      case "--model": model = value; break;
      case "--account-route":
        if (value !== "api" && value !== "local-login") throw new ExperimentPolicyError("INVALID_ACCOUNT_ROUTE");
        account = value; break;
      case "--experiment-id":
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new ExperimentPolicyError("INVALID_EXPERIMENT_ID");
        experimentId = value; break;
      case "--deadline-ms":
        deadlineMs = Number(value);
        if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 600_000) throw new ExperimentPolicyError("INVALID_DEADLINE");
        break;
    }
  }
  if (!allow) throw new ExperimentPolicyError("MODEL_CALL_NOT_ALLOWED");
  if (model === undefined) throw new ExperimentPolicyError("MODEL_REQUIRED");
  if (account === undefined) throw new ExperimentPolicyError("ACCOUNT_ROUTE_REQUIRED");
  if (command === "resume" && experimentId === undefined) throw new ExperimentPolicyError("EXPERIMENT_ID_REQUIRED");
  if (command === "run" && experimentId !== undefined) throw new ExperimentPolicyError("INVALID_RESUME_INPUT");
  return { command, model, experimentId, deadlineMs };
}

function failure(error: unknown): ToolsCliOutput {
  return {
    ok: false,
    error: (error instanceof ExperimentPolicyError || error instanceof RuntimeTransportError) && /^[A-Z_]+$/.test(error.code)
      ? error.code : "TOOL_EXPERIMENT_FAILED",
  };
}

export async function main(dependencies: ToolsCliDependencies = {}): Promise<void> {
  const runtime = dependencies.runtime ?? new ScopedToolExperiment();
  let interrupted = false;
  let cleanup: Promise<void> | undefined;
  const onSigint = () => {
    interrupted = true;
    cleanup ??= runtime.shutdown();
    void cleanup.catch(() => undefined);
  };
  process.once("SIGINT", onSigint);
  let output = await runToolsCli(process.argv.slice(2), { ...dependencies, runtime });
  if (cleanup !== undefined) {
    try { await cleanup; } catch { output = { ...output, ok: false, error: "RUNTIME_CLEANUP_FAILED" }; }
  }
  process.removeListener("SIGINT", onSigint);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = interrupted ? 130 : output.ok ? 0 : 1;
}
if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) await main();
