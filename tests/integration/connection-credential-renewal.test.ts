import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { StateStore } from "../../packages/local-connector/src/state-store.js";
import { Connector } from "../../packages/local-connector/src/cli.js";
import { CentralClient } from "../../packages/local-connector/src/central-client.js";
import { WorkflowClient } from "../../packages/local-connector/src/workflow-client.js";
import { WorkflowRunner } from "../../packages/local-connector/src/workflow-runner.js";
import { RuntimeStore } from "../../packages/local-connector/src/runtime-store.js";
import type { PublicBinding } from "../../packages/local-connector/src/contracts.js";
import { prepareConnection } from "../../packages/local-connector/src/cli/connect-command.js";
import { OwnedFakeAdapter } from "../helpers/owned-runtime-fixture.js";
import {
  deviceCase,
  digest,
  secret,
  type DeviceFixture,
  type DeviceProfile,
  type DeviceResponse,
} from "../helpers/device-binding-fixture.js";
import { ensure, assertOwnedStack, productEnvironment } from "../helpers/local-access-stack.js";

function success(response: DeviceResponse) {
  ensure(
    response.status === 200 && response.data.ok === true,
    "Expected successful owned device request",
  );
  return response.data.data as Record<string, unknown>;
}
function unauthorized(response: DeviceResponse) {
  ensure(
    response.status === 401 && response.data.ok === false,
    "Expected immediate authentication rejection",
  );
}
function ownedRunner(
  profile: StateStore,
  agentId: string,
  adapter: OwnedFakeAdapter,
  origin: string,
) {
  const owner = new Connector(profile, new CentralClient(origin));
  return new WorkflowRunner(
    profile,
    new RuntimeStore(profile.dir, profile.profile, agentId),
    new WorkflowClient(owner.client.origin),
    adapter,
    {
      rotate: (check) => owner.rotate(check),
      bindings: async (key) =>
        (await owner.client.call("bindings", {}, key)).bindings as PublicBinding[],
      replace: (input) => owner.replace(input),
    },
  );
}
async function registered(f: DeviceFixture, name: string) {
  const owner = await f.stack.person(name);
  const scope = await f.stack.bootstrap(owner);
  const p = (await f.apiPair(name)).profile!;
  await f.approve(owner, p, scope);
  const credential = secret();
  f.hashes.add(digest(credential));
  await f.saveCleanupIdentity();
  const exchanged = success(
    await f.request(
      "exchange",
      {
        pairingId: p.pairingId,
        operationId: randomUUID(),
        credentialHash: digest(credential),
        confirmed: true,
      },
      p.proof,
    ),
  );
  p.credential = credential;
  p.deviceId = String(exchanged.deviceId);
  await f.saveCleanupIdentity();
  return { owner, p };
}
async function lifetime(f: DeviceFixture, p: DeviceProfile, credential: string) {
  const row = await f.stack.db.query(
    "select extract(epoch from (expires_at-created_at))::numeric seconds from device_binding_private.credentials where device_id=$1 and owner_user_id=$2 and hash=$3",
    [p.deviceId, p.ownerUserId, digest(credential)],
  );
  ensure(row.rowCount === 1, "Expected exactly the owned credential");
  return Number(row.rows[0].seconds);
}

test("should issue seven-day credentials and retain bounded rotation replay and immediate revocation", (context) =>
  deviceCase("seven-day-issuance", async (f) => {
    const { owner, p } = await registered(f, "seven-day");
    const previous = p.credential!;
    const issuedLifetime = await lifetime(f, p, previous);
    context.diagnostic(`Owned credential lifetime: ${issuedLifetime} seconds`);
    ensure(issuedLifetime === 604800, "New credentials must last exactly seven days");
    const candidate = secret();
    f.hashes.add(digest(candidate));
    await f.saveCleanupIdentity();
    const body = { operationId: randomUUID(), credentialHash: digest(candidate) };
    const rotation = success(await f.request("rotate", body, previous));
    ensure(
      (await lifetime(f, p, candidate)) === 604800,
      "Rotated credentials must last exactly seven days",
    );
    unauthorized(await f.request("heartbeat", {}, previous));
    success(await f.request("heartbeat", {}, candidate));
    const replay = success(await f.request("rotate", body, previous));
    ensure(
      replay.deviceId === rotation.deviceId && replay.expiresAt === rotation.expiresAt,
      "Same rotation must return the original receipt",
    );
    await f.stack.db.query(
      "update device_binding_private.devices set rotation_completed_at=clock_timestamp()-interval '121 seconds' where id=$1 and owner_user_id=$2 and rotation_operation=$3",
      [p.deviceId, p.ownerUserId, body.operationId],
    );
    unauthorized(await f.request("rotate", body, previous));
    success(await f.request("heartbeat", {}, candidate));
    success(await f.human(owner, "revoke", { deviceId: p.deviceId }));
    unauthorized(await f.request("heartbeat", {}, candidate));
    unauthorized(
      await f.request(
        "rotate",
        { operationId: randomUUID(), credentialHash: digest(secret()) },
        candidate,
      ),
    );
  }));

test("should preserve old credential evidence and function authority when the duration migration is repeated", () =>
  deviceCase("seven-day-preservation", async (f) => {
    const { p } = await registered(f, "preserved");
    await assertOwnedStack(f.stack.config);
    const migration = (
      await readFile("supabase/migrations/20261012001800-seven-day-device-credentials.sql", "utf8")
    )
      .replace(/^\s*begin;\s*/i, "")
      .replace(/\s*commit;\s*$/i, "");
    const authority = async () =>
      (
        await f.stack.db.query(
          "select oid,proowner,prolang,procost,prorows,prokind,prosecdef,proleakproof,proisstrict,proretset,provolatile,proparallel,pronargs,prorettype,proargtypes::text,proargnames,proargmodes,proconfig,proacl::text from pg_catalog.pg_proc where oid in ('device_binding_private.connector_010_runtime(text,jsonb,text)'::regprocedure,'device_binding_private.connector(text,jsonb,text)'::regprocedure) order by oid",
        )
      ).rows;
    const evidence = async () =>
      (
        await f.stack.db.query(
          "select jsonb_build_object('credential',to_jsonb(c),'device',to_jsonb(d)) evidence from device_binding_private.credentials c join device_binding_private.devices d on d.id=c.device_id where d.id=$1 and d.owner_user_id=$2 order by c.hash",
          [p.deviceId, p.ownerUserId],
        )
      ).rows;
    await f.stack.db.query("begin");
    try {
      await f.stack.db.query(
        "update device_binding_private.credentials set created_at=clock_timestamp()-interval '1 hour 1 second',expires_at=clock_timestamp()-interval '1 second',revoked_at=clock_timestamp() where device_id=$1 and owner_user_id=$2",
        [p.deviceId, p.ownerUserId],
      );
      const original = JSON.stringify(await evidence());
      const attributes = JSON.stringify(await authority());
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await f.stack.db.query(migration);
        ensure(
          JSON.stringify(await evidence()) === original,
          "Migration must preserve old expiry, revocation and device hashes",
        );
        ensure(
          JSON.stringify(await authority()) === attributes,
          "Migration must preserve function identity, authority and ACL",
        );
      }
    } finally {
      await f.stack.db.query("rollback");
    }
  }));

test("should reject credentials longer than seven days and keep expired evidence unusable", () =>
  deviceCase("seven-day-boundaries", async (f) => {
    const { p } = await registered(f, "boundaries");
    await f.stack.db.query("begin");
    try {
      await f.stack.db.query("savepoint duration_bound");
      let rejected = false;
      try {
        await f.stack.db.query(
          "update device_binding_private.credentials set expires_at=created_at+interval '7 days 1 second' where device_id=$1 and owner_user_id=$2",
          [p.deviceId, p.ownerUserId],
        );
      } catch (error) {
        rejected = (error as { code?: string }).code === "23514";
      }
      await f.stack.db.query("rollback to duration_bound");
      ensure(rejected, "Database must reject more than seven days");
      await f.stack.db.query(
        "update device_binding_private.credentials set created_at=clock_timestamp()-interval '1 hour 1 second',expires_at=clock_timestamp()-interval '1 second' where device_id=$1 and owner_user_id=$2",
        [p.deviceId, p.ownerUserId],
      );
      await f.stack.db.query("commit");
    } catch (error) {
      await f.stack.db.query("rollback");
      throw error;
    }
    unauthorized(await f.request("heartbeat", {}, p.credential));
    const key = secret();
    f.hashes.add(digest(key));
    await f.saveCleanupIdentity();
    unauthorized(
      await f.request(
        "rotate",
        { operationId: randomUUID(), credentialHash: digest(key) },
        p.credential,
      ),
    );
  }));

test("should preserve expired runtime evidence and recover with fresh approval at both registration limits", () =>
  deviceCase("recovery-at-limits", async (f) => {
    const owner = await f.stack.person("recovery-owner");
    const foreign = await f.stack.person("recovery-foreign");
    const observer = await f.stack.person("recovery-observer");
    const scope = await f.stack.bootstrap(owner);
    await f.stack.join(observer, await f.stack.invite(owner, scope.roomId, "observer"), "관찰자");
    const previousName = `web-${digest(randomUUID()).slice(0, 32)}`;
    const old = await f.register(await f.connected(owner, scope, previousName));
    const previous = new StateStore(join(f.root, "state"), previousName);
    const adapter = new OwnedFakeAdapter();
    await writeFile(
      join(f.root, "repository", "public-context.txt"),
      "Owned synthetic evidence.\n",
    );
    await ownedRunner(previous, old.agentId!, adapter, f.stack.config.app).prepare({
      choice: { model: "owned-synthetic", effort: "low" },
      files: ["public-context.txt"],
      handoff: "Read owned synthetic evidence only.",
      confirmed: true,
      autoQuestionsConfirmed: true,
    });
    await f.refresh(old);
    const healthy = await f.register(await f.connected(owner, scope, "healthy"));
    for (let index = 0; index < 8; index += 1) await f.connected(owner, scope, `idle-${index}`);
    const counts = async () => {
      const result = await f.stack.db.query(
        "select (select count(*)::int from device_binding_private.devices where owner_user_id=$1 and organization_id=$2 and state='active') devices,(select count(*)::int from device_binding_private.agents where owner_user_id=$1 and organization_id=$2 and room_id=$3 and state='active') agents",
        [owner.id, scope.organizationId, scope.roomId],
      );
      return result.rows[0];
    };
    const full = await counts();
    ensure(full.devices === 10 && full.agents === 2, "Owned scope must fill both limits");
    const overflow = (await f.apiPair("overflow")).profile!;
    await f.approve(owner, overflow, scope);
    const overflowKey = secret();
    f.hashes.add(digest(overflowKey));
    await f.saveCleanupIdentity();
    ensure(
      (
        await f.request(
          "exchange",
          {
            operationId: randomUUID(),
            credentialHash: digest(overflowKey),
            pairingId: overflow.pairingId,
            confirmed: true,
          },
          overflow.proof,
        )
      ).status === 429,
      "New registration must not bypass the device quota",
    );
    await previous.transaction(async () => {
      const state = await previous.read();
      ensure(state?.credential, "Owned registered state is required");
      const row = await f.stack.db.query(
        "update device_binding_private.credentials set expires_at=clock_timestamp()-interval '1 second' where device_id=$1 and owner_user_id=$2 and hash=$3 returning expires_at",
        [old.deviceId, owner.id, digest(state.credential)],
      );
      ensure(row.rowCount === 1, "Only the owned credential may be expired");
      state.credentialExpiresAt = (row.rows[0].expires_at as Date).toISOString();
      state.status = "disconnected";
      await previous.write(state);
    });
    unauthorized(await f.request("heartbeat", {}, old.credential));
    const originalProfile = await readFile(previous.file);
    const runtime = new RuntimeStore(previous.dir, previousName, old.agentId!);
    const originalRuntime = await readFile(runtime.file);
    const id = randomUUID();
    const name = `web-${createHash("sha256")
      .update(JSON.stringify(["connection-recovery", previousName, id]))
      .digest("hex")
      .slice(0, 32)}`;
    const next = new StateStore(previous.dir, name);
    const intent = { name, source: "cli" as const, server: f.stack.config.app };
    f.pairingIntents.set(name, intent);
    await f.saveCleanupIdentity();
    let beginCount = 0;
    let acknowledged = false;
    let confirmed = false;
    const notices: string[] = [];
    const connector = new Connector(
      next,
      new CentralClient(f.stack.config.app, async (url, options) => {
        const action = String(url).split("/").at(-1);
        const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
        if (action === "begin") {
          ensure(acknowledged, "Fresh pairing must wait for the owned revocation acknowledgement");
          beginCount += 1;
          Object.assign(intent, { codeHash: body.codeHash, proofHash: body.proofHash });
          f.hashes.add(String(body.codeHash));
          f.hashes.add(String(body.proofHash));
        }
        if (action === "exchange") f.hashes.add(String(body.credentialHash));
        await f.saveCleanupIdentity();
        return fetch(url, options);
      }),
    );
    let replacement: DeviceProfile | undefined;
    await prepareConnection(
      connector,
      {
        organizationId: scope.organizationId,
        roomId: scope.roomId,
        deviceAlias: "Recovered Mac",
        previousProfile: previousName,
        recoveryId: id,
      },
      {
        interactive: true,
        signal: new AbortController().signal,
        write: (message) => {
          notices.push(message);
        },
        confirmPreviousRevoked: async () => {
          ensure(
            beginCount === 0 && !(await next.read()),
            "No fresh pairing may precede this confirmation",
          );
          ensure(
            (await f.human(foreign, "revoke", { deviceId: old.deviceId })).status !== 200,
            "Foreign owners must not revoke the old device",
          );
          ensure(
            (await f.human(observer, "revoke", { deviceId: old.deviceId })).status !== 200,
            "Observers must not revoke the old device",
          );
          success(await f.human(owner, "revoke", { deviceId: old.deviceId }));
          const freed = await counts();
          ensure(
            freed.devices === 9 && freed.agents === 1,
            "Revocation must free only the selected owned registration",
          );
          acknowledged = true;
          return true;
        },
        open: async () => {
          const state = await next.read();
          ensure(
            state?.code && state.proof && state.pairingId,
            "Fresh pairing journal is required",
          );
          replacement = await f.captureCliPairing(name);
          ensure(
            (await f.human(observer, "approve", { code: state.code, ...scope, confirmed: true }))
              .status !== 200,
            "Observer approval must not authorize a fresh connection",
          );
          await f.approve(owner, replacement, scope);
        },
        confirm: async (approved) => {
          ensure(
            approved.organizationId === scope.organizationId && approved.roomId === scope.roomId,
            "Terminal confirmation must retain the selected scope",
          );
          confirmed = true;
          return true;
        },
      },
      (profile, agentId) => ownedRunner(profile, agentId, adapter, f.stack.config.app),
    );
    ensure(
      beginCount === 1 && acknowledged && confirmed && replacement,
      "Recovery requires exactly one fresh pairing and both explicit confirmations",
    );
    await f.refresh(replacement);
    await f.register(replacement);
    const freshAdapter = new OwnedFakeAdapter();
    await ownedRunner(next, replacement.agentId!, freshAdapter, f.stack.config.app).prepare({
      choice: { model: "owned-synthetic", effort: "low" },
      files: ["public-context.txt"],
      handoff: "Read the freshly approved synthetic evidence only.",
      confirmed: true,
      autoQuestionsConfirmed: true,
    });
    await f.refresh(replacement);
    const recovered = await counts();
    ensure(
      recovered.devices === 10 && recovered.agents === 2,
      "Both limits must remain unchanged after recovery",
    );
    ensure(
      (await readFile(previous.file)).equals(originalProfile) &&
        (await readFile(runtime.file)).equals(originalRuntime),
      "Original local evidence must remain byte-identical",
    );
    ensure(
      adapter.starts === 0 &&
        adapter.preparations === 1 &&
        freshAdapter.starts === 0 &&
        freshAdapter.preparations === 1,
      "Recovery must not submit a model input or prepare an old context again",
    );
    ensure(
      notices.join("").includes(old.deviceId!) && !notices.join("").includes(f.root),
      "Recovery guidance must identify the device without exposing a local path",
    );
    success(await f.request("heartbeat", {}, healthy.credential));
  }));

test(
  "should renew an idle product CLI connection and drain it on shutdown without AI setup",
  { timeout: 85000 },
  () =>
    deviceCase("idle-cli-renewal", async (f) => {
      const owner = await f.stack.person("idle-cli");
      const scope = await f.stack.bootstrap(owner);
      const p = await f.pair("idle-cli");
      await f.approve(owner, p, scope);
      await f.exchange(p);
      const store = new StateStore(join(f.root, "state"), p.name);
      const shorten = () =>
        store.transaction(async () => {
          const state = await store.read();
          ensure(
            state &&
              state.deviceId === p.deviceId &&
              state.mappings.length === 0 &&
              state.credential,
            "Idle CLI validation must remain an owned unconfigured profile",
          );
          const changed = await f.stack.db.query(
            "update device_binding_private.credentials set expires_at=clock_timestamp()+interval '4 minutes' where device_id=$1 and owner_user_id=$2 and hash=$3 and revoked_at is null returning expires_at",
            [p.deviceId, p.ownerUserId, digest(state.credential)],
          );
          ensure(changed.rowCount === 1, "Expected exactly one active owned credential");
          state.credentialExpiresAt = (changed.rows[0].expires_at as Date).toISOString();
          await store.write(state);
        });
      const changedCredential = async (previous: string) => {
        const deadline = performance.now() + 45000;
        while (performance.now() < deadline) {
          const state = await store.read();
          if (state?.credential && state.credential !== previous && !state.pending) {
            ensure(
              state.deviceId === p.deviceId && state.mappings.length === 0,
              "Automatic renewal must preserve the unconfigured device",
            );
            ensure(
              Date.parse(state.credentialExpiresAt ?? "") > Date.now() + 6 * 86400000,
              "The CLI must persist the issued seven-day credential",
            );
            await f.refresh(p);
            return state.credential;
          }
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        throw new Error("Owned idle CLI renewal did not finish");
      };
      await shorten();
      const previous = p.credential!;
      await f.saveCleanupIdentity();
      const child = spawn(
        process.execPath,
        [
          resolve("packages/local-connector/dist/src/cli.js"),
          "manage",
          "--state-dir",
          store.dir,
          "--profile",
          p.name,
          "--server",
          f.stack.config.app,
        ],
        { env: productEnvironment({ PATH: process.env.PATH, LANG: "C" }), stdio: "ignore" },
      );
      const exited = new Promise<number | null>((resolveExit) => {
        child.once("exit", resolveExit);
        child.once("error", () => resolveExit(-1));
      });
      try {
        const first = await changedCredential(previous);
        unauthorized(await f.request("heartbeat", {}, previous));
        success(await f.request("heartbeat", {}, first));
        const heartbeatBefore = await f.stack.db.query(
          "select last_seen_at from device_binding_private.devices where id=$1 and owner_user_id=$2",
          [p.deviceId, p.ownerUserId],
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 35000));
        const heartbeatAfter = await f.stack.db.query(
          "select last_seen_at from device_binding_private.devices where id=$1 and owner_user_id=$2",
          [p.deviceId, p.ownerUserId],
        );
        ensure(
          child.exitCode === null &&
            Number(heartbeatAfter.rows[0].last_seen_at) >
              Number(heartbeatBefore.rows[0].last_seen_at),
          "Idle CLI must continue its background heartbeat without AI setup",
        );
        await shorten();
        const second = await changedCredential(first);
        unauthorized(await f.request("heartbeat", {}, first));
        success(await f.request("heartbeat", {}, second));
        child.kill("SIGTERM");
        const code = await Promise.race([
          exited,
          new Promise<number>((resolveTimeout) => setTimeout(() => resolveTimeout(-1), 12000)),
        ]);
        ensure(code === 0, "Owned CLI must finish graceful shutdown");
        const final = await store.read();
        ensure(
          final?.status === "connected" && !final.pending && final.mappings.length === 0,
          "Shutdown must preserve the settled credential without AI registration",
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const settled = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 12000)),
        ]);
        if (!settled) {
          child.kill("SIGKILL");
          await exited;
          throw new Error("Owned CLI cleanup exceeded its bounded shutdown time");
        }
      }
    }),
);
