import { redirect } from "next/navigation";
import Link from "next/link";
import { requestClient, serverConfig } from "../../../lib/supabase/server";
import { currentUser, accessibleRooms } from "../../../features/room-access/access-service";
import { AccessError, type Room } from "../../../features/room-access/contracts";
import { ChatShell } from "../../../features/room-access/chat-shell";
import { ownedConnections } from "../../../features/device-binding/service";
import { ConnectionManager } from "../../../features/device-binding/connection-manager";
import { ConnectionError, messages, isId } from "../../../features/device-binding/contracts";
export const dynamic = "force-dynamic";
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string | string[] }>;
}) {
  let data: Awaited<ReturnType<typeof ownedConnections>> | undefined;
  let navigationRooms: Room[] = [];
  let navigationAvailable = false;
  let userId = "";
  let origin = "";
  try {
    const { client } = await requestClient();
    userId = await currentUser(client);
    origin = serverConfig().origin;
    const [navigation, connections] = await Promise.allSettled([
      accessibleRooms(client),
      ownedConnections(client),
    ]);
    for (const result of [navigation, connections]) {
      if (
        result.status === "rejected" &&
        (result.reason instanceof ConnectionError || result.reason instanceof AccessError) &&
        result.reason.code === "UNAUTHENTICATED"
      )
        throw result.reason;
    }
    if (navigation.status === "fulfilled") {
      navigationRooms = navigation.value;
      navigationAvailable = true;
    }
    if (connections.status === "fulfilled") data = connections.value;
  } catch (error) {
    if (
      (error instanceof ConnectionError || error instanceof AccessError) &&
      error.code === "UNAUTHENTICATED"
    )
      redirect("/login");
  }
  const query = (await searchParams).room;
  const returnRoomId =
    typeof query === "string" && isId(query)
      ? navigationRooms.find((room) => room.id === query)?.id
      : undefined;
  return data && navigationAvailable ? (
    <ConnectionManager
      {...data}
      navigationRooms={navigationRooms}
      returnRoomId={returnRoomId}
      origin={origin}
      userId={userId}
    />
  ) : (
    <ChatShell
      rooms={navigationRooms}
      roomId={returnRoomId}
      page="connections"
      title="내 AI 연결"
      actions={
        <Link
          href={returnRoomId ? `/app/rooms/${returnRoomId}` : "/app"}
          className="text-sm underline"
        >
          {returnRoomId ? "이전 채팅방으로" : "채팅방 목록으로"}
        </Link>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p role="alert" aria-label="기기 연결 오류">
          {messages.UNAVAILABLE}
        </p>
      </div>
    </ChatShell>
  );
}
