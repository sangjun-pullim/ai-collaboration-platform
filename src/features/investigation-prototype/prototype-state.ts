import { exampleSetup, initialEvents, outboundText, replayEvents, resultProposal } from "./mock-scenario.ts";

export type Setup = typeof exampleSetup;
export type SetupErrors = Partial<Record<keyof Setup, string>>;
export type RunId = "a" | "b";
export type Outcome = "completed" | "failed" | "interrupted";
export type Run = { phase: "running" | "requested" | "acknowledged" | "unknown" | "terminal"; outcome?: Outcome };
export type SharedEvent = {
  id: number; kind: string; sender: string; owner: string; recipient: string; text: string;
  repository?: string; snapshot?: string; location?: string; confirmed: true;
};
export type PrivateExplanation = { id: number; question: string; answer: string; target: SharedEvent };
export type Decision = "해결" | "추가 조사" | "보류";
export type PrototypeState = {
  stage: "setup" | "room"; role: "participant" | "observer"; setup: Setup;
  errors: SetupErrors; shared: SharedEvent[];
  draft: { text: string; recipient: string; check: "pending" | "passed" } | null;
  privateHistory: PrivateExplanation[]; interventions: { text: string; status: "pending" | "applied" }[];
  pendingDirection: string | null; appliedDirection: string | null;
  runs: Record<RunId, Run>; pauseRequested: boolean; replayIndex: number;
  result: { fact: string; hypothesis: string; proposal: string; tasks: readonly { repository: string; owner: string; evidence: string; proposal: string; nextValidation: string }[]; validation: string } | null; decision: Decision | null;
  nextId: number; announcement: string;
};
export type Action =
  | { type: "create"; setup: Setup } | { type: "observe" }
  | { type: "speak"; text: string }
  | { type: "explain"; text: string; targetId: number }
  | { type: "publish-private"; explanationId: number; part: "question" | "answer" }
  | { type: "steer"; text: string }
  | { type: "check-draft" } | { type: "finalize-draft" }
  | { type: "stop-own" } | { type: "pause-room" }
  | { type: "ack"; run: RunId }
  | { type: "unknown"; run: RunId }
  | { type: "terminal"; run: RunId; outcome: Outcome }
  | { type: "replay-event" } | { type: "propose-result" }
  | { type: "decide"; decision: Decision };

export function validateSetup(setup: Setup): SetupErrors {
  const errors: SetupErrors = {};
  for (const key of ["goal", "symptom", "expected", "environment"] as const) {
    if (!setup[key].trim()) errors[key] = "조사에 필요한 내용을 입력해 주세요.";
  }
  if (setup.bindingA !== "repository-a") errors.bindingA = "예제 연결 A를 선택해 주세요.";
  if (setup.bindingB !== "repository-b") errors.bindingB = "예제 연결 B를 선택해 주세요.";
  if (!setup.scope.length || setup.scope.some((item) => !["code", "validation", "events"].includes(item))) {
    errors.scope = "공유할 예제 정보의 범위를 하나 이상 선택해 주세요.";
  }
  return errors;
}

export function initialState(): PrototypeState {
  return {
    stage: "setup", role: "participant", setup: { ...exampleSetup, scope: [...exampleSetup.scope] },
    errors: {}, shared: [], draft: null, privateHistory: [], interventions: [],
    pendingDirection: null, appliedDirection: null, runs: { a: { phase: "running" }, b: { phase: "running" } },
    pauseRequested: false, replayIndex: 0, result: null, decision: null,
    nextId: 1, announcement: "모의 체험을 준비해 주세요.",
  };
}

export function pauseStatus(state: PrototypeState): "active" | "waiting" | "complete" {
  if (!state.pauseRequested) return "active";
  return Object.values(state.runs).every((run) => run.phase === "terminal") ? "complete" : "waiting";
}

function addHumanEvent(state: PrototypeState, kind: string, text: string): PrototypeState {
  return {
    ...state, nextId: state.nextId + 1,
    shared: [...state.shared, { id: state.nextId, kind, sender: "사람", owner: "나 · 예제 개발자 A",
      recipient: "모든 참가자", text, confirmed: true }],
    announcement: `${kind}이 공동 기록에 추가되었습니다.`,
  };
}

function requestStop(run: Run): Run {
  return run.phase === "running" ? { phase: "requested" } : run;
}

function applyDirection(state: PrototypeState): PrototypeState {
  if (!state.pendingDirection || state.runs.a.phase !== "terminal") return state;
  return {
    ...state, appliedDirection: state.pendingDirection, pendingDirection: null,
    interventions: state.interventions.map((entry) => entry.status === "pending" ? { ...entry, status: "applied" } : entry),
    announcement: "내 AI의 종결을 모의 확인했습니다. 새 방향을 다음 조사에 적용했습니다.",
  };
}

function visibleEvent(event: Omit<SharedEvent, "id" | "confirmed">, scope: string[]): Omit<SharedEvent, "id" | "confirmed"> | null {
  if (event.kind === "근거" && !scope.includes(event.repository === "repository-a" ? "code" : "validation")) return null;
  if (!scope.includes("code")) {
    const { repository, snapshot, location, ...rest } = event;
    // Repository and snapshot metadata remain visible; source locations require code sharing.
    return { ...rest, repository, snapshot, ...(location && scope.includes("code") ? { location } : {}) };
  }
  return event;
}

export function prototypeReducer(state: PrototypeState, action: Action): PrototypeState {
  if (state.stage === "setup") {
    if (action.type !== "create" && action.type !== "observe") return state;
    const setup = action.type === "create" ? action.setup : { ...exampleSetup, scope: [...exampleSetup.scope] };
    const errors = validateSetup(setup);
    if (Object.keys(errors).length) return { ...state, errors, announcement: "입력 내용을 확인해 주세요." };
    const events = initialEvents.map((event) => visibleEvent(event, setup.scope)).filter((event) => event !== null);
    return {
      ...state, stage: "room", role: action.type === "observe" ? "observer" : "participant", setup, errors: {},
      shared: events.map((event, i) => ({ ...event, id: i + 1, confirmed: true })),
      nextId: events.length + 1,
      draft: action.type === "observe" ? null : { text: outboundText, recipient: "AI B · repository-b", check: "pending" },
      announcement: action.type === "observe" ? "관찰 체험에 들어왔습니다. 실제 연결은 없습니다." : "모의 조사방을 만들었습니다.",
    };
  }
  if (state.role === "observer") return state;
  switch (action.type) {
    case "speak":
      return action.text.trim() ? addHumanEvent(state, "공동 발언", action.text.trim()) : state;
    case "explain": {
      const target = state.shared.find((event) => event.id === action.targetId);
      if (!target || !action.text.trim()) return state;
      return {
        ...state, nextId: state.nextId + 1,
        privateHistory: [...state.privateHistory, {
          id: state.nextId, question: action.text.trim(), target: { ...target },
          answer: `선택한 기록 “${target.text}”을 기준으로 설명합니다. 응답 접수와 실제 상태 갱신은 다른 시점일 수 있습니다. 모의 설명이며 추가 실행은 없습니다.`,
        }], announcement: "개인 설명이 추가되었습니다. 나에게만 보입니다.",
      };
    }
    case "publish-private": {
      const entry = state.privateHistory.find((item) => item.id === action.explanationId);
      return entry ? addHumanEvent(state, "공동 발언", entry[action.part]) : state;
    }
    case "steer":
      if (!action.text.trim() || state.pendingDirection) return state;
      return applyDirection({
        ...addHumanEvent(state, "방향 수정", action.text.trim()),
        interventions: [...state.interventions, { text: action.text.trim(), status: "pending" }],
        pendingDirection: action.text.trim(), runs: { ...state.runs, a: requestStop(state.runs.a) },
        announcement: "방향 수정을 공개했습니다. 내 AI의 종결 확인을 기다립니다.",
      });
    case "check-draft":
      return state.draft && state.draft.check === "pending" ? {
        ...state, draft: { ...state.draft, check: "passed" }, announcement: "모의 공개 검사를 마쳤습니다. 아직 공동 기록에 공개되지 않았습니다.",
      } : state;
    case "finalize-draft":
      return state.draft?.check === "passed" ? {
        ...state, draft: null, nextId: state.nextId + 1,
        shared: [...state.shared, { id: state.nextId, kind: "답변", sender: "AI A", owner: "예제 개발자 A",
          recipient: state.draft.recipient, text: state.draft.text, confirmed: true }],
        announcement: "확정된 발신 초안을 공동 기록에 공개했습니다.",
      } : state;
    case "stop-own":
      return { ...state, runs: { ...state.runs, a: requestStop(state.runs.a) }, announcement: "내 AI에만 정지를 요청했습니다." };
    case "pause-room":
      return { ...state, pauseRequested: true, runs: { a: requestStop(state.runs.a), b: requestStop(state.runs.b) },
        announcement: "두 예제 실행에 정지를 요청했습니다. 종결은 아직 확인되지 않았습니다." };
    case "ack":
      if (!["requested", "unknown"].includes(state.runs[action.run].phase)) return state;
      return { ...state, runs: { ...state.runs, [action.run]: { phase: "acknowledged" } },
        announcement: `AI ${action.run.toUpperCase()}의 connector가 모의 정지 요청을 확인했습니다. 종결 확인이 필요합니다.` };
    case "unknown":
      if (!["requested", "acknowledged"].includes(state.runs[action.run].phase)) return state;
      return { ...state, runs: { ...state.runs, [action.run]: { phase: "unknown" } },
        announcement: `AI ${action.run.toUpperCase()} offline · UNKNOWN. 실행 종결 확인이 필요합니다.` };
    case "terminal":
      if (!["requested", "acknowledged", "unknown"].includes(state.runs[action.run].phase)) return state;
      return applyDirection({ ...state, runs: { ...state.runs, [action.run]: { phase: "terminal", outcome: action.outcome } },
        announcement: `AI ${action.run.toUpperCase()}의 모의 실행 종결을 확인했습니다.` });
    case "replay-event": {
      if (state.pauseRequested || Object.values(state.runs).some((run) => run.phase !== "running")) return state;
      const event = replayEvents[state.replayIndex];
      if (!event) return state;
      const visible = visibleEvent(event, state.setup.scope);
      return { ...state, replayIndex: state.replayIndex + 1,
        ...(visible ? { nextId: state.nextId + 1, shared: [...state.shared, { ...visible, id: state.nextId, confirmed: true }] } : {}),
        announcement: visible ? "새 모의 공동 기록을 재생했습니다." : "선택한 공유 범위 밖의 모의 근거는 공개하지 않았습니다.",
      };
    }
    case "propose-result":
      return state.result ? state : { ...state, result: { ...resultProposal, tasks: resultProposal.tasks.map((task) => ({ ...task, evidence: state.setup.scope.includes("code") ? task.evidence : "코드 위치 공유 안 함 · 예제 snapshot" })) }, announcement: "모의 결과 초안이 준비되었습니다. 사람의 판단이 필요합니다." };
    case "decide":
      return state.result ? { ...addHumanEvent(state, "사람 결정", action.decision), decision: action.decision } : state;
    default:
      return state;
  }
}
