import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  validateRealtimeGrant,
  type RealtimeGrant,
  type RealtimeBody,
} from "./realtime-contracts.ts";

export type RealtimeState = "connecting" | "connected" | "reconnecting";
type Actor = { userId: string; roomId: string };
type RealtimeEnvironment = {
  fetch: typeof fetch;
  create: typeof createClient;
  now: () => number;
  clientId: () => string;
};
/** Tokens and channels exist only inside one active lifecycle. */
export class RoomRealtime {
  private generation = 0;
  private active = false;
  private grant: RealtimeGrant | null = null;
  private client: SupabaseClient | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort: AbortController | null = null;
  private clientId: string;
  constructor(
    private readonly actor: Actor,
    private readonly resync: () => void,
    private readonly onState: (state: RealtimeState) => void,
    private readonly env: RealtimeEnvironment = {
      fetch: (...args) => fetch(...args),
      create: createClient,
      now: Date.now,
      clientId: () => crypto.randomUUID(),
    },
  ) {
    this.clientId = env.clientId();
  }
  start() {
    if (this.active) return;
    if (this.generation > 0) this.clientId = this.env.clientId();
    this.active = true;
    const generation = ++this.generation;
    this.onState("connecting");
    void this.connect(generation);
  }
  private body(leaseId?: string): RealtimeBody {
    return {
      protocol: 1,
      roomId: this.actor.roomId,
      expectedUserId: this.actor.userId,
      clientId: this.clientId,
      ...(leaseId ? { leaseId } : {}),
    };
  }
  private release(grant: RealtimeGrant) {
    // Release is best effort; expiry and publisher authorization are independent guards.
    void this.env
      .fetch("/api/chat-realtime/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocol: 1,
          roomId: grant.roomId,
          expectedUserId: grant.userId,
          clientId: grant.clientId,
          leaseId: grant.leaseId,
        }),
        cache: "no-store",
        keepalive: true,
      })
      .catch(() => {});
  }
  private discard() {
    const client = this.client;
    this.client = null;
    if (client) {
      void client.removeAllChannels().catch(() => {});
      client.realtime.disconnect();
    }
    this.grant = null;
  }
  stop() {
    this.active = false;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.abort?.abort();
    this.abort = null;
    const grant = this.grant;
    this.discard();
    if (grant) this.release(grant);
  }
  private retry(generation: number) {
    if (!this.active || this.generation !== generation) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect(generation);
    }, 10_000);
  }
  private async connect(generation: number) {
    if (!this.active || this.generation !== generation) return;
    const previous = this.grant;
    const body = this.body(
      previous && Date.parse(previous.expiresAt) > this.env.now() ? previous.leaseId : undefined,
    );
    const abort = new AbortController();
    this.abort?.abort();
    this.abort = abort;
    const timeout = setTimeout(() => {
      if (this.active && this.generation === generation && this.abort === abort) {
        abort.abort();
        this.discard();
        this.onState("reconnecting");
        this.retry(generation);
      }
    }, 10_000);
    try {
      const response = await this.env.fetch("/api/chat-realtime/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error("Authorization unavailable");
      const grant = validateRealtimeGrant(result.data, body);
      if (!this.active || this.generation !== generation || abort.signal.aborted) {
        this.release(grant);
        return;
      }
      const lifetime =
        Math.min(Date.parse(grant.expiresAt), Date.parse(grant.tokenExpiresAt)) - this.env.now();
      if (lifetime < 5000) throw new Error("Authorization expired");
      this.discard();
      this.grant = grant;
      const client = this.env.create(grant.url, grant.key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 10 } },
      });
      this.client = client;
      await client.realtime.setAuth(grant.accessToken);
      if (!this.active || this.generation !== generation || this.client !== client) return;
      client
        .channel(grant.topic, {
          config: {
            private: true,
            broadcast: { self: false, ack: false },
            presence: { enabled: false },
          },
        })
        .on("broadcast", { event: "changed" }, (message) => {
          if (
            this.active &&
            this.generation === generation &&
            this.client === client &&
            message.payload?.version === 1
          )
            this.resync();
        })
        .subscribe((status) => {
          if (!this.active || this.generation !== generation || this.client !== client) return;
          if (status === "SUBSCRIBED") {
            this.onState("connected");
            this.resync();
          } else if (["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"].includes(status)) {
            this.onState("reconnecting");
            this.discard();
            this.retry(generation);
          }
        });
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.onState("reconnecting");
          void this.connect(generation);
        },
        Math.max(1000, lifetime - 30_000),
      );
    } catch {
      if (!this.active || this.generation !== generation || abort.signal.aborted) return;
      this.discard();
      this.onState("reconnecting");
      this.retry(generation);
    } finally {
      clearTimeout(timeout);
      if (this.abort === abort) this.abort = null;
    }
  }
}
