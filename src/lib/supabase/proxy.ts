import "server-only";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { privateHeaders, serverConfig } from "./server";
import { retryableAuthFailure } from "../../features/room-access/team-entry-policy";

export async function updateSession(request: NextRequest) {
  // Every API gateway validates Origin/body before its own Auth read and owns the
  // final refresh/error/logout cookies. Avoid a competing refresh in the proxy.
  if (request.nextUrl.pathname.startsWith("/api/")) return privateHeaders(NextResponse.next());
  let config: ReturnType<typeof serverConfig>;
  try {
    config = serverConfig();
  } catch {
    return privateHeaders(
      new NextResponse("서비스를 준비 중입니다. 잠시 뒤 다시 시도하세요.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
  }
  const login = new URL("/login", config.origin);
  const invite =
    request.nextUrl.pathname === "/app" ? request.nextUrl.searchParams.get("invite") : null;
  if (invite && /^[a-f0-9]{64}$/.test(invite)) login.searchParams.set("invite", invite);
  let response = NextResponse.next({ request });
  let forward = true;
  const refreshHeaders = new Headers();
  const updates = new Map<
    string,
    { name: string; value: string; options: import("@supabase/ssr").CookieOptions }
  >();
  const options = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: config.secure };
  const client = createServerClient(config.url, config.key, {
    cookieOptions: options,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        for (const [name, value] of Object.entries(headers)) refreshHeaders.set(name, value);
        for (const value of values)
          updates.set(value.name, { ...value, options: { ...value.options, ...options } });
      },
    },
  });
  const current = await client.auth.getUser().catch(() => null);
  const user = current?.data.user;
  const error = current?.error;
  const authFailed = !current || !!error || !user;
  if (request.nextUrl.pathname.startsWith("/app") && authFailed) {
    forward = false;
    response =
      !current || retryableAuthFailure(error)
        ? new NextResponse("접속을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.", { status: 503 })
        : NextResponse.redirect(login);
  } else if (request.nextUrl.pathname.startsWith("/app") && user) {
    let admitted;
    try {
      admitted = await client.rpc("team_entry_status");
    } catch {
      admitted = null;
    }
    if (!admitted || admitted.error) {
      forward = false;
      response = new NextResponse("접속을 확인하지 못했습니다. 잠시 뒤 다시 시도하세요.", {
        status: 503,
      });
    } else if (!admitted.data?.admitted) {
      forward = false;
      response = NextResponse.redirect(login);
    }
  }
  const replacement = [...updates.values()].some(
    (cookie) => cookie.value && cookie.options.maxAge !== 0,
  );
  const accepted = [...updates.values()].filter(
    (cookie) => !(authFailed && !replacement && (!cookie.value || cookie.options.maxAge === 0)),
  );
  // Apply only accepted updates to both the forwarded request and the response.
  // A failed refresh must never erase the identity seen by the downstream page.
  if (forward) {
    for (const cookie of accepted) request.cookies.set(cookie.name, cookie.value);
    response = NextResponse.next({ request });
  }
  for (const cookie of accepted) response.cookies.set(cookie.name, cookie.value, cookie.options);
  privateHeaders(response);
  refreshHeaders.forEach((value, name) => response.headers.set(name, value));
  return response;
}
