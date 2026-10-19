import test from "node:test";
import assert from "node:assert/strict";
import { runnerFixture } from "./runner-fixture.ts";
import { uuid } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { digest, stableJson, RuntimeError, type RuntimeAdapter } from "../src/runtime-contracts.ts";
import { createImageFile } from "../src/workflow/image-file.ts";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClaudeAdapter } from "../src/claude/adapter.ts";
import type { ClaudePolicy } from "../src/claude/policy.ts";

for (const scenario of ["terminal", "unknown", "cleanup-failure"] as const) {
  test(`should recover owned Codex image files with ${scenario} while preserving other requests`, async () => {
    const f = await runnerFixture();
    const bytes = Buffer.from("synthetic image bytes");
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 10,
      height: 10,
      sha256: digest(bytes),
    };
    const adapter = Object.assign(f.adapter, {
      imageInputVersion: 1 as const,
      preflightImage: async () => {},
    });
    try {
      f.queue().attachment = descriptor;
      if (scenario === "unknown")
        f.adapter.executeHook = async () => {
          throw new RuntimeError("UNKNOWN");
        };
      await f.runner(adapter).run({ once: true });
      const record = (await f.store.read())!;
      const attempt = record.attempts[0],
        snapshot = attempt.snapshot!;
      const owner = digest(
        stableJson({
          agentId: record.scope.agentId,
          journalKey: attempt.claimOperationId ?? attempt.requestId,
          requestId: snapshot.requestId,
          attemptId: snapshot.attemptId,
          fence: snapshot.fence,
          descriptor,
        }),
      );
      const path = join(f.store.dir, `image-${owner}`, "input");
      if (scenario !== "unknown") await createImageFile(f.store.dir, descriptor, bytes, owner);
      const foreign = await createImageFile(
        f.store.dir,
        descriptor,
        bytes,
        digest("another-agent"),
      );
      if (scenario === "cleanup-failure") await writeFile(path, Buffer.alloc(bytes.length));
      const runner = f.runner(adapter);
      if (scenario === "cleanup-failure") {
        // Force compaction of an uploaded request; failed cleanup must retain its journal.
        const compact = runner as unknown as {
          underBinding<T>(fn: () => Promise<T>): Promise<T>;
          compactJournal(force: boolean): Promise<void>;
        };
        await compact.underBinding(() => compact.compactJournal(true));
      } else await runner.run({ once: true });
      if (scenario === "terminal") await assert.rejects(stat(path), { code: "ENOENT" });
      else await stat(path);
      await stat(foreign.path!);
      if (scenario === "cleanup-failure")
        assert.equal((await f.store.read())!.attempts[0].requestId, attempt.requestId);
      if (scenario === "unknown")
        assert.equal((await f.store.read())!.attempts[0].state, "UNKNOWN");
      assert.equal(f.adapter.starts, 1);
      assert.ok((await readdir(f.store.dir)).includes(`image-${digest("another-agent")}`));
    } finally {
      await f.close();
    }
  });
}

for (const version of ["2.1.288", "2.1.293"]) {
  test(`should gate capability poll and claim image support for Claude ${version}`, async () => {
    const f = await runnerFixture();
    try {
      const policy: ClaudePolicy = {
        version,
        fingerprint: "a".repeat(64),
        async admit() {},
        assertLive() {},
        launch() {
          throw new Error("Provider must not start");
        },
      };
      const support = new ClaudeAdapter({ policy }).imageInputVersion;
      Object.assign(f.adapter, { imageInputVersion: support });
      f.queue();
      await f.runner(f.adapter).run({ once: true });
      const calls = f.requests.filter((r) => r.action === "poll" || r.action === "claim");
      assert.ok(calls.some((r) => r.action === "poll"));
      assert.ok(calls.some((r) => r.action === "claim"));
      for (const call of calls) assert.equal(call.body.imageInputVersion, support);
      assert.equal(
        f.requests.some((r) => r.action === "capability"),
        version === "2.1.293",
      );
    } finally {
      await f.close();
    }
  });
}

for (const provider of ["codex", "claude"] as const)
  for (const failure of ["download", "hash", "capacity"] as const) {
    test(`should close ${provider} image ${failure} failures before provider invocation and keep readiness`, async () => {
      const f = await runnerFixture(
        {},
        provider === "claude" ? (record) => Object.assign(record, claudeRecord(record)) : undefined,
      );
      try {
        const adapter: RuntimeAdapter = Object.assign(f.adapter, {
          imageInputVersion: 1 as const,
          preflightImage: async () => {
            if (failure === "capacity") throw new RuntimeError("RUNTIME_CAPACITY");
          },
        });
        const bytes = Buffer.from("synthetic image bytes");
        f.queue().attachment = {
          attachmentId: uuid(),
          mime: "image/png",
          bytes: bytes.length,
          width: 10,
          height: 10,
          sha256: failure === "hash" ? "0".repeat(64) : digest(bytes),
        };
        if (failure === "download")
          f.faults.before = async (action) => {
            if (action === "device-download") throw new Error("synthetic download failure");
          };
        await f.runner(adapter).run({ once: true });
        const saved = (await f.store.read())!;
        assert.equal(f.adapter.starts, 0);
        assert.equal(saved.attempts[0].state, "NOT_STARTED");
        assert.equal(saved.attempts[0].unstartedClosure?.kind, "SERVER_ATTACHMENT_REJECTED");
        assert.equal(
          saved.attempts[0].attachmentPreinputRejection?.reason,
          failure === "download"
            ? "IMAGE_DOWNLOAD_FAILED"
            : failure === "hash"
              ? "IMAGE_CONTENT_MISMATCH"
              : "IMAGE_HISTORY_CAPACITY",
        );
        assert.equal(f.requests.filter((r) => r.action === "fail-image-before-input").length, 1);
        if (provider === "codex") {
          f.faults.before = undefined;
          f.queue();
          await f.runner(adapter).run({ once: true });
          assert.equal(f.adapter.starts, 1);
          assert.equal((await f.store.read())!.attempts.at(-1)?.state, "UPLOADED");
        }
      } finally {
        await f.close();
      }
    });
  }
test("should recover a lost image failure receipt without invoking or re-downloading input", async () => {
  const f = await runnerFixture();
  try {
    const adapter: RuntimeAdapter = Object.assign(f.adapter, {
      imageInputVersion: 1 as const,
      preflightImage: async () => {},
    });
    f.queue().attachment = {
      attachmentId: uuid(),
      mime: "image/png",
      bytes: 21,
      width: 10,
      height: 10,
      sha256: "0".repeat(64),
    };
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "fail-image-before-input") response.destroy();
    };
    await f.runner(adapter).run({ once: true });
    const first = (await f.store.read())!;
    assert.equal(first.attempts[0].state, "UNKNOWN");
    assert.ok(first.attempts[0].attachmentPreinputRejection);
    f.faults.after = undefined;
    await f.runner(adapter).run({ once: true });
    assert.equal((await f.store.read())!.attempts[0].state, "NOT_STARTED");
    assert.equal(f.adapter.starts, 0);
    assert.equal(f.requests.filter((r) => r.action === "device-download").length, 1);
    const receipts = f.requests.filter((r) => r.action === "fail-image-before-input");
    assert.equal(receipts.length, 2);
    assert.deepEqual(receipts[0].body, receipts[1].body);
  } finally {
    await f.close();
  }
});
test("should preserve UNKNOWN without false closure when image rejection evidence cannot be saved", async () => {
  const f = await runnerFixture();
  try {
    const adapter: RuntimeAdapter = Object.assign(f.adapter, {
      imageInputVersion: 1 as const,
      preflightImage: async () => {},
    });
    f.queue().attachment = {
      attachmentId: uuid(),
      mime: "image/png",
      bytes: 21,
      width: 10,
      height: 10,
      sha256: "0".repeat(64),
    };
    await f
      .runner(adapter, {
        beforeMutation: async (kind) => {
          if (kind === "attachment-preinput-rejection")
            throw new Error("synthetic storage failure");
        },
      })
      .run({ once: true });
    const saved = (await f.store.read())!;
    assert.equal(saved.attempts[0].state, "UNKNOWN");
    assert.equal(saved.attempts[0].attachmentPreinputRejection, undefined);
    assert.equal(f.adapter.starts, 0);
    assert.equal(
      f.requests.some((r) => r.action === "fail-image-before-input"),
      false,
    );
  } finally {
    await f.close();
  }
});
