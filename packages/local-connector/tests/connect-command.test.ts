import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { CentralClient } from "../src/central-client.ts";
import { Connector } from "../src/cli.ts";
import { prepareConnection } from "../src/cli/connect-command.ts";
import { withSettingsDeviceLock } from "../src/cli/settings-lock.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { StateStore } from "../src/state-store.ts";
import type { Scope } from "../src/contracts.ts";

async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "connect-command-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = new StateStore(join(dir, "state"), "web-test");
  const pairingId = randomUUID(),
    deviceId = randomUUID();
  const scope: Scope = {
    ownerAlias: "본인",
    organizationId: randomUUID(),
    organizationName: "개발팀",
    roomId: randomUUID(),
    roomTitle: "채팅방",
    deviceAlias: "내 Mac",
  };
  const f = {
    profile,
    scope,
    state: "approved",
    now: Date.now(),
    confirmations: 0,
    acceptedConfirmations: 0,
    confirmed: true,
    lost: new Set<string>(),
    calls: [] as { action: string; body: Record<string, unknown> }[],
    opened: [] as string[],
    notices: [] as string[],
    abort: new AbortController(),
    pause: async () => {},
  };
  let expiresAt = new Date(f.now + 300000).toISOString();
  const client = new CentralClient("http://127.0.0.1:4318", async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    f.calls.push({ action, body: JSON.parse(String(init?.body)) });
    if (f.lost.delete(action)) throw new TypeError("synthetic response loss");
    if (action === "begin" && f.state === "expired") f.state = "approved";
    if (action === "begin") expiresAt = new Date(f.now + 300000).toISOString();
    const data =
      action === "begin"
        ? { protocol: 1, pairingId, expiresAt: new Date(f.now + 300000).toISOString() }
        : action === "pairing-status"
          ? {
              protocol: 1,
              pairingId,
              expiresAt,
              state: f.state,
              ...(f.state === "approved" ? { scope: f.scope } : {}),
            }
          : action === "exchange"
            ? { protocol: 1, deviceId, expiresAt: new Date(f.now + 3600000).toISOString() }
            : { protocol: 1, bindings: [] };
    return Response.json({ ok: true, data });
  });
  const connector = new Connector(profile, client);
  const input = {
    organizationId: scope.organizationId,
    roomId: scope.roomId,
    deviceAlias: "내 Mac",
  };
  const interaction = {
    interactive: true,
    signal: f.abort.signal,
    write: (value: string) => {
      f.notices.push(value);
    },
    open: async (value: string) => {
      f.opened.push(value);
    },
    confirm: async (value: Scope) => {
      assert.deepEqual(value, f.scope);
      assert.equal(
        f.calls.filter((call) => call.action === "exchange").length,
        f.acceptedConfirmations,
      );
      f.confirmations++;
      if (f.confirmed) f.acceptedConfirmations++;
      return f.confirmed;
    },
    pause: () => f.pause(),
    now: () => f.now,
  };
  const run = (overrides = {}) =>
    withSettingsDeviceLock(profile, "connect", () =>
      prepareConnection(connector, input, { ...interaction, ...overrides }),
    );
  return { ...f, f, connector, input, interaction, run };
}

test("should require local scope confirmation before exchange", async (t) => {
  const { f, run } = await fixture(t);
  await run();
  assert.equal(f.confirmations, 1);
  assert.equal((await f.profile.read())?.status, "connected");
  const opened = new URL(f.opened[0]);
  assert.equal(opened.search, "");
  assert.equal(new URLSearchParams(opened.hash.slice(1)).get("room"), f.scope.roomId);
  assert.equal(f.calls.filter((call) => call.action === "exchange").length, 1);
});

test("should refuse confirmation without a terminal or after refusal", async (t) => {
  const { f, run } = await fixture(t);
  await assert.rejects(run({ interactive: false }), { code: "FORBIDDEN" });
  assert.equal(f.calls.length, 0);
  f.confirmed = false;
  await assert.rejects(run(), { code: "FORBIDDEN" });
  assert.ok(!f.calls.some((call) => call.action === "exchange"));
  assert.ok(!(await f.profile.read())?.credential);
});

test("should refuse a mismatched room or organization", async (t) => {
  for (const key of ["roomId", "organizationId"] as const) {
    const { f, run } = await fixture(t);
    f.scope[key] = randomUUID();
    await assert.rejects(run(), { code: "FORBIDDEN" });
    assert.equal(f.confirmations, 0);
    assert.ok(!f.calls.some((call) => call.action === "exchange"));
  }
});

test("should preserve the pairing operation after response loss", async (t) => {
  const { f, run } = await fixture(t);
  f.lost.add("begin");
  await assert.rejects(run(), { code: "UNAVAILABLE" });
  const saved = await f.profile.read();
  assert.equal(saved?.pending?.action, "begin");
  await run();
  const begins = f.calls.filter((call) => call.action === "begin");
  assert.equal(begins.length, 2);
  assert.deepEqual(begins[1].body, begins[0].body);
  assert.equal((await f.profile.read())?.deviceId !== undefined, true);
});

test("should preserve the same exchange operation and credential on uncertain recovery", async (t) => {
  const { f, run } = await fixture(t);
  f.lost.add("exchange");
  await assert.rejects(run(), { code: "UNAVAILABLE" });
  const saved = await f.profile.read();
  assert.equal(saved?.pending?.action, "exchange");
  await run();
  const exchanges = f.calls.filter((call) => call.action === "exchange");
  assert.equal(exchanges.length, 2);
  assert.deepEqual(exchanges[1].body, exchanges[0].body);
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
  assert.equal((await f.profile.read())?.credential, saved?.pending?.candidateCredential);
});

test("should resume the same connected profile without pairing or exchange", async (t) => {
  const { f, run } = await fixture(t);
  await run();
  const prior = await f.profile.read();
  const before = f.calls.length;
  await run({ confirm: async () => true });
  assert.deepEqual(
    f.calls.slice(before).map((call) => call.action),
    ["bindings"],
  );
  assert.deepEqual(await f.profile.read(), prior);
});

test("should refuse a competing manager before pairing", async (t) => {
  const { f, run } = await fixture(t);
  await new SettingsStore(f.profile).locked(async () => {
    await assert.rejects(run(), { code: "RUNTIME_BUSY" });
  });
  assert.equal(f.calls.length, 0);
});

test("should stop polling on expiry or abort without a new profile or model input", async (t) => {
  for (const reason of ["expiry", "abort"] as const) {
    const { f, run } = await fixture(t);
    f.state = "pending";
    f.pause = async () => {
      if (reason === "expiry") f.now += 300001;
      else f.abort.abort();
    };
    await assert.rejects(run(), { code: "CONFLICT" });
    assert.deepEqual(
      f.calls.map((call) => call.action),
      ["begin", "pairing-status"],
    );
    assert.ok((await f.profile.read())?.code);
    assert.ok(!(await f.profile.read())?.credential);
  }
});

test("should preserve an approved profile when browser opening fails", async (t) => {
  const { f, run } = await fixture(t);
  await run({
    open: async () => {
      throw new Error("browser unavailable");
    },
  });
  assert.equal((await f.profile.read())?.status, "connected");
  assert.equal(f.opened.length, 0);
  assert.equal(f.notices.length, 3);
});

test("should renew only a confirmed expired unregistered pairing and preserve its original bytes", async (t) => {
  const { f, run } = await fixture(t);
  f.confirmed = false;
  await assert.rejects(run(), { code: "FORBIDDEN" });
  const original = await readFile(f.profile.file);
  f.now += 300001;
  f.state = "expired";
  f.confirmed = true;
  let restarted = 0;
  await run({
    confirmRestart: async () => {
      restarted++;
      return true;
    },
  });
  assert.equal(restarted, 1);
  assert.equal((await f.profile.read())?.status, "connected");
  const begins = f.calls.filter((call) => call.action === "begin");
  assert.equal(begins.length, 2);
  assert.notEqual(begins[0].body.codeHash, begins[1].body.codeHash);
  const archives = (await readdir(f.profile.dir)).filter((name) =>
    name.startsWith(".expired-pairing-"),
  );
  assert.equal(archives.length, 1);
  assert.deepEqual(await readFile(join(f.profile.dir, archives[0])), original);
  assert.equal(f.calls.filter((call) => call.action === "exchange").length, 1);
});

test("should retain an expired pairing without explicit restart confirmation", async (t) => {
  const { f, run } = await fixture(t);
  f.confirmed = false;
  await assert.rejects(run(), { code: "FORBIDDEN" });
  const original = await readFile(f.profile.file);
  f.now += 300001;
  f.state = "expired";
  await assert.rejects(run({ confirmRestart: async () => false }), { code: "CONFLICT" });
  assert.deepEqual(await readFile(f.profile.file), original);
  assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
  assert.equal(f.calls.filter((call) => call.action === "exchange").length, 0);
});

async function expiredFixture(t: TestContext) {
  const result = await fixture(t);
  result.f.confirmed = false;
  await assert.rejects(result.run(), { code: "FORBIDDEN" });
  result.f.now += 300001;
  result.f.state = "expired";
  result.f.confirmed = true;
  return result;
}

test("should retain pairing evidence and start no new operation after archive storage failures", async (t) => {
  for (const phase of [
    "write",
    "archive-sync",
    "archive-close",
    "directory-before",
    "unlink",
    "directory-after",
  ] as const) {
    const { f, run } = await expiredFixture(t);
    const original = await readFile(f.profile.file);
    const failure = new Error(`Synthetic archive ${phase} failure`);
    const realOpen = fsPromises.open,
      realUnlink = fsPromises.unlink;
    let faults = 0,
      directorySyncs = 0;
    const fail = async () => {
      faults++;
      throw failure;
    };
    const openMock = mock.method(
      fsPromises,
      "open",
      async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await realOpen(...args);
        const path = String(args[0]);
        if (path.includes("/.expired-pairing-")) {
          if (phase === "write") mock.method(handle, "writeFile", fail);
          if (phase === "archive-sync") mock.method(handle, "sync", fail);
          if (phase === "archive-close") {
            const close = handle.close.bind(handle);
            mock.method(handle, "close", async () => {
              await close();
              await fail();
            });
          }
        } else if (path === f.profile.dir) {
          const sync = handle.sync.bind(handle);
          mock.method(handle, "sync", async () => {
            directorySyncs++;
            if (
              (phase === "directory-before" && directorySyncs === 1) ||
              (phase === "directory-after" && directorySyncs === 2)
            )
              await fail();
            await sync();
          });
        }
        return handle;
      },
    );
    const unlinkMock = mock.method(
      fsPromises,
      "unlink",
      async (...args: Parameters<typeof fsPromises.unlink>) => {
        if (phase === "unlink" && String(args[0]) === f.profile.file) await fail();
        return realUnlink(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(run({ confirmRestart: async () => true }), (error) => error === failure);
    } finally {
      openMock.mock.restore();
      unlinkMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(faults, 1, phase);
    assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
    assert.equal(f.calls.filter((call) => call.action === "exchange").length, 0);
    if (phase === "directory-after") {
      await assert.rejects(readFile(f.profile.file), { code: "ENOENT" });
      const archives = (await readdir(f.profile.dir)).filter((name) =>
        name.startsWith(".expired-pairing-"),
      );
      assert.equal(archives.length, 1);
      assert.deepEqual(await readFile(join(f.profile.dir, archives[0])), original);
    } else assert.deepEqual(await readFile(f.profile.file), original);
  }
});

test("should retain the current profile if renewal is aborted or changed after preserving its bytes", async (t) => {
  for (const reason of ["abort", "changed-profile"] as const) {
    const { f, run } = await expiredFixture(t);
    const original = await readFile(f.profile.file);
    const changed = {
      ...(await f.profile.read())!,
      scope: { ...f.scope, ownerAlias: "changed owner" },
    };
    const realOpen = fsPromises.open;
    const openMock = mock.method(
      fsPromises,
      "open",
      async (...args: Parameters<typeof fsPromises.open>) => {
        const handle = await realOpen(...args);
        if (String(args[0]).includes("/.expired-pairing-")) {
          const sync = handle.sync.bind(handle);
          mock.method(handle, "sync", async () => {
            await sync();
            if (reason === "abort") f.abort.abort();
            else await f.profile.write(changed);
          });
        }
        return handle;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(run({ confirmRestart: async () => true }));
    } finally {
      openMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(
      await f.profile.read(),
      reason === "abort" ? JSON.parse(original.toString()) : changed,
    );
    const archives = (await readdir(f.profile.dir)).filter((name) =>
      name.startsWith(".expired-pairing-"),
    );
    assert.equal(archives.length, 1);
    assert.deepEqual(await readFile(join(f.profile.dir, archives[0])), original);
    assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
    assert.equal(f.calls.filter((call) => call.action === "exchange").length, 0);
  }
});

test("should recheck retained AI state after waiting for restart confirmation", async (t) => {
  for (const kind of ["settings", "runtime"] as const) {
    const { f, run } = await expiredFixture(t);
    const original = await readFile(f.profile.file);
    await assert.rejects(
      run({
        confirmRestart: async () => {
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { RuntimeStore } = await import("../src/runtime-store.ts");
          const store =
            kind === "settings"
              ? new SettingsStore(f.profile)
              : new RuntimeStore(f.profile.dir, f.profile.profile, randomUUID());
          await mkdir(store.dir, { recursive: true, mode: 0o700 });
          await writeFile(store.file, "unresolved state", { mode: 0o600 });
          return true;
        },
      }),
    );
    assert.deepEqual(await readFile(f.profile.file), original);
    assert.equal(
      (await readdir(f.profile.dir)).filter((name) => name.startsWith(".expired-pairing-")).length,
      0,
    );
    assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
  }
});

test("should refuse pairing renewal while registration, exchange or AI history may be unresolved", async (t) => {
  for (const held of [
    "mapping",
    "registration",
    "pending",
    "settings",
    "runtime",
    "unverified-expiry",
  ] as const) {
    const { f, run } = await fixture(t);
    f.confirmed = false;
    await assert.rejects(run(), { code: "FORBIDDEN" });
    const state = (await f.profile.read())!;
    f.now += 300001;
    f.state = held === "unverified-expiry" ? "approved" : "expired";
    if (held === "mapping")
      state.mappings.push({ root: "/synthetic", nativeSessionId: "retained" });
    if (held === "registration")
      state.registration = {
        mapping: { root: "/synthetic", nativeSessionId: "retained" },
        sessionAlias: "retained",
      };
    if (held === "pending")
      state.pending = { action: "exchange", body: {}, payloadHash: "a".repeat(64) };
    await f.profile.write(state);
    if (held === "settings") {
      const settings = new SettingsStore(f.profile);
      // Malformed retained state must block renewal rather than be discarded.
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(settings.dir, { recursive: true, mode: 0o700 });
      await writeFile(settings.file, "unresolved settings", { mode: 0o600 });
    }
    if (held === "runtime") {
      const { RuntimeStore } = await import("../src/runtime-store.ts");
      const runtime = new RuntimeStore(f.profile.dir, f.profile.profile, randomUUID());
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(runtime.dir, { recursive: true, mode: 0o700 });
      await writeFile(runtime.file, "unresolved runtime", { mode: 0o600 });
    }
    const before = await readFile(f.profile.file);
    let restarts = 0;
    await assert.rejects(
      run({
        confirmRestart: async () => {
          restarts++;
          return true;
        },
      }),
    );
    assert.equal(restarts, 0, held);
    assert.deepEqual(await readFile(f.profile.file), before);
    assert.equal(f.calls.filter((call) => call.action === "begin").length, 1);
    assert.equal(f.calls.filter((call) => call.action === "exchange").length, 0);
    assert.equal(
      (await readdir(f.profile.dir)).filter((name) => name.startsWith(".expired-pairing-")).length,
      0,
    );
  }
});

test("should reject an ended confirmation input without hanging", async (t) => {
  const f = await fixture(t);
  const entry = new URL("../src/cli/connect-command.js", import.meta.url).href;
  const driver = `import {terminalInteraction} from ${JSON.stringify(entry)};
process.stdin.push(null);
try { await terminalInteraction(new AbortController().signal).confirm(${JSON.stringify(f.scope)}, new AbortController().signal); process.exitCode = 2; } catch { process.stdout.write("REFUSED"); }`;
  const result = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", driver],
    { timeout: 2000 },
  );
  assert.match(result.stdout, /REFUSED/);
});

test("should ask again after an empty local confirmation and require an explicit answer", async (t) => {
  const { f } = await fixture(t);
  const entry = new URL("../src/cli/connect-command.js", import.meta.url).href;
  const driver = `import {terminalInteraction} from ${JSON.stringify(entry)};
const stop = new AbortController();
const confirmed = await terminalInteraction(stop.signal).confirm(${JSON.stringify(f.scope)}, stop.signal);
process.stdout.write(JSON.stringify({confirmed})+"\\n");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", driver], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "",
    stderr = "",
    prompts = 0;
  const prompt = "내 계정과 선택한 방이 맞으면 yes를 입력하세요";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    const count = stdout.split(prompt).length - 1;
    if (count > prompts) {
      prompts = count;
      child.stdin.write(count === 1 ? "\n" : "yes\n");
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Confirmation did not finish"));
    }, 2000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  assert.equal(result, 0, stderr);
  assert.equal(prompts, 2);
  assert.match(stdout, /"confirmed":true/);
});
