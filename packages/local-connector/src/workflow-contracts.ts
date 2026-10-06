export const humanActions = [
  "read",
  "input-state",
  "input-control",
  "speak",
  "start",
  "interrupt",
  "pause",
  "resume",
  "ask",
  "cancel",
] as const;
export const deviceActions = [
  "ready",
  "admission",
  "admission-ack",
  "poll",
  "claim",
  "start-intent",
  "lease",
  "question",
  "complete",
  "interrupt-ack",
  "observe",
] as const;
export type HumanAction = (typeof humanActions)[number];
export type DeviceAction = (typeof deviceActions)[number];
export type Action = HumanAction | DeviceAction;
export const errorStatus = {
  INVALID_BODY: 400,
  BODY_TOO_LARGE: 400,
  UNSAFE_ORIGIN: 403,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INPUT_PAUSED: 409,
  QUOTA: 429,
  UNAVAILABLE: 503,
} as const;
export type ErrorCode = keyof typeof errorStatus;
export class WorkflowError extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
export const roomModes = ["ACTIVE", "PAUSING", "PAUSED"] as const;
export const cycleStates = ["ACTIVE", "COMPLETED", "HUMAN_INPUT_REQUIRED", "CANCELLED"] as const;
export const runStates = [
  "QUEUED",
  "LEASED",
  "RUNNING",
  "UNKNOWN",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "CANCELLED",
] as const;
export const attemptStates = [
  "LEASED",
  "EXECUTING",
  "UNKNOWN",
  "COMPLETED",
  "FAILED",
  "INTERRUPTED",
  "ABANDONED",
] as const;
export const terminals = ["COMPLETED", "FAILED", "INTERRUPTED"] as const;
export const requestKinds = ["ORIGIN", "PEER", "CONTINUATION", "RESUME"] as const;
export const adoptions = [
  "NONE",
  "PENDING",
  "ACCEPTED",
  "HISTORICAL",
  "HUMAN_INPUT_REQUIRED",
] as const;
export const eventKinds = [
  "SPEECH",
  "INVESTIGATION_STARTED",
  "QUESTION",
  "ANSWER",
  "RUN_STATE",
  "INTERRUPT_REQUESTED",
  "INTERRUPT_ACKNOWLEDGED",
  "ROOM_PAUSE_REQUESTED",
  "ROOM_PAUSED",
  "ROOM_RESUMED",
  "INVESTIGATION_RESUMED",
  "HUMAN_INPUT_REQUIRED",
] as const;
export type RoomMode = (typeof roomModes)[number];
export type CycleState = (typeof cycleStates)[number];
export type RunState = (typeof runStates)[number];
export type Terminal = (typeof terminals)[number];
export type RequestKind = (typeof requestKinds)[number];
export type Adoption = (typeof adoptions)[number];
export type Body = Record<string, string | number | boolean>;
export interface PublicEvent {
  eventId: string;
  roomId: string;
  sequence: number;
  createdAt: string;
  kind: (typeof eventKinds)[number];
  senderKind: "HUMAN" | "AGENT" | "SYSTEM";
  senderAlias: string;
  publicText: string;
  cycleId: string | null;
  requestId: string | null;
  questionId: string | null;
  replyTo: string | null;
  roomRevision: number;
  bindingEpoch: number | null;
  agentId: string | null;
  requestKind: RequestKind | null;
  runState: RunState | null;
  terminal: Terminal | null;
  roomMode: RoomMode | null;
  adoption: Adoption;
}
export interface RunSummary {
  requestId: string;
  cycleId: string;
  agentId: string;
  ownerAlias: string;
  sessionAlias: string;
  requestKind: RequestKind;
  roomRevision: number;
  bindingEpoch: number;
  state: RunState;
  questionId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface PublicBinding {
  agentId: string;
  ownerAlias: string;
  sessionAlias: string;
  repositoryAlias: string;
  runtime: "codex" | "claude";
  bindingEpoch: number;
  owned: boolean;
  reportedReady: boolean;
  validUntil: string | null;
}
export interface CycleSummary {
  cycleId: string;
  originAgentId: string;
  peerAgentId: string;
  generation: number;
  roomRevision: number;
  originEpoch: number;
  peerEpoch: number;
  state: CycleState;
  runsReserved: number;
  peerRoundsReserved: number;
  deadline: string;
}
export interface DirectCycleSummary {
  cycleId: string;
  mode: "DIRECT";
  targetAgentId: string;
  targetEpoch: number;
  generation: 1;
  roomRevision: number;
  state: CycleState;
  runsReserved: 1;
  peerRoundsReserved: 0;
  deadline: string;
  canInterrupt: boolean;
}
export interface HistoryPage {
  roomId: string;
  roomRevision: number;
  roomMode: RoomMode;
  events: PublicEvent[];
  runs: RunSummary[];
  bindings: PublicBinding[];
  cycle: CycleSummary | DirectCycleSummary | null;
  nextCursor: number;
  highWaterSequence: number;
  hasMore: boolean;
}
export interface RequestPayload {
  requestId: string;
  cycleId: string;
  agentId: string;
  bindingEpoch: number;
  roomRevision: number;
  requestKind: RequestKind;
  questionId: string | null;
  publicText: string;
  replyText: string | null;
  deadline: string;
}
export interface AttemptSnapshot {
  requestId: string;
  attemptId: string;
  agentId: string;
  bindingEpoch: number;
  fence: number;
  state: (typeof attemptStates)[number];
  leaseExpiresAt: string;
  startIntentAt: string | null;
  payload: RequestPayload;
}
export interface InputState {
  agentId: string;
  bindingEpoch: number;
  revision: number;
  paused: boolean;
  appliedRevision: number | null;
  appliedEpoch: number | null;
  appliedAt: string | null;
}
export interface InputStates {
  roomId: string;
  bindings: InputState[];
}
export interface Control {
  controlId: string;
  requestId: string;
  attemptId: string;
  fence: number;
  state: "REQUESTED" | "ACKNOWLEDGED";
}
export interface PollSnapshot {
  roomId: string;
  roomRevision: number;
  roomMode: RoomMode;
  agentId: string;
  bindingEpoch: number;
  reportedReady: boolean;
  validUntil: string | null;
  queuedRequest: RequestPayload | null;
  attempt: AttemptSnapshot | null;
  control: Control | null;
}
export interface TerminalReceipt {
  requestId: string;
  attemptId: string;
  terminal: Terminal;
  adoption: Exclude<Adoption, "NONE">;
  continuationRequestId: string | null;
}
export interface CycleAdmission {
  cycleId: string;
  requestId: string | null;
  accepted: boolean;
  roomRevision: number;
  cycleState: CycleState;
}
export interface ResumeResult {
  roomId: string;
  roomRevision: number;
  roomMode: RoomMode;
  cycleId: string | null;
  requestId: string | null;
  accepted: boolean;
  cycleState: CycleState | null;
}
type Check = (value: unknown) => boolean;
type Shape = Record<string, Check>;
const id: Check = (v) =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const uint: Check = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive: Check = (v) => uint(v) && (v as number) > 0;
const bool: Check = (v) => typeof v === "boolean";
const text: Check = (v) =>
  typeof v === "string" &&
  !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(v) &&
  new TextEncoder().encode(v).length <= 8192 &&
  Array.from(v).length <= 4000;
const alias: Check = (v) =>
  typeof v === "string" &&
  v.length > 0 &&
  Array.from(v).length <= 80 &&
  !/[\u0000-\u001f\u007f]/.test(v);
const date: Check = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v) &&
  Number.isFinite(Date.parse(v));
const one =
  (values: readonly (string | number | boolean)[]): Check =>
  (v) =>
    values.includes(v as string);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
function matches(value: unknown, shape: Shape): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(shape).length &&
    Object.entries(shape).every(
      ([k, c]) => Object.hasOwn(value, k) && c((value as Record<string, unknown>)[k]),
    )
  );
}
const nested =
  (shape: Shape): Check =>
  (v) =>
    matches(v, shape);
const list =
  (check: Check, max: number): Check =>
  (v) =>
    Array.isArray(v) && v.length <= max && v.every(check);
const identity: Shape = {
  operationId: id,
  agentId: id,
  bindingEpoch: positive,
  requestId: id,
  attemptId: id,
  fence: positive,
};
const pair: Shape = {
  originAgentId: id,
  peerAgentId: id,
  originEpoch: positive,
  peerEpoch: positive,
  expectedRoomRevision: positive,
  publicText: text,
  confirmed: one([true]),
};
const bodies: Record<Action, Shape> = {
  read: { roomId: id, afterSequence: uint },
  "input-state": { roomId: id },
  "input-control": {
    roomId: id,
    expectedUserId: id,
    operationId: id,
    agentId: id,
    bindingEpoch: positive,
    expectedRevision: positive,
    paused: bool,
  },
  admission: { agentId: id, bindingEpoch: positive },
  "admission-ack": { agentId: id, bindingEpoch: positive, revision: positive, paused: bool },
  speak: { roomId: id, operationId: id, publicText: text },
  start: { roomId: id, operationId: id, ...pair },
  ask: {
    roomId: id,
    operationId: id,
    expectedUserId: id,
    targetAgentId: id,
    targetEpoch: positive,
    expectedRoomRevision: positive,
    publicText: text,
    confirmed: one([true]),
  },
  cancel: {
    roomId: id,
    operationId: id,
    expectedUserId: id,
    requestId: id,
    expectedRoomRevision: positive,
  },
  interrupt: {
    roomId: id,
    operationId: id,
    agentId: id,
    bindingEpoch: positive,
    expectedRoomRevision: positive,
  },
  pause: { roomId: id, operationId: id, expectedRoomRevision: positive },
  resume: {},
  ready: { operationId: id, agentId: id, bindingEpoch: positive, reportedReady: bool },
  poll: { agentId: id, bindingEpoch: positive },
  claim: { operationId: id, agentId: id, bindingEpoch: positive, requestId: id },
  "start-intent": identity,
  lease: identity,
  question: { ...identity, publicText: text, confirmed: one([true]) },
  complete: { ...identity, terminal: one(terminals), publicText: text },
  "interrupt-ack": { ...identity, controlId: id },
  observe: { ...identity, terminal: one(terminals), publicText: text },
};
export function validateBody(action: Action, input: unknown): Body {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    throw new WorkflowError("INVALID_BODY");
  }
  if (new TextEncoder().encode(serialized).length > 16384)
    throw new WorkflowError("BODY_TOO_LARGE");
  let shape = bodies[action];
  if (action === "resume") {
    const mode = (input as Body)?.mode;
    shape =
      mode === "room"
        ? { roomId: id, operationId: id, mode: one(["room"]), expectedRoomRevision: positive }
        : { roomId: id, operationId: id, mode: one(["cycle"]), cycleId: id, ...pair };
  }
  if (!shape || !matches(input, { protocol: one([1]), ...shape }))
    throw new WorkflowError("INVALID_BODY");
  const body = { ...input } as Body;
  if (Object.hasOwn(body, "publicText")) {
    body.publicText = (body.publicText as string).trim();
    if (["speak", "start", "resume", "question", "ask"].includes(action) && !body.publicText)
      throw new WorkflowError("INVALID_BODY");
    if (
      ["complete", "observe"].includes(action) &&
      body.terminal !== "COMPLETED" &&
      body.publicText !== ""
    )
      throw new WorkflowError("INVALID_BODY");
  }
  if (
    (action === "start" || (action === "resume" && body.mode === "cycle")) &&
    body.originAgentId === body.peerAgentId
  )
    throw new WorkflowError("INVALID_BODY");
  if (new TextEncoder().encode(JSON.stringify(body)).length > 16384)
    throw new WorkflowError("BODY_TOO_LARGE");
  return body;
}
const payload: Shape = {
  requestId: id,
  cycleId: id,
  agentId: id,
  bindingEpoch: positive,
  roomRevision: positive,
  requestKind: one(requestKinds),
  questionId: nullable(id),
  publicText: text,
  replyText: nullable(text),
  deadline: date,
};
const validPayload: Check = (v) =>
  matches(v, payload) &&
  (v.requestKind === "PEER" || v.requestKind === "CONTINUATION"
    ? v.questionId !== null
    : v.questionId === null) &&
  (v.requestKind === "CONTINUATION" ? v.replyText !== null : v.replyText === null);
const attempt: Shape = {
  requestId: id,
  attemptId: id,
  agentId: id,
  bindingEpoch: positive,
  fence: positive,
  state: one(attemptStates),
  leaseExpiresAt: date,
  startIntentAt: nullable(date),
  payload: validPayload,
};
const validAttempt: Check = (v) =>
  matches(v, attempt) &&
  matches(v.payload, payload) &&
  v.requestId === v.payload.requestId &&
  v.agentId === v.payload.agentId &&
  v.bindingEpoch === v.payload.bindingEpoch &&
  (v.state === "LEASED" || v.state === "ABANDONED"
    ? v.startIntentAt === null
    : v.startIntentAt !== null);
const control: Shape = {
  controlId: id,
  requestId: id,
  attemptId: id,
  fence: positive,
  state: one(["REQUESTED", "ACKNOWLEDGED"]),
};
const run: Shape = {
  requestId: id,
  cycleId: id,
  agentId: id,
  ownerAlias: alias,
  sessionAlias: alias,
  requestKind: one(requestKinds),
  roomRevision: positive,
  bindingEpoch: positive,
  state: one(runStates),
  questionId: nullable(id),
  createdAt: date,
  updatedAt: date,
};
const validRun: Check = (v) =>
  matches(v, run) &&
  (v.requestKind === "PEER" || v.requestKind === "CONTINUATION"
    ? v.questionId !== null
    : v.questionId === null);
const binding: Shape = {
  agentId: id,
  ownerAlias: alias,
  sessionAlias: alias,
  repositoryAlias: alias,
  runtime: one(["codex", "claude"]),
  bindingEpoch: positive,
  owned: bool,
  reportedReady: bool,
  validUntil: nullable(date),
};
const validBinding: Check = (v) =>
  matches(v, binding) && (!v.reportedReady || v.validUntil !== null);
const cycle: Shape = {
  cycleId: id,
  originAgentId: id,
  peerAgentId: id,
  generation: positive,
  roomRevision: positive,
  originEpoch: positive,
  peerEpoch: positive,
  state: one(cycleStates),
  runsReserved: (v) => uint(v) && (v as number) <= 11,
  peerRoundsReserved: (v) => uint(v) && (v as number) <= 5,
  deadline: date,
};
const directCycle: Shape = {
  cycleId: id,
  mode: one(["DIRECT"]),
  targetAgentId: id,
  targetEpoch: positive,
  generation: one([1]),
  roomRevision: positive,
  state: one(cycleStates),
  runsReserved: one([1]),
  peerRoundsReserved: one([0]),
  deadline: date,
  canInterrupt: bool,
};
const validCycle: Check = (v) =>
  matches(v, directCycle) || (matches(v, cycle) && v.originAgentId !== v.peerAgentId);
const event: Shape = {
  eventId: id,
  roomId: id,
  sequence: positive,
  createdAt: date,
  kind: one(eventKinds),
  senderKind: one(["HUMAN", "AGENT", "SYSTEM"]),
  senderAlias: alias,
  publicText: text,
  cycleId: nullable(id),
  requestId: nullable(id),
  questionId: nullable(id),
  replyTo: nullable(id),
  roomRevision: positive,
  bindingEpoch: nullable(positive),
  agentId: nullable(id),
  requestKind: nullable(one(requestKinds)),
  runState: nullable(one(runStates)),
  terminal: nullable(one(terminals)),
  roomMode: nullable(one(roomModes)),
  adoption: one(adoptions),
};
function validEvent(v: unknown): boolean {
  if (!matches(v, event)) return false;
  const e = v as unknown as PublicEvent;
  if (e.kind === "RUN_STATE")
    return (
      e.senderKind === "AGENT" &&
      e.adoption === "NONE" &&
      !!e.cycleId &&
      !!e.requestId &&
      !!e.agentId &&
      !!e.requestKind &&
      !!e.bindingEpoch &&
      !!e.runState &&
      e.questionId === null &&
      e.replyTo === null &&
      e.roomMode === null &&
      e.publicText === "" &&
      e.terminal === (terminals.includes(e.runState as Terminal) ? e.runState : null)
    );
  if (e.kind === "QUESTION" && e.senderKind === "HUMAN")
    return (
      e.adoption === "PENDING" &&
      e.publicText.trim() !== "" &&
      !!e.cycleId &&
      !!e.requestId &&
      !!e.agentId &&
      e.requestKind === "PEER" &&
      !!e.bindingEpoch &&
      !!e.questionId &&
      e.replyTo === null &&
      e.runState === null &&
      e.terminal === null &&
      e.roomMode === null
    );
  if (e.kind === "QUESTION" || e.kind === "ANSWER")
    return (
      e.senderKind === "AGENT" &&
      e.adoption !== "NONE" &&
      (e.kind === "ANSWER"
        ? e.requestKind === "PEER"
        : e.requestKind !== "PEER" && e.adoption === "PENDING" && e.publicText.trim() !== "") &&
      !!e.cycleId &&
      !!e.requestId &&
      !!e.agentId &&
      !!e.requestKind &&
      !!e.bindingEpoch &&
      !!e.questionId &&
      e.replyTo === (e.kind === "ANSWER" ? e.questionId : null) &&
      e.runState === null &&
      e.terminal === null &&
      e.roomMode === null
    );
  if (e.kind.startsWith("ROOM_"))
    return (
      e.roomMode ===
        (e.kind === "ROOM_PAUSE_REQUESTED"
          ? "PAUSING"
          : e.kind === "ROOM_PAUSED"
            ? "PAUSED"
            : "ACTIVE") &&
      e.publicText === "" &&
      e.adoption === "NONE" &&
      e.senderKind === (e.kind === "ROOM_PAUSED" ? "SYSTEM" : "HUMAN") &&
      !!e.roomMode &&
      e.cycleId === null &&
      e.requestId === null &&
      e.questionId === null &&
      e.replyTo === null &&
      e.agentId === null &&
      e.requestKind === null &&
      e.bindingEpoch === null &&
      e.runState === null &&
      e.terminal === null
    );
  if (
    e.runState !== null ||
    e.terminal !== null ||
    e.roomMode !== null ||
    e.questionId !== null ||
    e.replyTo !== null
  )
    return false;
  if (e.kind === "SPEECH")
    return e.senderKind === "HUMAN"
      ? e.publicText.trim() !== "" &&
          e.cycleId === null &&
          e.requestId === null &&
          e.agentId === null &&
          e.bindingEpoch === null &&
          e.requestKind === null &&
          e.adoption === "NONE"
      : e.senderKind === "AGENT" &&
          !!e.cycleId &&
          !!e.requestId &&
          !!e.agentId &&
          !!e.bindingEpoch &&
          e.requestKind !== null &&
          e.requestKind !== "PEER" &&
          ["ACCEPTED", "HISTORICAL"].includes(e.adoption) &&
          e.publicText.trim() !== "";
  if (e.kind === "INVESTIGATION_STARTED" || e.kind === "INVESTIGATION_RESUMED")
    return (
      e.senderKind === "HUMAN" &&
      e.adoption === "NONE" &&
      e.publicText.trim() !== "" &&
      e.cycleId !== null &&
      e.requestId === null &&
      e.agentId === null &&
      e.requestKind === null &&
      e.bindingEpoch === null
    );
  if (e.kind === "INTERRUPT_REQUESTED" || e.kind === "INTERRUPT_ACKNOWLEDGED")
    return (
      e.senderKind === "AGENT" &&
      e.adoption === "NONE" &&
      e.publicText === "" &&
      e.cycleId !== null &&
      e.requestId !== null &&
      e.agentId !== null &&
      e.requestKind !== null &&
      e.bindingEpoch !== null
    );
  return (
    e.kind === "HUMAN_INPUT_REQUIRED" &&
    e.senderKind === "SYSTEM" &&
    e.adoption === "HUMAN_INPUT_REQUIRED" &&
    e.publicText === "" &&
    e.cycleId !== null &&
    e.requestId === null &&
    e.agentId === null &&
    e.requestKind === null &&
    e.bindingEpoch === null
  );
}
const history: Shape = {
  roomId: id,
  roomRevision: positive,
  roomMode: one(roomModes),
  events: list(validEvent, 16),
  runs: list(validRun, 32),
  bindings: list(validBinding, 20),
  cycle: nullable(validCycle),
  nextCursor: uint,
  highWaterSequence: uint,
  hasMore: bool,
};
const poll: Shape = {
  roomId: id,
  roomRevision: positive,
  roomMode: one(roomModes),
  agentId: id,
  bindingEpoch: positive,
  reportedReady: bool,
  validUntil: nullable(date),
  queuedRequest: nullable(validPayload),
  attempt: nullable(validAttempt),
  control: nullable(nested(control)),
};
const admission: Shape = {
  cycleId: id,
  requestId: nullable(id),
  accepted: bool,
  roomRevision: positive,
  cycleState: one(cycleStates),
};
const resume: Shape = {
  roomId: id,
  roomRevision: positive,
  roomMode: one(roomModes),
  cycleId: nullable(id),
  requestId: nullable(id),
  accepted: bool,
  cycleState: nullable(one(cycleStates)),
};
const receipt: Shape = {
  requestId: id,
  attemptId: id,
  terminal: one(terminals),
  adoption: one(adoptions.slice(1)),
  continuationRequestId: nullable(id),
};
const inputState: Shape = {
  agentId: id,
  bindingEpoch: positive,
  revision: positive,
  paused: bool,
  appliedRevision: nullable(positive),
  appliedEpoch: nullable(positive),
  appliedAt: nullable(date),
};
const validInputState: Check = (v) =>
  matches(v, inputState) &&
  (v.appliedRevision === null
    ? v.appliedEpoch === null && v.appliedAt === null
    : v.appliedRevision === v.revision &&
      v.appliedEpoch === v.bindingEpoch &&
      v.appliedAt !== null);
const responses: Record<Action, Shape> = {
  "input-state": { roomId: id, bindings: list(validInputState, 20) },
  "input-control": inputState,
  admission: inputState,
  "admission-ack": inputState,
  read: history,
  speak: { eventId: id, sequence: positive },
  start: admission,
  ask: admission,
  cancel: {
    controlId: nullable(id),
    requestId: nullable(id),
    state: one(["REQUESTED", "NO_ACTIVE_RUN"]),
  },
  interrupt: {
    controlId: nullable(id),
    requestId: nullable(id),
    state: one(["REQUESTED", "NO_ACTIVE_RUN"]),
  },
  pause: { roomId: id, roomRevision: positive, roomMode: one(roomModes) },
  resume,
  ready: {
    agentId: id,
    bindingEpoch: positive,
    reportedReady: bool,
    validUntil: nullable(date),
    verification: one(["reported"]),
  },
  poll,
  claim: attempt,
  "start-intent": attempt,
  lease: attempt,
  question: {
    cycleId: id,
    questionId: nullable(id),
    peerRequestId: nullable(id),
    accepted: bool,
    cycleState: one(cycleStates),
  },
  complete: receipt,
  "interrupt-ack": { ...control, state: one(["ACKNOWLEDGED"]) },
  observe: receipt,
};
export function projectResponse(action: Action, value: unknown): unknown {
  if (!matches(value, responses[action])) throw new WorkflowError("UNAVAILABLE");
  if (
    new TextEncoder().encode(JSON.stringify(value)).length >
    (humanActions.includes(action as HumanAction) ? 262144 : 65536)
  )
    throw new WorkflowError("UNAVAILABLE");
  if (["input-control", "admission", "admission-ack"].includes(action) && !validInputState(value))
    throw new WorkflowError("UNAVAILABLE");
  if (action === "input-state") {
    const state = value as unknown as InputStates;
    if (new Set(state.bindings.map((binding) => binding.agentId)).size !== state.bindings.length)
      throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "read") {
    const h = value as unknown as HistoryPage;
    if (
      h.events.some(
        (e, i) => e.roomId !== h.roomId || (i > 0 && e.sequence <= h.events[i - 1].sequence),
      ) ||
      h.nextCursor > h.highWaterSequence ||
      (h.events.length > 0 && h.nextCursor !== h.events.at(-1)!.sequence) ||
      h.hasMore !== h.nextCursor < h.highWaterSequence
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  if (["claim", "start-intent", "lease"].includes(action)) {
    const a = value as unknown as AttemptSnapshot;
    if (
      !validAttempt(a) ||
      a.payload.requestId !== a.requestId ||
      a.payload.agentId !== a.agentId ||
      a.payload.bindingEpoch !== a.bindingEpoch ||
      (a.state === "EXECUTING" && a.startIntentAt === null)
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "poll") {
    const p = value as unknown as PollSnapshot;
    if (
      (p.queuedRequest &&
        (p.queuedRequest.agentId !== p.agentId ||
          p.queuedRequest.bindingEpoch !== p.bindingEpoch)) ||
      (p.attempt &&
        (p.attempt.agentId !== p.agentId || p.attempt.bindingEpoch !== p.bindingEpoch)) ||
      (p.control &&
        (!p.attempt ||
          p.control.requestId !== p.attempt.requestId ||
          p.control.attemptId !== p.attempt.attemptId ||
          p.control.fence !== p.attempt.fence))
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "interrupt" || action === "cancel") {
    const r = value as { controlId: string | null; requestId: string | null; state: string };
    if (
      r.state === "NO_ACTIVE_RUN"
        ? r.controlId !== null || r.requestId !== null
        : r.requestId === null
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "start" || action === "ask") {
    const r = value as unknown as CycleAdmission;
    if (
      r.accepted !== (r.requestId !== null) ||
      (!r.accepted && r.cycleState !== "HUMAN_INPUT_REQUIRED")
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "question") {
    const r = value as {
      accepted: boolean;
      questionId: string | null;
      peerRequestId: string | null;
      cycleState: CycleState;
    };
    if (
      (r.accepted && (r.questionId === null || r.peerRequestId === null)) ||
      (!r.accepted &&
        (r.questionId !== null ||
          r.peerRequestId !== null ||
          r.cycleState !== "HUMAN_INPUT_REQUIRED"))
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "ready") {
    const r = value as { reportedReady: boolean; validUntil: string | null };
    if (r.reportedReady !== (r.validUntil !== null)) throw new WorkflowError("UNAVAILABLE");
  }
  if (action === "resume") {
    const r = value as unknown as ResumeResult;
    if (
      (r.cycleId === null && (r.requestId !== null || r.cycleState !== null || !r.accepted)) ||
      (r.cycleId !== null && (r.cycleState === null || r.accepted !== (r.requestId !== null)))
    )
      throw new WorkflowError("UNAVAILABLE");
  }
  return value;
}
export function projectHistory(value: unknown): HistoryPage {
  return projectResponse("read", value) as HistoryPage;
}
export function projectPoll(value: unknown): PollSnapshot {
  return projectResponse("poll", value) as PollSnapshot;
}
export function projectEnvelope(action: Action, value: unknown, status: number): unknown {
  const v = value as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== 2)
    throw new WorkflowError("UNAVAILABLE");
  if (v.ok === false && matches(v.error, { code: one(Object.keys(errorStatus)) })) {
    const code = (v.error as { code: ErrorCode }).code;
    if (status === errorStatus[code]) throw new WorkflowError(code);
  }
  if (v.ok !== true || status !== 200 || !Object.hasOwn(v, "data"))
    throw new WorkflowError("UNAVAILABLE");
  return projectResponse(action, v.data);
}
