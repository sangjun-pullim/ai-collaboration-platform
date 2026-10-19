import { imageBlob } from "./client.ts";
import type { AttachmentDescriptor, UserScope } from "./contracts.ts";

type Entry = { abort: AbortController; result: Promise<Blob> };
const sessions = new Map<string, Map<string, Entry>>();
const scopeKey = (scope: UserScope) => `${scope.expectedUserId}:${scope.roomId}`;

/** Keep at most eight MiB of compressed previews per active room session. */
export function cachedImage(
  scope: UserScope,
  image: AttachmentDescriptor,
  load = imageBlob,
): Promise<Blob> {
  const key = scopeKey(scope);
  let cache = sessions.get(key);
  if (!cache) sessions.set(key, (cache = new Map()));
  const id = `${image.attachmentId}:${image.sha256}`;
  const existing = cache.get(id);
  if (existing) return existing.result;
  while (cache.size >= 16) {
    const oldest = cache.keys().next().value!;
    cache.get(oldest)!.abort.abort();
    cache.delete(oldest);
  }
  const abort = new AbortController();
  const entry: Entry = {
    abort,
    result: load(scope, image, abort.signal).catch((error) => {
      if (cache.get(id) === entry) cache.delete(id);
      throw error;
    }),
  };
  cache.set(id, entry);
  return entry.result;
}

export function clearImageCache(scope: UserScope) {
  const key = scopeKey(scope);
  for (const entry of sessions.get(key)?.values() ?? []) entry.abort.abort();
  sessions.delete(key);
}
