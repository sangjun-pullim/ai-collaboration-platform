import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as access from "../../src/features/room-access/contracts.ts";
import * as connection from "../../src/features/device-binding/contracts.ts";
import * as workflow from "../../src/features/investigation-coordinator/contracts.ts";

const origin = "https://collaboration.example";
const id = "00000000-0000-4000-8000-000000000001";
const token = "a".repeat(64);
type Policy = {
  read: (request: Request, action: string, human: boolean) => Promise<unknown>;
  bearer?: (request: Request) => string;
};
const variants = [
  {
    name: "room-access",
    contracts: access,
    error: access.AccessError,
    read: "readMutation",
    action: "logout",
    body: {},
  },
  {
    name: "device-binding",
    contracts: connection,
    error: connection.ConnectionError,
    read: "readConnection",
    action: "heartbeat",
    body: {},
  },
  {
    name: "investigation-coordinator",
    contracts: workflow,
    error: workflow.WorkflowError,
    read: "readWorkflow",
    action: "read",
    body: { protocol: 1, roomId: id, afterSequence: 0 },
  },
] as const;

function loadPolicy(variant: (typeof variants)[number], settingsFailure?: Error) {
  let settingsCalls = 0;
  const compile = (path: string) =>
    ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  const exports: Record<string, Policy["read"] | NonNullable<Policy["bearer"]>> = {};
  runInNewContext(
    compile(`src/features/${variant.name}/request-policy.ts`),
    {
      exports,
      require(name: string) {
        if (name === "server-only") return {};
        if (name === "./contracts") return variant.contracts;
        if (name === "../../lib/supabase/server")
          return {
            serverConfig() {
              settingsCalls++;
              if (settingsFailure) throw settingsFailure;
              return { origin };
            },
          };
        if (name === "../../lib/http/read-json-body") {
          const helper = {};
          runInNewContext(
            compile("src/lib/http/read-json-body.ts"),
            {
              exports: helper,
              require(dependency: string) {
                throw new Error(`Unexpected JSON reader dependency: ${dependency}`);
              },
              Buffer,
              TextDecoder,
              Uint8Array,
            },
            { timeout: 1000 },
          );
          return helper;
        }
        throw new Error(`Unexpected request policy dependency: ${name}`);
      },
      Buffer,
      TextDecoder,
      Uint8Array,
    },
    { timeout: 1000 },
  );
  return {
    read: exports[variant.read] as Policy["read"],
    bearer: (exports.bearer ?? exports.workflowBearer) as Policy["bearer"],
    settingsCalls: () => settingsCalls,
  };
}

function request(
  bytes: Uint8Array | string = "{}",
  headers: Record<string, string> = {},
  chunkSize = 4096,
) {
  const body = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === body.length) return controller.close();
      controller.enqueue(body.subarray(offset, offset + chunkSize));
      offset = Math.min(body.length, offset + chunkSize);
    },
  });
  return new Request(`${origin}/api/test`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: stream,
    duplex: "half",
  } as ConstructorParameters<typeof Request>[1]);
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function errorIs(variant: (typeof variants)[number], code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof variant.error);
    assert.equal(error.code, code);
    return true;
  };
}

for (const variant of variants) {
  test(`should enforce origin before content type and body access in ${variant.name}`, async () => {
    const policy = loadPolicy(variant);
    for (const suppliedOrigin of [null, "https://other.example", `${origin}/`]) {
      const touched: string[] = [];
      const input = {
        headers: {
          get(name: string) {
            touched.push(name);
            assert.equal(name, "origin");
            return suppliedOrigin;
          },
        },
        get body() {
          return assert.fail("Origin rejection must precede body access");
        },
      } as unknown as Request;
      await assert.rejects(
        policy.read(input, variant.action, true),
        errorIs(variant, "UNSAFE_ORIGIN"),
      );
      assert.deepEqual(touched, ["origin"]);
    }
    assert.equal(policy.settingsCalls(), 3);
    assert.deepEqual(
      plain(await policy.read(request(JSON.stringify(variant.body)), variant.action, true)),
      variant.body,
    );
  });

  test(`should preserve content type and missing body errors in ${variant.name}`, async () => {
    const policy = loadPolicy(variant);
    for (const contentType of [
      null,
      "text/plain",
      "application/json-patch+json",
      "application/json, text/plain",
    ]) {
      const input = {
        headers: {
          get(name: string) {
            return name === "origin" ? origin : contentType;
          },
        },
        get body() {
          return assert.fail("Content type rejection must precede body access");
        },
      } as unknown as Request;
      await assert.rejects(
        policy.read(input, variant.action, true),
        errorIs(variant, "INVALID_BODY"),
      );
    }
    const missingBody = new Request(origin, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
    });
    await assert.rejects(
      policy.read(missingBody, variant.action, true),
      errorIs(variant, "INVALID_BODY"),
    );
    for (const contentType of [
      "application/json; charset=utf-8",
      " Application/JSON ; charset=anything",
    ]) {
      assert.deepEqual(
        plain(
          await policy.read(
            request(JSON.stringify(variant.body), { "content-type": contentType }),
            variant.action,
            true,
          ),
        ),
        variant.body,
      );
    }
  });

  test(`should bound actual bytes and ignore content length in ${variant.name}`, async () => {
    const policy = loadPolicy(variant);
    const json = JSON.stringify(variant.body);
    const atLimit = json + " ".repeat(16384 - Buffer.byteLength(json));
    const input = request(atLimit, { "content-length": "999999" }, 7);
    assert.deepEqual(plain(await policy.read(input, variant.action, true)), variant.body);
    assert.equal(input.body!.locked, false);
    let cancelled = 0;
    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(atLimit));
        controller.enqueue(Buffer.from(" "));
      },
      cancel() {
        cancelled++;
      },
    });
    const tooLarge = new Request(origin, {
      method: "POST",
      headers: { origin, "content-type": "application/json", "content-length": "1" },
      body: overflow,
      duplex: "half",
    } as ConstructorParameters<typeof Request>[1]);
    await assert.rejects(
      policy.read(tooLarge, variant.action, true),
      errorIs(variant, "BODY_TOO_LARGE"),
    );
    assert.equal(cancelled, 1);
    assert.equal(tooLarge.body!.locked, false);
  });

  test(`should preserve malformed JSON and object validation in ${variant.name}`, async () => {
    const policy = loadPolicy(variant);
    for (const json of [
      "",
      "{",
      "null",
      "[]",
      "true",
      '"text"',
      "123",
      JSON.stringify({ ...variant.body, extra: true }),
    ]) {
      const input = request(json);
      await assert.rejects(
        policy.read(input, variant.action, true),
        errorIs(variant, "INVALID_BODY"),
      );
      assert.equal(input.body!.locked, false);
    }
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify(variant.body)),
    ]);
    if (variant.name === "device-binding") {
      await assert.rejects(
        policy.read(request(bom, {}, 1), variant.action, true),
        errorIs(variant, "INVALID_BODY"),
      );
    } else {
      assert.deepEqual(
        plain(await policy.read(request(bom, {}, 1), variant.action, true)),
        variant.body,
      );
    }
  });

  test(`should propagate original reader errors and release locks in ${variant.name}`, async () => {
    const policy = loadPolicy(variant);
    const readFailure = new Error("read failed");
    const input = new Request(origin, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: new ReadableStream({
        pull(controller) {
          controller.error(readFailure);
        },
      }),
      duplex: "half",
    } as ConstructorParameters<typeof Request>[1]);
    await assert.rejects(
      policy.read(input, variant.action, true),
      (error) => error === readFailure,
    );
    assert.equal(input.body!.locked, false);
    for (const failureAt of ["cancel", "releaseLock"] as const) {
      const failure = new Error(`${failureAt} failed`);
      const events: string[] = [];
      const reader = {
        async read() {
          events.push("read");
          return { done: false, value: Buffer.alloc(16385) };
        },
        async cancel() {
          events.push("cancel");
          if (failureAt === "cancel") throw failure;
        },
        releaseLock() {
          events.push("releaseLock");
          if (failureAt === "releaseLock") throw failure;
        },
      };
      const injected = {
        headers: new Headers({ origin, "content-type": "application/json" }),
        body: { getReader: () => reader },
      } as unknown as Request;
      await assert.rejects(
        policy.read(injected, variant.action, true),
        (error) => error === failure,
      );
      assert.deepEqual(events, ["read", "cancel", "releaseLock"]);
    }
  });
}

for (const variant of [variants[1], variants[2]]) {
  test(`should skip settings and origin entirely for device requests in ${variant.name}`, async () => {
    const policy = loadPolicy(variant, new Error("Settings must remain lazy"));
    for (const suppliedOrigin of [null, "https://other.example"]) {
      const input = request(JSON.stringify(variant.body));
      if (suppliedOrigin === null) input.headers.delete("origin");
      else input.headers.set("origin", suppliedOrigin);
      assert.deepEqual(plain(await policy.read(input, variant.action, false)), variant.body);
    }
    await assert.rejects(
      policy.read(request("{}", { "content-type": "text/plain" }), variant.action, false),
      errorIs(variant, "INVALID_BODY"),
    );
    assert.equal(policy.settingsCalls(), 0);
  });

  test(`should retain bearer cases and exact error identity in ${variant.name}`, () => {
    const policy = loadPolicy(variant);
    for (const authorization of [
      null,
      "",
      `bearer ${token}`,
      `Bearer ${"A".repeat(64)}`,
      `Bearer ${"a".repeat(63)}`,
      `Bearer ${token} `,
      `Bearer  ${token}`,
      `Bearer ${token}, Bearer ${token}`,
    ]) {
      const input = { headers: { get: () => authorization } } as unknown as Request;
      assert.throws(() => policy.bearer!(input), errorIs(variant, "UNAUTHENTICATED"));
    }
    assert.equal(
      policy.bearer!(new Request(origin, { headers: { authorization: `Bearer ${token}` } })),
      token,
    );
    assert.equal(policy.settingsCalls(), 0);
  });
}

test("should retain room field limits, trimming, UUID, email, code and role validation", async () => {
  const variant = variants[0];
  const policy = loadPolicy(variant);
  const read = (action: string, body: unknown) =>
    policy.read(request(JSON.stringify(body)), action, true);
  assert.deepEqual(plain(await read("code", { email: " user@example.com " })), {
    email: "user@example.com",
  });
  assert.deepEqual(plain(await read("invite", { roomId: id, role: " observer " })), {
    roomId: id,
    role: "observer",
  });
  const bootstrap = {
    groupName: "g",
    title: "한".repeat(160),
    goal: "g".repeat(2000),
    observation: "o".repeat(2000),
    environment: "e".repeat(2000),
    displayAlias: "a".repeat(80),
  };
  assert.deepEqual(plain(await read("bootstrap", bootstrap)), bootstrap);
  for (const key of ["title", "goal", "observation", "environment", "displayAlias"] as const) {
    await assert.rejects(
      read("bootstrap", { ...bootstrap, [key]: bootstrap[key] + "x" }),
      errorIs(variant, "INVALID_BODY"),
    );
  }
  for (const [action, body] of [
    ["code", { email: "bad" }],
    ["code", { email: 1 }],
    ["code", { email: "x\u0000@example.com" }],
    ["verify", { email: "user@example.com", code: "12345x" }],
    ["join", { code: "A".repeat(64), displayAlias: "alias" }],
    ["invite", { roomId: ` ${id} `, role: "observer" }],
    ["invite", { roomId: "invalid", role: "observer" }],
    ["invite", { roomId: id, role: "owner" }],
    ["bootstrap", { ...bootstrap, title: " " }],
    ["bootstrap", { ...bootstrap, groupName: "g".repeat(101) }],
  ] as const)
    await assert.rejects(read(action, body), errorIs(variant, "INVALID_BODY"));
  assert.deepEqual(plain(await read("verify", { email: "user@example.com", code: "123456" })), {
    email: "user@example.com",
    code: "123456",
  });
  assert.deepEqual(plain(await read("join", { code: token, displayAlias: " alias " })), {
    code: token,
    displayAlias: "alias",
  });
});

test("should use real device contracts for aliases, fields and protocol", async () => {
  const variant = variants[1];
  const policy = loadPolicy(variant);
  const body = { codeHash: token, proofHash: "b".repeat(64), deviceAlias: "기기", protocol: 1 };
  assert.deepEqual(
    plain(await policy.read(request(JSON.stringify(body), {}, 1), "begin", false)),
    body,
  );
  for (const invalid of [
    { ...body, deviceAlias: " 기기 " },
    { ...body, deviceAlias: "x".repeat(41) },
    { ...body, codeHash: body.proofHash },
    { ...body, protocol: 2 },
    { ...body, extra: true },
  ]) {
    await assert.rejects(
      policy.read(request(JSON.stringify(invalid)), "begin", false),
      errorIs(variant, "INVALID_BODY"),
    );
  }
  const invalidUtf8 = Buffer.concat([
    Buffer.from(`{"codeHash":"${token}","proofHash":"${"b".repeat(64)}","deviceAlias":"`),
    Buffer.from([0xff]),
    Buffer.from('","protocol":1}'),
  ]);
  await assert.rejects(
    policy.read(request(invalidUtf8), "begin", false),
    errorIs(variant, "INVALID_BODY"),
  );
});

test("should retain workflow trimming, text limits and strict UTF-8 across split chunks", async () => {
  const variant = variants[2];
  const policy = loadPolicy(variant);
  const body = { protocol: 1, roomId: id, operationId: id, publicText: " 한글😀 " };
  assert.deepEqual(plain(await policy.read(request(JSON.stringify(body), {}, 1), "speak", true)), {
    ...body,
    publicText: "한글😀",
  });
  for (const publicText of [" ", "x".repeat(4001), "한".repeat(2731), "\ud800"]) {
    await assert.rejects(
      policy.read(request(JSON.stringify({ ...body, publicText })), "speak", true),
      errorIs(variant, "INVALID_BODY"),
    );
  }
  const accepted = { ...body, publicText: "x".repeat(4000) };
  assert.deepEqual(
    plain(await policy.read(request(JSON.stringify(accepted)), "speak", true)),
    accepted,
  );
  const invalidUtf8 = Buffer.concat([
    Buffer.from(`{"protocol":1,"roomId":"${id}","operationId":"${id}","publicText":"`),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  await assert.rejects(
    policy.read(request(invalidUtf8), "speak", true),
    errorIs(variant, "INVALID_BODY"),
  );
  const roomPolicy = loadPolicy(variants[0]);
  await assert.rejects(
    roomPolicy.read(
      request(
        Buffer.concat([
          Buffer.from('{"email":"'),
          Buffer.from([0xff]),
          Buffer.from('@example.com"}'),
        ]),
      ),
      "code",
      true,
    ),
    errorIs(variants[0], "INVALID_BODY"),
  );
});
