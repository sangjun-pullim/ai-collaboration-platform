import {
  constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync,
  type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";

export type Refusal =
  | "INVALID_ARGUMENT" | "UNSAFE_STORAGE" | "STORAGE_FAILED" | "BUSY"
  | "BUDGET_IDENTITY" | "BUDGET_EXHAUSTED" | "EXECUTION_PRECEDENCE_UNCONFIRMED"
  | "STARTUP_EXECUTION_UNCONFIRMED" | "POLICY_DRIFT" | "PROTOCOL_REJECTED"
  | "PROTOCOL_LIMIT" | "PROTOCOL_TIMEOUT" | "TRANSPORT_CLOSED" | "CLEANUP_INCOMPLETE"
  | "NATIVE_IDENTITY" | "NATIVE_NOT_MATERIALIZED" | "HISTORY_UNCONFIRMED"
  | "INPUT_UNRESOLVED" | "TOOL_CORRELATION_UNCONFIRMED" | "TOOL_REJECTED"
  | "FILE_REJECTED" | "TERMINAL_UNCONFIRMED" | "RUNTIME_CLOSED";

/** Public failures contain only a fixed code, never provider diagnostics or paths. */
export class ProbeError extends Error {
  constructor(readonly code: Refusal) { super(code); }
}

export const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const digest = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProbeError("PROTOCOL_REJECTED");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new ProbeError("UNSAFE_STORAGE");
}
export function privateStat(path: string, directory = false): Stats {
  if (!isAbsolute(path) || realpathSync(path) !== path) throw new ProbeError("UNSAFE_STORAGE");
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
      (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) || stat.uid !== process.getuid?.()) {
    throw new ProbeError("UNSAFE_STORAGE");
  }
  return stat;
}
export function readPrivate(path: string, limit = 1024 * 1024): Buffer {
  const before = privateStat(path);
  if (before.size > limit) throw new ProbeError("UNSAFE_STORAGE");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd);
    if (!sameFile(before, opened)) throw new ProbeError("UNSAFE_STORAGE");
    const bytes = readBounded(fd, limit);
    if (bytes.length > limit || !sameFile(before, fstatSync(fd)) || !sameFile(before, privateStat(path))) {
      throw new ProbeError("UNSAFE_STORAGE");
    }
    return bytes;
  } finally { closeSync(fd); }
}
export function readBounded(fd: number, limit: number): Buffer {
  const bytes = Buffer.alloc(limit + 1);
  let length = 0;
  while (length < bytes.length) {
    const count = readSync(fd, bytes, length, bytes.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length > limit) throw new ProbeError("UNSAFE_STORAGE");
  return bytes.subarray(0, length);
}
export function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs && a.mode === b.mode && a.uid === b.uid && a.nlink === b.nlink;
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function atomicPrivate(path: string, value: unknown, beforeSync: () => void = () => {}): void {
  const parent = privateStat(dirname(path), true);
  const original = existsSync(path) ? privateStat(path) : undefined;
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  let renamed = false;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n");
    beforeSync();
    fsyncSync(fd);
    if (!sameFile(fstatSync(fd), privateStat(temporary))) throw new ProbeError("UNSAFE_STORAGE");
    const currentParent = privateStat(dirname(path), true);
    if (parent.dev !== currentParent.dev || parent.ino !== currentParent.ino) throw new ProbeError("UNSAFE_STORAGE");
    if (original ? !sameFile(original, privateStat(path)) : existsSync(path)) throw new ProbeError("UNSAFE_STORAGE");
    renameSync(temporary, path);
    renamed = true;
    syncDirectory(dirname(path));
  } catch { throw new ProbeError("STORAGE_FAILED"); }
  finally { closeSync(fd); if (!renamed && existsSync(temporary)) unlinkSync(temporary); }
}

async function locked<T>(directory: string, name: string, action: () => Promise<T>): Promise<T> {
  privateStat(directory, true);
  const path = join(directory, name);
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600); }
  catch { throw new ProbeError("BUSY"); }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
    fsyncSync(fd);
  } catch { closeSync(fd); throw new ProbeError("STORAGE_FAILED"); }
  const identity = fstatSync(fd);
  try { return await action(); }
  finally {
    closeSync(fd);
    if (!sameFile(identity, privateStat(path))) throw new ProbeError("UNSAFE_STORAGE");
    unlinkSync(path);
    syncDirectory(directory);
  }
}

export type Command = "probe-tools" | "probe-interrupt";
export interface InputIntent {
  inputId: string;
  approvalId: string;
  budgetId: string;
  slot: number;
  command: Command;
  promptHash: string;
  phase: "INTENT" | "TRANSMITTED" | "ACK" | "UNKNOWN" | "COMPLETED" | "INTERRUPTED";
  terminal: null | { kind: "COMPLETED" | "INTERRUPTED"; evidenceHash: string; text: string | null };
}
export interface ProbeState {
  version: 1;
  sessionId: string;
  root: string;
  rootIdentity: { dev: number; ino: number };
  initialized: boolean;
  persistence: "UNVERIFIED" | "NATIVE_NOT_MATERIALIZED" | "PERSISTED_ZERO" | "PERSISTED_HISTORY";
  fileSnapshotHash: string | null;
  inputs: InputIntent[];
  evidence: { kind: string; hash: string }[];
  cleanup: "NOT_STARTED" | "REAPED" | "CLEANUP_INCOMPLETE";
}

function state(value: unknown): ProbeState {
  const s = object(value);
  exact(s, ["version", "sessionId", "root", "rootIdentity", "initialized", "persistence", "fileSnapshotHash", "inputs", "evidence", "cleanup"]);
  const identity = object(s.rootIdentity);
  exact(identity, ["dev", "ino"]);
  if (s.version !== 1 || !uuid(s.sessionId) || typeof s.root !== "string" || !isAbsolute(s.root) ||
      !Number.isSafeInteger(identity.dev) || !Number.isSafeInteger(identity.ino) || typeof s.initialized !== "boolean" ||
      !["UNVERIFIED", "NATIVE_NOT_MATERIALIZED", "PERSISTED_ZERO", "PERSISTED_HISTORY"].includes(String(s.persistence)) ||
      !["NOT_STARTED", "REAPED", "CLEANUP_INCOMPLETE"].includes(String(s.cleanup)) ||
      s.fileSnapshotHash !== null && !isHash(s.fileSnapshotHash) ||
      !Array.isArray(s.inputs) || s.inputs.length > 3 || !Array.isArray(s.evidence) || s.evidence.length > 256) {
    throw new ProbeError("UNSAFE_STORAGE");
  }
  const ids = new Set<string>();
  for (const raw of s.inputs) {
    const input = object(raw);
    exact(input, ["inputId", "approvalId", "budgetId", "slot", "command", "promptHash", "phase", "terminal"]);
    if (!uuid(input.inputId) || !uuid(input.approvalId) || !uuid(input.budgetId) || ids.has(input.inputId) ||
        !Number.isInteger(input.slot) || Number(input.slot) < 1 || Number(input.slot) > 3 ||
        !["probe-tools", "probe-interrupt"].includes(String(input.command)) || !isHash(input.promptHash) ||
        !["INTENT", "TRANSMITTED", "ACK", "UNKNOWN", "COMPLETED", "INTERRUPTED"].includes(String(input.phase))) {
      throw new ProbeError("UNSAFE_STORAGE");
    }
    ids.add(input.inputId);
    if (input.terminal !== null) {
      const terminal = object(input.terminal);
      exact(terminal, ["kind", "evidenceHash", "text"]);
      if (!["COMPLETED", "INTERRUPTED"].includes(String(terminal.kind)) || terminal.kind !== input.phase ||
          !isHash(terminal.evidenceHash) || (terminal.text !== null &&
          (typeof terminal.text !== "string" || Buffer.byteLength(terminal.text) > 65536)) ||
          (terminal.kind === "INTERRUPTED" && terminal.text !== null)) throw new ProbeError("UNSAFE_STORAGE");
    } else if (["COMPLETED", "INTERRUPTED"].includes(String(input.phase))) throw new ProbeError("UNSAFE_STORAGE");
  }
  for (const raw of s.evidence) {
    const e = object(raw);
    exact(e, ["kind", "hash"]);
    if (typeof e.kind !== "string" || !/^[A-Z_]{1,48}$/.test(e.kind) || !isHash(e.hash)) throw new ProbeError("UNSAFE_STORAGE");
  }
  return s as unknown as ProbeState;
}
const isHash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);

export class OwnedProbeStore {
  readonly path: string;
  #locked = false;
  constructor(readonly directory: string, private readonly beforeSync: () => void = () => {}) {
    privateStat(directory, true);
    this.path = join(directory, "probe.json");
  }

  static reserve(directory: string, root: string): OwnedProbeStore {
    const rootStat = privateStat(root, true);
    mkdirSync(directory, { mode: 0o700 });
    const store = new OwnedProbeStore(directory);
    atomicPrivate(store.path, {
      version: 1, sessionId: randomUUID(), root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      initialized: false, persistence: "UNVERIFIED", fileSnapshotHash: null, inputs: [], evidence: [], cleanup: "NOT_STARTED",
    });
    return store;
  }

  read(): ProbeState {
    try {
      const s = state(JSON.parse(readPrivate(this.path).toString("utf8")));
      const r = privateStat(s.root, true);
      if (r.dev !== s.rootIdentity.dev || r.ino !== s.rootIdentity.ino) throw new ProbeError("UNSAFE_STORAGE");
      return s;
    } catch { throw new ProbeError("UNSAFE_STORAGE"); }
  }

  async withLock<T>(action: () => Promise<T>): Promise<T> {
    if (this.#locked) throw new ProbeError("BUSY");
    return locked(this.directory, "session.lock", async () => {
      this.#locked = true;
      try {
        this.update((s) => {
          for (const input of s.inputs) if (!input.terminal) input.phase = "UNKNOWN";
        });
        return await action();
      } finally { this.#locked = false; }
    });
  }

  assertLocked(): void { if (!this.#locked) throw new ProbeError("BUSY"); }

  update(change: (value: ProbeState) => void): void {
    this.assertLocked();
    const old = this.read();
    const next = structuredClone(old);
    change(next);
    state(next);
    if (next.sessionId !== old.sessionId || next.root !== old.root ||
        JSON.stringify(next.rootIdentity) !== JSON.stringify(old.rootIdentity) ||
        next.inputs.length < old.inputs.length || next.inputs.length > old.inputs.length + 1 || next.evidence.length < old.evidence.length ||
        (old.initialized && !next.initialized)) throw new ProbeError("UNSAFE_STORAGE");
    for (let i = 0; i < old.inputs.length; i++) {
      const a = old.inputs[i]!;
      const b = next.inputs[i]!;
      const { phase: _a, terminal: _at, ...ai } = a;
      const { phase: _b, terminal: _bt, ...bi } = b;
      if (JSON.stringify(ai) !== JSON.stringify(bi) || (a.terminal && JSON.stringify(a) !== JSON.stringify(b)) ||
          (a.phase === "UNKNOWN" && b.phase !== "UNKNOWN")) throw new ProbeError("UNSAFE_STORAGE");
      const transitions: Record<InputIntent["phase"], InputIntent["phase"][]> = {
        INTENT: ["INTENT", "TRANSMITTED", "UNKNOWN"], TRANSMITTED: ["TRANSMITTED", "ACK", "UNKNOWN"],
        ACK: ["ACK", "COMPLETED", "INTERRUPTED", "UNKNOWN"], UNKNOWN: ["UNKNOWN"],
        COMPLETED: ["COMPLETED"], INTERRUPTED: ["INTERRUPTED"],
      };
      if (!transitions[a.phase].includes(b.phase)) throw new ProbeError("UNSAFE_STORAGE");
    }
    if (JSON.stringify(next.evidence.slice(0, old.evidence.length)) !== JSON.stringify(old.evidence)) throw new ProbeError("UNSAFE_STORAGE");
    if (old.fileSnapshotHash !== null && old.fileSnapshotHash !== next.fileSnapshotHash &&
        (next.fileSnapshotHash === null || old.cleanup !== "REAPED" || !old.inputs.length || old.inputs.some((i) => !i.terminal))) {
      throw new ProbeError("UNSAFE_STORAGE");
    }
    if (next.inputs.length > old.inputs.length && (next.inputs.at(-1)!.phase !== "INTENT" || next.inputs.at(-1)!.terminal !== null ||
        old.inputs.some((i) => !i.terminal))) throw new ProbeError("UNSAFE_STORAGE");
    atomicPrivate(this.path, next, this.beforeSync);
  }

  record(kind: string, value: unknown): void {
    this.update((s) => { s.evidence.push({ kind, hash: digest(JSON.stringify(value)) }); });
  }
}

export interface Approval {
  version: 1;
  approvalId: string;
  budgetId: string;
  budgetPath: string;
  maxInputs: 3;
}
interface BudgetSlot {
  slot: number; inputId: string; sessionId: string; root: string; command: Command; promptHash: string;
}
export interface Budget { version: 1; approvalId: string; budgetId: string; maxInputs: 3; slots: BudgetSlot[] }

/** Only the supervisor creates the approval anchor and budget. No creation/reset API exists. */
export class ApprovalBudget {
  readonly approval: Approval;
  readonly #anchor: string;
  constructor(readonly approvalPath: string, expectedApprovalId: string) {
    try {
      privateStat(dirname(approvalPath), true);
      const bytes = readPrivate(approvalPath);
      const a = object(JSON.parse(bytes.toString("utf8")));
      exact(a, ["version", "approvalId", "budgetId", "budgetPath", "maxInputs"]);
      if (a.version !== 1 || !uuid(a.approvalId) || a.approvalId !== expectedApprovalId || !uuid(a.budgetId) ||
          a.maxInputs !== 3 || typeof a.budgetPath !== "string" || dirname(a.budgetPath) !== dirname(approvalPath) ||
          a.budgetPath === approvalPath) throw new ProbeError("BUDGET_IDENTITY");
      this.approval = a as unknown as Approval;
      this.#anchor = digest(bytes);
      this.read();
    } catch { throw new ProbeError("BUDGET_IDENTITY"); }
  }

  read(): Budget {
    if (digest(readPrivate(this.approvalPath)) !== this.#anchor) throw new ProbeError("BUDGET_IDENTITY");
    const b = object(JSON.parse(readPrivate(this.approval.budgetPath).toString("utf8")));
    exact(b, ["version", "approvalId", "budgetId", "maxInputs", "slots"]);
    if (b.version !== 1 || b.approvalId !== this.approval.approvalId || b.budgetId !== this.approval.budgetId ||
        b.maxInputs !== 3 || !Array.isArray(b.slots) || b.slots.length > 3) throw new ProbeError("BUDGET_IDENTITY");
    const ids = new Set<string>();
    b.slots.forEach((raw, index) => {
      const slot = object(raw);
      exact(slot, ["slot", "inputId", "sessionId", "root", "command", "promptHash"]);
      if (slot.slot !== index + 1 || !uuid(slot.inputId) || ids.has(slot.inputId) || !uuid(slot.sessionId) ||
          typeof slot.root !== "string" || !isAbsolute(slot.root) || !isHash(slot.promptHash) ||
          !["probe-tools", "probe-interrupt"].includes(String(slot.command))) throw new ProbeError("BUDGET_IDENTITY");
      ids.add(slot.inputId);
    });
    return b as unknown as Budget;
  }

  assertResolved(store: OwnedProbeStore): void {
    const s = store.read();
    const b = this.read();
    if (s.inputs.some((i) => i.approvalId !== b.approvalId || i.budgetId !== b.budgetId)) {
      throw new ProbeError("BUDGET_IDENTITY");
    }
    for (const slot of b.slots.filter((entry) => entry.sessionId === s.sessionId)) {
      const saved = s.inputs.find((i) => i.inputId === slot.inputId);
      if (!saved?.terminal || slot.root !== s.root || saved.promptHash !== slot.promptHash || saved.slot !== slot.slot ||
          saved.command !== slot.command || saved.budgetId !== b.budgetId || saved.approvalId !== b.approvalId) {
        throw new ProbeError("INPUT_UNRESOLVED");
      }
    }
  }

  async consume(store: OwnedProbeStore, command: Command, prompt: string, check: () => void): Promise<InputIntent> {
    store.assertLocked();
    return locked(dirname(this.approvalPath), "budget.lock", async () => {
      check();
      const s = store.read();
      if (s.inputs.some((i) => !i.terminal)) throw new ProbeError("INPUT_UNRESOLVED");
      const b = this.read();
      this.assertResolved(store);
      if (b.slots.length === 3) throw new ProbeError("BUDGET_EXHAUSTED");
      const input: InputIntent = {
        inputId: randomUUID(), approvalId: b.approvalId, budgetId: b.budgetId, slot: b.slots.length + 1,
        command, promptHash: digest(prompt), phase: "INTENT", terminal: null,
      };
      check();
      // Slot consumption and the complete input intent are one durable budget mutation.
      b.slots.push({ slot: input.slot, inputId: input.inputId, sessionId: s.sessionId,
        root: s.root, command, promptHash: input.promptHash });
      atomicPrivate(this.approval.budgetPath, b);
      check();
      store.update((next) => { next.inputs.push(input); });
      check();
      return input;
    });
  }
}
