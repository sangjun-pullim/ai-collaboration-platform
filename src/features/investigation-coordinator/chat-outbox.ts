import { validateBody, WorkflowError, type Body } from "./contracts.ts";
import type { DirectIntent } from "./direct-intents.ts";

export type SpeechEntry = {
  userId: string;
  roomId: string;
  operationId: string;
  body: Body;
  createdAt: number;
  bytes: number;
};
export type OutboxRead = { entry: SpeechEntry | null; expired: boolean };
export interface SpeechOutbox {
  read(userId: string, roomId: string): Promise<OutboxRead>;
  reserve(body: Body): Promise<SpeechEntry>;
  remove(userId: string, roomId: string, operationId: string): Promise<boolean>;
  clear(userId?: string, roomId?: string): Promise<void>;
}
const week = 7 * 24 * 60 * 60 * 1000;
export const outboxCleanupKey = "chat-outbox-cleanup-required";
const request = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error("브라우저 저장소를 사용할 수 없습니다."));
  });
function committed(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(new Error("브라우저 저장소에 요청을 보관하지 못했습니다."));
  });
}
export class IndexedSpeechOutbox implements SpeechOutbox {
  constructor(
    private readonly factory: () => IDBFactory = () => indexedDB,
    private readonly now: () => number = Date.now,
    private readonly cleanupStorage: () => Storage = () => localStorage,
  ) {}
  private async open() {
    const open = this.factory().open("chat-speech-outbox", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("speech", { keyPath: ["userId", "roomId"] });
    };
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new Error("브라우저 저장소를 열 수 없습니다."));
      open.onblocked = () => {
        reject(new Error("다른 탭의 저장소 사용이 끝난 뒤 다시 확인하세요."));
        open.onsuccess = () => open.result.close();
      };
    });
    database.onversionchange = () => database.close();
    return database;
  }
  private async transaction<T>(action: (store: IDBObjectStore) => Promise<T>) {
    const database = await this.open();
    const tx = database.transaction("speech", "readwrite");
    const done = committed(tx);
    try {
      const result = await action(tx.objectStore("speech"));
      await done;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already completed or aborted. */
      }
      await done.catch(() => {});
      throw error;
    } finally {
      database.close();
    }
  }
  private async cleanupPending(userId: string, roomId: string) {
    const storage = this.cleanupStorage();
    if (storage.getItem(outboxCleanupKey)) {
      await this.clear();
      storage.removeItem(outboxCleanupKey);
    }
    if (storage.getItem(`chat-outbox-user-cleanup:${userId}`)) await this.clear(userId);
    if (storage.getItem(`chat-outbox-scope-cleanup:${userId}:${roomId}`))
      await this.clear(userId, roomId);
  }
  async read(userId: string, roomId: string): Promise<OutboxRead> {
    await this.cleanupPending(userId, roomId);
    return this.transaction(async (store) => {
      const entry = (await request(store.get([userId, roomId]))) as SpeechEntry | undefined;
      if (!entry) return { entry: null, expired: false };
      const body = validateBody("speak", entry.body);
      if (
        body.expectedUserId !== userId ||
        body.roomId !== roomId ||
        body.operationId !== entry.operationId ||
        entry.userId !== userId ||
        entry.roomId !== roomId
      )
        throw new WorkflowError("FORBIDDEN");
      if (!Number.isFinite(entry.createdAt) || this.now() - entry.createdAt >= week) {
        await request(store.delete([userId, roomId]));
        return { entry: null, expired: true };
      }
      return { entry, expired: false };
    });
  }
  async reserve(input: Body): Promise<SpeechEntry> {
    const body = validateBody("speak", input);
    if (typeof body.expectedUserId !== "string") throw new WorkflowError("FORBIDDEN");
    const userId = body.expectedUserId,
      roomId = body.roomId as string,
      operationId = body.operationId as string;
    await this.cleanupPending(userId, roomId);
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    return this.transaction(async (store) => {
      const entries = (await request(store.getAll())) as SpeechEntry[];
      const current = entries.find((entry) => entry.userId === userId && entry.roomId === roomId);
      // Even expired reservations need an explicit read to report expiration before replacement.
      if (current) {
        if (
          current.operationId !== operationId ||
          !Number.isFinite(current.createdAt) ||
          this.now() - current.createdAt >= week ||
          ["protocol", "roomId", "expectedUserId", "operationId", "publicText"].some(
            (key) => current.body[key] !== body[key],
          )
        )
          throw new WorkflowError("CONFLICT");
        return current;
      }
      const owned = entries.filter((entry) => entry.userId === userId);
      if (
        owned.length >= 50 ||
        owned.reduce((sum, entry) => sum + entry.bytes, 0) + bytes > 1024 * 1024
      )
        throw new Error("저장 한도를 초과했습니다. 미확정 메시지를 확인하세요.");
      const entry: SpeechEntry = {
        userId,
        roomId,
        operationId,
        body,
        bytes,
        createdAt: this.now(),
      };
      await request(store.add(entry));
      return entry;
    });
  }
  async remove(userId: string, roomId: string, operationId: string) {
    return this.transaction(async (store) => {
      const entry = (await request(store.get([userId, roomId]))) as SpeechEntry | undefined;
      if (entry?.operationId !== operationId) return false;
      await request(store.delete([userId, roomId]));
      return true;
    });
  }
  async clearOtherUsers(userId: string) {
    await this.transaction(async (store) => {
      for (const entry of (await request(store.getAll())) as SpeechEntry[]) {
        if (entry.userId !== userId) await request(store.delete([entry.userId, entry.roomId]));
      }
    });
  }
  async clear(userId?: string, roomId?: string) {
    const marker = userId
      ? roomId
        ? `chat-outbox-scope-cleanup:${userId}:${roomId}`
        : `chat-outbox-user-cleanup:${userId}`
      : null;
    if (marker) this.cleanupStorage().setItem(marker, "1");
    await this.transaction(async (store) => {
      if (!userId) {
        await request(store.clear());
        return;
      }
      for (const entry of (await request(store.getAll())) as SpeechEntry[]) {
        if (entry.userId === userId && (!roomId || entry.roomId === roomId))
          await request(store.delete([entry.userId, entry.roomId]));
      }
    });
    if (marker) this.cleanupStorage().removeItem(marker);
  }
}
export const speechOutbox = new IndexedSpeechOutbox();
export const speechIntent = (entry: SpeechEntry): DirectIntent => ({
  action: "speak",
  body: entry.body,
});
export function announceOutbox() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("chat-outbox-changed");
  channel.postMessage({ version: 1 });
  channel.close();
}
