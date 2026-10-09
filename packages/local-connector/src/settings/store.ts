import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StateStore } from "../state-store.ts";
import { RuntimeStore } from "../runtime-store.ts";
import { serviceOrigin } from "../central-client.ts";
import {
  repositoryMode,
  validRepositoryAccess,
  rootIdentityHash,
} from "../workspace/repository-access.ts";
import { isSelectedPath, publicText } from "../runtime-file-policy.ts";
import {
  codexVersion,
  digest,
  stableJson,
  RuntimeError,
  type OwnedContext,
  type RootIdentity,
  type RuntimeSettings,
  type FileSnapshot,
} from "../runtime-contracts.ts";
import {
  isId,
  isHash,
  projectCapability,
  isModelDisplayName,
  projectResponse,
  validateBody,
  validateSelection,
  type Operation,
  type Receipt,
  type Body,
} from "./contracts.ts";

export type GenerationPointer = {
  generation: string;
  agentId: string;
  workspaceId: string;
  bindingEpoch: number;
  configRevision: number;
  provider: "codex" | "claude";
  localRootReference: string;
  legacy?: boolean;
};
export type SetupJournal = {
  operation: Operation;
  phase:
    | "CHOOSING"
    | "CATALOG_INTENT"
    | "LOCAL_CONFIRMATION"
    | "APPLYING"
    | "PREPARE_INTENT"
    | "PREPARED"
    | "COMMIT_INTENT"
    | "COMMITTED"
    | "LOCAL_COMMITTED"
    | "APPLIED"
    | "CANCEL_INTENT"
    | "CANCELLED"
    | "FAILED"
    | "UNKNOWN";
  generation: string;
  localRootReference: string;
  root: RootIdentity | null;
  settings: RuntimeSettings | null;
  context: OwnedContext | null;
  receipt: Receipt | null;
  reason: string | null;
  catalogContext?: OwnedContext | null;
  previous?: GenerationPointer | null;
  repositoryAccess?: RuntimeSettings["repositoryAccess"];
  files?: FileSnapshot[];
  handoff?: string;
  applyBody?: Body;
  applyHash?: string;
  commitBody?: Receipt;
};
export type SettingsState = {
  version: 1;
  server: string;
  deviceId: string;
  organizationId: string;
  roomId: string;
  current: GenerationPointer | null;
  retained: GenerationPointer[];
  journal: SetupJournal | null;
};

const limit = 256 * 1024;
type Check = (value: unknown) => boolean;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const exact =
  (shape: Record<string, Check>, optional: Record<string, Check> = {}): Check =>
  (v) =>
    object(v) &&
    Object.keys(v).every((k) => Object.hasOwn(shape, k) || Object.hasOwn(optional, k)) &&
    Object.entries(shape).every(([k, test]) => Object.hasOwn(v, k) && test(v[k])) &&
    Object.entries(optional).every(([k, test]) => !Object.hasOwn(v, k) || test(v[k]));
const one =
  (...values: unknown[]): Check =>
  (v) =>
    values.includes(v);
const nullable =
  (test: Check): Check =>
  (v) =>
    v === null || test(v);
const list =
  (test: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(test);
const uint: Check = (v) => Number.isSafeInteger(v) && Number(v) >= 0;
const positive: Check = (v) => uint(v) && Number(v) > 0;
const finite: Check = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const text: Check = (v) => typeof v === "string" && Buffer.byteLength(v) <= 65536;
const string: Check = (v) =>
  typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\0\r\n]/.test(v);
const provider = one("codex", "claude");
const generationId: Check = (v) => isId(v) && v === v.toLowerCase();
const rootSchema = exact({
  path: (v) => string(v) && String(v).startsWith("/") && resolve(String(v)) === v,
  dev: uint,
  ino: uint,
  uid: uint,
});
const pointerSchema = exact(
  {
    generation: generationId,
    agentId: isId,
    workspaceId: isId,
    bindingEpoch: positive,
    configRevision: uint,
    provider,
    localRootReference: isId,
  },
  { legacy: (v) => typeof v === "boolean" },
);
const fileSchema = exact({
  path: isSelectedPath,
  dev: uint,
  ino: uint,
  size: (v) => uint(v) && Number(v) <= 65536,
  mtimeMs: finite,
  ctimeMs: finite,
  hash: isHash,
});
const requestedSchema = exact({ model: string, effort: nullable(string) });
const capabilitiesSchema = exact(
  {
    version: string,
    models: list(
      exact(
        {
          id: string,
          model: string,
          efforts: list(string, 12),
          defaultEffort: nullable(string),
          isDefault: (v) => typeof v === "boolean",
        },
        { displayName: isModelDisplayName },
      ),
      256,
    ),
    defaultSettings: nullable(requestedSchema),
    snapshotHash: isHash,
    policy: one("CONFIRMED"),
  },
  { runtime: provider },
);
const settingsSchema = exact(
  {
    provider,
    requested: requestedSchema,
    capabilities: capabilitiesSchema,
    files: list(fileSchema, 32),
    handoff: text,
    publicScopeConfirmed: one(true),
    autoQuestionsConfirmed: (v) => typeof v === "boolean",
  },
  { repositoryAccess: validRepositoryAccess },
);
const contextSchema = exact(
  {
    ownership: one("CONNECTOR_CREATED"),
    generation: isId,
    threadId: string,
    root: rootSchema,
    epoch: positive,
    level: one("L1"),
    ownedTurns: list(() => false, 0),
  },
  {
    provider,
    materialization: exact({
      state: one("RESERVED", "MATERIALIZED"),
      version: string,
      policyFingerprint: isHash,
      initHash: nullable(isHash),
    }),
  },
);
const phases = [
  "CHOOSING",
  "CATALOG_INTENT",
  "LOCAL_CONFIRMATION",
  "APPLYING",
  "PREPARE_INTENT",
  "PREPARED",
  "COMMIT_INTENT",
  "COMMITTED",
  "LOCAL_COMMITTED",
  "APPLIED",
  "CANCEL_INTENT",
  "CANCELLED",
  "FAILED",
  "UNKNOWN",
];
function unsafe(): never {
  throw new RuntimeError("UNSAFE_STORAGE");
}
const equal = (a: unknown, b: unknown) => stableJson(a) === stableJson(b);

function validateSettings(settings: RuntimeSettings) {
  if (!settingsSchema(settings)) unsafe();
  const capabilities = projectCapability({
    ...settings.capabilities,
    runtime: settings.capabilities.runtime ?? settings.provider,
    policy: "verified",
  });
  if (settings.provider === "codex" && capabilities.version !== codexVersion) unsafe();
  validateSelection(
    {
      runtime: settings.provider,
      ...settings.requested,
      snapshotHash: capabilities.snapshotHash,
    },
    capabilities,
  );
  if (
    new Set(settings.files.map((f) => f.path)).size !== settings.files.length ||
    settings.files.reduce((sum, f) => sum + f.size, 0) > 512 * 1024
  )
    unsafe();
}
function validateFiles(files: FileSnapshot[]) {
  if (
    !list(fileSchema, 32)(files) ||
    new Set(files.map((f) => f.path)).size !== files.length ||
    files.reduce((sum, f) => sum + f.size, 0) > 512 * 1024
  )
    unsafe();
}
function validateOperation(operation: Operation, state: SettingsState) {
  const response = projectResponse({
    protocol: 1,
    deviceId: state.deviceId,
    configRevision: 0,
    catalog: null,
    operation,
    applied: null,
    current: false,
    currentBinding: null,
  });
  if (
    !equal(response.operation, operation) ||
    operation.deviceId !== state.deviceId ||
    operation.requested.deviceId !== state.deviceId ||
    operation.requested.operationId !== operation.operationId ||
    operation.requested.expectedConfigRevision !== operation.expectedConfigRevision ||
    (operation.receipt && operation.receipt.operationId !== operation.operationId)
  )
    unsafe();
}
function validateReceipt(journal: SetupJournal) {
  if (!journal.receipt) return;
  const receipt = validateBody("receipt", journal.receipt);
  if (
    !equal(receipt, journal.receipt) ||
    receipt.operationId !== journal.operation.operationId ||
    receipt.readMode !== journal.repositoryAccess?.mode ||
    (receipt.localRootReference !== null &&
      receipt.localRootReference !== journal.localRootReference)
  )
    unsafe();
  if (
    journal.settings &&
    receipt.runtime !== null &&
    receipt.state !== "LOCAL_CONFIRMATION" &&
    (receipt.runtime !== journal.settings.provider ||
      receipt.model !== journal.settings.requested.model ||
      receipt.effort !== journal.settings.requested.effort ||
      receipt.snapshotHash !== journal.settings.capabilities.snapshotHash)
  )
    unsafe();
  if (
    ["COMMITTED", "APPLIED"].includes(journal.receipt.state) &&
    (!journal.settings ||
      !journal.context ||
      !journal.root ||
      ((["COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(journal.phase) ||
        receipt.state === "APPLIED") &&
        (!receipt.agentId || !receipt.workspaceId)) ||
      (receipt.agentId === null) !== (receipt.workspaceId === null) ||
      (receipt.agentId === null &&
        (receipt.bindingEpoch !== 1 ||
          (journal.previous !== null && journal.previous !== undefined))) ||
      !receipt.bindingEpoch ||
      receipt.bindingEpoch !== journal.context.epoch ||
      receipt.localRootReference === null)
  )
    unsafe();
}
function validateCommitBody(journal: SetupJournal) {
  if (journal.commitBody === undefined) return;
  const body = validateBody("receipt", journal.commitBody) as Receipt;
  const previous = journal.previous;
  if (
    !equal(body, journal.commitBody) ||
    body.state !== "COMMITTED" ||
    body.operationId !== journal.operation.operationId ||
    body.configRevision !== journal.operation.expectedConfigRevision + 1 ||
    !journal.settings ||
    !journal.context ||
    !journal.root ||
    body.runtime !== journal.settings.provider ||
    body.model !== journal.settings.requested.model ||
    body.effort !== journal.settings.requested.effort ||
    body.snapshotHash !== journal.settings.capabilities.snapshotHash ||
    body.localRootReference !== journal.localRootReference ||
    body.readMode !== journal.repositoryAccess?.mode ||
    body.bindingEpoch !== journal.context.epoch ||
    body.bindingEpoch !== (previous?.bindingEpoch ?? 0) + 1 ||
    body.agentId !== (previous?.agentId ?? null) ||
    body.workspaceId !== (previous?.workspaceId ?? null)
  )
    unsafe();
  if (journal.receipt && ["COMMITTED", "APPLIED"].includes(journal.receipt.state)) {
    const expected = {
      ...body,
      state: journal.receipt.state,
      agentId: body.agentId ?? journal.receipt.agentId,
      workspaceId: body.workspaceId ?? journal.receipt.workspaceId,
    };
    if (!equal(journal.receipt, expected)) unsafe();
  }
}
function validateJournal(j: SetupJournal, state: SettingsState) {
  if (
    !exact(
      {
        operation: object,
        phase: one(...phases),
        generation: generationId,
        localRootReference: isId,
        root: nullable(rootSchema),
        settings: nullable(settingsSchema),
        context: nullable(contextSchema),
        receipt: nullable(object),
        reason: nullable(string),
      },
      {
        catalogContext: nullable(contextSchema),
        previous: nullable(pointerSchema),
        repositoryAccess: validRepositoryAccess,
        files: list(fileSchema, 32),
        handoff: text,
        applyBody: object,
        applyHash: isHash,
        commitBody: object,
      },
    )(j)
  )
    unsafe();
  validateOperation(j.operation, state);
  if (j.repositoryAccess) {
    const access = j.repositoryAccess;
    if (
      !j.root ||
      access.generation !== j.generation ||
      access.localRootReference !== j.localRootReference ||
      access.confirmationOperationId !== j.operation.operationId ||
      access.rootIdentityHash !== rootIdentityHash(j.root) ||
      j.files?.length !== 0 ||
      (j.settings && !equal(j.settings.repositoryAccess, access))
    )
      unsafe();
  } else if (j.settings?.repositoryAccess) unsafe();
  if (j.files) {
    validateFiles(j.files);
    if (!j.root || (j.settings && !equal(j.files, j.settings.files))) unsafe();
  }
  if (j.handoff !== undefined) {
    if (
      publicText(j.handoff, [j.root?.path ?? ""], true) !== j.handoff ||
      (j.settings && j.handoff !== j.settings.handoff)
    )
      unsafe();
  }
  const requested = j.operation.requested;
  if ((j.applyBody === undefined) !== (j.applyHash === undefined)) unsafe();
  if (j.applyBody) {
    const body = validateBody("apply", j.applyBody);
    if (
      digest(stableJson(body)) !== j.applyHash ||
      body.operationId !== j.operation.operationId ||
      body.deviceId !== state.deviceId ||
      body.expectedConfigRevision !== j.operation.expectedConfigRevision ||
      body.runtime !== requested.runtime ||
      body.localRootReference !== j.localRootReference ||
      body.readMode !== j.repositoryAccess?.mode ||
      (j.previous && body.expectedEpoch !== j.previous.bindingEpoch) ||
      (j.receipt && body.repositoryAlias !== j.receipt.repositoryAlias) ||
      (j.settings &&
        (body.model !== j.settings.requested.model ||
          body.effort !== j.settings.requested.effort ||
          body.snapshotHash !== j.settings.capabilities.snapshotHash))
    )
      unsafe();
  }
  if (
    (requested.localRootReference !== undefined &&
      requested.localRootReference !== j.localRootReference) ||
    (j.settings &&
      (requested.runtime !== j.settings.provider ||
        (requested.model !== undefined &&
          (requested.model !== j.settings.requested.model ||
            requested.effort !== j.settings.requested.effort ||
            requested.snapshotHash !== j.settings.capabilities.snapshotHash))))
  )
    unsafe();
  if (j.settings) {
    validateSettings(j.settings);
    if (!j.root) unsafe();
    repositoryMode(j.settings, { generation: j.generation, root: j.root });
  }
  if (j.settings && !j.root) unsafe();
  if (j.root && j.root.uid !== process.getuid?.()) unsafe();
  if (j.context) {
    const c = j.context,
      s = j.settings;
    if (
      !s ||
      !j.root ||
      c.generation !== j.generation ||
      !equal(c.root, j.root) ||
      (c.provider && c.provider !== s.provider)
    )
      unsafe();
    if (s.provider === "claude") {
      const m = c.materialization;
      if (
        c.provider !== "claude" ||
        !isId(c.threadId) ||
        !m ||
        m.version !== s.capabilities.version ||
        (m.state === "RESERVED" ? m.initHash !== null : !isHash(m.initHash))
      )
        unsafe();
    } else if (c.materialization || c.provider === "claude") unsafe();
  }
  if (j.catalogContext) {
    const c = j.catalogContext,
      m = c.materialization;
    if (
      !j.root ||
      !equal(c.root, j.root) ||
      c.generation !== j.generation ||
      c.provider !== "claude" ||
      !isId(c.threadId) ||
      !m ||
      (m.state === "RESERVED" ? m.initHash !== null : !isHash(m.initHash))
    )
      unsafe();
  }
  if (
    ["PREPARED", "COMMIT_INTENT", "COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(j.phase) &&
    !j.context
  )
    unsafe();
  validateReceipt(j);
  validateCommitBody(j);
  if (
    ["COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(j.phase) &&
    !["COMMITTED", "APPLIED"].includes(j.receipt?.state ?? "")
  )
    unsafe();
  if (j.phase === "APPLIED" && j.receipt?.state !== "APPLIED") unsafe();
  if (j.phase === "CANCELLED" && j.receipt?.state !== "CANCELLED") unsafe();
}
function pointerMatches(pointer: GenerationPointer, j: SetupJournal) {
  return (
    !!j.receipt &&
    pointer.generation === j.generation &&
    pointer.localRootReference === j.localRootReference &&
    pointer.provider === j.settings?.provider &&
    pointer.agentId === j.receipt.agentId &&
    pointer.workspaceId === j.receipt.workspaceId &&
    pointer.bindingEpoch === j.receipt.bindingEpoch &&
    pointer.configRevision === j.receipt.configRevision
  );
}
function validate(value: unknown): asserts value is SettingsState {
  try {
    if (
      !exact({
        version: one(1),
        server: string,
        deviceId: isId,
        organizationId: isId,
        roomId: isId,
        current: nullable(pointerSchema),
        retained: list(pointerSchema, 256),
        journal: nullable(object),
      })(value)
    )
      unsafe();
    const state = value as SettingsState;
    if (serviceOrigin(state.server) !== state.server) unsafe();
    const references = [...state.retained, ...(state.current ? [state.current] : [])];
    if (new Set(references.map((p) => p.generation)).size !== references.length) unsafe();
    if (state.journal) {
      validateJournal(state.journal, state);
      if (
        ["LOCAL_COMMITTED", "APPLIED"].includes(state.journal.phase) &&
        (!state.current || !pointerMatches(state.current, state.journal))
      )
        unsafe();
    }
  } catch {
    unsafe();
  }
}
function closed(journal: SetupJournal) {
  return (
    (journal.phase === "APPLIED" && journal.receipt?.state === "APPLIED") ||
    (journal.phase === "CANCELLED" && journal.receipt?.state === "CANCELLED")
  );
}
function validateContextChange(before: OwnedContext, after: OwnedContext | null) {
  if (!after) unsafe();
  const { materialization: old, ...identity } = before;
  const { materialization: next, ...current } = after;
  if (!equal(identity, current)) unsafe();
  if (
    old &&
    !equal(old, next) &&
    !(
      next &&
      old.state === "RESERVED" &&
      next.state === "MATERIALIZED" &&
      old.version === next.version &&
      old.policyFingerprint === next.policyFingerprint &&
      isHash(next.initHash)
    )
  )
    unsafe();
}
function validateJournalChange(before: SetupJournal, after: SetupJournal | null) {
  if (!after || before.operation.operationId !== after.operation.operationId) {
    if (!closed(before)) unsafe();
    return;
  }
  if (
    !equal(before.operation.requested, after.operation.requested) ||
    before.operation.deviceId !== after.operation.deviceId ||
    before.operation.expectedConfigRevision !== after.operation.expectedConfigRevision ||
    before.generation !== after.generation ||
    before.localRootReference !== after.localRootReference ||
    (before.root && !equal(before.root, after.root)) ||
    (before.repositoryAccess && !equal(before.repositoryAccess, after.repositoryAccess)) ||
    (!before.repositoryAccess &&
      after.repositoryAccess &&
      (before.phase !== "CHOOSING" ||
        after.phase !== "CATALOG_INTENT" ||
        before.files !== undefined ||
        before.receipt !== null)) ||
    (before.settings && !equal(before.settings, after.settings))
  )
    unsafe();
  if (before.context) validateContextChange(before.context, after.context);
  if (before.catalogContext)
    validateContextChange(before.catalogContext, after.catalogContext ?? null);
  if (!equal(before.previous ?? null, after.previous ?? null)) unsafe();
  if (
    (before.files !== undefined && !equal(before.files, after.files)) ||
    (before.handoff !== undefined && before.handoff !== after.handoff) ||
    (before.applyBody !== undefined && !equal(before.applyBody, after.applyBody)) ||
    (before.applyHash !== undefined && before.applyHash !== after.applyHash) ||
    (before.commitBody !== undefined && !equal(before.commitBody, after.commitBody))
  )
    unsafe();
  const ordered = [
    "CHOOSING",
    "CATALOG_INTENT",
    "LOCAL_CONFIRMATION",
    "APPLYING",
    "PREPARE_INTENT",
    "PREPARED",
    "COMMIT_INTENT",
    "COMMITTED",
    "LOCAL_COMMITTED",
    "APPLIED",
  ];
  const oldIndex = ordered.indexOf(before.phase),
    newIndex = ordered.indexOf(after.phase);
  if (oldIndex >= 0 && newIndex >= 0 && newIndex < oldIndex) unsafe();
  if (
    before.phase === "CANCEL_INTENT" &&
    !["CANCEL_INTENT", "CANCELLED", "COMMITTED", "UNKNOWN"].includes(after.phase)
  )
    unsafe();
  if (closed(before) && !equal(before, after)) unsafe();
  if (
    ["COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(before.phase) &&
    !["COMMITTED", "LOCAL_COMMITTED", "APPLIED", "UNKNOWN"].includes(after.phase)
  )
    unsafe();
  if (before.receipt && ["COMMITTED", "APPLIED", "CANCELLED"].includes(before.receipt.state)) {
    const { state: oldState, ...old } = before.receipt;
    const { state: newState, ...next } = after.receipt ?? {};
    if (
      !equal(old, next) ||
      (oldState !== newState && !(oldState === "COMMITTED" && newState === "APPLIED"))
    )
      unsafe();
  }
}
function validateChange(before: SettingsState, after: SettingsState) {
  for (const key of ["server", "deviceId", "organizationId", "roomId"] as const)
    if (before[key] !== after[key]) unsafe();
  if (before.retained.some((ref, i) => !equal(ref, after.retained[i]))) unsafe();
  if (before.journal) validateJournalChange(before.journal, after.journal);
  if (
    after.journal &&
    (!before.journal ||
      before.journal.operation.operationId !== after.journal.operation.operationId) &&
    after.journal.previous &&
    !equal(after.journal.previous, before.current)
  )
    unsafe();
  const changed = !equal(before.current, after.current);
  if (changed) {
    if (
      !after.current ||
      after.current.legacy === true ||
      !after.journal ||
      !["COMMITTED", "LOCAL_COMMITTED", "APPLIED"].includes(after.journal.phase) ||
      !pointerMatches(after.current, after.journal) ||
      (before.current && before.current.generation === after.current.generation) ||
      (before.current &&
        (after.current.configRevision <= before.current.configRevision ||
          (after.current.agentId === before.current.agentId &&
            after.current.bindingEpoch <= before.current.bindingEpoch))) ||
      !equal(after.retained, [...before.retained, ...(before.current ? [before.current] : [])])
    )
      unsafe();
  } else if (!equal(before.retained, after.retained)) unsafe();
}

// JSON.parse accepts duplicate keys. Parse structurally so ambiguous durable intents are refused.
function parseJson(source: string): unknown {
  let offset = 0;
  const whitespace = () => {
    while (/[ \t\r\n]/.test(source[offset] ?? "") && offset < source.length) offset++;
  };
  const quoted = () => {
    const token = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(
      source.slice(offset),
    );
    if (!token) unsafe();
    offset += token[0].length;
    return JSON.parse(token[0]) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) unsafe();
    whitespace();
    const start = source[offset];
    if (start === '"') return quoted();
    if (start === "{" || start === "[") {
      offset++;
      whitespace();
      const end = start === "{" ? "}" : "]";
      const entries: [string, unknown][] = [],
        items: unknown[] = [],
        keys = new Set<string>();
      if (source[offset] !== end)
        for (;;) {
          whitespace();
          if (start === "{") {
            const key = quoted();
            whitespace();
            if (keys.has(key) || source[offset++] !== ":") unsafe();
            keys.add(key);
            entries.push([key, value(depth + 1)]);
          } else items.push(value(depth + 1));
          whitespace();
          if (source[offset] === end) break;
          if (source[offset++] !== ",") unsafe();
        }
      offset++;
      return start === "{" ? Object.fromEntries(entries) : items;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      source.slice(offset),
    );
    if (!token) unsafe();
    offset += token[0].length;
    const result = JSON.parse(token[0]);
    if (typeof result === "number" && !Number.isFinite(result)) unsafe();
    return result;
  };
  const result = value(0);
  whitespace();
  if (offset !== source.length) unsafe();
  return result;
}
async function directory(path: string, privateRoot: string, check: () => void) {
  const parts: string[] = [];
  let part = path;
  while (part !== parse(part).root) {
    parts.unshift(part);
    part = dirname(part);
  }
  for (const current of parts) {
    let info: Stats;
    try {
      info = await lstat(current);
      check();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      check();
      await mkdir(current, { mode: 0o700 });
      check();
      info = await lstat(current);
      check();
    }
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      ((current === privateRoot || current.startsWith(`${privateRoot}/`)) &&
        (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700))
    )
      unsafe();
  }
  const actual = await realpath(path);
  check();
  if (actual !== path) unsafe();
}
function secureFile(info: Stats, max: number) {
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > max
  )
    unsafe();
}
async function readSecure(path: string, max: number, check: () => void) {
  const before = await lstat(path);
  check();
  secureFile(before, max);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check();
    const opened = await handle.stat();
    check();
    secureFile(opened, max);
    if (before.dev !== opened.dev || before.ino !== opened.ino) unsafe();
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    check();
    const after = await handle.stat();
    check();
    const current = await lstat(path);
    check();
    for (const info of [after, current]) {
      secureFile(info, max);
      if (
        info.ino !== opened.ino ||
        info.dev !== opened.dev ||
        info.size !== opened.size ||
        info.mtimeMs !== opened.mtimeMs ||
        info.ctimeMs !== opened.ctimeMs
      )
        unsafe();
    }
    if (bytesRead !== opened.size || bytesRead > max) unsafe();
    const bytes = buffer.subarray(0, bytesRead);
    return {
      value: parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      stat: opened,
      bytes,
    };
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string, check: () => void) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    check();
    await handle.sync();
    check();
  } finally {
    await handle.close();
  }
}
type Faults = { beforeSync?: (stage: "file" | "directory") => Promise<void> };
export class SettingsStore {
  readonly dir: string;
  readonly file: string;
  readonly lockPath: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    readonly profile: StateStore,
    private readonly faults: Faults = {},
  ) {
    this.dir = join(profile.dir, "settings", profile.profile);
    this.file = join(this.dir, "settings.json");
    this.lockPath = join(this.dir, "device.lock");
  }
  private async ensureDir(check: () => void) {
    check();
    await directory(this.dir, this.profile.dir, check);
    check();
  }
  async read(check = () => {}): Promise<SettingsState | undefined> {
    await this.ensureDir(check);
    try {
      const input = await readSecure(this.file, limit, check);
      check();
      validate(input.value);
      return input.value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        check();
        return undefined;
      }
      if (e instanceof RuntimeError) throw e;
      unsafe();
    }
  }
  write(state: SettingsState, check = () => {}): Promise<void> {
    const snapshot = structuredClone(state);
    validate(snapshot);
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > limit) unsafe();
    const work = this.writes.then(async () => {
      check();
      await this.ensureDir(check);
      check();
      const previous = await this.read(check);
      check();
      if (previous) validateChange(previous, snapshot);
      else await this.validateInitial(snapshot, check);
      const temp = join(this.dir, `.settings-${randomUUID()}.tmp`);
      let handle: FileHandle | undefined;
      try {
        handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        check();
        await handle.writeFile(bytes);
        check();
        await this.faults.beforeSync?.("file");
        check();
        await handle.sync();
        check();
        await handle.close();
        handle = undefined;
        check();
        const current = await this.read(check);
        check();
        if (!equal(current ?? null, previous ?? null)) unsafe();
        await rename(temp, this.file);
        check();
        await this.faults.beforeSync?.("directory");
        check();
        await syncDirectory(this.dir, check);
        check();
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
    });
    this.writes = work.catch(() => {});
    return work;
  }
  async assertIdle(check = () => {}): Promise<void> {
    const state = await this.read(check);
    check();
    if (state?.journal && !closed(state.journal)) throw new RuntimeError("RUNTIME_BUSY");
  }
  private async validateInitial(state: SettingsState, check: () => void) {
    if (state.retained.length) unsafe();
    if (!state.current) return;
    const pointer = state.current;
    if (
      pointer.legacy !== true ||
      pointer.configRevision !== 0 ||
      !state.journal ||
      !equal(state.journal.previous, pointer) ||
      !["CHOOSING", "CATALOG_INTENT", "LOCAL_CONFIRMATION", "APPLYING", "PREPARE_INTENT"].includes(
        state.journal.phase,
      )
    )
      unsafe();
    const legacy = await new RuntimeStore(
      this.profile.dir,
      this.profile.profile,
      pointer.agentId,
    ).read();
    check();
    if (
      !legacy ||
      !legacy.context ||
      legacy.context.generation !== pointer.generation ||
      legacy.scope.bindingEpoch !== pointer.bindingEpoch ||
      legacy.settings?.provider !== pointer.provider ||
      legacy.scope.server !== state.server ||
      legacy.scope.deviceId !== state.deviceId ||
      legacy.scope.organizationId !== state.organizationId ||
      legacy.scope.roomId !== state.roomId
    )
      unsafe();
    const profile = await this.profile.read();
    check();
    if (
      profile?.deviceId !== state.deviceId ||
      profile.server !== state.server ||
      profile.scope?.organizationId !== state.organizationId ||
      profile.scope.roomId !== state.roomId ||
      !profile.mappings.some(
        (mapping) =>
          mapping.agentId === pointer.agentId &&
          mapping.workspaceId === pointer.workspaceId &&
          mapping.bindingEpoch === pointer.bindingEpoch &&
          mapping.root === legacy.context!.root.path &&
          mapping.nativeSessionId === legacy.context!.threadId,
      )
    )
      unsafe();
  }
  generationStore(agentId: string, generation: string): RuntimeStore {
    if (!isId(agentId) || !generationId(generation)) unsafe();
    return new RuntimeStore(
      join(this.dir, "generations", generation),
      this.profile.profile,
      agentId,
    );
  }
  async locked<T>(run: () => Promise<T>, check = () => {}): Promise<T> {
    await this.ensureDir(check);
    check();
    const identity = digest(this.file);
    const handle = await this.acquire(identity, check);
    const token = randomUUID();
    const own = await handle.stat();
    let initialized = false;
    let retain = false;
    try {
      check();
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, identity }));
      check();
      await handle.sync();
      check();
      initialized = true;
      await syncDirectory(this.dir, check);
      check();
      const result = await run();
      check();
      return result;
    } catch (e) {
      retain = e instanceof RuntimeError && e.code === "CLEANUP_INCOMPLETE";
      throw e;
    } finally {
      await this.writes;
      await handle.close();
      if (retain) {
        // A live owner with incomplete provider cleanup must keep excluding every new owner.
      } else if (initialized) {
        const current = await readSecure(this.lockPath, 4096, () => {});
        if (
          current.stat.dev !== own.dev ||
          current.stat.ino !== own.ino ||
          !exact({ pid: one(process.pid), token: one(token), identity: one(identity) })(
            current.value,
          )
        )
          unsafe();
      } else {
        const current = await lstat(this.lockPath);
        if (current.dev !== own.dev || current.ino !== own.ino) unsafe();
      }
      if (!retain) {
        await unlink(this.lockPath);
        await syncDirectory(this.dir, () => {});
      }
    }
  }
  private async acquire(identity: string, check: () => void): Promise<FileHandle> {
    const create = (path: string) =>
      open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    try {
      const handle = await create(this.lockPath);
      return handle;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") unsafe();
    }
    check();
    const recoveryPath = `${this.lockPath}.recovery`;
    let recovery: FileHandle;
    try {
      recovery = await create(recoveryPath);
    } catch {
      throw new RuntimeError("RUNTIME_BUSY");
    }
    try {
      check();
      const old = await readSecure(this.lockPath, 4096, check);
      check();
      if (!exact({ pid: positive, token: isId, identity: one(identity) })(old.value)) unsafe();
      try {
        process.kill(Number((old.value as { pid: number }).pid), 0);
        throw new RuntimeError("RUNTIME_BUSY");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new RuntimeError("RUNTIME_BUSY");
      }
      const current = await lstat(this.lockPath);
      check();
      secureFile(current, 4096);
      if (current.dev !== old.stat.dev || current.ino !== old.stat.ino) unsafe();
      await unlink(this.lockPath);
      check();
      return await create(this.lockPath);
    } finally {
      await recovery.close();
      await unlink(recoveryPath);
    }
  }
}
