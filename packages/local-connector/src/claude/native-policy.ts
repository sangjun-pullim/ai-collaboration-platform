import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isId } from "../contracts.ts";
import {
  digest,
  RuntimeError,
  stableJson,
  type OwnedContext,
  type RuntimeSettings,
} from "../runtime-contracts.ts";
import { repositoryMode } from "../workspace/repository-access.ts";
import { nativeToolNames } from "../workspace/tool-contracts.ts";
import {
  canonicalAncestors,
  providerEnvironment,
  snapshotSource,
  type SourceSnapshot,
} from "./configuration.ts";
import { OWNED_SERVER } from "./input-proof.ts";
import {
  assertNativeEnvironment,
  assertNativeInstallation,
  verifyNativeInstallation,
  type NativeClaudeInstallation,
} from "./native-installation.ts";
import { nativeLayout, nativeSources, type NativeLayout } from "./native-sources.ts";
import { readOwnedHistory } from "./owned-history.ts";
import type { ClaudePolicy } from "./policy.ts";
import type { Launch } from "./transport.ts";

const revision = "claude-native-policy-030-v1";
const builtinPlugins = ["cc-plugin-agents-md@builtin", "cc-plugin-telemetry@builtin"];

/** Native authority is discovered lazily at admission, never supplied by a caller flag. */
export class NativeClaudePolicy implements ClaudePolicy {
  private installation: NativeClaudeInstallation | undefined;
  get version() {
    return this.installation?.version ?? "2.1.288";
  }
  private layout: NativeLayout | undefined;
  private snapshots: SourceSnapshot[] | undefined;
  private rootIdentity: string | undefined;
  private environmentHash: string | undefined;
  private fingerprintValue = "0".repeat(64);
  get fingerprint() {
    return this.fingerprintValue;
  }
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  private sourceSnapshot(root: string, check: () => void) {
    check();
    assertNativeEnvironment(this.environment);
    const home = realpathSync(homedir());
    const layout = nativeLayout(root, home, join(home, ".claude"));
    if (this.layout && stableJson(layout) !== stableJson(this.layout))
      throw new RuntimeError("SNAPSHOT_CHANGED");
    const identities = [
      ...new Set([root, layout.gitRoot, layout.mainCheckout, layout.configDirectory]),
    ].map((path) => {
      canonicalAncestors(path);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
        throw new RuntimeError("POLICY_UNCONFIRMED");
      return { path, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode };
    });
    const rootIdentity = stableJson(identities);
    const prior = new Map(this.snapshots?.map((source) => [source.path, source]));
    const next = nativeSources(layout, this.snapshots).map((source) =>
      snapshotSource(source, prior.get(source.path)),
    );
    const environmentHash = digest(stableJson(providerEnvironment(this.environment)));
    check();
    if (
      this.snapshots &&
      (rootIdentity !== this.rootIdentity ||
        environmentHash !== this.environmentHash ||
        next.length !== this.snapshots.length ||
        next.some((source, index) => {
          const previous = this.snapshots![index];
          return (
            source.path !== previous.path ||
            source.kind !== previous.kind ||
            source.hash !== previous.hash ||
            (source.kind !== "auth" && source.identity !== previous.identity)
          );
        }))
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    return { layout, next, rootIdentity, environmentHash };
  }

  async admit(root: string, check: () => void) {
    const sources = this.sourceSnapshot(root, check);
    const installation = await verifyNativeInstallation(
      root,
      this.environment,
      check,
      this.installation,
    );
    check();
    // The probes must not change the execution settings or identity before model input.
    const after = this.sourceSnapshot(root, check);
    if (
      stableJson(sources.next.map(({ path, kind, hash }) => ({ path, kind, hash }))) !==
        stableJson(after.next.map(({ path, kind, hash }) => ({ path, kind, hash }))) ||
      sources.rootIdentity !== after.rootIdentity ||
      sources.environmentHash !== after.environmentHash
    )
      throw new RuntimeError("SNAPSHOT_CHANGED");
    this.installation = installation;
    this.layout = after.layout;
    this.snapshots = after.next;
    this.rootIdentity = after.rootIdentity;
    this.environmentHash = after.environmentHash;
    this.fingerprintValue = digest(
      stableJson({
        revision,
        version: installation.version,
        executable: installation.binary.hash,
        accountHash: installation.accountHash,
        layout: after.layout,
        rootIdentity: after.rootIdentity,
        environmentHash: after.environmentHash,
        sources: after.next.map(({ path, kind, hash }) => ({ path, kind, hash })),
      }),
    );
  }

  assertLive(root: string, check: () => void) {
    if (!this.installation || !this.snapshots) throw new RuntimeError("POLICY_UNCONFIRMED");
    assertNativeInstallation(this.installation, check);
    const current = this.sourceSnapshot(root, check);
    this.snapshots = current.next;
  }

  private transcriptPath(context: OwnedContext) {
    this.assertLive(context.root.path, () => {});
    if (!isId(context.threadId) || context.root.path.length > 200)
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const encoded = context.root.path.replace(/[^a-zA-Z0-9]/g, "-");
    return join(this.installation!.projectsDirectory, encoded, `${context.threadId}.jsonl`);
  }
  async history(context: OwnedContext, check: () => void) {
    this.assertLive(context.root.path, check);
    const history = await readOwnedHistory(
      this.transcriptPath(context),
      context.threadId,
      context.root.path,
      check,
    );
    return { ...history, format: "claude-jsonl-v1" as const };
  }

  launch(
    context: OwnedContext,
    settings: RuntimeSettings | null,
    tools: readonly string[],
    resume: boolean,
  ): Launch {
    this.assertLive(context.root.path, () => {});
    const expected = nativeToolNames(
      settings ? repositoryMode(settings, context) : "SELECTED",
      tools.includes(`mcp__${OWNED_SERVER}__ask_peer`),
    );
    if (
      new Set(tools).size !== tools.length ||
      tools.length !== expected.length ||
      expected.some((tool) => !tools.includes(tool)) ||
      (!settings?.autoQuestionsConfirmed && tools.includes(`mcp__${OWNED_SERVER}__ask_peer`))
    )
      throw new RuntimeError("POLICY_UNCONFIRMED");
    const stat = lstatSync(context.root.path);
    if (
      context.root.dev !== stat.dev ||
      context.root.ino !== stat.ino ||
      context.root.uid !== stat.uid ||
      context.provider !== "claude" ||
      context.materialization?.version !== this.version ||
      context.materialization.policyFingerprint !== this.fingerprint ||
      !isId(context.threadId)
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const effort = settings?.requested.effort ?? null;
    if (effort !== null && !["low", "medium", "high", "xhigh", "max"].includes(effort))
      throw new RuntimeError("UNSUPPORTED_SETTINGS");
    const overlay = {
      disableAllHooks: true,
      autoMemoryEnabled: false,
      enabledPlugins: Object.fromEntries(
        [...new Set([...builtinPlugins, ...this.snapshots!.flatMap((source) => source.plugins)])]
          .sort()
          .map((name) => [name, false]),
      ),
      env: {
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "0",
        CLAUDE_CODE_TRANSCRIPT_LOCAL_GC: "0",
        CLAUDE_CODE_SKIP_PROMPT_HISTORY: "0",
        CLAUDE_CODE_FORK_SUBAGENT: "0",
        ...(effort === null ? {} : { CLAUDE_CODE_EFFORT_LEVEL: effort }),
      },
    };
    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--replay-user-messages",
      "--setting-sources",
      "user,project,local",
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
    args.push(resume ? "--resume" : "--session-id", context.threadId);
    // Validate the exact filename even for creation; never pass it as a display-name resume value.
    this.transcriptPath(context);
    const env = { ...providerEnvironment(this.environment), ...overlay.env };
    return { executable: this.installation!.executable, args, cwd: context.root.path, env };
  }
}
