import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as diagnostics from "../../src/features/investigation-coordinator/run-diagnostics-contracts.ts";
import { callRunDiagnostics } from "../../src/features/investigation-coordinator/run-diagnostics-client.ts";
import { readJsonBody } from "../../src/lib/http/read-json-body.ts";
const userId = "00000000-0000-4000-8000-000000000001",
  roomId = "00000000-0000-4000-8000-000000000002",
  requestId = "00000000-0000-4000-8000-000000000003";
const body: diagnostics.RunDiagnosticsRequest = {
  protocol: 1,
  expectedUserId: userId,
  roomId,
  requestIds: [requestId],
};
const data = {
  protocol: 1,
  roomId,
  diagnostics: [
    { requestId, deadline: "2030-01-01T00:00:00Z", stopReason: null, stopObservedAt: null },
  ],
};
function load(path: string, replacements: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name: string) => {
        if (name === "server-only") return {};
        if (name in replacements) return replacements[name];
        throw Error(`Unexpected dependency: ${name}`);
      },
    },
  );
  return exports;
}
test("should authenticate expected identity before calling the isolated diagnostic RPC", async () => {
  const loadedService = load("src/features/investigation-coordinator/run-diagnostics-service.ts", {
    "./contracts": contracts,
    "./run-diagnostics-contracts": diagnostics,
    "../room-access/team-entry-policy": { retryableAuthFailure: () => false },
  });
  const read = loadedService.readRunDiagnostics as (
    client: unknown,
    body: diagnostics.RunDiagnosticsRequest,
  ) => Promise<unknown>;
  let calls = 0;
  const client = (id: string | null, error: unknown = null) => ({
    auth: { getUser: async () => ({ data: { user: id ? { id } : null }, error: null }) },
    rpc: async (name: string, params: unknown) => {
      calls++;
      assert.equal(name, "workflow_human_run_diagnostics");
      assert.deepEqual(JSON.parse(JSON.stringify(params)), { p_body: body });
      return { data, error };
    },
  });
  await assert.rejects(read(client(null), body), { code: "UNAUTHENTICATED" });
  await assert.rejects(read(client(roomId), body), { code: "FORBIDDEN" });
  assert.equal(calls, 0);
  assert.deepEqual(await read(client(userId), body), data);
  await assert.rejects(
    read(client(userId, { code: "P0001", message: "FORBIDDEN", detail: "private" }), body),
    { code: "FORBIDDEN" },
  );
  await assert.rejects(read(client(userId, { code: "OTHER", message: "private" }), body), {
    code: "UNAVAILABLE",
  });
});
test("should reject unsafe origins and oversized bodies before session or diagnostic reads", async () => {
  let sessions = 0,
    calls = 0;
  const privateHeaders = (response: Response) => {
    response.headers.set("cache-control", "private, no-store");
    return response;
  };
  const loadedRoute = load("src/app/api/run-diagnostics/route.ts", {
    "next/server": {
      NextResponse: { json: (value: unknown, init: ResponseInit) => Response.json(value, init) },
    },
    "../../../lib/supabase/server": {
      serverConfig: () => ({ origin: "https://example.test" }),
      privateHeaders,
      requestClient: async () => {
        sessions++;
        return {
          client: {},
          finish: (value: unknown, status = 200) =>
            privateHeaders(Response.json(value, { status })),
        };
      },
    },
    "../../../lib/http/read-json-body": { readJsonBody },
    "../../../features/investigation-coordinator/contracts": contracts,
    "../../../features/investigation-coordinator/service": {
      workflowFailure: (error: unknown) => {
        const code = error instanceof contracts.WorkflowError ? error.code : "UNAVAILABLE";
        return { status: contracts.errorStatus[code], body: { ok: false, error: { code } } };
      },
    },
    "../../../features/investigation-coordinator/run-diagnostics-contracts": diagnostics,
    "../../../features/investigation-coordinator/run-diagnostics-service": {
      readRunDiagnostics: async () => {
        calls++;
        return data;
      },
    },
  });
  const post = loadedRoute.POST as (request: Request) => Promise<Response>;
  const request = (text: string, origin = "https://example.test") =>
    new Request("https://example.test/api/run-diagnostics", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: text,
    });
  assert.equal((await post(request(JSON.stringify(body), "https://foreign.test"))).status, 403);
  assert.equal(
    (await post(request(" ".repeat(16385)))).status,
    contracts.errorStatus.BODY_TOO_LARGE,
  );
  assert.equal(
    (await post(request(JSON.stringify({ ...body, requestIds: [requestId, requestId] })))).status,
    400,
  );
  assert.equal(sessions, 0);
  assert.equal(calls, 0);
  const result = await post(request(JSON.stringify(body)));
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control")!, /private.*no-store/);
  assert.equal(calls, 1);
});
test("should bound diagnostic streams and reject foreign response identities", async (t) => {
  let response = () => Response.json({ ok: true, data });
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return response();
  });
  assert.deepEqual(await callRunDiagnostics(body, new AbortController().signal), data);
  response = () => Response.json({ ok: true, data: { ...data, roomId: userId } });
  await assert.rejects(callRunDiagnostics(body, new AbortController().signal), {
    code: "UNAVAILABLE",
  });
  response = () =>
    new Response(" ".repeat(diagnostics.RUN_DIAGNOSTICS_BYTES + 1), {
      headers: { "content-type": "application/json" },
    });
  await assert.rejects(callRunDiagnostics(body, new AbortController().signal), {
    code: "UNAVAILABLE",
  });
});
