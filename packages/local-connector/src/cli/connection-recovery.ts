import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Connector } from "../cli.ts";
import { ConnectionError, isId, isHash } from "../contracts.ts";
import { RuntimeError, stableJson, type OwnedContext } from "../runtime-contracts.ts";
import { RuntimeStore } from "../runtime-store.ts";
import { ClaudeCatalogStore } from "../claude/catalog-store.ts";
import { StateStore, type ConnectorState } from "../state-store.ts";
import { SettingsStore, type SettingsState } from "../settings/store.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";
import {
  withConfiguredProfileProtection,
  withLocalProfileProtection,
} from "./remove-local-profile.ts";
import { withSettingsDeviceLock } from "./settings-lock.ts";
import { parseCliOptions, parseRecoveryChain } from "./parse-options.ts";
import type { ConnectInput, ConnectInteraction } from "./connect-command.ts";
import { serviceOrigin } from "../central-client.ts";

type Runner = (profile: StateStore, agentId: string) => WorkflowRunner;

export class MissingRecoveryRecordError extends ConnectionError {
  constructor() {
    super("CONFLICT");
  }
}
type RecoverySelection = {
  target: StateStore;
  store: StateStore;
  previous?: StateStore;
  gaps: StateStore[];
  mode: "normal" | "recovery";
  input: ConnectInput;
  origin: string;
};

function matchingScope(owner: ConnectorState, origin: string, input: ConnectInput) {
  if (
    owner.server !== origin ||
    (owner.scope &&
      (owner.scope.organizationId !== input.organizationId || owner.scope.roomId !== input.roomId))
  )
    throw new ConnectionError("FORBIDDEN");
  if ((owner.credential || owner.deviceId) && !owner.scope) throw new ConnectionError("FORBIDDEN");
}

/** A preliminary choice only: callers must revalidate it while holding its device locks. */
export async function selectConnectionProfile(
  target: StateStore,
  input: ConnectInput,
  origin: string,
): Promise<RecoverySelection> {
  if (!input.recoveryChain)
    return {
      target,
      store: target,
      gaps: [],
      mode: input.previousProfile ? "recovery" : "normal",
      input,
      origin,
    };
  const lineage = parseRecoveryChain(
    input.recoveryChain,
    target.profile,
    input.previousProfile!,
    input.recoveryId!,
  );
  const names = [lineage.baseProfile, ...lineage.chain.map((g) => g.profile)];
  const current = await target.read();
  if (current) matchingScope(current, origin, input);
  let found: StateStore | undefined,
    owner: ConnectorState | undefined,
    index = -1;
  for (let n = names.length - 2; n >= 0; n--) {
    const candidate = new StateStore(target.dir, names[n]);
    const record = await candidate.read();
    if (record) {
      matchingScope(record, origin, input);
      found = candidate;
      owner = record;
      index = n;
      break;
    }
  }
  if (!found) {
    if (current) throw new MissingRecoveryRecordError();
    return {
      target,
      store: new StateStore(target.dir, lineage.baseProfile),
      gaps: names.slice(1).map((name) => new StateStore(target.dir, name)),
      mode: "normal",
      input,
      origin,
    };
  }
  const gaps = names.slice(index + 1, -1).map((name) => new StateStore(target.dir, name));
  if (current)
    return { target, store: target, previous: found, gaps, mode: "recovery", input, origin };
  if (
    owner!.status === "pairing" ||
    (owner!.status === "connected" &&
      isHash(owner!.credential) &&
      isId(owner!.deviceId) &&
      Date.parse(owner!.credentialExpiresAt ?? "") > Date.now())
  )
    return { target, store: found, gaps: [...gaps, target], mode: "normal", input, origin };
  expired(owner, origin, input);
  return { target, store: target, previous: found, gaps, mode: "recovery", input, origin };
}

async function privateInfo(path: string) {
  try {
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== (stat.isDirectory() ? 0o700 : 0o600) ||
      (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** No profile file does not prove that a generation never executed. */
async function assertUnused(profile: StateStore, input: ConnectInput, origin: string) {
  if (await profile.read()) throw new RuntimeError("AUTHORITY_LOST");
  for (const path of [
    join(profile.dir, `${profile.profile}.lock`),
    new ClaudeCatalogStore(profile).directory,
    join(profile.dir, `${profile.profile}.claude-catalog.identity.json`),
  ])
    if (await privateInfo(path)) throw new RuntimeError("CONTEXT_UNCONFIRMED");
  const settings = new SettingsStore(profile);
  if (await privateInfo(settings.dir)) {
    for (const name of await readdir(settings.dir)) {
      const path = join(settings.dir, name),
        info = await privateInfo(path);
      if (name === "device.lock" && info?.isFile()) continue;
      if (name === "generations" && info?.isDirectory() && !(await readdir(path)).length) continue;
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    }
  }
  const runtime = join(profile.dir, "runtime", profile.profile);
  if (await privateInfo(join(profile.dir, "runtime"))) {
    if (await privateInfo(runtime)) {
      await RuntimeStore.agents(profile.dir, profile.profile);
      if ((await readdir(runtime)).length) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    }
  }
  for (const name of await readdir(profile.dir)) {
    if (name.startsWith(`${profile.profile}.`) || name.startsWith(`.${profile.profile}-`))
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    if (!name.startsWith(".expired-pairing-")) continue;
    const attributed =
      /^\.expired-pairing-([a-z0-9][a-z0-9-]{0,39})-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.json$/.exec(
        name,
      );
    if (
      !attributed &&
      !/^\.expired-pairing-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(
        name,
      )
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const path = join(profile.dir, name),
      info = await privateInfo(path);
    if (!info?.isFile() || info.size > 65536) throw new RuntimeError("UNSAFE_STORAGE");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await file.stat();
      if (
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.nlink !== 1 ||
        current.uid !== process.getuid?.() ||
        (current.mode & 0o777) !== 0o600 ||
        current.size > 65536
      )
        throw new RuntimeError("AUTHORITY_LOST");
      let saved: unknown;
      try {
        saved = JSON.parse((await file.readFile()).toString("utf8"));
      } catch {
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      }
      if (!saved || typeof saved !== "object" || Array.isArray(saved))
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      const record = saved as ConnectorState;
      if (
        typeof record.server !== "string" ||
        record.version !== 1 ||
        record.status !== "pairing" ||
        !Array.isArray(record.mappings) ||
        record.mappings.length ||
        record.credential ||
        record.deviceId ||
        record.pending ||
        record.registration
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      try {
        serviceOrigin(record.server);
      } catch {
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      }
      if (
        !isHash(record.code) ||
        !isHash(record.proof) ||
        !isId(record.pairingId) ||
        !Number.isFinite(Date.parse(record.pairingExpiresAt ?? ""))
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      if (attributed) {
        if (attributed[1] === profile.profile) throw new RuntimeError("CONTEXT_UNCONFIRMED");
        continue;
      }
      // Unattributed archives are irrelevant only when their origin or complete scope proves it.
      if (record.server !== origin) continue;
      if (
        record.scope &&
        isId(record.scope.organizationId) &&
        isId(record.scope.roomId) &&
        (record.scope.organizationId !== input.organizationId ||
          record.scope.roomId !== input.roomId)
      )
        continue;
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    } finally {
      await file.close();
    }
  }
}

async function withUnusedProfiles<T>(
  profiles: StateStore[],
  input: ConnectInput,
  origin: string,
  check: () => void,
  run: () => Promise<T>,
): Promise<T> {
  const visit = async (index: number): Promise<T> => {
    check();
    if (index === profiles.length) {
      for (const profile of profiles) await assertUnused(profile, input, origin);
      const result = await run();
      check();
      for (const profile of profiles) await assertUnused(profile, input, origin);
      return result;
    }
    return new SettingsStore(profiles[index]).locked(async () => {
      await assertUnused(profiles[index], input, origin);
      return visit(index + 1);
    }, check);
  };
  return visit(0);
}

async function assertSelection(selection: RecoverySelection) {
  const actual = await selectConnectionProfile(selection.target, selection.input, selection.origin);
  if (
    actual.store.profile !== selection.store.profile ||
    actual.previous?.profile !== selection.previous?.profile ||
    actual.mode !== selection.mode ||
    stableJson(actual.gaps.map((p) => p.profile)) !==
      stableJson(selection.gaps.map((p) => p.profile))
  )
    throw new RuntimeError("AUTHORITY_LOST");
}

async function pairingNamespaceEvidence(profile: StateStore) {
  const snapshot = JSON.parse(await evidence(profile));
  delete snapshot[profile.file];
  return stableJson(snapshot);
}

/** Accept only the exact newly archived pairing from this locked preparation, never an older fallback. */
async function hasPairingReplacement(
  profile: StateStore,
  original: ConnectorState,
  knownArchives: Set<string>,
  namespace: string,
) {
  if (
    original.status !== "pairing" ||
    original.pending ||
    original.registration ||
    original.credential ||
    original.deviceId ||
    original.mappings.length ||
    !Number.isFinite(Date.parse(original.pairingExpiresAt ?? "")) ||
    Date.parse(original.pairingExpiresAt!) > Date.now()
  )
    return false;
  const prefix = `.expired-pairing-${profile.profile}-`;
  const candidates = (await readdir(profile.dir)).filter(
    (name) => name.startsWith(prefix) && !knownArchives.has(name),
  );
  if (
    candidates.length !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/.test(
      candidates[0].slice(prefix.length),
    )
  )
    return false;
  const path = join(profile.dir, candidates[0]),
    before = await privateInfo(path);
  if (!before?.isFile() || before.size > 65536) throw new RuntimeError("UNSAFE_STORAGE");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 65536
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    const bytes = await file.readFile();
    const current = await privateInfo(path);
    if (bytes.length > 65536 || current?.dev !== stat.dev || current.ino !== stat.ino)
      throw new RuntimeError("AUTHORITY_LOST");
    let record: unknown;
    try {
      record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new RuntimeError("UNSAFE_STORAGE");
    }
    return (
      stableJson(record) === stableJson(original) &&
      (await pairingNamespaceEvidence(profile)) === namespace
    );
  } finally {
    await file.close();
  }
}

/** Normal reuse/first approval retains all unused-generation locks throughout preparation. */
export async function prepareSelectedConnection<T>(
  selection: RecoverySelection,
  check: () => void,
  run: (verify: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (selection.mode !== "normal") throw new ConnectionError("INVALID_BODY");
  return withSettingsDeviceLock(selection.store, "connect", async () => {
    check();
    await assertSelection(selection);
    const original = await selection.store.read();
    // The existing pairing restart probe creates this empty private runtime scaffold.
    // Capture it before the transition so its legitimate creation is not an authority change.
    if (
      original?.status === "pairing" &&
      (await RuntimeStore.agents(selection.store.dir, selection.store.profile)).length
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    const originalPairing =
      original?.status === "pairing"
        ? {
            record: original,
            namespace: await pairingNamespaceEvidence(selection.store),
            archives: new Set(await readdir(selection.store.dir)),
          }
        : undefined;
    if (!original) await assertUnused(selection.store, selection.input, selection.origin);
    const verify = async () => {
      check();
      for (const profile of selection.gaps)
        await assertUnused(profile, selection.input, selection.origin);
      if (
        originalPairing &&
        !(await selection.store.read()) &&
        (await hasPairingReplacement(
          selection.store,
          originalPairing.record,
          originalPairing.archives,
          originalPairing.namespace,
        ))
      )
        return;
      await assertSelection(selection);
    };
    return withUnusedProfiles(
      selection.gaps,
      selection.input,
      selection.origin,
      check,
      async () => {
        await verify();
        return run(verify);
      },
    );
  });
}

function expired(owner: ConnectorState | undefined, origin: string, input: ConnectInput) {
  if (
    !owner ||
    owner.server !== origin ||
    !isId(owner.deviceId) ||
    !isHash(owner.credential) ||
    owner.scope?.organizationId !== input.organizationId ||
    owner.scope.roomId !== input.roomId
  )
    throw new ConnectionError("FORBIDDEN");
  if (owner.pending || owner.registration) throw new RuntimeError("RUNTIME_BUSY");
  if (!["connected", "disconnected"].includes(owner.status)) throw new ConnectionError("CONFLICT");
  const expiry = Date.parse(owner.credentialExpiresAt ?? "");
  if (!Number.isFinite(expiry) || expiry > Date.now()) throw new ConnectionError("CONFLICT");
  return owner;
}

async function legacyEvidence(profile: StateStore, owner: ConnectorState) {
  const agents = (await RuntimeStore.agents(profile.dir, profile.profile)).sort();
  const mapped = owner.mappings.map((m) => m.agentId).sort();
  if (new Set(mapped).size !== mapped.length || stableJson(agents) !== stableJson(mapped))
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  for (const mapping of owner.mappings) {
    const record = await new RuntimeStore(profile.dir, profile.profile, mapping.agentId!).read();
    if (
      !record?.context ||
      !record.settings ||
      record.context.ownership !== "CONNECTOR_CREATED" ||
      record.context.epoch !== mapping.bindingEpoch ||
      record.context.root.path !== mapping.root ||
      record.context.threadId !== mapping.nativeSessionId ||
      (mapping.formatVersion === 2 &&
        (record.version !== 2 ||
          record.context.generation !== mapping.generation ||
          record.settings.provider !== mapping.runtime ||
          mapping.materialization !== (record.context.materialization?.state ?? "MATERIALIZED")))
    )
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  const generations = join(new SettingsStore(profile).dir, "generations");
  try {
    if ((await readdir(generations)).length) throw new RuntimeError("RUNTIME_BUSY");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function configuredSetupEvidence(
  profile: StateStore,
  settings: SettingsStore,
  configured: SettingsState,
) {
  const journal = configured.journal;
  if (!journal) return;
  if (!journal.context) {
    if (journal.catalogContext) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    return;
  }
  const context = journal.context;
  const pointer = [
    ...configured.retained,
    ...(configured.current ? [configured.current] : []),
  ].find((candidate) => candidate.generation === context.generation);
  if (!pointer) throw new RuntimeError("CONTEXT_UNCONFIRMED");
  const runtime = pointer.legacy
    ? new RuntimeStore(profile.dir, profile.profile, pointer.agentId)
    : settings.generationStore(pointer.agentId, pointer.generation);
  const record = await runtime.read();
  const actual = record?.context;
  if (
    !actual ||
    context.threadId !== actual.threadId ||
    context.generation !== actual.generation ||
    context.ownership !== actual.ownership ||
    context.epoch !== actual.epoch ||
    context.provider !== actual.provider ||
    stableJson(context.root) !== stableJson(actual.root) ||
    stableJson(journal.settings) !== stableJson(record.settings) ||
    !matchesMaterialization(context, actual)
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  const catalog = journal.catalogContext;
  if (pointer.provider !== "claude") {
    if (catalog) throw new RuntimeError("CONTEXT_UNCONFIRMED");
    return;
  }
  // SettingsStore validates the APPLIED receipt. choose() closes the catalog adapter
  // before LOCAL_CONFIRMATION; the catalog reservation is never the runtime session.
  if (
    journal.phase !== "APPLIED" ||
    journal.receipt?.state !== "APPLIED" ||
    !catalog ||
    catalog.generation !== journal.generation ||
    catalog.generation !== actual.generation ||
    catalog.ownership !== actual.ownership ||
    catalog.provider !== "claude" ||
    actual.provider !== "claude" ||
    stableJson(catalog.root) !== stableJson(journal.root) ||
    stableJson(catalog.root) !== stableJson(actual.root) ||
    catalog.epoch !== context.epoch ||
    catalog.level !== "L1" ||
    catalog.ownedTurns.length !== 0 ||
    catalog.threadId === actual.threadId ||
    catalog.materialization?.state !== "RESERVED" ||
    catalog.materialization.initHash !== null ||
    !actual.materialization ||
    catalog.materialization.version !== actual.materialization.version ||
    catalog.materialization.policyFingerprint !== actual.materialization.policyFingerprint
  )
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
}

function matchesMaterialization(saved: OwnedContext, actual: OwnedContext) {
  const before = saved.materialization,
    current = actual.materialization;
  if (!before || !current) return before === current;
  return (
    before.version === current.version &&
    before.policyFingerprint === current.policyFingerprint &&
    (before.state === "RESERVED"
      ? before.initHash === null
      : current.state === "MATERIALIZED" && before.initHash === current.initHash)
  );
}

/** Capture identities as well as bytes, so an identical replacement is not trusted evidence. */
async function evidence(profile: StateStore) {
  const result: Record<string, unknown> = {};
  const settingsDir = new SettingsStore(profile).dir;
  let files = 0;
  const visit = async (path: string, depth = 0): Promise<void> => {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      result[path] = null;
      return;
    }
    if (depth > 10 || ++files > 8192 || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
      throw new RuntimeError("UNSAFE_STORAGE");
    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o700) throw new RuntimeError("UNSAFE_STORAGE");
      const names = (await readdir(path)).sort();
      if (
        (path === settingsDir &&
          names.some((name) => !["settings.json", "device.lock", "generations"].includes(name))) ||
        (dirname(path) === join(settingsDir, "generations") &&
          stableJson(names) !== stableJson(["runtime"])) ||
        (path.endsWith("/runtime") && stableJson(names) !== stableJson([profile.profile]))
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      if (dirname(path).endsWith(`/runtime/${profile.profile}/archives`)) {
        const agent = path.slice(path.lastIndexOf("/") + 1);
        if (!isId(agent)) throw new RuntimeError("CONTEXT_UNCONFIRMED");
        const runtimeDir = dirname(dirname(path));
        const record = await new RuntimeStore(
          dirname(dirname(runtimeDir)),
          profile.profile,
          agent,
        ).read();
        if (
          !record ||
          stableJson(names) !==
            stableJson((record.archives ?? []).map((ref) => `${ref.hash}.json`).sort())
        )
          throw new RuntimeError("CONTEXT_UNCONFIRMED");
      }
      result[path] = [stat.dev, stat.ino, stat.mode, names.filter((n) => !n.endsWith(".lock"))];
      for (const name of names) {
        if (name.endsWith(".lock")) {
          const knownDevice = path === settingsDir && name === "device.lock";
          const agent = name.slice(0, -5);
          const knownRuntime =
            path.endsWith(`/runtime/${profile.profile}`) &&
            isId(agent) &&
            names.includes(`${agent}.json`);
          if (!knownDevice && !knownRuntime) throw new RuntimeError("RUNTIME_BUSY");
          const lock = await lstat(join(path, name));
          if (
            !lock.isFile() ||
            lock.isSymbolicLink() ||
            lock.uid !== process.getuid?.() ||
            (lock.mode & 0o777) !== 0o600 ||
            lock.nlink !== 1
          )
            throw new RuntimeError("UNSAFE_STORAGE");
          continue;
        }
        if (name.startsWith(".") || name.endsWith(".recovery"))
          throw new RuntimeError("RUNTIME_BUSY");
        // Runtime directories admit only named journals and their owned archives.
        if (
          path.endsWith(`/runtime/${profile.profile}`) &&
          name !== "archives" &&
          !(name.endsWith(".json") && isId(name.slice(0, -5)))
        )
          throw new RuntimeError("CONTEXT_UNCONFIRMED");
        await visit(join(path, name), depth + 1);
      }
      return;
    }
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size > 128 * 1024 * 1024
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat(),
        bytes = await file.readFile(),
        after = await file.stat();
      const identity = (s: typeof stat) => [
        s.dev,
        s.ino,
        s.size,
        s.mtimeMs,
        s.ctimeMs,
        s.uid,
        s.mode,
        s.nlink,
      ];
      if (
        stableJson(identity(stat)) !== stableJson(identity(before)) ||
        stableJson(identity(before)) !== stableJson(identity(after))
      )
        throw new RuntimeError("UNSAFE_STORAGE");
      result[path] = [...identity(after), createHash("sha256").update(bytes).digest("hex")];
    } finally {
      await file.close();
    }
  };
  await visit(profile.file);
  await visit(new SettingsStore(profile).dir);
  await visit(join(profile.dir, "runtime", profile.profile));
  const catalog = new ClaudeCatalogStore(profile);
  catalog.assertStartup();
  await visit(catalog.directory);
  await visit(join(profile.dir, `${profile.profile}.claude-catalog.identity.json`));
  return stableJson(result);
}

/** The old device stays locked across human approval; its runtime/session locks do not. */
export async function prepareRecovery(
  connector: Connector,
  input: ConnectInput,
  interaction: ConnectInteraction,
  runner: Runner,
  prepare: (verify: () => Promise<void>) => Promise<void>,
) {
  parseCliOptions(
    [
      "--profile",
      connector.store.profile,
      "--previous-profile",
      input.previousProfile!,
      "--recovery-id",
      input.recoveryId!,
      ...(input.recoveryChain ? ["--recovery-chain", input.recoveryChain] : []),
    ],
    "connect",
  );
  const selection = await selectConnectionProfile(connector.store, input, connector.client.origin);
  if (selection.mode !== "recovery") throw new RuntimeError("AUTHORITY_LOST");
  const previous =
    selection.previous ?? new StateStore(connector.store.dir, input.previousProfile!);
  const settings = new SettingsStore(previous);
  const check = () => {
    if (interaction.signal.aborted) throw new ConnectionError("CONFLICT");
  };
  return settings.locked(async () => {
    return withUnusedProfiles(selection.gaps, input, connector.client.origin, check, async () => {
      await assertSelection(selection);
      check();
      const record = await previous.read();
      if (!record) throw new MissingRecoveryRecordError();
      const owner = expired(record, connector.client.origin, input);
      const inspect = async () => {
        check();
        expired(await previous.read(), connector.client.origin, input);
        const configured = await settings.read();
        if (configured) {
          return withConfiguredProfileProtection(
            previous,
            settings,
            async (_owner, metadata) => {
              await configuredSetupEvidence(previous, settings, configured);
              return { snapshot: await evidence(previous), ...metadata };
            },
            "expired-fresh-approval",
          );
        }
        await legacyEvidence(previous, owner);
        return withLocalProfileProtection(
          previous,
          (agent) => runner(previous, agent),
          async () => ({ snapshot: await evidence(previous), unresolvedCount: 0 }),
        );
      };
      const { snapshot, unresolvedCount } = await inspect();
      check();
      const next = await connector.store.read();
      if (next?.credential) {
        if (
          !isId(next.deviceId) ||
          next.deviceId === owner.deviceId ||
          next.server !== owner.server ||
          next.scope?.organizationId !== owner.scope!.organizationId ||
          next.scope.roomId !== owner.scope!.roomId
        )
          throw new ConnectionError("FORBIDDEN");
      }
      // Locks exclude a live connector owner; they do not reconstruct a vanished terminal's proof.
      // A retry with fresh credentials must acknowledge preserved UNKNOWN answers again.
      if (unresolvedCount > 0) {
        interaction.write(
          `이전 답변 ${unresolvedCount}건은 결과 확인 불가로 보존합니다. 이전 질문을 자동 재실행하지 않습니다. 원래 연결 터미널을 종료하고 웹에서 이전 기기를 연결 취소한 뒤 새 대화로 연결하세요.\n`,
        );
        if (!(await interaction.confirmUnresolved?.(unresolvedCount, interaction.signal)))
          throw new ConnectionError("CONFLICT");
        check();
      }
      if (!next?.credential) {
        const safe = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 160);
        interaction.write(
          `이전 기록은 그대로 보존합니다. 새 기기의 AI와 폴더는 웹에서 다시 고르세요.\n` +
            `이전 연결 ID: ${owner.deviceId}\n기기: ${safe(owner.scope!.deviceAlias)}\n` +
            `방: ${safe(owner.scope!.roomTitle)} (${owner.scope!.roomId})\n` +
            `웹의 내 AI 연결 → 내 연결에서 같은 ID인 본인 기기만 연결 취소하세요. 기기 제거는 필요 없습니다.\n`,
        );
        if (!(await interaction.confirmPreviousRevoked?.(interaction.signal)))
          throw new ConnectionError("CONFLICT");
      }
      check();
      const rechecked = await inspect();
      if (rechecked.snapshot !== snapshot || rechecked.unresolvedCount !== unresolvedCount)
        throw new RuntimeError("AUTHORITY_LOST");
      // All old runtime/session/profile protections have returned before acquiring the new device.
      await withSettingsDeviceLock(connector.store, "connect", async () => {
        check();
        const current = await connector.store.read();
        if (
          current?.deviceId !== next?.deviceId ||
          current?.server !== next?.server ||
          current?.scope?.organizationId !== next?.scope?.organizationId ||
          current?.scope?.roomId !== next?.scope?.roomId
        )
          throw new ConnectionError("FORBIDDEN");
        if ((await evidence(previous)) !== snapshot) throw new RuntimeError("AUTHORITY_LOST");
        expired(await previous.read(), connector.client.origin, input);
        const verify = async () => {
          check();
          await assertSelection(selection);
          for (const profile of selection.gaps)
            await assertUnused(profile, input, connector.client.origin);
          expired(await previous.read(), connector.client.origin, input);
          if ((await evidence(previous)) !== snapshot) throw new RuntimeError("AUTHORITY_LOST");
        };
        await verify();
        await prepare(verify);
        check();
        if ((await evidence(previous)) !== snapshot) throw new RuntimeError("AUTHORITY_LOST");
      });
    });
  }, check);
}
