import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
function harness(blockMarker: boolean, blockIDB: boolean) {
  let clears = 0,
    removed = 0,
    notified = 0;
  const exports: Record<string, unknown> = {};
  runInNewContext(
    ts.transpileModule(
      readFileSync("src/features/investigation-coordinator/chat-session-cleanup.ts", "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      exports,
      CustomEvent: Event,
      window: {
        dispatchEvent: () => {
          notified++;
        },
      },
      localStorage: {
        setItem: () => {
          if (blockMarker) throw new Error("Synthetic localStorage denied");
        },
        removeItem: () => {},
        getItem: () => null,
      },
      sessionStorage: {
        length: 1,
        key: () => "human-direct-question:fixture",
        removeItem: () => {
          removed++;
        },
      },
      require(name: string) {
        if (name === "./chat-history-cache.ts") return { clearChatHistory: () => {} };
        if (name === "./chat-outbox.ts")
          return {
            outboxCleanupKey: "chat-outbox-cleanup-required",
            speechOutbox: {
              clear: async () => {
                clears++;
                if (blockIDB) throw new Error("Synthetic IDB denied");
              },
            },
          };
        throw new Error(`Unexpected cleanup dependency ${name}`);
      },
    },
  );
  return {
    clear: exports.clearChatSession as () => Promise<boolean>,
    notice: exports.chatCleanupNotice as () => boolean,
    counts: () => ({ clears, removed, notified }),
  };
}
test("should attempt IndexedDB and legacy cleanup even when localStorage marker creation fails", async () => {
  const h = harness(true, false);
  assert.equal(await h.clear(), false);
  assert.deepEqual(h.counts(), { clears: 1, removed: 1, notified: 1 });
  assert.equal(h.notice(), true);
});
test("should report both storage failures while still hiding memory and clearing independent legacy storage", async () => {
  const h = harness(true, true);
  assert.equal(await h.clear(), false);
  assert.deepEqual(h.counts(), { clears: 1, removed: 1, notified: 1 });
  assert.equal(h.notice(), true);
});
