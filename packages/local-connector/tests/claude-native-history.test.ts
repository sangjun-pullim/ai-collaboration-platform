import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { proveOwnedHistory } from "../src/claude/history-proof.ts";
import { checkpointNativeHistory } from "../src/claude/native-history-proof.ts";
import type { OwnedHistory } from "../src/claude/owned-history.ts";
import { digest, stableJson, type OwnedContext } from "../src/runtime-contracts.ts";

function nativeConversation() {
  const sessionId = randomUUID();
  const inputId = randomUUID();
  const assistantId = randomUUID();
  const root = "/owned/repository";
  const prompt = "Explain the workspace API.";
  const records: Record<string, unknown>[] = [
    {
      type: "user",
      uuid: inputId,
      parentUuid: null,
      sessionId,
      cwd: root,
      version: "2.1.288",
      isSidechain: false,
      message: { role: "user", content: prompt },
    },
    {
      type: "assistant",
      uuid: assistantId,
      parentUuid: inputId,
      sessionId,
      cwd: root,
      version: "2.1.288",
      isSidechain: false,
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "The API lists shared workspaces." }],
      },
    },
  ];
  const context: OwnedContext = {
    ownership: "CONNECTOR_CREATED",
    provider: "claude",
    generation: randomUUID(),
    threadId: sessionId,
    root: { path: root, dev: 1, ino: 2, uid: 501 },
    epoch: 1,
    level: "L2",
    materialization: {
      state: "MATERIALIZED",
      version: "2.1.288",
      policyFingerprint: digest("verified-native-policy"),
      initHash: digest("verified-live-init"),
    },
    ownedTurns: [
      Object.assign(
        {
          turnId: inputId,
          terminal: "COMPLETED" as const,
          promptHash: digest(prompt),
          resultHash: digest("verified-live-result"),
          toolReceipts: [],
        },
        {
          nativeHistory: {
            state: "VERIFIED" as const,
            format: "claude-jsonl-v1" as const,
            recordCount: records.length,
            prefixHash: digest(stableJson(records)),
          },
        },
      ),
    ],
  };
  const history: OwnedHistory = Object.assign(
    { materialized: true, sessionId, root, records },
    { format: "claude-jsonl-v1" as const },
  );
  return { context, history, inputId, assistantId, prompt };
}

test("should validate completed native conversation without stream init or result records", () => {
  const f = nativeConversation();
  const before = stableJson(f.context);
  assert.equal(proveOwnedHistory(f.context, f.history, "2.1.288"), null);
  assert.equal(stableJson(f.context), before);
});

test("should validate two completed native questions in the same session", () => {
  const f = nativeConversation();
  const nextId = randomUUID();
  const prompt = "Which endpoint calls that API?";
  f.history.records.push(
    {
      ...f.history.records[0],
      uuid: nextId,
      parentUuid: f.assistantId,
      message: { role: "user", content: prompt },
    },
    {
      ...f.history.records[1],
      uuid: randomUUID(),
      parentUuid: nextId,
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "GET /workspaces calls the API." }],
      },
    },
  );
  f.context.ownedTurns.push(
    Object.assign(
      {
        turnId: nextId,
        terminal: "COMPLETED" as const,
        promptHash: digest(prompt),
        resultHash: digest("second-verified-live-result"),
        toolReceipts: [],
      },
      {
        nativeHistory: {
          state: "VERIFIED" as const,
          format: "claude-jsonl-v1" as const,
          recordCount: f.history.records.length,
          prefixHash: digest(stableJson(f.history.records)),
        },
      },
    ),
  );
  assert.equal(proveOwnedHistory(f.context, f.history, "2.1.288"), null);
});

test("should reject changed native history after a completed live result", () => {
  const f = nativeConversation();
  (f.history.records[1].message as Record<string, unknown>).content = [
    { type: "text", text: "Changed after completion." },
  ];
  assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.288"), {
    code: "CONTEXT_UNCONFIRMED",
  });
});

test("should reject native history without a verified completion checkpoint", () => {
  const f = nativeConversation();
  Object.assign(f.context.ownedTurns[0], {
    nativeHistory: { state: "UNVERIFIED", reason: "HISTORY_REJECTED" },
  });
  assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.288"), {
    code: "CONTEXT_UNCONFIRMED",
  });
  assert.equal(f.context.ownedTurns[0].terminal, "COMPLETED");
});

for (const mutation of [
  "session",
  "cwd",
  "version",
  "parent",
  "duplicate",
  "foreign input",
  "sidechain",
] as const) {
  test(`should reject a native ${mutation} mismatch even with a matching file digest`, () => {
    const f = nativeConversation();
    if (mutation === "session") f.history.records[1].sessionId = randomUUID();
    if (mutation === "cwd") f.history.records[1].cwd = "/other-repository";
    if (mutation === "version") f.history.records[1].version = "2.1.289";
    if (mutation === "parent") f.history.records[1].parentUuid = randomUUID();
    if (mutation === "duplicate") f.history.records[1].uuid = f.inputId;
    if (mutation === "foreign input") f.history.records[0].uuid = randomUUID();
    if (mutation === "sidechain") f.history.records[1].isSidechain = true;
    const checkpoint = f.context.ownedTurns[0].nativeHistory!;
    assert.equal(checkpoint.state, "VERIFIED");
    if (checkpoint.state === "VERIFIED")
      checkpoint.prefixHash = digest(stableJson(f.history.records));
    assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.288"), {
      code: "CONTEXT_UNCONFIRMED",
    });
  });
}

test("should keep a reserved native input without any history unknown", () => {
  const f = nativeConversation();
  f.context.ownedTurns = [];
  f.context.materialization!.state = "RESERVED";
  f.context.materialization!.initHash = null;
  f.history.materialized = false;
  f.history.records = [];
  assert.equal(proveOwnedHistory(f.context, f.history, "2.1.288"), null);
});

function native293Conversation() {
  const f = nativeConversation();
  const metadataId = randomUUID();
  for (const frame of f.history.records) frame.version = "2.1.293";
  f.context.materialization!.version = "2.1.293";
  const user = f.history.records[0];
  const assistant = f.history.records[1];
  assistant.parentUuid = metadataId;
  const metadata = {
    type: "attachment",
    uuid: metadataId,
    parentUuid: f.inputId,
    sessionId: f.context.threadId,
    cwd: f.context.root.path,
    version: "2.1.293",
    isSidechain: false,
    attachment: { type: "environment", snapshot: { cwd: f.context.root.path } },
  };
  f.history.records = [
    {
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-10-08T00:00:00.000Z",
      sessionId: f.context.threadId,
      content: f.prompt,
    },
    {
      type: "queue-operation",
      operation: "dequeue",
      timestamp: "2026-10-08T00:00:00.001Z",
      sessionId: f.context.threadId,
    },
    user,
    metadata,
    { type: "atis-latch", sessionId: f.context.threadId, atis: "" },
    {
      type: "last-prompt",
      sessionId: f.context.threadId,
      leafUuid: metadataId,
      lastPrompt: f.prompt,
    },
    assistant,
    {
      type: "last-prompt",
      sessionId: f.context.threadId,
      leafUuid: f.assistantId,
      lastPrompt: f.prompt,
    },
    {
      type: "cost-state",
      sessionId: f.context.threadId,
      totalCostUSD: 0.001,
      totalAPIDuration: 20,
      totalAPIDurationWithoutRetries: 20,
      totalToolDuration: 0,
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalDuration: 25,
      startTime: 1,
      modelUsage: { "claude-test": { inputTokens: 10, outputTokens: 20 } },
      hasUnknownModelCost: false,
    },
  ];
  const checkpoint = f.context.ownedTurns[0].nativeHistory!;
  if (checkpoint.state === "VERIFIED") {
    checkpoint.recordCount = f.history.records.length;
    checkpoint.prefixHash = digest(stableJson(f.history.records));
  }
  return { ...f, user, assistant, metadata, metadataId };
}

test("should validate a native 293 conversation with scoped queue attachment and advisory records", () => {
  const f = native293Conversation();
  assert.equal(proveOwnedHistory(f.context, f.history, "2.1.293"), null);
});

test("should checkpoint native 293 live messages without counting attachments as additional input", () => {
  const f = native293Conversation();
  f.context.ownedTurns = [];
  f.context.materialization!.state = "RESERVED";
  f.context.materialization!.initHash = null;
  const result = checkpointNativeHistory(
    f.context,
    f.history,
    "2.1.293",
    {
      provider: "claude",
      sessionId: f.context.threadId,
      inputId: f.inputId,
      promptHash: digest(f.prompt),
      generation: f.context.generation,
      scope: {
        server: "https://test.invalid",
        deviceId: randomUUID(),
        organizationId: randomUUID(),
        roomId: randomUUID(),
        agentId: randomUUID(),
        bindingEpoch: 1,
      },
      attemptId: randomUUID(),
      fence: 1,
      policyFingerprint: f.context.materialization!.policyFingerprint,
    },
    [f.user, f.assistant],
  );
  assert.equal(result.state, "VERIFIED");
  if (result.state === "VERIFIED") {
    assert.equal(result.recordCount, f.history.records.length);
    assert.equal(result.prefixHash, digest(stableJson(f.history.records)));
  }
  assert.deepEqual(f.context.ownedTurns, []);
});

for (const [label, change] of [
  [
    "foreign metadata session",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[0].sessionId = randomUUID();
    },
  ],
  [
    "foreign queued prompt",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[0].content = "Unowned input";
    },
  ],
  [
    "unknown queue operation",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[0].operation = "replace";
    },
  ],
  [
    "orphan queue dequeue",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records.splice(0, 1);
    },
  ],
  [
    "unclosed queue enqueue",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records.splice(1, 1);
    },
  ],
  [
    "foreign attachment root",
    (f: ReturnType<typeof native293Conversation>) => {
      f.metadata.cwd = "/other/repository";
    },
  ],
  [
    "foreign attachment parent",
    (f: ReturnType<typeof native293Conversation>) => {
      f.metadata.parentUuid = randomUUID();
    },
  ],
  [
    "sidechain attachment",
    (f: ReturnType<typeof native293Conversation>) => {
      f.metadata.isSidechain = true;
    },
  ],
  [
    "duplicate attachment UUID",
    (f: ReturnType<typeof native293Conversation>) => {
      f.metadata.uuid = f.inputId;
    },
  ],
  [
    "unknown attachment kind",
    (f: ReturnType<typeof native293Conversation>) => {
      f.metadata.attachment.type = "unknown";
    },
  ],
  [
    "hidden attachment message",
    (f: ReturnType<typeof native293Conversation>) => {
      Object.assign(f.metadata, { message: { role: "user", content: "foreign prompt" } });
    },
  ],
  [
    "invalid latch value",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[4].atis = false;
    },
  ],
  [
    "foreign last-prompt leaf",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[5].leafUuid = randomUUID();
    },
  ],
  [
    "negative cost counter",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[8].totalCostUSD = -1;
    },
  ],
  [
    "hidden metadata message",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[4].message = { role: "user", content: "foreign prompt" };
    },
  ],
  [
    "unknown advisory record",
    (f: ReturnType<typeof native293Conversation>) => {
      f.history.records[4].type = "unknown";
    },
  ],
] as const)
  test(`should reject native 293 ${label} even with a matching history digest`, () => {
    const f = native293Conversation();
    change(f);
    const checkpoint = f.context.ownedTurns[0].nativeHistory!;
    if (checkpoint.state === "VERIFIED")
      checkpoint.prefixHash = digest(stableJson(f.history.records));
    assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.293"), {
      code: "CONTEXT_UNCONFIRMED",
    });
  });

test("should reject changed attachment payload after a verified completion", () => {
  const f = native293Conversation();
  f.metadata.attachment.snapshot.cwd = "/tampered/metadata";
  assert.throws(() => proveOwnedHistory(f.context, f.history, "2.1.293"), {
    code: "CONTEXT_UNCONFIRMED",
  });
});
