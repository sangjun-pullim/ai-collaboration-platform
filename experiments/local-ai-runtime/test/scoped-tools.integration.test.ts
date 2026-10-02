import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, linkSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { ExperimentStore, type ExperimentManifest } from "../src/experiment-policy.js";
import { SCOPED_TOOL_SPECS, ScopedToolExperiment, assertScopedPolicy, validatePeerQuestion, type ScopedToolOptions } from "../src/scoped-tool-experiment.js";
import { SCOPED_DISABLED_FEATURES, SCOPED_PROCESS_OVERRIDES, SCOPED_TOOL_NAMESPACE, StdioClient, type DynamicToolHandler, type ToolCallContext } from "../src/stdio-client.js";
import { MAX_FILE_BYTES, WorkspaceFilePolicy } from "../src/workspace-file-policy.js";
import { runToolsCli } from "../src/tools-cli.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-app-server.js", import.meta.url));
const scratch = process.env.SCOPED_TEST_SCRATCH;
const markerA = "a".repeat(48);
const markerB = "b".repeat(48);
const execution = { model: "synthetic-model", deadlineMs: 1000, terminalWaitMs: 20 };
const call = { namespace: SCOPED_TOOL_NAMESPACE, threadId: "thread-1", turnId: "turn-1", callId: "direct", tool: "read_workspace_file", arguments: { path: "public-context.txt" } };
const peer = { target: "peer-fixture", question: "Public synthetic fixture?", evidence: [{ path: "public-context.txt", startLine: 1, endLine: 1 }] };

// Public synthetic test data only. UNKNOWN fixtures are retained for the supervisor.
async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(scratch ?? tmpdir(), "scoped-tools-003-"));
  await chmod(dir, 0o700);
  t.after(async () => {
    let keep = false;
    for (const child of await readdir(dir)) {
      try {
        const manifest = JSON.parse(await readFile(join(dir, child, ".local-ai-runtime", "manifest.json"), "utf8")) as ExperimentManifest;
        if (["UNKNOWN", "STARTING", "RUNNING", "INTERRUPT_REQUESTED"].includes(manifest.state)) keep = true;
      } catch { /* Transport-only fixtures have no manifest. */ }
    }
    if (keep) {
      if (scratch !== undefined) appendFileSync(join(scratch, "003-retained-fixtures.jsonl"), `${JSON.stringify({ root: dir, reason: "unconfirmed-test-fixture" })}\n`, { mode: 0o600 });
    } else await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
async function store(t: TestContext): Promise<ExperimentStore> { return await ExperimentStore.create(undefined, await directory(t)); }
function launch(cwd: string, scenario: string, trace: string, handler?: DynamicToolHandler, extra: Record<string, string> = {}, timeout = 100) {
  return StdioClient.launchForTest({
    executable: process.execPath, args: [fixture, scenario], cwd,
    env: { ...process.env, FAKE_TRACE_PATH: trace, ...extra }, requestTimeoutMs: 300, closeTimeoutMs: 30, toolTimeoutMs: timeout,
    ...(handler === undefined ? {} : { experimentalApi: true, dynamicToolHandler: handler }),
  });
}
function runtime(scenario: string, trace: string, options: ScopedToolOptions = {}, extra: Record<string, string> = {}, toolTimeout = 100) {
  return new ScopedToolExperiment({ markerFactory: () => markerA, ...options,
    clientFactory: (cwd, handler) => launch(cwd, scenario, trace, handler, extra, toolTimeout) });
}
async function trace(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
function object(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}; }
function responses(entries: Record<string, unknown>[]) { return entries.filter((entry) => entry.type === "tool-response"); }
function methods(entries: Record<string, unknown>[]) { return entries.filter((entry) => entry.type === "received").map((entry) => object(entry.message).method); }
async function wait(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const until = Date.now() + 2000;
  while (!await predicate()) {
    if (Date.now() > until) throw new Error("fixture wait timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
function safePolicy() {
  return { config: {
    approval_policy: "never", sandbox_mode: "read-only", mcp_servers: {}, plugins: {}, apps: { _default: { enabled: false } },
    web_search: "disabled", agents: { enabled: false }, shell_environment_policy: { inherit: "none" },
    features: { ...Object.fromEntries(SCOPED_DISABLED_FEATURES.map((name) => [name, false])),
      code_mode: { enabled: false, direct_only_tool_namespaces: [SCOPED_TOOL_NAMESPACE] } },
  } };
}
const ok = { success: true, contentItems: [{ type: "inputText" as const, text: "public fixture" }] };

test("should enable dynamic tool callbacks only with explicit opt in", async (t) => {
  const dir = await directory(t);
  for (const enabled of [false, true]) {
    const path = join(dir, `opt-${enabled}.jsonl`); let invoked = 0;
    const raw = launch(dir, "tools-direct", path, enabled ? async () => { invoked++; return ok; } : undefined);
    t.after(() => raw.close());
    const events: string[] = [];
    raw.onEvent((event) => { if (event.status !== undefined) events.push(event.status); });
    await raw.initialize(); await raw.request("tools/callbacks", {});
    await wait(async () => responses(await trace(path)).length === 1 || events.includes("UNSUPPORTED_SERVER_REQUEST"));
    assert.equal(invoked, enabled ? 1 : 0);
    const entries = await trace(path); const init = entries.find((entry) => object(entry.message).method === "initialize")!;
    assert.equal(object(object(object(init.message).params).capabilities).experimentalApi, enabled);
    if (enabled) assert.deepEqual(object(responses(entries)[0]!.message).result, ok);
    await raw.close();
  }
  assert.equal(SCOPED_TOOL_NAMESPACE, "ai_collaboration_scoped");
  assert.equal(SCOPED_TOOL_SPECS.length, 1);
  assert.equal(SCOPED_TOOL_SPECS[0].type, "namespace");
  assert.equal(SCOPED_TOOL_SPECS[0].name, "ai_collaboration_scoped");
  assert.deepEqual(SCOPED_TOOL_SPECS[0].tools.map((spec) => spec.name), ["read_workspace_file", "ask_peer"]);
  assert.ok(SCOPED_TOOL_SPECS[0].tools.every((spec) => spec.type === "function" && spec.inputSchema.additionalProperties === false));
  assert.ok(SCOPED_PROCESS_OVERRIDES.includes('shell_environment_policy.inherit="none"'));
  assert.ok(SCOPED_PROCESS_OVERRIDES.includes("features.shell_tool=false"));
  assert.ok(SCOPED_PROCESS_OVERRIDES.includes('features.code_mode.direct_only_tool_namespaces=["ai_collaboration_scoped"]'));
  for (const name of SCOPED_DISABLED_FEATURES) assert.ok(SCOPED_PROCESS_OVERRIDES.includes(`features.${name}=false`));
});

test("should collect tool handler timeout exceptions and write failures", async (t) => {
  const dir = await directory(t); const unhandled: unknown[] = [];
  const collect = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", collect); t.after(() => process.removeListener("unhandledRejection", collect));
  for (const kind of ["throw", "timeout-resolve", "timeout-reject", "close", "write"]) {
    const gate = deferred<typeof ok>(); const path = join(dir, `${kind}.jsonl`); let entered = false;
    let context: ToolCallContext | undefined;
    const raw = launch(dir, "tools-direct", path, async (_params, ctx) => {
      entered = true; context = ctx;
      if (kind === "throw") throw new Error("synthetic sensitive exception");
      return await gate.promise;
    }, {}, 35);
    t.after(() => raw.close()); await raw.initialize(); await raw.request("tools/callbacks", {}); await wait(() => entered);
    if (kind === "close") await raw.close();
    else if (kind === "write") {
      await raw.request("tools/closeInput", {}); gate.resolve(ok); await wait(() => context?.signal.aborted === true);
    } else await wait(async () => responses(await trace(path)).length === 1);
    if (kind.endsWith("reject")) gate.reject(new Error("late synthetic rejection")); else gate.resolve(ok);
    await new Promise((resolve) => setTimeout(resolve, 20)); await raw.close();
    const result = responses(await trace(path)); assert.ok(result.length <= 1, "one response per RPC id");
    if (kind === "throw" || kind.startsWith("timeout")) assert.equal(object(object(result[0]!.message).result).success, false);
    assert.equal(context?.isActive(), false);
  }
  assert.deepEqual(unhandled, []);
  const path = join(dir, "concurrency.jsonl"); const gate = deferred<typeof ok>(); let entered = 0;
  const raw = launch(dir, "tools-direct", path, async () => { entered++; return await gate.promise; }, {
    FAKE_TOOL_CALLS: JSON.stringify([1, 2, 3].map((n) => ({ ...call, callId: `parallel-${n}` }))),
  });
  await raw.initialize(); await raw.request("tools/callbacks", {}); await wait(async () => responses(await trace(path)).length >= 1);
  assert.equal(entered, 2); gate.resolve(ok); await wait(async () => responses(await trace(path)).length === 3); await raw.close();
});

test("should read only allowlisted bounded text files", async (t) => {
  const owned = await store(t); const policy = new WorkspaceFilePolicy(owned.root);
  assert.match(policy.read("public-context.txt"), /Synthetic/); const path = join(owned.root, "tool-proof.txt");
  for (const data of [Buffer.alloc(MAX_FILE_BYTES, 97), Buffer.alloc(MAX_FILE_BYTES + 1, 97), Buffer.from([65, 0, 66]), Buffer.from([1, 2, 3]), Buffer.from([0xc3, 0x28])]) {
    writeFileSync(path, data, { mode: 0o600 });
    if (data.length === MAX_FILE_BYTES) assert.equal(policy.read("tool-proof.txt").length, MAX_FILE_BYTES);
    else assert.throws(() => policy.read("tool-proof.txt"), /WORKSPACE_FILE_REJECTED/);
  }
  unlinkSync(path); mkdirSync(path, { mode: 0o700 }); assert.throws(() => policy.read("tool-proof.txt"), /WORKSPACE_FILE_REJECTED/);
});

test("should reject path traversal secrets symlinks and hardlinks", async (t) => {
  const owned = await store(t); const policy = new WorkspaceFilePolicy(owned.root);
  for (const path of ["../tool-proof.txt", "/tool-proof.txt", "C:/tool-proof.txt", "//host/tool-proof.txt", "public-context.txt\0", "a\\b", "a//b", ".env", ".git/config", ".local-ai-runtime/manifest.json", "tool-proof.txt/../public-context.txt", "not-allowlisted.txt", ""]) assert.throws(() => policy.read(path), /WORKSPACE_FILE_REJECTED/);
  const proof = join(owned.root, "tool-proof.txt"); const outside = join(dirname(owned.root), "outside.txt");
  writeFileSync(outside, "outside-public-fixture", { mode: 0o600 });
  for (const target of [outside, join(owned.root, "public-context.txt")]) {
    symlinkSync(target, proof); assert.throws(() => policy.read("tool-proof.txt"), /WORKSPACE_FILE_REJECTED/); unlinkSync(proof);
  }
  linkSync(outside, proof); assert.throws(() => policy.read("tool-proof.txt"), /WORKSPACE_FILE_REJECTED/); unlinkSync(proof);
  symlinkSync(join(owned.root, "missing"), proof); assert.throws(() => policy.read("tool-proof.txt"), /WORKSPACE_FILE_REJECTED/);
});

test("should reject a replaced file before returning its content", async (t) => {
  const owned = await store(t); const policy = new WorkspaceFilePolicy(owned.root); const proof = join(owned.root, "tool-proof.txt");
  writeFileSync(proof, markerA, { mode: 0o600 });
  assert.throws(() => policy.read("tool-proof.txt", () => {
    renameSync(proof, join(owned.root, "retired-proof.txt")); writeFileSync(proof, markerB, { mode: 0o600 });
  }), /WORKSPACE_FILE_REJECTED/);
  assert.equal(policy.read("tool-proof.txt"), markerB);
});

test("should validate and record only structured fixture peer questions", async (t) => {
  assert.deepEqual(validatePeerQuestion(peer), peer);
  for (const args of [
    { ...peer, target: "foreign-ai" }, { ...peer, extra: true }, { ...peer, question: "x".repeat(2001) },
    { ...peer, evidence: Array.from({ length: 5 }, () => peer.evidence[0]) },
    ...["/secret", "../secret", ".env"].map((path) => ({ ...peer, evidence: [{ path, startLine: 1, endLine: 1 }] })),
    { ...peer, evidence: [{ ...peer.evidence[0], startLine: 0 }] }, { ...peer, evidence: [{ ...peer.evidence[0], endLine: 0 }] },
    { ...peer, evidence: [{ ...peer.evidence[0], extra: true }] },
  ]) assert.throws(() => validatePeerQuestion(args), /TOOL_CALL_REJECTED/);
  const owned = await store(t); const path = join(owned.root, "trace.jsonl");
  const result = await runtime("tools-normal", path).runNew(owned, execution); assert.equal(result.peerCallbacks, 1);
  const entries = await trace(path); assert.equal(entries.filter((entry) => entry.type === "startup").length, 1);
  assert.ok(!methods(entries).includes("command/exec"));
  const invalid = [
    { ...peer, target: "foreign-ai" }, { ...peer, extra: true },
    { ...peer, evidence: [{ path: "public-context.txt", startLine: 1, endLine: 99 }] },
  ];
  const another = await store(t); const anotherPath = join(another.root, "trace.jsonl");
  const scripted = invalid.map((arguments_, index) => [{ ...call, callId: `invalid-peer-${index}`, tool: "ask_peer", arguments: arguments_ }]);
  const invalidResult = await runtime("tools-normal", anotherPath, {}, { FAKE_TOOL_SCRIPT: JSON.stringify(scripted) }).runNew(another, execution);
  assert.equal(invalidResult.peerCallbacks, 0);
  assert.ok(responses(await trace(anotherPath)).every((entry) => object(object(entry.message).result).success === false));
});

test("should require verified policy before starting a tool thread", async (t) => {
  assert.doesNotThrow(() => assertScopedPolicy(safePolicy()));
  const patches: Record<string, unknown>[] = [
    { approval_policy: "on-request" }, { sandbox_mode: "workspace-write" }, { web_search: "cached" },
    { mcp_servers: "DELETE" }, { plugins: "DELETE" }, { mcp_servers: { fixture: {} } }, { plugins: { fixture: { enabled: true } } },
    { apps: { _default: { enabled: false }, extra: { enabled: true } } }, { apps: { _default: {} } },
    { agents: {} }, { shell_environment_policy: { inherit: "all" } }, { features: {} },
    ...SCOPED_DISABLED_FEATURES.map((name) => ({ features: { ...safePolicy().config.features, [name]: true } })),
  ];
  for (const patch of patches) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl");
    await assert.rejects(runtime("tools-normal", path, {}, { FAKE_TOOL_POLICY_PATCH: JSON.stringify(patch) }).runNew(owned, execution), /TOOL_POLICY_UNCONFIRMED/);
    const entries = await trace(path); assert.ok(!methods(entries).includes("thread/start")); assert.ok(!methods(entries).includes("turn/start"));
    assert.equal((JSON.parse(await readFile(owned.manifestPath, "utf8")) as ExperimentManifest).state, "READY");
  }
});

test("should expose only the owned namespace without enabling code mode host", async (t) => {
  const namespace = "ai_collaboration_scoped";
  const expectedTools = ["read_workspace_file", "ask_peer"].map((name) => ({ name, namespace }));
  const functions = SCOPED_TOOL_SPECS.flatMap((value) => {
    const spec = object(value);
    return spec.type === "namespace" && Array.isArray(spec.tools) ? spec.tools.map(object) : [spec];
  });
  const ownedSpecs = [{ type: "namespace", name: namespace, description: "Owned synthetic tools", tools: functions },
    { type: "function", name: "foreign_fixture_tool", description: "Unowned synthetic tool",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }];

  async function wireControl(specs: Record<string, unknown>[], active: boolean) {
    const owned = await store(t); const path = join(owned.root, "wire-trace.jsonl");
    const policy = new WorkspaceFilePolicy(owned.root); policy.replaceProof(markerA, () => undefined);
    let reads = 0; let peers = 0; let completed = false; let markerMatched = false;
    const raw = launch(owned.root, "tools-codeModeOnly", path, async (params) => {
      const request = object(params); assert.equal(request.namespace, namespace);
      if (request.tool === "read_workspace_file") {
        const args = object(request.arguments);
        assert.ok(args.path === "public-context.txt" || args.path === "tool-proof.txt");
        const text = policy.read(args.path); reads++;
        return { success: true, contentItems: [{ type: "inputText", text }] };
      }
      assert.equal(request.tool, "ask_peer"); validatePeerQuestion(request.arguments); peers++;
      return ok;
    });
    t.after(() => raw.close());
    raw.onEvent((event) => {
      if (event.kind === "turn/completed" && event.status === "completed") completed = true;
      if (event.kind === "item/completed" && event.phase === "final_answer" &&
          event.textHash === createHash("sha256").update(markerA).digest("hex")) markerMatched = true;
    });
    await raw.initialize();
    const config = object(object(await raw.request("config/read", { includeLayers: false })).config);
    assert.equal(object(config.features).code_mode_host, false);
    assert.equal(object(object(config.features).code_mode).enabled, false);
    assert.deepEqual(object(object(config.features).code_mode).direct_only_tool_namespaces, [namespace]);
    assertScopedPolicy({ config });
    await raw.request("thread/start", { cwd: owned.root, model: execution.model, dynamicTools: specs });
    await raw.request("turn/start", { threadId: "thread-1", input: [] });
    await wait(() => completed); await raw.close();
    const entries = await trace(path);
    const visible = entries.find((entry) => entry.type === "model-tools")!;
    assert.equal(visible.codeModeHost, false);
    assert.deepEqual(visible.tools, active ? expectedTools : []);
    assert.equal(reads, active ? 2 : 0); assert.equal(peers, active ? 1 : 0);
    assert.equal(markerMatched, active); assert.equal(responses(entries).length, active ? 3 : 0);
    return { completed, readCallbacks: reads, peerCallbacks: peers, fileMarkerMatched: markerMatched };
  }

  // Both controls use the same child/config; only the transmitted registration differs.
  const flat = await wireControl(functions, false);
  const scoped = await wireControl(ownedSpecs, true);
  const owned = await store(t); const path = join(owned.root, "production-trace.jsonl");
  const runner = runtime("tools-codeModeOnly", path); t.after(() => runner.shutdown());
  const result = await runner.runNew(owned, execution);
  const entries = await trace(path);
  t.diagnostic(JSON.stringify({ flatControl: flat, ownedControl: scoped, production: {
    state: result.state, policyVerified: result.policyVerified, readCallbacks: result.readCallbacks,
    peerCallbacks: result.peerCallbacks, fileMarkerMatched: result.fileMarkerMatched, success: result.success,
  } }));
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.success, true, "production must expose its registered tools directly in CodeModeOnly without enabling the host");
  assert.equal(result.readCallbacks, 2); assert.equal(result.peerCallbacks, 1); assert.equal(result.fileMarkerMatched, true);
  assert.deepEqual(entries.find((entry) => entry.type === "model-tools")!.tools, expectedTools);
  assert.equal(responses(entries).length, 3);
  const start = object(entries.find((entry) => object(entry.message).method === "thread/start")!.message);
  const registered = object(start.params).dynamicTools;
  assert.ok(Array.isArray(registered)); assert.equal(registered.length, 1);
  assert.equal(object(registered[0]).type, "namespace"); assert.equal(object(registered[0]).name, namespace);
  assert.deepEqual(object(registered[0]).tools, functions);
  assert.equal(object(object(object(entries.find((entry) => object(entry.message).method === "initialize")!.message).params).capabilities).experimentalApi, true);
});

test("should reject missing or broader direct tool exposure settings before any thread", async (t) => {
  const namespace = "ai_collaboration_scoped";
  const cases: { name: string; codeMode: unknown }[] = [
    { name: "missing-code-mode", codeMode: undefined }, { name: "null-code-mode", codeMode: null },
    { name: "missing-list", codeMode: { enabled: false } },
    ...[
      { name: "null-list", list: null }, { name: "invalid-string", list: namespace },
      { name: "invalid-object", list: {} }, { name: "invalid-entry", list: [7] },
      { name: "empty-list", list: [] }, { name: "foreign-namespace", list: ["foreign_fixture"] },
      { name: "functions-namespace", list: ["functions"] },
      { name: "additional-namespace", list: [namespace, "foreign_fixture"] },
      { name: "additional-functions", list: [namespace, "functions"] },
      { name: "duplicate-namespace", list: [namespace, namespace] },
      { name: "mixed-null", list: [namespace, null] },
    ].map(({ name, list }) => ({ name, codeMode: { enabled: false, direct_only_tool_namespaces: list } })),
  ];
  const outcomes: { name: string; policyRejected: boolean; threadStarts: number; turnStarts: number; state: string }[] = [];
  for (const { name, codeMode } of cases) {
    const owned = await store(t); const path = join(owned.root, "policy-trace.jsonl");
    const features: Record<string, unknown> = { ...safePolicy().config.features };
    delete features.code_mode;
    if (codeMode !== undefined) features.code_mode = codeMode;
    const runner = runtime("tools-codeModeOnly", path, {}, { FAKE_TOOL_POLICY_PATCH: JSON.stringify({ features }) });
    let policyRejected = false;
    try { await runner.runNew(owned, execution); }
    catch (error) { policyRejected = error instanceof Error && error.message.includes("TOOL_POLICY_UNCONFIRMED"); }
    await runner.shutdown();
    const received = methods(await trace(path));
    outcomes.push({ name, policyRejected, threadStarts: received.filter((method) => method === "thread/start").length,
      turnStarts: received.filter((method) => method === "turn/start").length,
      state: (JSON.parse(await readFile(owned.manifestPath, "utf8")) as ExperimentManifest).state });
  }
  t.diagnostic(JSON.stringify({ exposurePolicyCases: outcomes }));
  assert.deepEqual(outcomes, cases.map(({ name }) => ({ name, policyRejected: true, threadStarts: 0, turnStarts: 0, state: "READY" })),
    "every missing, invalid, foreign, broader or duplicate exposure setting must fail before a thread or turn");
});

test("should admit callbacks only for the acknowledged active turn", async (t) => {
  for (const scenario of ["tools-beforeTurn", "tools-early", "tools-cross", "tools-ackLost", "tools-terminalGate", "tools-terminalGateRead", "tools-cwdMismatch"]) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl"); const gate = deferred<void>(); let entered = false;
    const runner = runtime(scenario, path, { ackWaitMs: 60,
      ...(scenario.startsWith("tools-terminalGate") ? { beforeToolCommit: async () => { entered = true; await gate.promise; } } : {}) });
    const operation = runner.runNew(owned, execution);
    // Attach an observer before waiting on fixture gates; transport errors are expected here.
    void operation.catch(() => undefined);
    if (scenario.startsWith("tools-terminalGate")) {
      await wait(() => entered); await wait(async () => responses(await trace(path)).length === 1); gate.resolve();
    }
    if (scenario === "tools-ackLost" || scenario === "tools-cwdMismatch") {
      await assert.rejects(operation);
      assert.equal(responses(await trace(path)).every((entry) => object(object(entry.message).result).success === false), true);
    } else {
      const result = await operation; assert.equal(result.success, !scenario.startsWith("tools-terminalGate"));
      if (scenario.startsWith("tools-terminalGate")) {
        assert.equal(result.peerCallbacks, 0); assert.equal(result.readCallbacks, 0);
        for (const entry of responses(await trace(path))) assert.equal(JSON.stringify(entry.message).includes(markerA), false);
      }
      if (scenario === "tools-early") {
        const entries = await trace(path); const start = entries.find((entry) => object(entry.message).method === "turn/start")!;
        assert.ok(Number(responses(entries)[0]!.timestampMs) - Number(start.timestampMs) >= 35, "read waits for ACK");
      }
      if (scenario === "tools-cross") assert.equal(responses(await trace(path)).slice(0, 2).every((entry) => object(object(entry.message).result).success === false), true);
      if (scenario === "tools-beforeTurn") {
        const first = responses(await trace(path))[0]!;
        assert.equal(first.callId, "before-turn"); assert.equal(object(object(first.message).result).success, false);
        assert.equal(result.readCallbacks, 2);
      }
    }
    await runner.shutdown();
  }
  for (const tool of ["read_workspace_file", "ask_peer"]) {
    for (const namespace of [undefined, null, "foreign_fixture", "functions"]) {
      const owned = await store(t); const path = join(owned.root, "forged-namespace.jsonl"); let commits = 0;
      const forged: Record<string, unknown> = { ...call, tool,
        arguments: tool === "ask_peer" ? peer : { path: "tool-proof.txt" } };
      if (namespace === undefined) delete forged.namespace; else forged.namespace = namespace;
      const runner = runtime("tools-normal", path, { beforeToolCommit: async () => { commits++; } },
        { FAKE_TOOL_SCRIPT: JSON.stringify([[forged]]) });
      t.after(() => runner.shutdown());
      const result = await runner.runNew(owned, execution); await runner.shutdown();
      const entries = await trace(path);
      const request = object(entries.find((entry) => entry.type === "tool-call")!.params);
      assert.equal(request.threadId, "thread-1"); assert.equal(request.turnId, "turn-1"); assert.equal(request.tool, tool);
      if (namespace === undefined) assert.equal(Object.hasOwn(request, "namespace"), false);
      else assert.equal(request.namespace, namespace);
      assert.equal(methods(entries).filter((method) => method === "turn/start").length, 1);
      assert.equal(result.state, "COMPLETED"); assert.equal(result.success, false);
      assert.equal(result.readCallbacks, 0); assert.equal(result.peerCallbacks, 0); assert.equal(result.fileMarkerMatched, false);
      assert.equal(commits, 0); assert.equal(responses(entries).length, 1);
      const response = object(object(responses(entries)[0]!.message).result);
      assert.equal(response.success, false); assert.equal(JSON.stringify(response).includes(markerA), false);
    }
  }
  for (const tool of ["read_workspace_file", "ask_peer"]) for (const ending of ["shutdown", "timeout"]) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl"); const gate = deferred<void>(); let entered = false;
    const scripted = [[tool === "ask_peer" ? { ...call, tool, arguments: peer } : { ...call, arguments: { path: "tool-proof.txt" } }]];
    const runner = runtime("tools-normal", path, { beforeToolCommit: async () => { entered = true; await gate.promise; } }, { FAKE_TOOL_SCRIPT: JSON.stringify(scripted) }, 35);
    const operation = runner.runNew(owned, execution); void operation.catch(() => undefined); await wait(() => entered);
    if (ending === "shutdown") {
      const shutdown = runner.shutdown(); gate.resolve(); const result = await operation; await shutdown;
      assert.equal(result.state, "UNKNOWN"); assert.equal(result.readCallbacks, 0); assert.equal(result.peerCallbacks, 0);
    } else {
      await wait(async () => responses(await trace(path)).length >= 1); gate.resolve();
      const result = await operation; assert.equal(result.success, false); assert.equal(result.readCallbacks, 0); assert.equal(result.peerCallbacks, 0);
    }
    await runner.shutdown();
  }
});

test("should process an identical call id once and reject conflicting reuse", async (t) => {
  for (const scenario of ["tools-duplicates", "tools-conflictingTool", "tools-limit"]) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl"); const result = await runtime(scenario, path).runNew(owned, execution);
    const entries = responses(await trace(path));
    if (scenario === "tools-limit") {
      assert.equal(result.readCallbacks, 32); assert.equal(object(object(entries[32]!.message).result).success, false);
    } else {
      assert.equal(result.readCallbacks, 2); assert.equal(result.peerCallbacks, 1); assert.equal(result.success, true);
      assert.equal(entries.filter((entry) => object(object(entry.message).result).success === false).length, 1);
    }
  }
});

test("should preserve unknown instead of replaying an uncertain tool turn", async (t) => {
  const owned = await store(t); const path = join(owned.root, "trace.jsonl");
  await assert.rejects(runtime("tools-crash", path).runNew(owned, execution));
  const manifest = JSON.parse(await readFile(owned.manifestPath, "utf8")) as ExperimentManifest;
  assert.equal(manifest.state, "UNKNOWN"); assert.ok(manifest.startIntent); assert.ok(manifest.attemptId);
  const proof = await readFile(join(owned.root, "tool-proof.txt"), "utf8"); const before = methods(await trace(path)).length;
  await assert.rejects(runtime("tools-normal", path, { markerFactory: () => markerB }).resume(owned, execution), /RESUME_NOT_ALLOWED/);
  assert.equal(await readFile(join(owned.root, "tool-proof.txt"), "utf8"), proof); assert.equal(methods(await trace(path)).length, before);
});

test("should prove file reading without putting the marker in the prompt", async (t) => {
  for (const scenario of ["tools-normal", "tools-commentary", "tools-missingPhase", "tools-afterTerminal", "tools-staleFinal", "tools-finalOverwrite"]) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl"); const result = await runtime(scenario, path).runNew(owned, execution);
    assert.equal(result.state, "COMPLETED"); assert.equal(result.fileMarkerMatched, scenario === "tools-normal"); assert.equal(result.success, scenario === "tools-normal");
    for (const entry of (await trace(path)).filter((entry) => ["thread/start", "turn/start"].includes(String(object(entry.message).method)))) assert.equal(JSON.stringify(entry).includes(markerA), false);
    assert.equal((JSON.parse(await readFile(owned.manifestPath, "utf8")) as ExperimentManifest).contextMarkerHash, undefined);
  }
});

test("should resume an owned tool thread with a fresh file marker", async (t) => {
  for (const scenario of ["tools-normal", "tools-resumeUnsupported", "tools-threadMismatch"]) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl"); const shared = join(owned.root, "synthetic-prior-answer.txt");
    assert.equal((await runtime("tools-normal", path, {}, { FAKE_SHARED_STATE: shared }).runNew(owned, execution)).success, true);
    const runner = runtime(scenario, path, { markerFactory: () => markerB }, { FAKE_SHARED_STATE: shared });
    if (scenario === "tools-threadMismatch") await assert.rejects(runner.resume(owned, execution), /TOOL_THREAD_MISMATCH/);
    else {
      const result = await runner.resume(owned, execution); assert.equal(result.success, scenario === "tools-normal"); assert.equal(result.fileMarkerMatched, scenario === "tools-normal");
      assert.equal(await readFile(join(owned.root, "tool-proof.txt"), "utf8"), markerB);
    }
    const entries = await trace(path); const resumes = entries.filter((entry) => object(entry.message).method === "thread/resume");
    assert.equal(resumes.length, 1); assert.equal(object(object(resumes[0]!.message).params).threadId, "thread-1");
    assert.equal(object(object(resumes[0]!.message).params).dynamicTools, undefined);
    assert.equal(entries.filter((entry) => object(entry.message).method === "thread/start").length, 1);
  }
});

test("should replace a proof file without writing through links", async (t) => {
  for (const kind of ["symlink", "hardlink", "directory", "publicMode", "normal", "cancel"]) {
    const owned = await store(t); const policy = new WorkspaceFilePolicy(owned.root); const proof = join(owned.root, "tool-proof.txt"); const outside = join(dirname(owned.root), "outside.txt");
    writeFileSync(outside, markerA, { mode: 0o600 });
    if (kind === "symlink") symlinkSync(outside, proof); else if (kind === "hardlink") linkSync(outside, proof); else if (kind === "directory") mkdirSync(proof, { mode: 0o700 });
    else { writeFileSync(proof, markerA, { mode: 0o600 }); if (kind === "publicMode") chmodSync(proof, 0o644); }
    const inode = (await lstat(proof)).ino;
    if (kind === "normal") {
      policy.replaceProof(markerB, () => undefined); assert.equal(await readFile(proof, "utf8"), markerB); assert.notEqual((await lstat(proof)).ino, inode); assert.equal((await lstat(proof)).mode & 0o777, 0o600);
    } else if (kind === "cancel") {
      let checks = 0; assert.throws(() => policy.replaceProof(markerB, () => { if (++checks === 4) throw new Error("cancel before publication"); }), /WORKSPACE_FILE_REJECTED/);
      assert.equal(await readFile(proof, "utf8"), markerA);
    } else {
      const path = join(owned.root, "trace.jsonl"); await assert.rejects(runtime("tools-normal", path, { markerFactory: () => markerB }).runNew(owned, execution), /WORKSPACE_FILE_REJECTED/); assert.equal(methods(await trace(path)).length, 0);
    }
    assert.equal(await readFile(outside, "utf8"), markerA); assert.equal((await readdir(owned.root)).filter((name) => name.startsWith(".tool-proof-")).length, 0);
  }
});

test("should block tool preparation after shutdown without replacing the proof file", async (t) => {
  for (const initial of ["READY", "COMPLETED", "UNKNOWN", "STARTING", "RUNNING"] as const) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl"); writeFileSync(join(owned.root, "tool-proof.txt"), markerA, { mode: 0o600 });
    if (initial !== "READY") await owned.withLock(async (manifest) => { await owned.save({ ...manifest, state: initial, threadLocator: "thread-1", transitions: [...manifest.transitions, initial] }); });
    const gate = deferred<void>(); let entered = false;
    const runner = runtime("tools-normal", path, { markerFactory: () => markerB, beforePreparation: async () => { entered = true; await gate.promise; } });
    const operation = initial === "READY" ? runner.runNew(owned, execution) : runner.resume(owned, execution); void operation.catch(() => undefined);
    if (initial === "READY" || initial === "COMPLETED") {
      await wait(() => entered); await assert.rejects(owned.withLock(async () => undefined), /MANIFEST_LOCKED/);
      const closing = runner.shutdown(); await assert.rejects(operation, /RUNTIME_SHUTDOWN/); await closing;
      gate.reject(new Error("late preparation rejection")); await new Promise((resolve) => setTimeout(resolve, 10)); await owned.withLock(async () => undefined);
      assert.equal((JSON.parse(await readFile(owned.manifestPath, "utf8")) as ExperimentManifest).state, initial);
    } else { await assert.rejects(operation, /RESUME_NOT_ALLOWED/); assert.equal(entered, false); }
    assert.equal(await readFile(join(owned.root, "tool-proof.txt"), "utf8"), markerA); assert.equal(methods(await trace(path)).length, 0);
  }
  const owned = await store(t); const runner = runtime("tools-normal", join(owned.root, "trace.jsonl"));
  await runner.shutdown(); await assert.rejects(runner.runNew(owned, execution), /RUNTIME_SHUTDOWN/);
  for (const phase of ["preparation", "callback"]) {
    const target = await store(t); const proof = join(target.root, "tool-proof.txt"); writeFileSync(proof, markerA, { mode: 0o600 });
    const tracePath = join(target.root, "cli-trace.jsonl");
    const child = spawn(process.execPath, [fixture, "tools-cli-driver"], {
      cwd: target.root, env: { ...process.env, TEST_MANIFEST: target.manifestPath, TEST_TOOL_DRIVER_GATE: phase, FAKE_TRACE_PATH: tracePath },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    let entered = false; let stdout = ""; let stderr = "";
    child.on("message", (message) => { if (message === "tool-gate-entered") entered = true; });
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const ended = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    await wait(() => entered);
    await assert.rejects(target.withLock(async () => undefined), /MANIFEST_LOCKED/);
    child.kill("SIGINT");
    const code = await Promise.race([ended, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("SIGINT fixture failed to exit")), 2000); timer.unref();
    })]);
    assert.equal(code, 130); assert.equal(stderr.includes("Unhandled"), false);
    const output = object(JSON.parse(stdout)); assert.equal(output.ok, false);
    await target.withLock(async (manifest) => { assert.equal(manifest.state, phase === "preparation" ? "READY" : "UNKNOWN"); });
    if (phase === "preparation") {
      assert.equal(await readFile(proof, "utf8"), markerA); assert.equal(methods(await trace(tracePath)).length, 0);
    } else {
      assert.equal(object(output.result).readCallbacks, 0); assert.equal(object(output.result).peerCallbacks, 0);
    }
    assert.equal((await readdir(target.root)).some((name) => name.startsWith(".tool-proof-")), false);
  }
});

test("should omit raw tool content secrets and native locators from output", async (t) => {
  const args = ["run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api"];
  for (const scenario of ["tools-normal", "tools-cwdMismatch"]) {
    const owned = await store(t); const path = join(owned.root, "trace.jsonl");
    const output = await runToolsCli(args, { runtime: runtime(scenario, path, {}, { FAKE_STDERR_SECRET: "SYNTHETIC_SECRET_TOKEN" }), createStore: async () => owned });
    assert.equal(output.ok, scenario === "tools-normal"); const serialized = JSON.stringify(output);
    for (const secret of [markerA, createHash("sha256").update(markerA).digest("hex"), "thread-1", "turn-1", owned.root, "/secret/fake", "SYNTHETIC_SECRET_TOKEN", "Synthetic local AI", peer.question]) assert.equal(serialized.includes(secret), false);
  }
  for (const argv of [["run"], ["resume", "--allow-model-call", "--model", "x", "--account-route", "api"],
    [...args, "--resume-manifest", "/anything"], [...args, "--root", "/anything"], [...args, "--thread-id", "native"], [...args, "--prompt", "custom"], [...args, "--token", "synthetic"], [...args, "--account-route", "oauth"]]) {
    assert.equal((await runToolsCli(argv, { createStore: async () => { throw new Error("must not create"); } })).ok, false);
  }
  const legacy = await ExperimentStore.create(createHash("sha256").update("conversation-marker").digest("hex"), await directory(t));
  assert.equal((JSON.parse(await readFile(legacy.manifestPath, "utf8")) as ExperimentManifest).contextMarkerHash, createHash("sha256").update("conversation-marker").digest("hex"));
  await assert.rejects(runtime("tools-normal", join(legacy.root, "trace.jsonl")).runNew(legacy, execution), /RUN_NOT_ALLOWED/);
});
