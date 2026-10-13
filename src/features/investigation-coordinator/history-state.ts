import {
  WorkflowError,
  type RecoveryHistoryPage,
  type Retirement,
  type HistoryPage,
  type PublicEvent,
  type RunState,
  type RequestKind,
  type Terminal,
} from "./contracts.ts";

export interface HistoricalRun {
  requestId: string;
  cycleId: string;
  agentId: string;
  requestKind: RequestKind;
  bindingEpoch?: number;
  ownerAlias?: string;
  sessionAlias?: string;
  updatedAt?: string;
  state: RunState;
  terminal: Terminal | null;
  sequence: number;
}
export interface HistoryState {
  roomId: string;
  cursor: number;
  retirementCursor: number;
  retirements: Retirement[];
  events: PublicEvent[];
  runs: HistoricalRun[];
  snapshot: HistoryPage | null;
  gap: boolean;
}
export function emptyHistory(roomId: string): HistoryState {
  return {
    roomId,
    cursor: 0,
    retirementCursor: 0,
    retirements: [],
    events: [],
    runs: [],
    snapshot: null,
    gap: false,
  };
}
export function recordRetirements(state: HistoryState, entries: Retirement[]): HistoryState {
  const retirements = new Map(state.retirements.map((entry) => [entry.requestId, entry]));
  const sequences = new Map(state.retirements.map((entry) => [entry.sequence, entry.requestId]));
  const knownRuns = new Map(state.runs.map((run) => [run.requestId, run]));
  for (const entry of entries) {
    const previous = retirements.get(entry.requestId);
    const known = knownRuns.get(entry.requestId);
    if (
      (known &&
        (known.cycleId !== entry.cycleId ||
          known.agentId !== entry.agentId ||
          (known.bindingEpoch !== undefined && known.bindingEpoch !== entry.bindingEpoch))) ||
      state.events.some(
        (event) =>
          event.requestId === entry.requestId &&
          (event.roomId !== state.roomId ||
            event.cycleId !== entry.cycleId ||
            event.agentId !== entry.agentId ||
            event.bindingEpoch !== entry.bindingEpoch),
      ) ||
      (sequences.has(entry.sequence) && sequences.get(entry.sequence) !== entry.requestId) ||
      (previous &&
        (previous.sequence !== entry.sequence ||
          previous.cycleId !== entry.cycleId ||
          previous.agentId !== entry.agentId ||
          previous.bindingEpoch !== entry.bindingEpoch ||
          previous.retiredAt !== entry.retiredAt))
    )
      throw new WorkflowError("UNAVAILABLE");
    retirements.set(entry.requestId, entry);
    sequences.set(entry.sequence, entry.requestId);
  }
  return {
    ...state,
    retirements: [...retirements.values()].sort((a, b) => a.sequence - b.sequence),
  };
}
export function recoverySnapshot(state: HistoryState): RecoveryHistoryPage | null {
  return state.snapshot && "recovery" in state.snapshot
    ? (state.snapshot as RecoveryHistoryPage)
    : null;
}
export function mergeHistory(state: HistoryState, page: HistoryPage): HistoryState {
  if (page.roomId !== state.roomId) state = emptyHistory(page.roomId);
  if ("recovery" in page) {
    const recovery = (page as RecoveryHistoryPage).recovery;
    state = recordRetirements(state, recovery.retirements);
    state = {
      ...state,
      retirementCursor: Math.max(state.retirementCursor, recovery.nextRetirementCursor),
    };
  }
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
  const runs = new Map<string, HistoricalRun>(state.runs.map((run) => [run.requestId, run]));
  for (const event of events) {
    if (
      event.kind === "RUN_STATE" &&
      event.requestId &&
      event.cycleId &&
      event.agentId &&
      event.requestKind &&
      event.runState &&
      event.sequence > (runs.get(event.requestId)?.sequence ?? -1)
    ) {
      runs.set(event.requestId, {
        requestId: event.requestId,
        cycleId: event.cycleId,
        agentId: event.agentId,
        requestKind: event.requestKind,
        bindingEpoch: event.bindingEpoch ?? undefined,
        updatedAt: event.createdAt,
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
      bindingEpoch: run.bindingEpoch,
      ownerAlias: run.ownerAlias,
      sessionAlias: run.sessionAlias,
      updatedAt: run.updatedAt,
      state: run.state,
      terminal: ["COMPLETED", "FAILED", "INTERRUPTED"].includes(run.state)
        ? (run.state as Terminal)
        : null,
      // Preserve the observation boundary when a summary later leaves the latest 32.
      sequence: Math.max(runs.get(run.requestId)?.sequence ?? 0, snapshot.highWaterSequence),
    });
  }
  return {
    roomId: page.roomId,
    cursor,
    retirementCursor: state.retirementCursor,
    retirements: state.retirements,
    events,
    runs: [...runs.values()],
    snapshot,
    gap: cursor < Math.max(page.nextCursor, snapshot.nextCursor),
  };
}
