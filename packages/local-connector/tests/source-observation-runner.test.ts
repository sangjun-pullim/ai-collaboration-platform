import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, open, readFile, rename, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { runnerFixture, SyntheticAdapter, deferred } from "./runner-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { uuid, observation } from "./runtime-fixture.ts";
import {
  RuntimeError,
  digest,
  stableJson,
  type AttemptAuthority,
  type RuntimeSettings,
  type NativeInputIntent,
  type TerminalEvidence,
  type RuntimeRecord,
} from "../src/runtime-contracts.ts";
import type { RequestPayload } from "../src/workflow-contracts.ts";
import { RuntimeFilePolicy } from "../src/runtime-file-policy.ts";
import {
  sourceObservationReserveBytes,
  type SourceGitExecutor,
} from "../src/workflow/source-snapshot.ts";
import { admissionReserveBytes } from "../src/runtime-store.ts";

class SourceAdapter extends SyntheticAdapter {
  onBefore: () => Promise<void> = async () => {};
  onCommitted: () => Promise<void> = async () => {};
  duplicate = false;
  override async execute(
    authority: AttemptAuthority,
    settings: RuntimeSettings,
    payload: RequestPayload,
    beforeSubmit: (intent?: NativeInputIntent) => Promise<void>,
  ): Promise<TerminalEvidence> {
    this.current = authority;
    await this.onBefore();
    const intent: NativeInputIntent | undefined =
      settings.provider === "claude"
        ? {
            provider: "claude",
            sessionId: authority.context.threadId,
            inputId: uuid(),
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
    await this.onCommitted();
    if (this.duplicate) await assert.rejects(beforeSubmit(intent), { code: "UNKNOWN" });
    this.starts++;
    const turnId = intent?.inputId ?? uuid();
    await authority.ack(authority.context.threadId, turnId, intent ? digest("init") : undefined);
    this.observed = {
      threadId: authority.context.threadId,
      turnId,
      terminal: "COMPLETED",
      privateText: "Synthetic conclusion",
      publicText: "Synthetic conclusion",
      finalItems: [{ id: "final", hash: digest("Synthetic conclusion") }],
      textProof: "FINAL_ANSWER",
      observation: observation(settings),
      ...(intent ? { nativeInitHash: digest("init") } : {}),
    };
    return this.observed;
  }
}
const unavailable: SourceGitExecutor = async () => {
  throw new Error("unavailable");
};

test("should durably store one source observation with each provider intent before mocked native input", async () => {
  for (const provider of ["codex", "claude"] as const) {
    let git = 0;
    const f = await runnerFixture(
      {
        sourceGitExecutor: async (...args) => {
          git++;
          return unavailable(...args);
        },
      },
      provider === "claude" ? (r) => Object.assign(r, claudeRecord(r)) : undefined,
    );
    const adapter = new SourceAdapter();
    adapter.duplicate = true;
    try {
      adapter.onCommitted = async () => {
        const disk = (await f.store.read())!,
          a = disk.attempts[0];
        assert.equal(a.state, "PROVIDER_INTENT");
        assert.ok(a.sourceObservation);
        assert.equal(a.sourceObservation.git.commit, null);
        assert.deepEqual(
          a.sourceObservation.files.entries,
          f.settings.files.map(({ path, hash }) => ({ path, hash })),
        );
        assert.equal(a.native, null);
        assert.equal(adapter.starts, 0);
        if (provider === "claude") assert.ok(a.nativeIntent);
        else assert.equal(a.nativeIntent, undefined);
      };
      f.queue();
      assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
      assert.equal(adapter.starts, 1);
      assert.equal(git, 3);
      const disk = (await f.store.read())!;
      assert.ok(disk.attempts[0].sourceObservation);
      assert.equal(
        JSON.stringify(f.requests.map((r) => r.body)).includes("sourceObservation"),
        false,
      );
    } finally {
      await f.close();
    }
  }
});

test("should send no Git child or native input after root replacement before collection", async () => {
  let git = 0;
  const f = await runnerFixture({
      sourceGitExecutor: async (...args) => {
        git++;
        return unavailable(...args);
      },
    }),
    adapter = new SourceAdapter();
  try {
    adapter.onBefore = async () => {
      await rename(f.root, `${f.root}.saved`);
      await mkdir(f.root);
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UNKNOWN");
    assert.equal(adapter.starts, 0);
    assert.equal(git, 0);
    assert.equal((await f.store.read())!.attempts[0].sourceObservation, undefined);
  } finally {
    await f.close();
  }
});

test("should refuse native input on file changes authority loss or provider-intent write failure", async () => {
  for (const fault of ["file", "authority", "write"]) {
    const f = await runnerFixture({
        sourceGitExecutor: unavailable,
        beforeMutation: async (kind) => {
          if (fault === "write" && kind === "provider-intent")
            throw new RuntimeError("UNSAFE_STORAGE");
        },
      }),
      adapter = new SourceAdapter(),
      runner = f.runner(adapter);
    try {
      adapter.onBefore = async () => {
        if (fault === "file") await writeFile(join(f.root, "public.txt"), "changed evidence");
        if (fault === "authority") runner.stop();
      };
      f.queue();
      assert.equal((await runner.run({ once: true })).state, "UNKNOWN");
      assert.equal(adapter.starts, 0);
      assert.equal((await f.store.read())!.attempts[0].sourceObservation, undefined);
    } finally {
      await f.close();
    }
  }
});

test("should adopt committed source observation after directory sync failure while submitting no native input", async () => {
  let armed = false,
    failures = 0;
  const f = await runnerFixture({
      sourceGitExecutor: unavailable,
      beforeMutation: async (kind) => {
        if (kind === "provider-intent") armed = true;
      },
    }),
    adapter = new SourceAdapter();
  const owned = await lstat(f.store.dir),
    probe = await open(f.store.file, "r"),
    prototype = Object.getPrototypeOf(probe) as FileHandle,
    original = prototype.sync;
  await probe.close();
  const replacement = mock.method(prototype, "sync", async function (this: FileHandle) {
    const stat = await this.stat();
    if (armed && failures === 0 && stat.ino === owned.ino && stat.dev === owned.dev) {
      armed = false;
      failures++;
      throw new Error("SYNTHETIC_source_directory_sync");
    }
    return original.call(this);
  });
  try {
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UNKNOWN");
    assert.equal(failures, 1);
    assert.equal(adapter.starts, 0);
    const disk = (await f.store.read())!;
    assert.ok(disk.attempts[0].sourceObservation);
    assert.equal(disk.attempts[0].native, null);
    assert.equal(disk.attempts[0].state, "UNKNOWN");
    const saved = disk.attempts[0].sourceObservation;
    await f.runner(adapter).observe();
    assert.deepEqual((await f.store.read())!.attempts[0].sourceObservation, saved);
  } finally {
    replacement.mock.restore();
    await f.close();
  }
});

test("should keep source capacity through provider save and replace only its own reservation after disk commit", async () => {
  const f = await runnerFixture({ sourceGitExecutor: unavailable }),
    adapter = new SourceAdapter(),
    runner = f.runner(adapter);
  const internal = runner as unknown as {
    capacityReservations: Map<string, number>;
    record: RuntimeRecord;
    assertOrdinaryCapacity(record?: RuntimeRecord): void;
  };
  let sourceKey = "";
  try {
    adapter.onBefore = async () => {
      sourceKey = [...internal.capacityReservations.keys()].find((k) => k.startsWith("source:"))!;
      assert.ok(sourceKey);
      assert.equal(
        internal.capacityReservations.get(sourceKey),
        sourceObservationReserveBytes(f.settings.files),
      );
      internal.capacityReservations.set("synthetic-held-lease", 131072);
      internal.capacityReservations.set("synthetic-held-ready", 1024);
    };
    adapter.onCommitted = async () => {
      assert.equal(internal.capacityReservations.has(sourceKey), false);
      assert.equal(internal.capacityReservations.get("synthetic-held-lease"), 131072);
      assert.equal(internal.capacityReservations.get("synthetic-held-ready"), 1024);
      assert.deepEqual(
        internal.record.attempts[0].sourceObservation,
        (await f.store.read())!.attempts[0].sourceObservation,
      );
    };
    f.queue();
    assert.equal((await runner.run({ once: true })).state, "UPLOADED");
    assert.equal(adapter.starts, 1);
  } finally {
    await f.close();
  }
});

test("should block claim before source capacity exceeds admission space and admit a small selection", async () => {
  for (const large of [false, true]) {
    const f = await runnerFixture({ sourceGitExecutor: unavailable }),
      adapter = new SourceAdapter();
    try {
      if (large) {
        // Safe small contents with maximally escaped permitted selected paths.
        const paths = Array.from(
          { length: 32 },
          (_, i) =>
            `${i.toString().padStart(2, "0")}/${"\u0001".repeat(170)}/${"\u0002".repeat(170)}/${"\u0003".repeat(167)}`,
        );
        for (const path of paths) {
          await mkdir(join(f.root, path.slice(0, path.lastIndexOf("/"))), { recursive: true });
          await writeFile(join(f.root, path), "evidence");
        }
        const policy = await RuntimeFilePolicy.select(f.root, paths);
        f.record.settings!.files = [...policy.files];
        // Existing historical private evidence fills ordinary retained capacity without fake selected bytes.
        f.record.settings!.handoff = "x".repeat(65536);
        const bytes = Buffer.byteLength(JSON.stringify(f.record));
        assert.ok(bytes + admissionReserveBytes < 2 * 1024 * 1024);
        assert.ok(
          bytes + admissionReserveBytes + sourceObservationReserveBytes(policy.files) >
            2 * 1024 * 1024,
        );
        await f.store.write(f.record);
      }
      f.queue();
      if (large) {
        await assert.rejects(f.runner(adapter).run({ once: true }), { code: "RUNTIME_CAPACITY" });
        assert.equal((await f.store.read())!.ready, false);
        assert.equal(adapter.starts, 0);
        assert.equal(f.requests.filter((r) => r.action === "claim").length, 0);
      } else {
        assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
        assert.equal(adapter.starts, 1);
      }
    } finally {
      await f.close();
    }
  }
});

test("should preserve observation across outbox retry archive restart and source changes without recollection", async () => {
  let git = 0;
  const f = await runnerFixture({
      sourceGitExecutor: async (...args) => {
        git++;
        return unavailable(...args);
      },
    }),
    adapter = new SourceAdapter();
  try {
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "complete") response.destroy();
    };
    f.queue();
    await f.runner(adapter).run({ once: true });
    const before = (await f.store.read())!,
      saved = before.attempts[0].sourceObservation,
      operation = before.operations.find((o) => o.action === "complete")!;
    assert.ok(saved);
    assert.equal(git, 3);
    assert.equal(adapter.starts, 1);
    await writeFile(join(f.root, "public.txt"), "later file evidence");
    f.faults.after = undefined;
    await f.runner(adapter).run({ once: true });
    const after = (await f.store.read())!;
    assert.deepEqual(after.attempts[0].sourceObservation, saved);
    assert.equal(git, 3);
    assert.equal(adapter.starts, 1);
    const retries = f.requests.filter((r) => r.action === "complete");
    assert.ok(retries.length >= 2);
    assert.deepEqual(retries.at(-1)!.body, operation.body);
    const original = await readFile(f.store.file),
      compact = await f.store.compact(after);
    assert.equal(compact.attempts.length, 0);
    assert.deepEqual((await f.store.lastAttempt(compact))!.sourceObservation, saved);
    assert.deepEqual(
      await readFile(join(f.store.dir, "archives", f.scope.agentId, `${digest(original)}.json`)),
      original,
    );
  } finally {
    await f.close();
  }
});

test("should continue an already claimed input after its new-input pause is enabled", async () => {
  const f = await runnerFixture({ sourceGitExecutor: unavailable }),
    adapter = new SourceAdapter();
  try {
    adapter.onBefore = async () => {
      f.pauseInput(true);
    };
    f.queue();
    assert.equal((await f.runner(adapter).run({ once: true })).state, "UPLOADED");
    assert.equal(adapter.starts, 1);
    assert.ok((await f.store.read())!.attempts[0].sourceObservation);
  } finally {
    await f.close();
  }
});

for (const committed of [false, true]) {
  test(`should retain source reservation until owned disk proof on provider write fault ${committed}`, async () => {
    const f = await runnerFixture({ sourceGitExecutor: unavailable }),
      adapter = new SourceAdapter(),
      runner = f.runner(adapter);
    const internal = runner as unknown as {
      capacityReservations: Map<string, number>;
      record: RuntimeRecord;
    };
    const original = f.store.write.bind(f.store);
    let reached = false;
    const replacement = mock.method(
      f.store,
      "write",
      async (next: RuntimeRecord, check?: () => void) => {
        if (!reached && next.attempts.at(-1)?.state === "PROVIDER_INTENT") {
          reached = true;
          const key = [...internal.capacityReservations.keys()].find((k) =>
            k.startsWith("source:"),
          )!;
          assert.equal(
            internal.capacityReservations.get(key),
            sourceObservationReserveBytes(f.settings.files),
          );
          assert.equal((await f.store.read())!.attempts.at(-1)!.sourceObservation, undefined);
          if (committed) {
            await original(next, check);
            assert.equal(
              internal.capacityReservations.get(key),
              sourceObservationReserveBytes(f.settings.files),
            );
          }
          throw new RuntimeError("UNSAFE_STORAGE");
        }
        if (reached && next.attempts.at(-1)?.state === "UNKNOWN") {
          assert.equal(!!internal.record.attempts.at(-1)!.sourceObservation, committed);
          assert.deepEqual(internal.record, await f.store.read());
        }
        return original(next, check);
      },
    );
    try {
      f.queue();
      assert.equal((await runner.run({ once: true })).state, "UNKNOWN");
      assert.equal(reached, true);
      assert.equal(adapter.starts, 0);
      assert.equal(!!(await f.store.read())!.attempts.at(-1)!.sourceObservation, committed);
    } finally {
      replacement.mock.restore();
      await f.close();
    }
  });
}

test("should preserve input admission after an in-flight monitor lookup completes after source-backed upload", async () => {
  const f = await runnerFixture({ sourceGitExecutor: unavailable, pollIntervalMs: 5 }),
    adapter = new SourceAdapter(),
    runner = f.runner(adapter);
  let resolveEntered!: () => void, resolveRelease!: () => void;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  let armed = false,
    held = false;
  f.faults.before = async (action) => {
    if (action === "admission" && armed && !held) {
      held = true;
      resolveEntered();
      await release;
    }
  };
  adapter.onCommitted = async () => {
    armed = true;
    await entered;
  };
  const wait = async (predicate: () => Promise<boolean> | boolean) => {
    const deadline = performance.now() + 3000;
    while (!(await predicate())) {
      if (performance.now() >= deadline)
        throw new Error("SYNTHETIC_SOURCE_ADMISSION_DID_NOT_SETTLE");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  let running: Promise<unknown> | undefined;
  try {
    f.queue();
    running = runner.run();
    void running.catch(() => {});
    await wait(
      async () => (await f.store.read().catch(() => undefined))?.attempts[0]?.state === "UPLOADED",
    );
    resolveRelease();
    const polls = f.requests.filter((r) => r.action === "poll").length;
    await wait(() => f.requests.filter((r) => r.action === "poll").length >= polls + 3);
    assert.ok((await f.store.read())!.attempts[0].sourceObservation);
    assert.equal(f.requests.filter((r) => r.action === "ready").length, 1);
    assert.equal(adapter.starts, 1);
  } finally {
    resolveRelease();
    runner.stop();
    await running?.catch(() => {});
    await f.close();
  }
});

for (const control of ["admission", "admission-ack", "paused-ack"] as const) {
  test(`should finish an in-flight ${control} after receipt abort before source-backed UPLOADED persistence`, async () => {
    const f = await runnerFixture({ sourceGitExecutor: unavailable, pollIntervalMs: 5 }),
      adapter = new SourceAdapter(),
      runner = f.runner(adapter);
    let enterControl!: () => void,
      releaseControl!: () => void,
      enterUpload!: () => void,
      releaseUpload!: () => void;
    const controlEntered = new Promise<void>((r) => {
      enterControl = r;
    });
    const controlRelease = new Promise<void>((r) => {
      releaseControl = r;
    });
    const uploadEntered = new Promise<void>((r) => {
      enterUpload = r;
    });
    const uploadRelease = new Promise<void>((r) => {
      releaseUpload = r;
    });
    let armed = false,
      held = false;
    f.faults.before = async (action) => {
      if (action === (control === "paused-ack" ? "admission-ack" : control) && armed && !held) {
        held = true;
        enterControl();
        await controlRelease;
      }
    };
    adapter.onCommitted = async () => {
      armed = true;
      if (control !== "admission") {
        f.pauseInput(true);
        if (control === "admission-ack") f.pauseInput(false);
      }
      await controlEntered;
    };
    const original = f.store.write.bind(f.store);
    const replacement = mock.method(
      f.store,
      "write",
      async (next: RuntimeRecord, check?: () => void) => {
        if (next.attempts.at(-1)?.state === "UPLOADED") {
          enterUpload();
          await uploadRelease;
        }
        return original(next, check);
      },
    );
    const internal = runner as unknown as {
      inputAdmission: { allowed: boolean; work?: Promise<boolean> };
    };
    let running: Promise<unknown> | undefined;
    try {
      f.queue();
      running = runner.run({ once: true });
      void running.catch(() => {});
      await uploadEntered;
      assert.equal((await f.store.read())!.attempts[0].state, "TERMINAL");
      const work = internal.inputAdmission.work!;
      assert.ok(work);
      releaseControl();
      assert.equal(await work, control !== "paused-ack");
      assert.equal(internal.inputAdmission.allowed, control !== "paused-ack");
      if (control === "paused-ack") {
        assert.equal(f.inputState().paused, true);
        assert.equal(f.inputState().appliedRevision, f.inputState().revision);
      }
      releaseUpload();
      assert.equal(((await running) as { state: string }).state, "UPLOADED");
      assert.equal(adapter.starts, 1);
      assert.ok((await f.store.read())!.attempts[0].sourceObservation);
    } finally {
      releaseControl();
      releaseUpload();
      runner.stop();
      await running?.catch(() => {});
      replacement.mock.restore();
      await f.close();
    }
  });
}

for (const loss of ["stop", "epoch", "generation", "thread", "root", "active"] as const) {
  test(`should reject an in-flight input control lookup after ${loss} authority loss`, async () => {
    const f = await runnerFixture({ sourceGitExecutor: unavailable, pollIntervalMs: 5 }),
      adapter = new SourceAdapter(),
      runner = f.runner(adapter);
    let enter!: () => void, release!: () => void, finish!: () => void;
    const entered = new Promise<void>((r) => {
      enter = r;
    });
    const released = new Promise<void>((r) => {
      release = r;
    });
    const finished = new Promise<void>((r) => {
      finish = r;
    });
    let armed = false,
      held = false;
    f.faults.before = async (action) => {
      if (action === "admission" && armed && !held) {
        held = true;
        enter();
        await released;
      }
    };
    adapter.onCommitted = async () => {
      armed = true;
      await entered;
      await finished;
    };
    const internal = runner as unknown as {
      active?: AttemptAuthority;
      inputAdmission: { allowed: boolean; work?: Promise<boolean> };
    };
    let running: Promise<unknown> | undefined;
    try {
      f.queue();
      running = runner.run({ once: true });
      void running.catch(() => {});
      await entered;
      const authority = internal.active!,
        scope = structuredClone(authority.scope),
        context = structuredClone(authority.context),
        work = internal.inputAdmission.work!;
      if (loss === "stop") runner.stop();
      if (loss === "epoch") authority.scope.bindingEpoch++;
      if (loss === "generation") authority.context.generation = uuid();
      if (loss === "thread") authority.context.threadId = uuid();
      if (loss === "root") authority.context.root.ino++;
      if (loss === "active") internal.active = undefined;
      release();
      assert.equal(await work, false);
      assert.equal(internal.inputAdmission.allowed, false);
      assert.equal(adapter.starts, 0);
      authority.scope = scope;
      authority.context = context;
      internal.active = authority;
      finish();
      await running;
    } finally {
      release();
      finish();
      runner.stop();
      await running?.catch(() => {});
      await f.close();
    }
  });
}

for (const failure of ["none", "before-update", "before-write", "directory-sync"] as const) {
  test(`should settle only the paused claim source reservation after exact closure proof ${failure}`, async () => {
    let armed = false,
      reached = false,
      failures = 0;
    const f = await runnerFixture({
        sourceGitExecutor: unavailable,
        beforeMutation: async (kind) => {
          if (kind === "unstarted-closure") {
            armed = true;
            if (failure === "before-update") {
              failures++;
              throw new RuntimeError("UNSAFE_STORAGE");
            }
          }
        },
      }),
      runner = f.runner();
    const internal = runner as unknown as {
      capacityReservations: Map<string, number>;
      record: RuntimeRecord;
    };
    let sourceKey = "",
      claimId = "";
    const unrelated = new Map([
      ["held-lease", 131072],
      ["held-ready", 1024],
      ["source:other-attempt", 37],
    ]);
    f.faults.before = async (action, body) => {
      if (action === "claim") {
        f.pauseInput(true);
        claimId = String(body.operationId);
        sourceKey = `source:${claimId}`;
        assert.equal(
          internal.capacityReservations.get(sourceKey),
          sourceObservationReserveBytes(f.settings.files),
        );
        for (const [key, bytes] of unrelated) internal.capacityReservations.set(key, bytes);
      }
    };
    const originalWrite = f.store.write.bind(f.store);
    const writeMock = mock.method(
      f.store,
      "write",
      async (next: RuntimeRecord, check?: () => void) => {
        if (!reached && next.attempts.at(-1)?.unstartedClosure?.kind === "SERVER_INPUT_PAUSED") {
          reached = true;
          assert.equal(
            internal.capacityReservations.get(sourceKey),
            sourceObservationReserveBytes(f.settings.files),
          );
          assert.equal(internal.capacityReservations.get(claimId), 131072);
          if (failure === "before-write") {
            failures++;
            throw new RuntimeError("UNSAFE_STORAGE");
          }
        }
        return originalWrite(next, check);
      },
    );
    const owned = await lstat(f.store.dir),
      probe = await open(f.store.file, "r"),
      prototype = Object.getPrototypeOf(probe) as FileHandle,
      originalSync = prototype.sync;
    await probe.close();
    const syncMock = mock.method(prototype, "sync", async function (this: FileHandle) {
      const stat = await this.stat();
      if (
        failure === "directory-sync" &&
        armed &&
        failures === 0 &&
        stat.ino === owned.ino &&
        stat.dev === owned.dev
      ) {
        failures++;
        armed = false;
        throw new Error("SYNTHETIC_paused_closure_directory_sync");
      }
      return originalSync.call(this);
    });
    try {
      f.queue();
      const status = await runner.run({ once: true }),
        disk = (await f.store.read())!,
        attempt = disk.attempts[0];
      assert.equal(reached, failure !== "before-update");
      assert.equal(f.adapter.starts, 0);
      assert.equal(attempt.sourceObservation, undefined);
      assert.equal(failures, failure === "none" ? 0 : 1);
      assert.equal(
        status.state,
        failure === "before-write" || failure === "before-update" ? "UNKNOWN" : "NOT_STARTED",
      );
      assert.equal(
        disk.operations.find((o) => o.operationId === claimId)!.state,
        failure === "before-write" || failure === "before-update" ? "TRANSMITTED" : "CLOSED",
      );
      if (failure === "before-write" || failure === "before-update") {
        assert.equal(
          internal.capacityReservations.get(sourceKey),
          sourceObservationReserveBytes(f.settings.files),
        );
        assert.equal(internal.capacityReservations.get(claimId), 131072);
      } else {
        assert.deepEqual(attempt.unstartedClosure, {
          kind: "SERVER_INPUT_PAUSED",
          claimOperationId: claimId,
        });
        assert.equal(internal.capacityReservations.has(sourceKey), false);
        assert.equal(internal.capacityReservations.has(claimId), false);
      }
      for (const [key, bytes] of unrelated)
        assert.equal(internal.capacityReservations.get(key), bytes);
      assert.deepEqual(internal.record, disk);
    } finally {
      syncMock.mock.restore();
      writeMock.mock.restore();
      await f.close();
    }
  });
}

test("should keep only the fresh source reservation after two paused claims resume in the same runner", async () => {
  let git = 0,
    claims = 0;
  const f = await runnerFixture({
      sourceGitExecutor: async (...args) => {
        git++;
        return unavailable(...args);
      },
      pollIntervalMs: 5,
    }),
    runner = f.runner();
  const internal = runner as unknown as {
    capacityReservations: Map<string, number>;
    record: RuntimeRecord;
  };
  const third = deferred(),
    releaseThird = deferred(),
    completed = deferred(),
    releaseCompleted = deferred();
  const denied: string[] = [];
  const unrelated = new Map([
    ["held-lease", 131072],
    ["held-ready", 1024],
    ["source:other-attempt", 37],
  ]);
  f.faults.before = async (action, body) => {
    if (action === "claim") {
      claims++;
      if (claims <= 2) {
        denied.push(String(body.operationId));
        f.pauseInput(true);
        if (claims === 1)
          for (const [key, bytes] of unrelated) internal.capacityReservations.set(key, bytes);
      } else {
        third.resolve();
        await releaseThird.promise;
      }
    }
    if (action === "poll" && internal.record.attempts.at(-1)?.state === "UPLOADED") {
      completed.resolve();
      await releaseCompleted.promise;
    }
  };
  f.faults.after = async (action, _body, result) => {
    if (action === "claim" && (result as { claimDenied?: string }).claimDenied === "INPUT_PAUSED")
      f.pauseInput(false);
  };
  let running: Promise<unknown> | undefined;
  try {
    f.queue();
    running = runner.run({ once: false });
    void running.catch(() => {});
    await third.promise;
    const attempts = internal.record.attempts,
      fresh = attempts.at(-1)!,
      expected = `source:${fresh.claimOperationId}`;
    assert.equal(claims, 3);
    assert.equal(denied.length, 2);
    assert.equal(f.adapter.starts, 0);
    assert.equal(git, 0);
    assert.deepEqual(
      [...internal.capacityReservations.keys()].filter(
        (k) => k.startsWith("source:") && k !== "source:other-attempt",
      ),
      [expected],
    );
    for (const key of denied) {
      assert.equal(internal.capacityReservations.has(`source:${key}`), false);
      assert.equal(internal.capacityReservations.has(key), false);
      const closed = attempts.find((a) => a.claimOperationId === key)!;
      assert.equal(closed.state, "NOT_STARTED");
      assert.deepEqual(closed.unstartedClosure, {
        kind: "SERVER_INPUT_PAUSED",
        claimOperationId: key,
      });
    }
    for (const [key, bytes] of unrelated)
      assert.equal(internal.capacityReservations.get(key), bytes);
    const closures = structuredClone(attempts.slice(0, 2));
    releaseThird.resolve();
    await completed.promise;
    assert.equal(f.adapter.starts, 1);
    assert.equal(git, 3);
    assert.equal(internal.record.attempts.at(-1)!.state, "UPLOADED");
    assert.deepEqual(internal.record.attempts.slice(0, 2), closures);
  } finally {
    releaseThird.resolve();
    releaseCompleted.resolve();
    runner.stop();
    await running?.catch(() => {});
    await f.close();
  }
});

test("should reject mismatched or missing paused closure records before releasing its source reservation", async () => {
  const f = await runnerFixture({ sourceGitExecutor: unavailable }),
    runner = f.runner();
  const internal = runner as unknown as {
    capacityReservations: Map<string, number>;
    commitCapacityReservation(
      record: RuntimeRecord,
      reservation?: { operationId: string; remaining(record: RuntimeRecord): number | undefined },
    ): void;
  };
  let key = "",
    checked = 0;
  f.faults.before = async (action, body) => {
    if (action === "claim") {
      key = String(body.operationId);
      f.pauseInput(true);
    }
  };
  const original = internal.commitCapacityReservation.bind(internal);
  const replacement = mock.method(
    internal,
    "commitCapacityReservation",
    (
      record: RuntimeRecord,
      reservation?: { operationId: string; remaining(record: RuntimeRecord): number | undefined },
    ) => {
      if (reservation?.operationId === `source:${key}`) {
        checked++;
        assert.equal(
          internal.capacityReservations.get(reservation.operationId),
          sourceObservationReserveBytes(f.settings.files),
        );
        assert.equal(reservation.remaining(record), 0);
        // Probe the pure proof predicate on copies; owned disk and original record stay unchanged.
        for (const alter of [
          (bad: RuntimeRecord) => {
            bad.attempts.find((a) => a.claimOperationId === key)!.reason = "UNKNOWN";
          },
          (bad: RuntimeRecord) => {
            bad.operations.find((o) => o.operationId === key)!.payloadHash =
              digest("different claim");
          },
          (bad: RuntimeRecord) => {
            bad.attempts = bad.attempts.filter((a) => a.claimOperationId !== key);
          },
          (bad: RuntimeRecord) => {
            bad.operations = bad.operations.filter((o) => o.operationId !== key);
          },
          (bad: RuntimeRecord) => {
            bad.attempts.push(
              structuredClone(bad.attempts.find((a) => a.claimOperationId === key)!),
            );
          },
          (bad: RuntimeRecord) => {
            bad.operations.push(
              structuredClone(bad.operations.find((o) => o.operationId === key)!),
            );
          },
        ]) {
          const bad = structuredClone(record);
          alter(bad);
          assert.equal(reservation.remaining(bad), undefined);
          assert.equal(
            internal.capacityReservations.get(reservation.operationId),
            sourceObservationReserveBytes(f.settings.files),
          );
        }
      }
      return original(record, reservation);
    },
  );
  try {
    f.queue();
    assert.equal((await runner.run({ once: true })).state, "NOT_STARTED");
    assert.equal(checked, 1);
    assert.equal(internal.capacityReservations.has(`source:${key}`), false);
    assert.equal(f.adapter.starts, 0);
  } finally {
    replacement.mock.restore();
    await f.close();
  }
});
