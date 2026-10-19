import test from "node:test";
import assert from "node:assert/strict";
import { claudeFixture } from "./claude-runtime-fixture.ts";
import { digest } from "../src/runtime-contracts.ts";
import { uuid } from "./runtime-fixture.ts";
import { ClaudeAdapter } from "../src/claude/adapter.ts";
import type { ClaudePolicy } from "../src/claude/policy.ts";

test("should advertise images only for the verified Claude policy version", () => {
  for (const version of ["2.1.288", "2.1.293"]) {
    const policy: ClaudePolicy = {
      version,
      fingerprint: "a".repeat(64),
      async admit() {},
      assertLive() {},
      launch() {
        throw new Error("Provider must not start");
      },
    };
    assert.equal(
      new ClaudeAdapter({ policy }).imageInputVersion,
      version === "2.1.293" ? 1 : undefined,
    );
  }
  assert.equal(new ClaudeAdapter().imageInputVersion, undefined);
});

test("should reject cumulative image history capacity before opening a provider process", async () => {
  const f = await claudeFixture();
  try {
    const bytes = Buffer.alloc(512 * 1024, 1);
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 10,
      height: 10,
      sha256: digest(bytes),
    };
    f.authority.attempt.payload.attachment = descriptor;
    f.authority.image = { descriptor, bytes };
    f.history.byteLength = 12 * 1024 * 1024;
    await f.adapter.preflightImage(f.authority, f.settings, f.authority.attempt.payload);
    f.history.byteLength = 13 * 1024 * 1024;
    await assert.rejects(
      f.adapter.preflightImage(f.authority, f.settings, f.authority.attempt.payload),
      { code: "RUNTIME_CAPACITY" },
    );
    assert.equal(f.starts, 0);
  } finally {
    await f.close();
  }
});

test("should execute and prove the exact Claude image input through the adapter", async () => {
  const f = await claudeFixture();
  try {
    const bytes = Buffer.from("synthetic image");
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 10,
      height: 10,
      sha256: digest(bytes),
    };
    f.authority.attempt.payload.attachment = descriptor;
    f.authority.image = { descriptor, bytes };
    const evidence = await f.execute();
    assert.equal(evidence.terminal, "COMPLETED");
    assert.equal(f.starts, 1);
    const input = f.history.records.find((r) => r.type === "user");
    assert.ok(input);
    assert.equal(
      (input.message as { content: { source?: { data: string } }[] }).content[1].source?.data,
      bytes.toString("base64"),
    );
  } finally {
    await f.close();
  }
});
