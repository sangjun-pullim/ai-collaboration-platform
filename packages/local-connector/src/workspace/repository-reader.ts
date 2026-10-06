import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { digest, RuntimeError, type RootIdentity } from "../runtime-contracts.ts";
import { captureDirectory, readSafeFile, type Check } from "./safe-file-reader.ts";
import {
  isRepositoryDirectory,
  isRepositoryFile,
  isRepositoryPath,
} from "./repository-path-policy.ts";

const outputLimit = 8192;
const limits = {
  calls: 256,
  concurrent: 4,
  entries: 20000,
  directories: 512,
  bytes: 32 * 1024 * 1024,
  callMs: 3000,
  activeMs: 30000,
} as const;
interface Entry {
  path: string;
  type: "file" | "directory";
}
interface Observation {
  path: string;
  hash: string;
  readAt: string;
  byteStart: number;
  byteEnd: number;
  excerptHash: string;
}
interface ReadResult extends Observation {
  text: string;
  size: number;
  lineCount: number;
  nextOffset: number | null;
  truncated: boolean;
}
interface Match extends Observation {
  line: number;
  excerpt: string;
}
class TraversalCapacity extends RuntimeError {
  constructor() {
    super("RUNTIME_CAPACITY");
  }
}
const jsonSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function validDirectory(value: unknown) {
  return isRepositoryPath(value, true) && (value === "" || isRepositoryDirectory(value));
}
function boundary(bytes: Buffer, offset: number) {
  return offset === bytes.length || (bytes[offset] & 0xc0) !== 0x80;
}
function fitText(
  bytes: Buffer,
  start: number,
  end: number,
  make: (text: string, byteEnd: number) => unknown,
) {
  let low = start,
    high = end;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    let candidate = middle;
    while (candidate > start && !boundary(bytes, candidate)) candidate--;
    if (
      jsonSize(make(bytes.subarray(start, candidate).toString("utf8"), candidate)) <= outputLimit
    ) {
      if (candidate === low) {
        let next = low + 1;
        while (next < end && !boundary(bytes, next)) next++;
        if (jsonSize(make(bytes.subarray(start, next).toString("utf8"), next)) > outputLimit) break;
        low = next;
      } else low = candidate;
    } else high = candidate > low ? candidate - 1 : low;
  }
  while (low > start && !boundary(bytes, low)) low--;
  return low;
}

// One instance owns the cumulative budget for one authorized execution. Construction grants no authority.
export class RepositoryReader {
  private readonly root: RootIdentity;
  private calls = 0;
  private active = 0;
  private activeSince = 0;
  private activeElapsed = 0;
  private entries = 0;
  private directories = 0;
  private bytes = 0;
  constructor(
    root: RootIdentity,
    private readonly check: Check,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.root = { ...root };
  }
  private async run<T>(operation: (check: Check) => Promise<T>): Promise<T> {
    this.check();
    if (this.calls >= limits.calls) throw new RuntimeError("RUNTIME_CAPACITY");
    this.calls++;
    if (this.active >= limits.concurrent) throw new RuntimeError("RUNTIME_BUSY");
    const start = this.now();
    if (this.active === 0) this.activeSince = start;
    this.active++;
    let checkFailed = false;
    let checkFailure: unknown;
    const guard = () => {
      if (checkFailed) throw checkFailure;
      try {
        this.check();
      } catch (error) {
        checkFailed = true;
        checkFailure = error;
        throw error;
      }
      const now = this.now();
      if (
        now - start >= limits.callMs ||
        this.activeElapsed + now - this.activeSince >= limits.activeMs
      )
        throw new RuntimeError("RUNTIME_CAPACITY");
    };
    try {
      guard();
      const result = await operation(guard);
      guard();
      return result;
    } catch (error) {
      if (checkFailed) throw checkFailure;
      guard();
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("TOOL_REJECTED");
    } finally {
      this.active--;
      if (this.active === 0) this.activeElapsed += this.now() - this.activeSince;
    }
  }
  private reserveBytes = (count: number) => {
    if (this.bytes + count > limits.bytes) throw new TraversalCapacity();
    this.bytes += count;
  };
  private async directory(
    path: string,
    check: Check,
    visit: (entry: Entry) => Promise<boolean>,
  ): Promise<boolean> {
    check();
    if (this.directories >= limits.directories) throw new TraversalCapacity();
    this.directories++;
    const absolute = join(this.root.path, path);
    const verify = await captureDirectory(this.root, absolute, check);
    check();
    const handle = await opendir(absolute, { bufferSize: 1 });
    let complete = true;
    try {
      check();
      await verify();
      for (;;) {
        check();
        await verify();
        // Reserve synchronously before read; EOF and failed observations also consume the slot.
        if (this.entries >= limits.entries) throw new TraversalCapacity();
        this.entries++;
        const entry = await handle.read();
        check();
        await verify();
        if (!entry) break;
        const relative = path ? `${path}/${entry.name}` : entry.name;
        const directory = entry.isDirectory();
        if (!(directory ? isRepositoryDirectory(relative) : isRepositoryFile(relative))) continue;
        const info = await lstat(join(this.root.path, relative));
        check();
        await verify();
        if (
          info.isSymbolicLink() ||
          info.uid !== this.root.uid ||
          (info.mode & 0o022) !== 0 ||
          (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
        ) {
          complete = false;
          continue;
        }
        if (!(await visit({ path: relative, type: directory ? "directory" : "file" }))) {
          complete = false;
          break;
        }
        check();
      }
    } finally {
      await handle.close();
    }
    await verify();
    check();
    return complete;
  }
  list(input: { directory?: string; after?: string } = {}) {
    return this.run(async (check) => {
      const directory = input.directory ?? "";
      if (
        !validDirectory(directory) ||
        (input.after !== undefined &&
          (!isRepositoryPath(input.after) ||
            (input.after.includes("/")
              ? input.after.slice(0, input.after.lastIndexOf("/"))
              : "") !== directory))
      )
        throw new RuntimeError("TOOL_REJECTED");
      const entries: Entry[] = [];
      let truncated = false;
      try {
        truncated = !(await this.directory(directory, check, async (entry) => {
          if (!input.after || compare(entry.path, input.after) > 0) entries.push(entry);
          return true;
        }));
      } catch (error) {
        if (!(error instanceof TraversalCapacity)) throw error;
        truncated = true;
      }
      entries.sort((a, b) => compare(a.path, b.path));
      const result: { entries: Entry[]; nextCursor: string | null; truncated: boolean } = {
        entries: [],
        nextCursor: null,
        truncated,
      };
      for (const entry of entries) {
        const candidate = {
          entries: [...result.entries, entry],
          nextCursor: entry.path,
          truncated: true,
        };
        if (result.entries.length >= 64 || jsonSize(candidate) > outputLimit) {
          result.truncated = true;
          break;
        }
        result.entries.push(entry);
      }
      if (result.truncated && result.entries.length)
        result.nextCursor = result.entries.at(-1)!.path;
      return result;
    });
  }
  read(input: { path: string; offset?: number; expectedHash?: string }) {
    return this.run(async (check) => {
      if (
        !isRepositoryFile(input.path) ||
        (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) ||
        (input.expectedHash !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedHash))
      )
        throw new RuntimeError("TOOL_REJECTED");
      const file = await readSafeFile(
        this.root,
        input.path,
        check,
        "repository",
        this.reserveBytes,
      );
      const start = input.offset ?? 0;
      if (start > file.bytes.length || !boundary(file.bytes, start))
        throw new RuntimeError("TOOL_REJECTED");
      if (input.expectedHash && input.expectedHash !== file.snapshot.hash)
        throw new RuntimeError("SNAPSHOT_CHANGED");
      const readAt = new Date().toISOString();
      let lineCount = 1;
      for (
        let index = file.text.indexOf("\n");
        index !== -1;
        index = file.text.indexOf("\n", index + 1)
      )
        lineCount++;
      const make = (text: string, end: number): ReadResult => ({
        path: input.path,
        text,
        hash: file.snapshot.hash,
        size: file.bytes.length,
        lineCount,
        readAt,
        byteStart: start,
        byteEnd: end,
        excerptHash: digest(file.bytes.subarray(start, end)),
        nextOffset: end < file.bytes.length ? end : null,
        truncated: end < file.bytes.length,
      });
      const end = fitText(file.bytes, start, file.bytes.length, make);
      const result = make(file.bytes.subarray(start, end).toString("utf8"), end);
      if (jsonSize(result) > outputLimit) throw new RuntimeError("TOOL_REJECTED");
      return result;
    });
  }
  search(input: { query: string; directory?: string }) {
    return this.run(async (check) => {
      const directory = input.directory ?? "";
      if (
        !validDirectory(directory) ||
        typeof input.query !== "string" ||
        input.query.length === 0 ||
        input.query.length > 256
      )
        throw new RuntimeError("TOOL_REJECTED");
      const result: { matches: Match[]; truncated: boolean } = { matches: [], truncated: false };
      const pending = [directory];
      let stopped = false;
      while (pending.length && !stopped) {
        const path = pending.pop()!;
        try {
          const complete = await this.directory(path, check, async (entry) => {
            if (entry.type === "directory") {
              pending.push(entry.path);
              return true;
            }
            let file;
            try {
              file = await readSafeFile(
                this.root,
                entry.path,
                check,
                "repository",
                this.reserveBytes,
              );
            } catch (error) {
              check();
              if (error instanceof RuntimeError && error.code === "TOOL_REJECTED") {
                result.truncated = true;
                return true;
              }
              throw error;
            }
            const readAt = new Date().toISOString();
            let byteStart = 0;
            const lines = file.text.split("\n");
            for (let index = 0; index < lines.length; index++) {
              check();
              const line = lines[index];
              const length = Buffer.byteLength(line);
              const matchIndex = line.indexOf(input.query);
              if (matchIndex !== -1) {
                let contextIndex = Math.max(0, matchIndex - 80);
                if (contextIndex > 0 && /[\uDC00-\uDFFF]/.test(line[contextIndex])) contextIndex--;
                let excerptStart = byteStart + Buffer.byteLength(line.slice(0, contextIndex));
                if (result.matches.length >= 16) {
                  stopped = true;
                  return false;
                }
                const make = (excerpt: string, byteEnd: number): Match => ({
                  path: entry.path,
                  line: index + 1,
                  excerpt,
                  hash: file.snapshot.hash,
                  readAt,
                  byteStart: excerptStart,
                  byteEnd,
                  excerptHash: digest(file.bytes.subarray(excerptStart, byteEnd)),
                });
                const fitMatch = () => {
                  const end = fitText(
                    file.bytes,
                    excerptStart,
                    byteStart + length,
                    (excerpt, end) => ({
                      matches: [...result.matches, make(excerpt, end)],
                      truncated: true,
                    }),
                  );
                  return make(file.bytes.subarray(excerptStart, end).toString("utf8"), end);
                };
                let match = fitMatch();
                if (!match.excerpt.includes(input.query)) {
                  result.truncated = true;
                  // Drop leading context before giving up on the complete literal match.
                  let queryStart = matchIndex;
                  if (queryStart > 0 && /[\uDC00-\uDFFF]/.test(line[queryStart])) queryStart--;
                  excerptStart = byteStart + Buffer.byteLength(line.slice(0, queryStart));
                  match = fitMatch();
                }
                if (
                  !match.excerpt.includes(input.query) ||
                  jsonSize({ matches: [...result.matches, match], truncated: true }) > outputLimit
                ) {
                  stopped = true;
                  return false;
                }
                result.matches.push(match);
                if (match.byteEnd < byteStart + length) {
                  stopped = true;
                  return false;
                }
              }
              byteStart += length + (index < lines.length - 1 ? 1 : 0);
            }
            return true;
          });
          if (!complete) result.truncated = true;
        } catch (error) {
          check();
          if (!(error instanceof TraversalCapacity)) throw error;
          stopped = true;
        }
      }
      if (stopped || pending.length) result.truncated = true;
      return result;
    });
  }
}
