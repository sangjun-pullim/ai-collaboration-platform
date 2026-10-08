import test from "node:test";
import assert from "node:assert/strict";
import { runnerFixture, SyntheticAdapter } from "./runner-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { unresolvedRuntime } from "../src/runtime-store.ts";
import { uuid, observation } from "./runtime-fixture.ts";
import {
  digest,
  stableJson,
  type AttemptAuthority,
  type RuntimeSettings,
  type NativeInputIntent,
  type TerminalEvidence,
} from "../src/runtime-contracts.ts";
import type { RequestPayload } from "../src/workflow-contracts.ts";
class SourceAdapter extends SyntheticAdapter {
  override async execute(
    authority: AttemptAuthority,
    settings: RuntimeSettings,
    payload: RequestPayload,
    beforeSubmit: (intent?: NativeInputIntent) => Promise<void>,
  ): Promise<TerminalEvidence> {
    const turnId = uuid(),
      intent: NativeInputIntent | undefined =
        settings.provider === "claude"
          ? {
              provider: "claude",
              sessionId: authority.context.threadId,
              inputId: turnId,
              promptHash: digest(stableJson(payload)),
              generation: authority.context.generation,
              scope: structuredClone(authority.scope),
              attemptId: authority.attempt.attemptId,
              fence: authority.attempt.fence,
              policyFingerprint: authority.context.materialization!.policyFingerprint,
            }
          : undefined;
    await beforeSubmit(intent);
    authority.assertLive();
    this.starts++;
    await authority.ack(
      authority.context.threadId,
      turnId,
      intent ? digest("synthetic-init") : undefined,
    );
    return {
      threadId: authority.context.threadId,
      turnId,
      terminal: "COMPLETED",
      privateText: "Synthetic conclusion",
      publicText: "Synthetic conclusion",
      finalItems: [{ id: "synthetic", hash: digest("Synthetic conclusion") }],
      textProof: "FINAL_ANSWER",
      observation: observation(settings),
      ...(intent ? { nativeInitHash: digest("synthetic-init") } : {}),
    };
  }
}
test("should detach terminal evidence before publishing while an adapter retains its returned object", async () => {
  class RetainingAdapter extends SourceAdapter {
    evidence: TerminalEvidence | undefined;
    override async execute(...args: Parameters<SourceAdapter["execute"]>) {
      this.evidence = await super.execute(...args);
      return this.evidence;
    }
  }
  const adapter = new RetainingAdapter(),
    f = await runnerFixture({ sourceGitExecutor: unavailable });
  try {
    let changed = false;
    f.faults.before = async (action) => {
      if (action === "source-confirm" && !changed) {
        changed = true;
        adapter.evidence!.publicText = "Changed through an adapter-owned alias";
      }
    };
    f.queue();
    await f.runner(adapter).run({ once: true });
    assert.equal(changed, true);
    assert.equal(
      f.requests.find((request) => request.action === "complete")?.body.publicText,
      "Synthetic conclusion",
    );
    assert.equal((await f.store.read())!.attempts[0].terminal!.publicText, "Synthetic conclusion");
    assert.equal(adapter.evidence!.publicText, "Changed through an adapter-owned alias");
  } finally {
    await f.close();
  }
});
const unavailable = async () => {
  throw new Error("synthetic Git unavailable");
};
for (const provider of ["codex", "claude"] as const) {
  test(`should confirm source before new terminal operation for ${provider} and reuse support within the scope`, async () => {
    const f = await runnerFixture(
      { sourceGitExecutor: unavailable },
      provider === "claude" ? (r) => Object.assign(r, claudeRecord(r)) : undefined,
    );
    try {
      f.queue();
      await f.runner(new SourceAdapter()).run({ once: true });
      const actions = f.requests.map((r) => r.action),
        support = actions.indexOf("source-support"),
        claim = actions.indexOf("claim"),
        lastConfirm = actions.lastIndexOf("source-confirm"),
        complete = actions.indexOf("complete");
      assert.ok(support >= 0 && support < claim && lastConfirm > claim && lastConfirm < complete);
      assert.equal(actions.filter((a) => a === "source-support").length, 1);
      assert.equal(
        (await f.store.read())!.operations.some((o) => o.action.startsWith("source-")),
        false,
      );
    } finally {
      await f.close();
    }
  });
}
test("should block claim and native input when exact source support is unavailable", async () => {
  const f = await runnerFixture({ sourceGitExecutor: unavailable });
  try {
    f.faults.before = async (action) => {
      if (action === "source-support") throw new Error("unsupported");
    };
    f.queue();
    await assert.rejects(f.runner().run({ once: true }));
    assert.equal(
      f.requests.some((r) => r.action === "claim"),
      false,
    );
    assert.equal(f.adapter.starts, 0);
  } finally {
    await f.close();
  }
});
test("should keep TERMINAL after upload loss and recover identical bytes without native or Git input", async () => {
  let git = 0;
  const f = await runnerFixture({
    sourceGitExecutor: async () => {
      git++;
      return unavailable();
    },
  });
  try {
    f.queue();
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "source-upload") response.destroy();
    };
    await f.runner().run({ once: true });
    const before = (await f.store.read())!;
    assert.equal(before.attempts[0].state, "TERMINAL");
    assert.equal(unresolvedRuntime(before), true);
    assert.equal(
      before.operations.some((o) => o.action === "complete"),
      false,
    );
    const uploads = f.requests.filter((r) => r.action === "source-upload").map((r) => r.body);
    assert.ok(uploads.length >= 1);
    f.faults.after = undefined;
    await f.runner().run({ once: true });
    const after = (await f.store.read())!;
    assert.equal(after.attempts[0].state, "UPLOADED");
    assert.equal(f.adapter.starts, 1);
    assert.equal(git, 3);
    assert.deepEqual(after.attempts[0].sourceObservation, before.attempts[0].sourceObservation);
    assert.equal(f.requests.filter((r) => r.action === "source-upload").length, uploads.length);
    assert.equal(
      after.operations.some((o) => o.action.startsWith("source-")),
      false,
    );
  } finally {
    await f.close();
  }
});
