import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { createServerClient } from "@supabase/ssr";
import ts from "typescript";

const require = createRequire(import.meta.url);
const next = require("next/server");
const id = "00000000-0000-4000-8000-000000000001";
const base = "sb-127-auth-token";
function token(exp: number) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ sub: id, role: "authenticated", aud: "authenticated", exp }),
    ).toString("base64url"),
    Buffer.from("synthetic-signature").toString("base64url"),
  ].join(".");
}
function session(exp: number) {
  return {
    access_token: token(exp),
    refresh_token: "synthetic-owned-refresh",
    token_type: "bearer",
    expires_at: exp,
    expires_in: 3600,
    user: {
      id,
      aud: "authenticated",
      role: "authenticated",
      email: "owned@example.test",
      created_at: "2026-01-01T00:00:00Z",
      is_anonymous: true,
    },
  };
}
function harness() {
  const expired = session(Math.floor(Date.now() / 1000) - 3600);
  const initial = [
    { name: base, value: "base64-" + Buffer.from(JSON.stringify(expired)).toString("base64url") },
  ];
  const calls = { refresh: 0, signup: 0, user: 0 };
  let failing = true;
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    assert.equal(url.origin, "http://127.0.0.1:56321");
    if (url.pathname === "/auth/v1/signup") {
      calls.signup++;
      throw new Error("Unexpected signup");
    }
    if (url.pathname === "/auth/v1/token") {
      calls.refresh++;
      return failing
        ? Response.json(
            { message: "Synthetic rate limit", code: "over_request_rate_limit" },
            { status: 429 },
          )
        : Response.json(session(Math.floor(Date.now() / 1000) + 3600));
    }
    if (url.pathname === "/auth/v1/user") {
      calls.user++;
      return Response.json(session(0).user);
    }
    if (url.pathname === "/rest/v1/rpc/team_entry_status")
      return Response.json({ admitted: true, userId: id, displayName: "동료" });
    throw new Error("Unexpected provider request");
  };
  const cache = new Map<string, Record<string, unknown>>();
  function load(path: string): Record<string, unknown> {
    const file = resolve(path);
    const cached = cache.get(file);
    if (cached) return cached;
    const exports: Record<string, unknown> = {};
    cache.set(file, exports);
    runInNewContext(
      ts.transpileModule(readFileSync(file, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        Buffer,
        URL,
        Date,
        Headers,
        Request,
        Response,
        AbortController,
        TextEncoder,
        TextDecoder,
        setTimeout,
        clearTimeout,
        process: {
          env: {
            SUPABASE_URL: "http://127.0.0.1:56321",
            SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
            APP_ORIGIN: "http://127.0.0.1:4318",
          },
        },
        require(name: string) {
          if (name === "server-only") return {};
          if (name === "next/server") return next;
          if (name === "next/headers") return { cookies: async () => ({ getAll: () => initial }) };
          if (name === "@supabase/ssr")
            return {
              createServerClient: (
                url: string,
                key: string,
                options: Parameters<typeof createServerClient>[2],
              ) => createServerClient(url, key, { ...options, global: { fetch } }),
            };
          if (name.startsWith("."))
            return load(resolve(dirname(file), name.replace(/\.(?:js|ts)$/, "")) + ".ts");
          return require(name);
        },
      },
    );
    return exports;
  }
  return {
    initial,
    calls,
    load,
    recover() {
      failing = false;
    },
  };
}
for (const kind of ["connections", "investigations"] as const)
  test(`should retain the same identity after an actual SDK refresh429 in ${kind} API`, async () => {
    const h = harness();
    const route = h.load(`src/app/api/${kind}/[action]/route.ts`) as {
      POST(request: Request, context: { params: Promise<{ action: string }> }): Promise<Response>;
    };
    const action = kind === "connections" ? "revoke" : "speak";
    const body =
      kind === "connections"
        ? { deviceId: id }
        : { protocol: 1, roomId: id, operationId: id, publicText: "질문" };
    const request = new Request(`http://127.0.0.1:4318/api/${kind}/${action}`, {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:4318", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const before = JSON.stringify(h.initial);
    const response = await route.POST(request, { params: Promise.resolve({ action }) });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: { code: "UNAVAILABLE" } });
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.ok(JSON.stringify(h.initial) === before, "Cookie jar must remain unchanged");
    assert.ok(h.calls.refresh > 0);
    assert.equal(h.calls.signup, 0);
    h.recover();
    const server = h.load("src/lib/supabase/server.ts") as {
      requestClient(): Promise<{ client: ReturnType<typeof createServerClient> }>;
    };
    const restored = await server.requestClient();
    const identity = await restored.client.auth.getUser();
    assert.equal(identity.error, null);
    assert.equal(identity.data.user?.id, id);
    assert.equal(h.calls.signup, 0);
  });
test("should let the API gateway own authentication without a competing proxy refresh", async () => {
  const h = harness();
  const proxy = h.load("src/lib/supabase/proxy.ts") as {
    updateSession(request: InstanceType<typeof next.NextRequest>): Promise<Response>;
  };
  const request = new next.NextRequest("http://127.0.0.1:4318/api/access/bootstrap", {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:4318", Cookie: `${base}=${h.initial[0].value}` },
  });
  const before = request.cookies.get(base)?.value;
  const response = await proxy.updateSession(request);
  assert.ok(
    request.cookies.get(base)?.value === before,
    "Forwarded Auth cookie must remain unchanged",
  );
  assert.equal(response.headers.getSetCookie().length, 0);
  assert.equal(h.calls.refresh, 0);
  assert.equal(h.calls.signup, 0);
});
