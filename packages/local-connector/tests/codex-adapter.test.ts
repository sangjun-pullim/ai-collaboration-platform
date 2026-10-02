import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter, selectSettings, terminalEvidence } from "../src/codex-adapter.ts";
import { RuntimeError, type AttemptAuthority } from "../src/runtime-contracts.ts";
import { FakeProvider } from "./fake-provider.ts";
import { capabilities, runtimeFixture, observation, uuid } from "./runtime-fixture.ts";
import { deferred } from "./runner-fixture.ts";

type OriginPolicy = { config: Record<string, unknown>; layers: { name: Record<string, unknown>; version: unknown; config: unknown }[]; origins: Record<string, unknown> };
function sessionOriginFixture(change?: (policy: OriginPolicy, launch: number) => void) {
  const p = new FakeProvider(), reads: OriginPolicy[] = []; let launch = 0, version: string | undefined;
  p.policy.config.mcp_servers = { SYNTHETIC_MCP: { enabled: true, command: "SYNTHETIC_COMMAND" } };
  p.response = method => {
    if (method !== "config/read") return;
    const layer = { name: { type: "sessionFlags" }, version: version ?? `SYNTHETIC_SESSION_${launch}`, config: {} };
    const policy: OriginPolicy = { ...structuredClone(p.policy), layers: [...structuredClone(p.policy.layers), layer], origins: {
      "features.shell_tool": { name: structuredClone(layer.name), version: layer.version },
      developer_instructions: { name: structuredClone(p.policy.layers[0].name), version: p.policy.layers[0].version },
    } };
    change?.(policy, launch); reads.push(structuredClone(policy)); return policy;
  };
  const a = new CodexAdapter({ transportFactory: (_cwd, overrides) => { launch++; return p.launch(overrides); } });
  return { p, a, reads, drift() { version = "SYNTHETIC_LATE_SESSION"; } };
}
test("should admit retained session flag origins with matching per-child versions during MCP task relaunch", async () => {
  const f = await runtimeFixture(), s = sessionOriginFixture();
  try {
    await assert.doesNotReject(() => s.a.capabilities(f.root, () => {}));
    const context = await s.a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
    await s.a.validate(context, f.settings, () => {});
    assert.equal(s.p.serverStarts, 2);
    assert.notDeepEqual(s.reads[0].origins["features.shell_tool"], s.reads[1].origins["features.shell_tool"]);
    for (const read of s.reads) {
      assert.deepEqual(read.origins["features.shell_tool"], { name: read.layers[1].name, version: read.layers[1].version });
      assert.deepEqual(read.layers[0], s.p.policy.layers[0]);
      assert.equal(read.config.developer_instructions, "SYNTHETIC_PERSONAL");
      assert.equal((read.config.features as Record<string, unknown>).shell_tool, true);
      assert.equal(read.config.approval_policy, "never"); assert.equal(read.config.sandbox_mode, "read-only");
    }
    assert.deepEqual(s.reads[0].config.mcp_servers, { SYNTHETIC_MCP: { enabled: true, command: "SYNTHETIC_COMMAND" } });
    assert.deepEqual(s.reads[1].config.mcp_servers, { SYNTHETIC_MCP: { enabled: false, command: "SYNTHETIC_COMMAND" } });
    assert.equal(s.p.calls.some(call => call.method === "turn/start"), false);
  } finally { await s.a.close(); await f.close(); }
});
test("should reject unmatched malformed or ambiguous session origin metadata before owned creation", async () => {
  const f = await runtimeFixture();
  const changes: ((policy: OriginPolicy) => void)[] = [
    policy => { (policy.origins["features.shell_tool"] as Record<string, unknown>).version = "SYNTHETIC_UNMATCHED"; },
    policy => { (policy.origins["features.shell_tool"] as Record<string, unknown>).name = { type: "sessionFlags", marker: "SYNTHETIC_UNMATCHED" }; },
    ...[undefined, null, "", 7, "SYNTHETIC\nINVALID"].map(version => (policy: OriginPolicy) => { policy.origins["features.shell_tool"] = { name: { type: "sessionFlags" }, ...(version === undefined ? {} : { version }) }; }),
    policy => { (policy.origins["features.shell_tool"] as Record<string, unknown>).unknown = true; },
    policy => { policy.layers.push(structuredClone(policy.layers[1])); },
    policy => { policy.layers.push({ ...structuredClone(policy.layers[1]), version: "SYNTHETIC_OTHER_LAYER" }); },
    policy => { policy.layers.pop(); },
    policy => { policy.layers[1].config = null; },
  ];
  try {
    for (const change of changes) for (const changedLaunch of [1, 2]) {
      const s = sessionOriginFixture((policy, launch) => { if (launch === changedLaunch) change(policy); });
      try { await assert.rejects(s.a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(s.p.calls.some(call => call.method.startsWith("thread/") || call.method === "turn/start"), false); }
      finally { await s.a.close(); }
    }
  } finally { await f.close(); }
});
test("should retain exact personal origin source identity values and non-session versions across relaunch", async () => {
  const f = await runtimeFixture();
  const changes: ((policy: OriginPolicy) => void)[] = [
    policy => { (policy.origins.developer_instructions as Record<string, unknown>).version = "SYNTHETIC_CHANGED_PERSONAL"; },
    policy => { (policy.origins.developer_instructions as Record<string, unknown>).name = { type: "project", file: "/synthetic/other" }; },
    policy => { policy.layers[1].name = { type: "sessionFlags", marker: "SYNTHETIC_CHANGED_SOURCE" }; policy.origins["features.shell_tool"] = { name: policy.layers[1].name, version: policy.layers[1].version }; },
    policy => { policy.origins["features.shell_tool"] = structuredClone(policy.origins.developer_instructions); },
    policy => { policy.origins["features.memories"] = policy.origins["features.shell_tool"]; delete policy.origins["features.shell_tool"]; },
    policy => { policy.config.features = { ...(policy.config.features as object), shell_tool: false }; },
    policy => { policy.layers[0].version = "SYNTHETIC_CHANGED_PERSONAL_LAYER"; },
  ];
  try {
    for (const change of changes) {
      const s = sessionOriginFixture((policy, launch) => { if (launch === 2) change(policy); });
      try { await assert.rejects(s.a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(s.p.calls.some(call => call.method.startsWith("thread/") || call.method === "turn/start"), false); }
      finally { await s.a.close(); }
    }
  } finally { await f.close(); }
});
test("should reject consistent session origin and layer version drift within the same child before prepare or resume", async () => {
  const f = await runtimeFixture();
  try {
    for (const admission of ["prepare", "resume"]) {
      const s = sessionOriginFixture();
      try {
        const context = await s.a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
        const submitted = s.p.calls.filter(call => call.method.startsWith("thread/") || call.method === "turn/start").length;
        s.drift();
        await assert.rejects(admission === "prepare" ? s.a.prepare(f.policy.root, f.settings, uuid(), 2, () => {}) : s.a.validate(context, f.settings, () => {}), { code: "POLICY_UNCONFIRMED" });
        assert.equal(s.p.calls.filter(call => call.method.startsWith("thread/") || call.method === "turn/start").length, submitted);
        assert.equal(s.p.closed, true);
      } finally { await s.a.close(); }
    }
  } finally { await f.close(); }
});

test("should apply task executable gates before initial discovery reads", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), launches: string[][] = [];
  const a = new CodexAdapter({ transportFactory: (_cwd, overrides) => { launches.push([...overrides]); return p.launch(overrides); } });
  try {
    await a.capabilities(f.root, () => {});
    assert.ok(launches[0].some(arg => arg.includes('"plugins"=false')));
    assert.ok(launches[0].includes("notify=[]"));
    assert.equal(p.calls.some(call => ["hooks/list", "plugin/installed", "plugin/read"].includes(call.method)), false);
  } finally { await a.close(); await f.close(); }
});
test("should refuse normalized plugin enablement before creating an owned context", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  p.response = method => method === "experimentalFeature/list" ? { data: [{ name: "plugins", stage: "stable", displayName: null, description: null, announcement: null, enabled: true, defaultEnabled: false }], nextCursor: null } : undefined;
  try { await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.some(call => call.method.startsWith("thread/")), false); }
  finally { await a.close(); await f.close(); }
});
test("should reject an initial managed plugin pin before discovery can start", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  p.required = { requirements: { featureRequirements: { plugins: true } } };
  try { await assert.rejects(a.capabilities(f.root, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.length, 0); }
  finally { await a.close(); await f.close(); }
});
test("should disable every literal named MCP while retaining its other native settings", async () => {
  const f = await runtimeFixture(), p = new FakeProvider();
  const servers = { 'synthetic.dotted"name': { enabled: true, command: "SYNTHETIC_COMMAND", args: ["SYNTHETIC_ARG"], env: { CUSTOM_MCP_TOKEN: "SYNTHETIC_USER" }, default_tools_approval_mode: "approve" }, disabled: { enabled: false, url: "SYNTHETIC_URL" } };
  p.policy.config.mcp_servers = structuredClone(servers); const a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  try { await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}); assert.deepEqual(p.policy.config.mcp_servers, { 'synthetic.dotted"name': { ...servers['synthetic.dotted"name'], enabled: false }, disabled: servers.disabled }); }
  finally { await a.close(); await f.close(); }
});
test("should await the owned creation observer before naming and reject failed closed or revoked observers", { timeout: 10000 }, async () => {
  const f = await runtimeFixture(); try {
    for (const outcome of ["success", "failure", "closure", "authority-loss"]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }), entered = deferred(), release = deferred(); let live = true, observed = 0;
      const job = a.prepare(f.policy.root, f.settings, uuid(), 2, () => { if (!live) throw new RuntimeError("AUTHORITY_LOST"); }, async descriptor => {
        observed++; assert.equal(descriptor.threadId, p.thread.id); assert.deepEqual(descriptor.root, f.policy.root); assert.equal(descriptor.epoch, 2); assert.equal(descriptor.level, "L1"); assert.deepEqual(descriptor.ownedTurns, []);
        entered.resolve(); await release.promise; if (outcome === "failure") throw new RuntimeError("UNKNOWN");
        // Observer arguments cannot rewrite the adapter's acknowledged native identity.
        descriptor.threadId = "SYNTHETIC_OBSERVER_MUTATION";
      });
      const result = outcome === "success" ? job : assert.rejects(job, { code: outcome === "failure" ? "UNKNOWN" : outcome === "closure" ? "RUNTIME_CLOSED" : "AUTHORITY_LOST" });
      try {
        await entered.promise; assert.deepEqual(p.calls.filter(c => c.method.startsWith("thread/")).map(c => c.method), ["thread/start"]);
        if (outcome === "closure") await a.close(); if (outcome === "authority-loss") live = false; release.resolve(); await result; assert.equal(observed, 1);
        const named = p.calls.filter(c => c.method === "thread/name/set"); assert.equal(named.length, outcome === "success" ? 1 : 0);
        if (outcome === "success") assert.equal(named[0].params.threadId, p.thread.id); assert.equal(p.calls.some(c => c.method === "turn/start"), false);
      } finally { release.resolve(); await a.close(); }
    }
  } finally { await f.close(); }
});
test("should never notify owned creation for malformed or unowned start acknowledgements", async () => {
  const f = await runtimeFixture(); try {
    for (const changed of [{ id: "" }, { cwd: "/SYNTHETIC_OTHER" }, { status: { type: "active" } }, { turns: [{ id: "SYNTHETIC_UNOWNED" }] }]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); let observed = 0;
      p.response = (method, params) => method === "thread/start" ? { modelProvider: "openai", thread: { id: "SYNTHETIC_NEW", cwd: params.cwd, status: { type: "idle" }, turns: [], ...changed } } : undefined;
      try {
        await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}, async () => { observed++; }), { code: "CONTEXT_UNCONFIRMED" });
        assert.equal(observed, 0); assert.equal(p.calls.some(c => c.method === "thread/name/set" || c.method === "turn/start"), false);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});

test("should materialize only a newly owned empty thread before delivering a restartable candidate", async () => {
  const f = await runtimeFixture(), stored = new Map<string, Record<string, unknown>>(), p = new FakeProvider(stored), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  let restarted: CodexAdapter | undefined;
  try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 2, () => {});
    assert.deepEqual(p.calls.filter(c => c.method === "thread/name/set").map(c => c.params), [{ threadId: context.threadId, name: "ai-collaboration-owned-context" }]);
    assert.deepEqual(p.calls.filter(c => c.method.startsWith("thread/")).map(c => c.method), ["thread/start", "thread/name/set", "thread/read"]);
    assert.deepEqual(p.calls.find(c => c.method === "thread/read")!.params, { threadId: context.threadId, includeTurns: true });
    assert.ok(stored.has(context.threadId)); assert.equal(stored.get(context.threadId)!.cwd, f.root); assert.deepEqual(stored.get(context.threadId)!.turns, []); assert.equal(context.epoch, 2); assert.equal(context.level, "L1");
    const start = p.calls.find(c => c.method === "thread/start")!.params; assert.equal(start.model, f.settings.requested.model); assert.deepEqual(start.config, { ...expectedTaskConfig, model_reasoning_effort: f.settings.requested.effort }); assert.ok(Array.isArray(start.dynamicTools));
    await a.close(); const next = new FakeProvider(stored); restarted = new CodexAdapter({ transportFactory: (_cwd, overrides) => next.launch(overrides) });
    const report = await restarted.validate(context, f.settings, () => {}); assert.equal(report.turn.effortVerification, "UNVERIFIED");
    assert.deepEqual(next.calls.filter(c => c.method.startsWith("thread/")).map(c => c.method), ["thread/read", "thread/resume"]);
    assert.ok([...p.calls, ...next.calls].every(c => c.method !== "turn/start"));
  } finally { await restarted?.close(); await a.close(); await f.close(); }
});
test("should fail closed on naming acknowledgement or materialization failure without starting again", async () => {
  const f = await runtimeFixture(); try {
    for (const failure of ["rejected-name", "null-ack", "array-ack", "nonempty-ack", "ack-without-storage", "read-rejection"]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      p.response = method => {
        if (method === "thread/name/set") {
          if (failure === "rejected-name") throw new Error("SYNTHETIC_PRIVATE_NAME_FAILURE");
          if (failure === "null-ack") return null;
          if (failure === "array-ack") return [];
          if (failure === "nonempty-ack") return { threadId: "synthetic-private" };
          if (failure === "ack-without-storage") return {};
        }
        if (method === "thread/read" && failure === "read-rejection") throw new Error("SYNTHETIC_PRIVATE_READ_FAILURE");
      };
      try {
        await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), error => error instanceof RuntimeError && error.code === "CONTEXT_UNCONFIRMED" && error.message === "CONTEXT_UNCONFIRMED");
        assert.equal(p.calls.filter(c => c.method === "thread/start").length, 1); assert.equal(p.calls.filter(c => c.method === "thread/name/set").length, 1);
        assert.equal(p.calls.some(c => ["turn/start", "thread/resume"].includes(c.method)), false);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});
test("should refuse a named candidate with wrong ownership or nonempty incomplete stored history", async () => {
  const f = await runtimeFixture(); try {
    for (const changed of [{ id: "synthetic-unowned" }, { cwd: "/synthetic/other" }, { status: { type: "active" } }, { status: { type: "notLoaded" } }, { turns: [{ id: "unowned", status: "completed", itemsView: "full", items: [] }] }, { turns: null }, { historyMode: "paginated" }, { historyMode: null }]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      p.response = method => method === "thread/read" ? { thread: { ...p.thread, ...changed } } : undefined;
      try {
        await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "CONTEXT_UNCONFIRMED" });
        assert.equal(p.calls.filter(c => c.method === "thread/start").length, 1); assert.equal(p.calls.some(c => ["turn/start", "thread/resume"].includes(c.method)), false);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});
test("should withhold a preparation candidate after closure or authority loss at each persistence await", { timeout: 10000 }, async () => {
  const f = await runtimeFixture(); try {
    const stages = ["thread/start", "thread/name/set", "thread/read"];
    for (const stage of stages) for (const close of [false, true]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      let enter!: () => void, release!: () => void, live = true;
      const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
      // The provider may commit a transmitted operation after local cancellation.
      p.response = async method => { if (method === stage) { enter(); await pending; } };
      const job = a.prepare(f.policy.root, f.settings, uuid(), 1, () => { if (!live) throw new RuntimeError("AUTHORITY_LOST"); });
      const rejected = assert.rejects(job, { code: close ? "RUNTIME_CLOSED" : "AUTHORITY_LOST" });
      try {
        await entered; if (close) await a.close(); else live = false;
        release(); await rejected;
        assert.deepEqual(p.calls.filter(c => c.method.startsWith("thread/")).map(c => c.method), stages.slice(0, stages.indexOf(stage) + 1));
        assert.equal(p.calls.some(c => c.method === "turn/start"), false);
        if (stage !== "thread/start") assert.equal(p.storedThreads.size, 1);
      } finally { release(); await a.close(); }
    }
  } finally { await f.close(); }
});
test("should refuse invalid new ownership before sending a naming operation", async () => {
  const f = await runtimeFixture(); try {
    for (const changed of [{ id: "" }, { cwd: "/synthetic/other" }, { status: { type: "active" } }, { turns: [{ id: "unowned" }] }, { turns: null }]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      p.response = (method, params) => method === "thread/start" ? { modelProvider: "openai", thread: { id: "synthetic-new", cwd: params.cwd, status: { type: "idle" }, turns: [], ...changed } } : undefined;
      try {
        await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "CONTEXT_UNCONFIRMED" });
        assert.deepEqual(p.calls.filter(c => c.method.startsWith("thread/")).map(c => c.method), ["thread/start"]);
        assert.equal(p.calls.some(c => c.method === "turn/start"), false);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});
test("should accept the installed legacy history default after confirmed materialization", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); try {
    p.response = method => {
      if (method === "thread/read") { const thread = structuredClone(p.thread); delete thread.historyMode; return { thread }; }
    };
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
    assert.deepEqual(context.ownedTurns, []); assert.equal(p.storedThreads.size, 1);
    assert.equal(p.calls.filter(c => c.method === "thread/name/set").length, 1); assert.equal(p.calls.some(c => c.method === "turn/start"), false);
  } finally { await a.close(); await f.close(); }
});

test("should preserve independent model and effort choices for each binding", async () => {
  const cap = capabilities(); assert.deepEqual(selectSettings(cap, "default"), { model: "test-a", effort: "low" });
  assert.deepEqual(selectSettings(cap, { model: "test-b", effort: "medium" }), { model: "test-b", effort: "medium" }); assert.throws(() => selectSettings(cap, { model: "test-b", effort: "high" }));
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); try {
    const listed = await a.capabilities(f.root, () => {}); assert.equal(listed.models.length, 2);
    p.response = method => method === "model/list" ? { data: [{ id: "duplicate", model: "duplicate", defaultReasoningEffort: "low", isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }], nextCursor: "same" } : undefined;
    await assert.rejects(a.capabilities(f.root, () => {}), { code: "UNSUPPORTED_SETTINGS" });
  } finally { await a.close(); await f.close(); }
});
test("should distinguish requested settings from thread reports and unverified turn effort", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
    const report = await a.validate(context, f.settings, () => {}); assert.equal(report.turn.effortVerification, "UNVERIFIED"); assert.equal(report.thread.effort, "low");
    p.thread.reasoningEffort = "high"; await assert.rejects(a.validate(context, f.settings, () => {}), { code: "UNSUPPORTED_SETTINGS" });
    const evidence = terminalEvidence(context.threadId, "turn", { id: "turn", status: "completed", itemsView: "full", items: [{ type: "agentMessage", id: "item", phase: null, text: "unverified" }] }, [], report);
    assert.equal(evidence?.textProof, "UNCONFIRMED"); assert.equal(evidence?.privateText, "");
  } finally { await a.close(); await f.close(); }
});
test("should reject explicit model aliases and effort clamps while keeping null or absent reports unverified", async () => {
  for (const report of ["model-mismatch", "effort-clamp", "null", "missing"]) {
    const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
    try {
      const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
      if (report === "model-mismatch") p.thread.model = "SYNTHETIC_ALIAS";
      if (report === "effort-clamp") p.thread.reasoningEffort = "high";
      if (report === "null") { p.thread.model = null; p.thread.reasoningEffort = null; }
      if (report === "missing") { delete p.thread.model; delete p.thread.reasoningEffort; }
      if (["model-mismatch", "effort-clamp"].includes(report)) await assert.rejects(a.validate(context, f.settings, () => {}), { code: "UNSUPPORTED_SETTINGS" });
      else { const observed = await a.validate(context, f.settings, () => {}); assert.equal(observed.thread.model, null); assert.equal(observed.thread.effort, null); assert.equal(observed.turn.effortVerification, "UNVERIFIED"); assert.deepEqual(observed.requested, f.settings.requested); }
      assert.equal(p.calls.some(call => call.method === "turn/start"), false);
    } finally { await a.close(); await f.close(); }
  }
});
test("should report only same-turn reroutes without treating native effort annotations as verification", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), turnId = "SYNTHETIC_OWNED_TURN";
    const payload = { requestId: uuid(), cycleId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, roomRevision: 1, requestKind: "ORIGIN" as const, questionId: null, publicText: "SYNTHETIC_PUBLIC", replyText: null, deadline: new Date(Date.now() + 10000).toISOString() };
    const authority: AttemptAuthority = { scope: f.scope, context, attempt: { requestId: payload.requestId, attemptId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, fence: 1, state: "EXECUTING", leaseExpiresAt: payload.deadline, startIntentAt: new Date().toISOString(), payload }, signal: new AbortController().signal, assertLive() {}, ack: async () => {}, tool: async () => ({ success: false, contentItems: [] }) };
    p.response = method => {
      if (method !== "turn/start") return;
      queueMicrotask(() => {
        p.emit("model/rerouted", { threadId: context.threadId, turnId: "SYNTHETIC_OTHER_TURN", toModel: "SYNTHETIC_UNOWNED" });
        p.emit("model/rerouted", { threadId: context.threadId, turnId, toModel: "test-b" });
        p.emit("turn/completed", { threadId: context.threadId, turn: { id: turnId, status: "completed", itemsView: "full", items: [], reasoningEffort: "high", effortVerification: "VERIFIED" } });
      }); return { turn: { id: turnId } };
    };
    const evidence = await a.execute(authority, f.settings, payload, async () => {});
    assert.equal(evidence.observation.turn.model, "test-b"); assert.equal(evidence.observation.turn.rerouted, true); assert.equal(evidence.observation.turn.effortVerification, "UNVERIFIED");
    assert.deepEqual(evidence.observation.requested, f.settings.requested); assert.equal(evidence.observation.thread.effort, "low"); assert.equal(evidence.observation.turn.requestedEffort, "low");
  } finally { await a.close(); await f.close(); }
});
function personalFixture(p: FakeProvider) {
  const server = { command: "SYNTHETIC_COMMAND", args: ["SYNTHETIC_ARG"], enabled: true, required: false, env: { MCP_AUTH_TOKEN: "SYNTHETIC_USER" }, enabled_tools: ["read", "other"], disabled_tools: ["disabled"], default_tools_approval_mode: "auto", tools: { read: { approval_mode: "prompt", output_token_limit: 64 }, other: { approval_mode: "approve" }, unset: {}, automatic: { approval_mode: "auto" } } };
  const summary = { id: "SYNTHETIC_PLUGIN@SYNTHETIC_MARKET", name: "SYNTHETIC_PLUGIN", enabled: true, installed: true, authPolicy: "ON_USE", installPolicy: "AVAILABLE", source: { type: "local", path: "/synthetic/private/plugin" } };
  p.installed = { marketplaces: [{ name: "SYNTHETIC_MARKET", path: "/synthetic/private/market", plugins: [summary] }], marketplaceLoadErrors: [] };
  p.pluginDetails.set(summary.name, { plugin: { summary: structuredClone(summary), marketplaceName: "SYNTHETIC_MARKET", marketplacePath: "/synthetic/private/market", mcpServers: ["bundled.with\"quote", "configured"], hooks: [], skills: [], apps: [], appTemplates: [] } });
  p.policy.config = { ...p.policy.config, approval_policy: "on-request", sandbox_mode: "workspace-write", approvals_reviewer: "auto_review", developer_instructions: "SYNTHETIC_PERSONAL_INSTRUCTIONS", instructions: "SYNTHETIC_BASE", model_instructions_file: "/synthetic/private/instructions", experimental_compact_prompt_file: "/synthetic/private/compact", model_catalog_json: "/synthetic/private/models", web_search: "live", agents: { enabled: true }, shell_environment_policy: { inherit: "all" }, model_providers: { custom: { base_url: "SYNTHETIC_PROVIDER" } }, skills: { include_instructions: true }, memories: { use_memories: true },
    mcp_servers: { "native.with\"quote": server, disabled: { ...server, enabled: false, default_tools_approval_mode: "prompt" } },
    plugins: { [summary.id]: { enabled: true, mcp_servers: { configured: { enabled: false, enabled_tools: ["read"], disabled_tools: ["disabled"], default_tools_approval_mode: "prompt", tools: { read: { approval_mode: "prompt" }, write: { approval_mode: "approve" } }, ema_auth: { authorization_server_issuer: "SYNTHETIC_ISSUER", client_id: "SYNTHETIC_CLIENT", resource: "SYNTHETIC_RESOURCE", url: "SYNTHETIC_URL" } } } }, disabled: { enabled: false } },
    apps: { _default: { enabled: true, destructive_enabled: false, open_world_enabled: true, default_tools_approval_mode: "auto", approvals_reviewer: "auto_review" }, "app.with\"quote": { enabled: false, default_tools_enabled: true, default_tools_approval_mode: "prompt", approvals_reviewer: "auto_review", links: { "account.with\"quote": { approvals_reviewer: "auto_review", default_tools_approval_mode: "approve" }, strict: { default_tools_approval_mode: "prompt" } }, tools: { read: { enabled: true, approval_mode: "prompt" }, other: { enabled: false, approval_mode: "approve" }, unset: {}, automatic: { approval_mode: "auto" } } } },
  };
  p.policy.layers[0].config = { developer_instructions: "SYNTHETIC_PERSONAL_INSTRUCTIONS", hooks: { SessionStart: [{ command: "SYNTHETIC_PERSONAL_HOOK" }] } };
  return structuredClone(p.policy);
}
const gates = ["plugins", "apps", "hooks", "remote_plugin", "skill_mcp_dependency_install", "multi_agent", "multi_agent_v2", "image_generation", "in_app_browser", "browser_use", "browser_use_full_cdp_access", "browser_use_external", "computer_use"];
const expectedTaskConfig = { approval_policy: "never", sandbox_mode: "read-only", approvals_reviewer: "user", features: Object.fromEntries(gates.map(name => [name, false])), agents: { enabled: false }, notify: [] };
test("should preserve personal agent settings without bypassing permissions", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), before = personalFixture(p), launches: string[][] = [];
  p.policy.config.notify = ["SYNTHETIC_LEGACY_NOTIFY"]; p.policy.config.features = { ...(p.policy.config.features as object), apps: true, hooks: true, plugins: true };
  const a = new CodexAdapter({ transportFactory: (_root, overrides) => { launches.push([...overrides]); return p.launch(overrides); } });
  p.response = method => { if (method === "turn/start") { queueMicrotask(() => p.emit("turn/completed", { threadId: p.thread.id, turn: { id: "SYNTHETIC_TURN", status: "completed", itemsView: "full", items: [] } })); return { turn: { id: "SYNTHETIC_TURN" } }; } };
  try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), config = p.policy.config;
    for (const key of ["developer_instructions", "instructions", "model_instructions_file", "experimental_compact_prompt_file", "model_catalog_json", "skills", "memories", "shell_environment_policy", "web_search", "model_providers", "plugins", "apps", "hooks"]) assert.deepEqual(config[key], before.config[key]);
    assert.deepEqual(p.policy.layers, before.layers); assert.equal((config.features as Record<string, unknown>).shell_tool, true); assert.equal((config.features as Record<string, unknown>).code_mode, true); assert.equal((config.features as Record<string, unknown>).memories, true);
    assert.ok(gates.every(name => (config.features as Record<string, unknown>)[name] === false)); assert.deepEqual(config.agents, { enabled: false }); assert.deepEqual(config.notify, []);
    const servers = config.mcp_servers as Record<string, Record<string, unknown>>, original = before.config.mcp_servers as typeof servers;
    for (const name of Object.keys(original)) assert.deepEqual(servers[name], { ...original[name], enabled: false });
    const payload = { requestId: uuid(), cycleId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, roomRevision: 1, requestKind: "ORIGIN" as const, questionId: null, publicText: "SYNTHETIC_PUBLIC", replyText: null, deadline: new Date(Date.now() + 10000).toISOString() };
    const authority: AttemptAuthority = { scope: f.scope, context, attempt: { requestId: payload.requestId, attemptId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, fence: 1, state: "EXECUTING", leaseExpiresAt: payload.deadline, startIntentAt: new Date().toISOString(), payload }, signal: new AbortController().signal, assertLive() {}, ack: async () => {}, tool: async () => ({ success: false, contentItems: [] }) };
    await a.execute(authority, f.settings, payload, async () => {});
    for (const call of p.calls.filter(c => ["thread/start", "thread/resume", "turn/start"].includes(c.method))) {
      assert.equal(call.params.approvalPolicy, "never"); assert.equal(call.params.approvalsReviewer, "user"); assert.equal(Object.hasOwn(call.params, "developerInstructions"), false); assert.equal(Object.hasOwn(call.params, "baseInstructions"), false);
      if (call.method === "turn/start") { assert.deepEqual(call.params.sandboxPolicy, { type: "readOnly", networkAccess: false }); assert.deepEqual(call.params.environments, []); }
      else { assert.equal(call.params.sandbox, "read-only"); assert.deepEqual(call.params.config, { ...expectedTaskConfig, mcp_servers: Object.fromEntries(Object.keys(original).map(name => [name, { enabled: false }])), model_reasoning_effort: "low" }); }
      if (call.method === "thread/start") { assert.deepEqual(call.params.environments, []); assert.deepEqual(call.params.selectedCapabilityRoots, []); }
    }
    const input = p.calls.find(c => c.method === "turn/start")!.params.input as { text: string }[]; assert.ok(input[0].text.startsWith(f.settings.handoff)); assert.ok(input[0].text.includes("Do not edit originals, commit, deploy")); assert.ok(input[0].text.includes("SYNTHETIC_PUBLIC")); assert.ok(!input[0].text.includes("SYNTHETIC_PERSONAL") && !input[0].text.includes("/synthetic/private"));
    assert.equal(launches.length, 2); assert.ok(launches.every(args => args.some(arg => arg.includes('"plugins"=false')))); assert.ok(launches[1].some(arg => arg.includes('"native.with\\"quote"')));
    assert.equal(p.calls.some(c => ["plugin/installed", "plugin/read", "hooks/list", "mcpServerStatus/list"].includes(c.method)), false);
    const capability = await a.capabilities(f.root, () => {}); assert.ok(!JSON.stringify(capability).includes("SYNTHETIC_PERSONAL") && !JSON.stringify(capability).includes("/synthetic/private"));
  } finally { await a.close(); await f.close(); }
});
test("should preserve external instruction compaction and catalog sources and reject later drift", async () => {
  const f = await runtimeFixture(); try {
    for (const field of ["model_instructions_file", "experimental_compact_prompt_file", "model_catalog_json"]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); try {
        p.policy.config[field] = "/synthetic/private/source"; p.policy.layers[0].config = { [field]: "/synthetic/private/source" };
        const before = structuredClone(p.policy.layers);
        const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
        assert.deepEqual(p.policy.layers, before); assert.equal(p.policy.config[field], "/synthetic/private/source");
        p.policy.config[field] = "/synthetic/private/changed-source";
        await assert.rejects(a.validate(context, f.settings, () => {}), { code: "POLICY_UNCONFIRMED" });
        assert.equal(p.calls.some(c => ["thread/resume", "turn/start"].includes(c.method)), false);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});







test("should bind new and resumed contexts to explicit ownership root and epoch", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 2, () => {}); assert.equal(context.epoch, 2); assert.equal(context.level, "L1");
    await assert.rejects(a.validate({ ...context, threadId: "external" }, f.settings, () => {}), { code: "CONTEXT_UNCONFIRMED" });
    p.thread.cwd = "/unknown"; await assert.rejects(a.validate(context, f.settings, () => {}), { code: "CONTEXT_UNCONFIRMED" });
    assert.equal(p.calls.filter(c => c.method === "thread/start").length, 1);
  } finally { await a.close(); await f.close(); }
});
test("should refuse turn submission when resumed history is active unowned or incomplete", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}); context.ownedTurns.push({ turnId: "last-owned", terminal: "COMPLETED" }); context.level = "L2";
    for (const state of [{ status: { type: "active" }, turns: [] }, { status: { type: "idle" }, turns: [{ id: "extra", status: "completed", itemsView: "full", items: [] }] }, { status: { type: "idle" }, turns: [{ id: "last-owned", status: "completed", itemsView: "partial", items: [] }] }]) {
      Object.assign(p.thread, state); await assert.rejects(a.validate(context, f.settings, () => {}));
    }
    Object.assign(p.thread, { status: { type: "idle" }, turns: [{ id: "last-owned", status: "completed", itemsView: "full", items: [] }] });
    const payload = { requestId: uuid(), cycleId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, roomRevision: 1, requestKind: "CONTINUATION" as const, questionId: uuid(), publicText: "Public", replyText: "Reply", deadline: new Date(Date.now() + 10000).toISOString() };
    const authority: AttemptAuthority = { scope: f.scope, context, attempt: { requestId: payload.requestId, attemptId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, fence: 1, state: "EXECUTING", leaseExpiresAt: payload.deadline, startIntentAt: new Date().toISOString(), payload }, signal: new AbortController().signal, assertLive() {}, ack: async () => { assert.fail("Reused terminal ACK must not be admitted"); }, tool: async () => ({ success: true, contentItems: [] }) };
    p.response = method => method === "turn/start" ? { turn: { id: "last-owned" } } : undefined;
    await assert.rejects(a.execute(authority, f.settings, payload, async () => {}), { code: "UNKNOWN" }); assert.equal(p.calls.filter(c => c.method === "turn/start").length, 1);
  } finally { await a.close(); await f.close(); }
});
test("should publish only validated public questions and final text", async () => {
  const f = await runtimeFixture(); try {
    const report = observation(f.settings), terminal = { id: "owned", status: "completed", itemsView: "partial", items: [{ id: "partial", type: "agentMessage", phase: "final_answer", text: "partial" }] };
    assert.equal(terminalEvidence("thread", "owned", terminal, [], report)?.privateText, "");
    const evidence = terminalEvidence("thread", "owned", terminal, [{ id: "comment", type: "agentMessage", phase: "commentary", text: "private" }, { id: "final", type: "agentMessage", phase: "final_answer", text: "public" }], report);
    assert.equal(evidence?.privateText, "public"); assert.equal(terminalEvidence("thread", "other", terminal, [], report), null);
  } finally { await f.close(); }
});

test("should refuse incompatible managed permissions and unknown permission precedence before preparation", async () => {
  const f = await runtimeFixture(); try {
    for (const required of [{ allowedApprovalPolicies: ["on-request"] }, { allowedSandboxModes: ["workspace-write"] }, { autoReview: { requiredOnModels: ["synthetic"] } }, { allowedApprovalPolicies: "never" }, { allowedApprovalsReviewers: ["auto_review"] }]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); p.required = { requirements: required };
      try { await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.some(c => c.method.startsWith("thread/") || c.method === "turn/start"), false); }
      finally { await a.close(); }
    }
    for (const change of [
      (p: FakeProvider) => { p.policy.config.mcp_servers = { native: { command: "SYNTHETIC", default_tools_approval_mode: "unknown" } }; },
      (p: FakeProvider) => { p.policy.config.mcp_servers = { native: { command: "SYNTHETIC", tools: { x: { approval_mode: "auto", hidden_approval: "approve" } } } }; },
      (p: FakeProvider) => { p.policy.config.apps = { _default: { approvals_reviewer: "unknown" } }; },
      (p: FakeProvider) => { p.policy.config.apps = { x: { links: { account: { approvals_reviewer: "unknown" } } } }; },
    ]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); change(p);
      try { await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.some(c => c.method.startsWith("thread/")), false); }
      finally { await a.close(); }
    }
  } finally { await f.close(); }
});


test("should fail closed when effective task overlays or preserved native settings drift", async () => {
  const f = await runtimeFixture(); try {
    for (const change of [
      (p: FakeProvider) => { p.policy.config.approvals_reviewer = "auto_review"; },
      (p: FakeProvider) => { p.policy.config.developer_instructions = "SYNTHETIC_CHANGED"; },
      (p: FakeProvider) => { (p.policy.config.mcp_servers as Record<string, Record<string, unknown>>)['native.with"quote'].enabled = true; },
      (p: FakeProvider) => { (p.policy.config.mcp_servers as Record<string, Record<string, unknown>>)['native.with"quote'].default_tools_approval_mode = "approve"; },
      (p: FakeProvider) => { p.policy.layers[0].config = {}; },
      (p: FakeProvider) => { p.required = { requirements: { additionalDeveloperInstructions: "SYNTHETIC_CHANGED" } }; },
    ]) {
      const p = new FakeProvider(); personalFixture(p); let launches = 0;
      const a = new CodexAdapter({ transportFactory: (_cwd, overrides) => { p.launch(overrides); if (++launches === 2) change(p); return p; } });
      try { await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.some(c => c.method.startsWith("thread/")), false); }
      finally { await a.close(); }
    }
  } finally { await f.close(); }
});



test("should encode literal map identifiers and preserve HTTP OAuth and environment settings", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), launches: string[][] = [], a = new CodexAdapter({ transportFactory: (_cwd, overrides) => { launches.push(overrides); return p.launch(overrides); } });
  const names = ['dot.name', 'quote"name', 'back\\slash', '한글', '__proto__'];
  const server = { url: "SYNTHETIC_URL", enabled: true, auth: "oauth", bearer_token_env_var: "SYNTHETIC_ENV_NAME", env_http_headers: { Authorization: "SYNTHETIC_ENV_NAME" }, http_headers: { "SYNTHETIC_HEADER": "SYNTHETIC_USER_VALUE" }, http_headers_helper: "SYNTHETIC_HELPER", env_vars: ["SYNTHETIC_ENV", { name: "SYNTHETIC_OTHER", source: "SYNTHETIC_SOURCE" }], oauth: { authorization_server_issuer: "SYNTHETIC_ISSUER", client_id: "SYNTHETIC_ID", client_secret: "SYNTHETIC_PRIVATE", callback_port: 4321, callback_url: "SYNTHETIC_CALLBACK" }, tools: { 'tool.with"quote': { approval_mode: "prompt" } } };
  p.policy.config.mcp_servers = Object.fromEntries(names.map(name => [name, structuredClone(server)]));
  try {
    await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {});
    const servers = p.policy.config.mcp_servers as Record<string, Record<string, unknown>>; assert.deepEqual(Object.keys(servers), names);
    for (const name of names) assert.deepEqual(servers[name], { ...server, enabled: false });
    assert.equal(launches[1].filter(arg => arg.startsWith("mcp_servers=")).length, 1); assert.equal(launches[1].some(arg => arg.startsWith("mcp_servers.")), false);
  } finally { await a.close(); await f.close(); }
});

function featureRows() { return gates.map(name => ({ name, stage: "stable", enabled: false, defaultEnabled: true, displayName: null, description: null, announcement: null })); }
test("should read only initial config and requirements before closing and preflighting the effective child", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), before = personalFixture(p); let launches = 0;
  const a = new CodexAdapter({ transportFactory: (cwd, overrides, check) => {
    check(); assert.equal(cwd, f.root);
    if (launches++) { assert.equal(p.closed, true); assert.deepEqual(p.calls.map(call => call.method), ["config/read", "configRequirements/read"]); }
    return p.launch(overrides);
  } });
  try {
    await a.capabilities(f.root, () => {}); assert.equal(p.serverStarts, 2); assert.equal(p.preflights.length, 2);
    assert.deepEqual(p.policy.layers, before.layers); assert.deepEqual(p.policy.config.plugins, before.config.plugins);
    assert.ok(p.preflights.every(overrides => overrides.includes("notify=[]") && overrides.some(arg => arg.includes('"hooks"=false'))));
  } finally { await a.close(); await f.close(); }
});
test("should preserve mandatory requirements and refuse every conflicting managed execution pin", async () => {
  const f = await runtimeFixture(); try {
    for (const name of gates) {
      const p = new FakeProvider(); p.required = { requirements: { featureRequirements: { [name]: true }, additionalDeveloperInstructions: "SYNTHETIC_REQUIRED", allowManagedHooksOnly: true } };
      const before = structuredClone(p.required), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      try { await assert.rejects(a.capabilities(f.root, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.serverStarts, 0); assert.equal(p.calls.length, 0); assert.deepEqual(p.required, before); } finally { await a.close(); }
    }
    const p = new FakeProvider(); p.required = { requirements: { featureRequirements: { plugins: false, hooks: false, shell_tool: true }, additionalDeveloperInstructions: "SYNTHETIC_REQUIRED", allowManagedHooksOnly: true } };
    const before = structuredClone(p.required), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
    try { await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}); assert.deepEqual(p.required, before); assert.equal(p.calls.some(call => call.method === "hooks/list"), false); } finally { await a.close(); }
  } finally { await f.close(); }
});
test("should keep manifest approve and unknown hook or plugin metadata inert under task gates", async () => {
  const f = await runtimeFixture(), p = new FakeProvider();
  p.installed = { unknown: "SYNTHETIC_UNTRUSTED_INVENTORY" }; p.policy.config.plugins = { "SYNTHETIC_UNKNOWN_PLUGIN": { enabled: true, mcp_servers: { external: { default_tools_approval_mode: "approve" } } } };
  p.policy.config.hooks = { SessionStart: [{ enabled: true, command: "SYNTHETIC_UNKNOWN_INJECTION" }], state: { bookkeeping: true } };
  const before = structuredClone(p.policy.config), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  p.response = method => { if (["hooks/list", "plugin/installed", "plugin/read", "mcpServerStatus/list"].includes(method)) throw new Error("SYNTHETIC_FORBIDDEN_DISCOVERY"); };
  try {
    await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}); assert.deepEqual(p.policy.config.plugins, before.plugins); assert.deepEqual(p.policy.config.hooks, before.hooks);
    assert.ok(["hooks", "plugins", "apps"].every(name => (p.policy.config.features as Record<string, unknown>)[name] === false)); assert.equal(p.calls.some(call => call.method.startsWith("plugin/") || call.method === "hooks/list"), false);
  } finally { await a.close(); await f.close(); }
});
test("should validate bounded normalized feature pagination without treating unrelated research features as gates", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), rows = [...featureRows(), { name: "code_mode", stage: "underDevelopment", enabled: true, defaultEnabled: false, displayName: null, description: null, announcement: null }];
  p.response = (method, params) => { if (method === "experimentalFeature/list") { const index = params.cursor === null ? 0 : Number(params.cursor); return { data: rows.slice(index, index + 4), nextCursor: index + 4 < rows.length ? String(index + 4) : null }; } };
  const a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
  try { await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}); assert.ok(p.calls.filter(call => call.method === "experimentalFeature/list").every(call => call.params.limit === 32)); assert.equal((p.policy.config.features as Record<string, unknown>).code_mode, true); }
  finally { await a.close(); await f.close(); }
});
test("should reject malformed missing duplicated unknown or conflicting materialized features before thread admission", async () => {
  const f = await runtimeFixture(); try {
    for (const kind of ["missing", "duplicate", "true", "removed", "beta", "unknown-name", "unknown-stage", "unknown-field", "nonboolean-enabled", "nonboolean-default", "missing-field", "cursor-cycle", "bad-cursor", "oversized", "error"]) {
      const p = new FakeProvider(), rows: Record<string, unknown>[] = featureRows();
      if (kind === "missing") rows.shift(); if (kind === "duplicate") rows.push(structuredClone(rows[0])); if (kind === "true") rows[0].enabled = true;
      if (kind === "removed" || kind === "beta") rows[0].stage = kind; if (kind === "unknown-name") rows[0].name = "SYNTHETIC_UNKNOWN"; if (kind === "unknown-stage") rows[0].stage = "SYNTHETIC_UNKNOWN";
      if (kind === "unknown-field") rows[0].injection = "SYNTHETIC_PRIVATE"; if (kind === "nonboolean-enabled") rows[0].enabled = "false"; if (kind === "nonboolean-default") rows[0].defaultEnabled = null;
      if (kind === "missing-field") delete rows[0].description; if (kind === "oversized") rows[0].description = "x".repeat(65537);
      p.response = method => { if (method === "experimentalFeature/list") { if (kind === "error") throw new Error("SYNTHETIC_PRIVATE_FEATURE_ERROR"); return { data: rows, nextCursor: kind === "cursor-cycle" ? "SYNTHETIC_SAME" : kind === "bad-cursor" ? 1 : null }; } };
      const a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      try { await assert.rejects(a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.some(call => call.method.startsWith("thread/") || call.method === "turn/start"), false); } finally { await a.close(); }
    }
  } finally { await f.close(); }
});
test("should refuse raw task or preserved feature origin layer and requirement drift before new or resumed contexts", async () => {
  const f = await runtimeFixture(); try {
    for (const stage of ["prepare", "resume"]) for (const kind of ["enabled", "new-mcp", "notify", "agent", "research", "origin", "layer", "requirements"]) {
      const p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      try {
        const context = stage === "resume" ? await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}) : null; if (!context) await a.capabilities(f.root, () => {});
        if (kind === "enabled") (p.policy.config.features as Record<string, unknown>).plugins = true;
        if (kind === "new-mcp") p.policy.config.mcp_servers = { SYNTHETIC_NEW: { enabled: false, command: "SYNTHETIC_COMMAND" } };
        if (kind === "notify") p.policy.config.notify = ["SYNTHETIC_NOTIFY"]; if (kind === "agent") p.policy.config.agents = { enabled: true };
        if (kind === "research") (p.policy.config.features as Record<string, unknown>).code_mode = false;
        if (kind === "origin") p.policy.origins = { model: { version: "SYNTHETIC_CHANGED" } }; if (kind === "layer") p.policy.layers[0].version = "SYNTHETIC_CHANGED";
        if (kind === "requirements") p.required = { requirements: { additionalDeveloperInstructions: "SYNTHETIC_CHANGED" } };
        const starts = p.calls.filter(call => call.method === "thread/start").length;
        await assert.rejects(context ? a.validate(context, f.settings, () => {}) : a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" });
        assert.equal(p.calls.filter(call => call.method === "thread/start").length, starts); assert.equal(p.calls.some(call => ["thread/resume", "turn/start"].includes(call.method)), false);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});
test("should revalidate normalized execution features after provider intent and before turn submission", async () => {
  const f = await runtimeFixture(), p = new FakeProvider(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) }); let drift = false;
  p.response = method => method === "experimentalFeature/list" && drift ? { data: featureRows().map(row => row.name === "plugins" ? { ...row, enabled: true } : row), nextCursor: null } : undefined;
  try {
    const context = await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), payload = { requestId: uuid(), cycleId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, roomRevision: 1, requestKind: "ORIGIN" as const, questionId: null, publicText: "SYNTHETIC_PUBLIC", replyText: null, deadline: new Date(Date.now() + 10000).toISOString() };
    const authority: AttemptAuthority = { scope: f.scope, context, attempt: { requestId: payload.requestId, attemptId: uuid(), agentId: f.scope.agentId, bindingEpoch: 1, fence: 1, state: "EXECUTING", leaseExpiresAt: payload.deadline, startIntentAt: new Date().toISOString(), payload }, signal: new AbortController().signal, assertLive() {}, ack: async () => assert.fail("SYNTHETIC_UNAUTHORIZED_ACK"), tool: async () => ({ success: false, contentItems: [] }) };
    await assert.rejects(a.execute(authority, f.settings, payload, async () => { drift = true; }), { code: "POLICY_UNCONFIRMED" }); assert.equal(p.calls.some(call => call.method === "turn/start"), false);
  } finally { await a.close(); await f.close(); }
});
test("should reject late initial preflight completion after adapter closure or authority loss without spawning", async () => {
  const f = await runtimeFixture(); try {
    for (const close of [true, false]) {
      const p = new FakeProvider(), entered = deferred(), release = deferred(); let revoked = false, factories = 0;
      const a = new CodexAdapter({ transportFactory: async (_cwd, overrides, check) => { entered.resolve(); await release.promise; check(); factories++; return p.launch(overrides); } });
      const failed = assert.rejects(a.capabilities(f.root, () => { if (revoked) throw new RuntimeError("AUTHORITY_LOST"); }), { code: close ? "RUNTIME_CLOSED" : "AUTHORITY_LOST" });
      await entered.promise; if (close) await a.close(); else revoked = true; release.resolve(); await failed; assert.equal(factories, 0); assert.equal(p.serverStarts, 0); assert.equal(p.calls.length, 0);
      await a.close();
    }
  } finally { await f.close(); }
});
test("should refuse materialized boolean drift before preparation or resume and permanently close that child", async () => {
  const f = await runtimeFixture(); try {
    for (const stage of ["prepare", "resume"]) for (const field of ["enabled", "defaultEnabled"]) {
      const p = new FakeProvider(), rows = featureRows(), a = new CodexAdapter({ transportFactory: (_cwd, overrides) => p.launch(overrides) });
      p.response = method => method === "experimentalFeature/list" ? { data: structuredClone(rows), nextCursor: null } : undefined;
      try {
        const context = stage === "resume" ? await a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}) : null; if (!context) await a.capabilities(f.root, () => {});
        rows[0][field as "enabled" | "defaultEnabled"] = !rows[0][field as "enabled" | "defaultEnabled"];
        await assert.rejects(context ? a.validate(context, f.settings, () => {}) : a.prepare(f.policy.root, f.settings, uuid(), 1, () => {}), { code: "POLICY_UNCONFIRMED" });
        assert.equal(p.closed, true); assert.equal(p.calls.some(call => ["thread/resume", "turn/start"].includes(call.method)), false); assert.equal(p.calls.filter(call => call.method === "thread/start").length, context ? 1 : 0);
        await assert.rejects(a.capabilities(f.root, () => {}), { code: "RUNTIME_CLOSED" }); assert.equal(p.serverStarts, 2);
      } finally { await a.close(); }
    }
  } finally { await f.close(); }
});
