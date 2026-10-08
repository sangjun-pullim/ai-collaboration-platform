import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  RuntimeError,
  digest,
  stableJson,
  type NativeInterruption,
  type NativeInputIntent,
  type RuntimeRecord,
} from "../src/runtime-contracts.ts";
import { runtimeFixture, appendFixtureCompletion, uuid, observation } from "./runtime-fixture.ts";

import { claudeRecord } from "./provider-runtime-fixture.ts";

test("should preserve legacy Codex records without rewriting their format", async () => {
  const f = await runtimeFixture();
  try {
    await f.store.write(f.record);
    const before = await readFile(f.store.file);
    const restored = (await f.store.read())!;
    assert.equal(restored.version, 1);
    assert.deepEqual(restored, f.record);
    await f.store.write(restored);
    assert.deepEqual(await readFile(f.store.file), before);
  } finally {
    await f.close();
  }
});

test("should store an explicit Claude reservation with unavailable effort as null", async () => {
  const f = await runtimeFixture();
  try {
    const expected = claudeRecord(f.record);
    await f.store.write(expected);
    assert.deepEqual(await f.store.read(), expected);
  } finally {
    await f.close();
  }
});

test("should reject Claude settings disguised as legacy Codex or without an owned reservation", async () => {
  const f = await runtimeFixture();
  try {
    for (const change of [
      (value: Record<string, unknown>) => {
        value.version = 1;
      },
      (value: Record<string, unknown>) => {
        delete (value.context as Record<string, unknown>).materialization;
      },
      (value: Record<string, unknown>) => {
        (value.settings as Record<string, unknown>).provider = "codex";
      },
      (value: Record<string, unknown>) => {
        const context = value.context as Record<string, unknown>;
        (context.materialization as Record<string, unknown>).state = "MATERIALIZED";
      },
    ]) {
      const value = claudeRecord(f.record) as unknown as Record<string, unknown>;
      change(value);
      await assert.rejects(
        async () => f.store.write(value as unknown as RuntimeRecord),
        (error: unknown) => error instanceof RuntimeError && error.code === "UNSAFE_STORAGE",
      );
    }
  } finally {
    await f.close();
  }
});

import { interruptionProof } from "./claude-runtime-fixture.ts";

function interruptedRecord(source: RuntimeRecord) {
  const record = claudeRecord(source),
    context = record.context!;
  const requestId = uuid(),
    attemptId = uuid(),
    inputId = uuid();
  const payload = {
    requestId,
    cycleId: uuid(),
    agentId: record.scope.agentId,
    bindingEpoch: record.scope.bindingEpoch,
    roomRevision: 1,
    requestKind: "ORIGIN" as const,
    questionId: null,
    publicText: "Synthetic interrupt fixture",
    replyText: null,
    deadline: new Date(Date.now() + 120000).toISOString(),
  };
  const snapshot = {
    requestId,
    attemptId,
    agentId: record.scope.agentId,
    bindingEpoch: record.scope.bindingEpoch,
    fence: 1,
    state: "EXECUTING" as const,
    leaseExpiresAt: payload.deadline,
    startIntentAt: new Date().toISOString(),
    payload,
  };
  const intent: NativeInputIntent = {
    provider: "claude",
    sessionId: context.threadId,
    inputId,
    promptHash: digest("owned prompt"),
    generation: context.generation,
    scope: structuredClone(record.scope),
    attemptId,
    fence: 1,
    policyFingerprint: context.materialization!.policyFingerprint,
  };
  context.materialization = {
    ...context.materialization!,
    state: "MATERIALIZED",
    initHash: digest("owned init"),
  };
  record.attempts.push({
    requestId,
    scope: structuredClone(record.scope),
    generation: context.generation,
    state: "ACKNOWLEDGED",
    snapshot,
    native: { threadId: intent.sessionId, turnId: inputId },
    nativeIntent: intent,
    terminal: null,
    receipt: null,
    reason: null,
    toolCalls: [],
  });
  const operationId = uuid(),
    body = {
      protocol: 1,
      agentId: record.scope.agentId,
      bindingEpoch: record.scope.bindingEpoch,
      operationId,
      requestId,
      attemptId,
      fence: 1,
    };
  record.operations.push({
    operationId,
    action: "start-intent",
    body,
    payloadHash: digest(stableJson({ action: "start-intent", body })),
    state: "CONFIRMED",
    result: snapshot,
  });
  return record;
}
function closeInterrupted(record: RuntimeRecord) {
  const a = record.attempts[0],
    intent = a.nativeIntent!;
  a.state = "TERMINAL";
  a.terminal = {
    threadId: intent.sessionId,
    turnId: intent.inputId,
    terminal: "INTERRUPTED",
    privateText: "",
    publicText: "",
    finalItems: [{ id: uuid(), hash: digest("owned abort") }],
    textProof: "UNCONFIRMED",
    observation: observation(record.settings!),
    nativeInitHash: record.context!.materialization!.initHash!,
    ...(a.nativeInterruption ? { nativeInterruption: structuredClone(a.nativeInterruption) } : {}),
    ...(a.toolCancellations ? { toolCancellations: structuredClone(a.toolCancellations) } : {}),
  };
  record.context!.ownedTurns.push({
    turnId: intent.inputId,
    terminal: "INTERRUPTED",
    promptHash: intent.promptHash,
    resultHash: a.terminal.finalItems[0].hash,
    toolReceipts: [],
    ...(a.nativeInterruption ? { nativeInterruption: structuredClone(a.nativeInterruption) } : {}),
    ...(a.toolCancellations ? { toolCancellations: structuredClone(a.toolCancellations) } : {}),
  });
  record.context!.level = "L2";
}

for (const state of ["VERIFIED", "UNVERIFIED"] as const) {
  test(`should retain immutable ${state} native history evidence with its completed terminal`, async () => {
    const f = await runtimeFixture();
    try {
      const record = interruptedRecord(f.record);
      closeInterrupted(record);
      const evidence: import("../src/runtime-contracts.ts").NativeHistoryEvidence =
        state === "VERIFIED"
          ? {
              state,
              format: "claude-jsonl-v1",
              recordCount: 2,
              prefixHash: digest("native-prefix"),
            }
          : { state, reason: "HISTORY_REJECTED" };
      record.attempts[0].terminal!.terminal = "COMPLETED";
      record.context!.ownedTurns[0].terminal = "COMPLETED";
      record.attempts[0].terminal!.nativeHistory = structuredClone(evidence);
      record.context!.ownedTurns[0].nativeHistory = structuredClone(evidence);
      await f.store.write(record);
      assert.deepEqual(await f.store.read(), record);
      const replaced = structuredClone(record);
      replaced.attempts[0].terminal!.nativeHistory = {
        state: "UNVERIFIED",
        reason: "MISSING_HISTORY",
      };
      replaced.context!.ownedTurns[0].nativeHistory = structuredClone(
        replaced.attempts[0].terminal!.nativeHistory,
      );
      await assert.rejects(async () => f.store.write(replaced), { code: "UNSAFE_STORAGE" });
      const mismatch = structuredClone(record);
      delete mismatch.context!.ownedTurns[0].nativeHistory;
      await assert.rejects(async () => f.store.write(mismatch), { code: "UNSAFE_STORAGE" });
    } finally {
      await f.close();
    }
  });
}

test("should reject native history evidence in legacy and Codex terminal locations", async () => {
  for (const version of [1, 2] as const) {
    const f = await runtimeFixture();
    try {
      appendFixtureCompletion(f.record);
      if (version === 2) {
        Object.assign(f.record, { version: 2 });
        Object.assign(f.record.settings!.capabilities, { runtime: "codex" });
        const { capabilityHash } = await import("../src/settings/contracts.ts");
        const { snapshotHash: oldHash, ...contents } = f.record.settings!.capabilities;
        void oldHash;
        f.record.settings!.capabilities.snapshotHash = capabilityHash({
          ...contents,
          runtime: "codex",
          policy: "verified",
        });
      }
      await f.store.write(f.record);
      assert.deepEqual(await f.store.read(), f.record);
      for (const location of ["terminal", "closed"] as const) {
        const forged = structuredClone(f.record);
        const nativeHistory = { state: "UNVERIFIED" as const, reason: "MISSING_HISTORY" as const };
        if (location === "terminal") forged.attempts[0].terminal!.nativeHistory = nativeHistory;
        else forged.context!.ownedTurns[0].nativeHistory = nativeHistory;
        await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
      }
    } finally {
      await f.close();
    }
  }
});

test("should preserve v1 bytes and reject interruption fields in every legacy evidence location", async () => {
  const f = await runtimeFixture();
  try {
    const attempt = appendFixtureCompletion(f.record);
    await f.store.write(f.record);
    const before = await readFile(f.store.file);
    await f.store.write((await f.store.read())!);
    assert.deepEqual(await readFile(f.store.file), before);
    const intent: NativeInputIntent = {
      provider: "claude",
      sessionId: f.context.threadId,
      inputId: attempt.native!.turnId,
      promptHash: digest("legacy"),
      generation: f.context.generation,
      scope: f.scope,
      attemptId: attempt.snapshot!.attemptId,
      fence: 1,
      policyFingerprint: digest("policy"),
    };
    for (const location of ["journal", "terminal", "closed"] as const) {
      const forged = structuredClone(f.record),
        proof = interruptionProof(intent);
      if (location === "journal") forged.attempts[0].nativeInterruption = proof;
      if (location === "terminal") forged.attempts[0].terminal!.nativeInterruption = proof;
      if (location === "closed") forged.context!.ownedTurns[0].nativeInterruption = proof;
      await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
      assert.deepEqual(await readFile(f.store.file), before);
    }
  } finally {
    await f.close();
  }
});

test("should reject receipt without intent foreign descriptor hashes and wrong queue or input identity", async () => {
  const f = await runtimeFixture();
  try {
    const base = interruptedRecord(f.record);
    await f.store.write(base);
    const proof = interruptionProof(base.attempts[0].nativeIntent!, {
      still_queued: [],
      cancelled: [base.attempts[0].nativeIntent!.inputId],
    });
    const changes: ((p: NativeInterruption) => void)[] = [
      (p) => {
        delete (p as Partial<NativeInterruption>).intent;
      },
      (p) => {
        p.intentHash = digest("foreign intent");
      },
      (p) => {
        p.requestHash = digest("foreign request");
      },
      (p) => {
        p.intent.sessionId = uuid();
      },
      (p) => {
        p.intent.inputId = uuid();
      },
      (p) => {
        p.intent.promptHash = digest("foreign prompt");
      },
      (p) => {
        p.intent.generation = uuid();
      },
      (p) => {
        p.intent.scope.agentId = uuid();
      },
      (p) => {
        p.intent.scope.bindingEpoch++;
      },
      (p) => {
        p.intent.attemptId = uuid();
      },
      (p) => {
        p.intent.fence++;
      },
      (p) => {
        p.intent.policyFingerprint = digest("foreign policy");
      },
      (p) => {
        (p.receipt!.stillQueued as string[]).push(p.intent.inputId);
      },
      (p) => {
        p.receipt!.cancelled = [uuid()];
      },
      (p) => {
        p.receipt!.cancelled = [p.intent.inputId, p.intent.inputId];
      },
      (p) => {
        p.receipt!.cancelled = [p.intent.inputId, uuid()];
      },
      (p) => {
        p.receipt!.responseHash = digest("foreign receipt");
      },
    ];
    for (const change of changes) {
      const forged = structuredClone(base),
        altered = structuredClone(proof);
      change(altered);
      if (altered.intent && altered.intentHash === proof.intentHash)
        altered.intentHash = digest(stableJson(altered.intent));
      if (altered.receipt && altered.receipt.responseHash === proof.receipt!.responseHash)
        altered.receipt.responseHash = digest(
          stableJson({
            still_queued: altered.receipt.stillQueued,
            cancelled: altered.receipt.cancelled,
          }),
        );
      forged.attempts[0].nativeInterruption = altered;
      await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
    }
  } finally {
    await f.close();
  }
});

test("should permit one receipt append before terminal and reject deletion or replacement of saved evidence", async () => {
  const f = await runtimeFixture();
  try {
    const record = interruptedRecord(f.record),
      a = record.attempts[0];
    a.nativeInterruption = interruptionProof(a.nativeIntent!);
    await f.store.write(record);
    for (const change of [
      (p: NativeInterruption) => {
        p.intent.attemptId = uuid();
        p.intentHash = digest(stableJson(p.intent));
      },
      (p: NativeInterruption) => {
        p.requestHash = digest("replace request");
      },
    ]) {
      const altered = structuredClone(record);
      change(altered.attempts[0].nativeInterruption!);
      await assert.rejects(async () => f.store.write(altered), { code: "UNSAFE_STORAGE" });
    }
    const deleted = structuredClone(record);
    delete deleted.attempts[0].nativeInterruption;
    await assert.rejects(async () => f.store.write(deleted), { code: "UNSAFE_STORAGE" });
    a.nativeInterruption = interruptionProof(a.nativeIntent!, {
      still_queued: [],
      cancelled: [a.nativeIntent!.inputId],
    });
    await f.store.write(record);
    assert.deepEqual((await f.store.read())!.attempts[0].nativeInterruption, a.nativeInterruption);
    const noReceipt = structuredClone(record);
    delete noReceipt.attempts[0].nativeInterruption!.receipt;
    await assert.rejects(async () => f.store.write(noReceipt), { code: "UNSAFE_STORAGE" });
    const replaced = structuredClone(record);
    replaced.attempts[0].nativeInterruption = interruptionProof(a.nativeIntent!, {
      still_queued: [],
    });
    await assert.rejects(async () => f.store.write(replaced), { code: "UNSAFE_STORAGE" });
    closeInterrupted(record);
    await f.store.write(record);
    const closed = structuredClone(record);
    delete closed.context!.ownedTurns[0].nativeInterruption;
    await assert.rejects(async () => f.store.write(closed), { code: "UNSAFE_STORAGE" });
    const changedTerminal = structuredClone(record);
    delete changedTerminal.attempts[0].terminal!.nativeInterruption;
    await assert.rejects(async () => f.store.write(changedTerminal), { code: "UNSAFE_STORAGE" });
  } finally {
    await f.close();
  }
});

test("should reject receipt append after terminal and preserve already closed evidence", async () => {
  const f = await runtimeFixture();
  try {
    const record = interruptedRecord(f.record),
      a = record.attempts[0];
    a.nativeInterruption = interruptionProof(a.nativeIntent!);
    closeInterrupted(record);
    await f.store.write(record);
    const before = await readFile(f.store.file);
    const altered = structuredClone(record),
      proof = interruptionProof(a.nativeIntent!, { still_queued: [] });
    altered.attempts[0].nativeInterruption = proof;
    altered.attempts[0].terminal!.nativeInterruption = proof;
    altered.context!.ownedTurns[0].nativeInterruption = proof;
    await assert.rejects(async () => f.store.write(altered), { code: "UNSAFE_STORAGE" });
    assert.deepEqual(await readFile(f.store.file), before);
  } finally {
    await f.close();
  }
});

test("should preserve past v2 closed INTERRUPTED records and held-tool cancellations without new fields", async () => {
  for (const withCancellation of [false, true]) {
    const f = await runtimeFixture();
    try {
      const record = interruptedRecord(f.record),
        a = record.attempts[0];
      if (withCancellation) {
        const payloadHash = digest("past owned tool");
        a.toolCalls.push({
          callId: "past-held-read",
          payloadHash,
          operationId: null,
          result: null,
        });
        a.toolCancellations = [
          {
            callId: "past-held-read",
            controlId: "past-control",
            payloadHash,
            cancelHash: digest(
              stableJson({ type: "control_cancel_request", request_id: "past-control" }),
            ),
          },
        ];
      }
      closeInterrupted(record);
      await f.store.write(record);
      const before = await readFile(f.store.file),
        restored = (await f.store.read())!;
      assert.deepEqual(restored, record);
      assert.equal(restored.attempts[0].nativeInterruption, undefined);
      await f.store.write(restored);
      assert.deepEqual(await readFile(f.store.file), before);
    } finally {
      await f.close();
    }
  }
});

import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
function automaticRecord(source: RuntimeRecord) {
  const record = interruptedRecord(source);
  record.settings!.files = [];
  record.settings!.repositoryAccess = createRepositoryAccess(
    record.context!.generation,
    record.context!.root,
    uuid(),
    uuid(),
  );
  record.attempts[0].nativeIntent!.toolPolicy = {
    version: 1,
    mode: "AUTO_CODE",
    peerAllowed: false,
  };
  return record;
}
function hashed<T extends object, K extends string>(body: T, key: K): T & Record<K, string> {
  return { ...body, [key]: digest(stableJson(body)) } as T & Record<K, string>;
}
function automaticIntent(record: RuntimeRecord) {
  return hashed(
    {
      version: 1 as const,
      kind: "REPOSITORY_TOOL_INTENT" as const,
      generation: record.context!.generation,
      approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
      tool: "read_workspace_file" as const,
      argumentsHash: digest(stableJson({ path: "src/unselected.ts" })),
      createdAt: new Date().toISOString(),
    },
    "intentHash",
  ) as import("../src/runtime-contracts.ts").RepositoryToolIntent;
}
function automaticObservation(
  record: RuntimeRecord,
  result: import("../src/runtime-contracts.ts").ToolResult,
) {
  return hashed(
    {
      version: 1 as const,
      kind: "REPOSITORY_TOOL_OBSERVATION" as const,
      generation: record.context!.generation,
      approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
      tool: "read_workspace_file" as const,
      resultHash: digest(stableJson(result)),
      files: [
        {
          path: "src/unselected.ts",
          hash: digest("whole file"),
          readAt: new Date().toISOString(),
          byteStart: 0,
          byteEnd: 7,
          excerptHash: digest("excerpt"),
        },
      ],
    },
    "observationHash",
  ) as import("../src/runtime-contracts.ts").RepositoryToolObservation;
}
test("should persist automatic approval and nullable intent before immutable exact returned observation", async () => {
  const f = await runtimeFixture();
  try {
    const record = automaticRecord(f.record);
    await f.store.write(record);
    record.attempts[0].toolCalls.push({
      callId: "automatic-read",
      payloadHash: digest("trusted call"),
      operationId: null,
      result: null,
      repositoryIntent: automaticIntent(record),
    });
    await f.store.write(record);
    assert.deepEqual(await f.store.read(), record);
    const result = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "excerpt" }],
    };
    record.attempts[0].toolCalls[0].result = result;
    record.attempts[0].toolCalls[0].repositoryObservation = automaticObservation(record, result);
    await f.store.write(record);
    assert.deepEqual(await f.store.read(), record);
    for (const mutate of [
      (value: RuntimeRecord) => {
        value.settings!.repositoryAccess!.confirmationOperationId = uuid();
      },
      (value: RuntimeRecord) => {
        const intent = value.attempts[0].toolCalls[0].repositoryIntent!;
        intent.argumentsHash = digest("changed");
        const { intentHash: old, ...body } = intent;
        void old;
        intent.intentHash = digest(stableJson(body));
      },
      (value: RuntimeRecord) => {
        const observation = value.attempts[0].toolCalls[0].repositoryObservation!;
        observation.files[0].hash = digest("changed");
        const { observationHash: old, ...body } = observation;
        void old;
        observation.observationHash = digest(stableJson(body));
      },
      (value: RuntimeRecord) => {
        delete value.attempts[0].toolCalls[0].repositoryObservation;
      },
    ]) {
      const forged = structuredClone(record);
      mutate(forged);
      await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
    }
  } finally {
    await f.close();
  }
});
test("should reject resultless raw selected forged mismatched and cancelled repository observations", async () => {
  const f = await runtimeFixture();
  try {
    const record = automaticRecord(f.record);
    record.attempts[0].toolCalls.push({
      callId: "automatic-read",
      payloadHash: digest("trusted call"),
      operationId: null,
      result: null,
      repositoryIntent: automaticIntent(record),
    });
    await f.store.write(record);
    const result = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "excerpt" }],
    };
    const withObservation = structuredClone(record);
    withObservation.attempts[0].toolCalls[0].repositoryObservation = automaticObservation(
      record,
      result,
    );
    await assert.rejects(async () => f.store.write(withObservation), { code: "UNSAFE_STORAGE" });
    withObservation.attempts[0].toolCalls[0].result = result;
    for (const mutate of [
      (value: RuntimeRecord) => {
        value.attempts[0].toolCalls[0].repositoryObservation!.generation = uuid();
      },
      (value: RuntimeRecord) => {
        value.attempts[0].toolCalls[0].repositoryObservation!.resultHash = digest("forged");
      },
      (value: RuntimeRecord) => {
        value.attempts[0].toolCalls[0].repositoryObservation!.files[0].byteStart = 10;
      },
      (value: RuntimeRecord) => {
        Object.assign(value.attempts[0].toolCalls[0].repositoryObservation!, { raw: "model JSON" });
      },
    ]) {
      const forged = structuredClone(withObservation);
      mutate(forged);
      await assert.rejects(async () => f.store.write(forged), { code: "UNSAFE_STORAGE" });
    }
    record.attempts[0].toolCancellations = [
      {
        callId: "automatic-read",
        controlId: "cancel",
        payloadHash: record.attempts[0].toolCalls[0].payloadHash,
        cancelHash: digest("cancelled"),
      },
    ];
    await f.store.write(record);
    withObservation.attempts[0].toolCancellations = structuredClone(
      record.attempts[0].toolCancellations,
    );
    await assert.rejects(async () => f.store.write(withObservation), { code: "UNSAFE_STORAGE" });
    const selected = interruptedRecord(f.record);
    selected.attempts[0].toolCalls = structuredClone(withObservation.attempts[0].toolCalls);
    await assert.rejects(async () => f.store.write(selected), { code: "UNSAFE_STORAGE" });
  } finally {
    await f.close();
  }
});
test("should reject automatic permission expansion in a saved version two selected generation", async () => {
  const f = await runtimeFixture();
  try {
    const record = claudeRecord(f.record);
    await f.store.write(record);
    record.settings!.files = [];
    record.settings!.repositoryAccess = createRepositoryAccess(
      record.context!.generation,
      record.context!.root,
      uuid(),
      uuid(),
    );
    await assert.rejects(async () => f.store.write(record), { code: "UNSAFE_STORAGE" });
  } finally {
    await f.close();
  }
});

test("should keep peer verification separate and immutable while the exact outbound operation is pending", async () => {
  const f = await runtimeFixture();
  try {
    const record = automaticRecord(f.record),
      attempt = record.attempts[0];
    attempt.nativeIntent!.toolPolicy!.peerAllowed = true;
    await f.store.write(record);
    const operationId = uuid();
    const body = {
      protocol: 1,
      agentId: record.scope.agentId,
      bindingEpoch: record.scope.bindingEpoch,
      operationId,
      requestId: attempt.requestId,
      attemptId: attempt.snapshot!.attemptId,
      fence: attempt.snapshot!.fence,
      publicText: "Question based on verified evidence",
      confirmed: true,
    };
    record.operations.push({
      operationId,
      action: "question",
      body,
      payloadHash: digest(stableJson({ action: "question", body })),
      state: "PENDING",
      result: null,
    });
    const proof = hashed(
      {
        version: 1 as const,
        kind: "PEER_EVIDENCE_OBSERVATION" as const,
        purpose: "VERIFIED_FOR_PEER_QUESTION" as const,
        generation: record.context!.generation,
        approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
        files: [
          {
            path: "src/unselected.ts",
            startLine: 1,
            endLine: 1,
            lineCount: 3,
            hash: digest("whole file"),
            readAt: new Date().toISOString(),
            byteStart: 0,
            byteEnd: 7,
            excerptHash: digest("excerpt"),
          },
        ],
      },
      "observationHash",
    );
    attempt.toolCalls.push({
      callId: "peer",
      payloadHash: digest("peer call"),
      operationId,
      result: null,
      peerEvidenceObservation: proof,
    });
    await f.store.write(record);
    assert.equal((await f.store.read())!.attempts[0].toolCalls[0].result, null);
    assert.deepEqual(
      (await f.store.read())!.attempts[0].toolCalls[0].peerEvidenceObservation,
      proof,
    );
    assert.equal(Object.hasOwn(proof, "resultHash"), false);
    for (const mutate of [
      (value: RuntimeRecord) => {
        value.attempts[0].toolCalls[0].operationId = uuid();
      },
      (value: RuntimeRecord) => {
        value.attempts[0].toolCalls[0].peerEvidenceObservation!.files[0].endLine = 4;
      },
      (value: RuntimeRecord) => {
        Object.assign(value.attempts[0].toolCalls[0].peerEvidenceObservation!, {
          resultHash: digest("provider returned result"),
        });
      },
      (value: RuntimeRecord) => {
        const evidence = value.attempts[0].toolCalls[0].peerEvidenceObservation!;
        evidence.files[0].endLine = 2;
        const { observationHash: old, ...contents } = evidence;
        void old;
        evidence.observationHash = digest(stableJson(contents));
      },
    ]) {
      const changed = structuredClone(record);
      mutate(changed);
      await assert.rejects(async () => f.store.write(changed), { code: "UNSAFE_STORAGE" });
    }
    attempt.toolCalls[0].result = {
      success: true,
      contentItems: [{ type: "inputText", text: "accepted/pending" }],
    };
    await assert.rejects(async () => f.store.write(record), { code: "UNSAFE_STORAGE" });
    record.operations.at(-1)!.state = "CONFIRMED";
    record.operations.at(-1)!.result = {
      cycleId: attempt.snapshot!.payload.cycleId,
      questionId: uuid(),
      peerRequestId: uuid(),
      accepted: true,
      cycleState: "ACTIVE",
    };
    await f.store.write(record);
    assert.deepEqual(
      (await f.store.read())!.attempts[0].toolCalls[0].peerEvidenceObservation,
      proof,
    );
  } finally {
    await f.close();
  }
});

for (const kind of ["CONTINUATION", "RESUME"] as const)
  test(`should preserve authorized ${kind} origin policy and pending peer evidence`, async () => {
    const f = await runtimeFixture();
    try {
      const record = automaticRecord(f.record),
        attempt = record.attempts[0];
      attempt.snapshot!.payload.requestKind = kind;
      attempt.snapshot!.payload.questionId = kind === "CONTINUATION" ? uuid() : null;
      attempt.snapshot!.payload.replyText = kind === "CONTINUATION" ? "Verified answer" : null;
      for (const op of record.operations) {
        const result = op.result as { payload?: unknown };
        if (result?.payload) result.payload = structuredClone(attempt.snapshot!.payload);
      }
      attempt.nativeIntent!.toolPolicy!.peerAllowed = true;
      await f.store.write(record);
      const operationId = uuid();
      const body = {
        protocol: 1,
        agentId: record.scope.agentId,
        bindingEpoch: record.scope.bindingEpoch,
        operationId,
        requestId: attempt.requestId,
        attemptId: attempt.snapshot!.attemptId,
        fence: attempt.snapshot!.fence,
        publicText: "Question based on verified evidence",
        confirmed: true,
      };
      record.operations.push({
        operationId,
        action: "question",
        body,
        payloadHash: digest(stableJson({ action: "question", body })),
        state: "PENDING",
        result: null,
      });
      const proof = hashed(
        {
          version: 1 as const,
          kind: "PEER_EVIDENCE_OBSERVATION" as const,
          purpose: "VERIFIED_FOR_PEER_QUESTION" as const,
          generation: record.context!.generation,
          approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
          files: [
            {
              path: "src/unselected.ts",
              startLine: 1,
              endLine: 1,
              lineCount: 3,
              hash: digest("whole file"),
              readAt: new Date().toISOString(),
              byteStart: 0,
              byteEnd: 7,
              excerptHash: digest("excerpt"),
            },
          ],
        },
        "observationHash",
      );
      attempt.toolCalls.push({
        callId: "peer",
        payloadHash: digest("peer call"),
        operationId,
        result: null,
        peerEvidenceObservation: proof,
      });
      await f.store.write(record);
      assert.equal((await f.store.read())!.attempts[0].toolCalls[0].result, null);
      assert.deepEqual(
        (await f.store.read())!.attempts[0].toolCalls[0].peerEvidenceObservation,
        proof,
      );
      assert.equal(Object.hasOwn(proof, "resultHash"), false);
      for (const mutate of [
        (value: RuntimeRecord) => {
          value.attempts[0].toolCalls[0].operationId = uuid();
        },
        (value: RuntimeRecord) => {
          value.attempts[0].toolCalls[0].peerEvidenceObservation!.files[0].endLine = 4;
        },
        (value: RuntimeRecord) => {
          Object.assign(value.attempts[0].toolCalls[0].peerEvidenceObservation!, {
            resultHash: digest("provider returned result"),
          });
        },
        (value: RuntimeRecord) => {
          const evidence = value.attempts[0].toolCalls[0].peerEvidenceObservation!;
          evidence.files[0].endLine = 2;
          const { observationHash: old, ...contents } = evidence;
          void old;
          evidence.observationHash = digest(stableJson(contents));
        },
      ]) {
        const changed = structuredClone(record);
        mutate(changed);
        await assert.rejects(async () => f.store.write(changed), { code: "UNSAFE_STORAGE" });
      }
      attempt.toolCalls[0].result = {
        success: true,
        contentItems: [{ type: "inputText", text: "accepted/pending" }],
      };
      await assert.rejects(async () => f.store.write(record), { code: "UNSAFE_STORAGE" });
      record.operations.at(-1)!.state = "CONFIRMED";
      record.operations.at(-1)!.result = {
        cycleId: attempt.snapshot!.payload.cycleId,
        questionId: uuid(),
        peerRequestId: uuid(),
        accepted: true,
        cycleState: "ACTIVE",
      };
      await f.store.write(record);
      assert.deepEqual(
        (await f.store.read())!.attempts[0].toolCalls[0].peerEvidenceObservation,
        proof,
      );
    } finally {
      await f.close();
    }
  });

test("should reject a repository observation byte range beyond the actual core file limit", async () => {
  const f = await runtimeFixture();
  try {
    const record = automaticRecord(f.record);
    record.attempts[0].toolCalls.push({
      callId: "oversized-observation",
      payloadHash: digest("trusted call"),
      operationId: null,
      result: null,
      repositoryIntent: automaticIntent(record),
    });
    await f.store.write(record);
    const next = structuredClone(record);
    const result = {
      success: true,
      contentItems: [{ type: "inputText" as const, text: "excerpt" }],
    };
    const observation = automaticObservation(record, result);
    observation.files[0].byteEnd = 2097153;
    const { observationHash, ...body } = observation;
    void observationHash;
    observation.observationHash = digest(stableJson(body));
    next.attempts[0].toolCalls[0].result = result;
    next.attempts[0].toolCalls[0].repositoryObservation = observation;
    await assert.rejects(async () => f.store.write(next), { code: "UNSAFE_STORAGE" });
  } finally {
    await f.close();
  }
});
