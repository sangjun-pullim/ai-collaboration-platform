import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

function definition(sql: string, name: string) {
  const start = sql.indexOf(`function device_binding_private.${name}(`);
  assert.ok(start >= 0);
  const headerEnd = sql.indexOf("$$", start);
  const bodyEnd = sql.indexOf("$$;", headerEnd + 2);
  assert.ok(headerEnd > start && bodyEnd > headerEnd);
  return { header: sql.slice(start, headerEnd), body: sql.slice(headerEnd + 2, bodyEnd) };
}
test("should change exactly the two issuance intervals while preserving authorization and replay semantics", () => {
  const baseline = definition(
    readFileSync("supabase/migrations/20261005001000-owner-local-ai-setup.sql", "utf8"),
    "connector",
  );
  const migration = readFileSync(
    "supabase/migrations/20261012001800-seven-day-device-credentials.sql",
    "utf8",
  );
  const issuance = definition(migration, "connector_010_runtime");
  assert.equal(issuance.header, baseline.header.replace(".connector(", ".connector_010_runtime("));
  assert.equal(baseline.body.match(/t\+interval '1 hour'/g)?.length, 2);
  assert.equal(
    issuance.body,
    baseline.body.replaceAll("t+interval '1 hour'", "t+interval '7 days'"),
  );
  assert.equal(migration.match(/^begin;$/gim)?.length, 1);
  assert.equal(migration.match(/^commit;$/gim)?.length, 1);
  const schemaChanges = migration.slice(0, migration.indexOf("create or replace function"));
  assert.doesNotMatch(
    schemaChanges,
    /\b(?:update|delete|insert)\s+(?:into\s+)?device_binding_private\./i,
  );
  for (const body of [baseline.body, issuance.body]) {
    const fingerprint = createHash("md5").update(body).digest("hex");
    assert.ok(schemaChanges.includes(fingerprint));
  }
});

test("should fingerprint the exact installed SQL010 prosrc without trimming its dollar body", () => {
  const baseline = definition(
    readFileSync("supabase/migrations/20261005001000-owner-local-ai-setup.sql", "utf8"),
    "connector",
  );
  assert.ok(baseline.body.startsWith("\n"));
  const md5 = (source: string) => createHash("md5").update(source).digest("hex");
  assert.equal(md5(baseline.body), "5ddfe023acf667121443a91bb3093797");
  assert.notEqual(md5(baseline.body.trim()), md5(baseline.body));
  const migration = readFileSync(
    "supabase/migrations/20261012001800-seven-day-device-credentials.sql",
    "utf8",
  );
  assert.ok(migration.includes(md5(baseline.body)));
  const installer = readFileSync("scripts/apply-local-ai-settings.mjs", "utf8");
  assert.ok(installer.includes(`legacyHash: "${md5(baseline.body)}"`));
  const issuance = definition(migration, "connector_010_runtime");
  assert.ok(installer.includes(`fixedHash: "${md5(issuance.body)}"`));
});
