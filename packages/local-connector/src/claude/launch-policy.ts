import { lstatSync, realpathSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  digest,
  RuntimeError,
  stableJson,
  type OwnedContext,
  type RuntimeSettings,
} from "../runtime-contracts.ts";
import type { ClaudePolicy } from "./policy.ts";
import type { Launch } from "./transport.ts";
import { nativeToolNames } from "../workspace/tool-contracts.ts";
import { repositoryMode } from "../workspace/repository-access.ts";
import { OWNED_SERVER } from "./input-proof.ts";
import { isId } from "../contracts.ts";
import { readOwnedHistory } from "./owned-history.ts";
import {
  canonicalAncestors,
  providerEnvironment,
  readConfigurationFile,
  snapshotBinary,
  snapshotSource,
  type ConfigurationSource,
  type SourceSnapshot,
} from "./configuration.ts";

const revision = "claude-policy-024-v1";
const syntheticEvidence = new WeakSet<object>();
export interface SyntheticClaudeLayout {
  fixtureDirectory: string;
  fixture: string;
  root: string;
  gitRoot: string;
  mainCheckout: string;
  configDirectory: string;
  userConfiguration: string;
  legacyLocal: string;
  instructions: readonly string[];
  sourceCompleteness: boolean;
  managedCompleteness: boolean;
  startupPrecedence: boolean;
  reloadPrecedence: boolean;
  effortPrecedence: boolean;
  nullableEffortUnaffected: boolean;
  transcriptEncoding: "short-cwd-v1" | "UNCONFIRMED";
}
export interface SyntheticClaudeEvidence {
  readonly kind: "SYNTHETIC";
  readonly version: string;
  readonly executable: string;
  readonly executableHash: string;
  readonly fixtureHash: string;
  readonly layout: Readonly<SyntheticClaudeLayout>;
}
function inside(parent: string, path: string) {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}
/** This constructor-only evidence can never authorize an official Claude binary. */
export function createSyntheticClaudeEvidence(
  layout: SyntheticClaudeLayout,
): SyntheticClaudeEvidence {
  const copied = structuredClone(layout);
  for (const path of [
    copied.fixtureDirectory,
    copied.fixture,
    copied.root,
    copied.gitRoot,
    copied.mainCheckout,
    copied.configDirectory,
    copied.userConfiguration,
    copied.legacyLocal,
    ...copied.instructions,
  ]) {
    if (path !== resolve(path) || !inside(copied.fixtureDirectory, path))
      throw new RuntimeError("POLICY_UNCONFIRMED");
    canonicalAncestors(path);
  }
  const directory = lstatSync(copied.fixtureDirectory);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new RuntimeError("POLICY_UNCONFIRMED");
  const bytes = readConfigurationFile(copied.fixture);
  if (
    extname(copied.fixture) !== ".mjs" ||
    !bytes ||
    !bytes.toString("utf8").startsWith("// AI_COLLAB_SYNTHETIC_CLAUDE_FIXTURE\n")
  )
    throw new RuntimeError("POLICY_UNCONFIRMED");
  const executable = realpathSync(process.execPath);
  const evidence: SyntheticClaudeEvidence = Object.freeze({
    kind: "SYNTHETIC",
    version: "2.1.287",
    executable,
    executableHash: snapshotBinary(executable).hash,
    fixtureHash: snapshotBinary(copied.fixture).hash,
    layout: Object.freeze({ ...copied, instructions: Object.freeze([...copied.instructions]) }),
  });
  syntheticEvidence.add(evidence);
  return evidence;
}
function sources(layout: Readonly<SyntheticClaudeLayout>): ConfigurationSource[] {
  const entries: ConfigurationSource[] = [
    { path: join(layout.configDirectory, "settings.json"), kind: "user" },
    { path: join(layout.configDirectory, ".credentials.json"), kind: "auth" },
    { path: layout.userConfiguration, kind: "auth" },
    { path: join(layout.gitRoot, ".claude", "settings.json"), kind: "project" },
    { path: join(layout.root, ".claude", "settings.local.json"), kind: "local" },
    { path: join(layout.mainCheckout, ".claude", "settings.local.json"), kind: "local" },
    { path: layout.legacyLocal, kind: "local" },
    { path: join(layout.configDirectory, "managed-settings.json"), kind: "managed" },
    { path: join(layout.configDirectory, "CLAUDE.md"), kind: "instruction" },
    { path: join(layout.root, "CLAUDE.md"), kind: "instruction" },
    { path: join(layout.root, ".claude", "CLAUDE.md"), kind: "instruction" },
    ...layout.instructions.map((path): ConfigurationSource => ({ path, kind: "instruction" })),
  ];
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}
function environmentIdentity(env: NodeJS.ProcessEnv) {
  // Authentication refresh does not change execution authority. Everything else is pinned.
  const auth = /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)$/;
  return digest(
    stableJson(
      Object.fromEntries(
        Object.entries(providerEnvironment(env)).filter(([key]) => !auth.test(key)),
      ),
    ),
  );
}

/** Owns admission, source drift, launch and the single exact transcript location. */
export class ClaudeLaunchPolicy implements ClaudePolicy {
  readonly version: string;
  private fingerprintValue: string;
  get fingerprint(): string {
    return this.fingerprintValue;
  }
  private snapshots: SourceSnapshot[] | undefined;
  private rootIdentity: string | undefined;
  private environmentHash: string | undefined;
  constructor(
    private readonly evidence?: SyntheticClaudeEvidence,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    const trusted = evidence && syntheticEvidence.has(evidence);
    this.version = trusted ? evidence.version : "0.0.0";
    this.fingerprintValue = trusted
      ? digest(
          stableJson({
            revision,
            version: evidence.version,
            executable: evidence.executableHash,
            fixture: evidence.fixtureHash,
            layout: evidence.layout,
          }),
        )
      : "0".repeat(64);
  }
  private reviewed(root: string): SyntheticClaudeEvidence {
    const evidence = this.evidence;
    if (
      !evidence ||
      !syntheticEvidence.has(evidence) ||
      evidence.kind !== "SYNTHETIC" ||
      evidence.executable !== realpathSync(process.execPath)
    )
      throw new RuntimeError("POLICY_UNCONFIRMED");
    const layout = evidence.layout;
    if (
      !layout.sourceCompleteness ||
      !layout.managedCompleteness ||
      !layout.startupPrecedence ||
      !layout.reloadPrecedence ||
      !layout.effortPrecedence
    )
      throw new RuntimeError("POLICY_UNCONFIRMED");
    if (root !== layout.root || !inside(layout.gitRoot, root))
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    if (
      this.environment.CLAUDE_CONFIG_DIR !== undefined &&
      this.environment.CLAUDE_CONFIG_DIR !== layout.configDirectory
    )
      throw new RuntimeError("POLICY_UNCONFIRMED");
    return evidence;
  }
  private snapshot(root: string, check: () => void) {
    const evidence = this.reviewed(root);
    check();
    for (const path of [
      root,
      evidence.layout.gitRoot,
      evidence.layout.mainCheckout,
      evidence.layout.configDirectory,
    ])
      canonicalAncestors(path);
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const rootIdentity = stableJson(
      [
        ...new Set([
          root,
          evidence.layout.gitRoot,
          evidence.layout.mainCheckout,
          evidence.layout.configDirectory,
        ]),
      ].map((path) => {
        const directory = lstatSync(path);
        if (
          !directory.isDirectory() ||
          directory.uid !== process.getuid?.() ||
          (directory.mode & 0o022) !== 0
        )
          throw new RuntimeError("POLICY_UNCONFIRMED");
        return {
          path,
          dev: directory.dev,
          ino: directory.ino,
          uid: directory.uid,
          mode: directory.mode,
        };
      }),
    );
    const existing = new Map(this.snapshots?.map((entry) => [entry.path, entry]));
    const next = [
      snapshotBinary(evidence.executable, existing.get(evidence.executable)),
      snapshotBinary(evidence.layout.fixture, existing.get(evidence.layout.fixture)),
      ...sources(evidence.layout).map((source) =>
        snapshotSource(source, existing.get(source.path)),
      ),
    ];
    check();
    if (next[0].hash !== evidence.executableHash || next[1].hash !== evidence.fixtureHash)
      throw new RuntimeError("SNAPSHOT_CHANGED");
    if (next.some((entry) => entry.managedConflict)) throw new RuntimeError("POLICY_UNCONFIRMED");
    const environmentHash = environmentIdentity(this.environment);
    if (
      this.snapshots &&
      (this.rootIdentity !== rootIdentity ||
        this.environmentHash !== environmentHash ||
        next.length !== this.snapshots.length ||
        next.some(
          (entry, i) =>
            entry.path !== this.snapshots![i].path ||
            entry.kind !== this.snapshots![i].kind ||
            entry.hash !== this.snapshots![i].hash ||
            (entry.kind !== "auth" && entry.identity !== this.snapshots![i].identity),
        ))
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    this.snapshots = next;
    this.rootIdentity = rootIdentity;
    this.environmentHash = environmentHash;
    this.fingerprintValue = digest(
      stableJson({
        revision,
        version: evidence.version,
        layout: evidence.layout,
        rootIdentity,
        environmentHash,
        sources: next.map(({ path, kind, hash }) => ({ path, kind, hash })),
      }),
    );
  }
  async admit(root: string, check: () => void) {
    this.snapshot(root, check);
  }
  assertLive(root: string, check: () => void) {
    this.reviewed(root);
    if (!this.snapshots) throw new RuntimeError("POLICY_UNCONFIRMED");
    this.snapshot(root, check);
  }
  private effort(settings: RuntimeSettings | null): string | null {
    const value = settings?.requested.effort ?? null;
    const inherited = [
      this.environment.CLAUDE_CODE_EFFORT_LEVEL,
      ...this.snapshots!.map((source) => source.env.CLAUDE_CODE_EFFORT_LEVEL),
    ].filter((entry) => entry !== undefined);
    if (value === null) {
      if (inherited.length && !this.evidence!.layout.nullableEffortUnaffected)
        throw new RuntimeError("POLICY_UNCONFIRMED");
    } else {
      if (!["low", "medium", "high", "xhigh", "max"].includes(value))
        throw new RuntimeError("UNSUPPORTED_SETTINGS");
      if (
        this.snapshots!.some(
          (source) =>
            source.kind === "managed" &&
            source.env.CLAUDE_CODE_EFFORT_LEVEL !== undefined &&
            source.env.CLAUDE_CODE_EFFORT_LEVEL !== value,
        )
      )
        throw new RuntimeError("POLICY_UNCONFIRMED");
    }
    return value;
  }
  transcriptPath(context: OwnedContext): string {
    const evidence = this.reviewed(context.root.path);
    if (!isId(context.threadId)) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    if (evidence.layout.transcriptEncoding !== "short-cwd-v1" || context.root.path.length > 200)
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const encoded = context.root.path.replace(/[^a-zA-Z0-9]/g, "-");
    return join(evidence.layout.configDirectory, "projects", encoded, `${context.threadId}.jsonl`);
  }
  async history(context: OwnedContext, check: () => void) {
    this.assertLive(context.root.path, check);
    return readOwnedHistory(
      this.transcriptPath(context),
      context.threadId,
      context.root.path,
      check,
    );
  }
  launch(
    context: OwnedContext,
    settings: RuntimeSettings | null,
    tools: readonly string[],
    resume: boolean,
  ): Launch {
    this.assertLive(context.root.path, () => {});
    const expectedTools = nativeToolNames(
      settings ? repositoryMode(settings, context) : "SELECTED",
      tools.includes(`mcp__${OWNED_SERVER}__ask_peer`),
    );
    if (
      !tools.length ||
      new Set(tools).size !== tools.length ||
      tools.length !== expectedTools.length ||
      expectedTools.some((tool) => !tools.includes(tool)) ||
      tools.some(
        (tool) =>
          !nativeToolNames(
            settings ? repositoryMode(settings, context) : "SELECTED",
            settings?.autoQuestionsConfirmed === true,
          ).includes(tool),
      ) ||
      (!settings?.autoQuestionsConfirmed && tools.includes(`mcp__${OWNED_SERVER}__ask_peer`))
    )
      throw new RuntimeError("POLICY_UNCONFIRMED");
    const stat = lstatSync(context.root.path);
    if (
      context.root.dev !== stat.dev ||
      context.root.ino !== stat.ino ||
      context.root.uid !== stat.uid
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const effort = this.effort(settings);
    const path = this.transcriptPath(context);
    const overlay = {
      disableAllHooks: true,
      enabledPlugins: Object.fromEntries(
        [...new Set(this.snapshots!.flatMap((source) => source.plugins))]
          .sort()
          .map((name) => [name, false]),
      ),
      env: effort === null ? {} : { CLAUDE_CODE_EFFORT_LEVEL: effort },
    };
    const args = [
      this.evidence!.layout.fixture,
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--tools",
      "",
      "--allowedTools",
      tools.join(","),
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify({ mcpServers: { [OWNED_SERVER]: { type: "sdk", name: OWNED_SERVER } } }),
      "--permission-mode",
      "dontAsk",
      "--settings",
      JSON.stringify(overlay),
    ];
    if (settings) args.push("--model", settings.requested.model);
    if (effort !== null) args.push("--effort", effort);
    args.push(resume ? "--resume" : "--session-id", resume ? path : context.threadId);
    const env: NodeJS.ProcessEnv = {
      ...providerEnvironment(this.environment),
      CLAUDE_CONFIG_DIR: this.evidence!.layout.configDirectory,
    };
    if (effort !== null) env.CLAUDE_CODE_EFFORT_LEVEL = effort;
    return { executable: this.evidence!.executable, args, cwd: context.root.path, env };
  }
}
