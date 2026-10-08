import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
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
    confirmed: true,
    lost: new Set<string>(),
    calls: [] as { action: string; body: Record<string, unknown> }[],
    opened: [] as string[],
    notices: [] as string[],
    abort: new AbortController(),
    pause: async () => {},
  };
  const expiresAt = new Date(f.now + 300000).toISOString();
  const client = new CentralClient("http://127.0.0.1:4318", async (url, init) => {
    const action = String(url).split("/").at(-1)!;
    f.calls.push({ action, body: JSON.parse(String(init?.body)) });
    if (f.lost.delete(action)) throw new TypeError("synthetic response loss");
    const data =
      action === "begin"
        ? { protocol: 1, pairingId, expiresAt }
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
        f.confirmations ? 1 : 0,
      );
      f.confirmations++;
      return f.confirmed;
    },
    pause: (signal: AbortSignal) => f.pause(signal),
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
