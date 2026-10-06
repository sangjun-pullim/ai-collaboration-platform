import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeTransport } from "../src/claude/transport.ts";
import { RuntimeError } from "../src/runtime-contracts.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const child = `
import { createInterface } from "node:readline";
const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
process.stderr.write("credential=synthetic-private-secret\\n");
lines.on("line", line => {
  const frame = JSON.parse(line);
  if (mode === "invalid") { process.stdout.write(Buffer.from([255, 10])); return; }
  if (mode === "oversized") { process.stdout.write("x".repeat(1025)); return; }
  if (mode === "held") return;
  if (mode === "message") {
    process.stdout.write(JSON.stringify({type:"assistant",value:"owned"}) + "\\n"); return;
  }
  process.stdout.write(JSON.stringify({type:"control_response",response:{
    subtype: mode === "discriminator" ? "invalid" : "success",
    request_id: frame.request_id, response:{echo:frame.request}
  }}) + "\\n");
});
`;
async function fixture(
  mode: string,
  run: (
    transport: ClaudeTransport,
    failed: ReturnType<typeof deferred<RuntimeError>>,
  ) => Promise<void>,
  options: ConstructorParameters<typeof ClaudeTransport>[2] = {},
) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "claude-transport-unit-"));
  const script = join(directory, "stdio.mjs");
  await writeFile(script, child, { mode: 0o600 });
  const failed = deferred<RuntimeError>();
  const transport = new ClaudeTransport(
    { executable: process.execPath, args: [script, mode], cwd: directory, env: { LANG: "C" } },
    () => {},
    { probeMs: 5000, requestMs: 3000, closeMs: [20, 250, 250], ...options },
  );
  transport.setHandler(async () => {}, failed.resolve);
  try {
    await run(transport, failed);
  } finally {
    await transport.close();
    await rm(directory, { recursive: true, force: true });
  }
}
test("should match control responses and reap the owned stdio child", () =>
  fixture("echo", async (transport) => {
    const request = { subtype: "initialize", sdkMcpServers: ["owned"] };
    assert.deepEqual(await transport.request(request), { echo: request });
    assert.equal(transport.pendingCount, 0);
    assert.deepEqual(await transport.close(), { reaped: true, code: "REAPED" });
  }));
test("should reject malformed UTF8 without exposing private stderr", () =>
  fixture("invalid", async (transport, failed) => {
    await assert.rejects(transport.request({ subtype: "initialize" }), { code: "UNKNOWN" });
    const error = await failed.promise;
    assert.equal(error.message, "UNKNOWN");
    assert.equal(error.message.includes("synthetic-private-secret"), false);
    assert.equal((await transport.close()).code, "REAPED");
  }));
test("should bound an unterminated stdout frame", () =>
  fixture(
    "oversized",
    async (transport, failed) => {
      await assert.rejects(transport.request({ subtype: "initialize" }), {
        code: "RUNTIME_CAPACITY",
      });
      assert.equal((await failed.promise).code, "RUNTIME_CAPACITY");
    },
    { lineBytes: 1024 },
  ));
test("should reject a foreign control discriminator while keeping every request rejectable", () =>
  fixture("discriminator", async (transport, failed) => {
    await assert.rejects(transport.request({ subtype: "initialize" }), { code: "UNKNOWN" });
    assert.equal((await failed.promise).code, "UNKNOWN");
    assert.equal(transport.pendingCount, 0);
  }));
test("should abort held requests and close without a new native input", () =>
  fixture("held", async (transport) => {
    const request = transport.request({ subtype: "initialize" });
    const rejected = assert.rejects(request, { code: "UNKNOWN" });
    assert.equal((await transport.close()).code, "REAPED");
    await rejected;
    assert.equal(transport.pendingCount, 0);
  }));
test("should abort and drain an owned message handler before releasing cleanup", () =>
  fixture("message", async (transport) => {
    const entered = deferred<void>(),
      exited = deferred<void>();
    transport.setHandler(
      async (_frame, signal) => {
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        exited.resolve();
      },
      () => {},
    );
    await transport.write({ type: "user", content: "synthetic only" });
    await entered.promise;
    assert.equal((await transport.close()).code, "REAPED");
    await exited.promise;
  }));
