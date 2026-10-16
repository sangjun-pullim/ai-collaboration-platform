import type { HistoryState } from "./history-state.ts";
type Actor = { userId: string; roomId: string; role: string };
type Cached = { actor: Actor; history: HistoryState; at: number; bytes: number };
const entries = new Map<string, Cached>();
const key = (actor: Actor) => `${actor.userId}:${actor.roomId}:${actor.role}`;
export function clearChatHistory(userId?: string, roomId?: string) {
  for (const [id, entry] of entries)
    if ((!userId || userId === entry.actor.userId) && (!roomId || roomId === entry.actor.roomId))
      entries.delete(id);
}
export function cacheChatHistory(actor: Actor, history: HistoryState, now = Date.now()) {
  if (!history.snapshot) return;
  const bytes = new TextEncoder().encode(JSON.stringify(history)).byteLength;
  entries.delete(key(actor));
  if (bytes > 10 * 1024 * 1024) return;
  entries.set(key(actor), { actor, history, bytes, at: now });
  for (const [id, entry] of entries) if (now - entry.at > 300_000) entries.delete(id);
  while (
    entries.size > 3 ||
    [...entries.values()].reduce((sum, entry) => sum + entry.bytes, 0) > 10 * 1024 * 1024
  )
    entries.delete(entries.keys().next().value!);
}
/** Callers must keep this private until a new actor-pinned HTTP read succeeds. */
export function cachedChatHistory(actor: Actor, now = Date.now()): HistoryState | null {
  for (const [id, entry] of entries)
    if (
      entry.actor.userId !== actor.userId ||
      (entry.actor.roomId === actor.roomId && entry.actor.role !== actor.role) ||
      now - entry.at > 300_000
    )
      entries.delete(id);
  const cached = entries.get(key(actor));
  if (!cached) return null;
  entries.delete(key(actor));
  entries.set(key(actor), { ...cached, at: now });
  return cached.history;
}
