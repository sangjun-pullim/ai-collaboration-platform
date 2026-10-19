import { NextResponse } from "next/server";
import { requestClient, privateHeaders, serverConfig } from "../../../../../lib/supabase/server";
import { WorkflowError } from "../../../../../features/investigation-coordinator/contracts";
import { isId, userScope } from "../../../../../features/chat-attachments/contracts";
import { attachmentFailure, userImage } from "../../../../../features/chat-attachments/server";
export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    if (request.headers.has("authorization") || request.headers.has("range"))
      throw new WorkflowError("FORBIDDEN");
    const origin = request.headers.get("origin");
    if (
      (origin && origin !== serverConfig().origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new WorkflowError("UNSAFE_ORIGIN");
    const { id } = await context.params;
    if (!isId(id)) throw new WorkflowError("INVALID_BODY");
    const url = new URL(request.url);
    if ([...url.searchParams.keys()].some((k) => k !== "roomId" && k !== "expectedUserId"))
      throw new WorkflowError("INVALID_BODY");
    const scope = userScope({
      protocol: 1,
      roomId: url.searchParams.get("roomId"),
      expectedUserId: url.searchParams.get("expectedUserId"),
    });
    session = await requestClient();
    const image = await userImage(session.client, scope, id);
    // Copy only refreshed session cookies from the standard session response.
    const refreshed = session.finish({ ok: true });
    const headers = new Headers(refreshed.headers);
    headers.set("Content-Type", image.descriptor.mime);
    headers.set("Content-Length", String(image.bytes.length));
    headers.set("X-Content-SHA256", image.descriptor.sha256);
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(new Uint8Array(image.bytes), { headers });
  } catch (error) {
    const result = attachmentFailure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
