import "server-only";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { privateHeaders, serverConfig } from "./server";

export async function updateSession(request: NextRequest) {
  let config: ReturnType<typeof serverConfig>;
  try { config = serverConfig(); } catch {
    if (request.nextUrl.pathname.startsWith("/api/")) return privateHeaders(NextResponse.next());
    return privateHeaders(new NextResponse("서비스를 준비 중입니다. 잠시 뒤 다시 시도하세요.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
  }
  // A rejected mutation origin must not rotate or set Auth cookies in the proxy.
  if (request.nextUrl.pathname.startsWith("/api/") && request.method === "POST" && request.headers.get("origin") !== config.origin) {
    return privateHeaders(NextResponse.next());
  }
  let response = NextResponse.next({ request });
  const refreshHeaders = new Headers();
  const updates = new Map<string, { name: string; value: string; options: import("@supabase/ssr").CookieOptions }>();
  const options = { path: "/", httpOnly: true, sameSite: "lax" as const, secure: config.secure };
  const client = createServerClient(config.url, config.key, {
    cookieOptions: options,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        for (const [name, value] of Object.entries(headers)) refreshHeaders.set(name, value);
        for (const value of values) {
          request.cookies.set(value.name, value.value);
          updates.set(value.name, { ...value, options: { ...value.options, ...options } });
        }
        response = NextResponse.next({ request });
      },
    },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (request.nextUrl.pathname.startsWith("/app") && (!user || error)) {
    response = NextResponse.redirect(new URL("/login", config.origin));
  }
  // Logout owns the final deletion; do not attach a competing refreshed cookie.
  if (request.nextUrl.pathname !== "/api/auth/logout") {
    for (const cookie of updates.values()) response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  privateHeaders(response);
  refreshHeaders.forEach((value, name) => response.headers.set(name, value));
  return response;
}
