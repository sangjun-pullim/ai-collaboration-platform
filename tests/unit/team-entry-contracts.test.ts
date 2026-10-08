import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/room-access/contracts.ts";

type Entry = { userId: string; displayName: string };
type Session = { client: unknown; hasAuthCookies: boolean; preserveSessionCookies(): void };
type Service = { enterTeam(session: Session, body: Record<string, string>): Promise<Entry> };
function load(path: string, dependencies: Record<string, unknown>) {
  const exports = {};
  runInNewContext(
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      Date,
      require(name: string) {
        if (name === "server-only") return {};
        if (name === "./contracts") return contracts;
        if (Object.hasOwn(dependencies, name)) return dependencies[name];
        throw new Error(`Unexpected dependency: ${name}`);
      },
    },
  );
  return exports;
}
function service() {
  const policy = load("src/features/room-access/team-entry-policy.ts", {});
  return load("src/features/room-access/team-entry-service.ts", {
    "./team-entry-policy": policy,
  }) as Service;
}
const id = "00000000-0000-4000-8000-000000000001";
const body = { code: " synthetic code ", displayName: "테스트" };
function fixture(error: unknown, hasAuthCookies = true) {
  const calls = { signup: 0, preserve: 0, admit: 0 };
  const session = {
    hasAuthCookies,
    preserveSessionCookies() {
      calls.preserve++;
    },
    client: {
      auth: {
        async getUser() {
          return { data: { user: error ? null : { id } }, error };
        },
        async signInAnonymously() {
          calls.signup++;
          return { data: { user: { id } }, error: null };
        },
      },
      async rpc(name: string, input: Record<string, string>) {
        assert.equal(name, "team_entry_admit");
        assert.equal(input.p_code, body.code);
        calls.admit++;
        return {
          data: {
            ok: true,
            userId: id,
            displayName: body.displayName,
            access_token: "must-not-project",
          },
          error: null,
        };
      },
    },
  };
  return { calls, session };
}
function code(expected: string) {
  return (error: unknown) => error instanceof contracts.AccessError && error.code === expected;
}
test("should create an identity only for confirmed missing session without cookies", async () => {
  const f = fixture({ name: "AuthSessionMissingError", status: 400 }, false);
  const result = await service().enterTeam(f.session, body);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    userId: id,
    displayName: body.displayName,
  });
  assert.equal(f.calls.signup, 1);
});
test("should preserve an existing identity when the display name changes", async () => {
  const f = fixture(null);
  await service().enterTeam(f.session, body);
  assert.equal(f.calls.signup, 0);
  assert.equal(f.calls.admit, 1);
});
for (const failure of [
  { name: "AuthRetryableFetchError", status: 503 },
  { name: "AuthApiError", status: 500 },
  { name: "AuthApiError", status: 429 },
  { name: "AbortError" },
  { name: "TimeoutError" },
])
  test(`should retain cookies and avoid signup on ${failure.name} ${"status" in failure ? failure.status : "timeout"}`, async () => {
    const f = fixture(failure);
    await assert.rejects(service().enterTeam(f.session, body), code("UNAVAILABLE"));
    assert.equal(f.calls.signup, 0);
    assert.equal(f.calls.admit, 0);
    assert.ok(f.calls.preserve > 0);
    f.session.client.auth.getUser = async () => ({ data: { user: { id } }, error: null });
    assert.equal((await service().enterTeam(f.session, body)).userId, id);
    assert.equal(f.calls.signup, 0);
  });
for (const reason of ["session_not_found", "user_banned", "user_not_found"])
  test(`should reject ${reason} without replacing the identity`, async () => {
    const f = fixture({ name: "AuthApiError", status: 401, code: reason });
    await assert.rejects(service().enterTeam(f.session, body), code("UNAUTHENTICATED"));
    assert.equal(f.calls.signup, 0);
    assert.equal(f.calls.admit, 0);
  });
test("should require explicit logout for a cookie with missing SDK session", async () => {
  const f = fixture({ name: "AuthSessionMissingError", status: 400 }, true);
  await assert.rejects(service().enterTeam(f.session, body), code("UNAUTHENTICATED"));
  assert.equal(f.calls.signup, 0);
});
test("should reject a mismatched admission identity", async () => {
  const f = fixture(null);
  f.session.client.rpc = async () => ({
    data: {
      ok: true,
      userId: "00000000-0000-4000-8000-000000000002",
      displayName: body.displayName,
      access_token: "",
    },
    error: null,
  });
  await assert.rejects(service().enterTeam(f.session, body), code("UNAVAILABLE"));
  assert.equal(f.calls.signup, 0);
});
test("should bound new anonymous signup bursts before contacting the provider", async () => {
  const s = service(),
    f = fixture({ name: "AuthSessionMissingError", status: 400 }, false);
  for (let i = 0; i < 10; i++) await s.enterTeam(f.session, body);
  await assert.rejects(s.enterTeam(f.session, body), code("CODE_COOLDOWN"));
  assert.equal(f.calls.signup, 10);
});
