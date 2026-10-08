import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, realpath, lstat, open, rename } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  LocalAccessStack,
  assertOwnedStack,
  productEnvironment,
  ensure,
  type FixturePerson,
} from "./local-access-stack.js";
import {
  isHash,
  isId,
  validateBody,
  projectResponse,
} from "../../src/features/device-binding/contracts.js";
import { authBrowserChildEnvironment } from "./auth-browser-artifact-policy.js";
const execute = promisify(execFile);
export const frozenAccessMigrations: Record<string, string> = {
  "20261001000100-web-auth-room-access.sql":
    "3656625ed20441fb88b406ee91e07a1edfd95475211b9a9bd902488df663f83f",
  "20261001000200-deny-inactive-auth-reads.sql":
    "9f156193650c3b8144cebf297b8377e2d963a227f7e5afb36044a7d3909d6972",
  "20261001000300-deny-soft-deleted-auth.sql":
    "57ef9a665739d3541aaad46987520e061176643c5aeab0a757d353ff89c674da",
  "20261001000400-device-workspace-binding.sql":
    "6ef236b65e053aeaa7eefdefcad7400505c4d0946cdcea5873588897285b3c3b",
  "20261001000500-device-cascade-integrity.sql":
    "e7345dcf4302e40fbf772edda8dab6cc3fce84aeb99ffd224ed979a06032de7c",
};
export async function assertDeviceMigrationSources() {
  for (const [name, expected] of Object.entries(frozenAccessMigrations))
    ensure(
      createHash("sha256")
        .update(await readFile(resolve("supabase/migrations", name)))
        .digest("hex") === expected,
      "Frozen access migration source has changed",
    );
  const current = createHash("sha256")
    .update(
      await readFile(resolve("supabase/migrations/20261001000400-device-workspace-binding.sql")),
    )
    .digest("hex");
  const followup = createHash("sha256")
    .update(
      await readFile(resolve("supabase/migrations/20261001000500-device-cascade-integrity.sql")),
    )
    .digest("hex");
  return {
    migration: "20261001000400",
    sha256: current,
    followup: { migration: "20261001000500", sha256: followup },
  };
}
type FailureStage =
  | "setup"
  | "assertion"
  | "pairing-recovery"
  | "device-cleanup"
  | "stack-cleanup"
  | "private-root-cleanup";
class DeviceCheckFailure extends Error {
  constructor(stage: FailureStage, frames: RegExpMatchArray[]) {
    super(
      `Owned device ${stage} failed${frames.length ? ` at ${frames.map((frame) => `${frame[1]}:${frame[2]}:${frame[3]}`).join(" <- ")}` : ""}; private diagnostics withheld`,
    );
  }
}
function safeFailure(error: unknown, stage: FailureStage) {
  if (error instanceof DeviceCheckFailure) return error;
  const frames =
    error instanceof Error
      ? error.stack
          ?.split("\n")
          .slice(1)
          .map((line) =>
            line.match(
              /\/(device-workspace-binding\.test|device-binding-fixture|local-access-stack)\.(?:js|ts):(\d+):(\d+)(?:\)|$)/,
            ),
          )
          .filter((frame): frame is RegExpMatchArray => !!frame)
          .slice(0, 2)
      : undefined;
  return new DeviceCheckFailure(stage, frames ?? []);
}
function addFailure(failures: Error[], error: unknown, stage: FailureStage) {
  if (
    error instanceof AggregateError &&
    error.errors.every((item) => item instanceof DeviceCheckFailure)
  )
    failures.push(...error.errors);
  else failures.push(safeFailure(error, stage));
}
function combinedFailure(failures: Error[]) {
  return failures.length === 1
    ? failures[0]
    : new AggregateError(
        failures,
        "Owned device checks and cleanup failed; private diagnostics withheld",
      );
}
export const digest = (v: string) => createHash("sha256").update(v).digest("hex");
export const secret = () => randomBytes(32).toString("hex");
export type DeviceProfile = {
  name: string;
  code: string;
  proof: string;
  pairingId: string;
  codeHash: string;
  proofHash: string;
  credential?: string;
  deviceId?: string;
  roomId?: string;
  organizationId?: string;
  ownerUserId?: string;
  agentId?: string;
  workspaceId?: string;
};
export type PairFault =
  "response-lost" | "cli-response-invalid" | "stdout-lost" | "state-validation";
export type PairingIntent = {
  name: string;
  source: "cli" | "api";
  server: string;
  codeHash?: string;
  proofHash?: string;
  pairingId?: string;
};
export type DeviceResponse = {
  status: number;
  headers: Headers;
  data: Record<string, unknown>;
  text: string;
};
export class DeviceFixture {
  readonly profiles = new Map<string, DeviceProfile>();
  readonly hashes = new Set<string>();
  readonly pairingIntents = new Map<string, PairingIntent>();
  private readonly pairingSeeds = new Map<string, { code: string; proof: string }>();
  private identityWrites: Promise<void> = Promise.resolve();
  private constructor(
    readonly stack: LocalAccessStack,
    readonly root: string,
  ) {
    stack.onOwnedIdentity = () => this.saveCleanupIdentity();
  }
  static async open(label: string) {
    await assertDeviceMigrationSources();
    const stack = await LocalAccessStack.open(`device-${label}`);
    try {
      const installed = await stack.db.query(
        "select to_regclass('device_binding_private.pairings') is not null pairing,to_regprocedure('public.connector_exchange(jsonb,text)') is not null exchange,to_regprocedure('public.connection_list()') is not null human",
      );
      ensure(
        installed.rows[0].pairing && installed.rows[0].exchange && installed.rows[0].human,
        "The device migration must be applied by the supervising agent before actual checks",
      );
      const receipts = await stack.db.query(
        "select count(*)::int n,bool_and(condeferrable and condeferred and convalidated and confdeltype='a') ready from pg_constraint where (conrelid='device_binding_private.workspaces'::regclass and conname='workspaces_device_id_registration_credential_hash_fkey') or (conrelid='device_binding_private.agents'::regclass and conname in ('agents_device_id_registration_credential_hash_fkey','agents_device_id_replacement_credential_hash_fkey'))",
      );
      ensure(
        receipts.rows[0].n === 3 && receipts.rows[0].ready,
        "The receipt cascade followup must be applied by the supervising agent before actual checks",
      );
      const root = await mkdtemp(join(await realpath(tmpdir()), "device-actual-"));
      await mkdir(join(root, "repository"));
      const fixture = new DeviceFixture(stack, root);
      await fixture.saveCleanupIdentity();
      return fixture;
    } catch (error) {
      const failures = [safeFailure(error, "setup")];
      try {
        await stack.close();
      } catch (cleanup) {
        failures.push(safeFailure(cleanup, "stack-cleanup"));
      }
      throw combinedFailure(failures);
    }
  }
  async saveCleanupIdentity() {
    const pending = this.identityWrites.then(() => this.writeCleanupIdentity());
    this.identityWrites = pending.catch(() => {});
    return pending;
  }
  private async writeCleanupIdentity() {
    const directory = await lstat(this.root);
    ensure(
      directory.isDirectory() &&
        !directory.isSymbolicLink() &&
        directory.uid === process.getuid?.() &&
        (directory.mode & 0o777) === 0o700 &&
        (await realpath(this.root)) === this.root,
      "Refusing an unsafe cleanup identity directory",
    );
    const file = join(this.root, "cleanup-identity.json");
    try {
      const existing = await lstat(file);
      ensure(
        existing.isFile() &&
          !existing.isSymbolicLink() &&
          existing.uid === process.getuid?.() &&
          (existing.mode & 0o777) === 0o600 &&
          existing.nlink === 1,
        "Refusing an unsafe cleanup identity manifest",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const identity = {
      version: 1,
      project: this.stack.config.project,
      api: this.stack.config.api,
      app: this.stack.config.app,
      namespace: this.stack.namespace,
      users: [...this.stack.users],
      organizations: [...this.stack.organizationOwners].map(([id, ownerUserId]) => ({
        id,
        ownerUserId,
      })),
      hashes: [...this.hashes],
      pairings: [...this.pairingIntents.values()].map((intent) => {
        const p = this.profiles.get(intent.name);
        return {
          name: intent.name,
          source: intent.source,
          profileFile: `state/${intent.name}.json`,
          codeHash: intent.codeHash,
          proofHash: intent.proofHash,
          pairingId: intent.pairingId,
          deviceId: p?.deviceId,
          ownerUserId: p?.ownerUserId,
          organizationId: p?.organizationId,
          roomId: p?.roomId,
        };
      }),
    };
    const temporary = join(this.root, `.cleanup-identity-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(JSON.stringify(identity));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
      const parent = await open(
        this.root,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
  async cli(name: string, command: string, args: string[] = []) {
    await assertOwnedStack(this.stack.config);
    ensure(/^[a-z0-9-]+$/.test(name), "Unknown local fixture profile");
    await this.saveCleanupIdentity();
    const argv = [
      resolve("packages/local-connector/dist/src/cli.js"),
      command,
      "--state-dir",
      join(this.root, "state"),
      "--profile",
      name,
      "--server",
      this.pairingIntents.get(name)?.server ?? this.stack.config.app,
      ...args,
    ];
    try {
      const result = await execute(process.execPath, argv, {
        env: productEnvironment({ PATH: process.env.PATH, LANG: "C" }),
        timeout: 20000,
        maxBuffer: 16384,
      });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new Error("Owned product CLI command failed");
    }
  }
  private async intent(name: string, source: "cli" | "api") {
    ensure(
      /^[a-z0-9][a-z0-9-]{0,39}$/.test(name) &&
        !this.pairingIntents.has(name) &&
        !this.profiles.has(name),
      "Refusing an unknown or duplicate local pairing intent",
    );
    const intent: PairingIntent = { name, source, server: this.stack.config.app };
    this.pairingIntents.set(name, intent);
    await this.saveCleanupIdentity();
    return intent;
  }
  private async readOwnedState(name: string) {
    ensure(this.pairingIntents.has(name), "Refusing an untracked local state file");
    const directory = join(this.root, "state"),
      file = join(directory, `${name}.json`);
    const dir = await lstat(directory),
      before = await lstat(file);
    ensure(
      dir.isDirectory() &&
        !dir.isSymbolicLink() &&
        dir.uid === process.getuid?.() &&
        (dir.mode & 0o777) === 0o700 &&
        (await realpath(directory)) === directory,
      "Refusing an unsafe fixture state directory",
    );
    ensure(
      before.isFile() &&
        !before.isSymbolicLink() &&
        before.uid === process.getuid?.() &&
        (before.mode & 0o777) === 0o600 &&
        before.nlink === 1 &&
        before.size <= 65536,
      "Refusing an unsafe fixture state file",
    );
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      ensure(
        current.ino === before.ino && current.dev === before.dev,
        "Fixture state file changed while opening",
      );
      const state = JSON.parse(await handle.readFile("utf8")) as Record<string, unknown>;
      ensure(
        state &&
          typeof state === "object" &&
          state.version === 1 &&
          state.server === this.pairingIntents.get(name)?.server,
        "Refusing another server's private state",
      );
      return state;
    } finally {
      await handle.close();
    }
  }
  async state(name: string): Promise<Record<string, unknown>> {
    ensure(this.profiles.has(name), "Unknown device fixture profile");
    return this.readOwnedState(name);
  }
  private async captureHashes(intent: PairingIntent) {
    let seed = this.pairingSeeds.get(intent.name);
    if (!seed && intent.source === "cli") {
      let state: Record<string, unknown>;
      try {
        state = await this.readOwnedState(intent.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      ensure(
        isHash(state.code) && isHash(state.proof) && state.code !== state.proof,
        "Private pairing journal must retain distinct original code and proof",
      );
      seed = { code: state.code, proof: state.proof };
      this.pairingSeeds.set(intent.name, seed);
    }
    if (seed) {
      const codeHash = digest(seed.code),
        proofHash = digest(seed.proof);
      ensure(
        (!intent.codeHash || intent.codeHash === codeHash) &&
          (!intent.proofHash || intent.proofHash === proofHash),
        "Fixture pairing intent changed its original hashes",
      );
      intent.codeHash = codeHash;
      intent.proofHash = proofHash;
      this.hashes.add(codeHash);
      this.hashes.add(proofHash);
      await this.saveCleanupIdentity();
    }
  }
  private async recoverIntent(intent: PairingIntent) {
    await assertOwnedStack(this.stack.config);
    await this.captureHashes(intent);
    if (!intent.codeHash || !intent.proofHash) return;
    const found = await this.stack.db.query(
      "select id,code_hash,proof_hash from device_binding_private.pairings where code_hash=$1 and proof_hash=$2",
      [intent.codeHash, intent.proofHash],
    );
    ensure(
      found.rowCount === 0 || found.rowCount === 1,
      "Refusing ambiguous anonymous pairing identity",
    );
    if (found.rowCount === 0) return;
    const row = found.rows[0];
    ensure(
      isId(row.id) && row.code_hash === intent.codeHash && row.proof_hash === intent.proofHash,
      "Recovered pairing must match both original intent hashes",
    );
    const seed = this.pairingSeeds.get(intent.name);
    ensure(seed, "Pairing recovery requires its own original private journal");
    const existing = this.profiles.get(intent.name);
    ensure(
      !existing || existing.pairingId === row.id,
      "Refusing to replace a tracked pairing identity",
    );
    this.profiles.set(
      intent.name,
      existing ?? {
        name: intent.name,
        code: seed.code,
        proof: seed.proof,
        codeHash: intent.codeHash,
        proofHash: intent.proofHash,
        pairingId: row.id,
      },
    );
    intent.pairingId = row.id;
    await this.saveCleanupIdentity();
  }
  private async withBeginFault<T>(
    intent: PairingIntent,
    fault: PairFault | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (fault !== "response-lost" && fault !== "cli-response-invalid") return run();
    let forwarded = false;
    const server = createServer(async (request, response) => {
      try {
        ensure(
          !forwarded && request.method === "POST" && request.url === "/api/connector/begin",
          "Fault relay only forwards its own single begin request",
        );
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          ensure(size <= 16384, "Fault relay body exceeds limit");
          chunks.push(chunk);
        }
        const body = validateBody("begin", JSON.parse(Buffer.concat(chunks).toString("utf8")));
        await this.captureHashes(intent);
        ensure(
          body.codeHash === intent.codeHash && body.proofHash === intent.proofHash,
          "Fault relay cannot forward another pairing intent",
        );
        forwarded = true;
        const actual = await this.request("begin", body);
        ensure(
          actual.status === 200 && actual.data.ok === true,
          "Actual product begin must succeed before injecting response loss",
        );
        const data = projectResponse("begin", actual.data.data, true);
        intent.pairingId = String(data.pairingId);
        await this.recoverIntent(intent);
        if (fault === "response-lost") {
          request.socket.destroy();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, data: { ...data, protocol: 2 } }));
      } catch {
        response.writeHead(500).end('{"ok":false,"error":{"code":"UNAVAILABLE"}}');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    intent.server = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      return await run();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
  private async withPairingRecovery<T>(intent: PairingIntent, run: () => Promise<T>): Promise<T> {
    const failures: Error[] = [];
    let result: T | undefined;
    try {
      result = await run();
    } catch (error) {
      addFailure(failures, error, "assertion");
    }
    try {
      await this.recoverIntent(intent);
    } catch (error) {
      addFailure(failures, error, "pairing-recovery");
    }
    if (failures.length) throw combinedFailure(failures);
    return result as T;
  }
  async pair(name: string, options: { fault?: PairFault } = {}) {
    const intent = await this.intent(name, "cli");
    return this.withPairingRecovery(intent, async () => {
      const result = await this.withBeginFault(intent, options.fault, () =>
        this.cli(name, "pair", ["--device-alias", `기기 ${name}`]),
      );
      await this.recoverIntent(intent);
      if (options.fault === "stdout-lost")
        throw new Error("Owned CLI output intentionally withheld after actual begin");
      const state = await this.state(name);
      if (options.fault === "state-validation")
        throw new Error("Owned private state validation intentionally failed after actual begin");
      const profile = this.profiles.get(name);
      ensure(
        Object.keys(result).sort().join(",") === "code,expiresAt,state",
        "Pair CLI output must contain only the one-time code and public state",
      );
      ensure(
        profile &&
          isHash(result.code) &&
          result.code === profile.code &&
          state.proof === profile.proof &&
          state.pairingId === profile.pairingId,
        "CLI output and private state must match the pre-recorded pairing intent",
      );
      await this.verifyPairing(profile);
      return profile;
    });
  }
  async apiPair(name: string, options: { fault?: PairFault } = {}) {
    await assertOwnedStack(this.stack.config);
    const intent = await this.intent(name, "api");
    const code = secret(),
      proof = secret();
    this.pairingSeeds.set(name, { code, proof });
    await this.captureHashes(intent);
    return this.withPairingRecovery(intent, async () => {
      const response = await this.withBeginFault(intent, options.fault, () =>
        this.requestAt(intent.server, "begin", {
          codeHash: intent.codeHash,
          proofHash: intent.proofHash,
          deviceAlias: "합성 기기",
          protocol: 1,
        }),
      );
      if (response.status !== 200) return { response };
      const data = projectResponse("begin", response.data.data, true);
      await this.recoverIntent(intent);
      const profile = this.profiles.get(name);
      ensure(
        profile && profile.pairingId === data.pairingId,
        "API pairing result must match both pre-recorded hashes",
      );
      await this.verifyPairing(profile);
      return { response, profile };
    });
  }
  async verifyPairing(profile: DeviceProfile) {
    await assertOwnedStack(this.stack.config);
    const row = await this.stack.db.query(
      "select id from device_binding_private.pairings where id=$1 and code_hash=$2 and proof_hash=$3",
      [profile.pairingId, profile.codeHash, profile.proofHash],
    );
    ensure(row.rowCount === 1, "Anonymous pairing must match exact fixture hashes");
  }
  async human(person: FixturePerson, action: string, body: unknown) {
    await this.saveCleanupIdentity();
    const response = await person.web.post(`/api/connections/${action}`, body);
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      data: JSON.parse(text),
      text,
    } as DeviceResponse;
  }
  async request(action: string, body: unknown, key?: string, headers: Record<string, string> = {}) {
    await this.saveCleanupIdentity();
    return this.requestAt(this.stack.config.app, action, body, key, headers);
  }
  private async requestAt(
    origin: string,
    action: string,
    body: unknown,
    key?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(`${origin}/api/connector/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      redirect: "manual",
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      data: JSON.parse(text),
      text,
    } as DeviceResponse;
  }
  async approve(
    person: FixturePerson,
    p: DeviceProfile,
    scope: { organizationId: string; roomId: string },
  ) {
    ensure(
      this.stack.users.has(person.id) && this.stack.organizations.has(scope.organizationId),
      "Refusing unowned approval scope",
    );
    const r = await this.human(person, "approve", { code: p.code, ...scope, confirmed: true });
    ensure(r.status === 200, "Owned pairing approval failed");
    p.organizationId = scope.organizationId;
    p.roomId = scope.roomId;
    p.ownerUserId = person.id;
    await this.saveCleanupIdentity();
  }
  async exchange(p: DeviceProfile) {
    ensure(p.roomId, "Approved fixture scope is required");
    await this.cli(p.name, "status");
    await this.cli(p.name, "exchange", ["--confirm-scope", p.roomId]);
    await this.refresh(p);
    return p;
  }
  async refresh(p: DeviceProfile) {
    const state = await this.state(p.name);
    p.credential = String(state.credential);
    p.deviceId = String(state.deviceId);
    this.hashes.add(digest(p.credential));
    const mappings = state.mappings as Record<string, unknown>[];
    if (mappings[0]) {
      p.agentId = String(mappings[0].agentId);
      p.workspaceId = String(mappings[0].workspaceId);
    }
    await this.saveCleanupIdentity();
  }
  async connected(
    person: FixturePerson,
    scope: { organizationId: string; roomId: string },
    name: string,
  ) {
    const p = await this.pair(name);
    await this.approve(person, p, scope);
    return this.exchange(p);
  }
  async register(p: DeviceProfile) {
    await this.cli(p.name, "register", [
      "--root",
      join(this.root, "repository"),
      "--native-session",
      `private-native-${p.name}`,
      "--repository-alias",
      "공개 저장소",
      "--session-alias",
      "공개 세션",
      "--confirm-public",
      "yes",
    ]);
    await this.refresh(p);
    return p;
  }
  async cleanupPairing(name: string) {
    await assertOwnedStack(this.stack.config);
    const intent = this.pairingIntents.get(name);
    ensure(intent, "Refusing cleanup without a pre-recorded pairing intent");
    await this.recoverIntent(intent);
    const p = this.profiles.get(name);
    if (p) {
      const pair = await this.stack.db.query(
        "select device_id from device_binding_private.pairings where id=$1 and code_hash=$2 and proof_hash=$3",
        [p.pairingId, p.codeHash, p.proofHash],
      );
      if (pair.rowCount === 0) {
        ensure(
          p.ownerUserId && p.organizationId && this.stack.organizations.has(p.organizationId),
          "Refusing an unexplained missing fixture pairing",
        );
        if (p.deviceId) {
          const remains = await this.stack.db.query(
            "select id from device_binding_private.devices where id=$1",
            [p.deviceId],
          );
          ensure(remains.rowCount === 0, "Refusing a missing pairing with a live device");
        }
        this.profiles.delete(name);
      } else {
        ensure(pair.rowCount === 1, "Refusing changed fixture pairing identity");
        const deviceId = pair.rows[0].device_id as string | null;
        if (deviceId) {
          const owned = await this.stack.db.query(
            "select owner_user_id,organization_id,room_id from device_binding_private.devices where id=$1",
            [deviceId],
          );
          ensure(
            owned.rowCount === 1 &&
              this.stack.users.has(owned.rows[0].owner_user_id) &&
              this.stack.organizations.has(owned.rows[0].organization_id),
            "Refusing another user's device cleanup",
          );
          p.deviceId = deviceId;
          p.ownerUserId = owned.rows[0].owner_user_id;
          p.organizationId = owned.rows[0].organization_id;
          p.roomId = owned.rows[0].room_id;
          const keys = await this.stack.db.query(
            "select hash from device_binding_private.credentials where device_id=$1",
            [deviceId],
          );
          for (const row of keys.rows) this.hashes.add(row.hash);
        }
        await this.saveCleanupIdentity();
        await this.stack.db.query("begin");
        try {
          await this.stack.db.query("select device_binding_private.guard()");
          await this.stack.db.query(
            "delete from device_binding_private.pairings where id=$1 and code_hash=$2 and proof_hash=$3",
            [p.pairingId, p.codeHash, p.proofHash],
          );
          if (deviceId)
            await this.stack.db.query(
              "delete from device_binding_private.devices where id=$1 and owner_user_id=any($2::uuid[])",
              [deviceId, [...this.stack.users]],
            );
          await this.stack.db.query("commit");
        } catch (error) {
          const failures = [safeFailure(error, "device-cleanup")];
          try {
            await this.stack.db.query("rollback");
          } catch (rollback) {
            failures.push(safeFailure(rollback, "device-cleanup"));
          }
          throw combinedFailure(failures);
        }
        this.profiles.delete(name);
      }
    }
    for (const h of [intent.codeHash, intent.proofHash])
      if (h) {
        await this.stack.db.query(
          "delete from device_binding_private.secret_hashes where hash=$1 and not exists(select 1 from device_binding_private.pairings where code_hash=$1 or proof_hash=$1) and not exists(select 1 from device_binding_private.credentials where hash=$1)",
          [h],
        );
        this.hashes.delete(h);
      }
    this.pairingIntents.delete(name);
    this.pairingSeeds.delete(name);
    await this.saveCleanupIdentity();
  }
  async close() {
    const failures: Error[] = [];
    try {
      await assertOwnedStack(this.stack.config);
      await this.saveCleanupIdentity();
      for (const name of [...this.pairingIntents.keys()]) await this.cleanupPairing(name);
      for (const h of this.hashes)
        await this.stack.db.query(
          "delete from device_binding_private.secret_hashes where hash=$1 and not exists(select 1 from device_binding_private.pairings where code_hash=$1 or proof_hash=$1) and not exists(select 1 from device_binding_private.credentials where hash=$1)",
          [h],
        );
    } catch (error) {
      addFailure(failures, error, "device-cleanup");
    }
    try {
      await this.stack.close();
    } catch (error) {
      addFailure(failures, error, "stack-cleanup");
    }
    if (!failures.length) {
      try {
        await rm(this.root, { recursive: true, force: true });
      } catch (error) {
        failures.push(safeFailure(error, "private-root-cleanup"));
      }
    }
    if (failures.length) throw combinedFailure(failures);
  }
}
export async function deviceCase(label: string, run: (fixture: DeviceFixture) => Promise<void>) {
  const f = await DeviceFixture.open(label),
    failures: Error[] = [];
  try {
    await run(f);
  } catch (error) {
    addFailure(failures, error, "assertion");
  }
  try {
    await f.close();
  } catch (error) {
    addFailure(failures, error, "device-cleanup");
  }
  if (failures.length) throw combinedFailure(failures);
}
export async function runDeviceBrowserParent() {
  const fixture = await DeviceFixture.open("browser");
  const token = secret();
  const people = new Map<string, FixturePerson>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const supplied = req.headers.authorization?.slice(7) ?? "";
    if (
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      let raw = "";
      for await (const part of req) {
        raw += part.toString();
        ensure(Buffer.byteLength(raw) <= 4096, "Broker request exceeds limit");
      }
      const input = JSON.parse(raw);
      let data: unknown;
      if (req.url === "/person") {
        const p = await fixture.stack.person("browser", false);
        people.set(p.id, p);
        data = { id: p.id, email: p.email };
      } else if (req.url === "/code") {
        const p = people.get(input.id);
        ensure(p, "Unknown fixture person");
        data = { code: await fixture.stack.code(p.email) };
      } else if (req.url === "/track") {
        await fixture.stack.trackOrganization(input.organizationId);
        data = {};
      } else if (req.url === "/pair") {
        ensure(people.has(input.id) && typeof input.name === "string", "Unknown fixture person");
        const p = await fixture.pair(input.name);
        data = { code: p.code, name: p.name };
      } else if (req.url === "/register") {
        const p = fixture.profiles.get(input.name);
        const person = people.get(input.id);
        ensure(p && person, "Unknown fixture connection");
        await assertOwnedStack(fixture.stack.config);
        const row = await fixture.stack.db.query(
          "select owner_user_id,organization_id,room_id from device_binding_private.pairings where id=$1 and proof_hash=$2",
          [p.pairingId, p.proofHash],
        );
        ensure(
          row.rowCount === 1 &&
            row.rows[0].owner_user_id === person.id &&
            fixture.stack.organizations.has(row.rows[0].organization_id),
          "Fixture approval owner differs",
        );
        p.roomId = row.rows[0].room_id;
        p.organizationId = row.rows[0].organization_id;
        p.ownerUserId = person.id;
        await fixture.exchange(p);
        await fixture.register(p);
        await fixture.cli(p.name, "heartbeat");
        data = { state: "registered", verification: "unverified" };
      } else if (req.url === "/heartbeat") {
        const p = fixture.profiles.get(input.name);
        ensure(
          p && people.has(input.id) && p.ownerUserId === input.id,
          "Unknown fixture connection",
        );
        const r = await fixture.request("heartbeat", {}, p.credential);
        data = { status: r.status };
      } else throw new Error("Unknown device broker action");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500).end('{"error":"Owned device broker action failed"}');
    }
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const env = {
      ...productEnvironment(),
      LOCAL_DEVICE_FIXTURE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      LOCAL_DEVICE_FIXTURE_TOKEN: token,
      ...authBrowserChildEnvironment,
    };
    const child = spawn(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.device.config.ts"],
      { env, stdio: "inherit" },
    );
    process.exitCode = await new Promise<number>((r) => {
      child.on("exit", (c) => r(c ?? 1));
      child.on("error", () => r(1));
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await fixture.close();
  }
}
