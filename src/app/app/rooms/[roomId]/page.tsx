import { notFound, redirect } from "next/navigation";
import { requestClient } from "../../../../lib/supabase/server";
import { roomDetails } from "../../../../features/room-access/access-service";
import { RoomAccessView } from "../../../../features/room-access/room-access-view";
import { AccessError, messages } from "../../../../features/room-access/contracts";
import { roomBindings } from "../../../../features/device-binding/service";
import { RoomBindings } from "../../../../features/device-binding/room-bindings";
import type { PublicBinding } from "../../../../features/device-binding/contracts";
import { InvestigationView } from "../../../../features/investigation-coordinator/investigation-view";
export const dynamic = "force-dynamic";
export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  let data: Awaited<ReturnType<typeof roomDetails>> | undefined;
  let bindings: PublicBinding[] = [];
  let bindingUnavailable = false;
  try {
    const { roomId } = await params;
    const { client } = await requestClient();
    data = await roomDetails(client, roomId);
    try {
      bindings = await roomBindings(client, roomId);
    } catch {
      bindingUnavailable = true;
    }
  } catch (error) {
    if (error instanceof AccessError && error.code === "UNAUTHENTICATED") redirect("/login");
    if (error instanceof AccessError && error.code === "NOT_FOUND") notFound();
  }
  return data ? (
    <RoomAccessView
      investigation={
        <InvestigationView
          key={`${data.userId}:${data.room.id}`}
          userId={data.userId}
          roomId={data.room.id}
          role={data.role}
        />
      }
      {...data}
      bindings={
        bindingUnavailable ? (
          <p role="alert">기기 등록 정보를 불러올 수 없습니다.</p>
        ) : (
          <RoomBindings bindings={bindings} />
        )
      }
    />
  ) : (
    <main>
      <p>{messages.UNAVAILABLE}</p>
    </main>
  );
}
