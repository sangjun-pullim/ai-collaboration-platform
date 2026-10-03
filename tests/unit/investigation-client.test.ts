import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";

type Client = (
  action: contracts.HumanAction,
  body: contracts.Body,
  signal: AbortSignal,
) => Promise<unknown>;
type Fetch = (url: string, options: RequestInit) => Promise<Response>;
const originalGlobals = {
  fetch,
  AbortSignal,
  timeout: AbortSignal.timeout,
  any: AbortSignal.any,
  setTimeout,
  clearTimeout,
};
const fixture = JSON.parse(readFileSync("tests/fixtures/workflow-contracts.json", "utf8")) as {
  cases: { action: contracts.Action; body: contracts.Body; response: unknown }[];
};
const direct = JSON.parse(readFileSync("tests/fixtures/human-direct-contracts.json", "utf8"));
const read = fixture.cases.find((entry) => entry.action === "read")!;
// Normalize JSON results across VM realms without altering production parsing or errors.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const envelope = { ok: true, data: read.response };
const bytes = encoded(envelope);
const investigationClient = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/investigation-client.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;

function client(fetchMock: Fetch): Client {
  const exports: { callInvestigation?: Client } = {};
  runInNewContext(
    investigationClient,
    {
      exports,
      require(name: string) {
        if (name === "./contracts.ts") return contracts;
        throw new Error("Unexpected isolated client dependency");
      },
      fetch: fetchMock,
      AbortSignal,
      TextDecoder,
      Uint8Array,
    },
    { timeout: 1000 },
  );
  assert.ok(exports.callInvestigation);
  return exports.callInvestigation;
}

function response(chunks: Uint8Array[], status = 200, contentType = "application/json") {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { status, headers: { "Content-Type": contentType } },
  );
}

async function rejectResponse(value: Response, code: contracts.ErrorCode = "UNAVAILABLE") {
  let fetched = 0;
  const call = client(async () => {
    fetched++;
    return value;
  });
  await assert.rejects(call("read", read.body, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof contracts.WorkflowError);
    assert.equal(error.code, code);
    return true;
  });
  assert.equal(fetched, 1);
  if (value.body) assert.equal(value.body.locked, false);
}

after(() => {
  assert.equal(globalThis.fetch, originalGlobals.fetch);
  assert.equal(globalThis.AbortSignal, originalGlobals.AbortSignal);
  assert.equal(AbortSignal.timeout, originalGlobals.timeout);
  assert.equal(AbortSignal.any, originalGlobals.any);
  assert.equal(globalThis.setTimeout, originalGlobals.setTimeout);
  assert.equal(globalThis.clearTimeout, originalGlobals.clearTimeout);
});

test("should validate the investigation body before fetching", async () => {
  let fetched = 0;
  const caller = new AbortController();
  let composite: AbortSignal | undefined;
  const call = client(async (url, options) => {
    fetched++;
    assert.equal(url, "/api/investigations/read");
    assert.deepEqual(Object.keys(options).sort(), [
      "body",
      "cache",
      "headers",
      "method",
      "redirect",
      "signal",
    ]);
    assert.equal(options.method, "POST");
    assert.equal(
      JSON.stringify(options.headers),
      JSON.stringify({ "Content-Type": "application/json" }),
    );
    assert.equal(options.body, JSON.stringify(read.body));
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.notEqual(options.signal, caller.signal);
    assert.equal(options.signal.aborted, false);
    composite = options.signal;
    return response([bytes]);
  });
  await assert.rejects(
    call("read", { ...read.body, actor: "forged" }, caller.signal),
    (error: unknown) => {
      assert.ok(error instanceof contracts.WorkflowError);
      assert.equal(error.code, "INVALID_BODY");
      return true;
    },
  );
  assert.equal(fetched, 0);
  assert.deepEqual(plain(await call("read", read.body, caller.signal)), read.response);
  assert.equal(fetched, 1);
  caller.abort();
  assert.equal(composite!.aborted, true);
  assert.equal(composite!.reason, caller.signal.reason);
});

test("should project bounded investigation responses", async (t) => {
  const humanCases = fixture.cases.filter((entry) =>
    contracts.humanActions.includes(entry.action as contracts.HumanAction),
  );
  const cases = [
    ...humanCases,
    { action: "ask", body: direct.ask, response: direct.admission },
    { action: "cancel", body: direct.cancel, response: direct.cancelResult },
  ];
  for (const entry of cases) {
    await t.test(entry.action, async () => {
      const value = response(
        [encoded({ ok: true, data: entry.response })],
        200,
        " Application/JSON ; charset=utf-8",
      );
      let fetched = 0;
      assert.deepEqual(
        plain(
          await client(async () => {
            fetched++;
            return value;
          })(entry.action as contracts.HumanAction, entry.body, new AbortController().signal),
        ),
        entry.response,
      );
      assert.equal(fetched, 1);
      assert.equal(value.body!.locked, false);
    });
  }
  await t.test("exact byte limit including JSON whitespace", async () => {
    const padded = new Uint8Array(262_144).fill(0x20);
    padded.set(bytes);
    const value = response([padded.subarray(0, 131_072), padded.subarray(131_072)]);
    assert.deepEqual(
      plain(await client(async () => value)("read", read.body, new AbortController().signal)),
      read.response,
    );
    assert.equal(value.body!.locked, false);
  });
  await t.test("chunked multibyte UTF-8 and split BOM", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
    // One byte per chunk splits both the BOM and the fixture's Korean characters.
    const value = response(Array.from(bom, (byte) => new Uint8Array([byte])));
    assert.deepEqual(
      plain(await client(async () => value)("read", read.body, new AbortController().signal)),
      read.response,
    );
    assert.equal(value.body!.locked, false);
  });
});

test("should reject unavailable investigation responses without retrying", async (t) => {
  const invalid: [string, () => Response][] = [
    ["non-JSON content type", () => response([bytes], 200, "text/plain")],
    ["missing content type", () => new Response(bytes)],
    ["missing body", () => new Response(null, { headers: { "Content-Type": "application/json" } })],
    ["malformed UTF-8", () => response([new Uint8Array([0xc3, 0x28])])],
    ["incomplete multibyte UTF-8", () => response([bytes, new Uint8Array([0xe3])])],
    ["malformed JSON", () => response([new TextEncoder().encode("{")])],
    ["empty stream", () => response([])],
    ["success with error status", () => response([bytes], 503)],
    [
      "error code with wrong status",
      () => response([encoded({ ok: false, error: { code: "FORBIDDEN" } })], 401),
    ],
    ["extra envelope field", () => response([encoded({ ...envelope, extra: true })])],
    [
      "invalid projected response",
      () => response([encoded({ ok: true, data: { roomId: read.body.roomId } })]),
    ],
    [
      "error envelope with raw field",
      () => response([encoded({ ok: false, error: { code: "CONFLICT", message: "raw" } })], 409),
    ],
  ];
  for (const [name, make] of invalid) await t.test(name, () => rejectResponse(make()));
  for (const [code, status] of Object.entries(contracts.errorStatus)) {
    await t.test(`public ${code} envelope`, () =>
      rejectResponse(
        response([encoded({ ok: false, error: { code } })], status),
        code as contracts.ErrorCode,
      ),
    );
  }
});

test("should cancel oversized responses and release reader locks", async (t) => {
  await t.test("actual byte overflow cancels the real stream", async () => {
    const padded = new Uint8Array(262_144).fill(0x20);
    padded.set(bytes);
    let cancelled = 0;
    let pulled = 0;
    const value = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(pulled++ === 0 ? padded : new Uint8Array([0x20]));
        },
        cancel() {
          cancelled++;
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    await rejectResponse(value);
    assert.equal(cancelled, 1);
  });
  const readFailure = new contracts.WorkflowError("CONFLICT");
  const cancelFailure = new contracts.WorkflowError("FORBIDDEN");
  const releaseFailure = new contracts.WorkflowError("NOT_FOUND");
  const cases = [
    {
      name: "success",
      mode: "success",
      cancel: undefined,
      release: undefined,
      expected: undefined,
    },
    {
      name: "ordinary read failure",
      mode: "ordinary-read",
      cancel: undefined,
      release: undefined,
      expected: "UNAVAILABLE",
    },
    {
      name: "workflow read failure",
      mode: "read",
      cancel: undefined,
      release: undefined,
      expected: readFailure,
    },
    {
      name: "read and release failures",
      mode: "read",
      cancel: undefined,
      release: releaseFailure,
      expected: releaseFailure,
    },
    {
      name: "overflow",
      mode: "overflow",
      cancel: undefined,
      release: undefined,
      expected: "UNAVAILABLE",
    },
    {
      name: "overflow and cancel failure",
      mode: "overflow",
      cancel: cancelFailure,
      release: undefined,
      expected: cancelFailure,
    },
    {
      name: "overflow and ordinary cancel failure",
      mode: "overflow",
      cancel: new Error("cancel failure"),
      release: undefined,
      expected: "UNAVAILABLE",
    },
    {
      name: "overflow and release failure",
      mode: "overflow",
      cancel: undefined,
      release: releaseFailure,
      expected: releaseFailure,
    },
    {
      name: "overflow cancel and release failures",
      mode: "overflow",
      cancel: cancelFailure,
      release: releaseFailure,
      expected: releaseFailure,
    },
    {
      name: "success and release failure",
      mode: "success",
      cancel: undefined,
      release: releaseFailure,
      expected: releaseFailure,
    },
    {
      name: "read and ordinary release failure",
      mode: "read",
      cancel: undefined,
      release: new Error("release failure"),
      expected: "UNAVAILABLE",
    },
  ];
  for (const entry of cases)
    await t.test(entry.name, async () => {
      const calls: string[] = [];
      let reads = 0;
      const reader = {
        async read() {
          calls.push("read");
          if (entry.mode === "read") throw readFailure;
          if (entry.mode === "ordinary-read") throw new Error("read failure");
          if (entry.mode === "overflow") return { done: false, value: new Uint8Array(262_145) };
          return reads++ === 0 ? { done: false, value: bytes } : { done: true };
        },
        async cancel() {
          calls.push("cancel");
          if (entry.cancel) throw entry.cancel;
        },
        releaseLock() {
          calls.push("release");
          if (entry.release) throw entry.release;
        },
      };
      const value = {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        body: {
          getReader() {
            calls.push("acquire");
            return reader;
          },
        },
      } as unknown as Response;
      let fetched = 0;
      const result = client(async () => {
        fetched++;
        return value;
      })("read", read.body, new AbortController().signal);
      if (entry.expected === undefined) assert.deepEqual(plain(await result), read.response);
      else
        await assert.rejects(result, (error: unknown) => {
          if (typeof entry.expected === "string") {
            assert.ok(error instanceof contracts.WorkflowError);
            assert.equal(error.code, entry.expected);
          } else assert.equal(error, entry.expected);
          return true;
        });
      assert.equal(fetched, 1);
      assert.deepEqual(
        calls,
        entry.mode === "overflow"
          ? ["acquire", "read", "cancel", "release"]
          : entry.mode === "success"
            ? ["acquire", "read", "read", "release"]
            : ["acquire", "read", "release"],
      );
    });
});

// A standalone Response does not inherit fetch cancellation. Bind it explicitly.
function boundFetch(stage: "fetch" | "read") {
  let signal: AbortSignal | undefined;
  let releaseReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  let fetched = 0;
  let aborts = 0;
  let releases = 0;
  let detach = () => {};
  let value: Response | undefined;
  const fetchMock: Fetch = async (_url, options) => {
    fetched++;
    assert.ok(options.signal instanceof AbortSignal);
    signal = options.signal;
    if (stage === "fetch")
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          aborts++;
          reject(signal!.reason);
        };
        signal!.addEventListener("abort", onAbort, { once: true });
        detach = () => signal!.removeEventListener("abort", onAbort);
        if (signal!.aborted) onAbort();
        releaseReady();
      });
    value = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () => {
            aborts++;
            controller.error(signal!.reason);
          };
          signal!.addEventListener("abort", onAbort, { once: true });
          detach = () => signal!.removeEventListener("abort", onAbort);
          if (signal!.aborted) onAbort();
        },
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    const getReader = value.body!.getReader.bind(value.body!);
    value.body!.getReader = (() => {
      const reader = getReader();
      const release = reader.releaseLock.bind(reader);
      reader.releaseLock = () => {
        releases++;
        release();
        detach();
      };
      releaseReady();
      return reader;
    }) as typeof getReader;
    return value;
  };
  return {
    fetchMock,
    ready,
    cleanup: () => detach(),
    counts: () => ({ fetched, aborts, releases }),
    signal: () => signal,
    response: () => value,
  };
}

test("should preserve caller cancellation and workflow error identity", async (t) => {
  for (const stage of ["fetch", "read"] as const)
    await t.test(`caller abort during ${stage}`, async () => {
      const caller = new AbortController();
      const reason = new Error("caller cancellation");
      const bound = boundFetch(stage);
      try {
        const result = client(bound.fetchMock)("read", read.body, caller.signal);
        const rejected = assert.rejects(result, (error: unknown) => {
          assert.equal(error, reason);
          return true;
        });
        await bound.ready;
        caller.abort(reason);
        await rejected;
        assert.equal(bound.signal()!.aborted, true);
        assert.equal(bound.signal()!.reason, reason);
        assert.deepEqual(bound.counts(), {
          fetched: 1,
          aborts: 1,
          releases: stage === "read" ? 1 : 0,
        });
        if (bound.response()) assert.equal(bound.response()!.body!.locked, false);
      } finally {
        bound.cleanup();
      }
    });
  for (const error of [
    new contracts.WorkflowError("QUOTA"),
    new Error("fetch failure"),
    new DOMException("Unrelated abort", "AbortError"),
  ]) {
    await t.test(`fetch failure ${error.name}:${error.message}`, async () => {
      let fetched = 0;
      await assert.rejects(
        client(async () => {
          fetched++;
          throw error;
        })("read", read.body, new AbortController().signal),
        (failure: unknown) => {
          if (error instanceof contracts.WorkflowError) assert.equal(failure, error);
          else {
            assert.ok(failure instanceof contracts.WorkflowError);
            assert.equal(failure.code, "UNAVAILABLE");
          }
          return true;
        },
      );
      assert.equal(fetched, 1);
    });
  }
});

test("should enforce the 10000ms composite deadline without waiting ten seconds", async (t) => {
  const milliseconds: number[] = [];
  const inputs: AbortSignal[][] = [];
  const deadlines: AbortController[] = [];
  const timeoutMock = t.mock.method(AbortSignal, "timeout", (delay: number) => {
    milliseconds.push(delay);
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  const anyMock = t.mock.method(AbortSignal, "any", (signals: AbortSignal[]) => {
    inputs.push(signals);
    return originalGlobals.any.call(AbortSignal, signals);
  });
  try {
    for (const stage of ["fetch", "read"] as const) {
      const caller = new AbortController();
      const bound = boundFetch(stage);
      try {
        const result = client(bound.fetchMock)("read", read.body, caller.signal);
        const rejected = assert.rejects(result, (error: unknown) => {
          assert.ok(error instanceof contracts.WorkflowError);
          assert.equal(error.code, "UNAVAILABLE");
          return true;
        });
        await bound.ready;
        const deadline = deadlines.at(-1)!;
        const selected = inputs.at(-1)!;
        assert.equal(selected.length, 2);
        assert.equal(selected[0], caller.signal);
        assert.equal(selected[1], deadline.signal);
        assert.notEqual(bound.signal(), caller.signal);
        assert.notEqual(bound.signal(), deadline.signal);
        const timeout = new DOMException("Controlled deadline", "TimeoutError");
        deadline.abort(timeout);
        await rejected;
        assert.equal(bound.signal()!.reason, timeout);
        assert.equal(caller.signal.aborted, false);
        assert.deepEqual(bound.counts(), {
          fetched: 1,
          aborts: 1,
          releases: stage === "read" ? 1 : 0,
        });
        if (bound.response()) assert.equal(bound.response()!.body!.locked, false);
      } finally {
        bound.cleanup();
      }
    }
    assert.deepEqual(milliseconds, [10_000, 10_000]);
  } finally {
    anyMock.mock.restore();
    timeoutMock.mock.restore();
    for (const deadline of deadlines) if (!deadline.signal.aborted) deadline.abort();
  }
});
