import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fsPromises, {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  stat,
  symlink,
  chmod,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { StateStore, type ConnectorState } from "../src/state-store.ts";
import { CentralClient, serviceOrigin } from "../src/central-client.ts";
import { Connector, hash, main } from "../src/cli.ts";
import {
  canonicalRoot,
  workspaceBody,
  agentBody,
  gitMetadata,
} from "../src/workspace-registration.ts";
import { ConnectionError, type Body } from "../src/contracts.ts";
import { runnerFixture } from "./runner-fixture.ts";
import { CodexAdapter } from "../src/codex-adapter.ts";
import { RuntimeStore } from "../src/runtime-store.ts";
import { RuntimeError, digest, stableJson } from "../src/runtime-contracts.ts";
async function temporary(run: (root: string) => Promise<void>) {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, "device-unit-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function connected(server: string): ConnectorState {
  return {
    version: 1,
    server,
    status: "connected",
    credential: randomBytes(32).toString("hex"),
    credentialExpiresAt: new Date(Date.now() + 3600000).toISOString(),
    deviceId: randomUUID(),
    mappings: [],
  };
}
test("should store connector secrets atomically with private ownership", () =>
  temporary(async (root) => {
    const store = new StateStore(join(root, "state"), "one");
    const value = connected("http://127.0.0.1:1234");
    await store.locked(() => store.write(value));
    assert.equal((await stat(store.dir)).mode & 0o777, 0o700);
    assert.equal((await stat(store.file)).mode & 0o777, 0o600);
    assert.deepEqual(await store.read(), value);
    await store.locked(async () => {
      await assert.rejects(
        () => new StateStore(store.dir, "one").locked(async () => {}),
        ConnectionError,
      );
    });
    await writeFile(join(store.dir, ".one-interrupted.tmp"), "partial", { mode: 0o600 });
    assert.deepEqual(await store.read(), value);
    const filesBefore = (await readdir(store.dir)).sort(),
      candidate = connected(value.server),
      injected = new Error("Synthetic atomic rename failure");
    let middleFailures = 0;
    const renameMock = mock.method(
      fsPromises,
      "rename",
      async (
        source: Parameters<typeof fsPromises.rename>[0],
        target: Parameters<typeof fsPromises.rename>[1],
      ) => {
        assert.equal(target, store.file);
        assert.equal((await stat(source)).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(await readFile(source, "utf8")), candidate);
        middleFailures++;
        throw injected;
      },
    );
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        () => store.locked(() => store.write(candidate)),
        (error: unknown) => error === injected,
      );
    } finally {
      renameMock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(middleFailures, 1);
    assert.deepEqual(await store.read(), value);
    assert.deepEqual((await readdir(store.dir)).sort(), filesBefore);
    await store.locked(() => store.write(candidate));
    assert.deepEqual(await store.read(), candidate);
    assert.deepEqual((await readdir(store.dir)).sort(), filesBefore);
    await store.locked(() => store.write(value));
    const actualUid = process.getuid!();
    const ownerMock = mock.method(
      process as NodeJS.Process & { getuid: () => number },
      "getuid",
      () => actualUid + 1,
    );
    try {
      await assert.rejects(() => store.read(), ConnectionError);
    } finally {
      ownerMock.mock.restore();
    }
    await chmod(store.file, 0o644);
    await assert.rejects(() => store.read(), ConnectionError);
    await chmod(store.file, 0o600);
    const linked = new StateStore(store.dir, "linked");
    await symlink(store.file, linked.file);
    await assert.rejects(() => linked.read(), ConnectionError);
    await assert.rejects(() => linked.write(value), ConnectionError);
    await writeFile(join(store.dir, "one.lock"), "2147483647", { mode: 0o600 });
    await store.locked(async () => {
      assert.deepEqual(await store.read(), value);
    });
    await writeFile(join(store.dir, "one.lock"), "2147483647", { mode: 0o600 });
    const outcomes = await Promise.allSettled([
      store.locked(() => new Promise<void>((r) => setTimeout(r, 20))),
      new StateStore(store.dir, "one").locked(() => new Promise<void>((r) => setTimeout(r, 20))),
    ]);
    assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
    const unsafe = join(root, "unsafe");
    await mkdir(unsafe, { mode: 0o755 });
    await chmod(unsafe, 0o755);
    await assert.rejects(() => new StateStore(unsafe, "one").read(), ConnectionError);
  }));
test("should recover saved pairing and rotation operations after a response is lost", () =>
  temporary(async (root) => {
    const requests: { action: string; body: Body; authorization?: string }[] = [];
    const receipts = new Map<string, Record<string, unknown>>();
    const lost = new Set(["exchange", "rotate", "workspace", "agent", "replace"]);
    const pairingId = randomUUID(),
      deviceId = randomUUID(),
      workspaceId = randomUUID(),
      agentId = randomUUID(),
      roomId = randomUUID();
    const fetchMock = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body;
      const action = url.split("/").at(-1)!;
      requests.push({
        action,
        body,
        authorization: new Headers(init.headers).get("authorization") ?? undefined,
      });
      const key = action + String(body.operationId);
      let data = receipts.get(key);
      if (!data) {
        if (action === "begin")
          data = { protocol: 1, pairingId, expiresAt: new Date(Date.now() + 300000).toISOString() };
        else if (action === "pairing-status")
          data = {
            protocol: 1,
            pairingId,
            state: "approved",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            scope: {
              ownerAlias: "owner",
              organizationId: randomUUID(),
              organizationName: "group",
              roomId,
              roomTitle: "room",
              deviceAlias: "laptop",
            },
          };
        else if (action === "exchange" || action === "rotate")
          data = { protocol: 1, deviceId, expiresAt: new Date(Date.now() + 3600000).toISOString() };
        else if (action === "workspace") data = { protocol: 1, workspaceId };
        else
          data = {
            protocol: 1,
            workspaceId,
            agentId,
            bindingEpoch: action === "replace" ? 2 : 1,
            state: "registered",
            verification: "unverified",
          };
        receipts.set(key, data);
      }
      if (lost.delete(action)) throw new TypeError("Synthetic response lost");
      return Response.json({ ok: true, data });
    });
    try {
      const origin = "http://127.0.0.1:1234";
      const dir = join(root, "state");
      const store = new StateStore(dir, "one");
      const restart = () => new Connector(new StateStore(dir, "one"), new CentralClient(origin));
      await store.locked(() => restart().pair("laptop"));
      await store.locked(() => restart().status());
      await assert.rejects(() => store.locked(() => restart().exchange(roomId)), ConnectionError);
      const exchange = await store.read();
      assert.equal(exchange?.pending?.action, "exchange");
      assert.equal(exchange?.credential, undefined);
      assert.equal(
        (await store.locked(() => restart().status())).recovery,
        "retry the same command",
      );
      await store.locked(() => restart().exchange(roomId));
      const initial = await store.read();
      assert.equal(initial?.credential, exchange?.pending?.candidateCredential);
      await assert.rejects(() => store.locked(() => restart().rotate()), ConnectionError);
      const pendingRotate = await store.read();
      assert.equal(pendingRotate?.credential, initial?.credential);
      assert.equal(
        (await store.locked(() => restart().status())).recovery,
        "retry the same command",
      );
      await store.locked(() => restart().rotate());
      assert.equal((await store.read())?.credential, pendingRotate?.pending?.candidateCredential);
      const localRoot = join(root, "repository");
      await mkdir(localRoot);
      const input = {
        root: localRoot,
        nativeSessionId: "private-native-unit",
        repositoryAlias: "repository",
        sessionAlias: "session",
        confirmed: true,
      };
      await assert.rejects(() => store.locked(() => restart().register(input)), ConnectionError);
      assert.equal((await store.read())?.mappings.length, 0);
      assert.equal(
        (await store.locked(() => restart().status())).recovery,
        "retry the same command",
      );
      await assert.rejects(() => store.locked(() => restart().register(input)), ConnectionError);
      assert.equal((await store.read())?.pending?.action, "agent");
      assert.equal(
        (await store.locked(() => restart().status())).recovery,
        "retry the same command",
      );
      await store.locked(() => restart().register(input));
      const saved = await store.read();
      assert.equal(saved?.mappings.length, 1);
      const replacement = {
        ...input,
        agentId,
        sessionAlias: "new session",
        nativeSessionId: "private-new-native-unit",
      };
      await assert.rejects(
        () => store.locked(() => restart().replace(replacement)),
        ConnectionError,
      );
      const candidate = await store.read();
      assert.equal(candidate?.mappings[0].nativeSessionId, input.nativeSessionId);
      assert.equal(candidate?.pending?.candidate?.nativeSessionId, replacement.nativeSessionId);
      assert.equal(
        (await store.locked(() => restart().status())).recovery,
        "retry the same command",
      );
      await assert.rejects(() => store.locked(() => restart().rotate()), ConnectionError);
      await store.locked(() => restart().replace(replacement));
      assert.equal((await store.read())?.mappings[0].nativeSessionId, replacement.nativeSessionId);
      assert.equal((await store.read())?.mappings[0].bindingEpoch, 2);
      for (const action of ["exchange", "rotate", "workspace", "agent", "replace"]) {
        const calls = requests.filter((r) => r.action === action);
        assert.equal(calls.length, 2);
        assert.deepEqual(calls[0], calls[1]);
      }
      const publicRequests = JSON.stringify(requests.map((r) => r.body));
      assert.ok(
        !publicRequests.includes(localRoot) && !publicRequests.includes(input.nativeSessionId),
      );
    } finally {
      fetchMock.mock.restore();
    }
    const begins: Body[] = [],
      committed = new Set<string>();
    let loseBegin = true;
    const beginMock = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.ok(url.endsWith("/api/connector/begin"));
      const body = JSON.parse(String(init.body)) as Body;
      begins.push(body);
      if (committed.has(String(body.codeHash)))
        return Response.json({ ok: false, error: { code: "CONFLICT" } }, { status: 409 });
      committed.add(String(body.codeHash));
      if (loseBegin) {
        loseBegin = false;
        throw new TypeError("Synthetic begin response lost after commit");
      }
      return Response.json({
        ok: true,
        data: {
          protocol: 1,
          pairingId: randomUUID(),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        },
      });
    });
    try {
      const store = new StateStore(join(root, "state"), "lost-begin"),
        restart = () => new Connector(store, new CentralClient("http://127.0.0.1:1234"));
      await assert.rejects(() => store.locked(() => restart().pair("laptop")), ConnectionError);
      const uncertain = await store.read();
      assert.equal(uncertain?.pending?.action, "begin");
      assert.match(
        String((await store.locked(() => restart().status())).recovery),
        /revoke-local.*fresh approval/,
      );
      await assert.rejects(
        () => store.locked(() => restart().pair("laptop")),
        (error: unknown) => error instanceof ConnectionError && error.code === "CONFLICT",
      );
      const disconnected = await store.read();
      assert.equal(disconnected?.status, "disconnected");
      assert.equal(disconnected?.code, uncertain?.code);
      assert.equal(disconnected?.proof, uncertain?.proof);
      assert.deepEqual(begins[1], begins[0]);
      assert.match(
        String((await store.locked(() => restart().status())).recovery),
        /revoke-local.*fresh approval/,
      );
      assert.equal(begins.length, 2);
      await store.locked(() => store.remove());
      const fresh = await store.locked(() => restart().pair("laptop"));
      assert.equal(fresh.state, "pairing");
      assert.notEqual(begins[2].codeHash, begins[0].codeHash);
      assert.notEqual(begins[2].proofHash, begins[0].proofHash);
      assert.equal((await new StateStore(store.dir, "one").read())?.status, "connected");
    } finally {
      beginMock.mock.restore();
    }
  }));
async function isolatedLocalRevoke(
  f: Awaited<ReturnType<typeof runnerFixture>>,
  run: (invoke: () => Promise<void>) => Promise<void>,
) {
  let network = 0,
    provider = 0;
  const fetchMock = mock.method(globalThis, "fetch", async () => {
    network++;
    throw new Error("SYNTHETIC_NETWORK_DENIED");
  });
  const providerMocks = [
    "capabilities",
    "prepare",
    "validate",
    "execute",
    "observe",
    "interrupt",
    "close",
  ].map((method) =>
    mock.method(CodexAdapter.prototype, method as "close", async () => {
      provider++;
      throw new RuntimeError("PROVIDER_UNAVAILABLE");
    }),
  );
  const stdoutMock = mock.method(process.stdout, "write", () => true);
  try {
    await run(() => main(["revoke-local", "--state-dir", f.stateDir, "--profile", "one"]));
    assert.equal(network, 0);
    assert.equal(provider, 0);
  } finally {
    stdoutMock.mock.restore();
    for (const handle of providerMocks) handle.mock.restore();
    fetchMock.mock.restore();
  }
}
async function resolvedRevokeFixture() {
  const f = await runnerFixture();
  f.queue();
  assert.equal((await f.runner().run({ once: true })).state, "UPLOADED");
  return f;
}
function pendingReady(agentId: string, state: "PENDING" | "TRANSMITTED" = "PENDING") {
  const operationId = randomUUID(),
    body = { protocol: 1, operationId, agentId, bindingEpoch: 1, reportedReady: false };
  return {
    operationId,
    action: "ready" as const,
    body,
    payloadHash: digest(stableJson({ action: "ready", body })),
    state,
    result: null,
  };
}
test(
  "should preserve exact local evidence on unresolved pending preparation and foreign ownership revoke refusals",
  { timeout: 15000 },
  async () => {
    for (const reason of [
      "UNKNOWN",
      "PENDING",
      "TRANSMITTED",
      "preparation",
      "pending-rotation",
      "device",
      "organization",
      "room",
      "agent",
      "origin",
      "epoch",
      "root",
      "native",
    ]) {
      const f = await resolvedRevokeFixture();
      try {
        const state = (await f.profile.read())!;
        state.status = "disconnected";
        state.credentialExpiresAt = new Date(Date.now() - 1000).toISOString();
        if (reason === "UNKNOWN") {
          f.queue();
          f.adapter.executeHook = async () => {
            throw new RuntimeError("UNKNOWN");
          };
          await f.runner().run({ once: true });
        }
        if (["PENDING", "TRANSMITTED", "preparation"].includes(reason)) {
          const saved = (await f.store.read())!;
          saved.ready = false;
          if (reason === "preparation")
            saved.preparation = {
              operationId: randomUUID(),
              previousEpoch: 1,
              generation: randomUUID(),
              settings: saved.settings!,
              candidate: null,
              state: "PROVIDER_PENDING",
            };
          else
            saved.operations.push(
              pendingReady(f.scope.agentId, reason as "PENDING" | "TRANSMITTED"),
            );
          await f.store.write(saved);
        }
        if (reason === "pending-rotation")
          state.pending = {
            action: "rotate",
            body: { operationId: randomUUID(), credentialHash: "b".repeat(64) },
            secret: "SYNTHETIC_PENDING",
            payloadHash: "a".repeat(64),
          };
        if (reason === "device") state.deviceId = randomUUID();
        if (reason === "organization") state.scope!.organizationId = randomUUID();
        if (reason === "room") state.scope!.roomId = randomUUID();
        if (reason === "agent") state.mappings[0].agentId = randomUUID();
        if (reason === "origin") state.server = "http://127.0.0.1:8888";
        if (reason === "epoch") state.mappings[0].bindingEpoch = 2;
        if (reason === "root") state.mappings[0].root = "SYNTHETIC_FOREIGN_ROOT";
        if (reason === "native") state.mappings[0].nativeSessionId = "SYNTHETIC_FOREIGN_SESSION";
        await f.profile.transaction(() => f.profile.write(state));
        const profile = await readFile(f.profile.file),
          runtime = await readFile(f.store.file);
        const code = [
          "UNKNOWN",
          "PENDING",
          "TRANSMITTED",
          "preparation",
          "pending-rotation",
        ].includes(reason)
          ? "RUNTIME_BUSY"
          : "AUTHORITY_LOST";
        await isolatedLocalRevoke(f, async (invoke) => {
          await assert.rejects(invoke, { code });
        });
        assert.deepEqual(await readFile(f.profile.file), profile);
        assert.deepEqual(await readFile(f.store.file), runtime);
      } finally {
        await f.close();
      }
    }
  },
);
test("should refuse local CLI revocation while an owned binding or native session is locked", async () => {
  for (const kind of ["binding", "session"]) {
    const f = await resolvedRevokeFixture();
    try {
      const profile = await readFile(f.profile.file),
        runtime = await readFile(f.store.file);
      const refused = () =>
        isolatedLocalRevoke(f, async (invoke) => {
          await assert.rejects(invoke, { code: "RUNTIME_BUSY" });
        });
      if (kind === "binding") await f.store.locked(refused);
      else await f.store.sessionLocked(f.context.threadId, refused);
      assert.deepEqual(await readFile(f.profile.file), profile);
      assert.deepEqual(await readFile(f.store.file), runtime);
    } finally {
      await f.close();
    }
  }
});
test("should validate every local agent before deleting any resolved runtime or its profile", async () => {
  for (const kind of ["unresolved", "busy", "resolved"]) {
    const f = await resolvedRevokeFixture();
    try {
      const agentId = "ffffffff-ffff-4fff-8fff-ffffffffffff",
        other = new RuntimeStore(f.stateDir, "one", agentId);
      assert.ok(f.scope.agentId < agentId);
      const value = {
        ...structuredClone(f.record),
        scope: { ...f.scope, agentId },
        context: {
          ...structuredClone(f.context),
          threadId: randomUUID(),
          generation: randomUUID(),
        },
      };
      if (kind === "unresolved") value.operations.push(pendingReady(agentId));
      await other.write(value);
      const state = (await f.profile.read())!;
      state.status = "disconnected";
      state.mappings.push({
        ...state.mappings[0],
        agentId,
        nativeSessionId: value.context.threadId,
      });
      await f.profile.transaction(() => f.profile.write(state));
      const profile = await readFile(f.profile.file),
        first = await readFile(f.store.file),
        second = await readFile(other.file);
      const attempt = () =>
        isolatedLocalRevoke(f, async (invoke) => {
          if (kind === "resolved") await invoke();
          else await assert.rejects(invoke, { code: "RUNTIME_BUSY" });
        });
      if (kind === "busy") await other.locked(attempt);
      else await attempt();
      if (kind === "resolved") {
        assert.equal(await f.profile.read(), undefined);
        assert.equal(await f.store.read(), undefined);
        assert.equal(await other.read(), undefined);
      } else {
        assert.deepEqual(await readFile(f.profile.file), profile);
        assert.deepEqual(await readFile(f.store.file), first);
        assert.deepEqual(await readFile(other.file), second);
      }
    } finally {
      await f.close();
    }
  }
});
for (const kind of ["expired", "disconnected", "revoked"]) {
  test(
    `should locally revoke resolved ${kind} profiles and permit fresh pairing initialization`,
    { timeout: 15000 },
    async () => {
      const f = await runnerFixture();
      try {
        f.queue();
        assert.equal((await f.runner().run({ once: true })).state, "UPLOADED");
        const value = (await f.profile.read())!;
        if (kind === "expired")
          value.credentialExpiresAt = new Date(Date.now() - 1000).toISOString();
        else value.status = "disconnected";
        if (kind === "revoked") {
          delete value.credential;
          delete value.credentialExpiresAt;
        }
        await f.profile.transaction(() => f.profile.write(value));
        const other = new StateStore(f.stateDir, "unrelated");
        await other.transaction(() => other.write(connected(value.server)));
        const otherBytes = await readFile(other.file);
        let network = 0,
          provider = 0,
          pairing = false;
        const output: string[] = [];
        const fetchMock = mock.method(globalThis, "fetch", async (url: string) => {
          network++;
          assert.equal(pairing, true);
          assert.ok(String(url).endsWith("/api/connector/begin"));
          return Response.json({
            ok: true,
            data: {
              protocol: 1,
              pairingId: randomUUID(),
              expiresAt: new Date(Date.now() + 300000).toISOString(),
            },
          });
        });
        const closeMock = mock.method(CodexAdapter.prototype, "close", async () => {
          provider++;
        });
        const providerMocks = [
          "capabilities",
          "prepare",
          "validate",
          "execute",
          "observe",
          "interrupt",
        ].map((method) =>
          mock.method(CodexAdapter.prototype, method as "close", async () => {
            provider++;
            throw new RuntimeError("PROVIDER_UNAVAILABLE");
          }),
        );
        const stdoutMock = mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
          output.push(String(chunk));
          return true;
        });
        try {
          await main(["revoke-local", "--state-dir", f.stateDir, "--profile", "one"]);
          assert.equal(network, 0);
          assert.equal(provider, 0);
          assert.deepEqual(JSON.parse(output[0]), { state: "removed", scope: "local profile" });
          assert.equal(await f.profile.read(), undefined);
          assert.equal(await f.store.read(), undefined);
          assert.deepEqual(await readFile(other.file), otherBytes);
          pairing = true;
          await main([
            "pair",
            "--server",
            value.server,
            "--state-dir",
            f.stateDir,
            "--profile",
            "one",
            "--device-alias",
            "Synthetic fresh device",
          ]);
          const fresh = (await f.profile.read())!;
          assert.equal(fresh.status, "pairing");
          assert.equal(fresh.credential, undefined);
          assert.deepEqual(fresh.mappings, []);
          assert.equal(network, 1);
          assert.equal(provider, 0);
        } finally {
          stdoutMock.mock.restore();
          closeMock.mock.restore();
          for (const handle of providerMocks) handle.mock.restore();
          fetchMock.mock.restore();
        }
      } finally {
        await f.close();
      }
    },
  );
}
test("should reject unsafe service origins redirects and unsupported protocol versions", async () => {
  for (const input of [
    "http://remote.invalid",
    "file:///tmp/file",
    "https://user:pass@safe.invalid",
    "https://safe.invalid/path",
    "http://127.0.0.1:1234/",
  ])
    assert.throws(() => serviceOrigin(input), ConnectionError);
  assert.equal(serviceOrigin("https://safe.invalid"), "https://safe.invalid");
  assert.equal(serviceOrigin("http://127.0.0.1:1234"), "http://127.0.0.1:1234");
  let mode = "redirect";
  const fetchMock = mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (mode === "redirect") throw new TypeError("Synthetic redirect refused");
    return Response.json({
      ok: true,
      data: {
        protocol: mode === "version" ? 2 : 1,
        pairingId: randomUUID(),
        expiresAt: new Date().toISOString(),
        ...(mode === "unknown" ? { privateRoot: "synthetic" } : {}),
      },
    });
  });
  try {
    const client = new CentralClient("http://127.0.0.1:1234");
    const body = { codeHash: hash("a"), proofHash: hash("b"), deviceAlias: "laptop", protocol: 1 };
    for (mode of ["redirect", "version", "unknown"])
      await assert.rejects(() => client.call("begin", body), ConnectionError);
    await assert.rejects(() => client.call("begin", { ...body, protocol: 2 }), ConnectionError);
  } finally {
    fetchMock.mock.restore();
  }
});
test("should build public registration metadata without serializing local state", () =>
  temporary(async (root) => {
    const metadata = {
      repositoryAlias: "repository",
      branch: "feature/device",
      commit: "a".repeat(40),
      dirty: "unknown" as const,
      root,
      nativeSessionId: "private-native",
      credential: "private-credential",
    };
    const body = workspaceBody(randomUUID(), metadata);
    assert.deepEqual(Object.keys(body).sort(), [
      "branch",
      "commit",
      "dirty",
      "operationId",
      "repositoryAlias",
    ]);
    assert.ok(!JSON.stringify(body).includes(root));
    const agent = agentBody(randomUUID(), randomUUID(), {
      sessionAlias: "session",
      runtime: "codex",
    });
    assert.deepEqual(Object.keys(agent).sort(), [
      "operationId",
      "runtime",
      "sessionAlias",
      "workspaceId",
    ]);
    const git = await gitMetadata(root);
    assert.deepEqual(git, { branch: "unknown", commit: "unknown", dirty: "unknown" });
    for (const repositoryAlias of [
      root,
      "https://private.invalid",
      "a".repeat(64),
      randomUUID(),
      "../repo",
    ])
      assert.throws(
        () => workspaceBody(randomUUID(), { ...metadata, repositoryAlias }),
        ConnectionError,
      );
  }));
test("should reject protected roots and preserve independent local profiles", () =>
  temporary(async (root) => {
    const home = join(root, "home"),
      repository = join(home, "repository"),
      claude = join(home, ".claude"),
      nested = join(claude, "projects");
    await mkdir(repository, { recursive: true });
    await mkdir(join(home, ".codex"));
    await mkdir(nested, { recursive: true });
    const prefixed = join(claude, "..cache");
    await mkdir(prefixed);
    const link = join(root, "repository-link"),
      protectedLink = join(root, "settings-link");
    await symlink(repository, link);
    await symlink(claude, protectedLink);
    const homeMock = mock.method(os, "homedir", () => home);
    syncBuiltinESMExports();
    try {
      assert.equal(await canonicalRoot(repository), await realpath(repository));
      assert.equal(await canonicalRoot(link), await realpath(repository));
      for (const input of [
        "/",
        home,
        root,
        join(home, ".codex"),
        claude,
        nested,
        prefixed,
        protectedLink,
      ])
        await assert.rejects(
          () => canonicalRoot(input),
          (error: unknown) => error instanceof ConnectionError && error.code === "FORBIDDEN",
        );
      await assert.rejects(
        () => canonicalRoot(join(root, "missing")),
        (error: unknown) => error instanceof ConnectionError && error.code === "INVALID_BODY",
      );
      const external = join(root, "external"),
        normal = join(external, "repository");
      await mkdir(normal, { recursive: true });
      for (const settings of [
        ".claude",
        ".codex",
        ".agents",
        ".ssh",
        ".aws",
        ".config",
        "Library",
      ]) {
        const target = join(external, settings),
          child = join(target, "nested"),
          prefixedChild = join(target, "..cache");
        await mkdir(child, { recursive: true });
        await mkdir(prefixedChild);
        await rm(join(home, settings), { recursive: true, force: true });
        await symlink(target, join(home, settings));
        assert.equal(await canonicalRoot(repository), await realpath(repository));
        assert.equal(await canonicalRoot(normal), await realpath(normal));
        for (const input of [
          target,
          child,
          prefixedChild,
          external,
          join(home, settings),
          join(home, settings, "..cache"),
        ])
          await assert.rejects(
            () => canonicalRoot(input),
            (error: unknown) => error instanceof ConnectionError && error.code === "FORBIDDEN",
          );
      }
      const originalRealpath = fsPromises.realpath;
      for (const code of ["EACCES", "EIO", "ELOOP"]) {
        const metadataMock = mock.method(
          fsPromises,
          "realpath",
          async (path: Parameters<typeof fsPromises.realpath>[0]) => {
            if (path === join(home, ".aws"))
              throw Object.assign(new Error("Synthetic protected metadata failure"), { code });
            return originalRealpath(path);
          },
        );
        syncBuiltinESMExports();
        try {
          await assert.rejects(
            () => canonicalRoot(normal),
            (error: unknown) => error instanceof ConnectionError && error.code === "FORBIDDEN",
          );
        } finally {
          metadataMock.mock.restore();
          syncBuiltinESMExports();
        }
        assert.equal(await canonicalRoot(normal), await originalRealpath(normal));
      }
    } finally {
      homeMock.mock.restore();
      syncBuiltinESMExports();
    }
    const a = new StateStore(join(root, "state"), "a"),
      b = new StateStore(a.dir, "b");
    await a.locked(() => a.write(connected("https://safe.invalid")));
    await b.locked(() => b.write(connected("https://safe.invalid")));
    const before = await readFile(b.file, "utf8");
    await a.locked(() => a.remove());
    assert.equal(await readFile(b.file, "utf8"), before);
    assert.equal(await a.read(), undefined);
    const execute = promisify(execFile);
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const output = await execute(
      process.execPath,
      [cli, "revoke-local", "--state-dir", a.dir, "--profile", "a"],
      {
        env: { PATH: process.env.PATH, LANG: "C", TMPDIR: process.env.TMPDIR },
        timeout: 10000,
        maxBuffer: 4096,
      },
    );
    assert.deepEqual(JSON.parse(output.stdout), { state: "removed", scope: "local profile" });
    assert.ok(!output.stdout.includes(a.dir));
    assert.equal(await readFile(b.file, "utf8"), before);
  }));
