import test from "node:test";
import assert from "node:assert/strict";
import { readJsonBody } from "../../src/lib/http/read-json-body.ts";
import { AccessError } from "../../src/features/room-access/contracts.ts";
import { ConnectionError } from "../../src/features/device-binding/contracts.ts";
import { WorkflowError } from "../../src/features/investigation-coordinator/contracts.ts";

const origin = "https://collaboration.example";
type Options = Parameters<typeof readJsonBody>[1];
const strict: Options = { error: (code) => new AccessError(code), utf8: "strict" };
const replacement: Options = { error: (code) => new ConnectionError(code), utf8: "replacement" };

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let position = 0;
  const events: string[] = [];
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        events.push("pull");
        if (position === chunks.length) controller.close();
        else controller.enqueue(chunks[position++]);
      },
      cancel() {
        events.push("cancel");
      },
    },
    { highWaterMark: 0 },
  );
  const request = new Request(origin, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof Request>[1]);
  return { request, stream, events, consumed: () => position };
}

function json(value: unknown, headers: Record<string, string> = {}) {
  return streamed([Buffer.from(JSON.stringify(value))], headers);
}

function split(bytes: Uint8Array, size: number) {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size)
    chunks.push(bytes.subarray(offset, offset + size));
  return chunks;
}

function accessError(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AccessError);
    assert.equal(error.code, code);
    return true;
  };
}

function injected(reader: {
  read: () => Promise<{ done: boolean; value?: Uint8Array }>;
  cancel: () => Promise<void>;
  releaseLock: () => void;
}) {
  return {
    headers: new Headers({ "content-type": "application/json" }),
    body: { getReader: () => reader },
  } as unknown as Request;
}

test("should enforce optional origin before content type and body access", async () => {
  for (const suppliedOrigin of [null, "https://other.example", `${origin}/`]) {
    const reads: string[] = [];
    const request = {
      headers: {
        get(name: string) {
          reads.push(name);
          assert.equal(name, "origin");
          return suppliedOrigin;
        },
      },
      get body() {
        return assert.fail("Rejected origins must not access body");
      },
    } as unknown as Request;
    await assert.rejects(
      readJsonBody(request, { ...strict, expectedOrigin: origin }),
      accessError("UNSAFE_ORIGIN"),
    );
    assert.deepEqual(reads, ["origin"]);
  }
  const accepted = json({ ok: true }, { origin });
  assert.deepEqual(await readJsonBody(accepted.request, { ...strict, expectedOrigin: origin }), {
    ok: true,
  });
  assert.equal(accepted.stream.locked, false);
  for (const suppliedOrigin of [undefined, "https://other.example"]) {
    const input = json(
      { ok: true },
      suppliedOrigin === undefined ? {} : { origin: suppliedOrigin },
    );
    const get = input.request.headers.get.bind(input.request.headers);
    const inspected = {
      headers: {
        get(name: string) {
          assert.notEqual(name, "origin");
          return get(name);
        },
      },
      body: input.request.body,
    } as unknown as Request;
    assert.deepEqual(await readJsonBody(inspected, strict), { ok: true });
  }
  await assert.rejects(
    readJsonBody(json({}).request, { ...strict, expectedOrigin: "" }),
    accessError("UNSAFE_ORIGIN"),
  );
});

test("should reject non-JSON content types before acquiring the reader", async () => {
  for (const type of [
    null,
    "text/plain",
    "application/problem+json",
    "application/json, text/plain",
  ]) {
    const request = {
      headers: { get: () => type },
      get body() {
        return assert.fail("Rejected content types must not acquire the reader");
      },
    } as unknown as Request;
    await assert.rejects(readJsonBody(request, strict), accessError("INVALID_BODY"));
  }
  for (const type of [
    "application/json",
    "Application/JSON ; charset=utf-8",
    "application/json; charset=latin1",
  ]) {
    assert.deepEqual(
      await readJsonBody(json({ value: "한" }, { "content-type": type }).request, strict),
      { value: "한" },
    );
  }
  await assert.rejects(
    readJsonBody(
      new Request(origin, { method: "POST", headers: { "content-type": "application/json" } }),
      strict,
    ),
    accessError("INVALID_BODY"),
  );
});

test("should bound actual streamed bytes at sixteen kibibytes", async () => {
  const bytes = Buffer.from(JSON.stringify("x".repeat(16382)));
  assert.equal(bytes.byteLength, 16384);
  for (const contentLength of ["1", "16385", "999999", "invalid"]) {
    const input = streamed(split(bytes, 31), { "content-length": contentLength });
    assert.equal(await readJsonBody(input.request, strict), "x".repeat(16382));
    assert.equal(input.stream.locked, false);
    assert.equal(input.events.includes("cancel"), false);
  }
  for (const chunks of [[Buffer.concat([bytes, Buffer.from(" ")])], [bytes, Buffer.from(" ")]]) {
    const input = streamed([...chunks, Buffer.from("unread")], { "content-length": "1" });
    await assert.rejects(readJsonBody(input.request, strict), accessError("BODY_TOO_LARGE"));
    assert.equal(input.consumed(), chunks.length);
    assert.equal(input.events.filter((event) => event === "cancel").length, 1);
    assert.equal(input.stream.locked, false);
  }
  const malformedOverflow = streamed([Buffer.alloc(16385, 0xff)]);
  await assert.rejects(
    readJsonBody(malformedOverflow.request, strict),
    accessError("BODY_TOO_LARGE"),
  );
  assert.equal(malformedOverflow.stream.locked, false);
});

test("should count byte views and multibyte text by received bytes", async () => {
  const backing = Buffer.alloc(18000);
  backing.write("{}", 100);
  assert.deepEqual(await readJsonBody(streamed([backing.subarray(100, 102)]).request, strict), {});
  const bytes = Buffer.from(JSON.stringify("😀".repeat(4095)) + "  ");
  assert.equal(bytes.byteLength, 16384);
  assert.equal(await readJsonBody(streamed(split(bytes, 3)).request, strict), "😀".repeat(4095));
  const tooLarge = streamed(split(Buffer.concat([bytes, Buffer.from(" ")]), 3));
  await assert.rejects(readJsonBody(tooLarge.request, strict), accessError("BODY_TOO_LARGE"));
  assert.equal(tooLarge.stream.locked, false);
});

test("should preserve strict and replacement UTF-8 policies across chunk boundaries", async () => {
  const value = { text: "한글😀é" };
  const bytes = Buffer.from(JSON.stringify(value));
  for (const options of [strict, replacement]) {
    for (const size of [1, 2, 3, 5]) {
      const input = streamed(split(bytes, size));
      assert.deepEqual(await readJsonBody(input.request, options), value);
      assert.equal(input.stream.locked, false);
    }
  }
  const emptyChunks = streamed([
    Buffer.alloc(0),
    bytes.subarray(0, 5),
    Buffer.alloc(0),
    bytes.subarray(5),
  ]);
  assert.deepEqual(await readJsonBody(emptyChunks.request, strict), value);
});

test("should retain fatal decoding and replacement characters for invalid UTF-8", async () => {
  for (const [invalidBytes, expected] of [
    [[0xff], "�"],
    [[0xc3, 0x28], "�("],
    [[0xe2, 0x82], "�"],
    [[0xed, 0xa0, 0x80], "���"],
    [[0xf4, 0x90, 0x80, 0x80], "����"],
  ] as const) {
    const bytes = Buffer.concat([Buffer.from('"'), Buffer.from(invalidBytes), Buffer.from('"')]);
    const fatal = streamed(split(bytes, 1));
    await assert.rejects(readJsonBody(fatal.request, strict), accessError("INVALID_BODY"));
    assert.equal(fatal.stream.locked, false);
    const replaced = streamed(split(bytes, 1));
    assert.equal(await readJsonBody(replaced.request, replacement), expected);
    assert.equal(replaced.stream.locked, false);
  }
});

test("should strip a leading BOM only under the original strict policy", async () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"text":"ok"}')]);
  assert.deepEqual(await readJsonBody(streamed(split(bytes, 1)).request, strict), { text: "ok" });
  await assert.rejects(readJsonBody(streamed(split(bytes, 1)).request, replacement), (error) => {
    assert.ok(error instanceof ConnectionError);
    assert.equal(error.code, "INVALID_BODY");
    return true;
  });
  for (const options of [strict, replacement]) {
    assert.deepEqual(await readJsonBody(json({ text: "\ufeff" }).request, options), {
      text: "\ufeff",
    });
  }
});

test("should map only decode and JSON failures to the supplied error class", async () => {
  for (const ErrorClass of [AccessError, ConnectionError, WorkflowError]) {
    const codes: string[] = [];
    const options: Options = {
      utf8: "strict",
      error(code) {
        codes.push(code);
        return new ErrorClass(code);
      },
    };
    for (const bytes of [
      Buffer.alloc(0),
      Buffer.from("{"),
      Buffer.from("{} trailing"),
      Buffer.from([0xff]),
    ]) {
      const input = streamed([bytes]);
      await assert.rejects(readJsonBody(input.request, options), (error) => {
        assert.ok(error instanceof ErrorClass);
        assert.equal(error.code, "INVALID_BODY");
        return true;
      });
      assert.equal(input.stream.locked, false);
    }
    await assert.rejects(
      readJsonBody(json({}).request, { ...options, expectedOrigin: origin }),
      (error) => error instanceof ErrorClass && error.code === "UNSAFE_ORIGIN",
    );
    await assert.rejects(
      readJsonBody(streamed([Buffer.alloc(16385)]).request, options),
      (error) => error instanceof ErrorClass && error.code === "BODY_TOO_LARGE",
    );
    assert.deepEqual(codes, [
      "INVALID_BODY",
      "INVALID_BODY",
      "INVALID_BODY",
      "INVALID_BODY",
      "UNSAFE_ORIGIN",
      "BODY_TOO_LARGE",
    ]);
  }
});

test("should return parsed values without performing domain validation", async () => {
  for (const value of [null, [], true, 42, "text", { extra: true }]) {
    assert.deepEqual(await readJsonBody(json(value).request, strict), value);
  }
});

test("should release actual stream locks while propagating read failures unchanged", async () => {
  for (const afterChunk of [false, true]) {
    const failure = new Error("stream read failure");
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (afterChunk && pulled++ === 0) controller.enqueue(Buffer.from("{"));
          else controller.error(failure);
        },
      },
      { highWaterMark: 0 },
    );
    const input = new Request(origin, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as ConstructorParameters<typeof Request>[1]);
    await assert.rejects(readJsonBody(input, strict), (error) => error === failure);
    assert.equal(stream.locked, false);
  }
});

test("should propagate actual cancel failures and still release the stream lock", async () => {
  const failure = new Error("stream cancel failure");
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(Buffer.alloc(16385));
      },
      cancel() {
        cancelled++;
        throw failure;
      },
    },
    { highWaterMark: 0 },
  );
  const input = new Request(origin, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof Request>[1]);
  await assert.rejects(readJsonBody(input, strict), (error) => error === failure);
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test("should release reader locks before decoding and preserve release error precedence", async () => {
  for (const phase of ["success", "malformed", "read", "cancel", "releaseLock"] as const) {
    const events: string[] = [];
    const readFailure = new Error("read failure");
    const cancelFailure = new Error("cancel failure");
    const releaseFailure = new Error("release failure");
    let reads = 0;
    const input = injected({
      async read() {
        events.push("read");
        if (phase === "read") throw readFailure;
        if (phase === "cancel") return { done: false, value: Buffer.alloc(16385) };
        return reads++ === 0
          ? { done: false, value: Buffer.from(phase === "malformed" ? "{" : "{}") }
          : { done: true };
      },
      async cancel() {
        events.push("cancel");
        throw cancelFailure;
      },
      releaseLock() {
        events.push("releaseLock");
        if (phase === "releaseLock" || phase === "cancel") throw releaseFailure;
      },
    });
    const options: Options = {
      utf8: "strict",
      error(code) {
        events.push(code);
        return new AccessError(code);
      },
    };
    if (phase === "success") {
      assert.deepEqual(await readJsonBody(input, options), {});
      assert.deepEqual(events, ["read", "read", "releaseLock"]);
    } else if (phase === "malformed") {
      await assert.rejects(readJsonBody(input, options), accessError("INVALID_BODY"));
      assert.deepEqual(events, ["read", "read", "releaseLock", "INVALID_BODY"]);
    } else {
      await assert.rejects(
        readJsonBody(input, options),
        (error) => error === (phase === "read" ? readFailure : releaseFailure),
      );
      assert.deepEqual(
        events,
        phase === "cancel"
          ? ["read", "cancel", "releaseLock"]
          : phase === "read"
            ? ["read", "releaseLock"]
            : ["read", "read", "releaseLock"],
      );
    }
  }
});

test("should preserve reader acquisition failures without invoking the error factory", async () => {
  const failure = new Error("locked stream");
  const body = new ReadableStream<Uint8Array>();
  const existingReader = body.getReader();
  const options: Options = {
    utf8: "strict",
    error() {
      return assert.fail("Stream errors must retain their original identity");
    },
  };
  const input = {
    headers: new Headers({ "content-type": "application/json" }),
    body,
  } as unknown as Request;
  await assert.rejects(readJsonBody(input, options), TypeError);
  assert.equal(body.locked, true);
  existingReader.releaseLock();
  const thrown = {
    headers: input.headers,
    body: {
      getReader() {
        throw failure;
      },
    },
  } as unknown as Request;
  await assert.rejects(readJsonBody(thrown, options), (error) => error === failure);
});
