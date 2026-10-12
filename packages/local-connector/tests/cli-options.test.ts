import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionError } from "../src/contracts.ts";
import { parseCliOptions } from "../src/cli/parse-options.ts";
import { createHash } from "node:crypto";

const objectPrototype = Object.prototype;

test("should accept only a complete connect recovery relation", () => {
  const previous = `web-${"a".repeat(32)}`;
  const recoveryId = "12345678-1234-4123-8123-123456789abc";
  const profile = `web-${createHash("sha256")
    .update(JSON.stringify(["connection-recovery", previous, recoveryId]))
    .digest("hex")
    .slice(0, 32)}`;
  const parse = parseCliOptions as (args: string[], command?: string) => Record<string, string>;
  const args = ["--profile", profile, "--previous-profile", previous, "--recovery-id", recoveryId];
  assert.equal(parse(args, "connect").profile, profile);
  for (const command of [undefined, "pair", "manage", "runtime-run", "revoke-local"])
    assert.throws(() => parse(args, command), { code: "INVALID_BODY" });
  for (const invalid of [
    args.slice(0, 4),
    ["--profile", previous, ...args.slice(2)],
    ["--profile", `web-${"b".repeat(32)}`, ...args.slice(2)],
    [...args.slice(0, 5), "not-a-uuid"],
    [...args, "--recovery-id", recoveryId],
  ])
    assert.throws(() => parse(invalid, "connect"), { code: "INVALID_BODY" });
});

// These values and cases are independent of the source loader and stay fixed after extraction.
const allOptions = {
  server: "http://127.0.0.1:1234",
  "state-dir": " /synthetic state ",
  profile: "synthetic-profile",
  "device-alias": " Synthetic device ",
  "confirm-scope": "yes",
  root: " /synthetic workspace ",
  "native-session": "synthetic-session",
  "repository-alias": "Synthetic repository",
  "session-alias": "Synthetic session",
  "agent-id": "synthetic-agent",
  "confirm-public": "no",
  model: "synthetic-model",
  effort: "synthetic-effort",
  "runtime-default": "synthetic-default",
  files: ' ["one file", "two"] ',
  handoff: ' {"message":"synthetic handoff"} ',
  "confirm-new-context": "yes",
  "confirm-auto-questions": "no",
  once: "--synthetic-value",
};
const pairs = Object.entries(allOptions);
const validCases: { name: string; input: string[]; expected: Record<string, string> }[] = [
  { name: "empty options", input: [], expected: {} },
  ...pairs.map(([key, value]) => ({
    name: `single ${key} option`,
    input: [`--${key}`, value],
    expected: { [key]: value },
  })),
  {
    name: "all 19 options in order",
    input: pairs.flatMap(([key, value]) => [`--${key}`, value]),
    expected: allOptions,
  },
  {
    name: "all 19 options in reverse order",
    input: [...pairs].reverse().flatMap(([key, value]) => [`--${key}`, value]),
    expected: allOptions,
  },
  {
    name: "whitespace only value",
    input: ["--profile", " \t\n "],
    expected: { profile: " \t\n " },
  },
  { name: "bare option marker value", input: ["--model", "--"], expected: { model: "--" } },
  {
    name: "known option name as a value",
    input: ["--model", "--effort", "--once", "no"],
    expected: { model: "--effort", once: "no" },
  },
];
const invalidCases = [
  { name: "unknown key", input: ["--unknown", "value"] },
  { name: "empty key", input: ["--", "value"] },
  { name: "prototype key", input: ["--__proto__", "value"] },
  { name: "inherited constructor key", input: ["--constructor", "value"] },
  { name: "inherited toString key", input: ["--toString", "value"] },
  { name: "case changed key", input: ["--Server", "value"] },
  { name: "missing prefix", input: ["server", "value"] },
  { name: "single dash prefix", input: ["-server", "value"] },
  { name: "triple dash prefix", input: ["---server", "value"] },
  { name: "leading prefix whitespace", input: [" --server", "value"] },
  { name: "equals syntax", input: ["--server=value", "value"] },
  { name: "missing value", input: ["--server"] },
  { name: "empty value", input: ["--server", ""] },
  { name: "adjacent duplicate", input: ["--server", "one", "--server", "two"] },
  { name: "same value duplicate", input: ["--profile", "one", "--profile", "one"] },
  {
    name: "separated duplicate",
    input: ["--model", "one", "--effort", "high", "--model", "two"],
  },
  { name: "missing later value", input: ["--model", "one", "--effort"] },
  { name: "empty later value", input: ["--model", "one", "--effort", ""] },
  { name: "unknown later key", input: ["--model", "one", "--unknown", "two"] },
  { name: "trailing positional argument", input: ["--model", "one", "trailing"] },
];

test("should parse existing connector options without changing their values", async (t) => {
  for (const { name, input, expected } of validCases) {
    await t.test(name, () => {
      for (const frozen of [false, true]) {
        const received = [...input];
        if (frozen) Object.freeze(received);
        const result = parseCliOptions(received);
        assert.equal(Object.getPrototypeOf(result), objectPrototype);
        assert.equal(Array.isArray(result), false);
        assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
        assert.deepEqual(
          Object.keys(result),
          input.filter((_, i) => i % 2 === 0).map((key) => key.slice(2)),
        );
        assert.deepEqual(received, input);
      }
    });
  }
});

test("should reject malformed connector option pairs", async (t) => {
  for (const { name, input } of invalidCases) {
    await t.test(name, () => {
      for (const frozen of [false, true]) {
        const received = [...input];
        if (frozen) Object.freeze(received);
        assert.throws(
          () => parseCliOptions(received),
          (error: unknown) => {
            assert.ok(error instanceof ConnectionError);
            assert.equal(error.constructor, ConnectionError);
            assert.equal(error.code, "INVALID_BODY");
            assert.equal(error.message, "INVALID_BODY");
            return true;
          },
        );
        assert.deepEqual(received, input);
      }
    });
  }
});
