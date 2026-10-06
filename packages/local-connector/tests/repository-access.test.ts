import test from "node:test";
import assert from "node:assert/strict";
import {
  createRepositoryAccess,
  repositoryMode,
  validRepositoryAccess,
} from "../src/workspace/repository-access.ts";
import { runtimeFixture, uuid } from "./runtime-fixture.ts";

test("should require a new exact approval bound to generation and physical root", async () => {
  const f = await runtimeFixture();
  try {
    const settings = { ...f.settings, files: [] };
    assert.equal(repositoryMode(settings, f.context), "SELECTED");
    const access = createRepositoryAccess(f.context.generation, f.policy.root, uuid(), uuid());
    const approved = { ...settings, repositoryAccess: access };
    assert.equal(repositoryMode(approved, f.context), "AUTO_CODE");
    assert.equal(validRepositoryAccess({ ...access, extra: true }), false);
    for (const patch of [
      { generation: uuid() },
      { rootIdentityHash: "0".repeat(64) },
      { sharePathHashConfirmed: false },
      { approvedAt: "today" },
      { localRootReference: "invalid" },
    ]) {
      assert.throws(() =>
        repositoryMode(
          { ...approved, repositoryAccess: { ...access, ...patch } } as typeof approved,
          f.context,
        ),
      );
    }
    assert.throws(() => repositoryMode({ ...approved, files: f.settings.files }, f.context));
    assert.throws(() =>
      repositoryMode(approved, {
        ...f.context,
        root: { ...f.context.root, ino: f.context.root.ino + 1 },
      }),
    );
  } finally {
    await f.close();
  }
});

test("should reject approval insertion into saved legacy settings", async () => {
  const f = await runtimeFixture();
  try {
    await f.store.write(f.record);
    const next = structuredClone(f.record);
    next.settings!.files = [];
    next.settings!.repositoryAccess = createRepositoryAccess(
      f.context.generation,
      f.policy.root,
      uuid(),
      uuid(),
    );
    await assert.rejects(async () => f.store.write(next), { code: "UNSAFE_STORAGE" });
  } finally {
    await f.close();
  }
});
