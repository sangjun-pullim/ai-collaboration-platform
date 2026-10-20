import test from "node:test";
import assert from "node:assert/strict";
import {
  connectionSnapshot,
  connectionTime,
  connectionObservationExpired,
  unavailableConnectionSnapshot,
} from "../../src/features/device-binding/connection-presence.ts";
import type { OwnedDevice } from "../../src/features/device-binding/contracts.ts";

const now = "2026-10-12T02:00:00.000Z";
const device = (changes: Partial<OwnedDevice> = {}): OwnedDevice => ({
  deviceId: "private-device-id",
  deviceAlias: "내 Mac",
  organizationId: "private-org-id",
  roomId: "private-room-id",
  state: "active",
  lastSeenAt: now,
  expiresAt: "2026-10-12T03:00:00.000Z",
  ...changes,
});

test("should expire observations at the earliest heartbeat or credential deadline including hidden devices", () => {
  const devices = Array.from({ length: 6 }, () => device());
  devices[5] = device({ expiresAt: "2026-10-12T02:00:10.000Z" });
  const snapshot = connectionSnapshot({ devices, rooms: [] }, now);
  assert.equal(snapshot.devices.length, 5);
  assert.equal(connectionObservationExpired(snapshot, Date.parse(now) + 9_999), false);
  assert.equal(connectionObservationExpired(snapshot, Date.parse(now) + 10_000), true);
  const oldHeartbeat = connectionSnapshot(
    { devices: [device({ lastSeenAt: "2026-10-12T01:58:31.000Z" })], rooms: [] },
    now,
  );
  assert.equal(connectionObservationExpired(oldHeartbeat, Date.parse(now) + 1_000), true);
  assert.equal(connectionObservationExpired(snapshot, Date.parse(now) + 90_000), true);
  assert.equal(snapshot.connectedCount, 6);
  assert.equal(
    connectionObservationExpired(unavailableConnectionSnapshot(now), Date.parse(now)),
    false,
  );
});

test("should mark only a current authenticated recent device green", () => {
  for (const [changes, green] of [
    [{}, true],
    [{ lastSeenAt: new Date(Date.parse(now) - 89_999).toISOString() }, true],
    [{ lastSeenAt: new Date(Date.parse(now) - 90_000).toISOString() }, false],
    [{ lastSeenAt: new Date(Date.parse(now) + 5_000).toISOString() }, true],
    [{ lastSeenAt: new Date(Date.parse(now) + 5_001).toISOString() }, false],
    [{ lastSeenAt: null }, false],
    [{ lastSeenAt: "invalid" }, false],
    [{ expiresAt: now }, false],
    [{ expiresAt: null }, false],
    [{ expiresAt: "invalid" }, false],
    [{ state: "revoked" }, false],
    [{ state: "removed" }, false],
  ] as [Partial<OwnedDevice>, boolean][]) {
    const result = connectionSnapshot({ devices: [device(changes)], rooms: [] }, now);
    assert.equal(result.state === "connected", green, JSON.stringify(changes));
    assert.equal(result.connectedCount, Number(green));
  }
  assert.equal(
    connectionSnapshot({ devices: [device()], rooms: [] }, "invalid").state,
    "unconfirmed",
  );
});

test("should distinguish mixed owned devices and limit projected detail without secrets", () => {
  const devices = Array.from({ length: 7 }, (_, i) =>
    device({ deviceAlias: `Mac ${i}`, lastSeenAt: i === 0 ? now : null }),
  );
  devices.push(device({ state: "revoked" }), device({ state: "removed" }));
  const snapshot = connectionSnapshot(
    {
      devices,
      rooms: [
        {
          roomId: "private-room-id",
          organizationId: "private-org-id",
          roomTitle: "개발방",
          organizationName: "우리 팀",
        },
      ],
    },
    now,
  );
  assert.equal(snapshot.activeCount, 7);
  assert.equal(snapshot.connectedCount, 1);
  assert.equal(snapshot.devices.length, 5);
  assert.equal(snapshot.devices[0].roomTitle, "개발방");
  assert.equal(snapshot.devices[1].state, "unconfirmed");
  assert.ok(!JSON.stringify(snapshot).includes("private-"));
  assert.equal(unavailableConnectionSnapshot(now).state, "unavailable");
  assert.match(connectionTime(now), /11:00:00/);
});
