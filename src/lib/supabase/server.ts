import "server-only";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AccessError, errorStatus } from "../../features/room-access/contracts";

export function serverConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const origin = process.env.APP_ORIGIN;
  if (!url || !key || !origin || key.startsWith("sb_secret_")) throw new AccessError("UNAVAILABLE");
  // Accept a publishable key or the legacy anon JWT, never an admin/service key.
  if (!key.startsWith("sb_publishable_")) {
    try {
      const claims = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString("utf8"));
      if (claims.role !== "anon") throw new Error();
    } catch {
      throw new AccessError("UNAVAILABLE");
    }
  }
  try {
    const app = new URL(origin);
    const provider = new URL(url);
    if (
      app.origin !== origin ||
      !["http:", "https:"].includes(app.protocol) ||
      !["http:", "https:"].includes(provider.protocol)
    )
      throw new Error();
  } catch {
    throw new AccessError("UNAVAILABLE");
  }
  return { url, key, origin, secure: origin.startsWith("https://") };
}
export function privateHeaders<T extends Response>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("Expires", "0");
  response.headers.set("Vary", "Cookie, Origin");
  return response;
}
export async function requestClient() {
  const config = serverConfig();
  const jar = await cookies();
  const refreshHeaders = new Headers();
  const writes = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const base = `sb-${new URL(config.url).hostname.split(".")[0]}-auth-token`;
  const isAuthCookie = (name: string) => name === base || name.startsWith(`${base}.`);
  const options = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: config.secure };
  let explicitLogout = false;
  function preserveSessionCookies() {
    // Keep cleanup paired with a completed same-identity refresh. A failed refresh
    // may only delete cookies; retain the original browser identity in that case.
    if (
      [...writes.values()].some(
        (cookie) => isAuthCookie(cookie.name) && cookie.value && cookie.options.maxAge !== 0,
      )
    )
      return;
    for (const [name, cookie] of writes) {
      if (isAuthCookie(name) && (!cookie.value || cookie.options.maxAge === 0)) writes.delete(name);
    }
  }
  const client = createServerClient(config.url, config.key, {
    cookieOptions: options,
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (values, headers) => {
        for (const [name, value] of Object.entries(headers)) refreshHeaders.set(name, value);
        for (const value of values)
          writes.set(value.name, { ...value, options: { ...value.options, ...options } });
      },
    },
  });
  return {
    client,
    hasAuthCookies: jar.getAll().some((cookie) => isAuthCookie(cookie.name) && !!cookie.value),
    preserveSessionCookies,
    clearSessionCookies() {
      explicitLogout = true;
      // Include all old chunks and chunks created by this request's refresh.
      for (const name of new Set([...jar.getAll().map((c) => c.name), ...writes.keys(), base])) {
        if (
          name === base ||
          name.startsWith(`${base}.`) ||
          name === `${base}-code-verifier` ||
          name.startsWith(`${base}-code-verifier.`)
        ) {
          writes.set(name, {
            name,
            value: "",
            options: { ...options, maxAge: 0, expires: new Date(0) },
          });
        }
      }
    },
    finish(data: unknown, status = 200) {
      if (status >= 400 && !explicitLogout) preserveSessionCookies();
      const response = privateHeaders(NextResponse.json(data, { status }));
      refreshHeaders.forEach((value, name) => response.headers.set(name, value));
      for (const cookie of writes.values())
        response.cookies.set(cookie.name, cookie.value, cookie.options);
      return response;
    },
  };
}
export function failure(error: unknown) {
  const code = error instanceof AccessError ? error.code : "UNAVAILABLE";
  return { body: { ok: false as const, error: { code } }, status: errorStatus[code] };
}
