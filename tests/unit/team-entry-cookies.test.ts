import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/room-access/contracts.ts";

type Cookie = {
  name: string;
  value: string;
  options: {
    maxAge?: number;
    httpOnly?: boolean;
    sameSite?: string;
    path?: string;
    secure?: boolean;
  };
};
type Session = {
  hasAuthCookies: boolean;
  preserveSessionCookies(): void;
  clearSessionCookies(): void;
  finish(data: unknown, status?: number): Response & { cookies: Map<string, Cookie> };
};
const base = "sb-127-auth-token";
async function fixture(initial: Array<{ name: string; value: string }>) {
  let update: (values: Cookie[], headers: Record<string, string>) => void = () => {
    throw new Error("Cookie adapter not initialized");
  };
  const exported: { requestClient?: () => Promise<Session> } = {};
  class CookieJar extends Map<string, Cookie> {
    override set(name: string, value: Cookie | string, options?: Cookie["options"]): this {
      return super.set(
        name,
        typeof value === "string" ? { name, value, options: options ?? {} } : value,
      );
    }
  }
  class FakeResponse extends Response {
    cookies = new CookieJar();
    static json(data: unknown, options: ResponseInit) {
      return new FakeResponse(JSON.stringify(data), options);
    }
  }
  runInNewContext(
    ts.transpileModule(readFileSync("src/lib/supabase/server.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: exported,
      URL,
      Buffer,
      Headers,
      Date,
      process: {
        env: {
          SUPABASE_URL: "http://127.0.0.1:56321",
          SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
          APP_ORIGIN: "http://127.0.0.1:4318",
        },
      },
      require(name: string) {
        if (name === "server-only") return {};
        if (name === "@supabase/ssr")
          return {
            createServerClient(
              _url: string,
              _key: string,
              options: { cookies: { setAll: typeof update } },
            ) {
              update = options.cookies.setAll;
              return {};
            },
          };
        if (name === "next/headers") return { cookies: async () => ({ getAll: () => initial }) };
        if (name === "next/server") return { NextResponse: FakeResponse };
        if (name === "../../features/room-access/contracts") return contracts;
        throw new Error("Unexpected server dependency");
      },
    },
  );
  assert.ok(exported.requestClient);
  const session = await exported.requestClient();
  return {
    session,
    update(values: Cookie[]) {
      update(values, {});
    },
  };
}
for (const status of [500, 503, 429])
  test(`should retain existing Auth chunks after deletion-only refresh failure ${status}`, async () => {
    const f = await fixture([
      { name: base + ".0", value: "original-a" },
      { name: base + ".1", value: "original-b" },
    ]);
    assert.equal(f.session.hasAuthCookies, true);
    f.update([
      { name: base + ".0", value: "", options: { maxAge: 0 } },
      { name: base + ".1", value: "", options: { maxAge: 0 } },
    ]);
    const response = f.session.finish({ ok: false }, status);
    assert.equal(response.cookies.size, 0);
    assert.equal(response.status, status);
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/);
  });
test("should preserve completed same-identity refresh and remove its stale chunks", async () => {
  const f = await fixture([
    { name: base + ".0", value: "old-a" },
    { name: base + ".1", value: "old-b" },
  ]);
  f.update([
    { name: base + ".0", value: "", options: { maxAge: 0 } },
    { name: base + ".1", value: "", options: { maxAge: 0 } },
    { name: base, value: "refreshed", options: { maxAge: 3600 } },
  ]);
  f.session.preserveSessionCookies();
  const response = f.session.finish({ ok: true });
  assert.equal(response.cookies.size, 3);
  assert.equal(response.cookies.get(base)?.value, "refreshed");
  assert.equal(response.cookies.get(base + ".1")?.options.maxAge, 0);
  for (const cookie of response.cookies.values()) {
    assert.equal(cookie.options.httpOnly, true);
    assert.equal(cookie.options.sameSite, "lax");
    assert.equal(cookie.options.path, "/");
  }
});
test("should clear every original and refreshed Auth chunk on explicit logout", async () => {
  const f = await fixture([
    { name: base + ".0", value: "old-a" },
    { name: base + ".7", value: "old-b" },
    { name: base + "-code-verifier.0", value: "legacy-verifier" },
    { name: "unrelated", value: "keep" },
  ]);
  f.update([{ name: base + ".2", value: "refreshed", options: {} }]);
  f.session.clearSessionCookies();
  const response = f.session.finish({ ok: true });
  for (const name of [base, base + ".0", base + ".7", base + ".2", base + "-code-verifier.0"]) {
    assert.equal(response.cookies.get(name)?.value, "");
    assert.equal(response.cookies.get(name)?.options.maxAge, 0);
  }
  assert.equal(response.cookies.has("unrelated"), false);
});
test("should distinguish a verifier cookie from an existing Auth identity", async () => {
  const f = await fixture([{ name: base + "-code-verifier", value: "legacy-verifier" }]);
  assert.equal(f.session.hasAuthCookies, false);
});
