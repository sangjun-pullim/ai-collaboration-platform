import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { ApprovalBudget, OwnedProbeStore, ProbeError, uuid } from "./owned-probe-store.js";
import { NativeRuntime } from "./native-runtime.js";
import { SelectedFiles, TaskPolicy, providerEnvironment } from "./task-policy.js";

type CliCommand = "preflight" | "probe-zero" | "probe-tools" | "probe-interrupt";
interface Arguments {
  command: CliCommand;
  approvalPath: string;
  approvalId: string;
  root: string;
  state: string;
  claude: string;
  optIn: boolean;
}

function parse(argv: string[]): Arguments {
  const [command, ...rest] = argv;
  if (!["preflight", "probe-zero", "probe-tools", "probe-interrupt"].includes(command ?? "")) {
    throw new ProbeError("INVALID_ARGUMENT");
  }
  const flags = new Map<string, string>();
  let optIn = false;
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (key === "--native-opt-in" && !optIn) { optIn = true; continue; }
    if (!["--approval", "--approval-id", "--root", "--state", "--claude"].includes(key) || flags.has(key)) {
      throw new ProbeError("INVALID_ARGUMENT");
    }
    const value = rest[++i];
    if (!value || value.startsWith("--")) throw new ProbeError("INVALID_ARGUMENT");
    flags.set(key, value);
  }
  const approvalPath = flags.get("--approval") ?? "";
  const approvalId = flags.get("--approval-id") ?? "";
  const root = flags.get("--root") ?? "";
  const state = flags.get("--state") ?? "";
  const claude = flags.get("--claude") ?? "";
  if (!uuid(approvalId) || [approvalPath, root, state, claude].some((p) => !isAbsolute(p) || p.includes("\0"))) {
    throw new ProbeError("INVALID_ARGUMENT");
  }
  return { command: command as CliCommand, approvalPath, approvalId, root, state, claude, optIn };
}

/** A command-line opt-in is permission to investigate, never native policy evidence. */
export async function main(argv: string[]): Promise<{ status: string; actualInputs: number }> {
  const args = parse(argv);
  const budget = new ApprovalBudget(args.approvalPath, args.approvalId);
  budget.read();
  const policy = new TaskPolicy();
  policy.admit();
  // The current production admission fails above until reviewed native evidence is implemented.
  if (args.command === "preflight") return { status: "PREFLIGHT_CONFIRMED", actualInputs: 0 };
  if (!args.optIn) throw new ProbeError("INVALID_ARGUMENT");
  const store = args.command === "probe-zero" ? OwnedProbeStore.reserve(args.state, args.root) : new OwnedProbeStore(args.state);
  return store.withLock(async () => {
    if (store.read().root !== args.root) throw new ProbeError("UNSAFE_STORAGE");
    const files = new SelectedFiles(args.root, ["owned-fixture.txt"]);
    const runtime = new NativeRuntime(store, budget, policy, files, args.claude, providerEnvironment(process.env));
    try {
      await runtime.initialize(args.command !== "probe-zero");
      if (args.command === "probe-zero") {
        await runtime.probeZero();
        // Fresh-process read/resume is still a separate required proof, never implicit success.
        return { status: "ZERO_HISTORY_OBSERVED_RESUME_UNCONFIRMED", actualInputs: 0 };
      }
      // Tool and interrupt probes require root-verified native callback/terminal seams.
      // No arbitrary prompt or model selection is exposed here.
      throw new ProbeError("TOOL_CORRELATION_UNCONFIRMED");
    } finally { await runtime.close(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((result) => {
    process.stdout.write(JSON.stringify(result) + "\n");
  }).catch((error: unknown) => {
    const code = error instanceof ProbeError ? error.code : "PROTOCOL_REJECTED";
    process.stdout.write(JSON.stringify({ status: "REFUSED", code }) + "\n");
    process.exitCode = 1;
  });
}
