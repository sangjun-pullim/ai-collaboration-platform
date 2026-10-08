import type { HistoryPage, PublicEvent, RunState, RequestKind, Terminal } from "./contracts.ts";

export interface HistoricalRun {
  requestId: string;
  cycleId: string;
  agentId: string;
  requestKind: RequestKind;
  state: RunState;
  terminal: Terminal | null;
  sequence: number;
}
export interface HistoryState {
  roomId: string;
  cursor: number;
  events: PublicEvent[];
  runs: HistoricalRun[];
  snapshot: HistoryPage | null;
  gap: boolean;
}
export function emptyHistory(roomId: string): HistoryState {
  return { roomId, cursor: 0, events: [], runs: [], snapshot: null, gap: false };
}
export function mergeHistory(state: HistoryState, page: HistoryPage): HistoryState {
  if (page.roomId !== state.roomId) state = emptyHistory(page.roomId);
  const ids = new Map(state.events.map((event) => [event.eventId, event]));
  for (const event of page.events) {
    if (event.roomId === page.roomId && !ids.has(event.eventId)) ids.set(event.eventId, event);
  }
  const events = [...ids.values()].sort((a, b) => a.sequence - b.sequence);
  let cursor = 0;
  for (const event of events) {
    if (event.sequence === cursor + 1) cursor = event.sequence;
    else if (event.sequence > cursor + 1) break;
  }
  // Delayed backfill still contributes events; its older snapshot cannot undo current state.
  const snapshot =
    state.snapshot &&
    (state.snapshot.highWaterSequence > page.highWaterSequence ||
      state.snapshot.roomRevision > page.roomRevision)
      ? state.snapshot
      : page;
  const runs = new Map<string, HistoricalRun>();
  for (const event of events) {
    if (
      event.kind === "RUN_STATE" &&
      event.requestId &&
      event.cycleId &&
      event.agentId &&
      event.requestKind &&
      event.runState
    ) {
      runs.set(event.requestId, {
        requestId: event.requestId,
        cycleId: event.cycleId,
        agentId: event.agentId,
        requestKind: event.requestKind,
        state: event.runState,
        terminal: event.terminal,
        sequence: event.sequence,
      });
    }
  }
  for (const run of snapshot.runs) {
    runs.set(run.requestId, {
      requestId: run.requestId,
      cycleId: run.cycleId,
      agentId: run.agentId,
      requestKind: run.requestKind,
      state: run.state,
      terminal: ["COMPLETED", "FAILED", "INTERRUPTED"].includes(run.state)
        ? (run.state as Terminal)
        : null,
      sequence: runs.get(run.requestId)?.sequence ?? 0,
    });
  }
  return {
    roomId: page.roomId,
    cursor,
    events,
    runs: [...runs.values()],
    snapshot,
    gap: cursor < Math.max(page.nextCursor, snapshot.nextCursor),
  };
}
