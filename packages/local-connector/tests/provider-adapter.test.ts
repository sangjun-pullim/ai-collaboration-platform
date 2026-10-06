import test from "node:test";
import assert from "node:assert/strict";
import fs, { fsyncSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";
import { dirname, join } from "node:path";
import { createProviderAdapter } from "../src/provider-adapter.ts";
import { ClaudeAdapter } from "../src/claude/adapter.ts";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { ClaudeCatalogStore } from "../src/claude/catalog-store.ts";
import { type Launch } from "../src/claude/transport.ts";
import { type RuntimeAdapter } from "../src/runtime-contracts.ts";
import { policyFixture } from "./claude-policy-fixture.ts";
import {
  FakeTransport,
  claudeHarness,
  deferred,
  streamingAbort,
  interruptionProof,
} from "./claude-runtime-fixture.ts";
import { FakeProvider } from "./fake-provider.ts";
import { uuid } from "./runtime-fixture.ts";

test("should preserve Codex construction through its existing transport factory", async () => {
  const f = await policyFixture(),
    provider = new FakeProvider();
  let calls = 0;
  const adapter = createProviderAdapter("codex", {
    profile: f.profile,
    codex: {
      transportFactory(root, overrides, check) {
        check();
        assert.equal(root, f.root);
        calls++;
        return provider.launch(overrides);
      },
    },
  });
  try {
    assert.ok(adapter instanceof CodexAdapter);
    assert.equal((await adapter.capabilities(f.root, () => {})).policy, "CONFIRMED");
    assert.equal(calls, 2);
  } finally {
    await adapter.close();
    await f.close();
  }
});
test("should retain default policy rejection with zero catalog child personal IO and user inputs", async (t) => {
  const f = await policyFixture();
  let catalog = 0,
    children = 0,
    sourceIO = 0;
  const environment = new Proxy(
    {},
    {
      get() {
        assert.fail("must not read inherited settings");
      },
      ownKeys() {
        assert.fail("must not read inherited environment");
      },
    },
  );
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    reserveCatalog: async () => {
      catalog++;
      return f.context;
    },
    claude: {
      environment,
      transport() {
        children++;
        return new FakeTransport();
      },
    },
  });
  try {
    for (const method of ["lstatSync", "openSync", "readSync", "realpathSync"] as const)
      t.mock.method(fs, method, () => {
        sourceIO++;
        assert.fail("must not access policy/catalog/history storage");
      });
    syncBuiltinESMExports();
    await assert.rejects(
      adapter.capabilities(f.root, () => {}),
      { code: "POLICY_UNCONFIRMED" },
    );
    await assert.rejects(
      adapter.prepare(f.context.root, f.settings, uuid(), 1, () => {}),
      { code: "POLICY_UNCONFIRMED" },
    );
    await assert.rejects(
      adapter.validate(f.context, f.settings, () => {}),
      { code: "POLICY_UNCONFIRMED" },
    );
    await assert.rejects(
      adapter.observe(
        f.context,
        f.settings,
        { threadId: f.context.threadId, turnId: uuid() },
        () => {},
      ),
      { code: "POLICY_UNCONFIRMED" },
    );
    assert.deepEqual({ catalog, children, sourceIO }, { catalog: 0, children: 0, sourceIO: 0 });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await adapter.close();
    await f.close();
  }
});
test("should supply policy and exact history while preserving setup catalog reservation", async () => {
  const f = await policyFixture();
  const launches: Launch[] = [],
    native = new FakeTransport();
  let reserved = 0;
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    reserveCatalog: async (root, version, fingerprint) => {
      reserved++;
      assert.equal(root, f.root);
      assert.equal(version, "2.1.287");
      f.context.materialization!.policyFingerprint = fingerprint;
      return f.context;
    },
    claude: {
      evidence: f.evidence,
      environment: {},
      transport(launch) {
        launches.push(launch);
        return native;
      },
    },
  });
  try {
    assert.ok(adapter instanceof ClaudeAdapter);
    const capability = await adapter.capabilities(f.root, () => {});
    assert.equal(capability.runtime, "claude");
    assert.equal(reserved, 1);
    assert.equal(native.writes.length, 0);
    assert.equal(
      launches[0].args[launches[0].args.indexOf("--session-id") + 1],
      f.context.threadId,
    );
    assert.ok(!JSON.stringify(capability).includes(f.config));
    await adapter.validate(f.context, f.settings, () => {});
  } finally {
    await adapter.close();
    await f.close();
  }
});
test("should sync the standalone reservation before its zero-input catalog child and close only after reap", async () => {
  const f = await policyFixture(),
    events: string[] = [],
    native = new FakeTransport();
  const catalog = new ClaudeCatalogStore(f.profile);
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    catalogSync: {
      file(fd) {
        fsyncSync(fd);
        events.push("file");
      },
      directory(fd) {
        fsyncSync(fd);
        events.push("directory");
      },
    },
    claude: {
      evidence: f.evidence,
      environment: {},
      transport(launch) {
        events.push("child");
        const ledger = JSON.parse(fs.readFileSync(catalog.file, "utf8"));
        assert.equal(ledger.status, "RESERVED");
        assert.equal(ledger.context.threadId, launch.args[launch.args.indexOf("--session-id") + 1]);
        assert.deepEqual(events.slice(0, 6), [
          "directory",
          "file",
          "directory",
          "file",
          "directory",
          "child",
        ]);
        assert.throws(() => new ClaudeCatalogStore(f.profile).assertStartup(), {
          code: "CLEANUP_INCOMPLETE",
        });
        return native;
      },
    },
  });
  try {
    await adapter.capabilities(f.root, () => {});
    assert.equal(JSON.parse(await readFile(catalog.file, "utf8")).status, "CLOSED");
    assert.equal(native.writes.length, 0);
    catalog.assertStartup();
  } finally {
    await adapter.close();
    await f.close();
  }
});
test("should send nothing after standalone file or directory sync failure", async () => {
  for (const failure of ["file", "directory"] as const) {
    const f = await policyFixture();
    let children = 0,
      directories = 0;
    const adapter = createProviderAdapter("claude", {
      profile: f.profile,
      catalogSync: {
        file(fd) {
          if (failure === "file") throw new Error("synthetic sync failure");
          fsyncSync(fd);
        },
        directory(fd) {
          directories++;
          if (failure === "directory" && directories === 2)
            throw new Error("synthetic sync failure");
          fsyncSync(fd);
        },
      },
      claude: {
        evidence: f.evidence,
        environment: {},
        transport() {
          children++;
          return new FakeTransport();
        },
      },
    });
    try {
      await assert.rejects(
        adapter.capabilities(f.root, () => {}),
        /synthetic sync failure/,
      );
      assert.equal(children, 0);
    } finally {
      await adapter.close();
      await f.close();
    }
  }
});
test("should persist UNKNOWN and retain the device lock when owned transport close throws", async () => {
  const f = await policyFixture(),
    native = new FakeTransport();
  native.close = async () => {
    throw new Error("synthetic unconfirmed close");
  };
  const adapter = createProviderAdapter("claude", {
    profile: f.profile,
    claude: { evidence: f.evidence, environment: {}, transport: () => native },
  });
  try {
    await assert.rejects(
      withSettingsDeviceLock(f.profile, "runtime-capabilities", async () =>
        adapter.capabilities(f.root, () => {}),
      ),
      { code: "CLEANUP_INCOMPLETE" },
    );
    const catalog = new ClaudeCatalogStore(f.profile);
    assert.equal(JSON.parse(await readFile(catalog.file, "utf8")).status, "UNKNOWN");
    assert.throws(() => catalog.assertStartup(), { code: "CLEANUP_INCOMPLETE" });
    assert.ok(
      await lstat(join(f.profile.dir, "settings", f.profile.profile, "device.lock")).catch(
        () => undefined,
      ),
    );
    assert.equal(native.writes.length, 0);
  } finally {
    await adapter.close().catch(() => {});
    await f.close();
  }
});
test("should block setup current legacy root fingerprint and Codex transitions after UNKNOWN cleanup", async () => {
  const f = await policyFixture(),
    native = new FakeTransport();
  native.cleanupFailed = true;
  const initial = createProviderAdapter("claude", {
    profile: f.profile,
    claude: { evidence: f.evidence, environment: {}, transport: () => native },
  });
  const catalog = new ClaudeCatalogStore(f.profile);
  const adapters: RuntimeAdapter[] = [];
  let children = 0,
    reservations = 0;
  try {
    await assert.rejects(
      initial.capabilities(f.root, () => {}),
      { code: "CLEANUP_INCOMPLETE" },
    );
    const before = await readFile(catalog.file);
    const setup = createProviderAdapter("claude", {
      profile: f.profile,
      reserveCatalog: async () => {
        reservations++;
        return f.context;
      },
      claude: {
        evidence: f.evidence,
        environment: {},
        transport() {
          children++;
          return new FakeTransport();
        },
      },
    });
    adapters.push(setup);
    await assert.rejects(
      setup.capabilities(f.root, () => {}),
      { code: "CLEANUP_INCOMPLETE" },
    );
    const current = createProviderAdapter("claude", {
      profile: f.profile,
      claude: {
        evidence: f.evidence,
        environment: {},
        transport() {
          children++;
          return new FakeTransport();
        },
      },
    });
    adapters.push(current);
    await assert.rejects(
      current.prepare(f.context.root, f.settings, uuid(), 1, () => {}),
      { code: "CLEANUP_INCOMPLETE" },
    );
    await assert.rejects(
      current.validate(
        {
          ...f.context,
          materialization: { ...f.context.materialization!, policyFingerprint: "b".repeat(64) },
        },
        f.settings,
        () => {},
      ),
      { code: "CONTEXT_UNCONFIRMED" },
    );
    const otherRoot = join(f.directory, "other-root");
    await mkdir(otherRoot, { mode: 0o700 });
    const changed = await policyFixture();
    try {
      const changedPolicy = createProviderAdapter("claude", {
        profile: f.profile,
        claude: {
          evidence: changed.evidence,
          environment: {},
          transport() {
            children++;
            return new FakeTransport();
          },
        },
      });
      adapters.push(changedPolicy);
      await assert.rejects(
        changedPolicy.capabilities(changed.root, () => {}),
        { code: "CLEANUP_INCOMPLETE" },
      );
    } finally {
      await changed.close();
    }
    for (const operation of ["catalog", "prepare", "observe"] as const) {
      const codex = createProviderAdapter("codex", {
        profile: f.profile,
        codex: {
          transportFactory() {
            children++;
            return new FakeProvider();
          },
        },
      });
      adapters.push(codex);
      if (operation === "catalog")
        await assert.rejects(
          codex.capabilities(otherRoot, () => {}),
          { code: "CLEANUP_INCOMPLETE" },
        );
      if (operation === "prepare")
        await assert.rejects(
          codex.prepare(f.context.root, f.record.settings!, uuid(), 1, () => {}),
          { code: "CLEANUP_INCOMPLETE" },
        );
      if (operation === "observe")
        await assert.rejects(
          codex.observe(
            { ...f.context, provider: "codex" },
            f.record.settings!,
            { threadId: f.context.threadId, turnId: uuid() },
            () => {},
          ),
          { code: "CLEANUP_INCOMPLETE" },
        );
    }
    assert.equal(children, 0);
    assert.equal(reservations, 0);
    assert.deepEqual(await readFile(catalog.file), before);
  } finally {
    await initial.close().catch(() => {});
    for (const adapter of adapters) await adapter.close().catch(() => {});
    await f.close();
  }
});
test("should recover the same tool-free interrupted input through the composed real adapter without another input", async () => {
  const f = await policyFixture();
  await f.admit();
  const h = claudeHarness(f.runtime, f.record),
    entered = deferred<void>();
  const path = f.policy.transcriptPath(f.context);
  const persist = async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, h.history.records.map((frame) => JSON.stringify(frame) + "\n").join(""), {
      mode: 0o600,
    });
  };
  const emit = async (frame: Record<string, unknown>) => {
    await h.emit(frame);
    await persist();
  };
  h.native.onInput = async (input) => {
    await emit(input);
    await emit(h.init());
    await h.ack.promise;
    await emit(h.assistant(input));
    entered.resolve();
  };
  h.native.onInterrupt = async () => ({ still_queued: [], cancelled: [h.intent!.inputId] });
  const options = {
    profile: f.profile,
    claude: { evidence: f.evidence, environment: {}, transport: () => h.native },
  };
  const adapter = createProviderAdapter("claude", options);
  let recovery: RuntimeAdapter | undefined;
  const execution = adapter.execute(
    h.authority,
    h.settings,
    h.authority.attempt.payload,
    async (intent) => {
      assert.ok(intent);
      h.captureIntent(intent);
    },
  );
  void execution.catch(() => {});
  try {
    await entered.promise;
    assert.equal(await adapter.interrupt(h.authority), true);
    await emit(h.result(h.native.writes[0], streamingAbort));
    const terminal = await execution;
    assert.equal(terminal.terminal, "INTERRUPTED");
    const proof = interruptionProof(h.intent!, {
      still_queued: [],
      cancelled: [h.intent!.inputId],
    });
    assert.deepEqual(terminal.nativeInterruption, proof);
    const catalog = new ClaudeCatalogStore(f.profile);
    const lease = catalog.reserve(f.context.root, f.policy.version, f.policy.fingerprint);
    catalog.finish(lease, { reaped: false, code: "CLEANUP_INCOMPLETE" });
    recovery = createProviderAdapter("claude", options);
    const observed = await recovery.observe(
      f.context,
      f.settings,
      {
        threadId: f.context.threadId,
        turnId: h.intent!.inputId,
        intent: h.intent,
        toolCalls: [],
        nativeInterruption: proof,
      },
      () => {},
    );
    assert.equal(observed!.terminal, "INTERRUPTED");
    assert.deepEqual(observed!.nativeInterruption, proof);
    await assert.rejects(
      recovery.prepare(
        f.context.root,
        f.settings,
        uuid(),
        1,
        () => {},
        async () => assert.fail("must not reserve a new UUID"),
      ),
      { code: "CLEANUP_INCOMPLETE" },
    );
    await assert.rejects(
      recovery.capabilities(f.root, () => {}),
      { code: "CLEANUP_INCOMPLETE" },
    );
    f.context.materialization = {
      ...f.context.materialization!,
      state: "MATERIALIZED",
      initHash: terminal.nativeInitHash!,
    };
    f.context.ownedTurns.push({
      turnId: h.intent!.inputId,
      terminal: "INTERRUPTED",
      promptHash: h.intent!.promptHash,
      resultHash: terminal.finalItems[0].hash,
      toolReceipts: [],
      nativeInterruption: proof,
    });
    await assert.rejects(
      recovery.execute(h.authority, h.settings, h.authority.attempt.payload, async () => {}),
      { code: "CLEANUP_INCOMPLETE" },
    );
    assert.equal(h.native.writes.length, 1);
    assert.equal(h.native.controls.length, 1);
  } finally {
    await recovery?.close();
    await adapter.close();
    await h.close();
    await f.close();
  }
});
