import { ConnectionError, isHash, isId } from "./contracts.ts";
import type { StateStore, ConnectorState } from "./state-store.ts";

export interface ConnectionRenewalControl {
  ensure(check?: () => void): Promise<void>;
  stop(): Promise<void>;
}
type RenewalConnector = {
  store: StateStore;
  client: { origin: string };
  rotate(check?: () => void): Promise<unknown>;
};

/** One device owner shares this coordinator; callers wait outside profile transactions. */
export class ConnectionRenewal implements ConnectionRenewalControl {
  private work: Promise<void> | undefined;
  private stopped = false;
  private identity: string | undefined;
  constructor(private readonly connector: RenewalConnector) {}

  private registered(state: ConnectorState | undefined): state is ConnectorState {
    if (!state) return false;
    if (state.server !== this.connector.client.origin) throw new ConnectionError("CONFLICT");
    if (!state.deviceId && !state.credential) return false;
    if (
      !isId(state.deviceId) ||
      !isId(state.scope?.organizationId) ||
      !isId(state.scope?.roomId) ||
      !isHash(state.credential)
    )
      throw new ConnectionError("UNAUTHENTICATED");
    const identity = JSON.stringify([
      state.server,
      state.deviceId,
      state.scope!.organizationId,
      state.scope!.roomId,
    ]);
    if (this.identity && identity !== this.identity) throw new ConnectionError("FORBIDDEN");
    this.identity = identity;
    return true;
  }
  private due(state: ConnectorState) {
    if (state.registration || (state.pending && state.pending.action !== "rotate")) return false;
    if (state.pending?.action === "rotate") return true;
    const expires = Date.parse(state.credentialExpiresAt ?? "");
    if (state.status !== "connected" || !Number.isFinite(expires) || expires <= Date.now())
      throw new ConnectionError("UNAUTHENTICATED");
    return expires - Date.now() <= 5 * 60_000;
  }
  private async renew() {
    const store = this.connector.store;
    const state = await store.read();
    if (this.stopped || !this.registered(state) || !this.due(state)) return;
    await store.transaction(async () => {
      const current = await store.read();
      if (this.stopped) return;
      if (!this.registered(current)) throw new ConnectionError("UNAUTHENTICATED");
      if (!this.due(current)) return;
      // An admitted rotation finishes its journal even if an individual waiter closes.
      await this.connector.rotate();
      const next = await store.read();
      if (!this.registered(next) || next.pending || next.status !== "connected")
        throw new ConnectionError("UNAUTHENTICATED");
    });
  }
  async ensure(check = () => {}) {
    check();
    if (this.work) {
      await this.work;
      check();
      return;
    }
    if (this.stopped) return;
    const work = this.renew();
    this.work = work;
    try {
      await work;
      check();
    } finally {
      if (this.work === work) this.work = undefined;
    }
  }
  async stop() {
    this.stopped = true;
    // The request owner observes errors; shutdown only drains retained work.
    await this.work?.catch(() => {});
  }
}
