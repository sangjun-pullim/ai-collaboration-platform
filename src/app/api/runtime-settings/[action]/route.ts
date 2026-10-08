import { NextResponse } from "next/server";
import { requestClient, privateHeaders } from "../../../../lib/supabase/server";
import {
  humanActions,
  deviceActions,
  SettingsError,
  type HumanAction,
  type DeviceAction,
} from "../../../../features/runtime-settings/contracts";
import { readSettings, settingsBearer } from "../../../../features/runtime-settings/request-policy";
import {
  humanSettings,
  deviceSettings,
  settingsFailure,
} from "../../../../features/runtime-settings/service";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  let session: Awaited<ReturnType<typeof requestClient>> | undefined;
  try {
    const { action } = await context.params;
    const human = humanActions.includes(action as HumanAction);
    if (!human && !deviceActions.includes(action as DeviceAction))
      throw new SettingsError("NOT_FOUND");
    const body = await readSettings(request, action as HumanAction | DeviceAction, human);
    if (human) {
      session = await requestClient();
      return session.finish({
        ok: true,
        data: await humanSettings(session.client, action as HumanAction, body),
      });
    }
    const response = privateHeaders(
      NextResponse.json({
        ok: true,
        data: await deviceSettings(action as DeviceAction, body, settingsBearer(request)),
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
