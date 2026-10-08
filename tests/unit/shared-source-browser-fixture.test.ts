import test from "node:test";
import assert from "node:assert/strict";
import {
  SourceBrowserRegistry,
  type SourceBrowserScene,
} from "../helpers/source-browser-fixture.js";
import type { SourceReadPage } from "../../src/features/investigation-coordinator/source-contracts.ts";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function fixtureScene(): SourceBrowserScene {
  const page = (eventId: string): SourceReadPage => ({
    version: 2,
    roomId: id(1),
    eventId,
    state: "NO_TARGET_SNAPSHOT",
    target: null,
    manifestHash: null,
    summary: null,
    files: [],
    nextIndex: null,
  });
  return {
    roomId: id(1),
    owner: { id: id(2), displayName: "owner" },
    observer: { id: id(3), displayName: "observer" },
    eventId: id(4),
    question: { eventId: id(5), publicText: "question" },
    original: page(id(4)),
    recipient: page(id(5)),
  };
}
test("should constrain source browser operations to owned fixed scenes and scoped users without exposing parent state", async () => {
  const calls: string[] = [],
    state = { credential: "private", root: "/private", sql: "private" };
  const registry = new SourceBrowserRegistry({
    async prepare(scene) {
      calls.push(`prepare:${scene}`);
      return { state, publicScene: { ...fixtureScene(), admin: "private" } };
    },
    async entry(owned, person) {
      assert.equal(owned, state);
      calls.push(`entry:${person}`);
      return {
        code: "test-entry",
        admin: "private",
        cookies: [
          {
            name: "test-cookie",
            value: "test-session",
            url: "http://127.0.0.1",
            httpOnly: true,
            sameSite: "Lax" as const,
            root: "/private",
          },
        ],
      };
    },
    async dispose(owned) {
      assert.equal(owned, state);
      calls.push("dispose");
    },
  });
  for (const [action, input] of [
    ["source-setup", { scene: "../../private" }],
    ["source-setup", { scene: "desktop-source-history", sql: "select" }],
    ["source-upload", { scene: "desktop-source-history" }],
    ["source-code", { scene: "desktop-source-history", id: id(2) }],
  ] as const)
    await assert.rejects(registry.dispatch(action, input));
  assert.deepEqual(calls, []);
  const publicScene = await registry.dispatch("source-setup", { scene: "desktop-source-history" });
  assert.deepEqual(publicScene, fixtureScene());
  await assert.rejects(registry.dispatch("source-setup", { scene: "desktop-source-history" }));
  for (const input of [
    { scene: "desktop-source-history", id: id(99) },
    { scene: "mobile-source-history", id: id(2) },
    { scene: "desktop-source-history", id: id(2), path: "/private" },
  ])
    await assert.rejects(registry.dispatch("source-code", input));
  const entry = await registry.dispatch("source-code", {
    scene: "desktop-source-history",
    id: id(2),
  });
  assert.deepEqual(entry, {
    code: "test-entry",
    cookies: [
      {
        name: "test-cookie",
        value: "test-session",
        url: "http://127.0.0.1",
        httpOnly: true,
        sameSite: "Lax",
      },
    ],
  });
  assert.deepEqual(await registry.dispatch("source-dispose", { scene: "desktop-source-history" }), {
    closed: true,
  });
  await assert.rejects(
    registry.dispatch("source-code", { scene: "desktop-source-history", id: id(2) }),
  );
  await assert.rejects(registry.dispatch("source-setup", { scene: "desktop-source-history" }));
  await registry.close();
  assert.deepEqual(calls, ["prepare:desktop-source-history", `entry:${id(2)}`, "dispose"]);
});
test("should reject private nested public data and dispose parent-owned preparations", async () => {
  let disposed = 0;
  const registry = new SourceBrowserRegistry({
    async prepare() {
      const publicScene = fixtureScene();
      return {
        state: "owned",
        publicScene: {
          ...publicScene,
          original: { ...publicScene.original, credential: "private" },
        },
      };
    },
    async entry() {
      throw new Error("Entry must not run");
    },
    async dispose(state) {
      assert.equal(state, "owned");
      disposed++;
    },
  });
  await assert.rejects(registry.dispatch("source-setup", { scene: "desktop-source-history" }));
  assert.equal(disposed, 1);
  await registry.close();
  assert.equal(disposed, 1);
});
test("should prevent overlapping preparation and close remaining parent-owned scenes exactly once", async () => {
  let resolvePreparation!: () => void,
    prepared = 0,
    disposed = 0;
  const gate = new Promise<void>((resolve) => {
    resolvePreparation = resolve;
  });
  const registry = new SourceBrowserRegistry({
    async prepare() {
      prepared++;
      await gate;
      return { state: "owned", publicScene: fixtureScene() };
    },
    async entry() {
      throw new Error("Entry must not run");
    },
    async dispose() {
      disposed++;
    },
  });
  const first = registry.dispatch("source-setup", { scene: "desktop-source-history" });
  await assert.rejects(registry.dispatch("source-setup", { scene: "desktop-source-history" }));
  resolvePreparation();
  await first;
  await registry.close();
  await registry.close();
  assert.equal(prepared, 1);
  assert.equal(disposed, 1);
});
