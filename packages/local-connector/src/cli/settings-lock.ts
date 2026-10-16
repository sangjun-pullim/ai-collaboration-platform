import type { StateStore, ConnectorState } from "../state-store.ts";
import { ConnectionError, isHash, isId } from "../contracts.ts";
import { RuntimeError } from "../runtime-contracts.ts";
import { SettingsStore } from "../settings/store.ts";

export class RetiredProfileError extends RuntimeError {
  constructor() {
    super("CONTEXT_UNCONFIRMED");
  }
}

/** The caller must hold settings.locked; only normal connect may hand off unfinished settings. */
export async function readConnectSettingsOwner(
  settings: SettingsStore,
  expectedScope: { server: string; organizationId: string; roomId: string },
): Promise<ConnectorState | undefined> {
  const original = await settings.profile.read();
  const configured = await settings.read();
  if (configured && !original) throw new RetiredProfileError();
  if (original) {
    if (
      original.server !== expectedScope.server ||
      (original.scope &&
        (original.scope.organizationId !== expectedScope.organizationId ||
          original.scope.roomId !== expectedScope.roomId))
    )
      throw new ConnectionError("FORBIDDEN");
    if ((original.credential || original.deviceId) && !original.scope)
      throw new ConnectionError("FORBIDDEN");
  }
  if (
    configured &&
    (original!.server !== configured.server ||
      original!.deviceId !== configured.deviceId ||
      original!.scope?.organizationId !== configured.organizationId ||
      original!.scope?.roomId !== configured.roomId)
  )
    throw new ConnectionError("FORBIDDEN");
  // A rejected or expired owner needs fresh approval, not a retry of its settings.
  // This remains a refusal: no journal is resumed, cleared, or treated as idle.
  if (
    original &&
    isId(original.deviceId) &&
    isHash(original.credential) &&
    !original.pending &&
    !original.registration &&
    (original.status === "disconnected" ||
      Date.parse(original.credentialExpiresAt ?? "") <= Date.now())
  )
    throw new ConnectionError("UNAUTHENTICATED");
  // Only the same registered owner may hand its durable journal to SettingsManager.
  // The device lock still excludes live owners; enrollment and other commands remain idle-only.
  const resumeSettings =
    configured &&
    original?.status === "connected" &&
    isId(original.deviceId) &&
    isHash(original.credential) &&
    Date.parse(original.credentialExpiresAt ?? "") > Date.now() &&
    !original.pending &&
    !original.registration;
  if (!resumeSettings) await settings.assertIdle();
  return original;
}

/** Acquire the device lock before any binding, session or profile lock. */
export function withSettingsDeviceLock<T>(
  profile: StateStore,
  command: string,
  run: (settings: SettingsStore) => Promise<T>,
): Promise<T> {
  const settings = new SettingsStore(profile);
  return settings.locked(async () => {
    await settings.assertIdle();
    const state = await settings.read();
    if (state && ["pair", "exchange", "connect"].includes(command) && !(await profile.read()))
      throw new RetiredProfileError();
    if (state?.current && ["register", "replace", "runtime-prepare"].includes(command))
      throw new RuntimeError("UNSUPPORTED_SETTINGS");
    return run(settings);
  });
}
