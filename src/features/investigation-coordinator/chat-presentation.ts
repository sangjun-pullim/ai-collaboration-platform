import type { PublicBinding, PublicEvent, RunSummary } from "./contracts.ts";
import type { SourceTarget } from "./source-contracts.ts";
import type { HistoricalRun } from "./history-state.ts";

function answerIdentity(event: PublicEvent) {
  if (
    event.kind !== "ANSWER" ||
    !event.requestId ||
    !event.questionId ||
    !event.agentId ||
    event.bindingEpoch === null
  )
    return null;
  return [event.roomId, event.requestId, event.questionId, event.agentId, event.bindingEpoch].join(
    ":",
  );
}

// Adoption updates remain in the audit history but update one chat answer.
export function timelineEvents(events: PublicEvent[]) {
  const latest = new Map<string, PublicEvent>();
  for (const event of events) {
    const identity = answerIdentity(event);
    if (identity && (!latest.has(identity) || latest.get(identity)!.sequence < event.sequence))
      latest.set(identity, event);
  }
  return events.filter((event) => {
    if (event.kind === "RUN_STATE") return false;
    const identity = answerIdentity(event);
    return !identity || latest.get(identity) === event;
  });
}

// Historical identity comes only from persisted events/runs, never current aliases.
export function eventTarget(
  event: PublicEvent,
  runs: RunSummary[],
  bindings: PublicBinding[],
  historicalRuns: HistoricalRun[] = [],
  snapshot: SourceTarget | null = null,
) {
  if (snapshot)
    return {
      agentId: snapshot.agentId,
      epoch: snapshot.bindingEpoch,
      savedAlias: `${snapshot.ownerAlias} · ${snapshot.sessionAlias}`,
      current: bindings.find(
        (binding) =>
          binding.agentId === snapshot.agentId && binding.bindingEpoch === snapshot.bindingEpoch,
      ),
      state: historicalRuns.find((run) => run.requestId === snapshot.requestId)?.state,
    };
  // An agent question's event identity belongs to the origin, not the recipient.
  if (event.kind === "QUESTION" && event.senderKind === "AGENT") return null;
  const run = runs.find((run) =>
    event.requestId
      ? run.requestId === event.requestId
      : !!event.questionId && run.questionId === event.questionId,
  );
  const agentId = event.agentId ?? run?.agentId;
  const epoch = event.bindingEpoch ?? run?.bindingEpoch;
  if (!agentId || epoch === undefined || epoch === null) return null;
  const current = bindings.find(
    (binding) => binding.agentId === agentId && binding.bindingEpoch === epoch,
  );
  return {
    agentId,
    epoch,
    savedAlias: run ? `${run.ownerAlias} · ${run.sessionAlias}` : null,
    current,
    state: run?.state ?? historicalRuns.find((run) => run.requestId === event.requestId)?.state,
  };
}
export function shouldSendOnEnter(
  key: string,
  shiftKey: boolean,
  isComposing: boolean,
  keyCode: number,
) {
  return key === "Enter" && !shiftKey && !isComposing && keyCode !== 229;
}
export function nearTimelineBottom(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - scrollTop - clientHeight < 64;
}

export function questionForReply(event: PublicEvent, events: PublicEvent[]) {
  if (event.kind !== "ANSWER") return null;
  return (
    events.find(
      (other) =>
        other.kind === "QUESTION" &&
        (other.eventId === event.replyTo ||
          other.questionId === event.replyTo ||
          (!!event.questionId && other.questionId === event.questionId)),
    ) ?? null
  );
}
