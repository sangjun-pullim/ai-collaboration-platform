"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { callInvestigation } from "./investigation-client";
import { RoomChatController, type RoomChatActor } from "./room-chat-controller";

export function useRoomChat({ userId, roomId, role }: RoomChatActor) {
  const controller = useMemo(
    () => new RoomChatController({ userId, roomId, role }, callInvestigation),
    [userId, roomId, role],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return { ...state, mutate: controller.mutate, loseAccess: controller.loseAccess };
}
