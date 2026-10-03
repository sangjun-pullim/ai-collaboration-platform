import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApprovalBudget, OwnedProbeStore } from "../src/owned-probe-store.js";
import { NativeRuntime, readExactOwnedHistory, type RuntimeOptions } from "../src/native-runtime.js";
import { TaskPolicy, SelectedFiles, providerEnvironment, type NativeEvidence } from "../src/task-policy.js";
import type { Launch } from "../src/native-transport.js";

export const fake = fileURLToPath(new URL("../../test/fixtures/fake-claude.mjs", import.meta.url));
export const syntheticEvidence: NativeEvidence = {
  version: "2.1.287", provenance: "SYNTHETIC_FIXTURE", startup: "TASK_OVERLAY_BEFORE_EXECUTION",
  execution: "TASK_OVERLAY_PINS_RUNTIME_RELOAD", instructions: "PRESERVED",
  callback: "NATIVE_ASSISTANT_TOOL_USE", managed: "NO_CONFLICT", initialUserMessage: "ABSENT", inheritedHooks: "DISABLED",
};
export function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export class Fixture {
  readonly directory: string;
  readonly root: string;
  readonly native: string;
  readonly source: string;
  readonly instruction: string;
  readonly approvalPath: string;
  readonly approvalId = randomUUID();
  readonly budget: ApprovalBudget;
  readonly store: OwnedProbeStore;
  readonly files: SelectedFiles;
  readonly log: string;
  #calls = 0;

  constructor() {
    const temporary = process.env.TMPDIR;
    if (!temporary) throw new Error("SYNTHETIC_TMPDIR_REQUIRED");
    this.directory = mkdtempSync(join(realpathSync(temporary), "009-synthetic-"));
    this.root = join(this.directory, "root");
    this.native = join(this.directory, "native");
    mkdirSync(this.root, { mode: 0o700 });
    mkdirSync(this.native, { mode: 0o700 });
    this.source = join(this.root, "synthetic-settings.json");
    this.instruction = join(this.root, "CLAUDE.md");
    writeFileSync(this.source, '{"language":"SYNTHETIC_KOREAN"}\n', { mode: 0o600 });
    writeFileSync(this.instruction, "SYNTHETIC_PERSONAL_INSTRUCTIONS\n", { mode: 0o600 });
    writeFileSync(join(this.root, "owned-fixture.txt"), "SYNTHETIC_FIRST_MARKER", { mode: 0o644 });
    this.files = new SelectedFiles(this.root, ["owned-fixture.txt"]);
    this.store = OwnedProbeStore.reserve(join(this.directory, "state"), this.root);
    this.approvalPath = join(this.directory, "approval.json");
    const budgetId = randomUUID();
    const budgetPath = join(this.directory, "budget.json");
    writeFileSync(this.approvalPath, JSON.stringify({ version: 1, approvalId: this.approvalId, budgetId, budgetPath, maxInputs: 3 }), { mode: 0o600 });
    writeFileSync(budgetPath, JSON.stringify({ version: 1, approvalId: this.approvalId, budgetId, maxInputs: 3, slots: [] }), { mode: 0o600 });
    this.budget = new ApprovalBudget(this.approvalPath, this.approvalId);
    this.log = join(this.directory, "fake.log");
  }

  policy(evidence = syntheticEvidence): TaskPolicy {
    return new TaskPolicy({ sources: [{ path: this.source, kind: "user" }, { path: this.instruction, kind: "instruction" }],
      knownPlugins: ["synthetic.plugin@market"], evidence });
  }

  launch(mode: string, args: string[]): Launch {
    this.#calls++;
    return { executable: process.execPath, args: [fake, ...args], cwd: this.root, env: providerEnvironment({
      TMPDIR: process.env.TMPDIR, FAKE_MODE: mode, FAKE_NATIVE_DIR: this.native, FAKE_LOG: this.log,
      SYNTHETIC_USER_KEY: "SYNTHETIC_USER_VALUE", LOCAL_ACCESS_ADMIN: "SYNTHETIC_ADMIN", DATABASE_URL: "SYNTHETIC_DATABASE",
    }) };
  }

  runtime(mode = "normal", options: RuntimeOptions = {}, store = this.store, policy = this.policy()): NativeRuntime {
    return new NativeRuntime(store, this.budget, policy, this.files, "/SYNTHETIC_NEVER_EXECUTED_CLAUDE", {}, {
      launch: (args) => this.launch(mode, args),
      history: () => readExactOwnedHistory(join(this.native, `${store.read().sessionId}.jsonl`), store.read().sessionId, this.root),
      transport: { probeMs: 2500, requestMs: 500, closeMs: [50, 100, 100] },
      ...options,
    });
  }

  get spawnCount(): number { return this.#calls; }
  events(): Record<string, unknown>[] {
    if (!existsSync(this.log)) return [];
    return readFileSync(this.log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  dispose(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
