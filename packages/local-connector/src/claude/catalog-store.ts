import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isHash, isId } from "../contracts.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type OwnedContext,
  type RootIdentity,
} from "../runtime-contracts.ts";
import type { StateStore } from "../state-store.ts";
import { canonicalAncestors, fileIdentity, readConfigurationFile } from "./configuration.ts";
import type { Cleanup } from "./transport.ts";

interface Ledger {
  schema: 1;
  profile: string;
  status: "RESERVED" | "UNKNOWN" | "CLOSED";
  token: string;
  context: OwnedContext;
}
export interface CatalogLease {
  readonly token: string;
  readonly context: OwnedContext;
}
export interface CatalogSync {
  file(fd: number): void;
  directory(fd: number): void;
}
/** One fixed profile ledger persists barriers independently of settings lock PID recovery. */
export class ClaudeCatalogStore {
  readonly directory: string;
  readonly file: string;
  private readonly anchor: string;
  constructor(
    private readonly profile: Pick<StateStore, "dir" | "profile">,
    private readonly sync: CatalogSync = { file: fsyncSync, directory: fsyncSync },
  ) {
    if (profile.dir !== resolve(profile.dir) || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(profile.profile))
      throw new RuntimeError("UNSAFE_STORAGE");
    this.directory = join(profile.dir, `${profile.profile}.claude-catalog`);
    this.file = join(this.directory, "ledger.json");
    this.anchor = join(profile.dir, `${profile.profile}.claude-catalog.identity.json`);
  }
  private secureDirectory(path: string) {
    canonicalAncestors(path);
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700 ||
      realpathSync(path) !== path
    )
      throw new RuntimeError("UNSAFE_STORAGE");
  }
  private read(): Ledger | undefined {
    canonicalAncestors(this.directory);
    canonicalAncestors(this.anchor);
    if (!existsSync(this.directory)) {
      if (existsSync(this.anchor)) throw new RuntimeError("UNSAFE_STORAGE");
      return undefined;
    }
    this.secureDirectory(this.directory);
    // Once the private ledger directory exists, missing/renamed ledgers fail closed.
    let before;
    try {
      before = lstatSync(this.file);
    } catch {
      throw new RuntimeError("UNSAFE_STORAGE");
    }
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o777) !== 0o600 ||
      before.size > 16384
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    const fd = openSync(
      this.file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (fileIdentity(fstatSync(fd)) !== fileIdentity(before))
        throw new RuntimeError("UNSAFE_STORAGE");
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) break;
        offset += count;
      }
      if (
        offset !== before.size ||
        fileIdentity(fstatSync(fd)) !== fileIdentity(before) ||
        fileIdentity(lstatSync(this.file)) !== fileIdentity(before)
      )
        throw new RuntimeError("UNSAFE_STORAGE");
      let ledger: Ledger;
      try {
        ledger = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)),
        ) as Ledger;
      } catch {
        throw new RuntimeError("UNSAFE_STORAGE");
      }
      const context = ledger?.context,
        materialization = context?.materialization,
        root = context?.root;
      if (
        ledger.schema !== 1 ||
        ledger.profile !== this.profile.profile ||
        !["RESERVED", "UNKNOWN", "CLOSED"].includes(ledger.status) ||
        !isId(ledger.token) ||
        !context ||
        context.ownership !== "CONNECTOR_CREATED" ||
        context.provider !== "claude" ||
        !isId(context.threadId) ||
        !isId(context.generation) ||
        context.epoch !== 1 ||
        context.level !== "L1" ||
        !Array.isArray(context.ownedTurns) ||
        context.ownedTurns.length !== 0 ||
        !root ||
        typeof root.path !== "string" ||
        root.path !== resolve(root.path) ||
        [root.dev, root.ino, root.uid].some((value) => !Number.isSafeInteger(value) || value < 0) ||
        materialization?.state !== "RESERVED" ||
        materialization.initHash !== null ||
        !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(materialization.version) ||
        !isHash(materialization.policyFingerprint)
      )
        throw new RuntimeError("UNSAFE_STORAGE");
      let anchorStat;
      try {
        anchorStat = lstatSync(this.anchor);
      } catch {
        throw new RuntimeError("UNSAFE_STORAGE");
      }
      if ((anchorStat.mode & 0o777) !== 0o600) throw new RuntimeError("UNSAFE_STORAGE");
      const anchorBytes = readConfigurationFile(this.anchor, 1024);
      if (!anchorBytes) throw new RuntimeError("UNSAFE_STORAGE");
      let anchor: { identity: string; hash: string };
      try {
        anchor = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(anchorBytes),
        ) as typeof anchor;
      } catch {
        throw new RuntimeError("UNSAFE_STORAGE");
      }
      if (
        anchor.identity !== fileIdentity(before) ||
        anchor.hash !== digest(bytes.subarray(0, offset).toString("base64"))
      )
        throw new RuntimeError("UNSAFE_STORAGE");
      return ledger;
    } finally {
      closeSync(fd);
    }
  }
  assertStartup(lease?: CatalogLease): void {
    const ledger = this.read();
    if (!ledger || ledger.status === "CLOSED") return;
    if (
      ledger.status === "RESERVED" &&
      lease &&
      ledger.token === lease.token &&
      stableJson(ledger.context) === stableJson(lease.context)
    )
      return;
    throw new RuntimeError("CLEANUP_INCOMPLETE");
  }
  private atomicFile(path: string, contents: string): void {
    this.secureDirectory(this.directory);
    const temp = join(this.directory, `.${randomUUID()}.tmp`);
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, contents);
      this.sync.file(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, path);
      const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        this.sync.directory(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        /* Atomic rename normally consumes the temp. */
      }
    }
  }
  private write(ledger: Ledger): void {
    const contents = JSON.stringify(ledger);
    this.atomicFile(this.file, contents);
    // A fixed durable identity detects ledger rename/replacement even after restart.
    this.atomicFile(
      this.anchor,
      JSON.stringify({
        identity: fileIdentity(lstatSync(this.file)),
        hash: digest(Buffer.from(contents).toString("base64")),
      }),
    );
  }
  reserve(root: RootIdentity, version: string, fingerprint: string): CatalogLease {
    this.assertStartup();
    if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || !isHash(fingerprint))
      throw new RuntimeError("POLICY_UNCONFIRMED");
    canonicalAncestors(root.path);
    const stat = lstatSync(root.path);
    if (
      !stat.isDirectory() ||
      root.path !== realpathSync(root.path) ||
      root.dev !== stat.dev ||
      root.ino !== stat.ino ||
      root.uid !== stat.uid
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    canonicalAncestors(this.profile.dir);
    if (!existsSync(this.profile.dir))
      mkdirSync(this.profile.dir, { recursive: true, mode: 0o700 });
    this.secureDirectory(this.profile.dir);
    if (!existsSync(this.directory)) {
      mkdirSync(this.directory, { mode: 0o700 });
      const parent = openSync(dirname(this.directory), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        this.sync.directory(parent);
      } finally {
        closeSync(parent);
      }
    }
    const context: OwnedContext = {
      ownership: "CONNECTOR_CREATED",
      provider: "claude",
      generation: randomUUID(),
      threadId: randomUUID(),
      root: structuredClone(root),
      epoch: 1,
      level: "L1",
      ownedTurns: [],
      materialization: {
        state: "RESERVED",
        version,
        policyFingerprint: fingerprint,
        initHash: null,
      },
    };
    const token = randomUUID();
    this.write({ schema: 1, profile: this.profile.profile, status: "RESERVED", token, context });
    return Object.freeze({ token, context: structuredClone(context) });
  }
  finish(lease: CatalogLease, cleanup: Cleanup): void {
    const ledger = this.read();
    if (
      !ledger ||
      ledger.token !== lease.token ||
      stableJson(ledger.context) !== stableJson(lease.context) ||
      ledger.status !== "RESERVED"
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    // The actual owned transport result is the only cleanup evidence accepted here.
    this.write({
      ...ledger,
      status: cleanup.reaped && cleanup.code === "REAPED" ? "CLOSED" : "UNKNOWN",
    });
  }
}
