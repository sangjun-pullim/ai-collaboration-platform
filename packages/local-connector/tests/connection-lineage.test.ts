import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state-store.ts";
import { SettingsStore } from "../src/settings/store.ts";
import { Connector } from "../src/cli.ts";
import { CentralClient } from "../src/central-client.ts";
import { prepareConnection, connectionFailureHint } from "../src/cli/connect-command.ts";
import {
  selectConnectionProfile,
  prepareSelectedConnection,
} from "../src/cli/connection-recovery.ts";
import type { WorkflowRunner } from "../src/workflow-runner.ts";

async function fixture(t: TestContext, state?: "valid" | "expired") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "connection-lineage-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const origin = "http://127.0.0.1:4318";
  const baseProfile = `web-${"a".repeat(32)}`,
    chain = [];
  let parent = baseProfile;
  for (let n = 0; n < 3; n++) {
    const recoveryId = randomUUID(),
      profile = `web-${createHash("sha256")
        .update(JSON.stringify(["connection-recovery", parent, recoveryId]))
        .digest("hex")
        .slice(0, 32)}`;
    chain.push({ previousProfile: parent, recoveryId, profile });
    parent = profile;
  }
  const selection = { version: 1, baseProfile, chain },
    last = chain.at(-1)!;
  const scope = {
    ownerAlias: "본인",
    organizationId: randomUUID(),
    organizationName: "합성 조직",
    roomId: randomUUID(),
    roomTitle: "합성 방",
    deviceAlias: "검증 Mac",
  };
  const input = {
    organizationId: scope.organizationId,
    roomId: scope.roomId,
    deviceAlias: scope.deviceAlias,
    previousProfile: last.previousProfile,
    recoveryId: last.recoveryId,
    recoveryChain: JSON.stringify(selection),
  };
  const original = new StateStore(dir, baseProfile),
    target = new StateStore(dir, last.profile);
  if (state)
    await original.write({
      version: 1,
      server: origin,
      status: "connected",
      deviceId: randomUUID(),
      credential: "a".repeat(64),
      credentialExpiresAt: new Date(
        Date.now() + (state === "valid" ? 3600000 : -3600000),
      ).toISOString(),
      scope,
      mappings: [],
    });
  else await original.read();
  const calls: string[] = [];
  const control = { expiredPairing: false };
  const pairingId = randomUUID(),
    deviceId = randomUUID();
  const client = new CentralClient(origin, async (url) => {
    const action = String(url).split("/").at(-1)!;
    calls.push(action);
    if (action === "begin") control.expiredPairing = false;
    if (action === "pairing-status" && control.expiredPairing)
      return Response.json({
        ok: true,
        data: {
          protocol: 1,
          pairingId,
          expiresAt: new Date(Date.now() - 3600000).toISOString(),
          state: "expired",
        },
      });
    const data =
      action === "begin"
        ? { protocol: 1, pairingId, expiresAt: new Date(Date.now() + 300000).toISOString() }
        : action === "pairing-status"
          ? {
              protocol: 1,
              pairingId,
              expiresAt: new Date(Date.now() + 300000).toISOString(),
              state: "approved",
              scope,
            }
          : action === "exchange"
            ? { protocol: 1, deviceId, expiresAt: new Date(Date.now() + 3600000).toISOString() }
            : { protocol: 1, bindings: [] };
    return Response.json({ ok: true, data });
  });
  const interaction = {
    interactive: true,
    signal: new AbortController().signal,
    write: () => {},
    open: async () => {},
    confirm: async () => true,
    confirmPreviousRevoked: async () => true,
  };
  const runner = () => {
    throw new Error("empty fixture must not create an AI runtime");
  };
  const run = async (overrides = {}) => {
    const selected = await selectConnectionProfile(target, input, origin);
    const connector = new Connector(selected.store, client);
    if (selected.mode === "normal")
      return prepareSelectedConnection(
        selected,
        () => {},
        (verify) =>
          prepareConnection(
            connector,
            {
              organizationId: input.organizationId,
              roomId: input.roomId,
              deviceAlias: input.deviceAlias,
            },
            { ...interaction, ...overrides, verifyPreparation: verify },
          ),
      );
    return prepareConnection(
      connector,
      input,
      { ...interaction, ...overrides },
      runner as unknown as (p: StateStore, a: string) => WorkflowRunner,
    );
  };
  return { dir, origin, selection, input, original, target, scope, calls, run, control, pairingId };
}

test("should restart an expired pairing ancestor and retain its attributable archive across later commands", async (t) => {
  const f = await fixture(t);
  await f.original.write({
    version: 1,
    server: f.origin,
    status: "pairing",
    code: "b".repeat(64),
    proof: "c".repeat(64),
    pairingId: f.pairingId,
    pairingExpiresAt: new Date(Date.now() - 3600000).toISOString(),
    scope: f.scope,
    mappings: [],
  });
  f.control.expiredPairing = true;
  await f.run({ confirmRestart: async () => true });
  assert.equal((await f.original.read())?.status, "connected");
  const before = f.calls.length;
  await f.run();
  assert.deepEqual(f.calls.slice(before), ["bindings"]);
});

for (const older of ["absent", "valid"] as const)
  test(`should preserve the selected intermediate pairing during restart with an ${older} baseline`, async (t) => {
    const f = await fixture(t, older === "valid" ? "valid" : undefined);
    const intermediate = new StateStore(f.dir, f.selection.chain[0].profile);
    await intermediate.write({
      version: 1,
      server: f.origin,
      status: "pairing",
      code: "b".repeat(64),
      proof: "c".repeat(64),
      pairingId: f.pairingId,
      pairingExpiresAt: new Date(Date.now() - 3600000).toISOString(),
      scope: f.scope,
      mappings: [],
    });
    const baseline = await f.original.read();
    f.control.expiredPairing = true;
    await f.run({ confirmRestart: async () => true });
    assert.equal((await intermediate.read())?.status, "connected");
    assert.deepEqual(await f.original.read(), baseline);
    const start = f.calls.length;
    await f.run();
    assert.deepEqual(f.calls.slice(start), ["bindings"]);
  });

for (const changed of ["extra-archive", "runtime-evidence"] as const)
  test(`should refuse an intermediate pairing replacement with ${changed} during restart confirmation`, async (t) => {
    const f = await fixture(t, "valid"),
      intermediate = new StateStore(f.dir, f.selection.chain[0].profile);
    await intermediate.write({
      version: 1,
      server: f.origin,
      status: "pairing",
      code: "b".repeat(64),
      proof: "c".repeat(64),
      pairingId: f.pairingId,
      pairingExpiresAt: new Date(Date.now() - 3600000).toISOString(),
      scope: f.scope,
      mappings: [],
    });
    f.control.expiredPairing = true;
    await assert.rejects(
      f.run({
        confirmRestart: async () => {
          if (changed === "extra-archive")
            await writeFile(
              join(f.dir, `.expired-pairing-${intermediate.profile}-${randomUUID()}.json`),
              JSON.stringify(await intermediate.read()),
              { mode: 0o600 },
            );
          else
            await writeFile(
              join(f.dir, "runtime", intermediate.profile, "unknown.json"),
              "preserve this evidence",
              { mode: 0o600 },
            );
          return true;
        },
      }),
    );
    assert.deepEqual(f.calls, ["pairing-status"]);
  });

test("should reuse a valid ancestor after two unexecuted intermediate commands without registering a new device", async (t) => {
  const f = await fixture(t, "valid"),
    before = await readFile(f.original.file);
  await f.run();
  assert.deepEqual(f.calls, ["bindings"]);
  assert.deepEqual(await readFile(f.original.file), before);
  assert.equal(await f.target.read(), undefined);
});
test("should recover an expired actual ancestor while preserving its bytes and the nominal hash parent", async (t) => {
  const f = await fixture(t, "expired"),
    before = await readFile(f.original.file);
  await f.run();
  assert.deepEqual(await readFile(f.original.file), before);
  assert.equal((await f.target.read())?.status, "connected");
  assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
});
test("should freshly approve a disconnected future-expiry intermediate without falling back to a valid baseline", async (t) => {
  const f = await fixture(t, "valid"),
    intermediate = new StateStore(f.dir, f.selection.chain[0].profile),
    baseline = await readFile(f.original.file);
  await intermediate.write({
    ...(await f.original.read())!,
    status: "disconnected",
    deviceId: randomUUID(),
  });
  const before = await readFile(intermediate.file);
  let cancellations = 0;
  const confirmPreviousRevoked = async () => {
    assert.deepEqual(f.calls, []);
    cancellations++;
    return true;
  };
  await f.run({ confirmPreviousRevoked });
  assert.deepEqual(f.calls, ["begin", "pairing-status", "exchange"]);
  assert.notEqual((await f.target.read())!.deviceId, (await intermediate.read())!.deviceId);
  f.calls.length = 0;
  await f.run({ confirmPreviousRevoked });
  assert.deepEqual(f.calls, ["bindings"]);
  assert.equal(cancellations, 1);
  assert.deepEqual(await readFile(intermediate.file), before);
  assert.deepEqual(await readFile(f.original.file), baseline);
});
for (const fault of ["invalid-expiry", "pending", "wrong-scope"] as const)
  test(`should refuse disconnected future-expiry intermediate ${fault} without unsafe baseline fallback`, async (t) => {
    const f = await fixture(t, "valid"),
      intermediate = new StateStore(f.dir, f.selection.chain[0].profile),
      owner = {
        ...(await f.original.read())!,
        status: "disconnected" as const,
        deviceId: randomUUID(),
      };
    if (fault === "invalid-expiry") owner.credentialExpiresAt = "invalid";
    if (fault === "pending")
      owner.pending = {
        action: "rotate",
        body: { operationId: randomUUID() },
        payloadHash: "a".repeat(64),
      };
    if (fault === "wrong-scope") owner.scope = { ...owner.scope!, roomId: randomUUID() };
    await intermediate.write(owner);
    const bytes = await readFile(intermediate.file);
    await assert.rejects(f.run());
    assert.deepEqual(f.calls, []);
    assert.equal(await f.target.read(), undefined);
    assert.deepEqual(await readFile(intermediate.file), bytes);
  });
test("should start the baseline profile when every prepared generation is genuinely unused", async (t) => {
  const f = await fixture(t);
  await f.run();
  assert.equal((await f.original.read())?.status, "connected");
  assert.equal(await f.target.read(), undefined);
});
test("should hold every skipped device lock across local owner confirmation", async (t) => {
  const f = await fixture(t, "valid");
  await f.run({
    confirm: async () => {
      for (const generation of f.selection.chain)
        await assert.rejects(
          new SettingsStore(new StateStore(f.dir, generation.profile)).locked(async () => {}),
          { code: "RUNTIME_BUSY" },
        );
      return true;
    },
  });
});
for (const kind of [
  "catalog",
  "profile-lock",
  "temporary-record",
  "settings",
  "runtime",
  "tombstone",
] as const)
  test(`should reject an absent intermediate profile with ${kind} evidence before registration`, async (t) => {
    const f = await fixture(t, "expired"),
      name = f.selection.chain[0].profile;
    if (kind === "catalog") await mkdir(join(f.dir, `${name}.claude-catalog`), { mode: 0o700 });
    else if (kind === "profile-lock")
      await writeFile(join(f.dir, `${name}.lock`), "1", { mode: 0o600 });
    else if (kind === "temporary-record")
      await writeFile(join(f.dir, `.${name}-${randomUUID()}.tmp`), "preserve", { mode: 0o600 });
    else if (kind === "settings") {
      const folder = new SettingsStore(new StateStore(f.dir, name)).dir;
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, "unknown"), "preserve", { mode: 0o600 });
    } else if (kind === "runtime") {
      const folder = join(f.dir, "runtime", name);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(join(folder, "unknown"), "preserve", { mode: 0o600 });
    } else
      await writeFile(
        join(f.dir, `.expired-pairing-${randomUUID()}.json`),
        JSON.stringify({
          version: 1,
          server: f.origin,
          status: "pairing",
          mappings: [],
          code: "b".repeat(64),
          proof: "c".repeat(64),
          pairingId: randomUUID(),
          pairingExpiresAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    await assert.rejects(f.run());
    assert.deepEqual(f.calls, []);
  });
test("should reject the nearest stored ancestor from another room without falling back to the valid baseline", async (t) => {
  const f = await fixture(t, "valid"),
    nearest = new StateStore(f.dir, f.input.previousProfile);
  const record = (await f.original.read())!;
  await nearest.write({ ...record, scope: { ...record.scope!, roomId: randomUUID() } });
  await assert.rejects(f.run(), { code: "FORBIDDEN" });
  assert.deepEqual(f.calls, []);
});
test("should refuse a new skipped profile appearing during confirmation and preserve its record", async (t) => {
  const f = await fixture(t, "valid"),
    gap = new StateStore(f.dir, f.selection.chain[0].profile);
  await assert.rejects(
    f.run({
      confirm: async () => {
        await gap.write((await f.original.read())!);
        return true;
      },
    }),
    { code: "AUTHORITY_LOST" },
  );
  assert.ok(await gap.read());
  assert.ok(!f.calls.includes("exchange"));
});
test("should explain a legacy missing parent without falsely claiming another account owns the device", async (t) => {
  const f = await fixture(t, "expired");
  const error = await prepareConnection(
    new Connector(f.target, new CentralClient(f.origin)),
    { ...f.input, recoveryChain: undefined },
    {
      interactive: true,
      signal: new AbortController().signal,
      write: () => {},
      open: async () => {},
      confirm: async () => true,
    },
    () => {
      throw Error();
    },
  ).then(
    () => undefined,
    (e) => e,
  );
  assert.match(connectionFailureHint(error), /이전 로컬 연결 기록/);
});

for (const stage of ["revoked", "exchange"] as const)
  for (const kind of ["profile", "archive"] as const)
    test(`should reject ${kind} changes during ${stage} confirmation before its registration mutation`, async (t) => {
      const f = await fixture(t, "expired");
      const change = async () => {
        if (kind === "profile")
          await new StateStore(f.dir, f.selection.chain[0].profile).write(
            (await f.original.read())!,
          );
        else
          await writeFile(
            join(f.dir, `.expired-pairing-${randomUUID()}.json`),
            JSON.stringify({
              version: 1,
              server: f.origin,
              status: "pairing",
              mappings: [],
              code: "b".repeat(64),
              proof: "c".repeat(64),
              pairingId: randomUUID(),
              pairingExpiresAt: new Date().toISOString(),
            }),
            { mode: 0o600 },
          );
        return true;
      };
      await assert.rejects(
        f.run(stage === "revoked" ? { confirmPreviousRevoked: change } : { confirm: change }),
      );
      assert.ok(!f.calls.includes("exchange"));
      if (stage === "revoked") assert.deepEqual(f.calls, []);
      else assert.deepEqual(f.calls, ["begin", "pairing-status"]);
    });

test("should block a missing generation's attributed archive but allow a securely proved unrelated origin", async (t) => {
  for (const own of [true, false]) {
    const f = await fixture(t, "expired"),
      profile = f.selection.chain[0].profile;
    const name = own
      ? `.expired-pairing-${profile}-${randomUUID()}.json`
      : `.expired-pairing-${randomUUID()}.json`;
    await writeFile(
      join(f.dir, name),
      JSON.stringify({
        version: 1,
        server: own ? f.origin : "https://unrelated.example",
        status: "pairing",
        mappings: [],
        code: "b".repeat(64),
        proof: "c".repeat(64),
        pairingId: randomUUID(),
        pairingExpiresAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    if (own) {
      await assert.rejects(f.run());
      assert.deepEqual(f.calls, []);
    } else await f.run();
  }
});
