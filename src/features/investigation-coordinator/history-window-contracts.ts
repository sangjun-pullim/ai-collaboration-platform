import {
  WorkflowError,
  projectResponse,
  type PublicEvent,
  type RecoveryHistoryPage,
} from "./contracts.ts";

export const HISTORY_WINDOW_LIMIT = 40;
export const HISTORY_WINDOW_BYTES = 262144;
export type HistoryWindowRequest = {
  protocol: 1;
  expectedUserId: string;
  roomId: string;
  beforeSequence: number | null;
};
export type HistoryWindow = {
  protocol: 1;
  roomId: string;
  beforeSequence: number | null;
  oldestSequence: number | null;
  hasOlder: boolean;
  events: PublicEvent[];
  snapshot: RecoveryHistoryPage;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}
const cursor = (value: unknown) =>
  value === null || (Number.isSafeInteger(value) && Number(value) > 0);
export function historyWindowRequest(value: unknown): HistoryWindowRequest {
  if (
    !object(value) ||
    !exact(value, ["protocol", "expectedUserId", "roomId", "beforeSequence"]) ||
    value.protocol !== 1 ||
    typeof value.expectedUserId !== "string" ||
    !uuid.test(value.expectedUserId) ||
    typeof value.roomId !== "string" ||
    !uuid.test(value.roomId) ||
    !cursor(value.beforeSequence)
  )
    throw new WorkflowError("INVALID_BODY");
  return value as HistoryWindowRequest;
}
export function projectHistoryWindow(value: unknown): HistoryWindow {
  const fail = () => {
    throw new WorkflowError("UNAVAILABLE");
  };
  if (
    !object(value) ||
    !exact(value, [
      "protocol",
      "roomId",
      "beforeSequence",
      "oldestSequence",
      "hasOlder",
      "events",
      "snapshot",
    ]) ||
    value.protocol !== 1 ||
    !cursor(value.beforeSequence) ||
    !cursor(value.oldestSequence) ||
    typeof value.hasOlder !== "boolean" ||
    !Array.isArray(value.events) ||
    value.events.length > HISTORY_WINDOW_LIMIT ||
    new TextEncoder().encode(JSON.stringify({ ok: true, data: value })).length >
      HISTORY_WINDOW_BYTES
  )
    return fail();
  const snapshot = projectResponse("read-recovery", value.snapshot) as RecoveryHistoryPage;
  if (
    value.roomId !== snapshot.roomId ||
    snapshot.events.length ||
    snapshot.nextCursor !== snapshot.highWaterSequence ||
    snapshot.hasMore
  )
    return fail();
  const upper =
    value.beforeSequence === null ? snapshot.highWaterSequence + 1 : Number(value.beforeSequence);
  if (upper > snapshot.highWaterSequence + 1) return fail();
  const events: PublicEvent[] = [];
  for (let i = 0; i < value.events.length; i += 16) {
    const chunk = value.events.slice(i, i + 16);
    const last = chunk.at(-1);
    if (!object(last) || !Number.isSafeInteger(last.sequence)) return fail();
    const page = projectResponse("read", {
      ...snapshotWithoutRecovery(snapshot),
      events: chunk,
      nextCursor: last.sequence,
      hasMore: Number(last.sequence) < snapshot.highWaterSequence,
    });
    events.push(...(page as RecoveryHistoryPage).events);
  }
  if (
    new Set(events.map((event) => event.eventId)).size !== events.length ||
    events.some(
      (event, i) => event.sequence < 1 || (i > 0 && event.sequence !== events[i - 1].sequence + 1),
    ) ||
    (events.length ? events.at(-1)!.sequence !== upper - 1 : upper !== 1) ||
    value.oldestSequence !== (events[0]?.sequence ?? null) ||
    value.hasOlder !== !!(events[0] && events[0].sequence > 1)
  )
    return fail();
  return {
    protocol: 1,
    roomId: snapshot.roomId,
    beforeSequence: value.beforeSequence as number | null,
    oldestSequence: value.oldestSequence as number | null,
    hasOlder: value.hasOlder,
    events,
    snapshot,
  };
}
function snapshotWithoutRecovery(snapshot: RecoveryHistoryPage) {
  const { recovery, ...page } = snapshot;
  void recovery;
  return page;
}
