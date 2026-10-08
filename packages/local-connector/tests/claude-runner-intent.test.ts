import test, { mock } from "node:test";
import { open, lstat, readFile, type FileHandle } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  RuntimeError,
  digest,
  stableJson,
  scopedNamespace,
  type AttemptAuthority,
  type NativeInputIntent,
  type NativeObservation,
  type OwnedContext,
  type RuntimeSettings,
  type TerminalEvidence,
} from "../src/runtime-contracts.ts";
import type { RequestPayload } from "../src/workflow-contracts.ts";
import { runnerFixture, SyntheticAdapter, deferred } from "./runner-fixture.ts";
import { uuid, observation } from "./runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";

class IntentAdapter extends SyntheticAdapter {
  lostAck = false;
  onSubmitted: (intent: NativeInputIntent) => Promise<void> = async () => {};
  intent: NativeInputIntent | undefined;
  observedNative: NativeObservation | undefined;
  override async execute(
    authority: AttemptAuthority,
    settings: RuntimeSettings,
    payload: RequestPayload,
    beforeSubmit: (intent?: NativeInputIntent) => Promise<void>,
  ): Promise<TerminalEvidence> {
    this.intent = {
      provider: "claude",
      sessionId: authority.context.threadId,
      inputId: uuid(),
      promptHash: digest(stableJson(payload)),
      generation: authority.context.generation,
      scope: structuredClone(authority.scope),
      attemptId: authority.attempt.attemptId,
      fence: authority.attempt.fence,
      policyFingerprint: authority.context.materialization!.policyFingerprint,
    };
    await beforeSubmit(this.intent);
    this.starts++;
    await this.onSubmitted(this.intent);
    this.observed = {
      threadId: this.intent.sessionId,
      turnId: this.intent.inputId,
      terminal: "COMPLETED",
      privateText: "Synthetic public conclusion",
      publicText: "Synthetic public conclusion",
      finalItems: [{ id: "synthetic-result", hash: digest("Synthetic public conclusion") }],
      textProof: "FINAL_ANSWER",
      observation: observation(settings),
      nativeInitHash: digest("synthetic-init"),
    };
    if (this.lostAck) throw new RuntimeError("UNKNOWN");
    await authority.ack(this.intent.sessionId, this.intent.inputId, this.observed.nativeInitHash);
    return this.observed;
  }
  override async observe(
    _context?: OwnedContext,
    _settings?: RuntimeSettings,
    native?: NativeObservation,
  ) {
    this.observedNative = native;
    return this.observed;
  }
}

test("should fsync the exact Claude input intent before provider submission and materialize only after ACK", async () => {
  const f = await runnerFixture({}, (record) => Object.assign(record, claudeRecord(record)));
  const adapter = new IntentAdapter();
  try {
    adapter.onSubmitted = async (intent) => {
      const disk = (await f.store.read())!;
      assert.deepEqual(disk.attempts[0].nativeIntent, intent);
      assert.equal(disk.attempts[0].state, "PROVIDER_INTENT");
      assert.equal(disk.attempts[0].native, null);
      assert.equal(disk.context!.materialization!.state, "RESERVED");
    };
    f.queue();
    const status = await f.runner(adapter).run({ once: true });
    assert.equal(status.state, "UPLOADED");
    const disk = (await f.store.read())!;
    assert.equal(disk.context!.materialization!.state, "MATERIALIZED");
    assert.equal(disk.attempts[0].native!.turnId, adapter.intent!.inputId);
    assert.equal(adapter.starts, 1);
  } finally {
    await f.close();
  }
});

test("should submit no Claude input when durable intent storage fails", async () => {
  const f = await runnerFixture(
    {
      beforeMutation: async (kind) => {
        if (kind === "provider-intent") throw new RuntimeError("UNSAFE_STORAGE");
      },
    },
    (record) => Object.assign(record, claudeRecord(record)),
  );
  const adapter = new IntentAdapter();
  try {
    f.queue();
    const status = await f.runner(adapter).run({ once: true });
    assert.equal(status.state, "UNKNOWN");
    assert.equal(adapter.starts, 0);
    assert.equal((await f.store.read())!.attempts[0].nativeIntent, undefined);
  } finally {
    await f.close();
  }
});

test("should observe the exact reserved Claude input after a lost ACK without submitting again", async () => {
  const f = await runnerFixture({}, (record) => Object.assign(record, claudeRecord(record)));
  const adapter = new IntentAdapter();
  adapter.lostAck = true;
  try {
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UNKNOWN");
    const before = (await f.store.read())!;
    assert.equal(before.attempts[0].native, null);
    const status = await f.runner(adapter).observe();
    assert.equal(status.state, "UPLOADED");
    assert.deepEqual(adapter.observedNative!.intent, before.attempts[0].nativeIntent);
    assert.equal(adapter.starts, 1);
    assert.equal((await f.store.read())!.context!.materialization!.state, "MATERIALIZED");
  } finally {
    await f.close();
  }
});

test("should retain UNKNOWN when exact Claude history has no confirmed terminal", async () => {
  const f = await runnerFixture({}, (record) => Object.assign(record, claudeRecord(record)));
  const adapter = new IntentAdapter();
  adapter.lostAck = true;
  try {
    f.queue();
    await f.runner(adapter).run({ once: true });
    adapter.observed = null;
    assert.equal((await f.runner(adapter).observe()).state, "UNKNOWN");
    assert.equal(adapter.starts, 1);
    assert.equal((await f.store.read())!.attempts[0].native, null);
  } finally {
    await f.close();
  }
});

test("should fsync exact tool cancellation before terminal adoption and preserve it during UNKNOWN observation", async () => {
  const f = await runnerFixture({}, (record) => Object.assign(record, claudeRecord(record)));
  class CancelAdapter extends IntentAdapter {
    override async execute(
      authority: AttemptAuthority,
      settings: RuntimeSettings,
      payload: RequestPayload,
      beforeSubmit: (intent?: NativeInputIntent) => Promise<void>,
    ): Promise<TerminalEvidence> {
      const terminal = await super.execute(authority, settings, payload, beforeSubmit);
      const call = {
        threadId: authority.context.threadId,
        turnId: this.intent!.inputId,
        callId: "held-read",
        namespace: scopedNamespace,
        tool: "read_workspace_file",
        arguments: { path: settings.files[0].path },
      };
      await authority.tool(call);
      const cancellation = {
        callId: call.callId,
        controlId: "held-control",
        payloadHash: digest(stableJson(call)),
        cancelHash: digest(
          stableJson({ type: "control_cancel_request", request_id: "held-control" }),
        ),
      };
      await authority.cancelledTool!(cancellation);
      assert.deepEqual((await f.store.read())!.attempts[0].toolCancellations, [cancellation]);
      this.observed = {
        ...terminal,
        terminal: "INTERRUPTED",
        privateText: "",
        publicText: "",
        textProof: "UNCONFIRMED",
        toolCancellations: [cancellation],
      };
      throw new RuntimeError("UNKNOWN");
    }
  }
  const adapter = new CancelAdapter();
  try {
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UNKNOWN");
    const disk = (await f.store.read())!;
    assert.equal(disk.attempts[0].toolCancellations!.length, 1);
    assert.equal((await f.runner(adapter).observe()).state, "UPLOADED");
    assert.deepEqual(adapter.observedNative!.toolCancellations, disk.attempts[0].toolCancellations);
    const restored = (await f.store.read())!;
    assert.deepEqual(
      restored.context!.ownedTurns[0].toolCancellations,
      disk.attempts[0].toolCancellations,
    );
    const forged = structuredClone(restored);
    forged.attempts[0].toolCancellations![0].cancelHash = digest("changed cancel proof");
    await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
    assert.equal(adapter.starts, 1);
  } finally {
    await f.close();
  }
});

import { claudeHarness, interruptionProof, streamingAbort } from "./claude-runtime-fixture.ts";
import type { RunnerOptions } from "../src/workflow-runner.ts";

async function realRunnerFixture(options: RunnerOptions = {}) {
  const f = await runnerFixture(options, (record) => {
    Object.assign(record, claudeRecord(record));
    record.settings!.autoQuestionsConfirmed = false;
  });
  const h = claudeHarness(f, f.record);
  const entered = deferred<void>();
  let authority: AttemptAuthority | undefined;
  const execute = h.adapter.execute.bind(h.adapter);
  h.adapter.execute = async (current, settings, payload, beforeSubmit) => {
    authority = current;
    return execute(current, settings, payload, async (intent) => {
      assert.ok(intent);
      h.captureIntent(intent);
      await beforeSubmit(intent);
    });
  };
  h.native.onInput = async (input) => {
    await h.emit(input);
    await h.emit(h.init());
    await h.emit(h.assistant(input));
    entered.resolve();
  };
  f.queue();
  const runner = f.runner(h.adapter);
  const running = runner.run({ once: true });
  void running.catch(() => {});
  await entered.promise;
  return {
    f,
    h,
    runner,
    running,
    get authority() {
      return authority!;
    },
  };
}

async function closeReal(f: Awaited<ReturnType<typeof realRunnerFixture>>) {
  await f.h.emit(f.h.result(f.h.native.writes[0], streamingAbort)).catch(() => {});
  await f.running.catch(() => {});
  await f.h.close();
  await f.f.close();
}

test("should keep UNKNOWN after terminal storage loss and recover INTERRUPTED with a new runner and new real ClaudeAdapter using the same synthetic history", async () => {
  let failedTerminal = false;
  const f = await realRunnerFixture({
    beforeMutation: async (kind) => {
      if (kind === "terminal-evidence" && !failedTerminal) {
        failedTerminal = true;
        throw new RuntimeError("UNSAFE_STORAGE");
      }
    },
  });
  let recovery: ReturnType<typeof f.h.createAdapter> | undefined;
  try {
    assert.equal(await f.h.adapter.interrupt(f.authority), true);
    await f.h.emit(f.h.result(f.h.native.writes[0], streamingAbort));
    assert.equal((await f.running).state, "UNKNOWN");
    assert.equal(failedTerminal, true);
    const interruptedJournal = (await f.f.store.read())!.attempts[0];
    f.f.unknown();
    recovery = f.h.createAdapter();
    const recovered = await f.f.runner(recovery, {}).observe();
    assert.equal(recovered.state, "UPLOADED");
    const disk = (await f.f.store.read())!;
    assert.equal(disk.attempts[0].terminal!.terminal, "INTERRUPTED");
    assert.equal(disk.attempts[0].receipt!.terminal, "INTERRUPTED");
    const proof = interruptionProof(f.h.intent!, { still_queued: [] });
    assert.deepEqual(interruptedJournal.nativeInterruption, proof);
    assert.deepEqual(disk.attempts[0].nativeInterruption, proof);
    assert.deepEqual(disk.attempts[0].terminal!.nativeInterruption, proof);
    assert.deepEqual(disk.context!.ownedTurns[0].nativeInterruption, proof);
    assert.equal(f.h.native.writes.length, 1);
    assert.equal(f.h.native.controls.length, 1);
    assert.equal(f.h.tools.length, 0);
    assert.equal(f.h.starts, 1);
    const upload = f.f.requests.filter((request) => request.action === "observe");
    assert.equal(upload.length, 1);
    assert.equal(upload[0].body.terminal, "INTERRUPTED");
    const compacted = await f.f.store.compact(disk);
    assert.equal(compacted.attempts.length, 0);
    assert.deepEqual(compacted.context!.ownedTurns[0].nativeInterruption, proof);
    const archiveValidator = f.h.createAdapter();
    try {
      await archiveValidator.validate(compacted.context!, compacted.settings!, () => {});
    } finally {
      await archiveValidator.close();
    }
    assert.equal(f.h.native.writes.length, 1);
    assert.equal(f.h.starts, 1);
  } finally {
    await recovery?.close();
    await closeReal(f);
  }
});

test("should persist exact interruption intent and receipt before returning native control delivery", async () => {
  const f = await realRunnerFixture(),
    uploading = deferred<void>(),
    releaseUpload = deferred<void>();
  f.f.faults.before = async (action) => {
    if (action === "complete") {
      uploading.resolve();
      await releaseUpload.promise;
    }
  };
  f.h.native.onInterrupt = async () => {
    const disk = (await f.f.store.read())!;
    assert.deepEqual(disk.attempts[0].nativeInterruption, interruptionProof(f.h.intent!));
    assert.equal(disk.attempts[0].terminal, null);
    return { still_queued: [], cancelled: [f.h.intent!.inputId] };
  };
  try {
    assert.equal(await f.h.adapter.interrupt(f.authority), true);
    const disk = (await f.f.store.read())!;
    assert.deepEqual(
      disk.attempts[0].nativeInterruption,
      interruptionProof(f.h.intent!, { still_queued: [], cancelled: [f.h.intent!.inputId] }),
    );
    assert.equal(disk.attempts[0].terminal, null);
    assert.equal(f.h.native.controls.length, 1);
    await f.h.emit(f.h.result(f.h.native.writes[0], streamingAbort));
    await uploading.promise;
    const closed = (await f.f.store.read())!;
    assert.deepEqual(
      closed.attempts[0].terminal!.nativeInterruption,
      disk.attempts[0].nativeInterruption,
    );
    const before = await readFile(f.f.store.file);
    assert.equal(await f.authority.interruption!(disk.attempts[0].nativeInterruption!), "CLOSED");
    assert.deepEqual(await readFile(f.f.store.file), before);
    releaseUpload.resolve();
    assert.equal((await f.running).state, "UPLOADED");
    await assert.rejects(f.authority.interruption!(disk.attempts[0].nativeInterruption!));
  } finally {
    releaseUpload.resolve();
    await closeReal(f);
  }
});

test("should send no native control after logical interruption storage failure", async () => {
  let reached = 0;
  const f = await realRunnerFixture({
    beforeMutation: async (kind) => {
      if (kind === "native-interruption") {
        reached++;
        throw new RuntimeError("UNSAFE_STORAGE");
      }
    },
  });
  try {
    await assert.rejects(f.h.adapter.interrupt(f.authority), { code: "UNSAFE_STORAGE" });
    assert.equal(reached, 1);
    assert.equal(f.h.native.controls.length, 0);
    assert.equal((await f.f.store.read())!.attempts[0].nativeInterruption, undefined);
  } finally {
    await closeReal(f);
  }
});

test("should send no native control after actual owned-directory FileHandle.sync failure", async () => {
  let armed = false,
    failedSync = 0;
  const f = await realRunnerFixture({
    beforeMutation: async (kind) => {
      if (kind === "native-interruption") armed = true;
    },
  });
  const owned = await lstat(f.f.store.dir);
  const probe = await open(f.f.store.file, "r");
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const original = prototype.sync;
  await probe.close();
  const replacement = mock.method(prototype, "sync", async function (this: FileHandle) {
    const stat = await this.stat();
    if (armed && stat.dev === owned.dev && stat.ino === owned.ino && failedSync === 0) {
      failedSync++;
      armed = false;
      throw new Error("SYNTHETIC_interruption_directory_sync");
    }
    return original.call(this);
  });
  try {
    await assert.rejects(f.h.adapter.interrupt(f.authority));
    assert.equal(failedSync, 1);
    assert.equal(f.h.native.controls.length, 0);
    // Readable bytes after a failed sync are not proof of durable success.
    assert.equal(f.h.native.writes.length, 1);
  } finally {
    replacement.mock.restore();
    await closeReal(f);
  }
});

test("should save only owned interruption evidence after stop while sending no new input tool or control", async () => {
  const f = await realRunnerFixture();
  try {
    const proof = interruptionProof(f.h.intent!);
    f.runner.stop();
    assert.equal(await f.authority.interruption!(proof), "SAVED");
    assert.deepEqual((await f.f.store.read())!.attempts[0].nativeInterruption, proof);
    assert.throws(() => f.authority.assertLive());
    await assert.rejects(
      f.authority.tool({
        threadId: proof.intent.sessionId,
        turnId: proof.intent.inputId,
        callId: "after-stop",
        namespace: scopedNamespace,
        tool: "read_workspace_file",
        arguments: { path: "public.txt" },
      }),
    );
    await assert.rejects(
      f.h.adapter.execute(f.authority, f.h.settings, f.authority.attempt.payload, async () => {}),
    );
    assert.equal(await f.h.adapter.interrupt(f.authority).catch(() => false), false);
    assert.equal(f.h.native.writes.length, 1);
    assert.equal(f.h.native.controls.length, 0);
    assert.equal(f.h.native.replies.length, 0);
  } finally {
    await closeReal(f);
  }
});

test("should reject interruption save after lost ownership or retirement", async () => {
  for (const loss of ["active", "lockHeld", "retired", "generation", "scope", "fence"] as const) {
    const f = await realRunnerFixture();
    const internals = f.runner as unknown as {
      active: AttemptAuthority | undefined;
      lockHeld: boolean;
      retired: boolean;
    };
    const previous = {
      active: internals.active,
      lockHeld: internals.lockHeld,
      retired: internals.retired,
    };
    const context = structuredClone(f.authority.context),
      scope = structuredClone(f.authority.scope),
      attempt = structuredClone(f.authority.attempt);
    try {
      const proof = interruptionProof(f.h.intent!);
      if (loss === "active") internals.active = undefined;
      if (loss === "lockHeld") internals.lockHeld = false;
      if (loss === "retired") internals.retired = true;
      if (loss === "generation") f.authority.context.generation = uuid();
      if (loss === "scope") f.authority.scope.bindingEpoch++;
      if (loss === "fence") f.authority.attempt.fence++;
      assert.ok(f.authority.interruption);
      await assert.rejects(f.authority.interruption(proof));
      assert.equal((await f.f.store.read())!.attempts[0].nativeInterruption, undefined);
      assert.equal(f.h.native.controls.length, 0);
    } finally {
      Object.assign(internals, previous);
      f.authority.context = context;
      f.authority.scope = scope;
      f.authority.attempt = attempt;
      await closeReal(f);
    }
  }
});

test("should close queued interruption storage after stopping a Claude input with a held native ACK", async () => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const f = await runnerFixture(
    {
      drainTimeoutMs: 10,
      beforeMutation: async (kind) => {
        if (kind === "native-ack") {
          entered.resolve();
          await release.promise;
        }
      },
    },
    (record) => Object.assign(record, claudeRecord(record)),
  );
  const h = claudeHarness(f, f.record),
    execute = h.adapter.execute.bind(h.adapter);
  h.adapter.execute = (authority, settings, payload, beforeSubmit) =>
    execute(authority, settings, payload, async (intent) => {
      assert.ok(intent);
      h.captureIntent(intent);
      await beforeSubmit(intent);
    });
  h.native.onInput = async (input) => {
    await h.emit(input);
    await h.emit(h.init());
  };
  f.queue();
  const runner = f.runner(h.adapter),
    run = runner.run({ once: true });
  void run.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await entered.promise;
    runner.stop();
    const result = await Promise.race([
      run,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("SYNTHETIC_shutdown_timeout")), 2000);
      }),
    ]);
    assert.equal(result.state, "UNKNOWN");
    const disk = (await f.store.read())!;
    assert.equal(disk.attempts[0].native, null);
    assert.equal(disk.attempts[0].nativeInterruption, undefined);
    assert.equal(h.native.writes.length, 1);
    assert.equal(h.native.controls.length, 0);
    const before = await readFile(f.store.file);
    release.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await readFile(f.store.file), before);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await run.catch(() => {});
    await h.close();
    await f.close();
  }
});

test("should preserve uploaded closed proof when an interrupt receipt arrives after terminal", async () => {
  const f = await realRunnerFixture(),
    receipt = deferred<unknown>(),
    controlStarted = deferred<void>();
  f.h.native.onInterrupt = () => {
    controlStarted.resolve();
    return receipt.promise;
  };
  let interrupted: Promise<boolean> | undefined;
  try {
    interrupted = f.h.adapter.interrupt(f.authority);
    void interrupted.catch(() => {});
    await controlStarted.promise;
    await f.h.emit(f.h.result(f.h.native.writes[0], streamingAbort));
    assert.equal((await f.running).state, "UPLOADED");
    const before = await readFile(f.f.store.file),
      disk = (await f.f.store.read())!;
    assert.deepEqual(disk.attempts[0].nativeInterruption, interruptionProof(f.h.intent!));
    assert.deepEqual(
      disk.context!.ownedTurns[0].nativeInterruption,
      interruptionProof(f.h.intent!),
    );
    receipt.resolve({ still_queued: [], cancelled: [f.h.intent!.inputId] });
    assert.equal(await interrupted, true);
    assert.deepEqual(await readFile(f.f.store.file), before);
    assert.equal(f.h.native.controls.length, 1);
    assert.equal(f.h.native.writes.length, 1);
  } finally {
    receipt.resolve({ still_queued: [] });
    await interrupted?.catch(() => {});
    await closeReal(f);
  }
});

test("should preserve the actual Claude input tool policy in the immutable closed owned turn", async () => {
  const f = await realRunnerFixture();
  try {
    assert.deepEqual(f.h.intent!.toolPolicy, { version: 1, mode: "SELECTED", peerAllowed: false });
    await f.h.emit(f.h.result(f.h.native.writes[0]));
    assert.equal((await f.running).state, "UPLOADED");
    const disk = (await f.f.store.read())!;
    assert.deepEqual(disk.context!.ownedTurns[0].toolPolicy, f.h.intent!.toolPolicy);
    const recovery = f.h.createAdapter();
    try {
      await recovery.validate(disk.context!, disk.settings!, () => {});
    } finally {
      await recovery.close();
    }
    const forged = structuredClone(disk);
    forged.context!.ownedTurns[0].toolPolicy!.peerAllowed = true;
    await assert.rejects(async () => f.f.store.write(forged), { code: "UNSAFE_STORAGE" });
    assert.equal(f.h.native.writes.length, 1);
  } finally {
    await f.h.close();
    await f.f.close();
  }
});

import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
import { nativeToolNames } from "../src/workspace/tool-contracts.ts";
import { RuntimeArchive } from "../src/runtime-archive.ts";
for (const boundary of ["none", "finalize", "archive-save", "archive-verify"] as const)
  test(`should preserve a completed automatic generation during selected replacement at ${boundary}`, async () => {
    const f = await runnerFixture({}, (record) => {
      Object.assign(record, claudeRecord(record));
      record.settings!.files = [];
      record.settings!.autoQuestionsConfirmed = false;
      record.settings!.repositoryAccess = createRepositoryAccess(
        record.context!.generation,
        record.context!.root,
        uuid(),
        uuid(),
      );
    });
    const h = claudeHarness(f, f.record),
      execute = h.adapter.execute.bind(h.adapter);
    h.adapter.execute = (authority, settings, payload, beforeSubmit) =>
      execute(authority, settings, payload, async (intent) => {
        assert.ok(intent);
        h.captureIntent(intent);
        await beforeSubmit(intent);
      });
    h.native.onInput = async (input) => {
      await h.emit(input);
      await h.emit({ ...h.init(), tools: nativeToolNames("AUTO_CODE", false) });
      await h.emit(
        h.assistant(input, [
          {
            type: "tool_use",
            id: "completed-auto-read",
            name: "mcp__ai_collaboration_scoped__read_workspace_file",
            input: { path: "public.txt" },
          },
        ]),
      );
      await h.emit({
        type: "control_request",
        request_id: "completed-auto-control",
        request: {
          subtype: "mcp_message",
          server_name: "ai_collaboration_scoped",
          message: {
            jsonrpc: "2.0",
            id: "completed-auto-rpc",
            method: "tools/call",
            params: {
              name: "read_workspace_file",
              arguments: { path: "public.txt" },
              _meta: {
                session_id: h.context.threadId,
                user_message_uuid: input.uuid,
                tool_use_id: "completed-auto-read",
              },
            },
          },
        },
      });
      const response = h.native.replies.at(-1) as {
        mcp_response: { result: { content: unknown[]; isError: boolean } };
      };
      await h.emit({
        type: "user",
        uuid: uuid(),
        session_id: h.context.threadId,
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "completed-auto-read",
              content: response.mcp_response.result.content,
              is_error: response.mcp_response.result.isError,
            },
          ],
        },
      });
      await h.emit(h.assistant(input));
      await h.emit(h.result(input));
    };
    let failed = false;
    try {
      f.queue();
      assert.equal((await f.runner(h.adapter).run({ once: true })).state, "UPLOADED");
      const before = (await f.store.read())!,
        previous = structuredClone(before.attempts[0]);
      assert.equal(previous.toolCalls.length, 1);
      assert.ok(previous.toolCalls[0].repositoryIntent);
      assert.equal(previous.toolCalls[0].result!.success, true);
      assert.ok(previous.toolCalls[0].result!.contentItems[0].text.length > 0);
      assert.equal(previous.toolCalls[0].repositoryObservation!.files.length, 1);
      assert.equal(
        previous.toolCalls[0].repositoryObservation!.resultHash,
        digest(stableJson(previous.toolCalls[0].result)),
      );
      assert.equal(previous.generation, before.context!.generation);
      assert.deepEqual(previous.nativeIntent!.toolPolicy, {
        version: 1,
        mode: "AUTO_CODE",
        peerAllowed: false,
      });
      const settings = structuredClone(before.settings),
        context = structuredClone(before.context);
      const selectedAdapter = () => {
        const adapter = new SyntheticAdapter();
        adapter.capabilities = async (_root, check) => {
          check();
          return structuredClone(settings!.capabilities);
        };
        adapter.prepare = async (
          root,
          _settings,
          generation,
          epoch,
          check,
          onCreated = async () => {},
        ) => {
          check();
          adapter.prepares++;
          const candidate: OwnedContext = {
            ownership: "CONNECTOR_CREATED",
            generation,
            root,
            epoch,
            threadId: uuid(),
            level: "L1",
            ownedTurns: [],
            provider: "claude",
            materialization: { ...context!.materialization!, state: "RESERVED", initHash: null },
          };
          await onCreated(candidate);
          check();
          return candidate;
        };
        return adapter;
      };
      const adapter = selectedAdapter();
      const replacement = f.runner(adapter, {
        beforeMutation: async (kind) => {
          if (boundary === "finalize" && kind === "prepare-finalize" && !failed) {
            failed = true;
            throw new RuntimeError("UNSAFE_STORAGE");
          }
        },
      });
      const input = {
        choice: "default" as const,
        files: ["public.txt"],
        handoff: "Selected replacement",
        confirmed: true as const,
        autoQuestionsConfirmed: false,
      };
      if (boundary.startsWith("archive-")) {
        const method = boundary === "archive-save" ? "save" : "verify";
        const original = RuntimeArchive.prototype[method];
        const injected = mock.method(
          RuntimeArchive.prototype,
          method,
          async function (this: RuntimeArchive, ...args: Parameters<typeof original>) {
            if (!failed && (method === "save" || (args[0] as unknown[]).length > 0)) {
              failed = true;
              throw new RuntimeError("UNSAFE_STORAGE");
            }
            return (original as (...input: unknown[]) => Promise<unknown>).apply(this, args);
          },
        );
        try {
          await assert.rejects(replacement.prepare(input), { code: "UNSAFE_STORAGE" });
        } finally {
          injected.mock.restore();
        }
        const retained = (await f.store.read())!;
        assert.deepEqual(retained.attempts[0], previous);
        assert.deepEqual(retained.settings, settings);
        assert.deepEqual(retained.context, context);
        assert.equal(f.requests.filter((request) => request.action === "replace").length, 0);
        await f.runner(selectedAdapter()).prepare(input);
      } else if (boundary === "finalize") {
        await assert.rejects(replacement.prepare(input));
        assert.equal((await f.store.read())!.preparation!.state, "REPLACE_PENDING");
        await f.runner(selectedAdapter()).prepare(input);
      } else await replacement.prepare(input);
      const after = (await f.store.read())!;
      assert.equal(after.scope.bindingEpoch, 2);
      assert.equal(after.settings!.repositoryAccess, undefined);
      assert.notEqual(after.context!.generation, context!.generation);
      const archiveFile = `${f.store.dir}/archives/${f.store.agentId}/${after.archives![0].hash}.json`;
      const archiveBytes = await readFile(archiveFile);
      assert.equal(digest(archiveBytes), after.archives![0].hash);
      const archived = [
        JSON.parse(archiveBytes.toString()) as import("../src/runtime-contracts.ts").RuntimeRecord,
      ];
      const original = archived.find((record) =>
        record.attempts.some((attempt) => attempt.requestId === previous.requestId),
      )!;
      assert.ok(original);
      assert.deepEqual(original.attempts[0], previous);
      assert.deepEqual(original.settings, settings);
      assert.deepEqual(original.context, context);
      assert.deepEqual(await f.store.lastAttempt(after), previous);
      assert.deepEqual(await f.store.read(), after);
      assert.deepEqual(await f.store.compact(after), after);
      assert.deepEqual(await readFile(archiveFile), archiveBytes);
      assert.equal(digest(await readFile(archiveFile)), after.archives![0].hash);
      const forged = structuredClone(after);
      forged.settings!.files = [];
      forged.settings!.repositoryAccess = settings!.repositoryAccess;
      await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
      assert.equal(f.requests.filter((request) => request.action === "replace").length, 1);
      assert.equal(h.native.writes.length, 1);
      assert.equal(h.native.replies.length, 1);
    } finally {
      await h.close();
      await f.close();
    }
  });
