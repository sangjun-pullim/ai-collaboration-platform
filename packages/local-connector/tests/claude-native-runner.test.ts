import assert from "node:assert/strict";
import test from "node:test";
import { type NativeHistoryEvidence } from "../src/runtime-contracts.ts";
import { claudeHarness, nativeConversationHistory } from "./claude-runtime-fixture.ts";
import { claudeRecord } from "./provider-runtime-fixture.ts";
import { runnerFixture } from "./runner-fixture.ts";

test("should resume a second question in the same native context after completed evidence is archived", async () => {
  const f = await runnerFixture({}, (record) => {
    Object.assign(record, claudeRecord(record));
    record.settings!.autoQuestionsConfirmed = false;
  });
  const h = claudeHarness(f, f.record);
  const create = () => {
    const adapter = h.createAdapter({
      history: async () => nativeConversationHistory(h.history, "2.1.287"),
    });
    const execute = adapter.execute.bind(adapter);
    adapter.execute = (authority, settings, payload, before) =>
      execute(authority, settings, payload, async (intent) => {
        assert.ok(intent);
        h.captureIntent(intent);
        await before(intent);
      });
    return adapter;
  };
  try {
    f.queue();
    assert.equal((await f.runner(create()).run({ once: true })).state, "UPLOADED");
    const first = (await f.store.read())!;
    assert.equal(first.context!.ownedTurns[0].nativeHistory!.state, "VERIFIED");
    const compacted = await f.store.compact(first);
    assert.equal(compacted.attempts.length, 0);
    assert.deepEqual(compacted.context, first.context);
    f.queue();
    assert.equal((await f.runner(create()).run({ once: true })).state, "UPLOADED");
    const second = (await f.store.read())!;
    assert.equal(second.context!.threadId, first.context!.threadId);
    assert.equal(second.context!.ownedTurns.length, 2);
    assert.ok(second.context!.ownedTurns.every((turn) => turn.nativeHistory?.state === "VERIFIED"));
    assert.equal(h.native.writes.length, 2);
    assert.equal(f.requests.filter((request) => request.action === "question").length, 0);
  } finally {
    await h.close();
    await f.close();
  }
});

test("should preserve and republish a native reply with unverified history before blocking resume", async () => {
  const f = await runnerFixture({}, (record) => {
    Object.assign(record, claudeRecord(record));
    record.settings!.autoQuestionsConfirmed = false;
  });
  const h = claudeHarness(f, f.record);
  let reads = 0;
  const create = () => {
    const adapter = h.createAdapter({
      history: async () => {
        const history = nativeConversationHistory(h.history, "2.1.287");
        if (++reads === 2)
          (history.records[1].message as Record<string, unknown>).content = [
            { type: "text", text: "synthetic mismatch" },
          ];
        return history;
      },
    });
    const execute = adapter.execute.bind(adapter);
    adapter.execute = (authority, settings, payload, before) =>
      execute(authority, settings, payload, async (intent) => {
        assert.ok(intent);
        h.captureIntent(intent);
        await before(intent);
      });
    return adapter;
  };
  const first = create();
  try {
    let lost = true;
    f.faults.after = async (action, _body, _result, response) => {
      if (action === "complete" && lost) {
        lost = false;
        response.destroy();
        return true;
      }
    };
    f.queue();
    assert.equal((await f.runner(first).run({ once: true })).state, "TERMINAL");
    const saved = (await f.store.read())!;
    const unverified: NativeHistoryEvidence = { state: "UNVERIFIED", reason: "HISTORY_REJECTED" };
    assert.equal(saved.attempts[0].terminal!.terminal, "COMPLETED");
    assert.equal(saved.attempts[0].terminal!.privateText, "Answer");
    assert.equal(saved.attempts[0].terminal!.textProof, "FINAL_ANSWER");
    assert.deepEqual(saved.attempts[0].terminal!.nativeHistory, unverified);
    assert.deepEqual(saved.context!.ownedTurns[0].nativeHistory, unverified);
    const recovery = create();
    await assert.rejects(f.runner(recovery).run({ once: true }), { code: "CONTEXT_UNCONFIRMED" });
    const published = (await f.store.read())!;
    assert.equal(published.attempts[0].state, "UPLOADED");
    assert.deepEqual(published.attempts[0].terminal, saved.attempts[0].terminal);
    const sent = f.requests.filter((request) => request.action === "complete");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(h.native.writes.length, 1);
    const archived = await f.store.compact(published);
    assert.equal(archived.attempts.length, 0);
    assert.deepEqual(archived.context!.ownedTurns[0].nativeHistory, unverified);
    assert.deepEqual((await f.store.lastAttempt(archived))!.terminal, saved.attempts[0].terminal);
    const reconnect = create();
    try {
      await assert.rejects(
        reconnect.validate(archived.context!, archived.settings!, () => {}),
        { code: "CONTEXT_UNCONFIRMED" },
      );
      assert.equal(h.native.writes.length, 1);
    } finally {
      await reconnect.close();
    }
  } finally {
    await first.close();
    await h.close();
    await f.close();
  }
});
