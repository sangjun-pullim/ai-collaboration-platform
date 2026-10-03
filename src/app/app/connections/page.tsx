import { redirect } from "next/navigation";
import { requestClient } from "../../../lib/supabase/server";
import { ownedConnections } from "../../../features/device-binding/service";
import { ConnectionManager } from "../../../features/device-binding/connection-manager";
import { ConnectionError, messages } from "../../../features/device-binding/contracts";
export const dynamic = "force-dynamic";
export default async function ConnectionsPage() {
  let data: Awaited<ReturnType<typeof ownedConnections>> | undefined;
  try {
    const { client } = await requestClient();
    data = await ownedConnections(client);
  } catch (error) {
    if (error instanceof ConnectionError && error.code === "UNAUTHENTICATED") redirect("/login");
  }
  return data ? (
    <ConnectionManager {...data} />
  ) : (
    <main>
      <p role="alert" aria-label="기기 연결 오류">
        {messages.UNAVAILABLE}
      </p>
    </main>
  );
}
