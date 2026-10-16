import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/device-binding/contracts.ts";
import * as statusContracts from "../../src/features/device-binding/connection-status-contracts.ts";
import { readJsonBody } from "../../src/lib/http/read-json-body.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const roomId = "00000000-0000-4000-8000-000000000002";
const deviceId = "00000000-0000-4000-8000-000000000003";
const agentId = "00000000-0000-4000-8000-000000000004";
const origin = "https://example.test";
const body = { expectedUserId: userId, roomId, deviceId };
const device = {
  deviceId,
  roomId,
  organizationId: userId,
  deviceAlias: "본인 Mac",
  state: "active",
  lastSeenAt: null,
  expiresAt: "2030-01-01T00:00:00.000Z",
  credential: "private-value",
};
function load(path: string, replacements: Record<string, unknown>) {
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(source, {
    exports,
    Date,
    require: (name: string) => {
      if (name === "server-only") return {};
      if (name in replacements) return replacements[name];
      throw new Error(`Unexpected connection status dependency: ${name}`);
    },
  });
  return exports;
}
function harness(
  options: {
    authId?: string | null;
    authError?: unknown;
    rooms?: readonly unknown[];
    devices?: readonly unknown[];
    rpcError?: unknown;
    execution?: unknown;
  } = {},
) {
  const calls: { name: string; params: Record<string, unknown> }[] = [];
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: options.authId === null ? null : { id: options.authId ?? userId } },
        error: options.authError ?? null,
      }),
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params });
      return name === "connection_list"
        ? {
            data: {
              rooms: options.rooms ?? [
                { roomId, organizationId: userId, roomTitle: "방", organizationName: "팀" },
              ],
              devices: options.devices ?? [device],
            },
            error: null,
          }
        : {
            data:
              options.execution === undefined
                ? { agentId, bindingEpoch: 7, failure: null, privateProof: "private-value" }
                : options.execution,
            error: options.rpcError ?? null,
          };
    },
  };
  const service = load("src/features/device-binding/service.ts", {
    "../room-access/team-entry-policy": { retryableAuthFailure: () => false },
    "./device-client": {},
    "../../lib/supabase/server": {},
    "./contracts": contracts,
    "./room-git-report": {},
    "./connection-status-contracts": statusContracts,
  });
  const connectionStatus = service.connectionStatus as (
    client: unknown,
    body: statusContracts.StatusRequest,
  ) => Promise<statusContracts.ConnectionStatus>;
  const policy = load("src/features/device-binding/request-policy.ts", {
    "../../lib/http/read-json-body": { readJsonBody },
    "../../lib/supabase/server": { serverConfig: () => ({ origin }) },
    "./contracts": contracts,
    "./connection-status-contracts": statusContracts,
  });
  let finished = 0;
  const privateHeaders = (response: Response) => {
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  };
  const route = load("src/app/api/connections/status/route.ts", {
    "next/server": {
      NextResponse: { json: (data: unknown, init: ResponseInit) => Response.json(data, init) },
    },
    "../../../../lib/supabase/server": {
      privateHeaders,
      requestClient: async () => ({
        client,
        finish: (data: unknown, status = 200) => {
          finished++;
          const response = privateHeaders(Response.json(data, { status }));
          response.headers.set("Set-Cookie", "refreshed=1; HttpOnly");
          return response;
        },
      }),
    },
    "../../../../features/device-binding/request-policy": policy,
    "../../../../features/device-binding/service": service,
  });
  const post = route.POST as (request: Request) => Promise<Response>;
  return {
    call: (input = body) => connectionStatus(client, input),
    post,
    calls,
    finished: () => finished,
  };
}
function request(input: unknown = body, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/connections/status`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  });
}

test("should return only the selected owned device and typed failure with server time through the session finish boundary", async () => {
  const h = harness({
    execution: {
      agentId,
      bindingEpoch: 7,
      failure: { requestId: roomId, reason: "SNAPSHOT_CHANGED", privateProof: "private-value" },
    },
  });
  const response = await h.post(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("set-cookie"), "refreshed=1; HttpOnly");
  const data = (await response.json()) as { ok: boolean; data: statusContracts.ConnectionStatus };
  assert.equal(data.ok, true);
  assert.equal(data.data.device.deviceId, deviceId);
  assert.ok(Number.isFinite(Date.parse(data.data.checkedAt)));
  assert.equal(JSON.stringify(data).includes("private-value"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [
    { name: "connection_list", params: {} },
    { name: "connection_execution_status", params: { p_room_id: roomId, p_device_id: deviceId } },
  ]);
  assert.equal(h.finished(), 1);
});

for (const [label, options] of [
  ["another authenticated account", { authId: agentId }],
  ["another device", { devices: [{ ...device, deviceId: agentId }] }],
  ["another device room", { devices: [{ ...device, roomId: agentId }] }],
  ["lost room access", { rooms: [] }],
] as const)
  test(`should reject ${label} before calling the execution RPC`, async () => {
    const h = harness(options);
    const response = await h.post(request());
    assert.equal(response.status, 403);
    assert.equal(
      h.calls.some((call) => call.name === "connection_execution_status"),
      false,
    );
    assert.equal(h.finished(), 1);
  });

test("should require authentication and fail honestly before the new RPC is deployed", async () => {
  const signedOut = harness({ authId: null });
  assert.equal((await signedOut.post(request())).status, 401);
  assert.equal(signedOut.calls.length, 0);
  const absent = harness({ rpcError: { code: "PGRST202", message: "function missing" } });
  const response = await absent.post(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: { code: "UNAVAILABLE" } });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(absent.finished(), 1);
});

test("should accept no prior private failure and reject unsupported failure payloads", async () => {
  assert.equal((await harness({ execution: null }).call()).executionStatus, null);
  for (const execution of [
    undefined,
    {},
    { agentId, bindingEpoch: 0, failure: null },
    { agentId, bindingEpoch: 1, failure: { requestId: roomId, reason: "UNBOUNDED_REASON" } },
  ].slice(1)) {
    await assert.rejects(() => harness({ execution }).call(), { code: "UNAVAILABLE" });
  }
});

test("should reject unsafe origin, content type, oversized body and foreign fields before opening a session", async () => {
  const h = harness();
  for (const [req, code] of [
    [request(body, { Origin: "https://foreign.test" }), "UNSAFE_ORIGIN"],
    [request(body, { "Content-Type": "text/plain" }), "INVALID_BODY"],
    [request({ ...body, credential: "secret" }), "INVALID_BODY"],
    [request({ ...body, expectedUserId: "unknown" }), "INVALID_BODY"],
    [request("x".repeat(16384)), "BODY_TOO_LARGE"],
  ] as const) {
    const response = await h.post(req);
    assert.deepEqual(await response.json(), { ok: false, error: { code } });
    assert.equal(response.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(h.finished(), 0);
  assert.equal(h.calls.length, 0);
});
