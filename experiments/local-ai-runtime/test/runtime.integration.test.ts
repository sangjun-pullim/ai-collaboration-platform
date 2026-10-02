import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { CodexRuntime, type RuntimeClientFactory } from "../src/codex-runtime.js";
import {
  ExperimentPolicyError,
  ExperimentStore,
  type ExperimentManifest,
  type ManifestRepository,
} from "../src/experiment-policy.js";
import { runCli } from "../src/cli.js";
import { RuntimeTransportError, StdioClient } from "../src/stdio-client.js";

const fixturePath = fileURLToPath(new URL("./fixtures/fake-app-server.js", import.meta.url));
const runtimeModuleUrl = pathToFileURL(fileURLToPath(new URL("../src/codex-runtime.js", import.meta.url))).href;
const policyModuleUrl = pathToFileURL(fileURLToPath(new URL("../src/experiment-policy.js", import.meta.url))).href;
const clientModuleUrl = pathToFileURL(fileURLToPath(new URL("../src/stdio-client.js", import.meta.url))).href;
const reviewDriverPath = fileURLToPath(new URL("./fixtures/review-driver.js", import.meta.url));

test("should serialize manifest holders across creation and crash recovery", async (t) => {
  await t.test("should reject even an empty legacy PID lock", async (t) => {
    const directory = await temporaryDirectory(t);
    const store = await createStore(directory, "legacy");
    await writeFile(join(store.root, ".local-ai-runtime", "manifest.lock"), "", { mode: 0o600 });
    await assert.rejects(store.withLock(async () => undefined), { code: "MANIFEST_LOCKED" });
  });
  await t.test("should serialize simultaneous entrants and release a killed holder", async (t) => {
    const directory = await temporaryDirectory(t);
    const store = await createStore(directory, "holders");
    const first = reviewDriver(t, "lock", store, { MARK_ACTIVE: "true" });
    const second = reviewDriver(t, "lock", store, { MARK_ACTIVE: "true" });
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.child.send("acquire");
    second.child.send("acquire");
    const outcomes = await Promise.all([first.outcome(), second.outcome()]);
    assert.equal(outcomes.filter((value) => "entered" in value).length, 1);
    assert.equal(outcomes.filter((value) => value.error === "MANIFEST_LOCKED").length, 1);
    const holder = "entered" in outcomes[0]! ? first : second;
    holder.child.kill("SIGKILL");
    await waitForExit(holder.child);
    const third = reviewDriver(t, "lock", store);
    const fourth = reviewDriver(t, "lock", store);
    await Promise.all([third.wait("ready"), fourth.wait("ready")]);
    third.child.send("acquire");
    fourth.child.send("acquire");
    const recovered = await Promise.all([third.outcome(), fourth.outcome()]);
    assert.equal(recovered.filter((value) => "entered" in value).length, 1);
    assert.equal(recovered.filter((value) => value.error === "MANIFEST_LOCKED").length, 1);
    assert.equal(recovered.find((value) => "entered" in value)?.entered, "UNKNOWN");
    const recoveredHolder = "entered" in recovered[0]! ? third : fourth;
    recoveredHolder.child.send("release");
    await recoveredHolder.wait("released");
  });
  await t.test("should preserve a holder after a same-process contender is rejected", async (t) => {
    const directory = await temporaryDirectory(t);
    const store = await createStore(directory, "same-process-holder");
    const localContender = await ExperimentStore.openOwned(store.manifestPath);
    const externalContender = reviewDriver(t, "lock", store);
    await externalContender.wait("ready");
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const admission = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = store.withLock(async () => { entered(); await gate; });
    await admission;
    try {
      await assert.rejects(localContender.withLock(async () => undefined), { code: "MANIFEST_LOCKED" });
      externalContender.child.send("acquire");
      assert.deepEqual(await externalContender.outcome(), { error: "MANIFEST_LOCKED" });
    } finally {
      release();
      await holder;
    }
    const successor = reviewDriver(t, "lock", store);
    await successor.wait("ready");
    successor.child.send("acquire");
    assert.ok("entered" in await successor.outcome());
    successor.child.send("release");
    await successor.wait("released");
  });
  await t.test("should protect the database creation window without deleting a contender's lock", async (t) => {
    const directory = await temporaryDirectory(t);
    const store = await createStore(directory, "creation");
    const marker = join(directory, "creation-gate");
    const creator = reviewDriver(t, "lock", store, { PAUSE_CREATION: "true", CREATION_MARKER: marker });
    await creator.wait("ready");
    creator.child.send("acquire");
    await waitUntil(async () => (await readFile(marker, "utf8").catch(() => "")) === "created");
    const contender = reviewDriver(t, "lock", store);
    await contender.wait("ready");
    contender.child.send("acquire");
    assert.ok("entered" in await contender.outcome());
    creator.child.kill("SIGCONT");
    assert.deepEqual(await creator.outcome(), { error: "MANIFEST_LOCKED" });
    contender.child.send("release");
    await contender.wait("released");
    await store.withLock(async () => undefined);
    const database = await import("node:fs/promises").then(({ stat }) => stat(join(store.root, ".local-ai-runtime", "manifest-lock.sqlite")));
    assert.equal(database.mode & 0o777, 0o600);
  });
  await t.test("should reject symlinked or public lock storage", async (t) => {
    const directory = await temporaryDirectory(t);
    const symlinkStore = await createStore(directory, "symlink-lock");
    await symlink(join(symlinkStore.root, "public-context.txt"), join(symlinkStore.root, ".local-ai-runtime", "manifest-lock.sqlite"));
    await assert.rejects(symlinkStore.withLock(async () => undefined), { code: "MANIFEST_NOT_OWNED" });
    const publicStore = await createStore(directory, "public-lock");
    const databasePath = join(publicStore.root, ".local-ai-runtime", "manifest-lock.sqlite");
    await writeFile(databasePath, "", { mode: 0o644 });
    await chmod(databasePath, 0o644);
    await assert.rejects(publicStore.withLock(async () => undefined), { code: "MANIFEST_NOT_OWNED" });
    await chmod(publicStore.root, 0o755);
    await assert.rejects(publicStore.withLock(async () => undefined), { code: "MANIFEST_NOT_OWNED" });
  });
});

test("should preserve a terminal received before an interrupt acknowledgement failure", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const scenario of ["terminalBeforeAckCompletedError", "terminalBeforeAckInterruptedError", "terminalBeforeAckCompletedWithheld", "terminalBeforeAckInterruptedWithheld", "ackErrorBeforeTerminal"]) {
    const store = await createStore(directory, scenario);
    const tracePath = join(directory, `${scenario}.jsonl`);
    const result = await new CodexRuntime(fakeFactory(scenario, tracePath, { requestTimeoutMs: 150 })).runNew(store, {
      ...executionOptions(scenario), interruptAfterMs: 0, terminalWaitMs: 35,
    });
    assert.equal(result.state, scenario.includes("Interrupted") ? "INTERRUPTED" : "COMPLETED");
    assert.equal((await readManifest(store.manifestPath)).state, result.state);
    assert.equal(receivedMethods(await readTrace(tracePath)).filter((method) => method === "turn/interrupt").length, 1);
  }
});

test("should bound terminal waiting from the interrupt request", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "delayedAck");
  const trace = join(directory, "delayed-ack.jsonl");
  const requested = deferred<void>();
  let unknownSaved = false;
  let ackAtUnknown = false;
  const terminalWaitMs = 30;
  const runtime = new CodexRuntime((cwd) => {
    const client = fakeFactory("delayedAckNoTerminal", trace, { requestTimeoutMs: 500, closeTimeoutMs: 20 })(cwd);
    const request = client.request.bind(client);
    client.request = (method, params, timeout) => {
      if (method === "turn/interrupt") {
        // Start the controlled clock at the actual outgoing RPC, after all preparation.
        t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
        requested.resolve();
      }
      return request(method, params, timeout);
    };
    const close = client.close.bind(client);
    client.close = async () => { t.mock.timers.reset(); await close(); };
    return client;
  });
  t.after(async () => { t.mock.timers.reset(); await runtime.shutdown(); });
  const repository: ManifestRepository = {
    manifestPath: store.manifestPath,
    withLock: store.withLock.bind(store),
    save: async (manifest) => {
      await store.save(manifest);
      if (manifest.state === "UNKNOWN") {
        ackAtUnknown = (await readTrace(trace)).some((entry) => entry.type === "interrupt-ack");
        unknownSaved = true;
      }
    },
  };
  const completed = runtime.runNew(repository, {
    ...executionOptions("synthetic"), interruptAfterMs: 0, terminalWaitMs: 30,
  });
  void completed.catch(() => undefined);
  await requested.promise;
  await waitForIo(async () => receivedMethods(await readTrace(trace)).includes("turn/interrupt"));
  assert.equal(unknownSaved, false);
  t.mock.timers.tick(terminalWaitMs);
  await waitForIo(() => unknownSaved);
  assert.equal(ackAtUnknown, false, "the terminal deadline must expire before delayed ACK delivery");
  const result = await completed;
  assert.equal(result.state, "UNKNOWN");
  assert.equal(receivedMethods(await readTrace(trace)).filter((method) => method === "turn/interrupt").length, 1);
});

test("should block runtime admission after shutdown during preparation", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const mode of ["prep-create", "prep-create-never", "prep-lock", "prep-lock-never", "prep-resume-lock-never", "prep-intent"]) {
    const store = await createStore(directory, mode);
    if (mode.includes("resume")) {
      await new CodexRuntime(fakeFactory("normal", join(directory, "resume-preparation.jsonl"))).runNew(store, executionOptions("synthetic"));
    }
    const driver = reviewDriver(t, mode, store);
    await driver.wait("preparing");
    driver.child.kill("SIGINT");
    await driver.wait("shutdown-returned");
    assert.equal(await waitForExitWithin(driver.child, 800), true);
    const methods = receivedMethods(await readTrace(driver.tracePath));
    assert.equal(methods.includes("turn/start"), false, mode);
    if (mode !== "prep-intent") {
      assert.equal((await readTrace(driver.tracePath)).some((entry) => entry.type === "startup"), false, mode);
    }
  }
  let launches = 0;
  const runtime = new CodexRuntime(() => { launches += 1; throw new Error("launched"); });
  await runtime.shutdown();
  const store = await createStore(directory, "after-shutdown");
  for (const operation of [() => runtime.probe(directory), () => runtime.runNew(store, executionOptions("x")), () => runtime.resume(store, executionOptions("x"))]) {
    await assert.rejects(operation(), { code: "RUNTIME_SHUTDOWN" });
  }
  assert.equal(launches, 0);
});

test("should terminate promptly after SIGINT while awaiting a terminal", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "sigint");
  const driver = reviewDriver(t, "sigint-wait", store);
  await driver.wait("signal-ready");
  await waitUntil(async () => (await readManifest(store.manifestPath)).state === "RUNNING");
  driver.child.kill("SIGINT");
  assert.equal(await waitForExitWithin(driver.child, 800), true, "SIGINT must wake the 120 second wait");
  assert.equal((await readManifest(store.manifestPath)).state, "UNKNOWN");
  const ownedPid = Number((await readTrace(driver.tracePath)).find((entry) => entry.type === "startup")?.pid);
  await waitUntil(() => !isAlive(ownedPid));
});

test("should await durable unknown and child cleanup after shutdown of a started turn", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "durable-shutdown");
  const driver = reviewDriver(t, "sigint-save-gate", store);
  await driver.wait("signal-ready");
  await waitUntil(async () => (await readManifest(store.manifestPath)).state === "RUNNING");
  driver.child.kill("SIGINT");
  await driver.wait("saving-unknown");
  assert.equal(driver.child.exitCode, null);
  assert.equal(driver.stdout(), "", "public output must wait for the durable UNKNOWN save");
  assert.equal((await readManifest(store.manifestPath)).state, "RUNNING");
  driver.child.send("persist");
  assert.equal(await waitForExitWithin(driver.child, 800), true);
  assert.equal(driver.child.exitCode, 130);
  assert.equal((await readManifest(store.manifestPath)).state, "UNKNOWN");
  const ownedPid = Number((await readTrace(driver.tracePath)).find((entry) => entry.type === "startup")?.pid);
  assert.equal(isAlive(ownedPid), false);
});

test("should handle a closed child stdin without an uncaught exception", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "closed-input");
  const driver = reviewDriver(t, "closedStdin", store);
  assert.equal(await waitForExitWithin(driver.child, 1_500), true);
  assert.equal(driver.child.exitCode, 0, driver.stderr());
  assert.equal((await readManifest(store.manifestPath)).state, "UNKNOWN");
});

test("should preserve a confirmed terminal during shutdown persistence", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "shutdown-terminal");
  const driver = reviewDriver(t, "sigint-save-gate", store, {
    TERMINAL_ON_CLOSE: "true", TERMINAL_GATE: join(store.root, ".local-ai-runtime", "terminal-gate"),
  });
  await driver.wait("signal-ready");
  await waitUntil(async () => (await readManifest(store.manifestPath)).state === "RUNNING");
  driver.child.kill("SIGINT");
  await driver.wait("saving-unknown");
  const ownedPid = Number((await readTrace(driver.tracePath)).find((entry) => entry.type === "startup")?.pid);
  await waitUntil(() => !isAlive(ownedPid));
  driver.child.send("persist");
  assert.equal(await waitForExitWithin(driver.child, 800), true);
  assert.equal((await readManifest(store.manifestPath)).state, "COMPLETED");
});

test("should collect write failures while rejecting unknown server requests", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "unknown-closed-input");
  const driver = reviewDriver(t, "unknownRequestClosedStdin", store);
  assert.equal(await waitForExitWithin(driver.child, 1_500), true);
  assert.equal(driver.child.exitCode, 0, driver.stderr());
  assert.equal((await readManifest(store.manifestPath)).state, "UNKNOWN");
});

test("should locate an owned experiment by ID without exposing its path", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(tmpdir(), "locatable");
  t.after(async () => await rm(store.root, { recursive: true, force: true }));
  assert.ok(store.root.includes(`local-ai-runtime-${store.experimentId}-`));
  await new CodexRuntime(fakeFactory("normal", join(directory, "locatable-initial.jsonl"))).runNew(store, executionOptions("synthetic"));
  const args = ["resume", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api", "--experiment-id", store.experimentId];
  const output = await runCli(args, { runtime: new CodexRuntime(fakeFactory("normal", join(directory, "locatable-resume.jsonl"))) });
  assert.equal(output.experimentId, store.experimentId);
  assert.equal(output.result?.state, "COMPLETED");
  assert.equal(JSON.stringify(output).includes(store.root), false);
  const invalid = await runCli(args.slice(0, -1).concat("not-a-uuid"));
  assert.equal(invalid.error, "INVALID_EXPERIMENT_ID");
  const duplicate = await mkdtemp(join(tmpdir(), `local-ai-runtime-${store.experimentId}-`));
  t.after(async () => await rm(duplicate, { recursive: true, force: true }));
  await cp(store.root, duplicate, { recursive: true });
  const ambiguous = await runCli(args);
  assert.equal(ambiguous.error, "EXPERIMENT_ID_AMBIGUOUS");
  const unownedId = randomUUID();
  const unowned = await mkdtemp(join(tmpdir(), `local-ai-runtime-${unownedId}-`));
  t.after(async () => await rm(unowned, { recursive: true, force: true }));
  const unownedOutput = await runCli(args.slice(0, -1).concat(unownedId));
  assert.equal(unownedOutput.error, "MANIFEST_NOT_OWNED");
  const symlinkId = randomUUID();
  const symlinkRoot = join(tmpdir(), `local-ai-runtime-${symlinkId}-link`);
  await symlink(store.root, symlinkRoot);
  t.after(async () => await rm(symlinkRoot, { force: true }));
  const symlinkOutput = await runCli(args.slice(0, -1).concat(symlinkId));
  assert.equal(symlinkOutput.error, "MANIFEST_NOT_OWNED");
  const conflicting = await runCli(args.concat("--resume-manifest", store.manifestPath));
  assert.equal(conflicting.error, "AMBIGUOUS_RESUME_INPUT");
});

test("should retain the experiment ID after a runtime failure", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = await createStore(directory, "failure-id");
  const output = await runCli(["run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api"], {
    createStore: async () => store,
    runtime: new CodexRuntime(fakeFactory("lostStartResponse", join(directory, "failed-runtime.jsonl"))),
  });
  assert.equal(output.ok, false);
  assert.equal(output.experimentId, store.experimentId);
  assert.equal(output.storage, "system-temporary-directory");
  assert.ok(output.cleanup?.includes("state verification"));
  assert.equal(JSON.stringify(output).includes(store.root), false);
});

test("should initialize before sending thread requests", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "trace.jsonl");
  const runtime = new CodexRuntime(fakeFactory("normal", tracePath));

  const result = await runtime.probe(directory);

  assert.equal(result.connectionLevel, "initialized");
  const methods = receivedMethods(await readTrace(tracePath));
  assert.deepEqual(methods, ["initialize", "initialized"]);
  assert.equal(methods.some((method) => method.startsWith("thread/") || method.startsWith("turn/")), false);
});

test("should correlate fragmented and out-of-order responses", async (t) => {
  const directory = await temporaryDirectory(t);
  const client = StdioClient.launchForTest({
    executable: process.execPath,
    args: [fixturePath, "fragmented"],
    cwd: directory,
    env: process.env,
  });
  t.after(async () => await client.close());
  const events: string[] = [];
  client.onEvent((event) => events.push(event.kind));
  await client.initialize();

  const alpha = client.request("alpha", {});
  const beta = client.request("beta", {});
  assert.deepEqual(await alpha, { method: "alpha" });
  assert.deepEqual(await beta, { method: "beta" });
  await waitUntil(() => events.includes("item/completed"));
  assert.deepEqual(events, ["item/completed"]);
});

test("should clear the overall deadline timer after an early terminal event", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "timer-driver.jsonl");
  const driverSource = `
    import { createHash } from "node:crypto";
    import { CodexRuntime } from ${JSON.stringify(runtimeModuleUrl)};
    import { ExperimentStore } from ${JSON.stringify(policyModuleUrl)};
    import { StdioClient } from ${JSON.stringify(clientModuleUrl)};
    const store = await ExperimentStore.create(createHash("sha256").update("timer-marker").digest("hex"), process.env.TEST_PARENT);
    const runtime = new CodexRuntime((cwd) => StdioClient.launchForTest({
      executable: process.execPath,
      args: [process.env.TEST_FIXTURE, "normal"],
      cwd,
      env: process.env
    }));
    await runtime.runNew(store, { model: "synthetic-model", prompt: "timer marker" });
  `;
  const driver = spawn(process.execPath, ["--input-type=module", "--eval", driverSource], {
    cwd: directory,
    env: {
      ...process.env,
      TEST_PARENT: directory,
      TEST_FIXTURE: fixturePath,
      FAKE_TRACE_PATH: tracePath,
    },
    stdio: "ignore",
  });
  t.after(() => stopProcess(driver));
  const exited = await waitForExitWithin(driver, 1_000);
  assert.equal(exited, true, "a cleared 120 second deadline must not keep the process alive");
});

test("should reject requests after timeout or process exit", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const [method, expected] of [
    ["timeout", "REQUEST_TIMEOUT"],
    ["exit", "RUNTIME_EOF"],
    ["malformed", "RUNTIME_MALFORMED_JSON"],
    ["oversized", "RUNTIME_LINE_TOO_LARGE"],
  ] as const) {
    const client = StdioClient.launchForTest({
      executable: process.execPath,
      args: [fixturePath, "normal"],
      cwd: directory,
      env: process.env,
      requestTimeoutMs: 500,
      closeTimeoutMs: 50,
    });
    await client.initialize();
    await assert.rejects(
      client.request(method, {}, 25),
      (error: unknown) => error instanceof RuntimeTransportError && error.code === expected,
    );
    await assert.rejects(client.request("alpha", {}), RuntimeTransportError);
    await client.close();
  }
});

test("should pass the canonical workspace without invoking a shell", async (t) => {
  const parent = await temporaryDirectory(t);
  const workspace = join(parent, "workspace ; touch SHOULD_NOT_EXIST");
  await import("node:fs/promises").then(async ({ mkdir }) => await mkdir(workspace));
  const tracePath = join(parent, "trace.jsonl");
  const client = StdioClient.launchForTest({
    executable: process.execPath,
    args: [fixturePath, "normal"],
    cwd: workspace,
    env: { ...process.env, FAKE_TRACE_PATH: tracePath },
  });
  await client.initialize();
  await client.close();

  const startup = (await readTrace(tracePath)).find((entry) => entry.type === "startup");
  assert.equal(startup?.cwd, await realpath(workspace));
  await assert.rejects(readFile(join(parent, "SHOULD_NOT_EXIST")), { code: "ENOENT" });
});

test("should enforce read-only policy and decline approval requests", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "approvals.jsonl");
  const store = await createStore(directory, "approval-marker");
  const runtime = new CodexRuntime(fakeFactory("approvals", tracePath));
  const result = await runtime.runNew(store, executionOptions("approval-marker"));

  assert.equal(result.state, "COMPLETED");
  const trace = await readTrace(tracePath);
  const threadStart = requestByMethod(trace, "thread/start");
  const turnStart = requestByMethod(trace, "turn/start");
  assert.deepEqual(threadStart.params, {
    cwd: store.root,
    model: "synthetic-model",
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  assert.deepEqual(asRecord(turnStart.params).sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.equal(asRecord(turnStart.params).approvalPolicy, "never");
  const approvals = trace.filter((entry) => entry.type === "approval-response").map((entry) => asRecord(entry.message));
  assert.deepEqual(asRecord(approvals[0]?.result), { decision: "decline" });
  assert.deepEqual(asRecord(approvals[1]?.result), { decision: "decline" });
  assert.deepEqual(asRecord(approvals[2]?.result), { permissions: {}, scope: "turn", strictAutoReview: true });

  const unknownStore = await createStore(directory, "unknown-request-marker");
  const unknownRuntime = new CodexRuntime(fakeFactory("unknownRequest", join(directory, "unknown.jsonl")));
  const unknownStarted = Date.now();
  const unknown = await unknownRuntime.runNew(unknownStore, {
    ...executionOptions("unknown-request-marker"),
    deadlineMs: 300,
    terminalWaitMs: 20,
  });
  assert.equal(unknown.state, "UNKNOWN");
  assert.ok(Date.now() - unknownStarted < 200);
  assert.equal((await readManifest(unknownStore.manifestPath)).state, "UNKNOWN");
});

test("should require explicit inputs before model calls", async () => {
  let launches = 0;
  const runtime = new CodexRuntime(() => {
    launches += 1;
    throw new Error("must not launch");
  });
  const cases = [
    ["run"],
    ["run", "--allow-model-call"],
    ["run", "--allow-model-call", "--model", "synthetic-model"],
    ["resume", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api"],
  ];
  for (const args of cases) {
    const output = await runCli(args, { runtime });
    assert.equal(output.ok, false);
  }
  assert.equal(launches, 0);
});

test("should wait for a terminal event after interrupt acknowledgement", async (t) => {
  const directory = await temporaryDirectory(t);
  const completedStore = await createStore(directory, "natural-marker");
  const completed = await new CodexRuntime(fakeFactory("interruptNaturalComplete", join(directory, "natural.jsonl"))).runNew(
    completedStore,
    { ...executionOptions("natural-marker"), interruptAfterMs: 0 },
  );
  assert.equal(completed.state, "COMPLETED");
  assert.deepEqual(completed.transitions.slice(-3), ["RUNNING", "INTERRUPT_REQUESTED", "COMPLETED"]);

  const interruptedStore = await createStore(directory, "interrupted-marker");
  const interrupted = await new CodexRuntime(fakeFactory("interruptInterrupted", join(directory, "interrupted.jsonl"))).runNew(
    interruptedStore,
    { ...executionOptions("interrupted-marker"), interruptAfterMs: 0 },
  );
  assert.equal(interrupted.state, "INTERRUPTED");

  const noTerminalStore = await createStore(directory, "interrupt-timeout-marker");
  const started = Date.now();
  const noTerminal = await new CodexRuntime(
    fakeFactory("interruptNoTerminal", join(directory, "interrupt-timeout.jsonl")),
  ).runNew(noTerminalStore, {
    ...executionOptions("interrupt-timeout-marker"),
    interruptAfterMs: 0,
    deadlineMs: 300,
    terminalWaitMs: 20,
  });
  assert.equal(noTerminal.state, "UNKNOWN");
  assert.ok(Date.now() - started < 200, "terminal wait must be bounded from interrupt acknowledgement");
});

test("should mark an uncertain started turn as unknown", async (t) => {
  const directory = await temporaryDirectory(t);
  for (const scenario of ["lostStartResponse", "exitAfterTurn"] as const) {
    const tracePath = join(directory, `${scenario}.jsonl`);
    const store = await createStore(directory, `${scenario}-marker`);
    const runtime = new CodexRuntime(fakeFactory(scenario, tracePath, { requestTimeoutMs: 80 }));
    await assert.rejects(runtime.runNew(store, executionOptions(`${scenario}-marker`)));
    const manifest = await readManifest(store.manifestPath);
    assert.equal(manifest.state, "UNKNOWN");
    assert.equal(receivedMethods(await readTrace(tracePath)).filter((method) => method === "turn/start").length, 1);
  }
});

test("should expire a started turn without a terminal notification", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "no-terminal.jsonl");
  const store = await createStore(directory, "deadline-marker");
  const runtime = new CodexRuntime(fakeFactory("noTerminal", tracePath, { closeTimeoutMs: 50 }));
  const started = Date.now();
  const result = await runtime.runNew(store, {
    ...executionOptions("deadline-marker"),
    deadlineMs: 45,
    terminalWaitMs: 20,
  });

  assert.equal(result.state, "UNKNOWN");
  assert.ok(Date.now() - started < 1_000);
  const trace = await readTrace(tracePath);
  assert.equal(receivedMethods(trace).filter((method) => method === "turn/interrupt").length, 1);
  const childPid = Number(trace.find((entry) => entry.type === "startup")?.pid);
  await waitUntil(() => !isAlive(childPid));
});

test("should start the overall deadline after persisting the start intent", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "delayed-thread.jsonl");
  const store = await createStore(directory, "delayed-thread-marker");
  const started = Date.now();
  const result = await new CodexRuntime(fakeFactory("delayedThreadNoTerminal", tracePath)).runNew(store, {
    ...executionOptions("delayed-thread-marker"),
    deadlineMs: 40,
    terminalWaitMs: 20,
  });
  const elapsed = Date.now() - started;
  const manifest = await readManifest(store.manifestPath);
  const recordedAt = Date.parse(manifest.startIntent?.recordedAt ?? "");
  const deadlineAt = Date.parse(manifest.startIntent?.deadlineAt ?? "");

  assert.equal(result.state, "UNKNOWN");
  assert.ok(deadlineAt - recordedAt >= 35 && deadlineAt - recordedAt <= 60);
  assert.ok(elapsed >= 110, `initialize/thread preparation must not consume turn budget: ${elapsed}ms`);
  assert.ok(elapsed < 500);
});

test("should block replay after a crash during a resumed turn", async (t) => {
  const directory = await temporaryDirectory(t);
  const initialTrace = join(directory, "initial.jsonl");
  const store = await createStore(directory, "crash-marker");
  await new CodexRuntime(fakeFactory("normal", initialTrace)).runNew(store, executionOptions("crash-marker"));

  const crashTrace = join(directory, "crash.jsonl");
  const driverSource = `
    import { CodexRuntime } from ${JSON.stringify(runtimeModuleUrl)};
    import { ExperimentStore } from ${JSON.stringify(policyModuleUrl)};
    import { StdioClient } from ${JSON.stringify(clientModuleUrl)};
    const store = await ExperimentStore.openOwned(process.env.TEST_MANIFEST);
    const runtime = new CodexRuntime((cwd) => StdioClient.launchForTest({
      executable: process.execPath,
      args: [process.env.TEST_FIXTURE, "crashWait"],
      cwd,
      env: process.env,
      requestTimeoutMs: 10000,
      closeTimeoutMs: 50
    }));
    await runtime.resume(store, { model: "synthetic-model", prompt: "resume without marker", deadlineMs: 10000 });
  `;
  const driver = spawn(process.execPath, ["--input-type=module", "--eval", driverSource], {
    cwd: directory,
    env: {
      ...process.env,
      TEST_MANIFEST: store.manifestPath,
      TEST_FIXTURE: fixturePath,
      FAKE_TRACE_PATH: crashTrace,
    },
    stdio: "ignore",
  });
  t.after(() => stopProcess(driver));
  await waitUntil(async () => receivedMethods(await readTrace(crashTrace)).includes("turn/start"), 2_000);
  driver.kill("SIGKILL");
  await waitForExit(driver);

  const persisted = await readManifest(store.manifestPath);
  assert.ok(
    persisted.state === "STARTING" || persisted.state === "RUNNING",
    `crash must leave a non-terminal active state, got ${persisted.state}`,
  );
  assert.equal(persisted.startIntent?.operation, "resume");
  const replayTrace = join(directory, "replay.jsonl");
  const reopened = await ExperimentStore.openOwned(store.manifestPath);
  await assert.rejects(
    new CodexRuntime(fakeFactory("normal", replayTrace)).resume(reopened, executionOptions("not-resent")),
    (error: unknown) => error instanceof ExperimentPolicyError && error.code === "RESUME_NOT_ALLOWED",
  );
  assert.equal((await readManifest(store.manifestPath)).state, "UNKNOWN");
  assert.equal(receivedMethods(await readTrace(replayTrace)).includes("turn/start"), false);
});

test("should avoid runtime calls when the start intent cannot be persisted", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "storage-failure.jsonl");
  const store = await createStore(directory, "storage-marker");
  const repository: ManifestRepository = {
    manifestPath: store.manifestPath,
    withLock: async (operation) => await store.withLock(operation),
    save: async (manifest) => {
      if (manifest.state === "STARTING") {
        throw new Error("synthetic persistence failure");
      }
      await store.save(manifest);
    },
  };
  await assert.rejects(
    new CodexRuntime(fakeFactory("normal", tracePath)).runNew(repository, executionOptions("storage-marker")),
    /synthetic persistence failure/,
  );
  const methods = receivedMethods(await readTrace(tracePath));
  assert.equal(methods.includes("thread/start"), true);
  assert.equal(methods.includes("turn/start"), false);
});

test("should ignore events from another or completed turn", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "early-events.jsonl");
  const store = await createStore(directory, "early-marker");
  const result = await new CodexRuntime(fakeFactory("earlyEvents", tracePath)).runNew(
    store,
    executionOptions("early-marker"),
  );
  assert.equal(result.state, "COMPLETED");
  assert.equal(result.transitions.at(-1), "COMPLETED");
  assert.equal(result.transitions.includes("FAILED"), false);
  assert.equal(receivedMethods(await readTrace(tracePath)).filter((method) => method === "turn/start").length, 1);
});

test("should resume only an inactive experiment-owned thread", async (t) => {
  const directory = await temporaryDirectory(t);
  const unowned = join(directory, "manifest.json");
  await writeFile(unowned, "{}", { encoding: "utf8", mode: 0o600 });
  await assert.rejects(ExperimentStore.openOwned(unowned), ExperimentPolicyError);

  const store = await createStore(directory, "resume-marker");
  await new CodexRuntime(fakeFactory("normal", join(directory, "complete.jsonl"))).runNew(
    store,
    executionOptions("resume-marker"),
  );
  const resumeTrace = join(directory, "resume-failure.jsonl");
  await assert.rejects(
    new CodexRuntime(fakeFactory("resumeFailure", resumeTrace)).resume(store, executionOptions("not-resent")),
    RuntimeTransportError,
  );
  const methods = receivedMethods(await readTrace(resumeTrace));
  assert.equal(methods.includes("thread/resume"), true);
  assert.equal(methods.includes("thread/start"), false);
  assert.equal(methods.includes("turn/start"), false);

  const activeStore = await createStore(directory, "active-marker");
  await activeStore.withLock(async (manifest) => {
    await activeStore.save({ ...manifest, state: "UNKNOWN" });
  });
  await assert.rejects(
    new CodexRuntime(fakeFactory("normal", join(directory, "blocked.jsonl"))).resume(
      activeStore,
      executionOptions("not-resent"),
    ),
    (error: unknown) => error instanceof ExperimentPolicyError && error.code === "RESUME_NOT_ALLOWED",
  );
});

test("should recall a conversation marker without resending it", async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = "a1b2c3d4e5f60718293a4b5c";
  const sharedState = join(directory, "provider-context.txt");
  const initialTrace = join(directory, "marker-initial.jsonl");
  const store = await createStore(directory, marker);
  await new CodexRuntime(fakeFactory("normal", initialTrace, { sharedState })).runNew(
    store,
    executionOptions(`Remember this conversation-only marker exactly: ${marker}`),
  );
  assert.equal((await readFile(join(store.root, "public-context.txt"), "utf8")).includes(marker), false);
  assert.equal((await readFile(store.manifestPath, "utf8")).includes(marker), false);

  const resumeTrace = join(directory, "marker-resume.jsonl");
  const resumed = await new CodexRuntime(fakeFactory("normal", resumeTrace, { sharedState })).resume(
    store,
    executionOptions("Reply with the prior marker without reading files."),
  );
  assert.equal(resumed.contextMarkerMatched, true);
  const resumeRequest = requestByMethod(await readTrace(resumeTrace), "turn/start");
  assert.equal(JSON.stringify(resumeRequest).includes(marker), false);

  const wrongStore = await createStore(directory, marker);
  await new CodexRuntime(fakeFactory("normal", join(directory, "wrong-initial.jsonl"), { sharedState })).runNew(
    wrongStore,
    executionOptions(`Remember this conversation-only marker exactly: ${marker}`),
  );
  const wrong = await new CodexRuntime(
    fakeFactory("wrongTurnMarker", join(directory, "wrong-resume.jsonl"), { sharedState }),
  ).resume(wrongStore, executionOptions("Reply with the prior marker without reading files."));
  assert.equal(wrong.contextMarkerMatched, false);
});

test("should omit secrets and native locators from public output", async (t) => {
  const directory = await temporaryDirectory(t);
  const tracePath = join(directory, "public-output.jsonl");
  const marker = "feedfacecafebeef00112233";
  let createdStore: ExperimentStore | undefined;
  const runtime = new CodexRuntime(
    fakeFactory("normal", tracePath, { stderrSecret: "SYNTHETIC_PROVIDER_TOKEN" }),
  );
  const output = await runCli(
    ["run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api"],
    {
      runtime,
      markerFactory: () => marker,
      createStore: async (hash) => {
        createdStore = await ExperimentStore.create(hash, directory);
        return createdStore;
      },
    },
  );
  assert.equal(output.ok, true);
  const serialized = JSON.stringify(output);
  assert.equal(serialized.includes("SYNTHETIC_PROVIDER_TOKEN"), false);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes("thread-1"), false);
  assert.equal(serialized.includes("turn-1"), false);
  assert.equal(serialized.includes(directory), false);
  assert.equal(serialized.includes(createdStore?.root ?? "impossible"), false);
  assert.equal(serialized.includes("/secret/fake"), false);
});

test("should clean up only the child process it started", async (t) => {
  const directory = await temporaryDirectory(t);
  const sibling = spawn(process.execPath, [fixturePath, "normal"], {
    cwd: directory,
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  t.after(() => stopProcess(sibling));
  await waitUntil(() => sibling.pid !== undefined && isAlive(sibling.pid));

  const tracePath = join(directory, "owned-child.jsonl");
  const store = await createStore(directory, "cleanup-marker");
  const result = await new CodexRuntime(
    fakeFactory("ignoreSigterm", tracePath, { closeTimeoutMs: 30, requestTimeoutMs: 100 }),
  ).runNew(store, {
    ...executionOptions("cleanup-marker"),
    deadlineMs: 40,
    terminalWaitMs: 15,
  });
  assert.equal(result.state, "UNKNOWN");
  const ownedPid = Number((await readTrace(tracePath)).find((entry) => entry.type === "startup")?.pid);
  await waitUntil(() => !isAlive(ownedPid));
  assert.equal(isAlive(sibling.pid), true);
  assert.equal(result.state, "UNKNOWN");
});

function reviewDriver(t: TestContext, mode: string, store: ExperimentStore, extraEnv: NodeJS.ProcessEnv = {}) {
  const tracePath = join(store.root, ".local-ai-runtime", `driver-${mode}-${Math.random().toString(16).slice(2)}.jsonl`);
  const child = spawn(process.execPath, [reviewDriverPath, mode], {
    cwd: store.root,
    env: { ...process.env, TEST_MANIFEST: store.manifestPath, TEST_FIXTURE: fixturePath, FAKE_TRACE_PATH: tracePath, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const messages: unknown[] = [];
  let stderr = "";
  let stdout = "";
  child.on("message", (message) => messages.push(message));
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  t.after(async () => { child.kill("SIGCONT"); stopProcess(child); await waitForExit(child); });
  return {
    child,
    tracePath,
    stderr: () => stderr,
    stdout: () => stdout,
    wait: async (expected: string) => {
      await waitUntil(() => messages.includes(expected), 2_000);
      messages.splice(messages.indexOf(expected), 1);
    },
    outcome: async () => {
      await waitUntil(() => messages.some((value) => typeof value === "object" && value !== null && ("entered" in value || "error" in value)), 2_000);
      const index = messages.findIndex((value) => typeof value === "object" && value !== null && ("entered" in value || "error" in value));
      return asRecord(messages.splice(index, 1)[0]);
    },
  };
}

function fakeFactory(
  scenario: string,
  tracePath: string,
  options: {
    readonly requestTimeoutMs?: number;
    readonly closeTimeoutMs?: number;
    readonly sharedState?: string;
    readonly stderrSecret?: string;
  } = {},
): RuntimeClientFactory {
  return (cwd) =>
    StdioClient.launchForTest({
      executable: process.execPath,
      args: [fixturePath, scenario],
      cwd,
      env: {
        ...process.env,
        FAKE_TRACE_PATH: tracePath,
        ...(options.sharedState === undefined ? {} : { FAKE_SHARED_STATE: options.sharedState }),
        ...(options.stderrSecret === undefined ? {} : { FAKE_STDERR_SECRET: options.stderrSecret }),
      },
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    });
}

async function createStore(parent: string, marker: string): Promise<ExperimentStore> {
  return await ExperimentStore.create(createHash("sha256").update(marker).digest("hex"), parent);
}

function executionOptions(prompt: string) {
  return { model: "synthetic-model", prompt, deadlineMs: 300, terminalWaitMs: 30 } as const;
}

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-runtime-test-"));
  await chmod(directory, 0o700);
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readTrace(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function receivedMethods(trace: readonly Record<string, unknown>[]): string[] {
  return trace
    .filter((entry) => entry.type === "received")
    .map((entry) => asRecord(entry.message).method)
    .filter((method): method is string => typeof method === "string");
}

function requestByMethod(trace: readonly Record<string, unknown>[], method: string): Record<string, unknown> {
  const entry = trace.find(
    (candidate) => candidate.type === "received" && asRecord(candidate.message).method === method,
  );
  assert.ok(entry, `missing request ${method}`);
  return asRecord(entry.message);
}

async function readManifest(path: string): Promise<ExperimentManifest> {
  return JSON.parse(await readFile(path, "utf8")) as ExperimentManifest;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("condition timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => { resolve = resolver; });
  return { promise, resolve };
}

async function waitForIo(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const started = process.hrtime.bigint();
  while (!(await predicate())) {
    if (process.hrtime.bigint() - started > 1_000_000_000n) throw new Error("I/O condition timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isSafeInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function waitForExitWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
