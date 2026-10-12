import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Connector } from "../src/cli.ts";
import { CentralClient } from "../src/central-client.ts";
import { StateStore } from "../src/state-store.ts";
import { ConnectionRenewal } from "../src/connection-renewal.ts";
import { runtimeFixture, uuid } from "./runtime-fixture.ts";
import { deferred } from "./runner-fixture.ts";

async function fixture() {
  const f = await runtimeFixture();
  const profile = new StateStore(f.stateDir, "one");
  await profile.write({
    version: 1,
    server: f.scope.server,
    status: "connected",
    deviceId: f.scope.deviceId,
    credential: "a".repeat(64),
    credentialExpiresAt: new Date(Date.now() + 300000).toISOString(),
    scope: {
      ownerAlias: "Owner",
      organizationName: "Org",
      roomTitle: "Room",
      deviceAlias: "Device",
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
    },
    mappings: [],
  });
  const calls: { body: Record<string, unknown>; secret: string | null }[] = [];
  let receipt: { body: Record<string, unknown>; expiresAt: string; at: number } | undefined;
  const faults = {
    lost: false,
    revoked: false,
    hold: undefined as (() => Promise<void>) | undefined,
  };
  const client = new CentralClient(f.scope.server, async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ body, secret: new Headers(init?.headers).get("authorization") });
    await faults.hold?.();
    if (faults.revoked)
      return Response.json({ ok: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
    if (receipt) {
      assert.deepEqual(body, receipt.body);
      if (Date.now() >= receipt.at + 120000)
        return Response.json({ ok: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
    } else
      receipt = {
        body,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        at: Date.now(),
      };
    if (faults.lost) {
      faults.lost = false;
      throw new Error("synthetic response lost");
    }
    return Response.json({
      ok: true,
      data: { protocol: 1, deviceId: f.scope.deviceId, expiresAt: receipt.expiresAt },
    });
  });
  const connector = new Connector(profile, client);
  const renewal = new ConnectionRenewal(connector);
  return { ...f, profile, connector, renewal, faults, calls };
}

test("should rotate only at the five-minute boundary and preserve a seven-day credential", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  try {
    const state = (await f.profile.read())!;
    state.credentialExpiresAt = new Date(Date.now() + 300001).toISOString();
    await f.profile.write(state);
    await f.renewal.ensure();
    assert.equal(f.calls.length, 0);
    t.mock.timers.setTime(Date.now() + 1);
    await f.renewal.ensure();
    assert.equal(f.calls.length, 1);
    assert.equal(
      Date.parse((await f.profile.read())!.credentialExpiresAt!),
      Date.now() + 7 * 86400000,
    );
    await f.renewal.ensure();
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("should share a rotation longer than the profile lock budget and settle it before stop returns", async () => {
  const f = await fixture(),
    entered = deferred(),
    release = deferred();
  let settled = false;
  try {
    f.faults.hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const owner = f.renewal.ensure();
    await entered.promise;
    const waiter = f.renewal.ensure().then(() => f.profile.transaction(() => f.profile.read()));
    const stopped = f.renewal.stop().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 3100));
    assert.equal(settled, false);
    assert.equal(f.calls.length, 1);
    release.resolve();
    await owner;
    const state = await waiter;
    await stopped;
    assert.equal(state?.pending, undefined);
    await f.renewal.ensure();
    assert.equal(f.calls.length, 1);
  } finally {
    release.resolve();
    await f.renewal.stop();
    await f.close();
  }
});

for (const expiredBy of [0, 119999, 120000])
  test(`should retain the original pending rotation across response loss at replay age ${expiredBy}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const f = await fixture();
    try {
      f.faults.lost = true;
      await assert.rejects(f.renewal.ensure(), { code: "UNAVAILABLE" });
      const pending = (await f.profile.read())!.pending!;
      t.mock.timers.setTime(Date.now() + expiredBy);
      if (expiredBy === 120000)
        await assert.rejects(f.renewal.ensure(), { code: "UNAUTHENTICATED" });
      else await f.renewal.ensure();
      assert.deepEqual(f.calls[1], f.calls[0]);
      const state = (await f.profile.read())!;
      if (expiredBy === 120000) assert.deepEqual(state.pending, pending);
      else assert.equal(state.credential, pending.candidateCredential);
    } finally {
      await f.close();
    }
  });

test("should recover a pending accepted rotation even when the previous local credential expired", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture();
  try {
    f.faults.lost = true;
    await assert.rejects(f.renewal.ensure(), { code: "UNAVAILABLE" });
    const state = (await f.profile.read())!;
    state.status = "disconnected";
    state.credentialExpiresAt = new Date(Date.now() - 1).toISOString();
    await f.profile.write(state);
    await f.renewal.ensure();
    assert.equal((await f.profile.read())!.status, "connected");
    assert.deepEqual(f.calls[1], f.calls[0]);
  } finally {
    await f.close();
  }
});

for (const held of [
  "expired",
  "disconnected",
  "foreign",
  "pending",
  "registration",
  "pairing",
] as const)
  test(`should preserve ${held} state without initiating an unauthorized rotation`, async () => {
    const f = await fixture();
    try {
      const state = (await f.profile.read())!;
      if (held === "expired") state.credentialExpiresAt = new Date(Date.now() - 1).toISOString();
      if (held === "disconnected") state.status = "disconnected";
      if (held === "foreign") state.server = "https://example.test";
      if (held === "pending")
        state.pending = {
          action: "replace",
          body: { operationId: uuid() },
          payloadHash: "b".repeat(64),
        };
      if (held === "registration")
        state.registration = {
          mapping: { root: f.root, nativeSessionId: uuid() },
          sessionAlias: "Pending",
        };
      if (held === "pairing") {
        state.status = "pairing";
        delete state.deviceId;
        delete state.credential;
        delete state.credentialExpiresAt;
      }
      await f.profile.write(state);
      const bytes = await readFile(f.profile.file);
      if (["expired", "disconnected", "foreign"].includes(held))
        await assert.rejects(f.renewal.ensure());
      else await f.renewal.ensure();
      assert.equal(f.calls.length, 0);
      assert.deepEqual(await readFile(f.profile.file), bytes);
    } finally {
      await f.close();
    }
  });

test("should pin the original device scope and keep rejected rotation evidence", async () => {
  const f = await fixture();
  try {
    f.faults.revoked = true;
    await assert.rejects(f.renewal.ensure(), { code: "UNAUTHENTICATED" });
    assert.equal((await f.profile.read())!.pending?.action, "rotate");
    assert.equal((await f.profile.read())!.status, "disconnected");
    const state = (await f.profile.read())!;
    state.scope!.roomId = uuid();
    await f.profile.write(state);
    await assert.rejects(f.renewal.ensure(), { code: "FORBIDDEN" });
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
