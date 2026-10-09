import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  readdir,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { isId } from "./contracts.ts";
import {
  digest,
  RuntimeError,
  stableJson,
  type AttemptJournal,
  type RuntimeRecord,
  type RuntimeScope,
} from "./runtime-contracts.ts";
import {
  RuntimeArchive,
  journalByteLimit,
  archiveReferenceLimit,
  archiveRequestLimit,
} from "./runtime-archive.ts";
import { unsafe, attemptMatches, unresolvedRuntime } from "./runtime/record-helpers.ts";
import { validSessionThreadId, validLockRecord } from "./runtime/record-schema.ts";
import { validate } from "./runtime/record-validation.ts";
import { validateChange } from "./runtime/record-transitions.ts";

export { unresolvedRuntime } from "./runtime/record-helpers.ts";
export { pruneConfirmedReady } from "./runtime/record-transitions.ts";

async function directory(path: string, check: () => void = () => {}, privateRoot = path) {
  const parts: string[] = [];
  let p = resolve(path);
  while (p !== parse(p).root) {
    parts.unshift(p);
    p = dirname(p);
  }
  for (const part of parts) {
    let info;
    try {
      info = await lstat(part);
      check();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      check();
      await mkdir(part, { mode: 0o700 });
      check();
      info = await lstat(part);
      check();
    }
    if (!info.isDirectory() || info.isSymbolicLink()) unsafe();
    if (
      (part === privateRoot || part.startsWith(`${privateRoot}/`)) &&
      (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    )
      unsafe();
  }
  const info = await lstat(path);
  check();
  const canonical = await realpath(path);
  check();
  if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700 || canonical !== path)
    unsafe();
}
function secureFile(s: Stats, limit: number) {
  if (
    !s.isFile() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o600 ||
    s.nlink !== 1 ||
    s.size > limit
  )
    unsafe();
}
async function readSecure(path: string, limit: number, check = () => {}) {
  const before = await lstat(path);
  check();
  secureFile(before, limit);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    check();
    const opened = await handle.stat();
    check();
    secureFile(opened, limit);
    if (before.ino !== opened.ino || before.dev !== opened.dev) unsafe();
    const data = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    check();
    const after = await handle.stat();
    check();
    const current = await lstat(path);
    check();
    if (
      bytesRead > limit ||
      bytesRead !== opened.size ||
      [after, current].some(
        (s) =>
          s.dev !== opened.dev ||
          s.ino !== opened.ino ||
          s.size !== opened.size ||
          s.mtimeMs !== opened.mtimeMs ||
          s.ctimeMs !== opened.ctimeMs,
      )
    )
      unsafe();
    return {
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead)),
      ),
      stat: opened,
      bytes: data.subarray(0, bytesRead),
    };
  } finally {
    await handle.close();
  }
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function archiveAttemptId(attempt: AttemptJournal): string {
  return attempt.claimOperationId ?? attempt.snapshot!.attemptId;
}
function bundleOperations(value: RuntimeRecord, requests: Set<string>): Set<string> {
  const refs = new Set(
    value.attempts
      .filter((a) => requests.has(a.requestId))
      .flatMap((a) => [a.claimOperationId, ...a.toolCalls.map((call) => call.operationId)]),
  );
  return new Set(
    value.operations
      .filter((op) => requests.has(String(op.body.requestId)) || refs.has(op.operationId))
      .map((op) => op.operationId),
  );
}
function completedRequests(value: RuntimeRecord): string[] {
  return [...new Set(value.attempts.map((a) => a.requestId))].filter((requestId) => {
    const attempts = value.attempts.filter((a) => a.requestId === requestId);
    if (
      !attempts.some((a) => a.state === "UPLOADED") ||
      attempts.some(
        (a) => a.state !== "UPLOADED" && !(a.state === "NOT_STARTED" && a.unstartedClosure),
      )
    )
      return false;
    for (const attempt of attempts.filter((a) => a.state === "UPLOADED")) {
      if (
        !value.operations.some(
          (op) =>
            ["complete", "observe"].includes(op.action) &&
            op.state === "CONFIRMED" &&
            attemptMatches(attempt, op) &&
            op.body.terminal === attempt.terminal!.terminal &&
            op.body.publicText === attempt.terminal!.publicText &&
            stableJson(op.result) === stableJson(attempt.receipt),
        )
      )
        return false;
    }
    const operations = bundleOperations(value, new Set([requestId]));
    if (
      value.operations.some(
        (op) => operations.has(op.operationId) && !["CONFIRMED", "CLOSED"].includes(op.state),
      )
    )
      return false;
    if (value.preparation && operations.has(value.preparation.operationId)) return false;
    return !value.attempts.some(
      (a) =>
        a.requestId !== requestId &&
        ((a.claimOperationId && operations.has(a.claimOperationId)) ||
          a.toolCalls.some((call) => call.operationId && operations.has(call.operationId))),
    );
  });
}
// These are bytes left free under the 2 MiB cap, not whole-file size thresholds.
export const terminalReserveBytes = 1536 * 1024;
export const admissionReserveBytes = 1792 * 1024;
export const terminalReserveOperations = 8;
export function assertRuntimeCapacity(
  value: RuntimeRecord,
  admission = false,
  extraBytes = 0,
  extraOperations = 0,
): void {
  const reserve = admission ? admissionReserveBytes : terminalReserveBytes;
  if (
    Buffer.byteLength(JSON.stringify(value)) + extraBytes + reserve > journalByteLimit ||
    value.operations.length + extraOperations + terminalReserveOperations + (admission ? 2 : 0) >
      1024 ||
    (admission &&
      (value.attempts.length >= 256 ||
        (value.context?.ownedTurns.length ?? 0) >= 256 ||
        (value.archives ?? []).length >= archiveReferenceLimit ||
        (value.archives ?? []).reduce((sum, ref) => sum + ref.requestIds.length, 0) >=
          archiveRequestLimit))
  ) {
    throw new RuntimeError("RUNTIME_CAPACITY");
  }
}
export class RuntimeStore {
  readonly dir: string;
  readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly archive: RuntimeArchive;
  constructor(
    readonly stateDir: string,
    readonly profile: string,
    readonly agentId: string,
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile) || !isId(agentId)) unsafe();
    this.dir = join(resolve(stateDir), "runtime", profile);
    this.file = join(this.dir, `${agentId}.json`);
    this.archive = new RuntimeArchive(this.dir, agentId);
  }
  async read(): Promise<RuntimeRecord | undefined> {
    await directory(resolve(this.stateDir));
    await directory(this.dir, () => {}, resolve(this.stateDir));
    try {
      const { value } = await readSecure(this.file, 2 * 1024 * 1024);
      validate(value);
      if (value.scope.agentId !== this.agentId) unsafe();
      await this.archiveRecords(value);
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (e instanceof RuntimeError) throw e;
      unsafe();
    }
  }
  write(value: RuntimeRecord, check = () => {}): Promise<void> {
    const snapshot = structuredClone(value);
    validate(snapshot);
    if (snapshot.scope.agentId !== this.agentId) unsafe();
    const work = this.writes.then(async () => {
      check();
      await directory(resolve(this.stateDir), check);
      await directory(this.dir, check, resolve(this.stateDir));
      check();
      let previous: RuntimeRecord | undefined;
      try {
        const input = await readSecure(this.file, 2 * 1024 * 1024, check);
        validate(input.value);
        previous = input.value;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      check();
      if (
        !previous &&
        ((snapshot.archives ?? []).length ||
          snapshot.lastArchive ||
          snapshot.attempts.some((a) => a.sourceObservation !== undefined))
      )
        unsafe();
      const bytes = await this.archive.withVerifiedContents(
        previous?.archives ?? [],
        (contents) => {
          const records = this.parseArchiveRecords(contents);
          if (previous) {
            this.validateArchiveRelationships(previous, records);
            validateChange(previous, snapshot);
          }
          this.validateArchiveRelationships(snapshot, records);
          const serialized = JSON.stringify(snapshot);
          if (Buffer.byteLength(serialized) > journalByteLimit) unsafe();
          return serialized;
        },
        check,
      );
      check();
      const temp = join(this.dir, `.${this.agentId}-${randomUUID()}.tmp`);
      let handle: FileHandle | undefined;
      try {
        check();
        handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        check();
        await handle.writeFile(bytes);
        check();
        await handle.sync();
        check();
        await handle.close();
        handle = undefined;
        check();
        try {
          const current = await lstat(this.file);
          check();
          secureFile(current, 2 * 1024 * 1024);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        check();
        await rename(temp, this.file);
        await syncDirectory(this.dir);
        check();
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
    });
    this.writes = work.catch(() => {});
    return work;
  }
  private parseArchiveRecords(contents: readonly string[]): RuntimeRecord[] {
    return contents.map((content) => {
      let source: unknown;
      try {
        source = JSON.parse(content);
      } catch {
        unsafe();
      }
      validate(source);
      return source;
    });
  }
  private validateArchiveRelationships(value: RuntimeRecord, records: RuntimeRecord[]) {
    const refs = value.archives ?? [];
    if (refs.length !== records.length) unsafe();
    let previousEpoch = 0;
    for (let index = 0; index < refs.length; index++) {
      const source = records[index];
      const { bindingEpoch: epoch, ...scope } = source.scope;
      const { bindingEpoch: currentEpoch, ...currentScope } = value.scope;
      if (
        stableJson(scope) !== stableJson(currentScope) ||
        epoch > currentEpoch ||
        epoch < previousEpoch ||
        stableJson(source.archives ?? []) !== stableJson(refs.slice(0, index))
      )
        unsafe();
      previousEpoch = epoch;
      const eligible = completedRequests(source);
      const selected = refs[index].requestIds;
      if (
        selected.some((id) => !eligible.includes(id)) ||
        stableJson(selected) !== stableJson(eligible.filter((id) => selected.includes(id)))
      )
        unsafe();
      if (source.lastArchive) {
        const prior = records
          .slice(0, index)
          .find((_, i) => refs[i].hash === source.lastArchive!.hash);
        if (
          !prior ||
          prior.attempts.filter(
            (a) =>
              archiveAttemptId(a) === source.lastArchive!.attemptId &&
              refs[records.indexOf(prior)].requestIds.includes(a.requestId),
          ).length !== 1
        )
          unsafe();
      }
    }
    if (value.lastArchive) {
      const index = refs.findIndex((ref) => ref.hash === value.lastArchive!.hash);
      if (
        index < 0 ||
        records[index].attempts.filter(
          (a) =>
            archiveAttemptId(a) === value.lastArchive!.attemptId &&
            refs[index].requestIds.includes(a.requestId),
        ).length !== 1
      )
        unsafe();
    }
  }
  private async archiveRecords(value: RuntimeRecord, check = () => {}): Promise<RuntimeRecord[]> {
    const bytes = await this.archive.verify(value.archives ?? [], check);
    const records = this.parseArchiveRecords(
      bytes.map((data) => new TextDecoder("utf-8", { fatal: true }).decode(data)),
    );
    this.validateArchiveRelationships(value, records);
    return records;
  }
  async lastAttempt(value: RuntimeRecord): Promise<AttemptJournal | undefined> {
    validate(value);
    if (value.scope.agentId !== this.agentId) unsafe();
    const records = await this.archiveRecords(value);
    if (!value.lastArchive) return value.attempts.at(-1);
    const index = (value.archives ?? []).findIndex((ref) => ref.hash === value.lastArchive!.hash);
    return structuredClone(
      records[index].attempts.find((a) => archiveAttemptId(a) === value.lastArchive!.attemptId),
    );
  }
  compact(value: RuntimeRecord, check = () => {}): Promise<RuntimeRecord> {
    const snapshot = structuredClone(value);
    validate(snapshot);
    const work = this.writes.then(async () => {
      check();
      await directory(resolve(this.stateDir), check);
      await directory(this.dir, check, resolve(this.stateDir));
      const input = await readSecure(this.file, journalByteLimit, check);
      validate(input.value);
      if (
        input.value.scope.agentId !== this.agentId ||
        stableJson(input.value) !== stableJson(snapshot)
      )
        unsafe();
      await this.archiveRecords(input.value, check);
      const requestIds = completedRequests(snapshot);
      if (!requestIds.length) return snapshot;
      const refs = snapshot.archives ?? [];
      if (
        refs.length >= archiveReferenceLimit ||
        refs.reduce((sum, ref) => sum + ref.requestIds.length, 0) + requestIds.length >
          archiveRequestLimit
      ) {
        throw new RuntimeError("RUNTIME_CAPACITY");
      }
      const next = structuredClone(snapshot);
      const removedOperations = bundleOperations(snapshot, new Set(requestIds));
      const hash = digest(input.bytes);
      next.archives = [...refs, { hash, requestIds }];
      const last = snapshot.attempts.at(-1);
      if (!snapshot.lastArchive && last && requestIds.includes(last.requestId)) {
        next.lastArchive = { hash, attemptId: archiveAttemptId(last) };
      }
      next.attempts = next.attempts.filter((a) => !requestIds.includes(a.requestId));
      next.operations = next.operations.filter((o) => !removedOperations.has(o.operationId));
      validate(next);
      const bytes = Buffer.from(JSON.stringify(next));
      if (bytes.length > journalByteLimit) throw new RuntimeError("RUNTIME_CAPACITY");
      // No general write can use this deletion exception. The source is the exact owned disk bytes.
      await this.archive.save(input.bytes, check);
      await this.archiveRecords(next, check);
      const temp = join(this.dir, `.${this.agentId}-${randomUUID()}.tmp`);
      let handle: FileHandle | undefined;
      try {
        check();
        handle = await open(
          temp,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        check();
        await handle.writeFile(bytes);
        check();
        await handle.sync();
        check();
        await handle.close();
        handle = undefined;
        const current = await readSecure(this.file, journalByteLimit, check);
        if (!current.bytes.equals(input.bytes)) unsafe();
        check();
        await rename(temp, this.file);
        await syncDirectory(this.dir);
        check();
      } finally {
        await handle?.close();
        await unlink(temp).catch(() => {});
      }
      return next;
    });
    this.writes = work.catch(() => {});
    return work;
  }
  async drainWrites() {
    await this.writes;
  }
  async locked<T>(run: (recovered: boolean) => Promise<T>) {
    await directory(resolve(this.stateDir));
    await directory(this.dir, () => {}, resolve(this.stateDir));
    return this.lock(join(this.dir, `${this.agentId}.lock`), digest(this.file), run);
  }
  async sessionLocked<T>(threadId: string, run: (recovered: boolean) => Promise<T>) {
    if (!validSessionThreadId(threadId)) unsafe();
    const parent = join(await realpath(tmpdir()), `ai-collab-owned-sessions-${process.getuid?.()}`);
    await directory(parent);
    return this.lock(join(parent, `${digest(threadId)}.lock`), digest(threadId), run);
  }
  private async lock<T>(
    path: string,
    identity: string,
    run: (recovered: boolean) => Promise<T>,
  ): Promise<T> {
    let handle: FileHandle;
    let recovered = false;
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") unsafe();
      const recoveryPath = `${path}.recovery`;
      let recovery: FileHandle;
      try {
        recovery = await open(
          recoveryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
      } catch {
        throw new RuntimeError("RUNTIME_BUSY");
      }
      try {
        const old = await readSecure(path, 4096);
        const value = old.value;
        if (!validLockRecord(value, identity)) unsafe();
        try {
          process.kill(Number(value.pid), 0);
          throw new RuntimeError("RUNTIME_BUSY");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new RuntimeError("RUNTIME_BUSY");
        }
        const current = await lstat(path);
        if (current.ino !== old.stat.ino || current.dev !== old.stat.dev) unsafe();
        await unlink(path);
        handle = await open(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        recovered = true;
      } finally {
        await recovery.close();
        await unlink(recoveryPath);
      }
    }
    const token = randomUUID();
    const own = await handle.stat();
    let retain = false;
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, identity }));
      await handle.sync();
      await syncDirectory(dirname(path));
      return await run(recovered);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "CLEANUP_INCOMPLETE") retain = true;
      throw error;
    } finally {
      await this.drainWrites();
      await handle.close();
      if (!retain) {
        const current = await readSecure(path, 4096);
        if (
          current.stat.ino !== own.ino ||
          current.stat.dev !== own.dev ||
          (current.value as { token: string }).token !== token
        )
          unsafe();
        await unlink(path);
        await syncDirectory(dirname(path));
      }
    }
  }
  async remove() {
    const record = await this.read();
    if (record && unresolvedRuntime(record)) throw new RuntimeError("RUNTIME_BUSY");
    if (record) {
      await unlink(this.file);
      await syncDirectory(this.dir);
    }
  }
  static async agents(stateDir: string, profile: string): Promise<string[]> {
    const parent = join(resolve(stateDir), "runtime", profile);
    try {
      await directory(parent, () => {}, resolve(stateDir));
      return (await readdir(parent))
        .filter((name) => name.endsWith(".json") && isId(name.slice(0, -5)))
        .map((name) => name.slice(0, -5));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }
}
export function runtimeRecord(
  scope: RuntimeScope,
  provider: "codex" | "claude" = "codex",
): RuntimeRecord {
  return {
    version: provider === "claude" ? 2 : 1,
    scope,
    settings: null,
    context: null,
    ready: false,
    preparation: null,
    attempts: [],
    operations: [],
  };
}
