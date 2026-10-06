import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowClient } from "../src/workflow-client.ts";
test("should restrict workflow transport and preserve fixed error boundaries", async () => {
  for (const url of [
    "http://external.example",
    "https://safe.example/path",
    "https://u:p@safe.example",
    "https://safe.example?key=x",
  ])
    assert.throws(() => new WorkflowClient(url), { code: "INVALID_BODY" });
  for (const url of [
    "https://safe.example",
    "http://127.0.0.1:4318",
    "http://[::1]:4318",
    "http://localhost:4318",
  ])
    assert.equal(new WorkflowClient(url).origin, url);
  const prior = globalThis.fetch;
  const body = { protocol: 1, agentId: "00000000-0000-4000-8000-000000000001", bindingEpoch: 1 };
  const client = new WorkflowClient("http://127.0.0.1:4318");
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      calls++;
      assert.equal(String(input), "http://127.0.0.1:4318/api/workflow/poll");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${"a".repeat(64)}`);
      throw new Error("provider secret native-session");
    };
    await assert.rejects(client.call("poll", body, "a".repeat(64)), { message: "UNAVAILABLE" });
    assert.equal(calls, 1);
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, error: { code: "CONFLICT" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    await assert.rejects(client.call("poll", body, "a".repeat(64)), { code: "CONFLICT" });
    for (const response of [
      new Response(JSON.stringify({ ok: false, error: { code: "CONFLICT", message: "secret" } }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ ok: true, data: { nativeSession: "secret" } }), {
        headers: { "Content-Type": "application/json" },
      }),
      new Response("a".repeat(65537), { headers: { "Content-Type": "application/json" } }),
      new Response(null, { status: 302, headers: { Location: "http://external.example" } }),
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(client.call("poll", body, "a".repeat(64)), { code: "UNAVAILABLE" });
    }
    await assert.rejects(client.call("poll", { ...body, rawPrompt: "bad" }, "a".repeat(64)), {
      code: "INVALID_BODY",
    });
  } finally {
    globalThis.fetch = prior;
  }
});

test("should enforce source response bytes before JSON parsing while preserving legacy response limits", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    body = { protocol: 1, agentId: id, bindingEpoch: 1 },
    data = { version: 2, agentId: id, bindingEpoch: 1 };
  const envelope = JSON.stringify({ ok: true, data });
  let responseText = envelope + " ".repeat(16385 - Buffer.byteLength(envelope)),
    cancelled = false;
  const client = new WorkflowClient(
    "http://127.0.0.1:4318",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from(responseText));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await assert.rejects(client.call("source-support", body, "a".repeat(64)), {
    code: "UNAVAILABLE",
  });
  void cancelled;
  const finite = new WorkflowClient(
    "http://127.0.0.1:4318",
    async () =>
      new Response(responseText, {
        status: responseText.startsWith('{"ok":false') ? 409 : 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  responseText = envelope + " ".repeat(16384 - Buffer.byteLength(envelope));
  assert.deepEqual(await finite.call("source-support", body, "a".repeat(64)), data);
  responseText = JSON.stringify({ ok: false, error: { code: "CONFLICT" } }).padEnd(65536, " ");
  await assert.rejects(finite.call("poll", body, "a".repeat(64)), { code: "CONFLICT" });
  responseText += " ";
  await assert.rejects(finite.call("poll", body, "a".repeat(64)), { code: "UNAVAILABLE" });
});

test("should apply the same raw source limit to upload confirmation and cancel an oversized open stream", async () => {
  const id = "00000000-0000-4000-8000-000000000001",
    hash = "a".repeat(64),
    identity = { agentId: id, bindingEpoch: 1, requestId: id, attemptId: id, fence: 1 };
  const cases: [
    import("../src/workflow-contracts.ts").DeviceAction,
    import("../src/workflow-contracts.ts").Body,
    unknown,
  ][] = [
    [
      "source-confirm",
      { protocol: 1, ...identity, manifestHash: hash },
      {
        version: 2,
        ...identity,
        manifestHash: hash,
        state: "ABSENT",
        count: null,
        totalBytes: null,
        nextMissingIndex: 0,
      },
    ],
    [
      "source-upload",
      {
        protocol: 1,
        ...identity,
        operationId: id,
        packetJson: JSON.stringify({
          version: 2,
          index: 0,
          count: 1,
          totalBytes: 1,
          manifestHash: hash,
          chunkHash: hash,
          bytesBase64: "YQ==",
        }),
      },
      { version: 2, ...identity, manifestHash: hash, operationId: id, index: 0, chunkHash: hash },
    ],
  ];
  for (const [action, body, data] of cases) {
    const envelope = JSON.stringify({ ok: true, data });
    let bytes = Buffer.from(envelope.padEnd(16384, " ")),
      cancelled = false;
    const finite = new WorkflowClient(
      "http://127.0.0.1:4318",
      async () => new Response(bytes, { headers: { "Content-Type": "application/json" } }),
    );
    assert.deepEqual(await finite.call(action, body, "a".repeat(64)), data);
    bytes = Buffer.from(envelope.padEnd(16385, " "));
    const stream = new WorkflowClient(
      "http://127.0.0.1:4318",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    await assert.rejects(stream.call(action, body, "a".repeat(64)), { code: "UNAVAILABLE" });
    assert.equal(cancelled, true);
  }
});
