import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as realtime from "../../src/features/investigation-coordinator/realtime-contracts.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body: realtime.RealtimeBody = {
  protocol: 1,
  roomId: id(1),
  expectedUserId: id(2),
  clientId: id(3),
};
function fixture() {
  let originalUser = id(2),
    tokenUser = id(2),
    rpcCalls = 0;
  let pinned = "";
  const token = `synthetic.${Buffer.from(JSON.stringify({ sub: id(2), session_id: id(9), exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  const client = {
    auth: {
      getUser: async (jwt?: string) => ({
        data: { user: { id: jwt ? tokenUser : originalUser } },
        error: null,
      }),
      getSession: async () => ({
        data: { session: { access_token: token, refresh_token: "MUST_NOT_BE_RETURNED" } },
        error: null,
      }),
    },
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/investigation-coordinator/realtime-service.ts", "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      exports,
      Buffer,
      Date,
      process: { env: {} },
      require(name: string) {
        if (name === "server-only") return {};
        if (name === "./contracts") return contracts;
        if (name === "./realtime-contracts") return realtime;
        if (name === "../../lib/supabase/server")
          return { serverConfig: () => ({ url: "http://127.0.0.1:54321", key: "synthetic-anon" }) };
        if (name === "@supabase/supabase-js")
          return {
            createClient: (
              _url: unknown,
              _key: unknown,
              options: { accessToken: () => Promise<string>; auth: unknown },
            ) => ({
              rpc: async () => {
                rpcCalls++;
                pinned = await options.accessToken();
                assert.deepEqual(JSON.parse(JSON.stringify(options.auth)), {
                  persistSession: false,
                  autoRefreshToken: false,
                  detectSessionInUrl: false,
                });
                return {
                  data: {
                    protocol: 1,
                    roomId: body.roomId,
                    userId: body.expectedUserId,
                    clientId: body.clientId,
                    leaseId: id(4),
                    topic: `chat-lease:${"a".repeat(64)}`,
                    expiresAt: new Date(Date.now() + 300_000).toISOString(),
                  },
                  error: null,
                };
              },
            }),
          };
        throw new Error(`Unexpected realtime service dependency ${name}`);
      },
    },
  );
  const call = exports.chatRealtime as (
    client: unknown,
    action: "authorize" | "release",
    body: realtime.RealtimeBody,
  ) => Promise<unknown>;
  return {
    call: () => call(client, "authorize", body),
    wrongActor: () => {
      originalUser = id(5);
    },
    wrongToken: () => {
      tokenUser = id(5);
    },
    rpcCalls: () => rpcCalls,
    pinned: () => pinned,
    token,
  };
}
test("should pin lease RPC to a twice-verified user access token and return no refresh token or session", async () => {
  const f = fixture();
  const result = (await f.call()) as realtime.RealtimeGrant;
  assert.equal(f.rpcCalls(), 1);
  assert.equal(f.pinned(), f.token);
  assert.equal(result.accessToken, f.token);
  assert.equal(Object.hasOwn(result, "session"), false);
  assert.equal(JSON.stringify(result).includes("MUST_NOT_BE_RETURNED"), false);
});
test("should reject actor or refreshed-token identity mismatch before lease RPC", async () => {
  const actor = fixture();
  actor.wrongActor();
  await assert.rejects(actor.call(), { code: "FORBIDDEN" });
  assert.equal(actor.rpcCalls(), 0);
  const token = fixture();
  token.wrongToken();
  await assert.rejects(token.call(), { code: "UNAUTHENTICATED" });
  assert.equal(token.rpcCalls(), 0);
});
