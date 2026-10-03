import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApprovalBudget, OwnedProbeStore, ProbeError, digest } from "../src/owned-probe-store.js";
import { NativeTransport } from "../src/native-transport.js";
import { TaskPolicy, SelectedFiles, providerEnvironment } from "../src/task-policy.js";
import { readExactOwnedHistory } from "../src/native-runtime.js";
import { Fixture, deferred, syntheticEvidence } from "./helpers.js";

const code = (expected: string) => (error: unknown) => error instanceof ProbeError && error.code === expected;

test("should reject unconfirmed startup execution before launching native CLI", async () => {
  const f = new Fixture();
  try {
    await f.store.withLock(async () => {
      for (const policy of [new TaskPolicy(), f.policy({ ...syntheticEvidence, managed: "CONFLICT" }),
        f.policy({ ...syntheticEvidence, inheritedHooks: "UNCONFIRMED" }),
        f.policy({ ...syntheticEvidence, initialUserMessage: "PRESENT" })]) {
        const runtime = f.runtime("normal", {}, f.store, policy);
        await assert.rejects(runtime.initialize(), (error: unknown) => error instanceof ProbeError);
        await runtime.close();
      }
      assert.equal(f.spawnCount, 0);
      assert.equal(f.budget.read().slots.length, 0);
    });
    // The actual experiment CLI has no constructor injection or boolean policy-proof escape.
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const child = spawn(process.execPath, [cli, "probe-zero", "--native-opt-in", "--approval", f.approvalPath,
      "--approval-id", f.approvalId, "--root", f.root, "--state", join(f.directory, "new-state"),
      "--claude", "/SYNTHETIC_MUST_NOT_SPAWN"], { env: { TMPDIR: process.env.TMPDIR }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
    const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(exit, 1);
    assert.deepEqual(JSON.parse(output), { status: "REFUSED", code: "EXECUTION_PRECEDENCE_UNCONFIRMED" });
    assert.equal(f.events().length, 0);
  } finally { f.dispose(); }
});

test("should preserve personal settings while enforcing the task tool boundary", async () => {
  const f = new Fixture();
  const before = [readFileSync(f.source), readFileSync(f.instruction)];
  try {
    const source = { OPENAI_API_KEY: "SYNTHETIC_OFFICIAL", ANTHROPIC_API_KEY: "SYNTHETIC_OFFICIAL",
      MCP_AUTH_TOKEN: "SYNTHETIC_PERSONAL", CUSTOM_HOOK_KEY: "SYNTHETIC_PERSONAL", HTTPS_PROXY: "SYNTHETIC_PROXY",
      CODEX_HOME: "SYNTHETIC_HOME", CLAUDE_CONFIG_DIR: "SYNTHETIC_PROFILE", LOCAL_ACCESS_ADMIN: "SYNTHETIC_ADMIN",
      AI_COLLAB_INJECTION: "SYNTHETIC_PRODUCT", DATABASE_URL: "SYNTHETIC_DB", JWT_SECRET: "SYNTHETIC_SIGNING" };
    const copy = structuredClone(source);
    const env = providerEnvironment(source);
    assert.deepEqual(source, copy);
    assert.equal(env.MCP_AUTH_TOKEN, "SYNTHETIC_PERSONAL");
    assert.equal(env.ANTHROPIC_API_KEY, "SYNTHETIC_OFFICIAL");
    for (const key of ["LOCAL_ACCESS_ADMIN", "AI_COLLAB_INJECTION", "DATABASE_URL", "JWT_SECRET"]) assert.equal(env[key], undefined);
    const productNames = ["DIRECT_URL", "DB_PASSWORD", "GOTRUE_JWT_SECRET", "PGRST_JWT_SECRET", "SERVER_SECRET",
      "LOCAL_AUTH_TOKEN", "SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_JWT_SECRET",
      "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "APP_ORIGIN", "LOCAL_ACCESS_FIXTURE_WORKDIR", "AI_COLLAB_CONTROL"];
    const productEnv = Object.fromEntries(productNames.map((name) => [name, "SYNTHETIC_RESERVED_VALUE"]));
    assert.deepEqual(providerEnvironment(productEnv), {});
    await f.store.withLock(async () => {
      const runtime = f.runtime();
      try {
        await runtime.initialize();
        const launch = f.events().find((e) => e.event === "launch")!;
        const args = launch.argv as string[];
        assert.equal(args[args.indexOf("--setting-sources") + 1], "user,project,local");
        assert.equal(args[args.indexOf("--tools") + 1], "");
        assert.ok(args.includes("--strict-mcp-config"));
        assert.ok(!args.some((a) => ["--bare", "--safe-mode", "--restricted", "--model", "--effort"].includes(a)));
        assert.deepEqual(JSON.parse(args[args.indexOf("--settings") + 1]!),
          { disableAllHooks: true, enabledPlugins: { "synthetic.plugin@market": false } });
        assert.deepEqual(launch.env, { SYNTHETIC_USER_KEY: "SYNTHETIC_USER_VALUE" });
      } finally { await runtime.close(); }
    });
    assert.deepEqual([readFileSync(f.source), readFileSync(f.instruction)], before);
  } finally { f.dispose(); }
});

test("should distinguish host reservation from native session persistence", async (t) => {
  for (const mode of ["normal", "no-materialize", "wrong-session", "wrong-cwd", "no-init", "startup-turn"]) {
    await t.test(mode, async () => {
      const f = new Fixture();
      try {
        assert.equal(f.store.read().initialized, false);
        assert.equal(f.store.read().persistence, "UNVERIFIED");
        await f.store.withLock(async () => {
          const runtime = f.runtime(mode);
          try {
            if (["wrong-session", "wrong-cwd", "no-init", "startup-turn"].includes(mode)) {
              await assert.rejects(runtime.initialize());
            } else {
              await runtime.initialize();
              if (mode === "normal") assert.equal(await runtime.probeZero(), "PERSISTED_ZERO");
              else {
                await assert.rejects(runtime.probeZero(), code("NATIVE_NOT_MATERIALIZED"));
                assert.equal(f.store.read().persistence, "NATIVE_NOT_MATERIALIZED");
              }
            }
          } finally { assert.equal((await runtime.close()).reaped, true); }
        });
        if (mode === "normal") await f.store.withLock(async () => {
          const fresh = f.runtime();
          try { await fresh.initialize(true); assert.equal(await fresh.probeZero(), "PERSISTED_ZERO"); }
          finally { await fresh.close(); }
        });
        assert.equal(f.events().filter((e) => e.event === "input").length, 0);
        const missing = await readExactOwnedHistory(join(f.native, `${randomUUID()}.jsonl`), randomUUID(), f.root).catch(() => null);
        assert.equal(missing, null);
      } finally { f.dispose(); }
    });
  }
});

test("should persist input intent before submission and retain ambiguous attempts", async (t) => {
  await t.test("intent fsync fails before any input", async () => {
    const f = new Fixture();
    let fail = false;
    const store = new OwnedProbeStore(f.store.directory, () => { if (fail) throw new Error("SYNTHETIC_FSYNC_FAILURE"); });
    try {
      await store.withLock(async () => {
        const runtime = f.runtime("normal", {}, store);
        try {
          await runtime.initialize();
          fail = true;
          await assert.rejects(runtime.input("probe-tools", "SYNTHETIC_PROMPT"), code("STORAGE_FAILED"));
          assert.equal(f.budget.read().slots.length, 1);
          assert.equal(f.events().filter((e) => e.event === "input").length, 0);
        } finally { fail = false; await runtime.close(); }
      });
      const calls = f.spawnCount;
      await f.store.withLock(async () => {
        const fresh = f.runtime();
        try { await assert.rejects(fresh.initialize(), code("INPUT_UNRESOLVED")); }
        finally { await fresh.close(); }
      });
      assert.equal(f.spawnCount, calls);
    } finally { f.dispose(); }
  });
  for (const mode of ["lose-ack", "no-terminal"]) await t.test(mode, async () => {
    const f = new Fixture();
    try {
      await f.store.withLock(async () => {
        const runtime = f.runtime(mode, { transport: { probeMs: 200, requestMs: 100, closeMs: [20, 30, 30] } });
        try { await runtime.initialize(); await assert.rejects(runtime.input("probe-tools", "SYNTHETIC_PROMPT")); }
        finally { await runtime.close(); }
      });
      assert.equal(f.store.read().inputs[0]!.phase, "UNKNOWN");
      const calls = f.spawnCount;
      await f.store.withLock(async () => {
        const runtime = f.runtime();
        try { await assert.rejects(runtime.initialize(true), code("INPUT_UNRESOLVED")); }
        finally { await runtime.close(); }
      });
      assert.equal(f.spawnCount, calls);
      assert.equal(f.budget.read().slots.length, 1);
    } finally { f.dispose(); }
  });
});

test("should correlate native input tool dispatch and typed result", async (t) => {
  for (const mode of ["normal", "duplicate-call", "bad-correlation", "foreign-tool-session", "foreign-tool-id", "foreign-result", "model-less", "missing-terminal-reason", "late-tool"]) {
    await t.test(mode, async () => {
      const f = new Fixture();
      try {
        await f.store.withLock(async () => {
          const runtime = f.runtime(mode);
          try {
            await runtime.initialize();
            if (["normal", "duplicate-call"].includes(mode)) {
              assert.equal(await runtime.input("probe-tools", "SYNTHETIC_PROMPT"), "COMPLETED");
              const s = f.store.read();
              assert.equal(s.inputs[0]!.phase, "COMPLETED");
              assert.equal(s.evidence.filter((e) => e.kind === "TOOL_CALLBACK").length, 2);
              assert.equal(runtime.defaults.observedModel, "synthetic-wire-model");
              assert.ok(s.inputs[0]!.terminal!.text!.includes("SYNTHETIC_FIRST_MARKER"));
            } else {
              await assert.rejects(runtime.input("probe-tools", "SYNTHETIC_PROMPT"));
              assert.equal(f.store.read().inputs[0]!.phase, "UNKNOWN");
              if (mode === "late-tool") assert.equal(f.store.read().evidence.filter((e) => e.kind === "TOOL_CALLBACK").length, 0);
            }
          } finally { await runtime.close(); }
        });
      } finally { f.dispose(); }
    });
  }
});

test("should read only unchanged selected files", () => {
  const f = new Fixture();
  const path = join(f.root, "owned-fixture.txt");
  try {
    assert.equal(f.files.read("owned-fixture.txt", () => {}), "SYNTHETIC_FIRST_MARKER");
    assert.throws(() => f.files.read("../owned-fixture.txt", () => {}), code("FILE_REJECTED"));
    const other = join(f.root, "other.txt");
    writeFileSync(other, "SYNTHETIC_OTHER", { mode: 0o600 });
    assert.throws(() => f.files.read("other.txt", () => {}), code("FILE_REJECTED"));
    renameSync(path, join(f.root, "original.txt"));
    symlinkSync(join(f.root, "original.txt"), path);
    assert.throws(() => new SelectedFiles(f.root, ["owned-fixture.txt"]), code("FILE_REJECTED"));
    unlinkSync(path);
    linkSync(join(f.root, "original.txt"), path);
    assert.throws(() => new SelectedFiles(f.root, ["owned-fixture.txt"]), code("FILE_REJECTED"));
    unlinkSync(path);
    writeFileSync(path, "SYNTHETIC_FIRST_MARKER", { mode: 0o600 });
    assert.throws(() => f.files.read("owned-fixture.txt", () => {}), code("FILE_REJECTED"));
    writeFileSync(path, "x".repeat(65537));
    assert.throws(() => new SelectedFiles(f.root, ["owned-fixture.txt"]), code("FILE_REJECTED"));
    writeFileSync(path, "token=SYNTHETIC_DUMMY");
    assert.throws(() => new SelectedFiles(f.root, ["owned-fixture.txt"]), code("FILE_REJECTED"));
    writeFileSync(path, "SYNTHETIC_ORIGINAL");
    const unchanged = new SelectedFiles(f.root, ["owned-fixture.txt"]);
    writeFileSync(path, "SYNTHETIC_MODIFIED");
    assert.throws(() => unchanged.read("owned-fixture.txt", () => {}), code("FILE_REJECTED"));
  } finally { f.dispose(); }
});

test("should separate interruption acknowledgement from native terminal evidence", async (t) => {
  for (const mode of ["normal", "interrupt-ack-only", "natural-race"]) await t.test(mode, async () => {
    const f = new Fixture();
    const entered = deferred();
    const release = deferred();
    try {
      await f.store.withLock(async () => {
        const runtime = f.runtime(mode, { toolResponseGate: async (name) => {
          if (mode === "natural-race") { if (name === "ask_peer") entered.resolve(); return; }
          entered.resolve(); await release.promise;
        },
          transport: { probeMs: 600, requestMs: 200, closeMs: [20, 50, 50] } });
        try {
          await runtime.initialize();
          const running = runtime.input("probe-interrupt", "SYNTHETIC_INTERRUPT");
          void running.catch(() => {});
          await entered.promise;
          if (mode === "natural-race") {
            const deadline = performance.now() + 1000;
            while (f.events().filter((e) => e.event === "tool-response").length !== 2 && performance.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            assert.equal(f.events().filter((e) => e.event === "tool-response").length, 2);
          }
          await runtime.interrupt();
          assert.equal(runtime.interruptReceiptObserved, true);
          if (mode === "interrupt-ack-only") {
            assert.equal(f.store.read().inputs[0]!.terminal, null);
            await assert.rejects(running);
            assert.equal(f.store.read().inputs[0]!.phase, "UNKNOWN");
          } else assert.equal(await running, mode === "natural-race" ? "COMPLETED" : "INTERRUPTED");
        } finally { await runtime.close(); release.resolve(); }
      });
    } finally { f.dispose(); }
  });
});

test("should leave missing default effort unverified", async (t) => {
  for (const mode of ["normal", "null-effort", "effort-high", "bad-effort"]) await t.test(mode, async () => {
    const f = new Fixture();
    try {
      await f.store.withLock(async () => {
        const runtime = f.runtime(mode);
        try {
          if (mode === "bad-effort") await assert.rejects(runtime.initialize(), code("PROTOCOL_REJECTED"));
          else {
            await runtime.initialize();
            assert.equal(runtime.defaults.requestedModel, null);
            assert.equal(runtime.defaults.initializedModel, "synthetic-alias");
            assert.equal(runtime.defaults.observedModel, null);
            assert.equal(runtime.defaults.models[0]!.resolvedModel, "synthetic-wire-model");
            assert.deepEqual(runtime.defaults.effort, mode === "effort-high" ? { status: "OBSERVED", value: "high" } : { status: "UNVERIFIED" });
          }
        } finally { await runtime.close(); }
      });
    } finally { f.dispose(); }
  });
});

test("should bound protocol IO and reap only owned processes", async (t) => {
  for (const mode of ["oversize", "invalid-utf8", "stderr-oversize", "hold-control", "exit-after-init", "ignore-close"]) {
    await t.test(mode, async () => {
      const f = new Fixture();
      try {
        const policy = f.policy();
        policy.admit();
        const transport = new NativeTransport(f.launch(mode, policy.arguments(f.store.read().sessionId, false)), () => policy.assertLive(),
          { requestMs: 100, probeMs: 1000, closeMs: [20, 30, 50] });
        transport.setHandler(async () => {}, () => {});
        try {
          const result = transport.request({ subtype: "initialize" });
          if (["ignore-close", "exit-after-init"].includes(mode)) await result;
          else await assert.rejects(result);
        } finally {
          const started = performance.now();
          assert.equal((await transport.close()).reaped, true);
          assert.ok(performance.now() - started < 1500);
          assert.equal(transport.pendingCount, 0);
          await assert.rejects(transport.write({ type: "user", message: { role: "user", content: "SYNTHETIC_CLOSED" } }));
        }
      } finally { f.dispose(); }
    });
  }
  await t.test("pending limit rejects the thirty-third request", async () => {
    const f = new Fixture();
    try {
      const policy = f.policy(); policy.admit();
      const transport = new NativeTransport(f.launch("hold-control", policy.arguments(f.store.read().sessionId, false)), () => policy.assertLive());
      const requests = Array.from({ length: 32 }, () => transport.request({ subtype: "initialize" }).catch((error: unknown) => error));
      try {
        await assert.rejects(transport.request({ subtype: "initialize" }), code("PROTOCOL_LIMIT"));
        assert.equal(transport.signal.aborted, true);
      } finally {
        assert.equal((await transport.close()).reaped, true);
        assert.equal((await Promise.all(requests)).length, 32);
      }
    } finally { f.dispose(); }
  });
  await t.test("uncooperative callback is permanently closed and cleanup remains incomplete", async () => {
    const f = new Fixture();
    const held = deferred();
    try {
      const policy = f.policy(); policy.admit();
      const transport = new NativeTransport(f.launch("normal", policy.arguments(f.store.read().sessionId, false)), () => policy.assertLive());
      transport.setHandler(async () => { await held.promise; transport.assertLive(); }, () => {});
      await transport.request({ subtype: "initialize" });
      const start = performance.now();
      assert.deepEqual(await transport.close(), { reaped: true, code: "CLEANUP_INCOMPLETE" });
      assert.ok(performance.now() - start < 2000);
      held.resolve();
      assert.throws(() => transport.assertLive(), code("TRANSPORT_CLOSED"));
    } finally { held.resolve(); f.dispose(); }
  });
});

test("should retain one approval budget across commands processes and roots", async () => {
  const f = new Fixture();
  try {
    for (let index = 0; index < 3; index++) await f.store.withLock(async () => {
      const runtime = f.runtime();
      try {
        await runtime.initialize(index > 0);
        assert.equal(await runtime.input(index === 2 ? "probe-interrupt" : "probe-tools", `SYNTHETIC_INPUT_${index}`), "COMPLETED");
      } finally { await runtime.close(); }
    });
    assert.equal(f.budget.read().slots.length, 3);
    const root = join(f.directory, "other-root"); mkdirSync(root, { mode: 0o700 });
    const other = OwnedProbeStore.reserve(join(f.directory, "other-state"), root);
    const freshBudget = new ApprovalBudget(f.approvalPath, f.approvalId);
    await other.withLock(async () => {
      await assert.rejects(freshBudget.consume(other, "probe-tools", "SYNTHETIC_FOURTH", () => {}), code("BUDGET_EXHAUSTED"));
    });
    assert.throws(() => new ApprovalBudget(f.approvalPath, randomUUID()), code("BUDGET_IDENTITY"));
    const bytes = readFileSync(f.approvalPath);
    const anchor = JSON.parse(bytes.toString()) as { budgetId: string };
    anchor.budgetId = randomUUID(); writeFileSync(f.approvalPath, JSON.stringify(anchor));
    assert.throws(() => f.budget.read(), code("BUDGET_IDENTITY"));
    writeFileSync(f.approvalPath, bytes);
    chmodSync(f.approvalPath, 0o644);
    assert.throws(() => new ApprovalBudget(f.approvalPath, f.approvalId), code("BUDGET_IDENTITY"));
  } finally { f.dispose(); }
});

test("should serialize concurrent budget claims and retain consumed slots in fresh processes", async () => {
  const f = new Fixture();
  try {
    const childProgram = `
      import { ApprovalBudget, OwnedProbeStore, ProbeError } from ${JSON.stringify(new URL("../src/owned-probe-store.js", import.meta.url).href)};
      const [approvalPath, approvalId, root, state, command] = process.argv.slice(1);
      try {
        const budget = new ApprovalBudget(approvalPath, approvalId);
        const store = OwnedProbeStore.reserve(state, root);
        await store.withLock(async () => { await budget.consume(store, command, "SYNTHETIC_CHILD_INPUT", () => {}); });
        process.stdout.write("CONSUMED");
      } catch (error) { process.stdout.write(error instanceof ProbeError ? error.code : "SYNTHETIC_UNKNOWN"); }
    `;
    const run = async (index: number): Promise<string> => {
      const root = join(f.directory, `process-root-${index}`); mkdirSync(root, { mode: 0o700 });
      const child = spawn(process.execPath, ["--input-type=module", "-e", childProgram, f.approvalPath, f.approvalId,
        root, join(f.directory, `process-state-${index}`), index % 2 ? "probe-interrupt" : "probe-tools"],
        { env: { TMPDIR: process.env.TMPDIR }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
      const exit = await new Promise<number | null>((resolve) => child.once("close", resolve));
      assert.equal(exit, 0);
      return output;
    };
    // Force an exact held lock boundary rather than relying on scheduler coincidence.
    const lock = join(f.directory, "budget.lock");
    writeFileSync(lock, "SYNTHETIC_OWNED_LOCK", { mode: 0o600 });
    assert.deepEqual(await Promise.all([run(0), run(1)]), ["BUSY", "BUSY"]);
    assert.equal(f.budget.read().slots.length, 0);
    unlinkSync(lock);
    for (const index of [2, 3, 4]) assert.equal(await run(index), "CONSUMED");
    assert.equal(await run(5), "BUDGET_EXHAUSTED");
    assert.equal(f.budget.read().slots.length, 3);
    assert.deepEqual(f.budget.read().slots.map((s) => s.command), ["probe-tools", "probe-interrupt", "probe-tools"]);
    assert.equal(f.spawnCount, 0);
  } finally { f.dispose(); }
});

test("should refuse journal forgery and retain immutable terminal evidence", async () => {
  const f = new Fixture();
  try {
    await f.store.withLock(async () => {
      const runtime = f.runtime();
      try {
        await runtime.initialize();
        await runtime.input("probe-tools", "SYNTHETIC_IMMUTABLE");
        const bytes = readFileSync(f.store.path);
        assert.throws(() => f.store.update((s) => { s.inputs[0]!.inputId = randomUUID(); }), code("UNSAFE_STORAGE"));
        assert.throws(() => f.store.update((s) => { s.inputs[0]!.terminal!.text = "SYNTHETIC_FORGED"; }), code("UNSAFE_STORAGE"));
        assert.throws(() => f.store.update((s) => { s.inputs[0]!.phase = "INTENT"; s.inputs[0]!.terminal = null; }), code("UNSAFE_STORAGE"));
        assert.deepEqual(readFileSync(f.store.path), bytes);
      } finally { await runtime.close(); }
    });
  } finally { f.dispose(); }
});

test("should close callbacks and reap the owned child after callback-free policy drift", async () => {
  const f = new Fixture();
  try {
    await f.store.withLock(async () => {
      const runtime = f.runtime("lose-ack", { driftMs: 10 });
      try {
        await runtime.initialize();
        const running = runtime.input("probe-tools", "SYNTHETIC_DRIFT");
        void running.catch(() => {});
        // Wait for the durable send boundary, not accelerated wall-clock timers.
        while (f.store.read().inputs[0]?.phase !== "TRANSMITTED") await new Promise((resolve) => setImmediate(resolve));
        writeFileSync(f.source, '{"language":"SYNTHETIC_CHANGED"}\n');
        await assert.rejects(running, code("POLICY_DRIFT"));
        assert.equal(f.store.read().inputs[0]!.phase, "UNKNOWN");
        assert.equal(f.store.read().inputs[0]!.terminal, null);
        await assert.rejects(runtime.input("probe-tools", "SYNTHETIC_LATE"));
      } finally { assert.equal((await runtime.close()).reaped, true); }
      assert.equal(f.store.read().cleanup, "REAPED");
      assert.equal(f.store.read().evidence.filter((e) => e.kind === "TOOL_CALLBACK").length, 0);
    });
  } finally { f.dispose(); }
});

test("should replace only owned fixture snapshots between reaped inputs", async () => {
  const f = new Fixture();
  try {
    await f.store.withLock(async () => {
      const first = f.runtime();
      try {
        await first.initialize();
        assert.equal(await first.input("probe-tools", "Read selected file and ask synthetic peer"), "COMPLETED");
        assert.throws(() => first.replaceFixture("owned-fixture.txt", "SYNTHETIC_SECOND_MARKER"), code("FILE_REJECTED"));
      } finally { await first.close(); }
      assert.equal(first.reaped, true);
      const old = f.files.snapshots()[0]!;
      first.replaceFixture("owned-fixture.txt", "SYNTHETIC_SECOND_MARKER");
      const updated = f.files.snapshots();
      assert.notEqual(old.ino, updated[0]!.ino);
      assert.notEqual(old.hash, updated[0]!.hash);
      const second = f.runtime();
      try {
        await second.initialize(true);
        assert.equal(await second.input("probe-tools", "Read selected file and remember previous context"), "COMPLETED");
        const text = f.store.read().inputs[1]!.terminal!.text!;
        assert.ok(text.includes("SYNTHETIC_FIRST_MARKER"));
        assert.ok(text.includes("SYNTHETIC_SECOND_MARKER"));
        assert.throws(() => second.replaceFixture("owned-fixture.txt", "SYNTHETIC_BAD"), code("FILE_REJECTED"));
        writeFileSync(join(f.root, "owned-fixture.txt"), "SYNTHETIC_UNEXPECTED");
        assert.throws(() => f.files.read("owned-fixture.txt", () => {}), code("FILE_REJECTED"));
        assert.equal(digest("SYNTHETIC_SECOND_MARKER"), updated[0]!.hash);
      } finally { await second.close(); }
    });
  } finally { f.dispose(); }
});


test("should settle unknown control response subtype and release the owned session lock", async (t) => {
  for (const boundary of ["request", "initialize"]) await t.test(boundary, async () => {
    const f = new Fixture();
    let outcome = "WATCHDOG_EXPIRED";
    let elapsed = 0;
    try {
      await f.store.withLock(async () => {
        const options = { requestMs: 300, probeMs: 1500, closeMs: [20, 50, 50] as [number, number, number] };
        const runtime = boundary === "initialize" ? f.runtime("unknown-response-subtype", { transport: options }) : null;
        const policy = f.policy();
        policy.admit();
        const transport = boundary === "request" ? new NativeTransport(
          f.launch("unknown-response-subtype", policy.arguments(f.store.read().sessionId, false)),
          () => { f.store.assertLocked(); policy.assertLive(); }, options) : null;
        transport?.setHandler(async () => {}, () => {});
        let watchdog: NodeJS.Timeout | undefined;
        const started = performance.now();
        try {
          const pending = runtime ? runtime.initialize() : transport!.request({ subtype: "initialize" });
          const settled = pending.then(() => "UNEXPECTED_SUCCESS", (error: unknown) =>
            error instanceof ProbeError ? error.code : "UNEXPECTED_ERROR");
          outcome = await Promise.race([settled, new Promise<string>((resolve) => {
            watchdog = setTimeout(() => resolve("WATCHDOG_EXPIRED"), 600);
          })]);
          elapsed = performance.now() - started;
        } finally {
          if (watchdog) clearTimeout(watchdog);
          const cleanup = await (runtime ? runtime.close() : transport!.close());
          assert.deepEqual(cleanup, { reaped: true, code: "REAPED" });
          if (transport) assert.equal(transport.pendingCount, 0);
          if (runtime) assert.equal(f.store.read().cleanup, "REAPED");
        }
      });
      // Reacquire only after the owned child and asynchronous jobs have drained.
      const fresh = new OwnedProbeStore(f.store.directory);
      await fresh.withLock(async () => { fresh.assertLocked(); });
      assert.equal(f.events().filter((e) => e.event === "input").length, 0);
      assert.equal(outcome, "PROTOCOL_REJECTED");
      assert.ok(elapsed < 600, "request must settle before the bounded watchdog");
    } finally { f.dispose(); }
  });
});

test("should reject non-string initialization effort and tool protocol enums", async (t) => {
  for (const field of ["init-effort", "init-tool", "catalog-effort"]) {
    for (const shape of ["array", "object"]) await t.test(`${field}-${shape}`, async () => {
      const f = new Fixture();
      try {
        await f.store.withLock(async () => {
          const runtime = f.runtime(`${field}-${shape}`);
          try {
            await assert.rejects(runtime.initialize(), code(field === "init-tool" ? "NATIVE_IDENTITY" : "PROTOCOL_REJECTED"));
            assert.deepEqual(runtime.defaults.effort, { status: "UNVERIFIED" });
            assert.equal(f.store.read().initialized, field === "catalog-effort");
          } finally { assert.equal((await runtime.close()).reaped, true); }
        });
        assert.equal(f.events().filter((e) => e.event === "input").length, 0);
        assert.equal(f.budget.read().slots.length, 0);
      } finally { f.dispose(); }
    });
  }
});

test("should retain UNKNOWN input for non-string terminal reasons", async (t) => {
  for (const shape of ["array", "object"]) await t.test(shape, async () => {
    const f = new Fixture();
    try {
      await f.store.withLock(async () => {
        const runtime = f.runtime(`terminal-reason-${shape}`);
        try {
          await runtime.initialize();
          await assert.rejects(runtime.input("probe-tools", "SYNTHETIC_MALFORMED_TERMINAL"), code("TERMINAL_UNCONFIRMED"));
        } finally { assert.equal((await runtime.close()).reaped, true); }
      });
      const saved = readFileSync(f.store.path);
      assert.equal(f.store.read().inputs[0]!.phase, "UNKNOWN");
      assert.equal(f.store.read().inputs[0]!.terminal, null);
      assert.equal(f.budget.read().slots.length, 1);
      const calls = f.spawnCount;
      await f.store.withLock(async () => {
        const runtime = f.runtime();
        try { await assert.rejects(runtime.initialize(true), code("INPUT_UNRESOLVED")); }
        finally { await runtime.close(); }
      });
      assert.equal(f.spawnCount, calls);
      assert.deepEqual(readFileSync(f.store.path), saved);
      assert.equal(f.events().filter((e) => e.event === "input").length, 1);
    } finally { f.dispose(); }
  });
});

test("should reject non-string assistant and MCP tool names before callback dispatch", async (t) => {
  for (const field of ["assistant-tool", "mcp-tool"]) {
    for (const shape of ["array", "object"]) await t.test(`${field}-${shape}`, async () => {
      const f = new Fixture();
      try {
        await f.store.withLock(async () => {
          const runtime = f.runtime(`${field}-${shape}`);
          try {
            await runtime.initialize();
            await assert.rejects(runtime.input("probe-tools", "SYNTHETIC_MALFORMED_TOOL"));
            assert.equal(f.store.read().inputs[0]!.phase, "UNKNOWN");
            assert.equal(f.store.read().inputs[0]!.terminal, null);
            assert.equal(f.store.read().evidence.filter((e) => e.kind === "TOOL_CALLBACK").length, 0);
          } finally { assert.equal((await runtime.close()).reaped, true); }
        });
        assert.equal(f.budget.read().slots.length, 1);
      } finally { f.dispose(); }
    });
  }
});

test("should reject non-string owned history record types before resume launch", async (t) => {
  for (const shape of ["array", "object"]) await t.test(shape, async () => {
    const f = new Fixture();
    try {
      await f.store.withLock(async () => {
        const runtime = f.runtime("normal", { history: async () => ({ materialized: true,
          sessionId: f.store.read().sessionId, root: f.root, records: [{ session_id: f.store.read().sessionId,
            cwd: f.root, subtype: "init", type: shape === "array" ? ["system"] : { value: "system" } }] }) });
        try { await assert.rejects(runtime.initialize(true), code("HISTORY_UNCONFIRMED")); }
        finally { await runtime.close(); }
      });
      assert.equal(f.spawnCount, 0);
      assert.equal(f.store.read().persistence, "UNVERIFIED");
    } finally { f.dispose(); }
  });
});
