import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../src/runtime-contracts.ts";
import { sourcePackets, publishSource } from "../src/workflow/source-publisher.ts";
import type { SourceConfirmation } from "../src/workflow/source-contracts.ts";
const id = "00000000-0000-4000-8000-000000000001";
const identity = { agentId: id, bindingEpoch: 1, requestId: id, attemptId: id, fence: 1 };
test("should slice raw bytes deterministically across UTF8 boundaries and preserve replay addresses", () => {
  for (const size of [8191, 8192, 8193, 4194304]) {
    const bytes = Buffer.alloc(size, 0x80),
      packets = sourcePackets(identity, bytes, digest(bytes));
    assert.equal(packets.length, Math.ceil(size / 8192));
    assert.deepEqual(
      Buffer.concat(
        packets.map((p) =>
          Buffer.from(JSON.parse(String(p.body.packetJson)).bytesBase64, "base64"),
        ),
      ),
      bytes,
    );
    assert.deepEqual(sourcePackets(identity, bytes, digest(bytes)), packets);
    assert.equal(
      sourcePackets(identity, Buffer.alloc(size, 0x81), digest(Buffer.alloc(size, 0x81)))[0].body
        .operationId,
      packets[0].body.operationId,
    );
  }
  assert.throws(() => sourcePackets(identity, Buffer.alloc(4194305), digest("x")));
});
test("should distinguish immutable packet ACKs from read-only whole confirmation", async () => {
  const bytes = Buffer.alloc(8193, 97),
    hash = digest(bytes),
    packets = sourcePackets(identity, bytes, hash),
    uploaded: number[] = [];
  let confirmed = false,
    queries = 0;
  const call = async (action: string, body: Record<string, unknown>) => {
    if (action === "source-confirm") {
      queries++;
      return {
        version: 2,
        ...identity,
        manifestHash: hash,
        state: confirmed ? "CONFIRMED" : "PARTIAL",
        count: 2,
        totalBytes: 8193,
        nextMissingIndex: confirmed ? 2 : 1,
      } satisfies SourceConfirmation;
    }
    const p = JSON.parse(String(body.packetJson));
    uploaded.push(p.index);
    confirmed = true;
    return {
      version: 2,
      ...identity,
      manifestHash: hash,
      operationId: body.operationId,
      index: p.index,
      chunkHash: p.chunkHash,
    };
  };
  assert.equal(await publishSource(identity, bytes, hash, call, () => {}), "CONFIRMED");
  assert.deepEqual(uploaded, [1]);
  assert.equal(queries, 2);
  await publishSource(identity, bytes, hash, call, () => {});
  assert.equal(uploaded.length, 1);
  const bad = async (action: string, body: Record<string, unknown>) =>
    action === "source-confirm"
      ? {
          version: 2,
          ...identity,
          manifestHash: hash,
          state: "PARTIAL",
          count: 2,
          totalBytes: 8193,
          nextMissingIndex: 1,
        }
      : { ...(await call(action, body)), index: 0 };
  await assert.rejects(publishSource(identity, bytes, hash, bad, () => {}));
  assert.equal(packets[0].body.protocol, 1);
});

test("should join split multibyte UTF8 and require final confirmation after replayed partial ACKs", async () => {
  const text = "a".repeat(8191) + "😀界é",
    bytes = Buffer.from(text),
    hash = digest(bytes),
    packets = sourcePackets(identity, bytes, hash);
  assert.equal(Buffer.from(packets[0].packet.bytesBase64, "base64").at(-1), 0xf0);
  assert.equal(
    Buffer.concat(packets.map((p) => Buffer.from(p.packet.bytesBase64, "base64"))).toString("utf8"),
    text,
  );
  let queries = 0,
    uploads = 0;
  await assert.rejects(
    publishSource(
      identity,
      bytes,
      hash,
      async (action, body) => {
        if (action === "source-confirm") {
          queries++;
          return {
            version: 2,
            ...identity,
            manifestHash: hash,
            state: "PARTIAL",
            count: packets.length,
            totalBytes: bytes.length,
            nextMissingIndex: 1,
          };
        }
        uploads++;
        const packet = JSON.parse(String(body.packetJson));
        return {
          version: 2,
          ...identity,
          manifestHash: hash,
          operationId: body.operationId,
          index: packet.index,
          chunkHash: packet.chunkHash,
        };
      },
      () => {},
    ),
    { code: "UNKNOWN" },
  );
  assert.equal(queries, 2);
  assert.equal(uploads, 1);
});

for (const state of ["CONFIRMED", "NO_TARGET_SNAPSHOT"] as const) {
  test(`should allocate no upload chunks when the initial confirmation is ${state}`, async (t) => {
    const bytes = Buffer.alloc(4194304, 97),
      hash = digest(bytes),
      subarray = Buffer.prototype.subarray;
    let sliced = 0,
      calls = 0;
    t.mock.method(
      Buffer.prototype,
      "subarray",
      function (this: Buffer, ...args: Parameters<Buffer["subarray"]>) {
        if (this.length === bytes.length) sliced++;
        return subarray.apply(this, args);
      },
    );
    assert.equal(
      await publishSource(
        identity,
        bytes,
        hash,
        async (action) => {
          assert.equal(action, "source-confirm");
          assert.equal(sliced, 0);
          calls++;
          return {
            version: 2,
            ...identity,
            manifestHash: hash,
            state,
            count: state === "CONFIRMED" ? 512 : null,
            totalBytes: state === "CONFIRMED" ? bytes.length : null,
            nextMissingIndex: state === "CONFIRMED" ? 512 : 0,
          };
        },
        () => {},
      ),
      state,
    );
    assert.equal(calls, 1);
    assert.equal(sliced, 0);
  });
}

test("should construct only the missing packet after confirmation and retain the original bytes", async (t) => {
  const bytes = Buffer.alloc(4194304, 97),
    hash = digest(bytes),
    subarray = Buffer.prototype.subarray;
  let sliced = 0,
    queries = 0;
  const indexes: number[] = [];
  t.mock.method(
    Buffer.prototype,
    "subarray",
    function (this: Buffer, ...args: Parameters<Buffer["subarray"]>) {
      if (this.length === bytes.length) sliced++;
      return subarray.apply(this, args);
    },
  );
  assert.equal(
    await publishSource(
      identity,
      bytes,
      hash,
      async (action, body) => {
        if (action === "source-confirm") {
          queries++;
          if (queries === 1) {
            assert.equal(sliced, 0);
            bytes.fill(98);
          }
          return {
            version: 2,
            ...identity,
            manifestHash: hash,
            state: queries === 1 ? "PARTIAL" : "CONFIRMED",
            count: 512,
            totalBytes: bytes.length,
            nextMissingIndex: queries === 1 ? 511 : 512,
          };
        }
        const packet = JSON.parse(String(body.packetJson));
        indexes.push(packet.index);
        assert.deepEqual(Buffer.from(packet.bytesBase64, "base64"), Buffer.alloc(8192, 97));
        return {
          version: 2,
          ...identity,
          manifestHash: hash,
          operationId: body.operationId,
          index: packet.index,
          chunkHash: packet.chunkHash,
        };
      },
      () => {},
    ),
    "CONFIRMED",
  );
  assert.deepEqual(indexes, [511]);
  assert.equal(sliced, 1);
  assert.equal(queries, 2);
});

test("should reject invalid original bytes before the first confirmation", async () => {
  let calls = 0;
  await assert.rejects(
    publishSource(
      identity,
      Buffer.from("x"),
      digest("y"),
      async () => {
        calls++;
      },
      () => {},
    ),
    { code: "INVALID_RUNTIME" },
  );
  assert.equal(calls, 0);
});
