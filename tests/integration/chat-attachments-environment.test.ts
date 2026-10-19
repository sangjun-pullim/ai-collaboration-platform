import test from "node:test";
import assert from "node:assert/strict";
import {
  ownedStackContainerNames,
  OWNED_PROJECT,
  productEnvironment,
} from "../helpers/local-access-stack.js";
test("should accept only the original six services or their single owned Storage addition", () => {
  const base = ["kong", "db", "inbucket", "auth", "rest", "realtime"].map(
    (name) => `supabase_${name}_${OWNED_PROJECT}`,
  );
  const storage = `supabase_storage_${OWNED_PROJECT}`;
  assert.equal(ownedStackContainerNames(base), true);
  assert.equal(ownedStackContainerNames([...base, storage]), true);
  for (const names of [
    base.slice(1),
    [...base.slice(1), storage],
    [...base, `supabase_other_${OWNED_PROJECT}`],
    [...base, storage, `supabase_other_${OWNED_PROJECT}`],
    [...base, "supabase_storage_foreign"],
    [...base.slice(1), base[1]],
  ])
    assert.equal(ownedStackContainerNames(names), false);
});
test("should pass image secrets only to an explicit server environment and exclude browser children", () => {
  const env = {
    PATH: "/synthetic",
    SUPABASE_URL: "http://127.0.0.1:56321",
    AI_COLLAB_IMAGE_STORAGE_SECRET: "synthetic-storage",
    CRON_SECRET: "synthetic-cleanup",
    OPENAI_API_KEY: "synthetic-provider",
    LOCAL_ACCESS_ADMIN_KEY: "synthetic-admin",
  };
  const browser = productEnvironment(env),
    server = productEnvironment(env, "server");
  assert.equal(
    Object.keys(browser).some(
      (key) => key.includes("SECRET") || key.includes("ADMIN") || key.includes("OPENAI"),
    ),
    false,
  );
  assert.equal(server.AI_COLLAB_IMAGE_STORAGE_SECRET, env.AI_COLLAB_IMAGE_STORAGE_SECRET);
  assert.equal(server.CRON_SECRET, env.CRON_SECRET);
  assert.equal(server.OPENAI_API_KEY, undefined);
  assert.equal(server.LOCAL_ACCESS_ADMIN_KEY, undefined);
});
