import { NextResponse } from "next/server";
import { requestClient, privateHeaders, serverConfig } from "../../../../lib/supabase/server";
import { readJsonBody } from "../../../../lib/http/read-json-body";
import { WorkflowError } from "../../../../features/investigation-coordinator/contracts";
import { workflowBearer } from "../../../../features/investigation-coordinator/request-policy";
import {
  authenticatedRpc,
  attachmentFailure,
  deviceImage,
  storeUserImage,
  reportImageCapability,
} from "../../../../features/chat-attachments/server";
import {
  deviceDownloadBody,
  readBody,
  userScope,
  capabilityBody,
} from "../../../../features/chat-attachments/contracts";
import { readImageBytes } from "../../../../features/chat-attachments/validation";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (action === "capability") {
      if (request.headers.has("cookie") || request.headers.has("origin"))
        throw new WorkflowError("FORBIDDEN");
      const secret = workflowBearer(request);
      const body = capabilityBody(
        await readJsonBody(request, { error: (code) => new WorkflowError(code), utf8: "strict" }),
      );
      return privateHeaders(
        NextResponse.json({ ok: true, data: await reportImageCapability(body, secret) }),
      );
    }
    if (action === "device-download") {
      if (
        request.headers.has("cookie") ||
        request.headers.has("origin") ||
        request.headers.has("range")
      )
        throw new WorkflowError("FORBIDDEN");
      const secret = workflowBearer(request);
      const body = deviceDownloadBody(
        await readJsonBody(request, { error: (code) => new WorkflowError(code), utf8: "strict" }),
      );
      const image = await deviceImage(body, secret);
      return new Response(new Uint8Array(image.bytes), {
        headers: {
          "Content-Type": image.descriptor.mime,
          "Content-Length": String(image.bytes.length),
          "X-Content-SHA256": image.descriptor.sha256,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store, max-age=0",
          Vary: "Authorization",
        },
      });
    }
    if (action !== "upload" && action !== "read" && action !== "capabilities")
      throw new WorkflowError("NOT_FOUND");
    if (request.headers.has("authorization")) throw new WorkflowError("FORBIDDEN");
    if (request.headers.get("origin") !== serverConfig().origin)
      throw new WorkflowError("UNSAFE_ORIGIN");
    session = await requestClient();
    if (action === "upload") {
      const scope = userScope({
        protocol: 1,
        roomId: request.headers.get("x-room-id"),
        expectedUserId: request.headers.get("x-expected-user-id"),
      });
      // Validate session and membership before consuming the bounded binary body.
      const rpc = await authenticatedRpc(session.client, scope.expectedUserId);
      await rpc("chat_attachment_authorize_upload", { p_body: scope });
      const image = await storeUserImage(
        session.client,
        scope,
        await readImageBytes(request),
        request.headers.get("content-type") ?? "",
      );
      return session.finish({ ok: true, data: image });
    }
    const input = await readJsonBody(request, {
      expectedOrigin: serverConfig().origin,
      error: (code) => new WorkflowError(code),
      utf8: "strict",
    });
    const body = action === "capabilities" ? userScope(input) : readBody(input);
    const rpc = await authenticatedRpc(session.client, body.expectedUserId);
    return session.finish({
      ok: true,
      data: await rpc(
        action === "capabilities" ? "chat_attachment_capabilities" : "chat_attachment_read",
        { p_body: body },
      ),
    });
  } catch (error) {
    const result = attachmentFailure(error);
    return session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
  }
}
