import { createHash, randomBytes } from "node:crypto";
import { CodexRuntime, type PublicRuntimeResult } from "./codex-runtime.js";
import { ExperimentPolicyError, ExperimentStore } from "./experiment-policy.js";
import { RuntimeTransportError } from "./stdio-client.js";

type Command = "probe" | "run" | "resume";

interface ParsedArguments {
  readonly command: Command;
  readonly allowModelCall: boolean;
  readonly model?: string;
  readonly accountRoute?: "api" | "local-login";
  readonly resumeManifest?: string;
  readonly experimentId?: string;
  readonly interruptAfterMs?: number;
  readonly deadlineMs?: number;
}

export interface CliDependencies {
  readonly runtime?: CodexRuntime;
  readonly cwd?: string;
  readonly createStore?: typeof ExperimentStore.create;
  readonly openStore?: typeof ExperimentStore.openOwned;
  readonly findStore?: typeof ExperimentStore.openById;
  readonly markerFactory?: () => string;
}

export interface CliOutput {
  readonly ok: boolean;
  readonly experimentId?: string;
  readonly result?: PublicRuntimeResult;
  readonly error?: string;
  readonly storage?: "system-temporary-directory" | "provided-owned-manifest";
  readonly cleanup?: string;
}

export async function runCli(argv: readonly string[], dependencies: CliDependencies = {}): Promise<CliOutput> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    return failure(error);
  }

  const runtime = dependencies.runtime ?? new CodexRuntime();
  if (parsed.command === "probe") {
    try {
      return { ok: true, result: await runtime.probe(dependencies.cwd ?? process.cwd()) };
    } catch (error) {
      return failure(error);
    }
  }

  const validationError = validateModelCall(parsed);
  if (validationError !== undefined) {
    return { ok: false, error: validationError };
  }
  const model = parsed.model;
  if (model === undefined) {
    return { ok: false, error: "MODEL_REQUIRED" };
  }

  const marker = dependencies.markerFactory?.() ?? randomBytes(24).toString("hex");
  const markerHash = createHash("sha256").update(marker).digest("hex");
  let store: ExperimentStore | undefined;
  let output: CliOutput;
  const storage = parsed.command === "run" || parsed.experimentId !== undefined
    ? "system-temporary-directory" as const : "provided-owned-manifest" as const;
  try {
    runtime.assertAdmission();
    if (parsed.command === "run") {
      const createdStore = await runtime.prepare((dependencies.createStore ?? ExperimentStore.create)(markerHash).then((created) => {
        store = created;
        return created;
      }));
      store = createdStore;
      runtime.assertAdmission();
      const result = await runtime.runNew(createdStore, {
        model,
        prompt: buildInitialPrompt(marker),
        ...(parsed.interruptAfterMs === undefined ? {} : { interruptAfterMs: parsed.interruptAfterMs }),
        ...(parsed.deadlineMs === undefined ? {} : { deadlineMs: parsed.deadlineMs }),
      });
      output = {
        ok: result.success,
        experimentId: createdStore.experimentId,
        result,
        storage,
        cleanup: cleanupInstruction(result.state),
      };
    } else {
      const lookup = parsed.experimentId !== undefined
        ? (dependencies.findStore ?? ExperimentStore.openById)(parsed.experimentId)
        : (dependencies.openStore ?? ExperimentStore.openOwned)(parsed.resumeManifest!);
      const ownedStore = await runtime.prepare(lookup.then((owned) => { store = owned; return owned; }));
      store = ownedStore;
      runtime.assertAdmission();
      const result = await runtime.resume(ownedStore, {
        model,
        prompt: buildResumePrompt(),
        ...(parsed.interruptAfterMs === undefined ? {} : { interruptAfterMs: parsed.interruptAfterMs }),
        ...(parsed.deadlineMs === undefined ? {} : { deadlineMs: parsed.deadlineMs }),
      });
      output = {
        ok: result.success && result.contextMarkerMatched === true,
        experimentId: ownedStore.experimentId,
        result,
        storage,
        cleanup: cleanupInstruction(result.state),
      };
    }
  } catch (error) {
    output = {
      ...failure(error),
      ...(store === undefined ? {} : {
        experimentId: store.experimentId,
        storage,
        cleanup: cleanupInstruction(),
      }),
    };
  }
  try { await runtime.shutdown(); }
  catch { output = { ...output, ok: false, error: "RUNTIME_CLEANUP_FAILED" }; }
  return output;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const values = [...argv];
  const first = values[0];
  const command: Command = first === undefined || first.startsWith("--") ? "probe" : parseCommand(values.shift());
  let allowModelCall = false;
  let model: string | undefined;
  let accountRoute: "api" | "local-login" | undefined;
  let resumeManifest: string | undefined;
  let experimentId: string | undefined;
  let interruptAfterMs: number | undefined;
  let deadlineMs: number | undefined;

  while (values.length > 0) {
    const flag = values.shift();
    switch (flag) {
      case "--allow-model-call":
        allowModelCall = true;
        break;
      case "--model":
        model = requiredValue(values, flag);
        break;
      case "--account-route": {
        const value = requiredValue(values, flag);
        if (value !== "api" && value !== "local-login") {
          throw new ExperimentPolicyError("INVALID_ACCOUNT_ROUTE");
        }
        accountRoute = value;
        break;
      }
      case "--resume-manifest":
        resumeManifest = requiredValue(values, flag);
        break;
      case "--experiment-id":
        experimentId = requiredValue(values, flag);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(experimentId)) {
          throw new ExperimentPolicyError("INVALID_EXPERIMENT_ID");
        }
        break;
      case "--interrupt-after-ms":
        interruptAfterMs = nonNegativeInteger(requiredValue(values, flag), "INVALID_INTERRUPT_DELAY");
        break;
      case "--deadline-ms":
        deadlineMs = positiveInteger(requiredValue(values, flag), "INVALID_DEADLINE");
        break;
      default:
        throw new ExperimentPolicyError("UNKNOWN_ARGUMENT");
    }
  }
  if (resumeManifest !== undefined && experimentId !== undefined) throw new ExperimentPolicyError("AMBIGUOUS_RESUME_INPUT");
  if (command !== "resume" && (resumeManifest !== undefined || experimentId !== undefined)) throw new ExperimentPolicyError("INVALID_RESUME_INPUT");

  return {
    command,
    allowModelCall,
    ...(model === undefined ? {} : { model }),
    ...(accountRoute === undefined ? {} : { accountRoute }),
    ...(resumeManifest === undefined ? {} : { resumeManifest }),
    ...(experimentId === undefined ? {} : { experimentId }),
    ...(interruptAfterMs === undefined ? {} : { interruptAfterMs }),
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
}

function validateModelCall(parsed: ParsedArguments): string | undefined {
  if (!parsed.allowModelCall) {
    return "MODEL_CALL_NOT_ALLOWED";
  }
  if (parsed.model === undefined || parsed.model.length === 0) {
    return "MODEL_REQUIRED";
  }
  if (parsed.accountRoute === undefined) {
    return "ACCOUNT_ROUTE_REQUIRED";
  }
  if (parsed.command === "resume" && parsed.resumeManifest === undefined && parsed.experimentId === undefined) {
    return "RESUME_MANIFEST_REQUIRED";
  }
  return undefined;
}

function cleanupInstruction(state?: string): string {
  if (state === "COMPLETED" || state === "FAILED" || state === "INTERRUPTED") {
    return "Verified terminal state: the owned experiment root may be removed after recording the result. Locate it by experiment ID under the system temporary directory.";
  }
  return "Keep the owned experiment root for state verification; do not delete or replay an UNKNOWN or unconfirmed attempt. Locate it by experiment ID under the system temporary directory.";
}

function parseCommand(value: string | undefined): Command {
  if (value === "probe" || value === "run" || value === "resume") {
    return value;
  }
  throw new ExperimentPolicyError("UNKNOWN_COMMAND");
}

function requiredValue(values: string[], flag: string | undefined): string {
  const value = values.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new ExperimentPolicyError(flag === undefined ? "ARGUMENT_REQUIRED" : "ARGUMENT_VALUE_REQUIRED");
  }
  return value;
}

function nonNegativeInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ExperimentPolicyError(code);
  }
  return parsed;
}

function positiveInteger(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ExperimentPolicyError(code);
  }
  return parsed;
}

function buildInitialPrompt(marker: string): string {
  return [
    "Read public-context.txt and briefly identify it as the synthetic experiment workspace.",
    `Remember this conversation-only marker exactly: ${marker}`,
    "Reply with only the marker after reading the file.",
  ].join("\n");
}

function buildResumePrompt(): string {
  return "Reply with only the conversation-only marker from the previous turn. Do not read files to find it.";
}

function failure(error: unknown): CliOutput {
  if (error instanceof ExperimentPolicyError || error instanceof RuntimeTransportError) {
    return { ok: false, error: error.code };
  }
  return { ok: false, error: "EXPERIMENT_FAILED" };
}

export async function main(dependencies: CliDependencies = {}): Promise<void> {
  const runtime = dependencies.runtime ?? new CodexRuntime();
  let interrupted = false;
  let cleanupFailed = false;
  const onSigint = () => {
    interrupted = true;
    void runtime.shutdown().catch(() => { cleanupFailed = true; });
  };
  process.once("SIGINT", onSigint);
  const output = await runCli(process.argv.slice(2), { ...dependencies, runtime });
  process.removeListener("SIGINT", onSigint);
  process.stdout.write(`${JSON.stringify(cleanupFailed ? { ...output, ok: false, error: "RUNTIME_CLEANUP_FAILED" } : output)}\n`);
  process.exitCode = interrupted ? 130 : output.ok ? 0 : 1;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  await main();
}
