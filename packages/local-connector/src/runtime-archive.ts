import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { digest, RuntimeError, type RuntimeArchiveReference } from "./runtime-contracts.ts";

export const journalByteLimit = 2 * 1024 * 1024;
export const archiveReferenceLimit = 64;
export const archiveRequestLimit = 4096;
const archiveByteLimit = 128 * 1024 * 1024;

function unsafe(): never {
  throw new RuntimeError("UNSAFE_STORAGE");
}
function secureFile(stat: Stats) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > journalByteLimit) unsafe();
}
function sameIdentity(before: Stats, after: Stats) {
  secureFile(after);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) unsafe();
}

/** Owned file evidence only. Permission to remove journals remains in RuntimeStore. */
export class RuntimeArchive {
  readonly dir: string;
  constructor(parent: string, agentId: string) {
    this.dir = join(parent, "archives", agentId);
  }
  private path(hash: string) {
    if (!/^[a-f0-9]{64}$/.test(hash)) unsafe();
    return join(this.dir, `${hash}.json`);
  }
  private async directory(create: boolean, check: () => void) {
    const parts: string[] = [];
    let path = resolve(this.dir);
    while (path !== parse(path).root) {
      parts.unshift(path);
      path = dirname(path);
    }
    for (const part of parts) {
      let stat: Stats;
      try {
        stat = await lstat(part);
        check();
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        check();
        await mkdir(part, { mode: 0o700 });
        check();
        stat = await lstat(part);
        check();
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) unsafe();
      if (part === dirname(this.dir) || part === this.dir) {
        if (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) unsafe();
      }
    }
    const canonical = await realpath(this.dir);
    check();
    if (canonical !== this.dir) unsafe();
  }
  private async sync(path: string, check: () => void) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      check();
      const stat = await handle.stat();
      check();
      if (stat.isFile()) secureFile(stat);
      else if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) unsafe();
      await handle.sync();
      check();
    } finally { await handle.close(); }
  }
  async read(hash: string, check = () => {}): Promise<Buffer> {
    try {
      await this.directory(false, check);
      const path = this.path(hash);
      const before = await lstat(path);
      check();
      secureFile(before);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        check();
        const opened = await handle.stat();
        check();
        sameIdentity(before, opened);
        const bytes = Buffer.alloc(opened.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          check();
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        check();
        sameIdentity(opened, after);
        const current = await lstat(path);
        check();
        sameIdentity(opened, current);
        await this.directory(false, check);
        if (offset !== opened.size) unsafe();
        const data = bytes.subarray(0, offset);
        new TextDecoder("utf-8", { fatal: true }).decode(data);
        if (digest(data) !== hash) unsafe();
        return data;
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      unsafe();
    }
  }
  async verify(references: RuntimeArchiveReference[], check = () => {}): Promise<Buffer[]> {
    if (references.length > archiveReferenceLimit ||
        references.reduce((sum, ref) => sum + ref.requestIds.length, 0) > archiveRequestLimit) unsafe();
    const hashes = new Set<string>();
    const requests = new Set<string>();
    const files: Buffer[] = [];
    let total = 0;
    for (const ref of references) {
      if (hashes.has(ref.hash)) unsafe();
      hashes.add(ref.hash);
      for (const requestId of ref.requestIds) {
        if (requests.has(requestId)) unsafe();
        requests.add(requestId);
      }
      const bytes = await this.read(ref.hash, check);
      total += bytes.length;
      if (total > archiveByteLimit) unsafe();
      files.push(bytes);
    }
    return files;
  }
  async save(bytes: Buffer, check = () => {}): Promise<string> {
    if (bytes.length > journalByteLimit) unsafe();
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const hash = digest(bytes);
    await this.directory(true, check);
    // Persist the newly created directory entries before the main journal can refer to them.
    await this.sync(dirname(dirname(this.dir)), check);
    await this.sync(dirname(this.dir), check);
    const path = this.path(hash);
    let handle;
    try {
      check();
      handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const prior = await this.read(hash, check);
      if (!prior.equals(bytes)) unsafe();
      await this.sync(path, check);
      await this.sync(this.dir, check);
      return hash;
    }
    let durable = false;
    try {
      check();
      await handle.writeFile(bytes);
      check();
      await handle.sync();
      check();
      durable = true;
    } finally {
      await handle.close();
      if (!durable) await unlink(path).catch(() => {});
    }
    const saved = await this.read(hash, check);
    if (!saved.equals(bytes)) unsafe();
    await this.sync(this.dir, check);
    return hash;
  }
}
