import { redirect } from "next/navigation";
import { requestClient, serverConfig } from "../../../lib/supabase/server";
import { currentUser } from "../../../features/room-access/access-service";
import { AccessError } from "../../../features/room-access/contracts";
import { ownedConnections } from "../../../features/device-binding/service";
import { ConnectionManager } from "../../../features/device-binding/connection-manager";
import { ConnectionError, messages } from "../../../features/device-binding/contracts";
export const dynamic = "force-dynamic";
export default async function ConnectionsPage() {
  let data: Awaited<ReturnType<typeof ownedConnections>> | undefined;
  let userId = "";
  let origin = "";
  try {
    const { client } = await requestClient();
    userId = await currentUser(client);
    origin = serverConfig().origin;
    data = await ownedConnections(client);
  } catch (error) {
    if (
      (error instanceof ConnectionError || error instanceof AccessError) &&
      error.code === "UNAUTHENTICATED"
    )
      redirect("/login");
  }
  return data ? (
    <ConnectionManager {...data} origin={origin} userId={userId} />
  ) : (
    <main>
      <p role="alert" aria-label="기기 연결 오류">
        {messages.UNAVAILABLE}
      </p>
    </main>
  );
}
