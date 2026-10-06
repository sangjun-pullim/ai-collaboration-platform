import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { RuntimeStore, unresolvedRuntime } from "../runtime-store.ts";
import { RuntimeError, stableJson } from "../runtime-contracts.ts";
import type { StateStore } from "../state-store.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";
import { SettingsStore, type GenerationPointer, type SettingsState } from "../settings/store.ts";
import type { ConnectorState } from "../state-store.ts";

export async function revokeLocalProfile(
  store: StateStore,
  runner: (agentId: string) => WorkflowRunner,
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
  const remove = async (index: number): Promise<unknown> => {
    if (index < agents.length)
      return runner(agents[index]).guardLocalRemoval(async (proof) => {
        protections.push(proof);
        try {
          return await remove(index + 1);
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
    }, check);
  };
  return remove(0);
}

/** Revoke the credential only after proving every retained generation is idle and owned.
 * The caller holds the settings device lock. Histories and settings remain on disk.
 */
export async function revokeConfiguredProfile(profile: StateStore, settings: SettingsStore) {
  await settings.assertIdle();
  const snapshot = await settings.read();
  const owner = await profile.read();
  if (!snapshot || !owner || settings.profile !== profile || !sameOwner(snapshot, owner))
    throw new RuntimeError("AUTHORITY_LOST");
  if (owner.pending || owner.registration) throw new RuntimeError("RUNTIME_BUSY");
  const pointers = [...snapshot.retained, ...(snapshot.current ? [snapshot.current] : [])].sort(
    (a, b) => a.generation.localeCompare(b.generation),
  );
  const legacyAgents = await RuntimeStore.agents(profile.dir, profile.profile);
  if (legacyAgents.some((agentId) => !pointers.some((p) => p.legacy && p.agentId === agentId)))
    throw new RuntimeError("RUNTIME_BUSY");
  const validations: (() => Promise<void>)[] = [];
  const guard = async (index: number): Promise<unknown> => {
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
        await removeOwnedProfile(profile, owner);
        return { state: "removed", scope: "local profile", historyRetained: true };
      });
    const pointer = pointers[index];
    const runtime = pointer.legacy
      ? new RuntimeStore(profile.dir, profile.profile, pointer.agentId)
      : settings.generationStore(pointer.agentId, pointer.generation);
    return runtime.locked(async () => {
      const record = await runtime.read();
      if (
        !record ||
        !matchesPointer(snapshot, pointer, record) ||
        !matchesCurrentMapping(snapshot, pointer, record, owner)
      )
        throw new RuntimeError("CONTEXT_UNCONFIRMED");
      if (unresolvedRuntime(record)) throw new RuntimeError("RUNTIME_BUSY");
      return runtime.sessionLocked(record.context!.threadId, async () => {
        const validate = async () => {
          const current = await runtime.read();
          if (stableJson(current) !== stableJson(record)) throw new RuntimeError("AUTHORITY_LOST");
          if (current && unresolvedRuntime(current)) throw new RuntimeError("RUNTIME_BUSY");
        };
        validations.push(validate);
        try {
          return await guard(index + 1);
        } finally {
          validations.pop();
        }
      });
    });
  };
  return guard(0);
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
  return (
    mappings.length === 1 &&
    mapping.workspaceId === pointer.workspaceId &&
    mapping.bindingEpoch === pointer.bindingEpoch &&
    mapping.root === record.context?.root.path &&
    mapping.nativeSessionId === record.context?.threadId &&
    (pointer.legacy ||
      (mapping.formatVersion === 2 &&
        mapping.runtime === pointer.provider &&
        mapping.generation === pointer.generation &&
        mapping.materialization === (record.context?.materialization?.state ?? "MATERIALIZED")))
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
