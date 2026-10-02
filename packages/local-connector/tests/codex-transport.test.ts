import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CodexTransport, providerEnvironment } from "../src/codex-transport.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { deferred } from "./runner-fixture.ts";
import { scopedOverrides } from "../src/codex-adapter.ts";
import { RuntimeError } from "../src/runtime-contracts.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const fixture = fileURLToPath(new URL("../../tests/fixtures/fake-codex.mjs", import.meta.url));
type Audit = { kind: string; pid: number; argv: string[]; cwd: string; environment: Record<string, string> };
async function audit(path: string): Promise<Audit[]> { const bytes = await readFile(path, "utf8").catch(() => ""); return bytes.trim() ? bytes.trim().split("\n").map(line => JSON.parse(line) as Audit) : []; }
test("should preflight every stdio app-server launch with identical task argv cwd and filtered environment", async () => {
  const f = await runtimeFixture(), path = join(f.directory, "synthetic-audit.jsonl");
  const source = Object.freeze({ OPENAI_API_KEY: "SYNTHETIC_PROVIDER", MCP_AUTH_TOKEN: "SYNTHETIC_MCP", HTTP_PROXY: "SYNTHETIC_PROXY", CODEX_HOME: "SYNTHETIC_HOME", DATABASE_URL: "SYNTHETIC_DB", LOCAL_ACCESS_ADMIN_KEY: "SYNTHETIC_ADMIN", AI_COLLAB_SECRET: "SYNTHETIC_RESERVED", CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "0", SYNTHETIC_AUDIT_FILE: path });
  const before = { ...source }; let client: CodexTransport | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      client = await CodexTransport.forTestLaunch(process.execPath, [fixture], f.root, [...scopedOverrides], source, () => {}); await client.initialize();
      const snapshot = await client.request("config/read", {}) as Audit; assert.deepEqual(snapshot.argv, [...scopedOverrides.flatMap(arg => ["-c", arg]), "app-server", "--listen", "stdio://"]); await client.close();
    }
    const rows = await audit(path); assert.deepEqual(rows.map(row => row.kind), ["PREFLIGHT", "APP_SERVER", "PREFLIGHT", "APP_SERVER"]);
    for (let i = 0; i < rows.length; i += 2) {
      assert.deepEqual(rows[i].argv, [...scopedOverrides.flatMap(arg => ["-c", arg]), "features", "list"]); assert.equal(rows[i].cwd, f.root); assert.equal(rows[i + 1].cwd, f.root); assert.deepEqual(rows[i].environment, rows[i + 1].environment);
      assert.deepEqual(rows[i].environment, { OPENAI_API_KEY: "SYNTHETIC_PROVIDER", MCP_AUTH_TOKEN: "SYNTHETIC_MCP", HTTP_PROXY: "SYNTHETIC_PROXY", CODEX_HOME: "SYNTHETIC_HOME", CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" });
    }
    assert.deepEqual(source, before);
  } finally { await client?.close(); await f.close(); }
});
test("should reject true missing duplicate unsupported malformed unknown or oversized preflight before app-server spawn", { timeout: 15000 }, async () => {
  const f = await runtimeFixture(); try {
    for (const mode of ["true", "missing", "duplicate", "unsupported", "malformed", "unknown", "oversized", "stderr-oversized", "error"]) {
      const path = join(f.directory, `${mode}.jsonl`);
      await assert.rejects(CodexTransport.forTestLaunch(process.execPath, [fixture], f.root, [...scopedOverrides], { SYNTHETIC_AUDIT_FILE: path, SYNTHETIC_PREFLIGHT_MODE: mode }, () => {}), error => error instanceof RuntimeError && error.code === "POLICY_UNCONFIRMED" && error.message === "POLICY_UNCONFIRMED");
      const rows = await audit(path); assert.deepEqual(rows.map(row => row.kind), ["PREFLIGHT"]); assert.throws(() => process.kill(rows[0].pid, 0), { code: "ESRCH" });
    }
  } finally { await f.close(); }
});
test("should bound timed out preflight reap its owned child and refuse a late closure before spawn", { timeout: 10000 }, async () => {
  const f = await runtimeFixture(); try {
    const path = join(f.directory, "timeout.jsonl");
    await assert.rejects(CodexTransport.forTestLaunch(process.execPath, [fixture], f.root, [...scopedOverrides], { SYNTHETIC_AUDIT_FILE: path, SYNTHETIC_PREFLIGHT_MODE: "stall-ignore" }, () => {}, 200), { code: "POLICY_UNCONFIRMED" });
    const rows = await audit(path); assert.deepEqual(rows.map(row => row.kind), ["PREFLIGHT"]); assert.throws(() => process.kill(rows[0].pid, 0), { code: "ESRCH" });
    const latePath = join(f.directory, "late.jsonl"); let closed = false;
    const rejected = assert.rejects(CodexTransport.forTestLaunch(process.execPath, [fixture], f.root, [...scopedOverrides], { SYNTHETIC_AUDIT_FILE: latePath, SYNTHETIC_PREFLIGHT_MODE: "late" }, () => { if (closed) throw new RuntimeError("RUNTIME_CLOSED"); }), { code: "RUNTIME_CLOSED" });
    for (let i = 0; i < 160 && !(await audit(latePath)).length; i++) await new Promise(resolve => setTimeout(resolve, 5));
    closed = true; await rejected; const late = await audit(latePath); assert.deepEqual(late.map(row => row.kind), ["PREFLIGHT"]); assert.throws(() => process.kill(late[0].pid, 0), { code: "ESRCH" });
  } finally { await f.close(); }
});
test("should refuse production config plugin MCP remote control and environment mutation RPCs", async () => {
  const f = await runtimeFixture(), client = await CodexTransport.forTestLaunch(process.execPath, [fixture], f.root, [...scopedOverrides], {}, () => {});
  try {
    await client.initialize();
    for (const method of ["config/value/write", "config/batchWrite", "config/reload", "mcpServer/refresh", "mcpServerStatus/list", "plugin/installed", "plugin/read", "plugin/install", "plugin/enable", "hooks/list", "experimentalFeature/enablement/set", "remoteControl/enable", "environment/create", "fixture/echo"]) await assert.rejects(client.request(method, {}), { code: "POLICY_UNCONFIRMED" });
    assert.equal((await client.request("config/read", {}) as Audit).kind, "APP_SERVER");
  } finally { await client.close(); await f.close(); }
});
test("should preserve native user environment without product fixture or reserved injection in the child", async () => {
  const user = { OPENAI_API_KEY: "SYNTHETIC_PROVIDER", MCP_AUTH_TOKEN: "SYNTHETIC_MCP", CUSTOM_HOOK_KEY: "SYNTHETIC_HOOK", HTTP_PROXY: "SYNTHETIC_PROXY", HTTPS_PROXY: "SYNTHETIC_TLS_PROXY", NO_PROXY: "SYNTHETIC_NO_PROXY", NODE_EXTRA_CA_CERTS: "SYNTHETIC_CERT", SSL_CERT_FILE: "SYNTHETIC_SSL", CODEX_HOME: "SYNTHETIC_HOME", CUSTOM_URL: "SYNTHETIC_USER_URL", EMPTY_USER_SETTING: "" };
  const reserved = ["LOCAL_ACCESS_ADMIN_KEY", "LOCAL_ACCESS_SIGNING_KEY", "LOCAL_ACCESS_OTP", "LOCAL_ACCESS_FIXTURE_TOKEN", "LOCAL_ACCESS_WORKDIR", "LOCAL_DEVICE_BRIDGE_KEY", "LOCAL_WORKFLOW_BRIDGE_TOKEN", "AI_COLLAB_ADAPTER", "AI_COLLAB_SECRET", "DATABASE_URL", "DIRECT_URL", "DB_PASSWORD", "JWT_SECRET", "GOTRUE_JWT_SECRET", "PGRST_JWT_SECRET", "SERVER_SECRET", "LOCAL_AUTH_TOKEN", "SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_JWT_SECRET", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "APP_ORIGIN"];
  const source = Object.freeze({ ...user, ...Object.fromEntries(reserved.map(key => [key, "SYNTHETIC_PRODUCT"])), UNDEFINED_USER: undefined }), before = { ...source };
  const environment = providerEnvironment(source); assert.deepEqual(source, before); assert.notEqual(environment, source); assert.deepEqual(environment, user);
  environment.CUSTOM_HOOK_KEY = "SYNTHETIC_CHILD_CHANGE"; assert.equal(source.CUSTOM_HOOK_KEY, "SYNTHETIC_HOOK");
  const f = await runtimeFixture(), client = CodexTransport.forTest(process.execPath, [fixture], f.root, source); try {
    await client.initialize(); const received = await client.request("fixture/environment", { keys: Object.keys(source) }) as Record<string, string>;
    assert.deepEqual(received, user); assert.ok(reserved.every(key => !Object.hasOwn(received, key))); assert.deepEqual(source, before);
  } finally { await client.close(); await f.close(); }
});
test("should bound provider lines requests and private errors", async () => {
  const f = await runtimeFixture(); const client = CodexTransport.forTest(process.execPath, [fixture], f.root); try {
    await client.initialize(); assert.deepEqual(await client.request("fixture/echo", { fixed: true }), { fixed: true });
    await assert.rejects(client.request("fixture/stall", {}, 25), { code: "PROVIDER_UNAVAILABLE" });
    await assert.rejects(client.request("fixture/error", {}), error => error instanceof Error && error.message === "PROVIDER_UNAVAILABLE");
    assert.ok(client.stderrBytes > 0); await assert.rejects(client.request("fixture/oversized", {}), { code: "PROVIDER_UNAVAILABLE" });
  } finally { await client.close(); await f.close(); }
});
test("should deduplicate provider rpc delivery and collect late tool results after closure", async () => {
  const f = await runtimeFixture(); const client = CodexTransport.forTest(process.execPath, [fixture], f.root); try {
    await client.initialize(); let calls = 0; const entered = deferred(), release = deferred(), receipts = deferred(); let count = 0;
    client.setToolHandler(async (_params, live) => { calls++; entered.resolve(); await release.promise; live(); return { success: true, contentItems: [] }; });
    client.onEvent(event => { if (event.method === "fixture/receipt" && ++count === 2) receipts.resolve(); });
    await client.request("fixture/tool", {}); await entered.promise; release.resolve(); await receipts.promise; assert.equal(calls, 1);
    const late = deferred(); client.setToolHandler(async (_params, live) => { await late.promise; live(); return { success: true, contentItems: [] }; });
    await client.close(); late.resolve();
  } finally { await client.close(); await f.close(); }
});
test("should terminate and reap the owned provider without killing an unrelated child", async () => {
  const f = await runtimeFixture(); const owned = CodexTransport.forTest(process.execPath, [fixture, "term-ignore"], f.root), unrelated = CodexTransport.forTest(process.execPath, [fixture, "term-ignore"], f.root); try {
    await Promise.all([owned.initialize(), unrelated.initialize()]); const pid = owned.childPid!; await owned.close();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }); assert.deepEqual(await unrelated.request("fixture/echo", { alive: true }), { alive: true });
  } finally { await Promise.all([owned.close(), unrelated.close()]); await f.close(); }
});

test("should decline headless native callbacks with typed private bounded diagnostics", async t => {
  const f = await runtimeFixture(), client = CodexTransport.forTest(process.execPath, [fixture], f.root), diagnostics: string[] = [];
  t.mock.method(process.stderr, "write", (value: string | Uint8Array) => { diagnostics.push(String(value)); return true; });
  const methods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "mcpServer/elicitation/request", "item/tool/requestUserInput", "execCommandApproval", "applyPatchApproval", "account/chatgptAuthTokens/refresh", "SYNTHETIC_UNKNOWN"];
  const results = new Map<string, Record<string, unknown>>(), complete = deferred(); let calls = 0, count = 0;
  try {
    await client.initialize(); client.setToolHandler(async () => { calls++; return { success: true, contentItems: [] }; });
    client.onEvent(event => { if (event.method === "fixture/nativeReceipt") { results.set(String(event.params.id), event.params); if (++count === methods.length * 2) complete.resolve(); } });
    const requests = methods.map((method, index) => ({ id: `SYNTHETIC_RPC_${index}`, method, params: { threadId: "SYNTHETIC_PRIVATE_THREAD", turnId: null, command: "SYNTHETIC_PRIVATE_COMMAND", token: "SYNTHETIC_PRIVATE_TOKEN", path: "/synthetic/private/path" } }));
    await client.request("fixture/nativeCallbacks", { requests: [...requests, ...requests] }); await complete.promise;
    for (const index of [0, 1]) assert.deepEqual(results.get(requests[index].id)!.result, { decision: "decline" });
    assert.deepEqual(results.get(requests[2].id)!.result, { permissions: {}, scope: "turn" });
    assert.deepEqual(results.get(requests[3].id)!.result, { action: "decline" });
    for (const index of [5, 6]) assert.deepEqual(results.get(requests[index].id)!.result, { decision: { denied: { rejection: "LOCAL_OWNER_APPROVAL_REQUIRED" } } });
    for (const index of [4, 7, 8]) assert.deepEqual(results.get(requests[index].id)!.error, { code: -32601, message: "TOOL_REJECTED" });
    assert.equal(calls, 0); assert.equal(diagnostics.length, 6); assert.ok(diagnostics.every(line => /^LOCAL_OWNER_APPROVAL_REQUIRED:(COMMAND|FILE_CHANGE|PERMISSIONS|ELICITATION|USER_INPUT|LEGACY_APPROVAL)\n$/.test(line)));
    assert.ok(diagnostics.every(line => !line.includes("SYNTHETIC_PRIVATE") && !line.includes("/synthetic")));
  } finally { await client.close(); await f.close(); }
});
