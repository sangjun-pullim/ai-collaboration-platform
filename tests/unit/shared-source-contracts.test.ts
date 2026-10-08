import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  sourceFixtureManifest,
  sourceFixtureAutoManifest,
} from "../helpers/source-manifest-fixture.js";
import * as web from "../../src/features/investigation-coordinator/source-contracts.ts";
import * as local from "../../packages/local-connector/src/workflow/source-contracts.ts";
import {
  validateBody,
  projectResponse,
} from "../../src/features/investigation-coordinator/contracts.ts";
const id = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
test("should preserve exact pure source contract mirrors and canonical UTF16 tokens", () => {
  assert.equal(
    readFileSync("src/features/investigation-coordinator/source-contracts.ts", "utf8"),
    readFileSync("packages/local-connector/src/workflow/source-contracts.ts", "utf8"),
  );
  for (const source of [web, local]) {
    for (const path of ["a", "😀", "\ud800", "\udc00", 'a\t"b', "a".repeat(512)])
      assert.equal(source.validPathToken(JSON.stringify(path)), true);
    for (const path of ["", "../a", "a\\b", "/a", "a\0b", "a".repeat(513)])
      assert.equal(source.validPathToken(JSON.stringify(path)), false);
    for (const token of ['"\\u0061"', '"\\uD800"', '"\\ud83d\\ude00"', '"a\\/b"'])
      assert.equal(source.validPathToken(token), false);
    assert.equal(source.validRefToken(null), true);
    assert.equal(source.validRefToken('"null"'), true);
  }
});
test("should keep source wire protocol1 with exact bounded packets and whole confirmation", () => {
  const identity = { agentId: id, bindingEpoch: 1, requestId: id, attemptId: id, fence: 1 };
  const packet = {
    version: 2,
    index: 0,
    count: 1,
    totalBytes: 1,
    manifestHash: hash,
    chunkHash: hash,
    bytesBase64: "YQ==",
  };
  assert.deepEqual(
    validateBody("source-upload", {
      protocol: 1,
      ...identity,
      operationId: id,
      packetJson: JSON.stringify(packet),
    }),
    { protocol: 1, ...identity, operationId: id, packetJson: JSON.stringify(packet) },
  );
  for (const bytesBase64 of ["YR==", "YQ=", "YQ===", "YQ==\n", "_Q=="])
    assert.throws(
      () =>
        validateBody("source-upload", {
          protocol: 1,
          ...identity,
          operationId: id,
          packetJson: JSON.stringify({ ...packet, bytesBase64 }),
        }),
      { code: "INVALID_BODY" },
    );
  assert.deepEqual(
    projectResponse("source-confirm", {
      ...identity,
      version: 2,
      manifestHash: hash,
      state: "ABSENT",
      count: null,
      totalBytes: null,
      nextMissingIndex: 0,
    }),
    {
      ...identity,
      version: 2,
      manifestHash: hash,
      state: "ABSENT",
      count: null,
      totalBytes: null,
      nextMissingIndex: 0,
    },
  );
  assert.throws(
    () =>
      projectResponse("source-confirm", {
        ...identity,
        version: 2,
        manifestHash: hash,
        state: "CONFIRMED",
        count: 2,
        totalBytes: 8193,
        nextMissingIndex: 1,
      }),
    { code: "UNAVAILABLE" },
  );
});

test("should validate generated public fixtures and preserve original v1 hashes", () => {
  assert.equal(
    sourceFixtureManifest().manifest.input.observationHash,
    "eb763b05375dd76d06a3a561cef400d24e3660c5a9f25001ec0a4dd38bbaca1f",
  );
  const digest = (value: unknown) =>
    createHash("sha256").update(web.sourceStableJson(value)).digest("hex");
  for (const source of [
    sourceFixtureManifest([]),
    sourceFixtureManifest(["src/input.ts"]),
    sourceFixtureManifest(["😀.ts", "\ud800.ts", "\ue000.ts"]),
    sourceFixtureManifest(["src/input.ts"], "main"),
    sourceFixtureManifest([], "null"),
    sourceFixtureAutoManifest(id),
  ]) {
    for (const schema of [web, local]) {
      assert.equal(schema.validPublicSourceInput(source.manifest.input), true);
      assert.equal(schema.validPublicSourceManifest(source.manifest), true);
    }
    const { observationHash, git, files, ...original } = source.manifest.input;
    const entries = files.entries.map(({ pathJson, hash }) => ({
      path: JSON.parse(pathJson),
      hash,
    }));
    const { refJson, ...originalGit } = git;
    assert.equal(files.manifestHash, digest(entries));
    assert.equal(
      observationHash,
      digest({
        ...original,
        git: { ...originalGit, ref: refJson === null ? null : JSON.parse(refJson) },
        files: { ...files, entries },
      }),
    );
    assert.equal(source.manifestHash, createHash("sha256").update(source.bytes).digest("hex"));
  }
});
