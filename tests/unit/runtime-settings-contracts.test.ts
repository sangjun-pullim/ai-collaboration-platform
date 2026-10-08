import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as web from "../../src/features/runtime-settings/contracts.ts";
import * as connector from "../../packages/local-connector/src/settings/contracts.ts";
const id = "00000000-0000-4000-8000-000000000001";
const base = { operationId: id, deviceId: id, expectedConfigRevision: 0, runtime: "claude" };
function capability(runtime: web.Provider = "claude", efforts: string[] = []) {
  const contents = {
    runtime,
    version: "1.0",
    models: [
      {
        id: "model-one",
        model: "model-one",
        efforts,
        defaultEffort: efforts[0] ?? null,
        isDefault: true,
      },
    ],
    defaultSettings: { model: "model-one", effort: efforts[0] ?? null },
    policy: "verified" as const,
  };
  return { ...contents, snapshotHash: web.capabilityHash(contents) };
}
test("should reject private paths and commands in every exact settings body", () => {
  const { runtime: omitted, ...missing } = base;
  void omitted;
  assert.throws(() => web.validateBody("select-folder", missing), { code: "INVALID_BODY" });
  for (const privateField of [
    "root",
    "nativeSession",
    "shell",
    "token",
    "executablePath",
    "credential",
  ]) {
    assert.throws(
      () => web.validateBody("select-folder", { ...base, [privateField]: "/private/example" }),
      { code: "INVALID_BODY" },
    );
  }
  const c = capability();
  for (const invalid of ["/Users/private", "model; touch secret", "../model", "credential"])
    assert.throws(
      () =>
        web.validateBody("select-runtime", {
          ...base,
          runtime: "claude",
          model: invalid,
          effort: null,
          snapshotHash: c.snapshotHash,
        }),
      { code: "INVALID_BODY" },
    );
  assert.throws(
    () =>
      web.validateBody("apply", {
        ...base,
        runtime: "claude",
        model: "model-one",
        effort: null,
        snapshotHash: c.snapshotHash,
        localRootReference: "/private",
        repositoryAlias: "공유 저장소",
        sessionAlias: "내 AI",
        expectedEpoch: null,
      }),
    { code: "INVALID_BODY" },
  );
});
test("should preserve nullable provider effort without a Codex default", () => {
  const c = capability();
  const body = web.validateBody("select-runtime", {
    ...base,
    runtime: "claude",
    model: "model-one",
    effort: null,
    snapshotHash: c.snapshotHash,
  });
  assert.equal(body.effort, null);
  assert.deepEqual(web.projectCapability(c), c);
  assert.equal(web.validateSelection(body as web.Selection, c).effort, null);
  assert.throws(() => web.validateSelection({ ...body, effort: "high" } as web.Selection, c), {
    code: "INVALID_BODY",
  });
  const codex = capability("codex", ["low", "high"]);
  assert.throws(
    () =>
      web.validateSelection(
        { runtime: "codex", model: "model-one", effort: null, snapshotHash: codex.snapshotHash },
        codex,
      ),
    { code: "INVALID_BODY" },
  );
});
test("should reject a Codex catalog with no effort instead of admitting null", () => {
  const c = capability("codex", []);
  assert.throws(() => web.projectCapability(c), { code: "INVALID_BODY" });
  assert.throws(
    () =>
      web.validateSelection(
        { runtime: "codex", model: "model-one", effort: null, snapshotHash: c.snapshotHash },
        c,
      ),
    { code: "INVALID_BODY" },
  );
});
test("should reject coerced receipt states in request and response", () => {
  const receipt = {
    operationId: id,
    state: ["COMMITTED"],
    configRevision: 0,
    runtime: null,
    model: null,
    effort: null,
    snapshotHash: null,
    localRootReference: null,
    repositoryAlias: null,
    sessionAlias: null,
    catalog: null,
    bindingEpoch: null,
    agentId: null,
    workspaceId: null,
  };
  assert.throws(() => web.validateBody("receipt", receipt), { code: "INVALID_BODY" });
  assert.throws(
    () =>
      web.projectResponse({
        protocol: 1,
        deviceId: id,
        configRevision: 0,
        catalog: null,
        operation: null,
        applied: receipt,
        current: true,
        currentBinding: null,
      }),
    { code: "UNAVAILABLE" },
  );
});
test("should expose the owner current binding before the first settings receipt", () => {
  const response = {
    protocol: 1,
    deviceId: id,
    configRevision: 0,
    catalog: null,
    operation: null,
    applied: null,
    current: true,
    currentBinding: { agentId: id, workspaceId: id, bindingEpoch: 3, runtime: "codex" },
  };
  assert.deepEqual(web.projectResponse(response), response);
  assert.throws(
    () =>
      web.projectResponse({
        ...response,
        currentBinding: { ...response.currentBinding, root: "/private" },
      }),
    { code: "UNAVAILABLE" },
  );
});
test("should reject changed or oversized capabilities instead of truncating models", () => {
  const c = capability();
  assert.throws(() => web.projectCapability({ ...c, version: "2.0" }), { code: "INVALID_BODY" });
  assert.throws(
    () =>
      web.projectCapability({
        ...c,
        models: [{ ...c.models[0], efforts: Array.from({ length: 13 }, (_, i) => `effort-${i}`) }],
      }),
    { code: "INVALID_BODY" },
  );
  assert.throws(
    () =>
      web.projectCapability({
        ...c,
        models: Array.from({ length: 257 }, (_, i) => ({
          ...c.models[0],
          id: `model-${i}`,
          model: `model-${i}`,
        })),
      }),
    { code: "INVALID_BODY" },
  );
  assert.throws(
    () =>
      web.validateSelection(
        { runtime: "claude", model: "model-one", effort: null, snapshotHash: "a".repeat(64) },
        c,
      ),
    { code: "CONFLICT" },
  );
  assert.throws(() => web.validateBody("select-folder", { ...base, raw: "x".repeat(17000) }), {
    code: "BODY_TOO_LARGE",
  });
});
test("should compute canonical SHA-256 with nested null Unicode and JSON escaping", () => {
  const content = {
    runtime: "claude" as const,
    version: '검증 "버전"\n',
    models: [
      { id: "모델", model: "模型", efforts: ["낮음"], defaultEffort: null, isDefault: false },
    ],
    defaultSettings: null,
    policy: "unsupported" as const,
  };
  function canonical(v: unknown): string {
    if (v !== null && typeof v === "object") {
      if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
      const r = v as Record<string, unknown>;
      return `{${Object.keys(r)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v);
  }
  assert.equal(
    web.capabilityHash(content),
    createHash("sha256").update(canonical(content)).digest("hex"),
  );
  assert.equal(
    web.capabilityHash({ ...content, models: content.models, version: content.version }),
    web.capabilityHash(content),
  );
});
test("should keep web and connector contract mirrors byte and behavior equal", () => {
  assert.equal(
    readFileSync("src/features/runtime-settings/contracts.ts", "utf8"),
    readFileSync("packages/local-connector/src/settings/contracts.ts", "utf8"),
  );
  const c = capability();
  assert.deepEqual(web.projectCapability(c), connector.projectCapability(c));
  for (const action of web.humanActions)
    assert.equal(connector.humanActions.includes(action), true);
  assert.deepEqual(web.deviceActions, connector.deviceActions);
  assert.deepEqual(
    web.validateBody("select-folder", base),
    connector.validateBody("select-folder", base),
  );
});
test("should reject private response fields and malformed error envelopes", () => {
  const response = {
    protocol: 1,
    deviceId: id,
    configRevision: 0,
    catalog: null,
    operation: null,
    applied: null,
    current: true,
    currentBinding: null,
  };
  assert.deepEqual(web.projectEnvelope({ ok: true, data: response }, 200), response);
  assert.throws(() => web.projectResponse({ ...response, path: "/private" }), {
    code: "UNAVAILABLE",
  });
  assert.throws(
    () =>
      web.projectEnvelope({ ok: false, error: { code: "FORBIDDEN", credential: "secret" } }, 403),
    { code: "UNAVAILABLE" },
  );
  assert.throws(() => web.projectEnvelope({ ok: false, error: { code: "FORBIDDEN" } }, 401), {
    code: "UNAVAILABLE",
  });
});

test("should bound device response streams and withhold cookies and redirects", async () => {
  const { SettingsClient } = await import("../../packages/local-connector/src/settings/client.ts");
  const response = {
    protocol: 1,
    deviceId: id,
    configRevision: 0,
    catalog: null,
    operation: null,
    applied: null,
    current: true,
    currentBinding: null,
  };
  let calls = 0;
  const client = new SettingsClient("http://127.0.0.1:3000", async (input, init) => {
    calls++;
    assert.equal(String(input), "http://127.0.0.1:3000/api/runtime-settings/poll");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, undefined);
    assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${"a".repeat(64)}`);
    return Response.json({ ok: true, data: response });
  });
  assert.deepEqual(await client.call("poll", {}, "a".repeat(64)), response);
  assert.equal(calls, 1);
  await assert.rejects(client.call("poll", {}, "invalid"), { code: "UNAUTHENTICATED" });
  assert.equal(calls, 1);
  const oversized = new SettingsClient(
    "http://127.0.0.1:3000",
    async () =>
      new Response(" ".repeat(17000), { headers: { "Content-Type": "application/json" } }),
  );
  await assert.rejects(oversized.call("poll", {}, "a".repeat(64)), { code: "UNAVAILABLE" });
  const redirected = new SettingsClient("http://127.0.0.1:3000", async () => {
    throw new Error("synthetic private upstream failure");
  });
  await assert.rejects(redirected.call("poll", {}, "a".repeat(64)), { code: "UNAVAILABLE" });
});

test("should read an exact completed settings operation without admitting a private selector", () => {
  for (const contract of [web, connector]) {
    for (const action of ["list", "poll"] as const) {
      const input = { ...(action === "list" ? { deviceId: id } : {}), operationId: id };
      assert.deepEqual(contract.validateBody(action, input), input);
      assert.throws(() => contract.validateBody(action, { ...input, operationId: "/private/id" }), {
        code: "INVALID_BODY",
      });
      assert.throws(() => contract.validateBody(action, { ...input, root: "/private" }), {
        code: "INVALID_BODY",
      });
    }
  }
});

test("should accept only exact optional automatic mode in apply and owner receipts", () => {
  const c = capability();
  const input = {
    ...base,
    model: "model-one",
    effort: null,
    snapshotHash: c.snapshotHash,
    localRootReference: id,
    repositoryAlias: "Repository",
    sessionAlias: "Session",
    expectedEpoch: null,
  };
  for (const contract of [web, connector]) {
    assert.deepEqual(contract.validateBody("apply", { ...input, readMode: "AUTO_CODE" }), {
      ...input,
      readMode: "AUTO_CODE",
    });
    for (const readMode of [null, "SELECTED", "AUTO", {}, true])
      assert.throws(() => contract.validateBody("apply", { ...input, readMode }), {
        code: "INVALID_BODY",
      });
    assert.throws(
      () =>
        contract.validateBody("select-runtime", {
          ...base,
          model: "model-one",
          effort: null,
          snapshotHash: c.snapshotHash,
          readMode: "AUTO_CODE",
        }),
      { code: "INVALID_BODY" },
    );
  }
});

test("should preserve optional automatic receipt metadata without exposing local approval identities", () => {
  const receipt = {
    operationId: id,
    state: "LOCAL_CONFIRMATION",
    configRevision: 0,
    runtime: "claude",
    model: null,
    effort: null,
    snapshotHash: null,
    localRootReference: id,
    repositoryAlias: "Repository",
    sessionAlias: null,
    catalog: capability(),
    bindingEpoch: null,
    agentId: null,
    workspaceId: null,
    readMode: "AUTO_CODE",
  };
  for (const contract of [web, connector]) {
    assert.deepEqual(contract.validateBody("receipt", receipt), receipt);
    assert.throws(
      () => contract.validateBody("receipt", { ...receipt, localRootReference: null }),
      { code: "INVALID_BODY" },
    );
    for (const field of [
      "root",
      "rootIdentityHash",
      "generation",
      "approvalHash",
      "confirmationOperationId",
    ])
      assert.throws(() => contract.validateBody("receipt", { ...receipt, [field]: id }), {
        code: "INVALID_BODY",
      });
    assert.throws(
      () => contract.validateBody("receipt", { ...receipt, readMode: "AUTO_CODE\ud800" }),
      { code: "INVALID_BODY" },
    );
  }
});
