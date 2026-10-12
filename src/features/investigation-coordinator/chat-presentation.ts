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

export interface AnswerStatusContext {
  events: PublicEvent[];
  runs: RunSummary[];
  historicalRuns?: HistoricalRun[];
  bindings: PublicBinding[];
  cycle: import("./contracts.ts").HistoryPage["cycle"];
  observedAt: number;
  now?: number;
  pollError?: string | null;
  gap?: boolean;
  role?: "owner" | "participant" | "observer";
  cancelReceipts?: import("./room-chat-controller.ts").CancelReceipt[];
}
export interface AnswerStatus {
  requestId: string;
  cycleId: string;
  agentId: string;
  epoch: number | null;
  state: RunSummary["state"];
  label: string;
  target: string;
  question: PublicEvent | null;
  spinning: boolean;
  freshness: string | null;
  ownConnection: boolean;
  guidance: string;
  detail: string;
  updatedAt: string | null;
  interruptStage: "REQUESTED" | "ACKNOWLEDGED" | null;
  cancelReceiptState: "REQUESTED" | "NO_ACTIVE_RUN" | null;
}
const answerLabels: Record<RunSummary["state"], string> = {
  QUEUED: "질문 접수 · AI 응답 대기",
  LEASED: "답변 준비 중",
  RUNNING: "답변 생성 중",
  COMPLETED: "답변 완료",
  FAILED: "답변 실패",
  INTERRUPTED: "중단 확인",
  CANCELLED: "시작 전 취소",
  UNKNOWN: "실행 결과 확인 필요",
};
const answerDetails: Record<RunSummary["state"], string> = {
  QUEUED: "질문이 접수되었습니다. 대상 AI의 응답을 기다립니다.",
  LEASED: "대상 AI의 로컬 연결 프로그램이 답변 준비를 보고했습니다.",
  RUNNING: "대상 AI의 로컬 실행 시작이 보고되었습니다.",
  COMPLETED: "답변 실행의 완료가 보고되었습니다. 공개 답변과 채택 여부는 대화 기록에서 확인하세요.",
  FAILED: "답변 실행의 실패가 보고되었습니다.",
  INTERRUPTED: "답변 실행의 중단이 확인되었습니다.",
  CANCELLED: "답변 실행을 시작하기 전에 취소되었습니다.",
  UNKNOWN: "실행 결과가 확인되지 않았습니다. 성공이나 중단이 확인되지 않은 상태입니다.",
};

type RequestEvidence = {
  summary?: RunSummary;
  historical?: HistoricalRun;
  cycleId: string;
  agentId: string;
  epoch: number | null;
  reports: PublicEvent[];
  interrupts: PublicEvent[];
  acknowledgements: PublicEvent[];
  sender: PublicEvent | null;
  question: PublicEvent | null;
};
type EvidenceIndex = ReturnType<typeof indexEvidence>;

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}
function uniqueEvent(map: Map<string, PublicEvent | null>, key: string, event: PublicEvent) {
  map.set(key, map.has(key) ? null : event);
}
function bindingKey(agentId: string, epoch: number | null) {
  return `${agentId}:${epoch}`;
}

// SQL007 device(question) holds lock_room, then reserve_006 emits QUEUED immediately
// before QUESTION. SQL011/013 overlays add no public events between these writes.
function reservedQuestion(
  events: PublicEvent[],
  summary: RunSummary | undefined,
  historical: HistoricalRun | undefined,
  index: {
    sequences: Map<string, PublicEvent | null>;
    eventIds: Map<string, PublicEvent | null>;
    questions: Map<string, PublicEvent | null>;
    conflicts: Set<string>;
    gap: boolean;
  },
) {
  const reservation = events[0];
  if (
    index.gap ||
    !reservation ||
    reservation.kind !== "RUN_STATE" ||
    reservation.runState !== "QUEUED" ||
    reservation.senderKind !== "AGENT" ||
    reservation.requestKind !== "PEER" ||
    !reservation.requestId ||
    !reservation.agentId ||
    !reservation.cycleId ||
    !reservation.bindingEpoch ||
    reservation.questionId !== null ||
    index.conflicts.has(reservation.requestId)
  )
    return null;
  const question = index.sequences.get(`${reservation.roomId}:${reservation.sequence + 1}`);
  if (
    !question ||
    index.sequences.get(`${reservation.roomId}:${reservation.sequence}`) !== reservation ||
    index.eventIds.get(reservation.eventId) !== reservation ||
    index.eventIds.get(question.eventId) !== question ||
    question.kind !== "QUESTION" ||
    question.senderKind !== "AGENT" ||
    !["ORIGIN", "CONTINUATION", "RESUME"].includes(question.requestKind ?? "") ||
    question.roomId !== reservation.roomId ||
    question.cycleId !== reservation.cycleId ||
    question.roomRevision !== reservation.roomRevision ||
    !question.questionId ||
    !question.requestId ||
    question.requestId === reservation.requestId ||
    !question.agentId ||
    question.agentId === reservation.agentId ||
    !question.bindingEpoch ||
    index.conflicts.has(question.requestId) ||
    index.questions.get(question.questionId) !== question
  )
    return null;
  if (
    (summary &&
      (summary.cycleId !== reservation.cycleId ||
        summary.agentId !== reservation.agentId ||
        summary.bindingEpoch !== reservation.bindingEpoch ||
        summary.requestKind !== "PEER" ||
        (summary.questionId !== null && summary.questionId !== question.questionId))) ||
    (historical &&
      (historical.cycleId !== reservation.cycleId ||
        historical.agentId !== reservation.agentId ||
        historical.requestKind !== "PEER"))
  )
    return null;
  return question;
}

function indexEvidence(context: AnswerStatusContext) {
  const summaries = new Map(context.runs.map((run) => [run.requestId, run]));
  const historical = new Map((context.historicalRuns ?? []).map((run) => [run.requestId, run]));
  const byRequest = new Map<string, PublicEvent[]>();
  const questions = new Map<string, PublicEvent | null>();
  const questionsByCycle = new Map<string, PublicEvent | null>();
  const sequences = new Map<string, PublicEvent | null>();
  const eventIds = new Map<string, PublicEvent | null>();
  const humanEvents: PublicEvent[] = [];
  const conflicts = new Set<string>();
  const identities = new Map<string, string>();
  const requestIds = new Set([...summaries.keys(), ...historical.keys()]);
  for (const event of context.events) {
    uniqueEvent(sequences, `${event.roomId}:${event.sequence}`, event);
    uniqueEvent(eventIds, event.eventId, event);
    if (event.kind === "QUESTION" && event.questionId) {
      uniqueEvent(questions, event.questionId, event);
      uniqueEvent(questionsByCycle, `${event.cycleId}:${event.questionId}`, event);
    }
    if (event.kind === "HUMAN_INPUT_REQUIRED") humanEvents.push(event);
    if (event.requestId) {
      append(byRequest, event.requestId, event);
      const identity = [
        event.roomId,
        event.cycleId,
        event.agentId,
        event.bindingEpoch,
        event.roomRevision,
        event.requestKind,
      ].join(":");
      const previous = identities.get(event.requestId);
      if (previous && previous !== identity) conflicts.add(event.requestId);
      else identities.set(event.requestId, identity);
      if (event.kind === "RUN_STATE") requestIds.add(event.requestId);
    }
  }
  for (const summary of context.runs) {
    const chosen = summaries.get(summary.requestId)!;
    const first = byRequest.get(summary.requestId)?.[0];
    if (
      chosen.cycleId !== summary.cycleId ||
      chosen.agentId !== summary.agentId ||
      chosen.bindingEpoch !== summary.bindingEpoch ||
      chosen.roomRevision !== summary.roomRevision ||
      chosen.requestKind !== summary.requestKind ||
      chosen.questionId !== summary.questionId ||
      (first &&
        (first.cycleId !== summary.cycleId ||
          first.agentId !== summary.agentId ||
          first.bindingEpoch !== summary.bindingEpoch ||
          first.roomRevision !== summary.roomRevision ||
          first.requestKind !== summary.requestKind))
    )
      conflicts.add(summary.requestId);
  }
  for (const saved of context.historicalRuns ?? []) {
    const chosen = historical.get(saved.requestId)!;
    const first = byRequest.get(saved.requestId)?.[0];
    if (
      chosen.cycleId !== saved.cycleId ||
      chosen.agentId !== saved.agentId ||
      chosen.requestKind !== saved.requestKind ||
      (first &&
        (first.cycleId !== saved.cycleId ||
          first.agentId !== saved.agentId ||
          first.requestKind !== saved.requestKind))
    )
      conflicts.add(saved.requestId);
  }
  const requests = new Map<string, RequestEvidence>();
  const byCycle = new Map<string, string[]>();
  for (const requestId of requestIds) {
    const summary = summaries.get(requestId);
    const saved = historical.get(requestId);
    const events = (byRequest.get(requestId) ?? []).sort((a, b) => a.sequence - b.sequence);
    const reports = events.filter(
      (event) =>
        event.kind === "RUN_STATE" &&
        event.runState &&
        (!summary ||
          (event.cycleId === summary.cycleId &&
            event.agentId === summary.agentId &&
            event.bindingEpoch === summary.bindingEpoch)) &&
        (!saved || (event.cycleId === saved.cycleId && event.agentId === saved.agentId)),
    );
    const report = reports.at(-1);
    const cycleId = summary?.cycleId ?? saved?.cycleId ?? report?.cycleId;
    const agentId = summary?.agentId ?? saved?.agentId ?? report?.agentId;
    if (!cycleId || !agentId) continue;
    const identity = events.find(
      (event) =>
        event.cycleId === cycleId &&
        event.agentId === agentId &&
        (event.kind === "ANSWER" || (event.kind === "QUESTION" && event.senderKind === "HUMAN")),
    );
    const epoch = summary?.bindingEpoch ?? report?.bindingEpoch ?? identity?.bindingEpoch ?? null;
    const matching = events.filter(
      (event) =>
        event.cycleId === cycleId && event.agentId === agentId && event.bindingEpoch === epoch,
    );
    const associated = matching.find(
      (event) =>
        event.kind === "ANSWER" || (event.kind === "QUESTION" && event.senderKind === "HUMAN"),
    );
    const requestKind = summary?.requestKind ?? saved?.requestKind ?? report?.requestKind ?? "";
    const questionId = summary?.questionId ?? associated?.questionId;
    const savedQuestion = questionId ? questionsByCycle.get(`${cycleId}:${questionId}`) : null;
    let question =
      savedQuestion &&
      (!(report ?? associated) || savedQuestion.roomId === (report ?? associated)!.roomId) &&
      (savedQuestion.senderKind === "HUMAN"
        ? savedQuestion.requestId === requestId &&
          savedQuestion.agentId === agentId &&
          savedQuestion.bindingEpoch === epoch
        : savedQuestion.senderKind === "AGENT" && requestKind === "PEER")
        ? savedQuestion
        : null;
    if (!question && !questionId)
      question = reservedQuestion(events, summary, saved, {
        sequences,
        eventIds,
        questions,
        conflicts,
        gap: !!context.gap,
      });
    requests.set(requestId, {
      summary,
      historical: saved,
      cycleId,
      agentId,
      epoch,
      reports,
      interrupts: matching.filter((event) =>
        ["INTERRUPT_REQUESTED", "INTERRUPT_ACKNOWLEDGED"].includes(event.kind),
      ),
      acknowledgements: matching.filter((event) => event.kind === "INTERRUPT_ACKNOWLEDGED"),
      sender: matching.find((event) => event.senderKind === "AGENT") ?? null,
      question,
    });
    append(byCycle, cycleId, requestId);
  }
  return {
    requests,
    byCycle,
    humanEvents,
    cancelReceipts: new Map(
      (context.cancelReceipts ?? []).map((receipt) => [receipt.requestId, receipt]),
    ),
    owned: new Set(
      context.bindings
        .filter((binding) => binding.owned)
        .map((binding) => bindingKey(binding.agentId, binding.bindingEpoch)),
    ),
  };
}

// The arrays are indexed once. Historical notices query their own cycle and use
// sequence bounds, so they never rescan the full room history for each record.
function reportBefore(events: PublicEvent[], sequence: number) {
  let low = 0,
    high = events.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (events[mid].sequence <= sequence) low = mid + 1;
    else high = mid;
  }
  return low ? events[low - 1] : undefined;
}
function projectStatus(
  requestId: string,
  run: RequestEvidence,
  context: AnswerStatusContext,
  index: EvidenceIndex,
  fresh: boolean,
  at?: PublicEvent,
): AnswerStatus | null {
  const { summary, historical, cycleId, agentId, epoch } = run;
  const report = at ? reportBefore(run.reports, at.sequence) : run.reports.at(-1);
  const eligibleSummary =
    !at || (summary && Date.parse(summary.updatedAt) < Date.parse(at.createdAt));
  const useReport =
    !!report &&
    (!!at ||
      (summary
        ? Date.parse(report.createdAt) > Date.parse(summary.updatedAt)
        : !historical || report.sequence > historical.sequence));
  const state = useReport
    ? report.runState
    : eligibleSummary
      ? (summary?.state ?? (!at ? historical?.state : null) ?? report?.runState)
      : null;
  if (!state) return null;
  const ownConnection =
    (context.role === "owner" || context.role === "participant") &&
    index.owned.has(bindingKey(agentId, epoch));
  const terminal = ["COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"].includes(state);
  const savedReceipt = !at && !terminal ? index.cancelReceipts.get(requestId) : undefined;
  const cancelReceiptState =
    savedReceipt &&
    savedReceipt.cycleId === cycleId &&
    savedReceipt.agentId === agentId &&
    savedReceipt.epoch === epoch
      ? savedReceipt.state
      : null;
  // Once the target acknowledges, repeated server requests cannot downgrade that evidence.
  const interrupt = at ? reportBefore(run.interrupts, at.sequence) : run.interrupts.at(-1);
  const acknowledgement = at
    ? reportBefore(run.acknowledgements, at.sequence)
    : run.acknowledgements.at(-1);
  const interruptStage = terminal
    ? null
    : acknowledgement
      ? "ACKNOWLEDGED"
      : interrupt || cancelReceiptState === "REQUESTED"
        ? "REQUESTED"
        : null;
  const interruptPending = interruptStage !== null;
  const needsCheck =
    state === "UNKNOWN" ||
    ["FAILED", "INTERRUPTED", "CANCELLED"].includes(state) ||
    interruptPending ||
    cancelReceiptState === "NO_ACTIVE_RUN";
  const check = ownConnection
    ? "내 Mac의 기존 AI 연결 터미널과 로컬 실행 기록을 확인하세요."
    : "대상 AI 소유자에게 Mac의 기존 AI 연결 터미널과 로컬 실행 기록을 확인해 달라고 요청하세요.";
  const retry =
    context.role === "observer"
      ? " 이전 실행이 끝났습니다. 답변이 필요하면 질문 가능한 참가자에게 새 질문을 명시적으로 보내 달라고 요청하세요."
      : " 이전 실행이 끝났습니다. 다시 답변이 필요하면 새 질문을 명시적으로 보내세요.";
  const guidance = at
    ? `${check} 같은 질문의 현재 답변 상태도 확인하세요.`
    : needsCheck
      ? `${check}${terminal ? retry : " 실행 종료가 확인될 때까지 같은 질문을 다시 보내지 마세요."}`
      : "";
  const sender = run.sender && (!at || run.sender.sequence <= at.sequence) ? run.sender : null;
  const target = summary
    ? `${summary.ownerAlias} · ${summary.sessionAlias}`
    : sender
      ? `소유자 이름 미기록 · ${sender.senderAlias}`
      : "대상 AI 이름 미기록";
  const question =
    run.question && (!at || run.question.sequence <= at.sequence) ? run.question : null;
  const cycle = context.cycle;
  const currentTarget =
    cycle?.cycleId === cycleId &&
    ("mode" in cycle
      ? cycle.targetAgentId === agentId && cycle.targetEpoch === epoch
      : (cycle.originAgentId === agentId && cycle.originEpoch === epoch) ||
        (cycle.peerAgentId === agentId && cycle.peerEpoch === epoch));
  return {
    requestId,
    cycleId,
    agentId,
    epoch,
    state,
    target,
    question,
    ownConnection,
    interruptStage,
    cancelReceiptState,
    guidance,
    label: interruptPending
      ? state === "UNKNOWN"
        ? interruptStage === "ACKNOWLEDGED"
          ? "중단 수신 확인 · 종료 확인 대기"
          : "중단 요청 접수 · 종료 확인 대기"
        : "중단 요청 중 · 종료 확인 대기"
      : answerLabels[state],
    detail: `${answerDetails[state]}${
      interruptPending
        ? `${interruptStage === "ACKNOWLEDGED" ? " 대상 Mac이 중단 요청 수신을 확인했습니다." : " 서버가 중단 요청을 접수했습니다. 대상 Mac의 수신 확인을 기다립니다."} 중단 요청의 수신 확인은 실제 실행 종료를 뜻하지 않습니다. 연결이 끊겼거나 연결이 바뀐 대상은 소유자가 기존 AI 연결 터미널에서 실제 종료를 확인하고 종료 상태를 보고해야 합니다.`
        : cancelReceiptState === "NO_ACTIVE_RUN"
          ? " 서버가 중단할 활성 실행이 없다고 응답했습니다. 이 응답만으로 기존 답변 실행의 종료 상태를 확정하지 않습니다."
          : ""
    }`,
    spinning:
      !at &&
      fresh &&
      currentTarget &&
      !interruptPending &&
      cancelReceiptState !== "NO_ACTIVE_RUN" &&
      ["QUEUED", "LEASED", "RUNNING"].includes(state),
    freshness: !at && fresh ? null : "상태 갱신 지연/확인 불가",
    updatedAt: useReport
      ? report.createdAt
      : (summary?.updatedAt ?? (report?.runState === state ? report.createdAt : null)),
  };
}
function noticeFromIndex(event: PublicEvent, context: AnswerStatusContext, index: EvidenceIndex) {
  const statuses: AnswerStatus[] = [];
  for (const requestId of index.byCycle.get(event.cycleId ?? "") ?? []) {
    const status = projectStatus(
      requestId,
      index.requests.get(requestId)!,
      context,
      index,
      false,
      event,
    );
    if (status) statuses.push(status);
  }
  const cycle = context.cycle?.cycleId === event.cycleId ? context.cycle : null;
  const deadline =
    cycle && Date.parse(cycle.deadline) <= Date.parse(event.createdAt)
      ? " 이 기록 시점에는 같은 조사의 기한이 지났습니다."
      : "";
  const budgets =
    cycle && !("mode" in cycle) && (cycle.runsReserved >= 11 || cycle.peerRoundsReserved >= 5)
      ? ` 현재 같은 조사의 예약은 실행 ${cycle.runsReserved}/11회, AI 간 질문 ${cycle.peerRoundsReserved}/5회입니다.`
      : "";
  return {
    explanation: `자동 진행에 사람의 확인이 필요합니다. 정확한 사유는 기록되지 않았습니다.${deadline}${budgets} 아래 당시 실행 상태와 같은 질문의 답변 상태를 확인하세요.`,
    guidance:
      "대상 AI 소유자에게 Mac의 기존 AI 연결 터미널과 로컬 실행 기록을 확인해 달라고 요청하세요.",
    statuses,
  };
}

export function answerStatuses(context: AnswerStatusContext) {
  const index = indexEvidence(context);
  // Read the clock only when an existing render asks for presentation; polling owns updates.
  const now = context.now ?? Date.now();
  const fresh =
    !context.pollError &&
    !context.gap &&
    Number.isFinite(context.observedAt) &&
    context.observedAt > 0 &&
    Number.isFinite(now) &&
    now >= context.observedAt &&
    now - context.observedAt <= 35_000;
  const statuses: AnswerStatus[] = [];
  const byQuestion = new Map<string, AnswerStatus[]>();
  for (const [requestId, run] of index.requests) {
    const status = projectStatus(requestId, run, context, index, fresh);
    if (!status) continue;
    statuses.push(status);
    if (status.question) append(byQuestion, status.question.eventId, status);
  }
  const notices = new Map(
    index.humanEvents.map((event) => [event.eventId, noticeFromIndex(event, context, index)]),
  );
  return { statuses, byQuestion, notices };
}

export function humanInputNotice(event: PublicEvent, context: AnswerStatusContext) {
  return noticeFromIndex(event, context, indexEvidence(context));
}
