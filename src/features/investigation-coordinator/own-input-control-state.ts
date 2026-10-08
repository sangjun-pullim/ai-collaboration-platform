import {
  WorkflowError,
  projectResponse,
  validateBody,
  type Body,
  type InputState,
  type InputStates,
} from "./contracts.ts";

export type InputIntent = { action: "input-control"; body: Body };
export const inputIntentKey = (userId: string, roomId: string) =>
  `own-ai-input:${userId}:${roomId}`;
export function inputIntent(
  userId: string,
  roomId: string,
  state: InputState,
  operationId: string,
): InputIntent {
  return {
    action: "input-control",
    body: validateBody("input-control", {
      protocol: 1,
      roomId,
      expectedUserId: userId,
      operationId,
      agentId: state.agentId,
      bindingEpoch: state.bindingEpoch,
      expectedRevision: state.revision,
      paused: !state.paused,
    }),
  };
}
export function restoreInputIntent(
  storage: Pick<Storage, "getItem">,
  userId: string,
  roomId: string,
): InputIntent | null {
  try {
    const raw = storage.getItem(inputIntentKey(userId, roomId));
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      Object.keys(saved).length !== 2 ||
      saved.action !== "input-control"
    )
      return null;
    const body = validateBody("input-control", saved.body);
    if (body.expectedUserId !== userId || body.roomId !== roomId) return null;
    return { action: "input-control", body };
  } catch {
    return null;
  }
}
/** Old epoch and revision projections cannot replace newer local knowledge. */
export function adoptInputState(
  current: InputState | undefined,
  value: unknown,
  agentId: string,
  bindingEpoch: number,
): InputState | undefined {
  const next = projectResponse("admission", value) as InputState;
  if (next.agentId !== agentId || next.bindingEpoch !== bindingEpoch)
    return current?.bindingEpoch === bindingEpoch ? current : undefined;
  if (current?.bindingEpoch === bindingEpoch) {
    if (next.revision < current.revision) return current;
    if (next.revision === current.revision && next.paused !== current.paused)
      throw new WorkflowError("UNAVAILABLE");
    if (next.revision === current.revision && current.appliedAt !== null && next.appliedAt === null)
      return current;
  }
  return next;
}
/** Only the response to this exact persisted operation confirms its receipt. */
export function inputReceipt(intent: InputIntent, value: unknown): InputState {
  const receipt = projectResponse("input-control", value) as InputState;
  const b = intent.body;
  if (
    receipt.agentId !== b.agentId ||
    receipt.bindingEpoch !== b.bindingEpoch ||
    receipt.paused !== b.paused ||
    (receipt.revision !== b.expectedRevision && receipt.revision !== Number(b.expectedRevision) + 1)
  )
    throw new WorkflowError("UNAVAILABLE");
  return receipt;
}
export function inputStatus(state: InputState | undefined, unavailable: boolean): string {
  if (unavailable || !state) return "상태 확인 불가";
  if (state.appliedRevision !== state.revision || state.appliedEpoch !== state.bindingEpoch)
    return "요청됨 · 연결 프로그램 대기";
  return state.paused ? "일시정지 적용 보고" : "재개 적용 보고";
}

/** Render only the current history bindings; additional owned server states are valid. */
export function projectOwnInputStates(
  current: Record<string, InputState>,
  value: unknown,
  roomId: string,
  pins: readonly (readonly [string, number])[],
): Record<string, InputState> {
  const response = projectResponse("input-state", value) as InputStates;
  if (response.roomId !== roomId) throw new WorkflowError("UNAVAILABLE");
  const next: Record<string, InputState> = {};
  for (const [id, epoch] of pins) {
    const state = response.bindings.find((item) => item.agentId === id);
    if (!state || state.bindingEpoch !== epoch) continue;
    const accepted = adoptInputState(current[id], state, id, epoch);
    if (accepted) next[id] = accepted;
  }
  return next;
}
