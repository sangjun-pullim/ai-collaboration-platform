import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Client } from "pg";

test(
  "should keep room serialization without locking immutable historical receipts",
  {
    skip: !process.env.LOCAL_POLL_LOCK_DB_URL && "requires an isolated local lock-test database",
    timeout: 20_000,
  },
  async (t) => {
    const url = new URL(process.env.LOCAL_POLL_LOCK_DB_URL!);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "56322");
    assert.equal(url.pathname, "/ai_collab_poll_lock_check");
    const setup = new Client({ connectionString: url.toString() });
    const blocker = new Client({ connectionString: url.toString() });
    const reader = new Client({ connectionString: url.toString() });
    await Promise.all([setup.connect(), blocker.connect(), reader.connect()]);
    const room = "00000000-0000-4000-8000-000000000001";
    try {
      await setup.query(`
      create schema workflow_private;
      create table workflow_private.rooms(room_id uuid primary key);
      create table workflow_private.cycles(id uuid primary key, room_id uuid);
      create table workflow_private.requests(id uuid primary key, room_id uuid);
      create table workflow_private.attempts(id uuid primary key, request_id uuid);
      create table workflow_private.questions(id uuid primary key, cycle_id uuid);
      create table workflow_private.controls(id uuid primary key, request_id uuid);
      create table workflow_private.readiness(agent_id uuid primary key, room_id uuid);
      create table workflow_private.receipts(room_id uuid, actor_kind text, actor_id uuid, operation_id uuid primary key);
    `);
      const definitions = readdirSync("supabase/migrations")
        .sort()
        .flatMap((file) =>
          [
            ...readFileSync(`supabase/migrations/${file}`, "utf8").matchAll(
              /create(?: or replace)? function workflow_private\.lock_room\(r uuid\)[\s\S]*?\$\$;/g,
            ),
          ].map((match) => match[0]),
        );
      assert.ok(definitions.length);
      await setup.query(definitions.at(-1)!);
      await setup.query("insert into workflow_private.rooms values($1)", [room]);
      await setup.query(
        `insert into workflow_private.receipts
      select $1,'device',$1,md5(i::text)::uuid from generate_series(1,15000) i`,
        [room],
      );
      await setup.query(
        definitions[0].replace(
          "workflow_private.lock_room(r",
          "workflow_private.baseline_lock_room(r",
        ),
      );
      for (const name of ["baseline_lock_room", "lock_room"]) {
        const start = performance.now();
        for (let i = 0; i < 10; i++)
          await reader.query(`select workflow_private.${name}($1)`, [room]);
        t.diagnostic(
          `${name}: 15000 receipts, 10 polls, ${(performance.now() - start).toFixed(1)}ms`,
        );
      }
      await blocker.query("begin");
      await blocker.query("select 1 from workflow_private.receipts limit 1 for update");
      await reader.query("set lock_timeout='200ms'");
      // A historical receipt lock must not stall live room reads or heartbeats.
      await reader.query("select workflow_private.lock_room($1)", [room]);
      await blocker.query("rollback");
      assert.equal(
        (await setup.query("select count(*)::int n from workflow_private.receipts")).rows[0].n,
        15000,
      );
      await blocker.query("begin");
      await blocker.query("select 1 from workflow_private.rooms where room_id=$1 for update", [
        room,
      ]);
      await assert.rejects(
        reader.query("select workflow_private.lock_room($1)", [room]),
        (error: unknown) => (error as { code?: string }).code === "55P03",
      );
    } finally {
      await blocker.query("rollback");
      await setup.query("drop schema if exists workflow_private cascade");
      await Promise.all([setup.end(), blocker.end(), reader.end()]);
    }
  },
);
