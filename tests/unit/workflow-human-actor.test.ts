import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as contracts from "../../src/features/investigation-coordinator/contracts.ts";
import * as responsePolicy from "../../src/features/investigation-coordinator/rpc-response-policy.ts";

const source = ts.transpileModule(
  readFileSync("src/features/investigation-coordinator/service.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const actor = "abcdefab-1234-4000-8000-abcdefabcdef";
const state = {
  agentId: "00000000-0000-4000-8000-000000000002",
  bindingEpoch: 1,
  revision: 2,
  paused: true,
  appliedRevision: null,
  appliedEpoch: null,
  appliedAt: null,
};
function harness() {
  const exports: {
    humanWorkflow?: (
      client: unknown,
      action: contracts.HumanAction,
      body: contracts.Body,
    ) => Promise<unknown>;
  } = {};
  runInNewContext(source, {
    exports,
    require(name: string) {
      if (name === "server-only") return {};
      if (name === "./contracts") return contracts;
      if (name === "./rpc-response-policy") return responsePolicy;
      if (name === "../room-access/team-entry-policy") return { retryableAuthFailure: () => false };
      if (name === "../device-binding/device-client" || name === "../../lib/supabase/server")
        return {};
      throw new Error(`Unexpected service dependency ${name}`);
    },
  });
  let authCalls = 0;
  const calls: { name: string; body: contracts.Body }[] = [];
  const client = {
    auth: {
      async getUser() {
        authCalls++;
        return { data: { user: { id: actor } }, error: null };
      },
    },
    async rpc(name: string, params: { p_body: contracts.Body }) {
      calls.push({ name, body: params.p_body });
      return { data: state, error: null };
    },
  };
  assert.ok(exports.humanWorkflow);
  return {
    call: (body: contracts.Body) => exports.humanWorkflow!(client, "input-control", body),
    calls,
    authCalls: () => authCalls,
  };
}
function body(expectedUserId: string): contracts.Body {
  return contracts.validateBody("input-control", {
    protocol: 1,
    roomId: "00000000-0000-4000-8000-000000000001",
    agentId: state.agentId,
    bindingEpoch: 1,
    expectedRevision: 1,
    paused: true,
    operationId: "00000000-0000-4000-8000-000000000003",
    expectedUserId,
  });
}
test("should accept the verified actor UUID in uppercase without changing the transmitted intent", async () => {
  const h = harness(),
    intent = body(actor.toUpperCase());
  assert.deepEqual(await h.call(intent), state);
  assert.equal(h.authCalls(), 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].name, "workflow_human_input_control");
  assert.equal(h.calls[0].body, intent);
  assert.equal(h.calls[0].body.expectedUserId, actor.toUpperCase());
});
test("should reject a different actor before any RPC call", async () => {
  const h = harness();
  await assert.rejects(h.call(body("abcdefab-1234-4000-8000-abcdefabcdee")), { code: "FORBIDDEN" });
  assert.equal(contracts.errorStatus.FORBIDDEN, 403);
  assert.equal(h.authCalls(), 1);
  assert.equal(h.calls.length, 0);
});
