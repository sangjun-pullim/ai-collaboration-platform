import test from "node:test";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { LocalAccessStack, ensure } from "../helpers/local-access-stack.js";

const syntheticCode = "fixture-company-entry-code";
async function fixture(run: (stack: LocalAccessStack) => Promise<void>) {
  const stack = await LocalAccessStack.open("team-entry");
  try {
    await run(stack);
  } finally {
    await stack.close();
  }
}
async function anonymous(stack: LocalAccessStack) {
  const client = createClient(stack.config.api, stack.config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const result = await client.auth.signInAnonymously();
  ensure(!result.error && result.data.user, "Actual owned anonymous signup failed");
  stack.users.add(result.data.user.id);
  return { client, id: result.data.user.id };
}
async function admit(client: SupabaseClient, code: string, displayName = "동료") {
  const result = await client.rpc("team_entry_admit", {
    p_code: code,
    p_display_name: displayName,
  });
  ensure(!result.error, "Admission must return a fixed result instead of rolling back counters");
  return result.data;
}
test("should deny direct anonymous app access until code admission", async () =>
  fixture(async (stack) => {
    const user = await anonymous(stack);
    const blocked = await user.client.rpc("access_bootstrap", {
      p_group_name: "격리 그룹",
      p_title: "격리 방",
      p_goal: "질문",
      p_observation: "합성",
      p_environment: "격리",
      p_display_alias: "동료",
    });
    ensure(
      blocked.error?.message === "UNAUTHENTICATED",
      "Direct anonymous bootstrap must be denied",
    );
    const status = await user.client.rpc("team_entry_status");
    ensure(status.data?.admitted === false, "Auth identity alone must not imply admission");
    for (const table of [
      "organizations",
      "rooms",
      "room_members",
      "organization_members",
      "workflow_events",
      "workflow_runs",
    ]) {
      const query = await user.client.from(table).select("*");
      ensure(!query.error && query.data.length === 0, "Unadmitted reads must not expose app data");
    }
    const permitted = await admit(user.client, syntheticCode);
    ensure(permitted.ok && permitted.userId === user.id, "Admission must bind auth.uid");
  }));
test("should preserve user identity across display names without merging equal names", async () =>
  fixture(async (stack) => {
    const a = await anonymous(stack),
      b = await anonymous(stack);
    const first = await admit(a.client, syntheticCode, "같은 이름"),
      second = await admit(b.client, syntheticCode, "같은 이름");
    ensure(
      first.userId === a.id && second.userId === b.id && a.id !== b.id,
      "Equal names must retain separate identities",
    );
    const changed = await admit(a.client, syntheticCode, "새 이름");
    ensure(
      changed.userId === a.id && changed.displayName === "새 이름",
      "Alias change must preserve identity",
    );
    const rows = await stack.db.query(
      "select count(*)::integer n from team_entry_private.admissions where user_id=any($1::uuid[])",
      [[a.id, b.id]],
    );
    ensure(rows.rows[0].n === 2, "Identity records must not merge by name");
  }));
test("should persist failed attempts and atomically enforce the actor cooldown", async () =>
  fixture(async (stack) => {
    const user = await anonymous(stack);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => admit(user.client, "wrong-owned-code")),
    );
    ensure(
      results.filter((r) => r.error?.code === "CODE_REJECTED").length === 5,
      "Exactly five failures should be counted",
    );
    ensure(
      results.filter((r) => r.error?.code === "CODE_COOLDOWN").length === 1,
      "Concurrent sixth attempt must be rate limited",
    );
    const row = await stack.db.query(
      "select cardinality(recent) n from team_entry_private.attempts where user_id=$1",
      [user.id],
    );
    ensure(row.rows[0].n === 5, "Rejected RPC results must commit failure counters");
    ensure(
      (await admit(user.client, syntheticCode)).error?.code === "CODE_COOLDOWN",
      "Valid code must not bypass cooldown",
    );
  }));
test("should retain membership restrictions for admitted users", async () =>
  fixture(async (stack) => {
    const user = await anonymous(stack);
    await admit(user.client, syntheticCode);
    const owner = await anonymous(stack);
    await admit(owner.client, syntheticCode);
    const created = await owner.client.rpc("access_bootstrap", {
      p_group_name: "다른 그룹",
      p_title: "실제 다른 방",
      p_goal: "질문",
      p_observation: "합성",
      p_environment: "격리",
      p_display_alias: "방 소유자",
    });
    ensure(
      !created.error && created.data?.roomId,
      "A real owned room must exist before the nonmember check",
    );
    await stack.trackOrganization(created.data.organizationId);
    const ownerRead = await owner.client.from("rooms").select("id").eq("id", created.data.roomId);
    ensure(ownerRead.data?.length === 1, "The room must be visible to its actual owner");
    const read = await user.client.rpc("connection_room_bindings", {
      p_room_id: created.data.roomId,
    });
    ensure(
      read.error?.message === "NOT_FOUND",
      "Admission must not grant a nonmember the existing room",
    );
    const outsiderRead = await user.client.from("rooms").select("id").eq("id", created.data.roomId);
    ensure(
      !outsiderRead.error && outsiderRead.data?.length === 0,
      "Admission alone must not satisfy actual room membership RLS",
    );
    const privateRead = await user.client
      .schema("team_entry_private")
      .from("configuration")
      .select("*");
    ensure(!!privateRead.error, "Private verifier must remain inaccessible through Data API");
  }));
test("should reject banned identities without restoring admission", async () =>
  fixture(async (stack) => {
    const user = await anonymous(stack);
    await admit(user.client, syntheticCode);
    await stack.disable({ id: user.id });
    const status = await user.client.rpc("team_entry_status");
    ensure(status.data?.admitted === false, "Ban must remove the active admission condition");
    const result = await admit(user.client, syntheticCode);
    ensure(result.error?.code === "UNAUTHENTICATED", "Code must not restore a banned identity");
  }));

// Exercise the deployed RPC in rollback-only database transactions. Changing the
// synthetic verifier/quota in this scope cannot alter a concurrent browser session.
async function transaction(stack: LocalAccessStack, userId: string, run: () => Promise<void>) {
  await stack.db.query("begin");
  try {
    await stack.db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
    await run();
  } finally {
    await stack.db.query("rollback");
  }
}
async function databaseAdmission(stack: LocalAccessStack, code: string) {
  await stack.db.query("set local role authenticated");
  try {
    const result = await stack.db.query("select public.team_entry_admit($1,$2) result", [
      code,
      "격리 동료",
    ]);
    return result.rows[0].result;
  } finally {
    await stack.db.query("reset role");
  }
}
test("should enforce the sixty-per-minute global quota without bypass through successful retries", async () =>
  fixture(async (stack) => {
    const user = await anonymous(stack);
    await transaction(stack, user.id, async () => {
      await stack.db.query("update team_entry_private.global_attempts set recent='{}' where id=1");
      for (let i = 0; i < 60; i++) {
        const result = await databaseAdmission(stack, syntheticCode);
        ensure(
          result.ok && result.userId === user.id,
          "Each allowed attempt must retain the actual identity",
        );
      }
      ensure(
        (await databaseAdmission(stack, syntheticCode)).error?.code === "CODE_COOLDOWN",
        "The sixty-first attempt must be limited globally",
      );
      const row = await stack.db.query(
        "select cardinality(recent) n from team_entry_private.global_attempts where id=1",
      );
      ensure(row.rows[0].n === 60, "Rejected global attempts must not add an extra hash operation");
    });
  }));
test("should preserve meaningful spaces and every byte of long company codes", async () =>
  fixture(async (stack) => {
    const user = await anonymous(stack);
    const code = " " + "x".repeat(100) + " ";
    await transaction(stack, user.id, async () => {
      await stack.db.query("update team_entry_private.global_attempts set recent='{}' where id=1");
      await stack.db.query(
        "update team_entry_private.configuration set verifier=extensions.crypt(encode(extensions.digest(convert_to($1,'UTF8'),'sha256'),'hex'),extensions.gen_salt('bf',10)) where id=1",
        [code],
      );
      ensure((await databaseAdmission(stack, code)).ok, "The complete long code must be accepted");
      ensure(
        (await databaseAdmission(stack, code.trim())).error?.code === "CODE_REJECTED",
        "Meaningful code spaces must not be trimmed",
      );
      ensure(
        (await databaseAdmission(stack, code.slice(0, -2) + "y ")).error?.code === "CODE_REJECTED",
        "A byte after the bcrypt truncation boundary must affect validation",
      );
      ensure(
        (await databaseAdmission(stack, code + "\n")).error?.code === "INVALID_BODY",
        "Control characters must be rejected by the database boundary",
      );
    });
  }));
test("should backfill only existing confirmed permanent identities without changing ownership", async () =>
  fixture(async (stack) => {
    const owner = await anonymous(stack);
    await admit(owner.client, syntheticCode, "기존 소유자");
    const bootstrap = await owner.client.rpc("access_bootstrap", {
      p_group_name: "격리 그룹",
      p_title: "기존 방",
      p_goal: "질문",
      p_observation: "합성",
      p_environment: "격리",
      p_display_alias: "기존 소유자",
    });
    ensure(!bootstrap.error && bootstrap.data?.organizationId, "Owned bootstrap must succeed");
    const scope = bootstrap.data as { organizationId: string; roomId: string };
    await stack.trackOrganization(scope.organizationId);
    const created = await stack.admin.auth.admin.createUser({
      email: `${stack.namespace}-legacy@example.test`,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
    });
    ensure(
      !created.error && created.data.user,
      "Owned confirmed permanent identity must be created",
    );
    const legacy = created.data.user.id;
    stack.users.add(legacy);
    const sql = readFileSync("supabase/migrations/20261004000900-team-code-entry.sql", "utf8");
    const start = sql.indexOf(
      "insert into team_entry_private.admissions(user_id,display_name,legacy)",
    );
    const end = sql.indexOf(";", start);
    ensure(start >= 0 && end > start, "Actual migration backfill must exist");
    await transaction(stack, legacy, async () => {
      await stack.db.query(
        "insert into public.organization_members(organization_id,user_id,role,display_alias) values($1,$2,'member',$3)",
        [scope.organizationId, legacy, "기존 동료"],
      );
      const before = await stack.db.query(
        "select id,owner_user_id from public.organizations where id=$1",
        [scope.organizationId],
      );
      await stack.db.query(sql.slice(start, end) + " on conflict(user_id) do nothing;");
      const admission = await stack.db.query(
        "select user_id,display_name,legacy from team_entry_private.admissions where user_id=$1",
        [legacy],
      );
      ensure(
        admission.rows[0]?.user_id === legacy &&
          admission.rows[0].legacy &&
          admission.rows[0].display_name === "기존 동료",
        "One-time backfill must retain the permanent identity and its own alias",
      );
      const after = await stack.db.query(
        "select id,owner_user_id from public.organizations where id=$1",
        [scope.organizationId],
      );
      ensure(
        JSON.stringify(before.rows) === JSON.stringify(after.rows),
        "Backfill must not transfer room or organization ownership",
      );
      const outsider = await stack.db.query(
        "select legacy from team_entry_private.admissions where user_id=$1",
        [owner.id],
      );
      ensure(
        outsider.rows[0]?.legacy === false,
        "Anonymous admission must never be upgraded to legacy",
      );
    });
    const later = await stack.admin.auth.admin.createUser({
      email: `${stack.namespace}-later@example.test`,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
    });
    ensure(!later.error && later.data.user, "Later owned permanent identity must be created");
    stack.users.add(later.data.user.id);
    const automatic = await stack.db.query(
      "select user_id from team_entry_private.admissions where user_id=$1",
      [later.data.user.id],
    );
    ensure(
      automatic.rowCount === 0,
      "Future confirmed provider users must not receive an automatic legacy admission",
    );
  }));

test("should deny existing member data and valid device workflow credentials when only admission is removed", async () =>
  workflowCase("admission-boundary", async (f) => {
    const scene = await f.scene("admission");
    const actor = scene.owner;
    await f.ready(scene.origin);
    await f.ready(scene.responder);
    const started = await f.start(scene);
    ensure(
      started.accepted && started.cycleId,
      "A real owned workflow must exist before the admission regression",
    );
    const client = actor.web.dataClient();
    const tables = [
      "organizations",
      "organization_members",
      "rooms",
      "room_members",
      "workflow_events",
      "workflow_runs",
    ];
    for (const table of tables) {
      const read = await client.from(table).select("*");
      ensure(
        !read.error && !!read.data?.length,
        "Existing membership must expose real rows before admission removal",
      );
    }
    const list = await client.rpc("connection_list");
    ensure(
      !list.error && list.data.devices?.length > 0,
      "The actual owner must have a live device before denial",
    );
    const bindings = await client.rpc("connection_room_bindings", {
      p_room_id: scene.scope.roomId,
    });
    ensure(
      !bindings.error && bindings.data.length === 2,
      "Two real bindings must be visible before denial",
    );
    const anonymousDevice = createClient(f.stack.config.api, f.stack.config.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const heartbeatBody = {};
    const pollBody = {
      protocol: 1,
      agentId: scene.origin.agentId!,
      bindingEpoch: await f.epoch(scene.origin),
    };
    ensure(
      !(
        await anonymousDevice.rpc("connector_heartbeat", {
          p_body: heartbeatBody,
          p_secret: scene.origin.credential,
        })
      ).error,
      "The real owned credential must work before admission removal",
    );
    ensure(
      !(
        await anonymousDevice.rpc("workflow_device_poll", {
          p_body: pollBody,
          p_secret: scene.origin.credential,
        })
      ).error,
      "The real workflow credential must work before admission removal",
    );
    const removed = await f.stack.db.query(
      "delete from team_entry_private.admissions where user_id=$1 returning user_id",
      [actor.id],
    );
    ensure(removed.rowCount === 1, "Only the exact owned admission must be removed");
    const auth = await client.auth.getUser();
    ensure(
      !auth.error && auth.data.user?.id === actor.id,
      "Provider identity and membership must remain valid during denial",
    );
    for (const table of tables) {
      const read = await client.from(table).select("*");
      ensure(
        !read.error && read.data?.length === 0,
        "Admissionless active membership must not expose its existing rows",
      );
    }
    ensure(
      (await client.rpc("connection_list")).error?.message === "UNAUTHENTICATED",
      "A valid owner cannot bypass admission through the direct connection RPC",
    );
    ensure(
      (await client.rpc("connection_room_bindings", { p_room_id: scene.scope.roomId })).error
        ?.message === "UNAUTHENTICATED",
      "Existing room bindings must be denied without admission",
    );
    const speak = await client.rpc("workflow_human_speak", {
      p_body: {
        protocol: 1,
        roomId: scene.scope.roomId,
        operationId: randomUUID(),
        publicText: "차단되어야 함",
      },
    });
    ensure(
      speak.error?.message === "FORBIDDEN",
      "Valid room workflow mutation must fail when only admission is missing",
    );
    for (const [name, body] of [
      ["connector_heartbeat", heartbeatBody],
      ["workflow_device_poll", pollBody],
    ] as const) {
      const response = await anonymousDevice.rpc(name, {
        p_body: body,
        p_secret: scene.origin.credential,
      });
      ensure(
        response.error?.message === "UNAUTHENTICATED",
        "Admissionless owner credentials must not regain execution through the direct Data API",
      );
    }
  }));
