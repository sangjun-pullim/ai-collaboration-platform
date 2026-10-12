import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Connector } from "../cli.ts";
import { ConnectionError, isId, isHash } from "../contracts.ts";
import { RuntimeError, stableJson } from "../runtime-contracts.ts";
import { RuntimeStore } from "../runtime-store.ts";
import { StateStore, type ConnectorState } from "../state-store.ts";
import { SettingsStore } from "../settings/store.ts";
import type { WorkflowRunner } from "../workflow-runner.ts";
import {
  withConfiguredProfileProtection,
  withLocalProfileProtection,
} from "./remove-local-profile.ts";
import { withSettingsDeviceLock } from "./settings-lock.ts";
import { parseCliOptions } from "./parse-options.ts";
import type { ConnectInput, ConnectInteraction } from "./connect-command.ts";

type Runner = (profile: StateStore, agentId: string) => WorkflowRunner;

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
  return stableJson(result);
}

/** The old device stays locked across human approval; its runtime/session locks do not. */
export async function prepareRecovery(
  connector: Connector,
  input: ConnectInput,
  interaction: ConnectInteraction,
  runner: Runner,
  prepare: () => Promise<void>,
) {
  parseCliOptions(
    [
      "--profile",
      connector.store.profile,
      "--previous-profile",
      input.previousProfile!,
      "--recovery-id",
      input.recoveryId!,
    ],
    "connect",
  );
  const previous = new StateStore(connector.store.dir, input.previousProfile!);
  const settings = new SettingsStore(previous);
  const check = () => {
    if (interaction.signal.aborted) throw new ConnectionError("CONFLICT");
  };
  return settings.locked(async () => {
    check();
    const owner = expired(await previous.read(), connector.client.origin, input);
    const inspect = async () => {
      check();
      expired(await previous.read(), connector.client.origin, input);
      const configured = await settings.read();
      if (configured) {
        const pointers = [
          ...configured.retained,
          ...(configured.current ? [configured.current] : []),
        ];
        for (const context of [configured.journal?.context, configured.journal?.catalogContext]) {
          if (!context) continue;
          const pointer = pointers.find((p) => p.generation === context.generation);
          if (!pointer) throw new RuntimeError("CONTEXT_UNCONFIRMED");
          const store = pointer.legacy
            ? new RuntimeStore(previous.dir, previous.profile, pointer.agentId)
            : settings.generationStore(pointer.agentId, pointer.generation);
          if ((await store.read())?.context?.threadId !== context.threadId)
            throw new RuntimeError("CONTEXT_UNCONFIRMED");
        }
        return withConfiguredProfileProtection(previous, settings, async () => evidence(previous));
      }
      await legacyEvidence(previous, owner);
      return withLocalProfileProtection(
        previous,
        (agent) => runner(previous, agent),
        async () => evidence(previous),
      );
    };
    const snapshot = await inspect();
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
    } else {
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
    if ((await inspect()) !== snapshot) throw new RuntimeError("AUTHORITY_LOST");
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
      await prepare();
      check();
      if ((await evidence(previous)) !== snapshot) throw new RuntimeError("AUTHORITY_LOST");
    });
  }, check);
}
