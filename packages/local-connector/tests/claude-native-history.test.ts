import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { proveOwnedHistory } from "../src/claude/history-proof.ts";
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
