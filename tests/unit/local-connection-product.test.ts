import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StateStore } from "../../packages/local-connector/src/state-store.ts";
import { Connector } from "../../packages/local-connector/src/cli.ts";
import { CentralClient } from "../../packages/local-connector/src/central-client.ts";
import { SettingsStore } from "../../packages/local-connector/src/settings/store.ts";
import type { Operation } from "../../packages/local-connector/src/settings/contracts.ts";
import {
  localConnectionCommand,
  readConnectionSelection,
  nextConnectionSelection,
} from "../../src/features/device-binding/local-connection-command.ts";

test(
  "should reconnect generated commands through the real bootstrap and CLI after unexecuted generations",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "connection-product-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "packages/local-connector/src"), { recursive: true, mode: 0o700 });
    await mkdir(join(root, "scripts"), { mode: 0o700 });
    await cp(
      resolve("scripts/local-connection-bootstrap.sh"),
      join(root, "scripts/local-connection-bootstrap.sh"),
    );
    const opener = join(root, "fixture-open");
    await writeFile(opener, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const build = (await import(pathToFileURL(resolve("scripts/build-local-connection.mjs")).href))
      .buildLocalConnection;
    const manifest = await build({
      root,
      compiler: async (_root: string, out: string) => {
        await cp(
          fileURLToPath(new URL("../../packages/local-connector/src", import.meta.url)),
          join(out, "src"),
          { recursive: true },
        );
        const entry = join(out, "src/cli/connect-command.js"),
          code = await readFile(entry, "utf8");
        assert.ok(code.includes('"/usr/bin/open"'));
        await writeFile(entry, code.replace('"/usr/bin/open"', JSON.stringify(opener)));
      },
    });
    const organizationId = randomUUID(),
      roomId = randomUUID(),
      userId = randomUUID(),
      deviceId = randomUUID(),
      pairingId = randomUUID();
    const scope = {
      organizationId,
      roomId,
      ownerAlias: "검증 사용자",
      organizationName: "합성 조직",
      roomTitle: "합성 방",
      deviceAlias: "검증 Mac",
    };
    const calls: string[] = [];
    let operation: Operation | null = null;
    let rejectSettingsPoll = false;
    let stop: () => void = () => {};
    const date = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    const server = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url?.startsWith("/local-connection/")) {
          const body = await readFile(join(root, "public", req.url));
          res.writeHead(200);
          res.end(body);
          return;
        }
        const action = req.url?.split("/").at(-1);
        for await (const part of req) void part;
        calls.push(req.url!);
        let data: Record<string, unknown> = { protocol: 1 };
        if (req.url === "/api/runtime-settings/poll") {
          if (rejectSettingsPoll) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: { code: "UNAUTHENTICATED" } }));
            setTimeout(() => stop(), 150);
            return;
          }
          data = {
            ...data,
            deviceId,
            configRevision: 0,
            catalog: null,
            operation,
            applied: null,
            current: false,
            currentBinding: null,
          };
          setTimeout(() => stop(), 150);
        } else if (action === "begin") data = { ...data, pairingId, expiresAt: date(300) };
        else if (action === "pairing-status")
          data = { ...data, pairingId, expiresAt: date(300), state: "approved", scope };
        else if (action === "exchange") data = { ...data, deviceId, expiresAt: date(604800) };
        else if (action === "bindings") data = { ...data, bindings: [] };
        else if (action === "heartbeat")
          data = { ...data, state: "registered", verification: "unverified", lastSeenAt: date(0) };
        else throw new Error("Unexpected fixture request");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, data }));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const kind of [
      "unfinished-plain",
      "unfinished-lineage",
      "first",
      "valid",
      "expired",
      "disconnected-future-intermediate",
      "auth-failure",
    ] as const) {
      const home = join(root, kind),
        work = join(home, "work");
      await mkdir(work, { recursive: true, mode: 0o700 });
      let selection = await readConnectionSelection(null, origin, userId, roomId);
      for (let n = 0; n < (kind === "unfinished-plain" ? 0 : 3); n++)
        selection = await nextConnectionSelection(selection, randomUUID());
      const original = new Connector(
        new StateStore(
          join(home, "Library/Application Support/ai-collab/connector"),
          kind === "disconnected-future-intermediate"
            ? selection.chain[0].profile
            : selection.baseProfile,
        ),
        new CentralClient(origin),
      ).store;
      if (kind !== "first")
        await original.write({
          version: 1,
          server: origin,
          status: kind === "disconnected-future-intermediate" ? "disconnected" : "connected",
          deviceId: kind === "valid" || kind.startsWith("unfinished-") ? deviceId : randomUUID(),
          credential: "a".repeat(64),
          credentialExpiresAt: date(kind === "expired" ? -3600 : 604800),
          scope,
          mappings: [],
        });
      const settings = new SettingsStore(original);
      operation = null;
      rejectSettingsPoll = kind === "auth-failure";
      if (kind.startsWith("unfinished-")) {
        const operationId = randomUUID();
        operation = {
          operationId,
          deviceId,
          expectedConfigRevision: 0,
          state: "LOCAL_CONFIRMATION",
          requested: { operationId, deviceId, expectedConfigRevision: 0, runtime: "codex" },
          receipt: null,
        };
        await settings.write({
          version: 1,
          server: origin,
          deviceId,
          organizationId,
          roomId,
          current: null,
          retained: [],
          journal: {
            operation,
            phase: "LOCAL_CONFIRMATION",
            generation: randomUUID(),
            localRootReference: randomUUID(),
            root: null,
            settings: null,
            context: null,
            receipt: null,
            reason: null,
          },
        });
      }
      const command = await localConnectionCommand({
        origin,
        userId,
        roomId,
        organizationId,
        deviceAlias: scope.deviceAlias,
        manifest,
        selection,
      });
      for (let retry = 0; retry < 2; retry++) {
        const before = await original.read(),
          bytes = before ? await readFile(original.file) : undefined,
          settingsBytes = operation ? await readFile(settings.file) : undefined,
          start = calls.length;
        const child = spawn(
          "/usr/bin/python3",
          [resolve("tests/helpers/local-connection-pty.py")],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        const environment = {
          ...process.env,
          HOME: home,
          TMPDIR: work,
          PATH: `${join(process.execPath, "..")}:/usr/bin:/bin`,
        };
        // This child's synthetic home isolates every default CLI path from personal records.
        child.stdin.write(JSON.stringify({ command, environment }) + "\n");
        stop = () => {
          if (child.stdin.writable) child.stdin.write("stop\n");
        };
        let output = "",
          errors = "";
        child.stdout.on("data", (b) => (output += b));
        child.stderr.on("data", (b) => (errors += b));
        const code = await new Promise<number | null>((done, reject) => {
          child.on("exit", done);
          child.on("error", reject);
        });
        assert.equal(code, 0, errors);
        const result = JSON.parse(output);
        assert.equal(result.exitCode, 0, result.output);
        assert.ok(calls.slice(start).includes("/api/runtime-settings/poll"), result.output);
        if (kind === "auth-failure") {
          assert.match(result.output, /서버.*인증.*거부/);
          assert.match(result.output, /웹.*연결.*확인/);
          assert.ok(result.output.includes(`${origin}/app/connections?room=${roomId}`));
          assert.ok(!result.output.includes("준비 완료"));
          assert.equal((await original.read())!.status, "connected");
          assert.equal(await settings.read(), undefined);
        } else if (kind.startsWith("unfinished-")) {
          assert.match(result.output, /모델.*effort.*적용/);
        } else {
          assert.match(result.output, /AI.*폴더/);
        }
        if (kind === "disconnected-future-intermediate" && retry === 0) {
          assert.ok(result.output.includes("revoked를 입력하세요:"));
          assert.ok(calls.slice(start).some((path) => path.endsWith("/begin")));
          assert.ok(calls.slice(start).some((path) => path.endsWith("/exchange")));
        }
        if (kind === "valid" || kind.startsWith("unfinished-") || retry)
          assert.ok(
            !calls
              .slice(start)
              .some((path) => path.endsWith("/begin") || path.endsWith("/exchange")),
          );
        if (kind !== "first" && bytes) assert.deepEqual(await readFile(original.file), bytes);
        if (settingsBytes) {
          assert.deepEqual(await readFile(settings.file), settingsBytes);
          assert.deepEqual(
            calls.slice(start).filter((path) => path !== "/api/connector/heartbeat"),
            ["/api/connector/bindings", "/api/runtime-settings/poll"],
          );
          assert.equal((await original.read())!.mappings.length, 0);
          assert.equal((await settings.read())!.current, null);
        }
        assert.deepEqual(await readdir(work), []);
      }
      const selected =
        kind === "expired" || kind === "disconnected-future-intermediate"
          ? new StateStore(original.dir, selection.chain.at(-1)!.profile)
          : original;
      assert.equal((await selected.read())?.status, "connected");
    }
  },
);
