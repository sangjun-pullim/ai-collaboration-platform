import { redirect } from "next/navigation";
import { requestClient } from "../../lib/supabase/server";
import { dashboard } from "../../features/room-access/access-service";
import { AccessDashboard } from "../../features/room-access/access-dashboard";
import { AccessError, messages } from "../../features/room-access/contracts";
export const dynamic = "force-dynamic";
export default async function AppPage() {
  let data: Awaited<ReturnType<typeof dashboard>> | undefined;
  try { const { client } = await requestClient(); data = await dashboard(client); }
  catch (error) { if (error instanceof AccessError && error.code === "UNAUTHENTICATED") redirect("/login"); }
  return data ? <AccessDashboard {...data} /> : <main><p>{messages.UNAVAILABLE}</p></main>;
}
