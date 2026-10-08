/** Pure public source schema. Keep this file identical in the independently shipped connector. */
export const sourceVersion = 2 as const;
export const sourceManifestByteLimit = 4 * 1024 * 1024;
export const sourceChunkByteLimit = 8192;
export const sourcePacketLimit = 512;
export const sourceFileLimit = 4096;
export type SourceAction = "source-support" | "source-upload" | "source-confirm" | "source-read";
export interface SourceIdentity {
  agentId: string;
  bindingEpoch: number;
  requestId: string;
  attemptId: string;
  fence: number;
}
export interface SourcePacket {
  version: 2;
  index: number;
  count: number;
  totalBytes: number;
  manifestHash: string;
  chunkHash: string;
  bytesBase64: string;
}
export interface SourceSupport {
  version: 2;
  agentId: string;
  bindingEpoch: number;
}
export interface SourceConfirmation extends SourceIdentity {
  version: 2;
  manifestHash: string;
  state: "NO_TARGET_SNAPSHOT" | "ABSENT" | "PARTIAL" | "CONFIRMED";
  count: number | null;
  totalBytes: number | null;
  nextMissingIndex: number;
}
export interface SourceAcknowledgement extends SourceIdentity {
  version: 2;
  manifestHash: string;
  operationId: string;
  index: number;
  chunkHash: string;
}
export interface PublicSourceInput {
  version: 1;
  kind: "INPUT_SOURCE_OBSERVATION";
  git: { observedAt: string; commit: string | null; refJson: string | null; dirty: "unknown" };
  files: {
    validatedAt: string;
    pathBase: "SELECTED_ROOT";
    entries: { pathJson: string; hash: string }[];
    manifestHash: string;
  };
  observationHash: string;
}
export interface PublicSourceExcerpt {
  excerptIndex: number;
  pathJson: string;
  hash: string;
  readAt: string;
  byteStart: number;
  byteEnd: number;
  excerptHash: string;
}
export interface PublicPeerExcerpt extends PublicSourceExcerpt {
  lineCount: number;
  requestedStartLine: number;
  requestedEndLine: number;
}
export type PublicSourceCall =
  | {
      callIndex: number;
      kind: "REPOSITORY_TOOL_OBSERVATION";
      tool: "list_workspace_files" | "search_workspace" | "read_workspace_file";
      resultHash: string;
      files: PublicSourceExcerpt[];
    }
  | {
      callIndex: number;
      kind: "PEER_EVIDENCE_OBSERVATION";
      purpose: "VERIFIED_FOR_PEER_QUESTION";
      questionOperationId: string;
      files: PublicPeerExcerpt[];
    };
export interface PublicSourceManifest {
  version: 2;
  kind: "RUN_SOURCE_MANIFEST";
  readMode: "SELECTED" | "AUTO_CODE";
  input: PublicSourceInput;
  calls: PublicSourceCall[];
}
export interface SourceTarget {
  requestId: string;
  agentId: string;
  bindingEpoch: number;
  ownerAlias: string;
  sessionAlias: string;
  repositoryAlias: string;
  runtime: "codex" | "claude";
  reservedAt: string;
}
export interface SourceSummary {
  readMode: "SELECTED" | "AUTO_CODE";
  input: Omit<PublicSourceInput, "files"> & {
    files: Omit<PublicSourceInput["files"], "entries"> & { entryCount: number };
  };
  callCount: number;
  repositoryCallCount: number;
  peerCallCount: number;
  listCallCount: number;
  fileCount: number;
}
export interface SourceFileRow {
  index: number;
  phase: "INPUT" | "REPOSITORY" | "PEER";
  callIndex: number | null;
  excerptIndex: number;
  tool: "list_workspace_files" | "search_workspace" | "read_workspace_file" | null;
  resultHash: string | null;
  questionOperationId: string | null;
  pathJson: string;
  hash: string;
  readAt: string | null;
  byteStart: number | null;
  byteEnd: number | null;
  excerptHash: string | null;
  lineCount: number | null;
  requestedStartLine: number | null;
  requestedEndLine: number | null;
}
export interface SourceReadPage {
  version: 2;
  roomId: string;
  eventId: string;
  state: "NO_TARGET_SNAPSHOT" | "NO_SOURCE" | "CONFIRMED";
  target: SourceTarget | null;
  manifestHash: string | null;
  summary: SourceSummary | null;
  files: SourceFileRow[];
  nextIndex: number | null;
}
export const sourceHash = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
export const sourceId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const sourceUint = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
export const sourceExact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => Object.hasOwn(v, k));
export const sourceTime = (v: unknown): v is string =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export function sourceStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sourceStableJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${sourceStableJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}
/** JSON.parse here is JS UTF16, never a PostgreSQL inner jsonb decode. */
export function decodeSourceToken(token: unknown): string | undefined {
  if (typeof token !== "string" || token.length > 3074) return undefined;
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === "string" && JSON.stringify(value) === token ? value : undefined;
  } catch {
    return undefined;
  }
}
export function validPathToken(token: unknown): boolean {
  const path = decodeSourceToken(token);
  return (
    path !== undefined &&
    path.length > 0 &&
    path.length <= 512 &&
    !path.startsWith("/") &&
    !/[\\\0\r\n]/.test(path) &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== "." &&
          part !== ".." &&
          !/^(?:\.git|\.codex|\.claude|\.agents|\.ssh|\.aws|\.config|node_modules|\.next|\.cache|cache|credentials?|auth(?:\.json)?|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|sqlite|db))$/i.test(
            part,
          ),
      )
  );
}
export function validRefToken(token: unknown): boolean {
  if (token === null) return true;
  const ref = decodeSourceToken(token);
  return (
    ref !== undefined &&
    (ref === "unknown" ||
      (ref.length <= 120 &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
        !ref.includes("..") &&
        !ref.includes("//") &&
        !ref.endsWith("/") &&
        !ref.endsWith(".lock") &&
        !ref.endsWith(".")))
  );
}
/** AUTO files use the original repository file policy; implementation code in auth directories is legal. */
export function validRepositoryPathToken(token: unknown): boolean {
  const path = decodeSourceToken(token);
  if (
    path === undefined ||
    !path.length ||
    path.length > 512 ||
    path.startsWith("/") ||
    /[\\\0\r\n]/.test(path)
  )
    return false;
  const parts = path.split("/");
  const material = /\.(?:pem|key|p12|pfx|sqlite(?:3)?|db|der|crt|cer|keystore|jks)$/i;
  const document =
    /\.(?:md|mdx|txt|rst|adoc|json|jsonc|yaml|yml|toml|xml|ini|conf|properties|csv|tsv)$/i;
  const protectedFile =
    /^(?:AGENTS\.md|CLAUDE\.md|CODEX\.md|mcp\.json|settings\.(?:json|jsonc|yaml|yml|toml)|(?:auth|authentication|credentials?|secrets?|tokens?|passwords?|api[._-]?keys?|access[._-]?tokens?|client[._-]?secrets?)(?:[._-].*)?|(?:settings|config)\.(?:local\.)?(?:claude|codex|mcp)\..*|(?:claude|codex|agent)[._-]settings(?:[._-].*)?)$/i;
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || part.startsWith(".") || material.test(part),
    )
  )
    return false;
  const name = parts.pop()!;
  if (
    parts.some(
      (part) =>
        /^(?:node_modules|vendor|build|dist|coverage|cache|target|out|bower_components|credentials?|secrets?|__generated__|__pycache__)$/i.test(
          part,
        ) ||
        /^(?:AGENTS\.md|CLAUDE\.md|CODEX\.md|mcp\.json|auth\.json)$/i.test(part) ||
        (document.test(part) && protectedFile.test(part)),
    )
  )
    return false;
  if (/\.(?:min|bundle|generated)\./i.test(name)) return false;
  if (
    /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|m|mm|php|sh|bash|zsh|sql|vue|svelte|html|css|scss|sass|less|graphql|gql|proto)$/i.test(
      name,
    )
  )
    return true;
  return (
    !protectedFile.test(name) &&
    (document.test(name) || /^(?:LICENSE|NOTICE|README|Dockerfile|Makefile)$/i.test(name))
  );
}
function validGit(v: unknown): boolean {
  return (
    sourceExact(v, ["observedAt", "commit", "refJson", "dirty"]) &&
    sourceTime(v.observedAt) &&
    (v.commit === null ||
      (typeof v.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.commit))) &&
    validRefToken(v.refJson) &&
    v.dirty === "unknown"
  );
}
export function validPublicSourceInput(v: unknown): v is PublicSourceInput {
  if (
    !sourceExact(v, ["version", "kind", "git", "files", "observationHash"]) ||
    v.version !== 1 ||
    v.kind !== "INPUT_SOURCE_OBSERVATION" ||
    !validGit(v.git) ||
    !sourceExact(v.files, ["validatedAt", "pathBase", "entries", "manifestHash"]) ||
    !sourceTime(v.files.validatedAt) ||
    v.files.pathBase !== "SELECTED_ROOT" ||
    !sourceHash(v.files.manifestHash) ||
    !sourceHash(v.observationHash) ||
    !Array.isArray(v.files.entries) ||
    v.files.entries.length > 32
  )
    return false;
  return v.files.entries.every(
    (e, i, entries) =>
      sourceExact(e, ["pathJson", "hash"]) &&
      validPathToken(e.pathJson) &&
      sourceHash(e.hash) &&
      (i === 0 || decodeSourceToken(entries[i - 1].pathJson)! < decodeSourceToken(e.pathJson)!),
  );
}
function validExcerpt(v: unknown, peer: boolean, index: number): boolean {
  const keys = [
    "excerptIndex",
    "pathJson",
    "hash",
    "readAt",
    "byteStart",
    "byteEnd",
    "excerptHash",
    ...(peer ? ["lineCount", "requestedStartLine", "requestedEndLine"] : []),
  ];
  return (
    sourceExact(v, keys) &&
    v.excerptIndex === index &&
    validRepositoryPathToken(v.pathJson) &&
    sourceHash(v.hash) &&
    sourceTime(v.readAt) &&
    sourceUint(v.byteStart, 2097152) &&
    sourceUint(v.byteEnd, 2097152) &&
    v.byteEnd >= v.byteStart &&
    sourceHash(v.excerptHash) &&
    (!peer ||
      (sourceUint(v.lineCount, 2097153) &&
        v.lineCount > 0 &&
        sourceUint(v.requestedStartLine, 2097153) &&
        v.requestedStartLine > 0 &&
        sourceUint(v.requestedEndLine, 2097153) &&
        v.requestedEndLine >= v.requestedStartLine &&
        v.requestedEndLine <= v.lineCount))
  );
}
export function validPublicSourceManifest(v: unknown): v is PublicSourceManifest {
  if (
    !sourceExact(v, ["version", "kind", "readMode", "input", "calls"]) ||
    v.version !== 2 ||
    v.kind !== "RUN_SOURCE_MANIFEST" ||
    !["SELECTED", "AUTO_CODE"].includes(String(v.readMode)) ||
    !validPublicSourceInput(v.input) ||
    !Array.isArray(v.calls) ||
    v.calls.length > 256 ||
    (v.readMode === "SELECTED" ? v.calls.length !== 0 : v.input.files.entries.length !== 0)
  )
    return false;
  let previous = -1,
    files = 0;
  for (const c of v.calls) {
    if (!c || !sourceUint(c.callIndex, 255) || c.callIndex <= previous || !Array.isArray(c.files))
      return false;
    previous = c.callIndex;
    files += c.files.length;
    const peer = c.kind === "PEER_EVIDENCE_OBSERVATION";
    if (
      peer
        ? !sourceExact(c, ["callIndex", "kind", "purpose", "questionOperationId", "files"]) ||
          c.purpose !== "VERIFIED_FOR_PEER_QUESTION" ||
          !sourceId(c.questionOperationId) ||
          c.files.length < 1 ||
          c.files.length > 4
        : !sourceExact(c, ["callIndex", "kind", "tool", "resultHash", "files"]) ||
          c.kind !== "REPOSITORY_TOOL_OBSERVATION" ||
          !sourceHash(c.resultHash) ||
          !["list_workspace_files", "search_workspace", "read_workspace_file"].includes(
            String(c.tool),
          ) ||
          c.files.length >
            (c.tool === "list_workspace_files" ? 0 : c.tool === "read_workspace_file" ? 1 : 16)
    )
      return false;
    if (!c.files.every((f: unknown, i: number) => validExcerpt(f, peer, i))) return false;
  }
  return (
    files <= sourceFileLimit &&
    new TextEncoder().encode(sourceStableJson(v)).length <= sourceManifestByteLimit
  );
}
export function validSourcePacket(v: unknown): v is SourcePacket {
  if (
    !sourceExact(v, [
      "version",
      "index",
      "count",
      "totalBytes",
      "manifestHash",
      "chunkHash",
      "bytesBase64",
    ]) ||
    v.version !== 2 ||
    !sourceUint(v.index, 511) ||
    !sourceUint(v.count, 512) ||
    v.count < 1 ||
    v.index >= v.count ||
    !sourceUint(v.totalBytes, sourceManifestByteLimit) ||
    v.totalBytes < 1 ||
    Math.ceil(v.totalBytes / sourceChunkByteLimit) !== v.count ||
    !sourceHash(v.manifestHash) ||
    !sourceHash(v.chunkHash) ||
    typeof v.bytesBase64 !== "string" ||
    v.bytesBase64.length > 10924 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.bytesBase64)
  )
    return false;
  const b = v.bytesBase64,
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (
    (b.endsWith("==") && (alphabet.indexOf(b.at(-3)!) & 15) !== 0) ||
    (b.endsWith("=") && !b.endsWith("==") && (alphabet.indexOf(b.at(-2)!) & 3) !== 0)
  )
    return false;
  const bytes = (b.length / 4) * 3 - (b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0);
  return (
    bytes ===
    (v.index === v.count - 1
      ? v.totalBytes - sourceChunkByteLimit * (v.count - 1)
      : sourceChunkByteLimit)
  );
}
export function validPacketJson(v: unknown): boolean {
  if (typeof v !== "string" || new TextEncoder().encode(v).length > 15020) return false;
  try {
    const packet: unknown = JSON.parse(v);
    return (
      validSourcePacket(packet) &&
      JSON.stringify({
        version: packet.version,
        index: packet.index,
        count: packet.count,
        totalBytes: packet.totalBytes,
        manifestHash: packet.manifestHash,
        chunkHash: packet.chunkHash,
        bytesBase64: packet.bytesBase64,
      }) === v
    );
  } catch {
    return false;
  }
}
export function validSourceIdentity(v: Record<string, unknown>): boolean {
  return (
    sourceId(v.agentId) &&
    sourceUint(v.bindingEpoch) &&
    v.bindingEpoch > 0 &&
    sourceId(v.requestId) &&
    sourceId(v.attemptId) &&
    sourceUint(v.fence) &&
    v.fence > 0
  );
}
export function validSourceResponse(action: SourceAction, v: unknown): boolean {
  if (new TextEncoder().encode(JSON.stringify(v) ?? "").length > 16384) return false;
  if (action === "source-support")
    return (
      sourceExact(v, ["version", "agentId", "bindingEpoch"]) &&
      v.version === 2 &&
      sourceId(v.agentId) &&
      sourceUint(v.bindingEpoch) &&
      v.bindingEpoch > 0
    );
  const identity = ["agentId", "bindingEpoch", "requestId", "attemptId", "fence"];
  if (action === "source-upload")
    return (
      sourceExact(v, [
        ...identity,
        "version",
        "manifestHash",
        "operationId",
        "index",
        "chunkHash",
      ]) &&
      v.version === 2 &&
      validSourceIdentity(v) &&
      sourceHash(v.manifestHash) &&
      sourceId(v.operationId) &&
      sourceUint(v.index, 511) &&
      sourceHash(v.chunkHash)
    );
  if (action === "source-confirm") {
    if (
      !sourceExact(v, [
        ...identity,
        "version",
        "manifestHash",
        "state",
        "count",
        "totalBytes",
        "nextMissingIndex",
      ]) ||
      v.version !== 2 ||
      !validSourceIdentity(v) ||
      !sourceHash(v.manifestHash) ||
      !sourceUint(v.nextMissingIndex, 512)
    )
      return false;
    if (v.state === "ABSENT" || v.state === "NO_TARGET_SNAPSHOT")
      return v.count === null && v.totalBytes === null && v.nextMissingIndex === 0;
    return (
      (v.state === "PARTIAL" || v.state === "CONFIRMED") &&
      sourceUint(v.count, 512) &&
      v.count > 0 &&
      sourceUint(v.totalBytes, sourceManifestByteLimit) &&
      v.totalBytes > 0 &&
      Math.ceil(v.totalBytes / 8192) === v.count &&
      (v.state === "CONFIRMED" ? v.nextMissingIndex === v.count : v.nextMissingIndex < v.count)
    );
  }
  return validSourceReadPage(v);
}
const nullable = (v: unknown, check: (v: unknown) => boolean) => v === null || check(v);
const alias = (v: unknown) =>
  typeof v === "string" &&
  v.length > 0 &&
  Array.from(v).length <= 80 &&
  !/[\u0000-\u001f\u007f]/.test(v);
function validTarget(v: unknown): v is SourceTarget {
  return (
    sourceExact(v, [
      "requestId",
      "agentId",
      "bindingEpoch",
      "ownerAlias",
      "sessionAlias",
      "repositoryAlias",
      "runtime",
      "reservedAt",
    ]) &&
    sourceId(v.requestId) &&
    sourceId(v.agentId) &&
    sourceUint(v.bindingEpoch) &&
    v.bindingEpoch > 0 &&
    alias(v.ownerAlias) &&
    alias(v.sessionAlias) &&
    alias(v.repositoryAlias) &&
    ["codex", "claude"].includes(String(v.runtime)) &&
    typeof v.reservedAt === "string" &&
    Number.isFinite(Date.parse(v.reservedAt))
  );
}
function validSummary(v: unknown): v is SourceSummary {
  if (
    !sourceExact(v, [
      "readMode",
      "input",
      "callCount",
      "repositoryCallCount",
      "peerCallCount",
      "listCallCount",
      "fileCount",
    ]) ||
    !["SELECTED", "AUTO_CODE"].includes(String(v.readMode)) ||
    ![v.callCount, v.repositoryCallCount, v.peerCallCount, v.listCallCount].every((n) =>
      sourceUint(n, 256),
    ) ||
    !sourceUint(v.fileCount, 4096) ||
    Number(v.repositoryCallCount) + Number(v.peerCallCount) !== v.callCount
  )
    return false;
  const input = v.input;
  return (
    sourceExact(input, ["version", "kind", "git", "files", "observationHash"]) &&
    input.version === 1 &&
    input.kind === "INPUT_SOURCE_OBSERVATION" &&
    validGit(input.git) &&
    sourceHash(input.observationHash) &&
    sourceExact(input.files, ["validatedAt", "pathBase", "entryCount", "manifestHash"]) &&
    sourceTime(input.files.validatedAt) &&
    input.files.pathBase === "SELECTED_ROOT" &&
    sourceUint(input.files.entryCount, 32) &&
    sourceHash(input.files.manifestHash) &&
    Number(v.listCallCount) <= Number(v.repositoryCallCount) &&
    (v.readMode === "SELECTED"
      ? v.callCount === 0 && v.fileCount === input.files.entryCount
      : input.files.entryCount === 0)
  );
}
function validRow(v: unknown): v is SourceFileRow {
  if (
    !sourceExact(v, [
      "index",
      "phase",
      "callIndex",
      "excerptIndex",
      "tool",
      "resultHash",
      "questionOperationId",
      "pathJson",
      "hash",
      "readAt",
      "byteStart",
      "byteEnd",
      "excerptHash",
      "lineCount",
      "requestedStartLine",
      "requestedEndLine",
    ]) ||
    !sourceUint(v.index, 4095) ||
    !sourceUint(v.excerptIndex, 31) ||
    !(v.phase === "INPUT" ? validPathToken(v.pathJson) : validRepositoryPathToken(v.pathJson)) ||
    !sourceHash(v.hash)
  )
    return false;
  if (v.phase === "INPUT")
    return (
      v.callIndex === null &&
      v.tool === null &&
      v.resultHash === null &&
      v.questionOperationId === null &&
      v.readAt === null &&
      v.byteStart === null &&
      v.byteEnd === null &&
      v.excerptHash === null &&
      v.lineCount === null &&
      v.requestedStartLine === null &&
      v.requestedEndLine === null
    );
  if (
    !sourceUint(v.callIndex, 255) ||
    !sourceTime(v.readAt) ||
    !sourceUint(v.byteStart, 2097152) ||
    !sourceUint(v.byteEnd, 2097152) ||
    v.byteEnd < v.byteStart ||
    !sourceHash(v.excerptHash)
  )
    return false;
  if (v.phase === "REPOSITORY")
    return (
      ["search_workspace", "read_workspace_file"].includes(String(v.tool)) &&
      sourceHash(v.resultHash) &&
      v.questionOperationId === null &&
      v.lineCount === null &&
      v.requestedStartLine === null &&
      v.requestedEndLine === null &&
      v.excerptIndex < (v.tool === "read_workspace_file" ? 1 : 16)
    );
  return (
    v.phase === "PEER" &&
    v.excerptIndex < 4 &&
    v.tool === null &&
    v.resultHash === null &&
    sourceId(v.questionOperationId) &&
    sourceUint(v.lineCount, 2097153) &&
    v.lineCount > 0 &&
    sourceUint(v.requestedStartLine, 2097153) &&
    v.requestedStartLine > 0 &&
    sourceUint(v.requestedEndLine, 2097153) &&
    v.requestedEndLine >= v.requestedStartLine &&
    v.requestedEndLine <= v.lineCount
  );
}
export function validSourceReadPage(v: unknown): v is SourceReadPage {
  if (
    !sourceExact(v, [
      "version",
      "roomId",
      "eventId",
      "state",
      "target",
      "manifestHash",
      "summary",
      "files",
      "nextIndex",
    ]) ||
    v.version !== 2 ||
    !sourceId(v.roomId) ||
    !sourceId(v.eventId) ||
    !Array.isArray(v.files) ||
    v.files.length > 4 ||
    !v.files.every(validRow) ||
    !nullable(v.nextIndex, (n) => sourceUint(n, 4095))
  )
    return false;
  if (v.state === "NO_TARGET_SNAPSHOT")
    return (
      v.target === null &&
      v.manifestHash === null &&
      v.summary === null &&
      v.files.length === 0 &&
      v.nextIndex === null
    );
  if (!validTarget(v.target)) return false;
  if (v.state === "NO_SOURCE")
    return (
      v.manifestHash === null && v.summary === null && v.files.length === 0 && v.nextIndex === null
    );
  if (v.state !== "CONFIRMED" || !sourceHash(v.manifestHash) || !validSummary(v.summary))
    return false;
  const summary = v.summary as SourceSummary,
    files = v.files as SourceFileRow[];
  return (
    files.every(
      (r, i) => r.index < summary.fileCount && (i === 0 || r.index === files[i - 1].index + 1),
    ) &&
    (v.nextIndex === null
      ? files.length === 0 || files.at(-1)!.index === summary.fileCount - 1
      : files.length > 0 &&
        v.nextIndex === files.at(-1)!.index &&
        Number(v.nextIndex) < summary.fileCount - 1)
  );
}
