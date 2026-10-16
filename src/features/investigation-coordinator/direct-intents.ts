import {
  WorkflowError,
  validateBody,
  type HumanAction,
  type Body,
  type Candidate,
} from "./contracts.ts";

export type DirectIntent = { action: "speak" | "ask" | "cancel" | "retire"; body: Body };

export function directIntentKey(userId: string, roomId: string) {
  return `human-direct-question:${userId}:${roomId}`;
}

export function restoreDirectIntent(
  storage: Storage,
  userId: string,
  roomId: string,
): DirectIntent | null {
  const key = directIntentKey(userId, roomId);
  try {
    // A legacy intent has no authenticated actor; never adopt it into a new namespace.
    storage.removeItem(`human-direct-question:${roomId}`);
    const saved = storage.getItem(key);
    if (!saved) return null;
    const value = JSON.parse(saved);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      !["speak", "ask", "cancel", "retire"].includes(value.action)
    )
      throw new WorkflowError("INVALID_BODY");
    const body = validateBody(value.action, value.body);
    if (body.roomId !== roomId || body.expectedUserId !== userId)
      throw new WorkflowError("FORBIDDEN");
    return { action: value.action, body };
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      /* Unavailable storage cannot authorize restoration. */
    }
    return null;
  }
}

export function mutationBody(
  action: HumanAction,
  fields: Body,
  userId: string,
  roomId: string,
  retryBody?: Body,
) {
  const direct =
    action === "speak" || action === "ask" || action === "cancel" || action === "retire";
  const body = validateBody(
    action,
    retryBody ?? {
      protocol: 1,
      roomId,
      operationId: crypto.randomUUID(),
      ...fields,
      ...(direct ? { expectedUserId: userId } : {}),
    },
  );
  if (direct && (body.expectedUserId !== userId || body.roomId !== roomId))
    throw new WorkflowError("FORBIDDEN");
  return body;
}

export type RetirementPin = Candidate & { userId: string; roomId: string };
export function pinRetirement(userId: string, roomId: string, candidate: Candidate): RetirementPin {
  return { ...candidate, userId, roomId };
}
export function retirementPinMatches(
  pin: RetirementPin,
  userId: string,
  roomId: string,
  candidate: Candidate | null,
) {
  return (
    !!candidate &&
    pin.userId === userId &&
    pin.roomId === roomId &&
    Object.keys(candidate).every(
      (key) => pin[key as keyof Candidate] === candidate[key as keyof Candidate],
    )
  );
}
