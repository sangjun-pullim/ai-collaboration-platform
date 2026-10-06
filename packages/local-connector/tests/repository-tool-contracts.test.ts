import test from "node:test";
import assert from "node:assert/strict";
import {
  isOriginRoleRequestKind,
  repositoryTools,
  validateToolArguments,
  nativeToolNames,
} from "../src/workspace/tool-contracts.ts";
const files = [{ path: "src/example.ts" }];
test("should preserve selected path-only arguments and exclude unconfirmed peer tools", () => {
  assert.deepEqual(
    repositoryTools("SELECTED", files, false).map((tool) => tool.name),
    ["read_workspace_file"],
  );
  assert.deepEqual(
    validateToolArguments("SELECTED", files, false, "read_workspace_file", { path: files[0].path }),
    { path: files[0].path },
  );
  assert.throws(() =>
    validateToolArguments("SELECTED", files, false, "read_workspace_file", {
      path: files[0].path,
      offset: 0,
    }),
  );
  assert.throws(() =>
    validateToolArguments("SELECTED", files, false, "ask_peer", {
      question: "Question",
      evidence: [{ path: files[0].path, startLine: 1, endLine: 1 }],
    }),
  );
});
test("should advertise and validate exact bounded automatic list search and read arguments", () => {
  assert.deepEqual(
    repositoryTools("AUTO_CODE", [], false).map((tool) => tool.name),
    ["list_workspace_files", "search_workspace", "read_workspace_file"],
  );
  assert.equal(nativeToolNames("AUTO_CODE", false).length, 3);
  for (const [tool, args] of [
    ["list_workspace_files", {}],
    ["search_workspace", { query: "function", directory: "src" }],
    ["read_workspace_file", { path: "src/example.ts", offset: 0, expectedHash: "a".repeat(64) }],
  ] as const)
    assert.deepEqual(validateToolArguments("AUTO_CODE", [], false, tool, args), args);
  for (const [tool, args] of [
    ["list_workspace_files", { limit: 2 }],
    ["list_workspace_files", { directory: "../outside" }],
    ["search_workspace", { query: "" }],
    ["read_workspace_file", { path: ".env" }],
    ["read_workspace_file", { path: "AGENTS.md" }],
    ["read_workspace_file", { path: "src/example.ts", offset: -1 }],
    ["read_workspace_file", { path: "src/example.ts", mode: "AUTO_CODE" }],
  ])
    assert.throws(() => validateToolArguments("AUTO_CODE", [], false, tool as string, args));
});

test("should reject an automatic offset beyond the actual two MiB core bound", () => {
  const tools = repositoryTools("AUTO_CODE", [], false);
  const read = tools.find((tool) => tool.name === "read_workspace_file")!;
  assert.equal((read.inputSchema.properties.offset as { maximum: number }).maximum, 2097152);
  assert.deepEqual(
    validateToolArguments("AUTO_CODE", [], false, "read_workspace_file", {
      path: "src/example.ts",
      offset: 2097152,
    }),
    { path: "src/example.ts", offset: 2097152 },
  );
  assert.throws(
    () =>
      validateToolArguments("AUTO_CODE", [], false, "read_workspace_file", {
        path: "src/example.ts",
        offset: 2097153,
      }),
    { code: "TOOL_REJECTED" },
  );
});

test("should recognize only the three server origin-role request kinds", () => {
  for (const kind of ["ORIGIN", "CONTINUATION", "RESUME"])
    assert.equal(isOriginRoleRequestKind(kind), true);
  for (const kind of ["PEER", "DIRECT", "origin", "UNKNOWN", null, undefined])
    assert.equal(isOriginRoleRequestKind(kind), false);
});
