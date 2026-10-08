import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { runnerFixture } from "./runner-fixture.ts";
import { projectSourceManifest } from "../src/workflow/source-manifest.ts";
test("should project only validated input and prove public bytes against original record", async () => {
  const f = await runnerFixture({
    sourceGitExecutor: async () => {
      throw new Error("synthetic unavailable");
    },
  });
  try {
    f.queue();
    await f.runner().run({ once: true });
    const record = (await f.store.read())!,
      projected = projectSourceManifest(record, record.attempts[0])!;
    assert.equal(projected.manifest.readMode, "SELECTED");
    assert.deepEqual(
      projected.manifest.input.files.entries,
      record.attempts[0].sourceObservation!.files.entries.map((e) => ({
        pathJson: JSON.stringify(e.path),
        hash: e.hash,
      })),
    );
    assert.ok(projected.bytes.length <= 2 * projected.ledger.recordBytes);
    assert.ok(projected.ledger.rootBytes <= 256);
    for (const secret of [
      record.context!.threadId,
      record.context!.root.path,
      record.context!.generation,
    ])
      assert.equal(projected.bytes.toString().includes(secret), false);
    delete record.attempts[0].sourceObservation;
    assert.equal(projectSourceManifest(record, record.attempts[0]), null);
  } finally {
    await f.close();
  }
});

import { RuntimeStore } from "../src/runtime-store.ts";
import { createRepositoryAccess } from "../src/workspace/repository-access.ts";
import { capabilityHash } from "../src/settings/contracts.ts";
import { RepositoryTools } from "../src/workflow/repository-tools.ts";
import { validRepositoryObservation } from "../src/workspace/repository-observation.ts";
import { digest, stableJson } from "../src/runtime-contracts.ts";
import { uuid } from "./runtime-fixture.ts";
function automatic(record: import("../src/runtime-contracts.ts").RuntimeRecord) {
  record.version = 2;
  record.settings!.files = [];
  const caps = record.settings!.capabilities,
    { snapshotHash, ...contents } = caps;
  void snapshotHash;
  caps.runtime = "codex";
  caps.snapshotHash = capabilityHash({ ...contents, runtime: "codex", policy: "verified" });
  record.settings!.repositoryAccess = createRepositoryAccess(
    record.context!.generation,
    record.context!.root,
    uuid(),
    uuid(),
  );
}
test("should preserve 256 validated calls without charging preserved array separators to root growth", async () => {
  const f = await runnerFixture(
    {
      sourceGitExecutor: async () => {
        throw new Error("synthetic Git unavailable");
      },
    },
    automatic,
  );
  try {
    f.queue();
    await f.runner().run({ once: true });
    const record = (await f.store.read())!,
      journal = record.attempts[0],
      tools = new RepositoryTools(record.context!, record.settings!, () => {});
    journal.toolCalls = Array.from({ length: 256 }, () => {
      const repositoryIntent = tools.intent("list_workspace_files", {}),
        result = { success: true, contentItems: [{ type: "inputText" as const, text: "{}" }] };
      const body = {
        version: 1 as const,
        kind: "REPOSITORY_TOOL_OBSERVATION" as const,
        generation: journal.generation,
        approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
        tool: "list_workspace_files" as const,
        resultHash: digest(stableJson(result)),
        files: [],
      };
      const repositoryObservation = { ...body, observationHash: digest(stableJson(body)) };
      assert.equal(validRepositoryObservation(repositoryObservation), true);
      return {
        callId: uuid(),
        payloadHash: digest("synthetic validated call"),
        operationId: null,
        result,
        repositoryIntent,
        repositoryObservation,
      };
    });
    const store = new RuntimeStore(f.stateDir, "source-ledger", record.scope.agentId);
    await mkdir(store.dir, { recursive: true, mode: 0o700 });
    await writeFile(store.file, JSON.stringify(record), { mode: 0o600 });
    const validated = (await store.read())!,
      projected = projectSourceManifest(validated, validated.attempts[0])!;
    assert.equal(projected.manifest.calls.length, 256);
    assert.ok(projected.ledger.rootBytes <= 256);
    assert.ok(projected.bytes.length <= 2 * Buffer.byteLength(JSON.stringify(validated)));
    assert.ok(projected.bytes.length <= 4194304);
  } finally {
    await f.close();
  }
});

test("should accept validated search records above input-v1 limits and prove worst path token expansion", async () => {
  const f = await runnerFixture(
    {
      sourceGitExecutor: async () => {
        throw new Error("synthetic Git unavailable");
      },
    },
    automatic,
  );
  try {
    f.queue();
    await f.runner().run({ once: true });
    const baseline = (await f.store.read())!,
      tools = new RepositoryTools(baseline.context!, baseline.settings!, () => {}),
      store = new RuntimeStore(f.stateDir, "search-ledger", baseline.scope.agentId);
    await mkdir(store.dir, { recursive: true, mode: 0o700 });
    for (const path of [
      "src/synthetic.ts",
      "\ud800".repeat(508) + ".ts",
      "\u0001".repeat(508) + ".ts",
      '"'.repeat(508) + ".ts",
    ]) {
      const record = structuredClone(baseline),
        journal = record.attempts[0];
      const originalProperty = Buffer.byteLength(JSON.stringify({ path })),
        publicProperty = Buffer.byteLength(JSON.stringify({ pathJson: JSON.stringify(path) }));
      assert.ok(publicProperty <= 2 * originalProperty);
      journal.toolCalls = Array.from({ length: 64 }, (_, callIndex) => {
        const result = {
            success: true,
            contentItems: [{ type: "inputText" as const, text: "synthetic returned result" }],
          },
          files = Array.from({ length: 8 }, (_, index) => ({
            path,
            hash: digest(`file-${index}`),
            readAt: "2026-10-06T00:00:00.000Z",
            byteStart: callIndex,
            byteEnd: callIndex + 1,
            excerptHash: digest(`excerpt-${index}`),
          }));
        const body = {
          version: 1 as const,
          kind: "REPOSITORY_TOOL_OBSERVATION" as const,
          generation: journal.generation,
          approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
          tool: "search_workspace" as const,
          resultHash: digest(stableJson(result)),
          files,
        };
        return {
          callId: uuid(),
          payloadHash: digest("synthetic validated search"),
          operationId: null,
          result,
          repositoryIntent: tools.intent("search_workspace", { query: "synthetic" }),
          repositoryObservation: { ...body, observationHash: digest(stableJson(body)) },
        };
      });
      await writeFile(store.file, JSON.stringify(record), { mode: 0o600 });
      const validated = (await store.read())!,
        projected = projectSourceManifest(validated, validated.attempts[0])!;
      assert.equal(projected.manifest.calls.length, 64);
      assert.equal(
        projected.manifest.calls.reduce((n, c) => n + c.files.length, 0),
        512,
      );
      assert.ok(projected.bytes.length > 131072);
      assert.ok(projected.bytes.length <= 2 * Buffer.byteLength(JSON.stringify(validated)));
      assert.ok(projected.bytes.length <= 4194304);
      assert.equal(projected.manifest.calls[0].files[0].pathJson, JSON.stringify(path));
      assert.equal(projected.manifest.calls[63].files[0].byteStart, 63);
    }
  } finally {
    await f.close();
  }
});

test("should preserve selected 0 1 32 entries and original hashes without imposing v1 bytes on token wrappers", async () => {
  const f = await runnerFixture({
    sourceGitExecutor: async () => {
      throw new Error("synthetic Git unavailable");
    },
  });
  try {
    f.queue();
    await f.runner().run({ once: true });
    const baseline = (await f.store.read())!,
      store = new RuntimeStore(f.stateDir, "selected-ledger", baseline.scope.agentId);
    await mkdir(store.dir, { recursive: true, mode: 0o700 });
    for (const count of [0, 1, 32]) {
      const record = structuredClone(baseline),
        journal = record.attempts[0],
        source = journal.sourceObservation!;
      record.settings!.files = Array.from({ length: count }, (_, index) => ({
        ...baseline.settings!.files[0],
        path: `${String(index).padStart(2, "0")}/${"\u0001".repeat(503)}.ts`,
      }));
      source.files.entries = record.settings!.files.map(({ path, hash }) => ({ path, hash }));
      source.files.manifestHash = digest(stableJson(source.files.entries));
      const { observationHash, ...body } = source;
      void observationHash;
      source.observationHash = digest(stableJson(body));
      await writeFile(store.file, JSON.stringify(record), { mode: 0o600 });
      const validated = (await store.read())!,
        projected = projectSourceManifest(validated, validated.attempts[0])!;
      assert.equal(projected.manifest.input.files.entries.length, count);
      assert.equal(projected.manifest.input.observationHash, source.observationHash);
      assert.equal(projected.manifest.input.files.manifestHash, source.files.manifestHash);
      assert.ok(projected.ledger.publicInputBytes <= 2 * projected.ledger.inputBytes);
      assert.ok(projected.bytes.length <= 2 * projected.ledger.recordBytes);
    }
  } finally {
    await f.close();
  }
});

import { isSelectedPath } from "../src/runtime-file-policy.ts";
import { isRepositoryFile } from "../src/workspace/repository-path-policy.ts";
import { validPathToken, validRepositoryPathToken } from "../src/workflow/source-contracts.ts";
test("should consume both original path policies without rejecting legal authentication implementation files", () => {
  for (const path of [
    "auth/service.ts",
    "authentication.ts",
    "credentials.ts",
    "auth.json",
    "AGENTS.md",
    "README.md",
    "dist/file.ts",
    ".hidden/file.ts",
    "src/settings.ts",
    "src/settings.json",
    "src/app.generated.ts",
    "src/unknown.binary",
    "a\0b.ts",
    "a\nb.ts",
    "a\\b.ts",
    "a/../b.ts",
    "/src/a.ts",
    "😀/a.ts",
    "\ud800/a.ts",
    "\ue000/a.ts",
    "\u0001/a.ts",
    "a".repeat(509) + ".ts",
    "a".repeat(510) + ".ts",
  ]) {
    assert.equal(validPathToken(JSON.stringify(path)), isSelectedPath(path), path);
    assert.equal(validRepositoryPathToken(JSON.stringify(path)), isRepositoryFile(path), path);
  }
});

test("should preserve peer pre-send evidence call gaps requested lines and hashes across mutable receipts", async () => {
  const f = await runnerFixture(
    {
      sourceGitExecutor: async () => {
        throw new Error("synthetic Git unavailable");
      },
    },
    automatic,
  );
  try {
    f.queue();
    await f.runner().run({ once: true });
    const record = (await f.store.read())!,
      journal = record.attempts[0],
      store = new RuntimeStore(f.stateDir, "peer-ledger", record.scope.agentId);
    await mkdir(store.dir, { recursive: true, mode: 0o700 });
    const operationId = uuid(),
      body = {
        protocol: 1,
        operationId,
        agentId: record.scope.agentId,
        bindingEpoch: record.scope.bindingEpoch,
        requestId: journal.requestId,
        attemptId: journal.snapshot!.attemptId,
        fence: journal.snapshot!.fence,
        publicText: "Synthetic question",
        confirmed: true,
      };
    record.operations.push({
      operationId,
      action: "question",
      body,
      payloadHash: digest(stableJson({ action: "question", body })),
      state: "TRANSMITTED",
      result: null,
    });
    const proof = {
      version: 1 as const,
      kind: "PEER_EVIDENCE_OBSERVATION" as const,
      generation: journal.generation,
      approvalHash: digest(stableJson(record.settings!.repositoryAccess)),
      purpose: "VERIFIED_FOR_PEER_QUESTION" as const,
      files: [
        {
          path: "auth/service.ts",
          hash: digest("file"),
          readAt: "2026-10-06T00:00:00.000Z",
          byteStart: 0,
          byteEnd: 80,
          excerptHash: digest("excerpt"),
          startLine: 4,
          endLine: 7,
          lineCount: 20,
        },
      ],
    };
    journal.toolCalls = [
      { callId: uuid(), payloadHash: digest("gap"), operationId: null, result: null },
      {
        callId: uuid(),
        payloadHash: digest("peer-call"),
        operationId,
        result: null,
        peerEvidenceObservation: { ...proof, observationHash: digest(stableJson(proof)) },
      },
    ];
    await writeFile(store.file, JSON.stringify(record), { mode: 0o600 });
    const validated = (await store.read())!,
      before = projectSourceManifest(validated, validated.attempts[0])!;
    assert.equal(before.manifest.calls[0].callIndex, 1);
    const peer = before.manifest.calls[0];
    assert.equal(peer.kind, "PEER_EVIDENCE_OBSERVATION");
    if (peer.kind !== "PEER_EVIDENCE_OBSERVATION") throw new Error("wrong kind");
    assert.equal(peer.questionOperationId, operationId);
    assert.equal(peer.files[0].requestedStartLine, 4);
    assert.equal(peer.files[0].byteStart, 0);
    const saved = record.operations.at(-1)!;
    saved.state = "CONFIRMED";
    saved.result = {
      cycleId: journal.snapshot!.payload.cycleId,
      questionId: uuid(),
      peerRequestId: uuid(),
      accepted: true,
      cycleState: "ACTIVE",
    };
    await writeFile(store.file, JSON.stringify(record), { mode: 0o600 });
    const changed = (await store.read())!,
      after = projectSourceManifest(changed, changed.attempts[0])!;
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(after.manifestHash, before.manifestHash);
  } finally {
    await f.close();
  }
});
