import type { OwnedDevice } from "./contracts.ts";

export type ConnectionPresence = "connected" | "unconfirmed" | "unavailable";
export type ConnectionSnapshot = {
  state: ConnectionPresence;
  checkedAt: string | null;
  validUntil?: string;
  activeCount: number;
  connectedCount: number;
  devices: {
    deviceAlias: string;
    roomTitle: string;
    organizationName: string;
    state: "connected" | "unconfirmed";
    reason: string;
    lastSeenAt: string | null;
  }[];
};
type Room = {
  roomId: string;
  organizationId: string;
  roomTitle: string;
  organizationName: string;
};
const timestamp = (value: string | null) => (value === null ? NaN : Date.parse(value));

export function connectionSnapshot(
  owned: { devices: OwnedDevice[]; rooms: Room[] },
  checkedAt: string,
): ConnectionSnapshot {
  const now = timestamp(checkedAt);
  const active = owned.devices.filter((device) => device.state === "active");
  const devices = active.map((device) => {
    const seen = timestamp(device.lastSeenAt);
    const expires = timestamp(device.expiresAt);
    const authenticated = Number.isFinite(now) && expires > now;
    const recent = Number.isFinite(seen) && now - seen < 90_000 && now - seen >= -5_000;
    const connected = authenticated && recent;
    const room = owned.rooms.find(
      (room) => room.roomId === device.roomId && room.organizationId === device.organizationId,
    );
    return {
      deviceAlias: device.deviceAlias,
      roomTitle: room?.roomTitle ?? "연결한 방 확인 안 됨",
      organizationName: room?.organizationName ?? "",
      state: connected ? ("connected" as const) : ("unconfirmed" as const),
      reason: connected
        ? "최근 통신 확인"
        : !authenticated
          ? "인증 유효 기간 확인 안 됨"
          : !Number.isFinite(seen)
            ? "통신 기록 없음"
            : seen - now > 5_000
              ? "통신 시각 확인 안 됨"
              : "최근 90초 통신 없음",
      lastSeenAt: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
    };
  });
  const connectedCount = devices.filter((device) => device.state === "connected").length;
  const deadlines = active.flatMap((device, index) =>
    devices[index].state === "connected"
      ? [Math.min(timestamp(device.lastSeenAt) + 90_000, timestamp(device.expiresAt))]
      : [],
  );
  return {
    state: connectedCount > 0 ? "connected" : "unconfirmed",
    checkedAt: Number.isFinite(now) ? new Date(now).toISOString() : null,
    ...(deadlines.length ? { validUntil: new Date(Math.min(...deadlines)).toISOString() } : {}),
    activeCount: active.length,
    connectedCount,
    devices: devices.slice(0, 5),
  };
}

/** An expired observation cannot establish whether the connector is still running. */
export function connectionObservationExpired(snapshot: ConnectionSnapshot, now: number): boolean {
  if (snapshot.state !== "connected") return false;
  const deadline = snapshot.validUntil
    ? timestamp(snapshot.validUntil)
    : Math.min(
        timestamp(snapshot.checkedAt) + 90_000,
        ...snapshot.devices
          .filter((device) => device.state === "connected")
          .map((device) => timestamp(device.lastSeenAt) + 90_000),
      );
  return !Number.isFinite(deadline) || now >= deadline;
}

export function unavailableConnectionSnapshot(checkedAt: string | null): ConnectionSnapshot {
  return { state: "unavailable", checkedAt, activeCount: 0, connectedCount: 0, devices: [] };
}

/** Use an explicit zone on both server and client to keep hydration deterministic. */
export function connectionTime(value: string | null): string {
  return value === null
    ? "없음"
    : new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(value));
}
