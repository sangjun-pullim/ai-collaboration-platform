import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  validateRealtimeBody,
  validateRealtimeGrant,
  type RealtimeBody,
} from "../../src/features/investigation-coordinator/realtime-contracts.ts";
import {
  RoomRealtime,
  type RealtimeState,
} from "../../src/features/investigation-coordinator/room-realtime.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body: RealtimeBody = { protocol: 1, roomId: id(1), expectedUserId: id(2), clientId: id(3) };
const grant = () => ({
  protocol: 1,
  roomId: body.roomId,
  userId: body.expectedUserId,
  clientId: body.clientId,
  leaseId: id(4),
  topic: `chat-lease:${"a".repeat(64)}`,
  expiresAt: new Date(300_000).toISOString(),
  tokenExpiresAt: new Date(3_600_000).toISOString(),
  accessToken: "memory-only-synthetic-access",
  url: "http://127.0.0.1:54321",
  key: "synthetic-anon",
});
test("should validate exact realtime lease ownership contracts", () => {
  assert.deepEqual(validateRealtimeBody("authorize", body), body);
  assert.deepEqual(validateRealtimeBody("release", { ...body, leaseId: id(4) }), {
    ...body,
    leaseId: id(4),
  });
  for (const bad of [
    null,
    [],
    { ...body, topic: "injected" },
    { ...body, leaseId: null },
    { ...body, clientId: "bad" },
    { ...body, expectedUserId: undefined },
  ])
    assert.throws(() => validateRealtimeBody("authorize", bad), { code: "INVALID_BODY" });
  assert.throws(() => validateRealtimeBody("release", body), { code: "INVALID_BODY" });
  assert.deepEqual(validateRealtimeGrant(grant(), body), grant());
  for (const change of [
    { userId: id(8) },
    { roomId: id(8) },
    { clientId: id(8) },
    { topic: "public" },
    { refreshToken: "secret" },
    { session: {} },
  ])
    assert.throws(() => validateRealtimeGrant({ ...grant(), ...change }, body), {
      code: "UNAVAILABLE",
    });
});
function harness(t: import("node:test").TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0,
    resyncs = 0;
  const states: RealtimeState[] = [];
  const requests: { path: string; body: RealtimeBody }[] = [];
  const clients: {
    auth: unknown;
    token: string | null;
    removed: number;
    disconnected: number;
    signal: (state: string) => void;
    hint: () => void;
  }[] = [];
  let fail = false;
  const environment = {
    now: () => now,
    clientId: () => body.clientId,
    fetch: (async (path: unknown, options: RequestInit) => {
      requests.push({ path: String(path), body: JSON.parse(String(options.body)) });
      if (fail) throw new Error("Synthetic authorization unavailable");
      return {
        ok: true,
        json: async () => ({
          ok: true,
          data: { ...grant(), expiresAt: new Date(now + 300_000).toISOString() },
        }),
      };
    }) as typeof fetch,
    create: ((...args: Parameters<typeof createClient>) => {
      const entry = {
        auth: args[2]?.auth,
        token: null as string | null,
        removed: 0,
        disconnected: 0,
        signal: (state: string) => {
          void state;
        },
        hint: () => {},
      };
      clients.push(entry);
      const channel = {
        on(_event: unknown, _filter: unknown, callback: (message: unknown) => void) {
          entry.hint = () => callback({ payload: { version: 1 } });
          return channel;
        },
        subscribe(callback: (state: string) => void) {
          entry.signal = callback;
          callback("SUBSCRIBED");
          return channel;
        },
      };
      return {
        realtime: {
          setAuth: async (token: string) => {
            entry.token = token;
          },
          disconnect: () => entry.disconnected++,
        },
        channel: () => channel,
        removeAllChannels: async () => {
          entry.removed++;
          entry.token = null;
        },
      };
    }) as unknown as typeof createClient,
  };
  const realtime = new RoomRealtime(
    { roomId: body.roomId, userId: body.expectedUserId },
    () => resyncs++,
    (state) => states.push(state),
    environment,
  );
  t.after(() => realtime.stop());
  return {
    realtime,
    clients,
    requests,
    states,
    resyncs: () => resyncs,
    advance: (ms: number) => {
      now += ms;
      t.mock.timers.tick(ms);
    },
    fail: () => {
      fail = true;
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
test("should backfill after subscribe and ignore closed generation callbacks", async (t) => {
  const h = harness(t);
  h.realtime.start();
  await flush();
  assert.equal(h.resyncs(), 1);
  h.clients[0].hint();
  assert.equal(h.resyncs(), 2);
  h.realtime.stop();
  h.clients[0].hint();
  h.clients[0].signal("SUBSCRIBED");
  assert.equal(h.resyncs(), 2);
  assert.equal(h.clients[0].removed, 1);
  assert.equal(h.clients[0].disconnected, 1);
  assert.equal(h.requests.at(-1)?.path, "/api/chat-realtime/release");
});
test("should renew in memory and discard channels on authorization failure", async (t) => {
  const h = harness(t);
  h.realtime.start();
  await flush();
  assert.deepEqual(h.clients[0].auth, {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  });
  h.advance(270_000);
  await flush();
  assert.equal(h.requests[1].body.leaseId, id(4));
  assert.equal(h.clients.length, 2);
  assert.equal(h.clients[0].token, null);
  assert.equal(h.resyncs(), 2);
  h.fail();
  h.advance(270_000);
  await flush();
  assert.equal(h.clients[1].token, null);
  assert.equal(h.states.at(-1), "reconnecting");
});
test("should reconnect with HTTP backfill after a channel error", async (t) => {
  const h = harness(t);
  h.realtime.start();
  await flush();
  h.clients[0].signal("CHANNEL_ERROR");
  assert.equal(h.states.at(-1), "reconnecting");
  h.advance(10_000);
  await flush();
  assert.equal(h.clients.length, 2);
  assert.equal(h.resyncs(), 2);
});

test("should discard a late authorization after stop without notifying a new lifecycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  let calls = 0,
    created = 0,
    resynced = 0;
  const states: RealtimeState[] = [];
  const realtime = new RoomRealtime(
    { userId: body.expectedUserId, roomId: body.roomId },
    () => resynced++,
    (state) => states.push(state),
    {
      now: () => 0,
      clientId: () => body.clientId,
      fetch: ((path: unknown) => {
        calls++;
        return String(path).endsWith("release") ? Promise.resolve(new Response("{}")) : pending;
      }) as typeof fetch,
      create: (() => {
        created++;
        throw new Error("late authorization must not create a client");
      }) as unknown as typeof createClient,
    },
  );
  realtime.start();
  realtime.stop();
  resolve(new Response(JSON.stringify({ ok: true, data: grant() })));
  await flush();
  assert.equal(created, 0);
  assert.equal(resynced, 0);
  assert.deepEqual(states, ["connecting"]);
  assert.equal(calls, 2);
});
