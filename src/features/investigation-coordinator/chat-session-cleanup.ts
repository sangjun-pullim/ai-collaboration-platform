import { clearChatHistory } from "./chat-history-cache.ts";
import { speechOutbox, outboxCleanupKey } from "./chat-outbox.ts";
const cleanupListeners = new Set<() => void>();
export const subscribeChatCleanup = (listener: () => void) => {
  cleanupListeners.add(listener);
  return () => {
    cleanupListeners.delete(listener);
  };
};
let cleanupFailed = false;
export function chatCleanupNotice() {
  try {
    return cleanupFailed || !!localStorage.getItem(outboxCleanupKey);
  } catch {
    return cleanupFailed;
  }
}
export const chatSessionEvent = "chat-session-cleared";
export async function clearChatSession(): Promise<boolean> {
  clearChatHistory();
  window.dispatchEvent(new CustomEvent(chatSessionEvent));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(chatSessionEvent);
    channel.postMessage({ version: 1 });
    channel.close();
  }
  let failed = false;
  try {
    localStorage.setItem(outboxCleanupKey, "1");
  } catch {
    failed = true;
  }
  // Attempt each store independently: a blocked marker must not skip durable deletion.
  let speechCleared = false;
  try {
    await speechOutbox.clear();
    speechCleared = true;
  } catch {
    failed = true;
  }
  let legacyCleared = false;
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith("human-direct-question:")) sessionStorage.removeItem(key);
    }
    legacyCleared = true;
  } catch {
    failed = true;
  }
  if (speechCleared && legacyCleared) {
    try {
      localStorage.removeItem(outboxCleanupKey);
    } catch {
      failed = true;
    }
  }
  cleanupFailed = failed;
  cleanupListeners.forEach((listener) => listener());
  return !failed;
}
