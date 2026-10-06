import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, symlink, link, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readOwnedHistory } from "../src/claude/owned-history.ts";

async function fixture(run: (directory: string, id: string, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "claude-history-unit-"));
  const id = randomUUID(),
    path = join(directory, `${id}.jsonl`);
  try {
    await run(directory, id, path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("should read only the complete exact reserved native history", () =>
  fixture(async (_dir, id, path) => {
    const records = [
      { type: "user", uuid: randomUUID() },
      { type: "result", uuid: randomUUID() },
    ];
    await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", {
      mode: 0o600,
    });
    assert.deepEqual(await readOwnedHistory(path, id, "/owned", () => {}), {
      materialized: true,
      sessionId: id,
      root: "/owned",
      records,
    });
    await assert.rejects(
      readOwnedHistory(path, randomUUID(), "/owned", () => {}),
      { code: "CONTEXT_UNCONFIRMED" },
    );
  }));
test("should preserve an unmaterialized reservation when its native directory does not exist", () =>
  fixture(async (directory, id) => {
    const history = await readOwnedHistory(
      join(directory, "not-created", `${id}.jsonl`),
      id,
      "/owned",
      () => {},
    );
    assert.deepEqual(history, { materialized: false, sessionId: id, root: "/owned", records: [] });
  }));
test("should reject linked or public native history files", () =>
  fixture(async (directory, id, path) => {
    const real = join(directory, "foreign.jsonl");
    await writeFile(real, "{}\n", { mode: 0o600 });
    await symlink(real, path);
    await assert.rejects(
      readOwnedHistory(path, id, "/owned", () => {}),
      { code: "UNSAFE_STORAGE" },
    );
    await rm(path);
    await link(real, path);
    await assert.rejects(
      readOwnedHistory(path, id, "/owned", () => {}),
      { code: "UNSAFE_STORAGE" },
    );
    await rm(path);
    await writeFile(path, "{}\n", { mode: 0o600 });
    await chmod(path, 0o644);
    await assert.rejects(
      readOwnedHistory(path, id, "/owned", () => {}),
      { code: "UNSAFE_STORAGE" },
    );
  }));
test("should reject a dangling native history directory link", () =>
  fixture(async (directory, id) => {
    const linked = join(directory, "linked");
    await symlink(join(directory, "absent"), linked);
    await assert.rejects(
      readOwnedHistory(join(linked, `${id}.jsonl`), id, "/owned", () => {}),
      { code: "UNSAFE_STORAGE" },
    );
  }));
test("should reject partial malformed oversized or non-UTF8 history", () =>
  fixture(async (_directory, id, path) => {
    for (const [bytes, code] of [
      [Buffer.from("{}"), "UNKNOWN"],
      [Buffer.from("{malformed}\n"), "UNKNOWN"],
      [Buffer.from([0xff, 10]), "UNKNOWN"],
      [Buffer.from("{}\n".repeat(4097)), "RUNTIME_CAPACITY"],
    ] as const) {
      await writeFile(path, bytes, { mode: 0o600 });
      await assert.rejects(
        readOwnedHistory(path, id, "/owned", () => {}),
        { code },
      );
    }
  }));
