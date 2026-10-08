import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { RuntimeError } from "../runtime-contracts.ts";
import {
  canonicalAncestors,
  readConfigurationFile,
  type ConfigurationSource,
  type SourceSnapshot,
} from "./configuration.ts";

export interface NativeLayout {
  root: string;
  gitRoot: string;
  mainCheckout: string;
  home: string;
  configDirectory: string;
  projectsDirectory: string;
}
const unsupported = () => new RuntimeError("POLICY_UNCONFIRMED");
function exists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw unsupported();
  }
}

/** Managed sources have higher priority than task overrides; initial personal support excludes them. */
export function assertNoManagedSources(home: string, configDirectory: string) {
  for (const path of [
    "/Library/Application Support/ClaudeCode/managed-settings.json",
    "/Library/Application Support/ClaudeCode/managed-settings.d",
    "/Library/Application Support/ClaudeCode/managed-mcp.json",
    "/Library/Application Support/ClaudeCode/CLAUDE.md",
    "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    "/Library/Preferences/com.anthropic.claudecode.plist",
    join(home, "Library", "Managed Preferences", "com.anthropic.claudecode.plist"),
    join(home, "Library", "Preferences", "com.anthropic.claudecode.plist"),
    join(configDirectory, "managed-settings.json"),
    join(configDirectory, "remote-settings.json"),
  ]) {
    canonicalAncestors(path);
    if (exists(path)) throw unsupported();
  }
}

function gitRoots(root: string, home: string): { gitRoot: string; mainCheckout: string } {
  let current = root;
  for (;;) {
    const path = join(current, ".git");
    const stat = exists(path);
    if (stat) {
      canonicalAncestors(path);
      if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw unsupported();
      if (stat.isDirectory()) return { gitRoot: current, mainCheckout: current };
      if (!stat.isFile()) throw unsupported();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        readConfigurationFile(path, 8192)!,
      );
      const match = /^gitdir: ([^\0\r\n]+)\n?$/.exec(text);
      if (!match) throw unsupported();
      const gitDirectory = resolve(current, match[1]);
      canonicalAncestors(gitDirectory);
      const common = readConfigurationFile(join(gitDirectory, "commondir"), 8192);
      if (!common) throw unsupported();
      const commonText = new TextDecoder("utf-8", { fatal: true }).decode(common).trim();
      if (!commonText || /[\0\r\n]/.test(commonText)) throw unsupported();
      const commonDirectory = resolve(gitDirectory, commonText);
      canonicalAncestors(commonDirectory);
      if (!commonDirectory.endsWith("/.git") || realpathSync(commonDirectory) !== commonDirectory)
        throw unsupported();
      const mainCheckout = dirname(commonDirectory);
      if (mainCheckout === home) throw unsupported();
      return { gitRoot: current, mainCheckout };
    }
    const next = dirname(current);
    if (next === current) return { gitRoot: root, mainCheckout: root };
    current = next;
  }
}

export function nativeLayout(root: string, home: string, configDirectory: string): NativeLayout {
  for (const path of [root, home, configDirectory]) canonicalAncestors(path);
  const roots = gitRoots(root, home);
  return {
    root,
    ...roots,
    home,
    configDirectory,
    projectsDirectory: join(configDirectory, "projects"),
  };
}

function ruleFiles(directory: string): string[] {
  const files: string[] = [];
  function visit(path: string, depth: number) {
    const stat = exists(path);
    if (!stat) return;
    canonicalAncestors(path);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      depth > 16
    )
      throw unsupported();
    const children = readdirSync(path, { withFileTypes: true });
    if (children.length > 256) throw unsupported();
    for (const child of children) {
      const next = join(path, child.name);
      if (child.isSymbolicLink()) throw unsupported();
      if (child.isDirectory()) visit(next, depth + 1);
      else if (child.isFile() && child.name.endsWith(".md")) files.push(next);
      if (files.length > 256) throw unsupported();
    }
  }
  visit(directory, 0);
  return files.sort();
}

function importedInstructions(
  path: string,
  home: string,
  depth = 0,
  seen = new Set<string>(),
): string[] {
  if (seen.has(path)) return [];
  if (seen.size >= 256) throw unsupported();
  seen.add(path);
  const bytes = readConfigurationFile(path);
  if (!bytes || depth === 4) return [];
  const text = new TextDecoder("utf-8", { fatal: true })
    .decode(bytes)
    .replace(/```[^]*?```|~~~[^]*?~~~|`[^`]*`/g, "");
  const paths: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@((?:\\ |[^\s`"'])+)/g)) {
    const value = match[1].replace(/\\ /g, " ");
    const imported = value.startsWith("~/")
      ? join(home, value.slice(2))
      : resolve(dirname(path), value);
    if (/^(?:\/net\/|\/Network\/|\\\\)/.test(imported)) throw unsupported();
    canonicalAncestors(imported);
    paths.push(imported, ...importedInstructions(imported, home, depth + 1, seen));
  }
  return paths;
}

/** Re-discovery also catches new sources. It never edits personal files or invokes git hooks. */
export function nativeSources(
  layout: NativeLayout,
  prior?: readonly SourceSnapshot[],
): ConfigurationSource[] {
  assertNoManagedSources(layout.home, layout.configDirectory);
  const sources: ConfigurationSource[] = [
    { path: join(layout.configDirectory, "settings.json"), kind: "user" },
    { path: join(layout.configDirectory, ".credentials.json"), kind: "auth" },
    {
      path: join(layout.home, ".claude.json"),
      kind: "auth",
      projection: "native-global",
      projectionRoots: [...new Set([layout.root, layout.gitRoot, layout.mainCheckout])],
    },
    { path: join(layout.root, ".claude", "settings.json"), kind: "project" },
    { path: join(layout.root, ".claude", "settings.local.json"), kind: "local" },
    { path: join(layout.gitRoot, ".claude", "settings.local.json"), kind: "local" },
    { path: join(layout.mainCheckout, ".claude", "settings.local.json"), kind: "local" },
    { path: join(layout.configDirectory, "CLAUDE.md"), kind: "instruction" },
    ...ruleFiles(join(layout.configDirectory, "rules")).map((path): ConfigurationSource => ({
      path,
      kind: "instruction",
    })),
  ];
  let parent = layout.root;
  for (;;) {
    const beneathHome = relative(layout.home, parent);
    const owned = beneathHome === "" || (!beneathHome.startsWith("..") && !isAbsolute(beneathHome));
    for (const name of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) {
      const path = join(parent, name);
      // Files above the private scope cannot silently introduce an unreviewed source.
      if (!owned && !exists(path)) continue;
      sources.push({ path, kind: "instruction" });
    }
    sources.push(
      ...ruleFiles(join(parent, ".claude", "rules")).map((path): ConfigurationSource => ({
        path,
        kind: "instruction",
      })),
    );
    const next = dirname(parent);
    if (parent === next) break;
    parent = next;
  }
  if (prior) {
    // Unchanged instructions reuse their discovered imports; snapshotSource still checks every identity.
    sources.push(
      ...prior
        .filter((source) => source.kind === "instruction")
        .map((source): ConfigurationSource => ({ path: source.path, kind: "instruction" })),
    );
  } else
    for (const source of [...sources]) {
      if (source.kind === "instruction")
        sources.push(
          ...importedInstructions(source.path, layout.home).map((path): ConfigurationSource => ({
            path,
            kind: "instruction",
          })),
        );
    }
  const byPath = new Map<string, ConfigurationSource>();
  for (const source of sources) {
    const existing = byPath.get(source.path);
    // Importing a settings file cannot remove its structured authority checks or projection.
    if (!existing || existing.kind === "instruction") byPath.set(source.path, source);
  }
  const unique = [...byPath.values()];
  if (unique.length > 512) throw unsupported();
  return unique.map((source) => ({ ...source, nativeReadOnly: true }));
}
