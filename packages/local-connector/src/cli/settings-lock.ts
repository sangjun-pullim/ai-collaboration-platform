import type { StateStore } from "../state-store.ts";
import { RuntimeError } from "../runtime-contracts.ts";
import { SettingsStore } from "../settings/store.ts";

export class RetiredProfileError extends RuntimeError {
  constructor() {
    super("CONTEXT_UNCONFIRMED");
  }
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
