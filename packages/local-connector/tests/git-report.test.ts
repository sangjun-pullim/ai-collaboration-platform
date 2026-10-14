import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeFixture, uuid, appendFixtureCompletion } from "./runtime-fixture.ts";
import { digest, stableJson } from "../src/runtime-contracts.ts";
import { StateStore } from "../src/state-store.ts";
import type { SettingsState } from "../src/settings/store.ts";
import { collectSourceObservation } from "../src/workflow/source-snapshot.ts";
import { reportCurrentRepositoryGit, heartbeatWithGitReport } from "../src/settings/git-report.ts";
import { reportConnectionHeartbeat } from "../src/settings/connection-heartbeat.ts";

const execute = promisify(execFile);
async function fixture(t: TestContext, withHistory = false) {
  const f = await runtimeFixture();
  t.after(f.close);
  if (withHistory) {
    const historic = await collectSourceObservation(
      f.policy.root,
      f.policy.files,
      () => {},
      new AbortController().signal,
    );
    const attempt = appendFixtureCompletion(f.record);
    attempt.state = "SERVER_INTENT_CONFIRMED";
    attempt.native = null;
    attempt.terminal = null;
    attempt.receipt = null;
    f.record.context!.ownedTurns = [];
    f.record.context!.level = "L1";
    f.record.operations.pop();
    const operationId = uuid();
    const body = {
      protocol: 1,
      agentId: f.scope.agentId,
      bindingEpoch: 1,
      operationId,
      requestId: attempt.requestId,
      attemptId: attempt.snapshot!.attemptId,
      fence: 1,
    };
    f.record.operations.push({
      operationId,
      action: "start-intent",
      body,
      payloadHash: digest(stableJson({ action: "start-intent", body })),
      state: "CONFIRMED",
      result: structuredClone(attempt.snapshot),
    });
    await f.store.write(f.record);
    attempt.state = "PROVIDER_INTENT";
    attempt.sourceObservation = historic;
  }
  await f.store.write(f.record);
  const profile = new StateStore(f.stateDir, "one");
  const credential = "a".repeat(64);
  await profile.write({
    version: 1,
    server: f.scope.server,
    status: "connected",
    deviceId: f.scope.deviceId,
    credential,
    credentialExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    scope: {
      organizationId: f.scope.organizationId,
      roomId: f.scope.roomId,
      ownerAlias: "Owner",
      organizationName: "Org",
      roomTitle: "Room",
      deviceAlias: "PC",
    },
    mappings: [],
  });
  const state: SettingsState = {
    version: 1,
    server: f.scope.server,
    deviceId: f.scope.deviceId,
    organizationId: f.scope.organizationId,
    roomId: f.scope.roomId,
    current: {
      generation: f.context.generation,
      agentId: f.scope.agentId,
      workspaceId: uuid(),
      bindingEpoch: 1,
      configRevision: 1,
      provider: "codex",
      localRootReference: uuid(),
    },
    retained: [],
    journal: null,
  };
  const storedProfile = (await profile.read())!;
  storedProfile.mappings = [
    {
      formatVersion: 2,
      materialization: "MATERIALIZED",
      runtime: "codex",
      generation: f.context.generation,
      root: f.root,
      nativeSessionId: f.context.threadId,
      workspaceId: state.current!.workspaceId,
      agentId: f.scope.agentId,
      bindingEpoch: 1,
    },
  ];
  await profile.write(storedProfile);
  const abort = new AbortController();
  const requests: {
    body: Record<string, unknown>;
    signal: AbortSignal;
    authorization: string | null;
  }[] = [];
  let reads = 0;
  let onRead: (() => void) | undefined;
  const controls = { failHttp: false };
  const settings = {
    read: async () => {
      reads++;
      onRead?.();
      return structuredClone(state);
    },
    generationStore: (agentId: string, generation: string) => {
      assert.equal(agentId, state.current!.agentId);
      assert.equal(generation, f.context.generation);
      return f.store;
    },
  };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), `${f.scope.server}/api/connector/git-report`);
    requests.push({
      body: JSON.parse(String(init!.body)),
      signal: init!.signal!,
      authorization: new Headers(init!.headers).get("authorization"),
    });
    if (controls.failHttp) throw new Error("private details");
    return Response.json({ ok: true, data: { protocol: 1, reported: true } });
  };
  const report = (observe = collectSourceObservation) =>
    reportCurrentRepositoryGit(profile, settings, f.scope.server, credential, abort.signal, {
      observe,
      fetcher,
    });
  const git = (...args: string[]) =>
    execute("/usr/bin/git", ["-C", f.root, ...args], {
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
    });
  const initGit = async () => {
    await git("init", "-b", "dev");
    await git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
  };
  return {
    ...f,
    profile,
    state,
    settings,
    abort,
    credential,
    requests,
    report,
    git,
    initGit,
    controls,
    get reads() {
      return reads;
    },
    set onRead(fn: () => void) {
      onRead = fn;
    },
  };
}

test("should report fresh dev main and commit changes from only the current root without changing source history", async (t) => {
  const f = await fixture(t, true);
  await f.initGit();
  const before = await f.store.read();
  await writeFile(join(f.root, "public.txt"), "Changed but not selected for this report");
  await f.report(async (root, files, check, signal) => {
    assert.deepEqual(files, []);
    assert.deepEqual(root, f.policy.root);
    return collectSourceObservation(root, files, check, signal);
  });
  const first = f.requests[0].body;
  assert.equal(first.branch, "dev");
  assert.match(String(first.commit), /^[a-f0-9]{40}$/);
  assert.deepEqual(
    Object.keys(first).sort(),
    [
      "agentId",
      "workspaceId",
      "bindingEpoch",
      "configRevision",
      "branch",
      "commit",
      "observedAt",
    ].sort(),
  );
  assert.equal(f.requests[0].authorization, `Bearer ${f.credential}`);
  await f.git("branch", "main");
  await f.git("symbolic-ref", "HEAD", "refs/heads/main");
  await f.git(
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "second",
  );
  await f.report();
  assert.equal(f.requests[1].body.branch, "main");
  assert.notEqual(f.requests[1].body.commit, first.commit);
  assert.deepEqual(await f.store.read(), before);
});
test("should report unknown for nonGit unborn detached and failed Git without assuming a branch", async (t) => {
  const f = await fixture(t);
  await f.report();
  assert.equal(f.requests[0].body.branch, "unknown");
  assert.equal(f.requests[0].body.commit, "unknown");
  await f.git("init", "-b", "dev");
  await f.report();
  assert.equal(f.requests[1].body.commit, "unknown");
  await f.initGit();
  await writeFile(join(f.root, ".git", "HEAD"), (await f.git("rev-parse", "HEAD")).stdout);
  await f.report();
  assert.equal(f.requests[2].body.branch, "unknown");
  assert.notEqual(f.requests[2].body.commit, "unknown");
  await f.report((root, files, check, signal) =>
    collectSourceObservation(root, files, check, signal, async () => {
      throw new Error("private Git diagnostic");
    }),
  );
  assert.equal(f.requests[3].body.commit, "unknown");
});
test("should skip previous generations incomplete settings foreign scope and unproved roots", async (t) => {
  for (const mutation of [
    "missing",
    "legacy",
    "revision",
    "generation",
    "epoch",
    "workspace",
    "device",
    "room",
    "organization",
    "root",
    "preparation",
    "pending",
  ]) {
    await t.test(mutation, async (t) => {
      const f = await fixture(t);
      const p = f.state.current!;
      if (mutation === "missing") f.state.current = null;
      if (mutation === "legacy") p.legacy = true;
      if (mutation === "revision") p.configRevision = 0;
      if (mutation === "generation") p.generation = uuid();
      if (mutation === "epoch") p.bindingEpoch++;
      if (mutation === "workspace") p.workspaceId = uuid();
      if (mutation === "device") f.state.deviceId = uuid();
      if (mutation === "room") f.state.roomId = uuid();
      if (mutation === "organization") f.state.organizationId = uuid();
      if (mutation === "root") {
        await rename(f.root, `${f.root}-old`);
        await mkdir(f.root);
      }
      if (mutation === "preparation") {
        const r = await f.store.read();
        r!.context = null;
        t.mock.method(f.store, "read", async () => r);
      }
      if (mutation === "pending")
        f.state.journal = { phase: "APPLYING" } as SettingsState["journal"];
      let observations = 0;
      await f.report(async (...args) => {
        observations++;
        return collectSourceObservation(...args);
      });
      assert.equal(f.requests.length, 0);
      if (!["root", "preparation", "generation", "epoch"].includes(mutation))
        assert.equal(observations, 0);
    });
  }
});
test("should recheck epoch revision generation scope credential and unfinished operations after observation", async (t) => {
  for (const kind of [
    "epoch",
    "revision",
    "generation",
    "room",
    "credential",
    "pending",
    "cancel",
    "root",
    "workspace",
    "mappingRoot",
    "localRootReference",
  ]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t);
      await f.report(async (...args) => {
        const o = await collectSourceObservation(...args);
        if (kind === "epoch") f.state.current!.bindingEpoch++;
        if (kind === "revision") f.state.current!.configRevision++;
        if (kind === "generation") f.state.current!.generation = uuid();
        if (kind === "room") f.state.roomId = uuid();
        if (kind === "credential") {
          const p = await f.profile.read();
          p!.credential = "b".repeat(64);
          await f.profile.write(p!);
        }
        if (kind === "pending")
          f.state.journal = { phase: "COMMITTED" } as SettingsState["journal"];
        if (kind === "cancel") f.abort.abort();
        if (kind === "root") {
          await rename(f.root, `${f.root}-old`);
          await mkdir(f.root);
        }
        if (kind === "workspace") f.state.current!.workspaceId = uuid();
        if (kind === "localRootReference") f.state.current!.localRootReference = uuid();
        if (kind === "mappingRoot") {
          const p = await f.profile.read();
          p!.mappings[0].root = join(f.directory, "other-root");
          await f.profile.write(p!);
        }
        return o;
      });
      assert.equal(f.requests.length, 0);
    });
  }
});
test("should keep heartbeat first and successful across slow failed Git and failed report sends", async (t) => {
  const f = await fixture(t);
  const order: string[] = [];
  f.controls.failHttp = true;
  const result = await heartbeatWithGitReport(
    async () => {
      order.push("heartbeat");
      return { ready: true };
    },
    () =>
      f.report(async (...args) => {
        order.push("git");
        return collectSourceObservation(...args);
      }),
    f.abort.signal,
  );
  assert.deepEqual(result, { ready: true });
  assert.deepEqual(order, ["heartbeat", "git"]);
  await assert.rejects(
    heartbeatWithGitReport(
      async () => {
        throw new Error("auth failure");
      },
      async () => {
        throw new Error("must not report");
      },
      f.abort.signal,
    ),
    /auth failure/,
  );
  const isolated = await heartbeatWithGitReport(
    async () => 42,
    async () => {
      throw new Error("failed Git");
    },
    f.abort.signal,
  );
  assert.equal(isolated, 42);
});
test("should abort in flight HTTP and never send after cancelled observation", async (t) => {
  const f = await fixture(t);
  let sent = false;
  await reportCurrentRepositoryGit(
    f.profile,
    f.settings,
    f.scope.server,
    f.credential,
    f.abort.signal,
    {
      fetcher: async (_url, init) => {
        sent = true;
        f.abort.abort();
        assert.equal(init!.signal!.aborted, true);
        throw new Error("aborted");
      },
    },
  );
  assert.equal(sent, true);
  await f.report();
  assert.equal(f.requests.length, 0);
});
test("should retain the existing serial cadence while Git observation is slow", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const abort = new AbortController();
  let release!: () => void;
  let heartbeats = 0;
  const job = reportConnectionHeartbeat(
    () =>
      heartbeatWithGitReport(
        async () => {
          heartbeats++;
        },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        abort.signal,
      ),
    abort.signal,
  );
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(90000);
  assert.equal(heartbeats, 1);
  abort.abort();
  release();
  await job;
  assert.equal(heartbeats, 1);
});
