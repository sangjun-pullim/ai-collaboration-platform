import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionError } from "../src/contracts.ts";
import { parseCliOptions } from "../src/cli/parse-options.ts";

const objectPrototype = Object.prototype;

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
