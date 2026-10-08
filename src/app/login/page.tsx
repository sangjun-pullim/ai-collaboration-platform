import { redirect } from "next/navigation";
import { LoginForm } from "../../features/room-access/login-form";
import { currentUser } from "../../features/room-access/access-service";
import { AccessError, messages } from "../../features/room-access/contracts";
import { requestClient } from "../../lib/supabase/server";

export const dynamic = "force-dynamic";
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string | string[] }>;
}) {
  const { invite } = await searchParams;
  const destination =
    typeof invite === "string" && /^[a-f0-9]{64}$/.test(invite) ? `/app?invite=${invite}` : "/app";
  let admitted = false;
  try {
    const { client } = await requestClient();
    await currentUser(client);
    admitted = true;
  } catch (error) {
    if (!(error instanceof AccessError) || error.code !== "UNAUTHENTICATED") {
      return (
        <main className="mx-auto flex min-h-dvh max-w-md items-center px-5">
          <p role="alert">{messages.UNAVAILABLE}</p>
        </main>
      );
    }
  }
  if (admitted) redirect(destination);
  return <LoginForm destination={destination} />;
}
