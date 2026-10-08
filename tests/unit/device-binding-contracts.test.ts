import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as web from "../../src/features/device-binding/contracts.ts";
import * as connector from "../../packages/local-connector/src/contracts.ts";
test("should agree on public connection contracts across web and connector validators", () => {
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/device-binding-contracts.json", "utf8"),
  ) as {
    version: number;
    cases: {
      kind: string;
      action: web.ConnectorAction | web.HumanAction;
      input: unknown;
      valid: boolean;
    }[];
  };
  assert.equal(fixture.version, 1);
  assert.deepEqual(web.humanActions, connector.humanActions);
  assert.deepEqual(web.connectorActions, connector.connectorActions);
  for (const c of fixture.cases) {
    const evaluate = (contracts: typeof web) => {
      try {
        if (c.kind === "alias") return { valid: contracts.isAlias(c.input) };
        if (c.kind === "branch") return { valid: contracts.isBranch(c.input) };
        if (c.kind === "body")
          return { valid: true, result: contracts.validateBody(c.action, c.input) };
        return { valid: true, result: contracts.projectResponse(c.action, c.input, true) };
      } catch {
        return { valid: false };
      }
    };
    const a = evaluate(web),
      b = evaluate(connector);
    assert.deepEqual(a, b);
    assert.equal(a.valid, c.valid);
  }
  const response = {
    protocol: 1,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    privateRoot: "synthetic-private",
  };
  assert.deepEqual(web.projectResponse("workspace", response), {
    protocol: 1,
    workspaceId: response.workspaceId,
  });
});
