import { constants } from "node:fs";
import { lstat, open, unlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeStore, unresolvedRuntime } from "../runtime-store.ts";
import { RuntimeError, stableJson, type RuntimeRecord } from "../runtime-contracts.ts";
import type { StateStore } from "../state-store.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";
import { SettingsStore, type GenerationPointer, type SettingsState } from "../settings/store.ts";
import type { ConnectorState, Mapping } from "../state-store.ts";
import { isFreshApprovalEligible } from "./recovery-eligibility.ts";

export async function withLocalProfileProtection<T>(
  store: StateStore,
  runner: (agentId: string) => WorkflowRunner,
  mutation: (snapshot: ConnectorState | undefined, remove: () => Promise<unknown>) => Promise<T>,
) {
  const snapshot = await store.read(),
    storedAgents = await RuntimeStore.agents(store.dir, store.profile);
  const agents = [
    ...new Set([
      ...storedAgents,
      ...(snapshot?.mappings.flatMap((mapping) => (mapping.agentId ? [mapping.agentId] : [])) ??
        []),
    ]),
  ].sort();
  const protections: { check(): void; validate(): Promise<void>; remove(): Promise<void> }[] = [];
  const check = () => {
    for (const proof of protections) proof.check();
  };
  const guard = async (index: number): Promise<T> => {
    if (index < agents.length)
      return runner(agents[index]).guardLocalRemoval(async (proof) => {
        protections.push(proof);
        try {
          return await guard(index + 1);
        } finally {
          protections.pop();
        }
      });
    return store.transaction(async () => {
      check();
      const current = await store.read();
      check();
      if (stableJson(current) !== stableJson(snapshot)) throw new RuntimeError("AUTHORITY_LOST");
      const currentAgents = await RuntimeStore.agents(store.dir, store.profile);
      check();
      if (currentAgents.some((agent) => !agents.includes(agent)))
        throw new RuntimeError("RUNTIME_BUSY");
      for (const proof of protections) {
        await proof.validate();
        check();
      }
      return mutation(snapshot, async () => {
        for (const proof of protections) {
          check();
          await proof.remove();
          check();
        }
        if (protections.length && snapshot) {
          const before = await lstat(store.file);
          check();
          const final = await store.read();
          check();
          if (stableJson(final) !== stableJson(snapshot)) throw new RuntimeError("AUTHORITY_LOST");
          const current = await lstat(store.file);
          check();
          if (
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.uid !== process.getuid?.() ||
            (current.mode & 0o777) !== 0o600 ||
            current.nlink !== 1 ||
            current.ino !== before.ino ||
            current.dev !== before.dev ||
            current.size !== before.size ||
            current.mtimeMs !== before.mtimeMs ||
            current.ctimeMs !== before.ctimeMs
          )
            throw new RuntimeError("UNSAFE_STORAGE");
          check();
          await unlink(store.file);
          check();
          const directory = await open(store.dir, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            check();
            await directory.sync();
            check();
          } finally {
            await directory.close();
          }
        } else {
          check();
          await store.remove();
          check();
        }
        return { state: "removed", scope: "local profile" };
      });
    }, check);
  };
  return guard(0);
}

export function revokeLocalProfile(store: StateStore, runner: (agentId: string) => WorkflowRunner) {
  return withLocalProfileProtection(store, runner, (_snapshot, remove) => remove());
}

/** Protect every retained generation and expose only owned recovery counts.
 * The caller holds the settings device lock. Histories and settings remain on disk.
 */
export async function withConfiguredProfileProtection<T>(
  profile: StateStore,
  settings: SettingsStore,
  mutation: (
    owner: ConnectorState,
    metadata: { unresolvedCount: number; preservedUnappliedSetup?: true },
  ) => Promise<T>,
  mode: "idle" | "fresh-approval" = "idle",
) {
  const snapshot = await settings.read();
  const owner = await profile.read();
  if (!snapshot || !owner || settings.profile !== profile || !sameOwner(snapshot, owner))
    throw new RuntimeError("AUTHORITY_LOST");
  if (owner.pending || owner.registration) throw new RuntimeError("RUNTIME_BUSY");
  if (mode === "fresh-approval" && !isFreshApprovalEligible(owner))
    throw new RuntimeError("RUNTIME_BUSY");
  const preservedUnappliedSetup =
    mode === "fresh-approval" && isUnappliedInitialSetup(snapshot, owner);
  if (!preservedUnappliedSetup) await settings.assertIdle();
  const pointers = [...snapshot.retained, ...(snapshot.current ? [snapshot.current] : [])].sort(
    (a, b) => a.generation.localeCompare(b.generation),
  );
  const mappings = mappingEvidence(owner, pointers);
  const generations = await generationInventory(settings, pointers);
  const legacyAgents = await RuntimeStore.agents(profile.dir, profile.profile);
  if (legacyAgents.some((agentId) => !pointers.some((p) => p.legacy && p.agentId === agentId)))
    throw new RuntimeError("RUNTIME_BUSY");
  const validations: (() => Promise<void>)[] = [];
  let unresolvedCount = 0;
  const guard = async (index: number): Promise<T> => {
    if (index === pointers.length)
      return profile.transaction(async () => {
        if (
          stableJson(await profile.read()) !== stableJson(owner) ||
          stableJson(await settings.read()) !== stableJson(snapshot)
        )
          throw new RuntimeError("AUTHORITY_LOST");
        for (const validate of validations) await validate();
        const currentAgents = await RuntimeStore.agents(profile.dir, profile.profile);
        if (stableJson(currentAgents.sort()) !== stableJson(legacyAgents.sort()))
          throw new RuntimeError("AUTHORITY_LOST");
        if (stableJson(await generationInventory(settings, pointers)) !== stableJson(generations))
          throw new RuntimeError("AUTHORITY_LOST");
        return mutation(owner, {
          unresolvedCount,
          ...(preservedUnappliedSetup ? { preservedUnappliedSetup: true } : {}),
        });
      });
    const pointer = pointers[index];
    const runtime = pointer.legacy
      ? new RuntimeStore(profile.dir, profile.profile, pointer.agentId)
      : settings.generationStore(pointer.agentId, pointer.generation);
    return runtime.locked(async () => {
      const record = await runtime.read();
      const mapping = mappings.get(pointer.generation);
      if (
        !record ||
        !matchesPointer(snapshot, pointer, record) ||
        !matchesCurrentMapping(snapshot, pointer, record, owner) ||
        (mapping && !matchesMapping(mapping, pointer, record))
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      const recordMode = pointer.legacy ? "idle" : mode;
      const count = protectedUnresolvedCount(record, recordMode);
      return runtime.sessionLocked(record.context!.threadId, async () => {
        const validate = async () => {
          const current = await runtime.read();
          if (stableJson(current) !== stableJson(record)) throw new RuntimeError("AUTHORITY_LOST");
          if (current) protectedUnresolvedCount(current, recordMode);
        };
        validations.push(validate);
        unresolvedCount += count;
        try {
          return await guard(index + 1);
        } finally {
          unresolvedCount -= count;
          validations.pop();
        }
      });
    });
  };
  return guard(0);
}

/** Initial discovery can fail before confirmation, then become UNKNOWN after auth loss.
 * SettingsManager persists settings before calling prepare, even if no runtime is created.
 * A metadata reservation alone proves neither catalog completion nor process termination.
 * SettingsStore.read has already validated journal, receipt, root and catalog ownership.
 */
function isUnappliedInitialSetup(state: SettingsState, owner: ConnectorState) {
  const journal = state.journal;
  if (
    !journal ||
    !(
      journal.phase === "UNKNOWN" ||
      (journal.phase === "FAILED" && journal.receipt?.state === "FAILED")
    ) ||
    !journal.receipt ||
    !["LOCAL_CONFIRMATION", "FAILED"].includes(journal.receipt.state) ||
    journal.operation.expectedConfigRevision !== 0 ||
    journal.receipt.configRevision !== 0 ||
    journal.receipt.runtime !== journal.operation.requested.runtime ||
    journal.receipt.agentId !== null ||
    journal.receipt.workspaceId !== null ||
    journal.receipt.bindingEpoch !== null ||
    (journal.operation.receipt &&
      (!["LOCAL_CONFIRMATION", "FAILED"].includes(journal.operation.receipt.state) ||
        journal.operation.receipt.configRevision !== 0 ||
        journal.operation.receipt.agentId !== null ||
        journal.operation.receipt.workspaceId !== null ||
        journal.operation.receipt.bindingEpoch !== null)) ||
    journal.settings !== null ||
    journal.context !== null ||
    journal.previous != null ||
    (journal.applyBody && journal.applyBody.expectedEpoch !== null) ||
    journal.commitBody !== undefined ||
    state.current !== null ||
    state.retained.length !== 0 ||
    owner.mappings.length !== 0
  )
    return false;
  const catalog = journal.catalogContext;
  return (
    !catalog ||
    (journal.operation.requested.runtime === "claude" &&
      catalog.provider === "claude" &&
      catalog.ownership === "CONNECTOR_CREATED" &&
      catalog.generation === journal.generation &&
      stableJson(catalog.root) === stableJson(journal.root) &&
      catalog.epoch === 1 &&
      catalog.level === "L1" &&
      catalog.ownedTurns.length === 0 &&
      catalog.materialization?.state === "RESERVED" &&
      catalog.materialization.initHash === null &&
      (!journal.receipt.catalog ||
        (journal.receipt.catalog.runtime === "claude" &&
          catalog.materialization.version === journal.receipt.catalog.version)))
  );
}

function protectedUnresolvedCount(record: RuntimeRecord, mode: "idle" | "fresh-approval") {
  if (!unresolvedRuntime(record)) return 0;
  if (
    mode !== "fresh-approval" ||
    record.preparation ||
    record.operations.some((operation) => !["CONFIRMED", "CLOSED"].includes(operation.state)) ||
    record.attempts.some(
      (attempt) =>
        !["UPLOADED", "NOT_STARTED"].includes(attempt.state) &&
        !(attempt.state === "UNKNOWN" && attempt.terminal === null && attempt.receipt === null),
    )
  )
    throw new RuntimeError("RUNTIME_BUSY");
  // UNKNOWN tools and native inputs stay untouched; no result or completion is inferred.
  return record.attempts.filter((attempt) => attempt.state === "UNKNOWN").length;
}

export function revokeConfiguredProfile(profile: StateStore, settings: SettingsStore) {
  return withConfiguredProfileProtection(profile, settings, async (owner) => {
    await removeOwnedProfile(profile, owner);
    return { state: "removed", scope: "local profile", historyRetained: true };
  });
}

async function generationInventory(settings: SettingsStore, pointers: GenerationPointer[]) {
  const parent = join(settings.dir, "generations");
  let entries: string[];
  try {
    const stat = await lstat(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    entries = (await readdir(parent)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    entries = [];
  }
  const expected = pointers
    .filter((p) => !p.legacy)
    .map((p) => p.generation)
    .sort();
  if (stableJson(entries) !== stableJson(expected)) throw new RuntimeError("RUNTIME_BUSY");
  for (const pointer of pointers.filter((p) => !p.legacy)) {
    const dir = join(parent, pointer.generation);
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    const agents = await RuntimeStore.agents(dir, settings.profile.profile);
    if (stableJson(agents.sort()) !== stableJson([pointer.agentId]))
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
  }
  return entries;
}

function sameOwner(settings: SettingsState, owner: ConnectorState) {
  return (
    owner.server === settings.server &&
    owner.deviceId === settings.deviceId &&
    owner.scope?.organizationId === settings.organizationId &&
    owner.scope.roomId === settings.roomId
  );
}
function matchesPointer(
  state: SettingsState,
  pointer: GenerationPointer,
  record: import("../runtime-contracts.ts").RuntimeRecord,
) {
  return (
    record.scope.server === state.server &&
    record.scope.deviceId === state.deviceId &&
    record.scope.organizationId === state.organizationId &&
    record.scope.roomId === state.roomId &&
    record.scope.agentId === pointer.agentId &&
    record.scope.bindingEpoch === pointer.bindingEpoch &&
    record.settings?.provider === pointer.provider &&
    record.context?.generation === pointer.generation &&
    record.context.epoch === pointer.bindingEpoch &&
    record.context.ownership === "CONNECTOR_CREATED" &&
    (pointer.legacy || record.version === 2)
  );
}
function matchesCurrentMapping(
  state: SettingsState,
  pointer: GenerationPointer,
  record: import("../runtime-contracts.ts").RuntimeRecord,
  owner: ConnectorState,
) {
  if (state.current?.generation !== pointer.generation) return true;
  const mappings = owner.mappings.filter((mapping) => mapping.agentId === pointer.agentId);
  const mapping = mappings[0];
  return mappings.length === 1 && matchesMapping(mapping, pointer, record);
}

/** Live mappings must name exactly one protected generation; older histories may be unmapped. */
function mappingEvidence(owner: ConnectorState, pointers: GenerationPointer[]) {
  if (new Set(owner.mappings.map((mapping) => mapping.agentId)).size !== owner.mappings.length)
    throw new RuntimeError("CONTEXT_UNCONFIRMED");
  const mapped = new Map<string, Mapping>();
  for (const mapping of owner.mappings) {
    const matching = pointers.filter((pointer) => matchesMappingPointer(mapping, pointer));
    if (matching.length !== 1 || mapped.has(matching[0].generation))
      throw new RuntimeError("CONTEXT_UNCONFIRMED");
    mapped.set(matching[0].generation, mapping);
  }
  return mapped;
}

function matchesMappingPointer(mapping: Mapping, pointer: GenerationPointer) {
  return (
    mapping.agentId === pointer.agentId &&
    mapping.workspaceId === pointer.workspaceId &&
    mapping.bindingEpoch === pointer.bindingEpoch &&
    (mapping.formatVersion === undefined
      ? pointer.legacy === true
      : mapping.formatVersion === 2 &&
        mapping.runtime === pointer.provider &&
        mapping.generation === pointer.generation)
  );
}

function matchesMapping(
  mapping: Mapping,
  pointer: GenerationPointer,
  record: import("../runtime-contracts.ts").RuntimeRecord,
) {
  return (
    matchesMappingPointer(mapping, pointer) &&
    mapping.root === record.context?.root.path &&
    mapping.nativeSessionId === record.context?.threadId &&
    (mapping.formatVersion === undefined ||
      mapping.materialization === (record.context?.materialization?.state ?? "MATERIALIZED"))
  );
}
async function removeOwnedProfile(profile: StateStore, snapshot: ConnectorState) {
  const before = await lstat(profile.file);
  if (stableJson(await profile.read()) !== stableJson(snapshot))
    throw new RuntimeError("AUTHORITY_LOST");
  const current = await lstat(profile.file);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.uid !== process.getuid?.() ||
    (current.mode & 0o777) !== 0o600 ||
    current.nlink !== 1 ||
    current.ino !== before.ino ||
    current.dev !== before.dev ||
    current.size !== before.size ||
    current.mtimeMs !== before.mtimeMs ||
    current.ctimeMs !== before.ctimeMs
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  await unlink(profile.file);
  const directory = await open(profile.dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
