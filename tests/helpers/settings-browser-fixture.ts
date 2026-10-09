import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WorkflowFixture } from "./workflow-fixture.js";
import { ClaudeProductFixture } from "./claude-product-fixture.js";
import { secret } from "./device-binding-fixture.js";
import { assertOwnedStack, ensure, productEnvironment } from "./local-access-stack.js";
import { authBrowserChildEnvironment } from "./auth-browser-artifact-policy.js";

type Input = Record<string, unknown>;
function exact(input: Input, keys: string[]) {
  ensure(
    input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      Object.keys(input).length === keys.length &&
      keys.every((key) => Object.hasOwn(input, key)),
    "Unknown settings broker fields",
  );
}
/** The parent retains private DB/Auth credentials; the child receives only product env and broker access. */
export async function runSettingsBrowserParent() {
  const workflow = await WorkflowFixture.open("settings-browser"),
    token = secret();
  const fixtures = new Map<string, ClaudeProductFixture>();
  const sceneNames = new Set<string>();
  const actionCounts = new Map<string, number>();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    const supplied = req.headers.authorization?.slice(7) ?? "";
    if (
      req.method !== "POST" ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(token) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      await assertOwnedStack(workflow.stack.config);
      let raw = "";
      for await (const part of req) {
        raw += part.toString();
        ensure(Buffer.byteLength(raw) <= 4096, "Broker input exceeds limit");
      }
      const input = JSON.parse(raw) as Input;
      let data: unknown;
      if (req.url === "/setup") {
        exact(input, ["viewport", "scenario"]);
        ensure(
          ["desktop", "mobile"].includes(String(input.viewport)) &&
            ["answer", "cancel", "stale", "automatic"].includes(String(input.scenario)),
          "Unknown fixed browser scene",
        );
        const sceneName = `${input.viewport}-${input.scenario}`;
        ensure(!sceneNames.has(sceneName) && sceneNames.size < 8, "Browser scene already reserved");
        sceneNames.add(sceneName);
        const id = randomUUID(),
          fixture = await ClaudeProductFixture.open(workflow, `browser-${fixtures.size}`);
        fixture.modelDisplayName = "Synthetic model name";
        if (input.scenario === "automatic") fixture.readMode = "AUTO_CODE";
        fixtures.set(id, fixture);
        fixture.suppressRunner = true;
        data = {
          id,
          roomId: fixture.scene.scope.roomId,
          deviceId: fixture.scene.responder.deviceId,
          owner: { id: fixture.scene.owner.id, displayName: fixture.scene.owner.displayName },
          requester: {
            id: fixture.scene.requester.id,
            displayName: fixture.scene.requester.displayName,
          },
        };
      } else {
        const fixture = fixtures.get(String(input.scene));
        ensure(fixture, "Unknown owned settings scene");
        if (req.url === "/code") {
          exact(input, ["scene", "actor"]);
          ensure(input.actor === "owner" || input.actor === "requester", "Unknown browser actor");
          data = workflow.stack.entryForBrowser(fixture.scene[input.actor]);
        } else if (req.url === "/record-intent") {
          exact(input, ["scene", "actor", "action", "operationId", "deviceId"]);
          ensure(input.actor === "owner" || input.actor === "requester", "Unknown browser actor");
          ensure(
            input.deviceId === fixture.scene.responder.deviceId &&
              typeof input.operationId === "string" &&
              /^[0-9a-f-]{36}$/.test(input.operationId),
            "Unowned browser operation",
          );
          ensure(
            input.actor === "requester"
              ? input.action === "ask"
              : ["select-folder", "select-runtime", "apply", "cancel"].includes(
                  String(input.action),
                ),
            "Unknown browser operation",
          );
          ensure(fixture.settingsOperations.length < 100, "Owned browser operation limit");
          await fixture.recordSettings(
            String(input.action),
            { operationId: input.operationId },
            fixture.scene[input.actor].id,
          );
          data = {};
        } else {
          exact(input, ["scene"]);
          const limits: Record<string, number> = {
            "/drive-folder": 1,
            "/drive-cancel": 1,
            "/drive-apply": 1,
            "/drive-ready": 1,
            "/drive-question": 2,
            "/stale-capability": 1,
          };
          const limit = limits[req.url ?? ""];
          ensure(limit, "Unknown settings broker action");
          const countKey = `${input.scene}:${req.url}`,
            count = actionCounts.get(countKey) ?? 0;
          ensure(count < limit, "Owned browser action limit");
          actionCounts.set(countKey, count + 1);
          if (req.url === "/drive-folder" || req.url === "/drive-cancel") {
            const status = await fixture.driveFolder();
            data = { state: status.state, ready: status.ready };
          } else if (req.url === "/drive-apply") {
            const status = await fixture.driveApply();
            data = {
              state: status.state,
              ready: status.ready,
              agentId: fixture.scene.responder.agentId,
            };
          } else if (req.url === "/drive-ready" || req.url === "/drive-question") {
            await workflow.devices.refresh(fixture.scene.responder);
            await workflow.history(fixture.scene, fixture.scene.requester);
            const status = await fixture.run();
            fixture.assertRequesterWithoutAI();
            data = {
              state: status.state,
              ready: status.ready,
              agentId: fixture.scene.responder.agentId,
              inputs: fixture.inputs.length,
            };
          } else if (req.url === "/stale-capability") {
            const current = fixture.settings.accepted(
              await fixture.human(fixture.scene.owner, "list", {
                deviceId: fixture.scene.responder.deviceId!,
              }),
            );
            ensure(
              current.operation?.state === "LOCAL_CONFIRMATION" && current.catalog,
              "No owned catalog to change",
            );
            const catalog = { ...current.catalog, snapshotHash: "0".repeat(64) };
            // A changed, invalid hash is sent through the real endpoint; it must be rejected.
            await fixture.recordSettings(
              "receipt",
              { operationId: current.operation.operationId },
              fixture.scene.responder.deviceId!,
            );
            const rejected = await fixture.settings.device(fixture.scene.responder, "receipt", {
              ...current.operation.receipt,
              catalog,
            });
            data = { status: rejected.status };
          } else throw new Error("Unknown settings broker action");
        }
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch {
      res
        .writeHead(500)
        .end('{"error":"Owned settings broker action failed; private diagnostics withheld"}');
    }
  });
  const failures: Error[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const child = spawn(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.settings.config.ts"],
      {
        env: {
          ...productEnvironment(),
          ...authBrowserChildEnvironment,
          LOCAL_SETTINGS_FIXTURE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          LOCAL_SETTINGS_FIXTURE_TOKEN: token,
        },
        stdio: "inherit",
      },
    );
    process.exitCode = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const fixture of fixtures.values())
      try {
        await fixture.close();
      } catch {
        failures.push(new Error("Owned settings browser runtime cleanup failed"));
      }
    try {
      await workflow.close();
    } catch {
      failures.push(new Error("Owned settings browser stack cleanup failed"));
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      "Owned settings browser cleanup failed; private diagnostics withheld",
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensure(
    process.argv.length === 3 && process.argv[2] === "--settings-e2e-runner",
    "Settings browser helper requires its fixed runner argument",
  );
  await runSettingsBrowserParent();
}
