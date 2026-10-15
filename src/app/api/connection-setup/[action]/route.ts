import { NextResponse } from "next/server";
import { requestClient, privateHeaders, serverConfig } from "../../../../lib/supabase/server";
import { readJsonBody } from "../../../../lib/http/read-json-body";
import { SettingsError } from "../../../../features/runtime-settings/contracts";
import { settingsFailure } from "../../../../features/runtime-settings/service";
import {
  setupActions,
  validateSetupBody,
  setupBearer,
  type SetupAction,
} from "../../../../features/connection-setup/contracts";
import { humanSetup, publicSetup } from "../../../../features/connection-setup/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    if (!setupActions.includes(action as SetupAction)) throw new SettingsError("NOT_FOUND");
    const human = action === "issue" || action === "inspect";
    if (
      (human && request.headers.has("authorization")) ||
      (!human && request.headers.has("cookie"))
    )
      throw new SettingsError("FORBIDDEN");
    const input = await readJsonBody(request, {
      expectedOrigin: human ? serverConfig().origin : undefined,
      error: (code) => new SettingsError(code),
      utf8: "strict",
    });
    const body = validateSetupBody(action as SetupAction, input);
    if (human) {
      session = await requestClient();
      return session.finish({ ok: true, data: await humanSetup(session.client, action, body) });
    }
    const response = privateHeaders(
      NextResponse.json({
        ok: true,
        data: await publicSetup(action as SetupAction, body, setupBearer(request)),
      }),
    );
    response.headers.set("Vary", "Authorization");
    return response;
  } catch (error) {
    const result = settingsFailure(error);
    const response = session
      ? session.finish(result.body, result.status)
      : privateHeaders(NextResponse.json(result.body, { status: result.status }));
    response.headers.set("Vary", "Cookie, Origin, Authorization");
    return response;
  }
}
