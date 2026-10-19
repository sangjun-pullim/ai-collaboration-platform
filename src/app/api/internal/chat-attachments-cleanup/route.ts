import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { cleanupImages } from "../../../../features/chat-attachments/cleanup";
import {
  PrivateImageStorage,
  storageAdminRpc,
} from "../../../../features/chat-attachments/storage";
export const runtime = "nodejs";
export const maxDuration = 15;
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization") ?? "";
  const expected = secret ? `Bearer ${secret}` : "";
  const headers = { "Cache-Control": "private, no-store, max-age=0" };
  if (
    !secret ||
    Buffer.byteLength(provided) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  )
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers },
    );
  try {
    return NextResponse.json(
      { ok: true, data: await cleanupImages(storageAdminRpc, new PrivateImageStorage()) },
      { headers },
    );
  } catch {
    return NextResponse.json(
      { ok: false, error: { code: "UNAVAILABLE" } },
      { status: 503, headers },
    );
  }
}
