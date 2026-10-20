"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { outboxCleanupKey } from "./chat-outbox";
import { RoomRealtime } from "./room-realtime";
import { chatSessionEvent } from "./chat-session-cleanup";
import { callInvestigation } from "./investigation-client";
import { callHistoryWindow } from "./history-window-client";
import { callRunDiagnostics } from "./run-diagnostics-client";
import { RoomChatController, type RoomChatActor } from "./room-chat-controller";

export function useRoomChat({ userId, roomId, role }: RoomChatActor) {
  const controller = useMemo(
    () =>
      new RoomChatController(
        { userId, roomId, role },
        callInvestigation,
        undefined,
        callHistoryWindow,
        callRunDiagnostics,
      ),
    [userId, roomId, role],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
    const realtime = new RoomRealtime(
      { userId, roomId },
      controller.requestResync,
      controller.setRealtimeState,
    );
    realtime.start();
    const unsubscribe = controller.subscribe(() => {
      if (controller.getSnapshot().permissionDenied) realtime.stop();
    });
    const invalidate = (nextUserId?: string) => {
      realtime.stop();
      controller.invalidateSession(nextUserId);
    };
    const sessionLost = (event: Event) =>
      invalidate((event as CustomEvent<{ nextUserId?: string }>).detail?.nextUserId);
    const sessionChannel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(chatSessionEvent);
    if (sessionChannel) sessionChannel.onmessage = (event) => invalidate(event.data?.nextUserId);
    const outboxChannel =
      typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("chat-outbox-changed");
    if (outboxChannel) outboxChannel.onmessage = () => void controller.refreshOutbox();
    window.addEventListener(chatSessionEvent, sessionLost);
    const storageChanged = (event: StorageEvent) => {
      if (event.key === outboxCleanupKey && event.newValue) {
        let nextUserId: string | undefined;
        try {
          nextUserId = JSON.parse(event.newValue).nextUserId;
        } catch {
          /* Older cleanup markers invalidate every identity. */
        }
        invalidate(nextUserId);
      }
    };
    window.addEventListener("storage", storageChanged);
    const leave = () => {
      realtime.stop();
      controller.stop();
    };
    const returnToPage = (event: PageTransitionEvent) => {
      if (event.persisted) {
        controller.start();
        realtime.start();
      }
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", returnToPage);
    const focus = () => {
      void controller.refreshOutbox();
      controller.requestResync();
    };
    window.addEventListener("focus", focus);
    const visible = () => {
      if (!document.hidden) focus();
    };
    window.addEventListener("online", controller.requestResync);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", controller.requestResync);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("storage", storageChanged);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", returnToPage);
      window.removeEventListener("focus", focus);
      window.removeEventListener(chatSessionEvent, sessionLost);
      sessionChannel?.close();
      outboxChannel?.close();
      unsubscribe();
      realtime.stop();
      controller.stop();
    };
  }, [controller, userId, roomId]);
  return {
    ...state,
    mutate: controller.mutate,
    loseAccess: controller.loseAccess,
    confirmStoredConflict: controller.confirmStoredConflict,
    loadOlder: controller.loadOlder,
    retryDiagnostics: controller.retryDiagnostics,
  };
}
