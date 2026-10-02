import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { CodexRuntime } from "../../src/codex-runtime.js";
import { ExperimentStore, type ManifestRepository } from "../../src/experiment-policy.js";
import * as cli from "../../src/cli.js";
import { StdioClient } from "../../src/stdio-client.js";

const mode = process.argv[2];
const manifestPath = process.env.TEST_MANIFEST!;
const fixturePath = process.env.TEST_FIXTURE!;
const tracePath = process.env.FAKE_TRACE_PATH!;
process.on("message", () => undefined);

function report(message: unknown): void {
  process.send?.(message);
}

async function command(expected: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const listener = (value: unknown) => {
      if (value === expected) {
        process.removeListener("message", listener);
        resolve();
      }
    };
    process.on("message", listener);
  });
}

function code(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "DRIVER_FAILED";
}

if (mode === "lock") {
  if (process.env.PAUSE_CREATION === "true") {
    const pause = () => {
      fs.writeFileSync(process.env.CREATION_MARKER!, "created", { mode: 0o600 });
      process.kill(process.pid, "SIGSTOP");
    };
    const originalOpen = fs.promises.open;
    fs.promises.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith("manifest.lock")) pause();
      return handle;
    };
    const originalOpenSync = fs.openSync;
    fs.openSync = ((...args: Parameters<typeof originalOpenSync>) => {
      const fd = originalOpenSync(...args);
      if (String(args[0]).endsWith("manifest-lock.sqlite")) pause();
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
  }
  const store = await ExperimentStore.openOwned(manifestPath);
  report("ready");
  await command("acquire");
  try {
    await store.withLock(async (manifest) => {
      if (process.env.MARK_ACTIVE === "true") {
        await store.save({ ...manifest, state: "RUNNING" });
      }
      report({ entered: manifest.state });
      await command("release");
    });
    report("released");
  } catch (error) {
    report({ error: code(error) });
  }
  process.disconnect?.();
} else {
  const scenario = process.env.TERMINAL_ON_CLOSE === "true" ? "terminalOnShutdown"
    : mode === "closedStdin" || mode === "unknownRequestClosedStdin" ? mode : "noTerminal";
  const runtime = new CodexRuntime((cwd) => {
    report("client-launched");
    const client = StdioClient.launchForTest({
      executable: process.execPath,
      args: [fixturePath, scenario],
      cwd,
      env: process.env,
      requestTimeoutMs: 500,
      closeTimeoutMs: 50,
    });
    if (mode === "closedStdin") {
      client.onEvent((event) => {
        if (event.kind === "item/started") {
          void client.request("test/write", { padding: "x".repeat(256 * 1024) }).catch(() => undefined);
        }
      });
    }
    return client;
  });
  const store = await ExperimentStore.openOwned(manifestPath);
  if (mode === "prep-lock" || mode === "prep-lock-never" || mode === "prep-resume-lock-never" || mode === "prep-intent" || mode === "prep-create" || mode === "prep-create-never") {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    process.once("SIGINT", () => {
      void runtime.shutdown().then(() => {
        report("shutdown-returned");
        if (!mode.endsWith("never")) release();
      }, () => { report("shutdown-rejected"); release(); });
    });
    const originalLock = store.withLock.bind(store);
    const repository: ManifestRepository = {
      manifestPath,
      withLock: async (operation) => {
        if (mode.includes("lock")) { report("preparing"); await gate; }
        return await originalLock(operation);
      },
      save: async (manifest) => {
        if (mode === "prep-intent" && manifest.state === "STARTING") { report("preparing"); await gate; }
        await store.save(manifest);
      },
    };
    if (mode.includes("lock")) store.withLock = repository.withLock;
    const output = mode === "prep-create" || mode === "prep-create-never"
      ? await cli.runCli(["run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api"], {
          runtime,
          createStore: async () => { report("preparing"); await gate; return store; },
        })
      : mode.includes("lock")
        ? await cli.runCli([
            mode.includes("resume") ? "resume" : "run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api",
            ...(mode.includes("resume") ? ["--resume-manifest", manifestPath] : []),
          ], { runtime, createStore: async () => store, openStore: async () => store })
        : await runtime.runNew(repository, { model: "synthetic-model", prompt: "synthetic", deadlineMs: 350, terminalWaitMs: 30 })
          .catch((error: unknown) => ({ error: code(error) }));
    report({ output });
    process.disconnect?.();
  } else if (mode === "sigint-wait" || mode === "sigint-save-gate") {
    if (mode === "sigint-save-gate") {
      const originalSave = store.save.bind(store);
      store.save = async (manifest) => {
        if (manifest.state === "UNKNOWN") {
          if (process.env.TERMINAL_GATE !== undefined) fs.writeFileSync(process.env.TERMINAL_GATE, "ready", { mode: 0o600 });
          report("saving-unknown");
          await command("persist");
        }
        await originalSave(manifest);
      };
    }
    process.argv = [process.execPath, "review-driver", "run", "--allow-model-call", "--model", "synthetic-model", "--account-route", "api"];
    report("signal-ready");
    await cli.main({ runtime, createStore: async () => store });
    process.disconnect?.();
  } else {
    const result = await runtime.runNew(store, {
      model: "synthetic-model", prompt: "synthetic", interruptAfterMs: 20, deadlineMs: 400, terminalWaitMs: 30,
    }).catch((error: unknown) => ({ error: code(error) }));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.disconnect?.();
  }
}
