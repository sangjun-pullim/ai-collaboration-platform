import { constants } from "node:fs";
import { mkdir, lstat, open, rename, unlink, realpath } from "node:fs/promises";
import { dirname, join, resolve, parse } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ConnectionError, isId, type Body, type Scope } from "./contracts.ts";
export type Mapping = {
  root: string;
  nativeSessionId: string;
  workspaceId?: string;
  agentId?: string;
  bindingEpoch?: number;
  formatVersion?: 2;
  runtime?: "codex" | "claude";
  generation?: string;
  materialization?: "RESERVED" | "MATERIALIZED";
};
export type Pending = {
  action: "begin" | "exchange" | "rotate" | "workspace" | "agent" | "replace";
  body: Body;
  secret?: string;
  candidateCredential?: string;
  candidate?: Mapping;
  payloadHash: string;
};
export type ConnectorState = {
  version: 1;
  server: string;
  status: "pairing" | "connected" | "disconnected";
  code?: string;
  proof?: string;
  pairingId?: string;
  pairingExpiresAt?: string;
  scope?: Scope;
  credential?: string;
  credentialExpiresAt?: string;
  deviceId?: string;
  mappings: Mapping[];
  pending?: Pending;
  registration?: { mapping: Mapping; sessionAlias: string };
};
function refused(): never {
  throw new ConnectionError("FORBIDDEN");
}
function validateMapping(mapping: Mapping) {
  if (
    mapping.formatVersion === undefined &&
    mapping.runtime === undefined &&
    mapping.generation === undefined &&
    mapping.materialization === undefined
  )
    return;
  if (
    mapping.formatVersion !== 2 ||
    !["codex", "claude"].includes(mapping.runtime ?? "") ||
    !isId(mapping.generation) ||
    !isId(mapping.agentId) ||
    !isId(mapping.workspaceId) ||
    !Number.isSafeInteger(mapping.bindingEpoch) ||
    mapping.bindingEpoch! < 1 ||
    typeof mapping.root !== "string" ||
    !mapping.root.startsWith("/") ||
    typeof mapping.nativeSessionId !== "string" ||
    !mapping.nativeSessionId ||
    !["RESERVED", "MATERIALIZED"].includes(mapping.materialization ?? "") ||
    (mapping.runtime === "claude" && !isId(mapping.nativeSessionId)) ||
    (mapping.materialization === "RESERVED" && mapping.runtime !== "claude")
  )
    refused();
}
class ProfileBusy extends ConnectionError {
  constructor() {
    super("FORBIDDEN");
  }
}
export class StateStore {
  readonly dir: string;
  readonly file: string;
  constructor(
    stateDir: string,
    readonly profile: string,
  ) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile)) refused();
    this.dir = resolve(stateDir);
    this.file = join(this.dir, `${profile}.json`);
  }
  private async ensureDir(check = () => {}) {
    check();
    // Inspect every ancestor to refuse symlink traversal before mkdir/open.
    const parts: string[] = [];
    let path = this.dir;
    while (path !== parse(path).root) {
      parts.unshift(path);
      path = dirname(path);
    }
    for (const part of parts) {
      let info;
      try {
        info = await lstat(part);
        check();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") refused();
        check();
        await mkdir(part, { mode: 0o700 });
        check();
        info = await lstat(part);
        check();
      }
      if (!info.isDirectory() || info.isSymbolicLink()) refused();
    }
    const info = await lstat(this.dir);
    check();
    if (
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(this.dir)) !== this.dir
    )
      refused();
  }
  private async checkFile(path: string, check = () => {}) {
    const info = await lstat(path);
    check();
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1
    )
      refused();
  }
  async locked<T>(run: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lockPath = join(this.dir, `${this.profile}.lock`);
    let handle;
    try {
      handle = await open(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      const recoveryPath = join(this.dir, `${this.profile}.recovery.lock`);
      let recovery;
      try {
        recovery = await open(
          recoveryPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ProfileBusy();
        refused();
      }
      try {
        try {
          await this.checkFile(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProfileBusy();
          throw error;
        }
        const lock = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let pid: number;
        const before = await lock.stat();
        try {
          const value = await lock.readFile("utf8");
          if (value === "") throw new ProfileBusy();
          if (!/^[1-9][0-9]{0,9}$/.test(value)) refused();
          pid = Number(value);
        } finally {
          await lock.close();
        }
        try {
          process.kill(pid, 0);
          throw new ProfileBusy();
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw new ProfileBusy();
        }
        const current = await lstat(lockPath);
        if (current.ino !== before.ino || current.dev !== before.dev) refused();
        await unlink(lockPath);
        try {
          handle = await open(
            lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
            0o600,
          );
          await handle.writeFile(String(process.pid));
          await handle.sync();
        } catch {
          refused();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ProfileBusy();
        throw error;
      } finally {
        await recovery.close();
        await unlink(recoveryPath);
      }
    }
    try {
      await handle.truncate(0);
      await handle.write(String(process.pid), 0, "utf8");
      await handle.sync();
      return await run();
    } finally {
      await handle.close();
      await unlink(lockPath);
    }
  }
  async transaction<T>(run: () => Promise<T>, check = () => {}): Promise<T> {
    const deadline = performance.now() + 2000;
    for (;;) {
      check();
      try {
        return await this.locked(async () => {
          check();
          return run();
        });
      } catch (error) {
        if (!(error instanceof ProfileBusy) || performance.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
        check();
      }
    }
  }
  async read(): Promise<ConnectorState | undefined> {
    await this.ensureDir();
    try {
      await this.checkFile(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    let handle;
    try {
      handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (
        stat.size > 65536 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.nlink !== 1
      )
        refused();
      const input = JSON.parse(await handle.readFile("utf8")) as ConnectorState;
      if (
        input.version !== 1 ||
        !Array.isArray(input.mappings) ||
        !["pairing", "connected", "disconnected"].includes(input.status)
      )
        refused();
      input.mappings.forEach(validateMapping);
      return input;
    } catch {
      refused();
    } finally {
      await handle?.close();
    }
  }
  async write(state: ConnectorState, check = () => {}) {
    state.mappings.forEach(validateMapping);
    await this.ensureDir(check);
    check();
    try {
      await this.checkFile(this.file, check);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    check();
    const temp = join(this.dir, `.${this.profile}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      check();
      await handle.writeFile(JSON.stringify(state));
      check();
      await handle.sync();
      check();
      await handle.close();
      handle = undefined;
      check();
      await rename(temp, this.file);
      const directory = await open(this.dir, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      check();
    } finally {
      await handle?.close();
      await unlink(temp).catch(() => {});
    }
  }
  async remove() {
    await this.ensureDir();
    try {
      await this.checkFile(this.file);
      await unlink(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  /** Preserve a never-registered pairing before an explicitly confirmed renewal. Caller holds the profile lock. */
  async archiveExpiredPairing(snapshot: ConnectorState, check = () => {}) {
    if (
      snapshot.status !== "pairing" ||
      snapshot.pending ||
      snapshot.registration ||
      snapshot.credential ||
      snapshot.deviceId ||
      snapshot.mappings.length
    )
      refused();
    await this.ensureDir(check);
    const before = await lstat(this.file);
    check();
    const source = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const info = await source.stat();
      check();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o600 ||
        info.nlink !== 1 ||
        info.size > 65536 ||
        info.ino !== before.ino ||
        info.dev !== before.dev
      )
        refused();
      bytes = await source.readFile();
      check();
      if (JSON.stringify(JSON.parse(bytes.toString("utf8"))) !== JSON.stringify(snapshot))
        refused();
    } finally {
      await source.close();
    }
    const archive = await open(
      join(this.dir, `.expired-pairing-${randomUUID()}.json`),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      check();
      await archive.writeFile(bytes);
      check();
      await archive.sync();
      check();
    } finally {
      await archive.close();
    }
    const directory = await open(this.dir, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await directory.sync();
      check();
      const unchanged = JSON.stringify(await this.read()) === JSON.stringify(snapshot);
      check();
      const current = await lstat(this.file);
      check();
      if (
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs ||
        !unchanged
      )
        refused();
      check();
      await unlink(this.file);
      await directory.sync();
      check();
    } finally {
      await directory.close();
    }
  }
}
