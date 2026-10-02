import { closeSync, constants, lstatSync, openSync, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const MANIFEST_KIND = "local-ai-runtime-experiment/v1";
const METADATA_DIRECTORY = ".local-ai-runtime";
const MANIFEST_NAME = "manifest.json";
const OWNER_NAME = "owned";
const LEGACY_LOCK_NAME = "manifest.lock";
const LOCK_DATABASE_NAME = "manifest-lock.sqlite";
const ACTIVE_STATES = new Set<RunState>(["STARTING", "RUNNING", "INTERRUPT_REQUESTED"]);

export type RunState =
  | "READY"
  | "STARTING"
  | "RUNNING"
  | "INTERRUPT_REQUESTED"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "UNKNOWN";

export interface StartIntent {
  readonly operation: "run" | "resume";
  readonly recordedAt: string;
  readonly deadlineAt: string;
}

export interface ExperimentManifest {
  readonly kind: typeof MANIFEST_KIND;
  readonly experimentId: string;
  readonly root: string;
  readonly state: RunState;
  readonly attemptId?: string | undefined;
  readonly startIntent?: StartIntent | undefined;
  readonly threadLocator?: string | undefined;
  readonly turnLocator?: string | undefined;
  readonly contextMarkerHash?: string | undefined;
  readonly contextMarkerMatched?: boolean | undefined;
  readonly eventKinds: readonly string[];
  readonly transitions: readonly RunState[];
  readonly createdAt: string;
  readonly verifiedAt: string;
}

export interface ManifestRepository {
  readonly manifestPath: string;
  withLock<T>(operation: (manifest: ExperimentManifest) => Promise<T>): Promise<T>;
  save(manifest: ExperimentManifest): Promise<void>;
}

export class ExperimentPolicyError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ExperimentPolicyError";
  }
}

export class ExperimentStore implements ManifestRepository {
  private constructor(
    public readonly manifestPath: string,
    public readonly root: string,
    public readonly experimentId: string,
  ) {}

  public static async create(contextMarkerHash?: string, parent = tmpdir()): Promise<ExperimentStore> {
    const experimentId = randomUUID();
    const createdRoot = await mkdtemp(join(parent, `local-ai-runtime-${experimentId}-`));
    await chmod(createdRoot, 0o700);
    const canonicalRoot = await realpath(createdRoot);
    const metadataDirectory = join(canonicalRoot, METADATA_DIRECTORY);
    await mkdir(metadataDirectory, { mode: 0o700 });
    await writePrivateFile(join(metadataDirectory, OWNER_NAME), `${experimentId}\n`);
    await writePrivateFile(
      join(canonicalRoot, "public-context.txt"),
      "Synthetic local AI runtime experiment workspace.\n",
    );
    const store = new ExperimentStore(join(metadataDirectory, MANIFEST_NAME), canonicalRoot, experimentId);
    const now = new Date().toISOString();
    await store.save({
      kind: MANIFEST_KIND,
      experimentId,
      root: canonicalRoot,
      state: "READY",
      ...(contextMarkerHash === undefined ? {} : { contextMarkerHash }),
      eventKinds: [],
      transitions: ["READY"],
      createdAt: now,
      verifiedAt: now,
    });
    return store;
  }

  public static async openOwned(manifestPath: string): Promise<ExperimentStore> {
    const requestedPath = resolve(manifestPath);
    await assertPrivatePath(requestedPath, "file");
    await assertPrivatePath(dirname(requestedPath), "directory");
    await assertPrivatePath(dirname(dirname(requestedPath)), "directory");
    const canonicalManifest = await realpath(requestedPath).catch(() => {
      throw new ExperimentPolicyError("MANIFEST_NOT_FOUND");
    });
    if (basename(canonicalManifest) !== MANIFEST_NAME || basename(dirname(canonicalManifest)) !== METADATA_DIRECTORY) {
      throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
    }
    const root = await realpath(dirname(dirname(canonicalManifest)));
    const expectedManifest = join(root, METADATA_DIRECTORY, MANIFEST_NAME);
    if (canonicalManifest !== expectedManifest) {
      throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
    }
    const manifest = await readManifestFile(canonicalManifest);
    const store = new ExperimentStore(canonicalManifest, root, manifest.experimentId);
    await store.#validateOwnership(manifest);
    return store;
  }

  public static async openById(experimentId: string): Promise<ExperimentStore> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(experimentId)) {
      throw new ExperimentPolicyError("INVALID_EXPERIMENT_ID");
    }
    const temporaryRoot = await realpath(tmpdir());
    const prefix = `local-ai-runtime-${experimentId}-`;
    const candidates = (await readdir(temporaryRoot)).filter((name) => name.startsWith(prefix));
    if (candidates.length === 0) throw new ExperimentPolicyError("EXPERIMENT_NOT_FOUND");
    if (candidates.length !== 1) throw new ExperimentPolicyError("EXPERIMENT_ID_AMBIGUOUS");
    const store = await ExperimentStore.openOwned(join(temporaryRoot, candidates[0]!, METADATA_DIRECTORY, MANIFEST_NAME));
    if (store.experimentId !== experimentId) throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
    return store;
  }

  public async withLock<T>(operation: (manifest: ExperimentManifest) => Promise<T>): Promise<T> {
    await this.#validateOwnership(await this.#read());
    const lock = acquireLock(dirname(this.manifestPath));
    try {
      let manifest = await this.#read();
      await this.#validateOwnership(manifest);
      if (ACTIVE_STATES.has(manifest.state)) {
        manifest = transitionManifest(manifest, "UNKNOWN");
        await this.save(manifest);
      }
      return await operation(manifest);
    } finally {
      try { lock.exec("ROLLBACK"); } finally { lock.close(); }
    }
  }

  public async save(manifest: ExperimentManifest): Promise<void> {
    if (manifest.root !== this.root || manifest.kind !== MANIFEST_KIND) {
      throw new ExperimentPolicyError("MANIFEST_SCOPE_MISMATCH");
    }
    const directory = dirname(this.manifestPath);
    const temporaryPath = join(directory, `.manifest-${randomUUID()}.tmp`);
    const file = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, this.manifestPath);
    await chmod(this.manifestPath, 0o600);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  }

  async #read(): Promise<ExperimentManifest> {
    return await readManifestFile(this.manifestPath);
  }

  async #validateOwnership(manifest: ExperimentManifest): Promise<void> {
    await assertPrivatePath(dirname(this.manifestPath), "directory");
    await assertPrivatePath(join(dirname(this.manifestPath), OWNER_NAME), "file");
    const [manifestStat, rootStat, canonicalRoot, owner] = await Promise.all([
      lstat(this.manifestPath),
      lstat(this.root),
      realpath(manifest.root),
      readFile(join(this.root, METADATA_DIRECTORY, OWNER_NAME), "utf8"),
    ]).catch(() => {
      throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
    });
    if (
      !manifestStat.isFile() ||
      manifestStat.isSymbolicLink() ||
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      canonicalRoot !== this.root ||
      manifest.root !== this.root ||
      manifest.experimentId !== this.experimentId ||
      owner.trim() !== manifest.experimentId ||
      (manifestStat.mode & 0o077) !== 0 ||
      (rootStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && (manifestStat.uid !== process.getuid() || rootStat.uid !== process.getuid()))
    ) {
      throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
    }
  }
}

async function readManifestFile(path: string): Promise<ExperimentManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ExperimentPolicyError("MANIFEST_INVALID");
  }
  if (!isManifest(parsed)) {
    throw new ExperimentPolicyError("MANIFEST_INVALID");
  }
  return parsed;
}

export function transitionManifest(
  manifest: ExperimentManifest,
  state: RunState,
  patch: Partial<Omit<ExperimentManifest, "kind" | "experimentId" | "root" | "state">> = {},
): ExperimentManifest {
  return {
    ...manifest,
    ...patch,
    state,
    transitions: [...manifest.transitions, state],
    verifiedAt: new Date().toISOString(),
  };
}

export function startAttempt(
  manifest: ExperimentManifest,
  operation: "run" | "resume",
  deadlineAt: Date,
): ExperimentManifest {
  if (manifest.state !== "READY" && manifest.state !== "COMPLETED") {
    throw new ExperimentPolicyError("REPLAY_BLOCKED");
  }
  const now = new Date();
  return transitionManifest(manifest, "STARTING", {
    attemptId: randomUUID(),
    startIntent: {
      operation,
      recordedAt: now.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
    },
    turnLocator: undefined,
    contextMarkerMatched: operation === "resume" ? false : manifest.contextMarkerMatched,
  });
}

export function assertResumeAllowed(manifest: ExperimentManifest, canonicalRoot: string): void {
  if (
    manifest.state !== "COMPLETED" ||
    manifest.threadLocator === undefined ||
    manifest.root !== canonicalRoot
  ) {
    throw new ExperimentPolicyError("RESUME_NOT_ALLOWED");
  }
}

function acquireLock(metadataDirectory: string): DatabaseSync {
  // Legacy locks are never interpreted or removed: their owner may still be running.
  try {
    lstatSync(join(metadataDirectory, LEGACY_LOCK_NAME));
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw new ExperimentPolicyError("MANIFEST_LOCKED");
    return openLockDatabase(metadataDirectory);
  }
  throw new ExperimentPolicyError("MANIFEST_LOCKED");
}

function openLockDatabase(metadataDirectory: string): DatabaseSync {
  const databasePath = join(metadataDirectory, LOCK_DATABASE_NAME);
  prepareLockDatabaseFile(databasePath);
  // Private owner-only directories are the trust boundary; same-UID hostile replacement is out of scope.
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(databasePath, { timeout: 0, enableDoubleQuotedStringLiterals: false });
  } catch (error) { throw lockDatabaseError(error); }
  try {
    database.exec("BEGIN IMMEDIATE");
    return database;
  } catch (error) {
    database.close();
    throw lockDatabaseError(error);
  }
}

function prepareLockDatabaseFile(databasePath: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(databasePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
    }
    // Closing a raw fd for an existing SQLite file would cancel this PID's POSIX locks.
    // Exclusive creation closes only a newly created file, before this PID opens SQLite.
    let fd: number | undefined;
    try {
      fd = openSync(databasePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    } catch (creationError) {
      if (!isNodeError(creationError) || creationError.code !== "EEXIST") {
        throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
      }
    }
    if (fd !== undefined) closeSync(fd);
    try { stat = lstatSync(databasePath); }
    catch { throw new ExperimentPolicyError("MANIFEST_NOT_OWNED"); }
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 || !ownedByCurrentUser(stat.uid)) {
    throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
  }
}

function lockDatabaseError(error: unknown): ExperimentPolicyError {
  return new ExperimentPolicyError(
    error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)
      ? "MANIFEST_LOCKED" : "MANIFEST_LOCK_FAILED",
  );
}

async function assertPrivatePath(path: string, kind: "file" | "directory"): Promise<void> {
  const stat = await lstat(path).catch(() => { throw new ExperimentPolicyError("MANIFEST_NOT_OWNED"); });
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory()) ||
      (stat.mode & 0o077) !== 0 || !ownedByCurrentUser(stat.uid)) {
    throw new ExperimentPolicyError("MANIFEST_NOT_OWNED");
  }
}

function ownedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await chmod(path, 0o600);
}

function isManifest(value: unknown): value is ExperimentManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.kind === MANIFEST_KIND &&
    typeof record.experimentId === "string" &&
    typeof record.root === "string" &&
    typeof record.state === "string" &&
    Array.isArray(record.eventKinds) &&
    Array.isArray(record.transitions) &&
    typeof record.createdAt === "string" &&
    typeof record.verifiedAt === "string"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
