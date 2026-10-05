import test from "node:test";
import assert from "node:assert/strict";
import {
  LocalAccessStack,
  WebSession,
  ensure,
  assertOwnedConfig,
  productEnvironment,
  type StackConfig,
  type FixturePerson,
  TEST_TEAM_CODE,
} from "../helpers/local-access-stack.js";
import { createHash } from "node:crypto";

async function fixture(label: string, run: (stack: LocalAccessStack) => Promise<void>) {
  const stack = await LocalAccessStack.open(label);
  try {
    await run(stack);
  } finally {
    await stack.close();
  }
}
async function rejected(response: Response, status: number, code?: string) {
  ensure(response.status === status, "Expected HTTP rejection status");
  const body = await response.json();
  ensure(
    body.ok === false &&
      Object.keys(body.error).length === 1 &&
      typeof body.error.code === "string",
    "Expected a fixed error envelope",
  );
  if (code) ensure(body.error.code === code, "Expected a fixed rejection code");
}
function trustedLoginRedirect(response: Response, trustedOrigin: string) {
  ensure(response.status === 307, "Protected access must redirect to login");
  const location = response.headers.get("location");
  ensure(location, "Protected redirect must include a Location header");
  const target = new URL(location, trustedOrigin);
  ensure(
    target.origin === new URL(trustedOrigin).origin &&
      target.pathname === "/login" &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password,
    "Protected redirect must resolve to the trusted fixed login URL",
  );
  const cache = response.headers.get("cache-control");
  ensure(
    cache?.includes("private") && cache.includes("no-store"),
    "Protected redirect must disable shared caches",
  );
}
async function blockedRoom(person: FixturePerson, roomId: string) {
  const response = await person.web.request(`/app/rooms/${roomId}`);
  ensure(response.status === 404, "Nonmember room read must return 404");
  const query = await person.web.dataClient().from("rooms").select("id").eq("id", roomId);
  ensure(!query.error && query.data.length === 0, "RLS must hide the inaccessible room");
}
async function state(stack: LocalAccessStack, organizationId: string, roomId: string) {
  const members = await stack.db.query(
    "select user_id,role,status from public.room_members where room_id=$1 order by user_id",
    [roomId],
  );
  const invites = await stack.db.query(
    "select id,role,consumed_at,consumed_by from room_access_private.room_invites where organization_id=$1 order by id",
    [organizationId],
  );
  const audit = await stack.db.query(
    "select count(*)::integer as count from room_access_private.access_audit where organization_id=$1",
    [organizationId],
  );
  return JSON.stringify({
    members: members.rows,
    invites: invites.rows,
    count: audit.rows[0].count,
  });
}

test("should enter with a company code and persist the same actual session", async () =>
  fixture("entry", async (stack) => {
    const person = await stack.firstTimeSignup("first-entry");
    const identity = person.id;
    for (let i = 0; i < 2; i++)
      ensure((await person.web.request("/app")).status === 200, "Same session must persist");
    const response = await person.web.post("/api/auth/enter", {
      code: TEST_TEAM_CODE,
      displayName: "바꾼 이름",
    });
    const result = await response.json();
    ensure(
      response.status === 200 && result.data.userId === identity,
      "Name change must retain identity",
    );
    ensure(
      response.headers.getSetCookie().every((c) => /httponly/i.test(c) && /samesite=lax/i.test(c)),
      "Auth cookie writes must be HttpOnly and Lax",
    );
    await rejected(
      await person.web.post("/api/auth/enter", { code: "wrong-code", displayName: "바꾼 이름" }),
      400,
      "CODE_REJECTED",
    );
    const other = await stack.firstTimeSignup("first-entry");
    ensure(other.id !== identity, "Equal names must not recover someone else's identity");
  }));
test("should preserve rejected code attempts and stop repeated guesses", async () =>
  fixture("entry-quota", async (stack) => {
    const person = await stack.person("wrong-code");
    for (let i = 0; i < 5; i++)
      await rejected(
        await person.web.post("/api/auth/enter", {
          code: "wrong-code",
          displayName: person.displayName,
        }),
        400,
        "CODE_REJECTED",
      );
    await rejected(
      await person.web.post("/api/auth/enter", {
        code: TEST_TEAM_CODE,
        displayName: person.displayName,
      }),
      429,
      "CODE_COOLDOWN",
    );
    await rejected(
      await person.web.post("/api/auth/code", { email: "synthetic@example.test" }),
      404,
      "NOT_FOUND",
    );
    await rejected(
      await person.web.post("/api/auth/verify", {
        email: "synthetic@example.test",
        code: "123456",
      }),
      404,
      "NOT_FOUND",
    );
  }));

test("should refresh eligible sessions and reject forged or unrefreshable sessions", async () =>
  fixture("refresh", async (stack) => {
    const a = await stack.person("a");
    const b = await stack.person("b");
    const initial = a.web.sessionData();
    a.web.expireSignedSession();
    const refreshed = await a.web.request("/app");
    ensure(
      refreshed.status === 200 && refreshed.headers.getSetCookie().length > 0,
      "An eligible signed expired session should refresh",
    );
    ensure(
      a.web.sessionData().refresh_token !== initial.refresh_token,
      "Successful refresh should rotate its token",
    );
    ensure(
      b.web.sessionData().user &&
        JSON.stringify(b.web.sessionData().user) !== JSON.stringify(a.web.sessionData().user),
      "Request clients must retain distinct Auth users",
    );
    const forged = new WebSession(stack.config);
    forged.replaceSession(a.web.sessionData());
    const data = forged.sessionData();
    const token = String(data.access_token);
    const parts = token.split(".");
    parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
    data.access_token = parts.join(".");
    forged.replaceSession(data);
    ensure(
      (await forged.request("/app")).status === 307,
      "Forged signature must reject protected access",
    );
    const broken = new WebSession(stack.config);
    broken.replaceSession(b.web.sessionData());
    broken.expireSignedSession();
    const expired = broken.sessionData();
    expired.refresh_token = "invalid-synthetic-refresh";
    broken.replaceSession(expired);
    ensure(
      (await broken.request("/app")).status === 307,
      "Unrefreshable signed expired session must be rejected",
    );
    ensure(
      (await b.web.request("/app")).status === 200,
      "Another user's valid session must remain independent",
    );
  }));

test("should clear refreshed session cookies on logout and reject refresh reuse", async () =>
  fixture("logout", async (stack) => {
    const person = await stack.person("logout");
    person.web.expireSignedSession();
    const old = person.web.sessionData().refresh_token as string;
    const response = await person.web.post("/api/auth/logout", {});
    ensure(response.status === 200, "Logout should revoke the refreshed session");
    ensure(
      response.headers.getSetCookie().every((cookie) => /max-age=0(?:;|$)/i.test(cookie)),
      "Logout must only return clearing session cookies",
    );
    ensure(person.web.jar.size === 0, "Logout must clear all session chunks");
    ensure(
      (await person.web.request("/app")).status === 307,
      "Next protected HTTP request must reject the logged-out session",
    );
    const reuse = await fetch(`${stack.config.api}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: stack.config.key, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: old }),
    });
    ensure(!reuse.ok, "Logged-out refresh token reuse must be rejected");
  }));

test("should reject access after the authenticated fixture account is disabled or deleted", async () =>
  fixture("account", async (stack) => {
    const a = await stack.person("deleted");
    const b = await stack.person("retained");
    const scope = await stack.bootstrap(b);
    await stack.join(a, await stack.invite(b, scope.roomId));
    const reads = [
      { table: "organizations", column: "id", value: scope.organizationId },
      { table: "organization_members", column: "organization_id", value: scope.organizationId },
      { table: "rooms", column: "id", value: scope.roomId },
      { table: "room_members", column: "room_id", value: scope.roomId },
    ] as const;
    const deletedDirect = a.web.dataClient();
    const session = a.web.sessionData();
    ensure(
      typeof session.access_token === "string",
      "Fixture must hold a valid signed Auth session before deletion",
    );
    const deletedClaims = JSON.parse(
      Buffer.from(session.access_token.split(".")[1], "base64url").toString("utf8"),
    );
    const deletedCookies = [...a.web.jar];
    const beforeDeletionWeb = () => {
      const web = new WebSession(stack.config);
      for (const [name, value] of deletedCookies) web.jar.set(name, value);
      return web;
    };
    for (const { table, column, value } of reads) {
      const before = await deletedDirect.from(table).select(column).eq(column, value);
      ensure(
        !before.error && before.data.length > 0,
        `Active synthetic member must read ${table} before physical deletion`,
      );
    }
    ensure(
      (await beforeDeletionWeb().request(`/app/rooms/${scope.roomId}`)).status === 200,
      "Issued member session must read its room before physical deletion",
    );
    ensure(
      deletedClaims.exp > Date.now() / 1000,
      "Physical-delete regression must begin with an unexpired Auth-issued JWT",
    );
    await stack.deleteAccount(a);
    const physicallyDeletedAuth = await stack.db.query("select id from auth.users where id=$1", [
      a.id,
    ]);
    ensure(
      physicallyDeletedAuth.rowCount === 0,
      "Actual physical deletion must remove the owned Auth row",
    );

    // Each HTTP request restores pre-deletion cookies; direct calls keep the original issued JWT.
    const deletedAppRead = await beforeDeletionWeb().request("/app");
    const deletedRoomRead = await beforeDeletionWeb().request(`/app/rooms/${scope.roomId}`);
    const deletedMutation = await beforeDeletionWeb().post("/api/access/bootstrap", {
      groupName: "그룹",
      title: "방",
      goal: "목표",
      observation: "근거",
      environment: "환경",
      displayAlias: "별칭",
    });
    const deletedRpc = await deletedDirect.rpc("access_bootstrap", {
      p_group_name: "합성 물리 삭제 그룹",
      p_title: "합성 물리 삭제 방",
      p_goal: "목표",
      p_observation: "근거",
      p_environment: "환경",
      p_display_alias: "삭제된 멤버",
    });
    if (!deletedRpc.error && typeof deletedRpc.data?.organizationId === "string")
      await stack.trackOrganization(deletedRpc.data.organizationId);
    const deletedReads = await Promise.all(
      reads.map(({ table, column, value }) =>
        deletedDirect.from(table).select(column).eq(column, value),
      ),
    );
    const retainedAppRead = await b.web.request("/app");
    const retainedRoomRead = await b.web.request(`/app/rooms/${scope.roomId}`);
    const retainedDirect = b.web.dataClient();
    const retainedReads = await Promise.all(
      reads.map(({ table, column, value }) =>
        retainedDirect.from(table).select(column).eq(column, value),
      ),
    );
    ensure(
      deletedClaims.exp > Date.now() / 1000,
      "Physical-delete regression must retain an unexpired pre-deletion access JWT",
    );
    trustedLoginRedirect(deletedAppRead, stack.config.app);
    trustedLoginRedirect(deletedRoomRead, stack.config.app);
    await rejected(deletedMutation, 401, "UNAUTHENTICATED");
    ensure(
      deletedRpc.error?.code === "P0001" && deletedRpc.error.message === "UNAUTHENTICATED",
      "Physically deleted account's issued JWT must not execute a mutation RPC",
    );
    for (const [index, result] of deletedReads.entries()) {
      ensure(
        (result.status === 200 && !result.error && result.data.length === 0) ||
          ([401, 403].includes(result.status) && result.error),
        `Physically deleted account's issued JWT must not read ${reads[index].table}`,
      );
    }
    ensure(
      retainedAppRead.status === 200 && retainedRoomRead.status === 200,
      "Retained owner's Auth session and room access must survive physical deletion",
    );
    for (const [index, result] of retainedReads.entries()) {
      ensure(
        !result.error && result.data.length > 0,
        `Retained owner must still read ${reads[index].table} after physical deletion`,
      );
    }

    const banned = await stack.person("disabled-member");
    await stack.join(banned, await stack.invite(b, scope.roomId));
    const direct = banned.web.dataClient();
    const issuedToken = banned.web.sessionData().access_token;
    ensure(typeof issuedToken === "string", "Ban regression requires an Auth-issued access JWT");
    const issuedClaims = JSON.parse(
      Buffer.from(issuedToken.split(".")[1], "base64url").toString("utf8"),
    );
    const capturedCookies = [...banned.web.jar];
    const retainedWeb = () => {
      const web = new WebSession(stack.config);
      for (const [name, value] of capturedCookies) web.jar.set(name, value);
      return web;
    };
    for (const { table, column, value } of reads) {
      const before = await direct.from(table).select(column).eq(column, value);
      ensure(
        !before.error && before.data.length > 0,
        `Active synthetic member must read ${table} before ban`,
      );
    }
    ensure(
      (await retainedWeb().request(`/app/rooms/${scope.roomId}`)).status === 200,
      "Issued member session must read its room before ban",
    );
    await stack.disable(banned);

    // Each web request starts with the pre-ban cookies; the direct client keeps its issued JWT.
    const appRead = await retainedWeb().request("/app");
    const roomRead = await retainedWeb().request(`/app/rooms/${scope.roomId}`);
    const mutation = await retainedWeb().post("/api/access/bootstrap", {
      groupName: "그룹",
      title: "방",
      goal: "목표",
      observation: "근거",
      environment: "환경",
      displayAlias: "별칭",
    });
    const rpc = await direct.rpc("access_bootstrap", {
      p_group_name: "합성 금지 그룹",
      p_title: "합성 금지 방",
      p_goal: "목표",
      p_observation: "근거",
      p_environment: "환경",
      p_display_alias: "중지된 멤버",
    });
    if (!rpc.error && typeof rpc.data?.organizationId === "string")
      await stack.trackOrganization(rpc.data.organizationId);
    const after = await Promise.all(
      reads.map(({ table, column, value }) => direct.from(table).select(column).eq(column, value)),
    );
    ensure(
      issuedClaims.exp > Date.now() / 1000,
      "Ban regression must retain an unexpired pre-ban access JWT",
    );
    trustedLoginRedirect(appRead, stack.config.app);
    trustedLoginRedirect(roomRead, stack.config.app);
    await rejected(mutation, 401, "UNAUTHENTICATED");
    ensure(
      rpc.error &&
        ((rpc.error.code === "P0001" && rpc.error.message === "UNAUTHENTICATED") ||
          [401, 403].includes(rpc.status)),
      "Banned account's issued JWT must not execute a mutation RPC",
    );
    for (const [index, result] of after.entries()) {
      ensure(
        (result.status === 200 && !result.error && result.data.length === 0) ||
          ([401, 403].includes(result.status) && result.error),
        `Banned account's issued JWT must not read ${reads[index].table}`,
      );
    }
    ensure(
      (await b.web.request(`/app/rooms/${scope.roomId}`)).status === 200,
      "Retained owner's room access must survive another member's ban",
    );

    const softDeleted = await stack.person("soft-deleted-member");
    const unaffectedMember = await stack.person("retained-member");
    await stack.join(softDeleted, await stack.invite(b, scope.roomId));
    await stack.join(unaffectedMember, await stack.invite(b, scope.roomId));
    const softDirect = softDeleted.web.dataClient();
    const softToken = softDeleted.web.sessionData().access_token;
    ensure(
      typeof softToken === "string",
      "Soft-delete regression requires an Auth-issued access JWT",
    );
    const softClaims = JSON.parse(
      Buffer.from(softToken.split(".")[1], "base64url").toString("utf8"),
    );
    const softCookies = [...softDeleted.web.jar];
    const preDeletionWeb = () => {
      const web = new WebSession(stack.config);
      for (const [name, value] of softCookies) web.jar.set(name, value);
      return web;
    };
    const activeAuth = await stack.db.query("select deleted_at from auth.users where id=$1", [
      softDeleted.id,
    ]);
    ensure(
      activeAuth.rowCount === 1 && activeAuth.rows[0].deleted_at === null,
      "Owned Auth row must be active before soft deletion",
    );
    for (const { table, column, value } of reads) {
      const before = await softDirect.from(table).select(column).eq(column, value);
      ensure(
        !before.error && before.data.length > 0,
        `Active synthetic member must read ${table} before soft deletion`,
      );
    }
    ensure(
      (await preDeletionWeb().request(`/app/rooms/${scope.roomId}`)).status === 200,
      "Issued member session must read its room before soft deletion",
    );
    await stack.softDeleteAccount(softDeleted);
    const deletedAuth = await stack.db.query("select deleted_at from auth.users where id=$1", [
      softDeleted.id,
    ]);
    ensure(
      deletedAuth.rowCount === 1 && deletedAuth.rows[0].deleted_at !== null,
      "Actual Auth soft deletion must retain a flagged timestamp row",
    );
    ensure(
      stack.users.has(softDeleted.id),
      "Soft-deleted account must remain tracked for physical cleanup",
    );

    // Preserve the pre-deletion cookies for each HTTP request and the original JWT for direct calls.
    const softAppRead = await preDeletionWeb().request("/app");
    const softRoomRead = await preDeletionWeb().request(`/app/rooms/${scope.roomId}`);
    const softMutation = await preDeletionWeb().post("/api/access/bootstrap", {
      groupName: "그룹",
      title: "방",
      goal: "목표",
      observation: "근거",
      environment: "환경",
      displayAlias: "별칭",
    });
    const softRpc = await softDirect.rpc("access_bootstrap", {
      p_group_name: "합성 삭제 그룹",
      p_title: "합성 삭제 방",
      p_goal: "목표",
      p_observation: "근거",
      p_environment: "환경",
      p_display_alias: "삭제된 멤버",
    });
    if (!softRpc.error && typeof softRpc.data?.organizationId === "string")
      await stack.trackOrganization(softRpc.data.organizationId);
    const softReads = await Promise.all(
      reads.map(({ table, column, value }) =>
        softDirect.from(table).select(column).eq(column, value),
      ),
    );
    ensure(
      softClaims.exp > Date.now() / 1000,
      "Soft-delete regression must retain an unexpired pre-deletion access JWT",
    );
    trustedLoginRedirect(softAppRead, stack.config.app);
    trustedLoginRedirect(softRoomRead, stack.config.app);
    await rejected(softMutation, 401, "UNAUTHENTICATED");
    ensure(
      softRpc.error &&
        ((softRpc.error.code === "P0001" && softRpc.error.message === "UNAUTHENTICATED") ||
          [401, 403].includes(softRpc.status)),
      "Soft-deleted account's issued JWT must not execute a mutation RPC",
    );
    for (const [index, result] of softReads.entries()) {
      ensure(
        (result.status === 200 && !result.error && result.data.length === 0) ||
          ([401, 403].includes(result.status) && result.error),
        `Soft-deleted account's issued JWT must not read ${reads[index].table}`,
      );
    }
    for (const retained of [b, unaffectedMember]) {
      ensure(
        (await retained.web.request(`/app/rooms/${scope.roomId}`)).status === 200,
        "Unaffected owner and member must retain HTTP room access after soft deletion",
      );
      const positiveClient = retained.web.dataClient();
      for (const { table, column, value } of reads) {
        const positiveRead = await positiveClient.from(table).select(column).eq(column, value);
        ensure(
          !positiveRead.error && positiveRead.data.length > 0,
          `Unaffected owner and member must retain direct ${table} reads`,
        );
      }
    }
  }));

test("should reject unsafe origins redirects and oversized or forged mutation bodies", async () =>
  fixture("http-policy", async (stack) => {
    const person = await stack.person("policy");
    for (const malformed of [
      "-".repeat(36),
      "0".repeat(36),
      "00000000-0000-0000-0000-000000000000",
    ]) {
      const response = await person.web.request(`/app/rooms/${malformed}`);
      ensure(response.status === 404, "Malformed opaque room path must return 404");
    }
    const body = {
      groupName: "그룹",
      title: "방",
      goal: "목표",
      observation: "근거",
      environment: "환경",
      displayAlias: "별칭",
    };
    const count = () =>
      stack.db.query(
        "select count(*)::integer as count from public.organizations where owner_user_id=$1",
        [person.id],
      );
    const before = (await count()).rows[0].count;
    for (const origin of ["https://attacker.invalid", "null", ""])
      await rejected(
        await person.web.post("/api/access/bootstrap", body, { Origin: origin }),
        403,
        "UNSAFE_ORIGIN",
      );
    for (const field of ["actor", "actorId", "owner", "ownerId", "redirect", "returnTo", "rpc"])
      await rejected(
        await person.web.post("/api/access/bootstrap", { ...body, [field]: person.id }),
        400,
        "INVALID_BODY",
      );
    await rejected(
      await person.web.post("/api/auth/enter", {
        displayName: person.displayName,
        code: "123456",
        redirect: "//attacker.invalid",
      }),
      400,
      "INVALID_BODY",
    );
    await rejected(
      await person.web.post("/api/access/bootstrap", { ...body, goal: "가".repeat(6000) }),
      400,
      "BODY_TOO_LARGE",
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"goal":"'));
        controller.enqueue(new Uint8Array(17000).fill(97));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const streamed = await person.web.request("/api/access/bootstrap", {
      method: "POST",
      headers: { Origin: stack.config.app, "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await rejected(streamed, 400, "BODY_TOO_LARGE");
    await rejected(await person.web.post("/api/access/not-a-function", {}), 404, "NOT_FOUND");
    await rejected(await person.web.post("/api/auth/not-an-action", {}), 404, "NOT_FOUND");
    const outsider = new WebSession(stack.config);
    const untrustedHeaders: Record<string, string>[] = [
      {},
      { Host: "attacker.invalid" },
      { "X-Forwarded-Host": "attacker.invalid", "X-Forwarded-Proto": "https" },
      {
        Host: "attacker.invalid",
        "X-Forwarded-Host": "other-attacker.invalid",
        "X-Forwarded-Proto": "https",
      },
    ];
    for (const path of ["/app", "/app?redirect=https://attacker.invalid"]) {
      for (const headers of untrustedHeaders)
        trustedLoginRedirect(await outsider.request(path, { headers }), stack.config.app);
    }
    ensure(
      (await count()).rows[0].count === before,
      "Rejected bodies must not mutate the database",
    );
  }));

test("should restrict database reads and mutations to active tenant and room members", async () =>
  fixture("rls", async (stack) => {
    const a = await stack.person("owner");
    const b = await stack.person("member");
    const outsider = await stack.person("other-tenant");
    const scope = await stack.bootstrap(a);
    const otherScope = await stack.bootstrap(outsider);
    const second = await a.web.mutate("room", {
      organizationId: scope.organizationId,
      title: "비초대 방",
      goal: "목표",
      observation: "근거",
      environment: "환경",
    });
    await stack.join(b, await stack.invite(a, scope.roomId));
    ensure(
      (await b.web.request(`/app/rooms/${scope.roomId}`)).status === 200,
      "Invited room must be readable",
    );
    await blockedRoom(b, second.roomId as string);
    await blockedRoom(b, otherScope.roomId);
    await blockedRoom(outsider, scope.roomId);
    const anonymous = new WebSession(stack.config);
    ensure(
      (await anonymous.request(`/app/rooms/${scope.roomId}`)).status === 307,
      "Anonymous web room read must require Auth",
    );
    const anonRead = await fetch(`${stack.config.api}/rest/v1/rooms?select=id`, {
      headers: { apikey: stack.config.key },
    });
    ensure(!anonRead.ok, "Anonymous direct table read must be denied by grants");
    const anonRpc = await fetch(`${stack.config.api}/rest/v1/rpc/access_invite`, {
      method: "POST",
      headers: { apikey: stack.config.key, "Content-Type": "application/json" },
      body: JSON.stringify({ p_room_id: scope.roomId, p_role: "observer" }),
    });
    ensure(!anonRpc.ok, "Anonymous direct mutation RPC must be denied by execute grants");
    for (const person of [a, b, outsider]) {
      const client = person.web.dataClient();
      ensure(
        (
          await client.from("rooms").insert({
            organization_id: scope.organizationId,
            owner_user_id: person.id,
            title: "위조",
            goal: "목표",
            observation: "근거",
            environment: "환경",
          })
        ).error,
        "Direct room INSERT must be denied",
      );
      ensure(
        (await client.from("rooms").update({ title: "위조" }).eq("id", scope.roomId)).error,
        "Direct room UPDATE must be denied",
      );
      ensure(
        (await client.from("rooms").delete().eq("id", scope.roomId)).error,
        "Direct room DELETE must be denied",
      );
    }
    await rejected(
      await outsider.web.post("/api/access/invite", { roomId: scope.roomId, role: "participant" }),
      403,
      "FORBIDDEN",
    );
    await a.web.mutate("revoke-room-member", { roomId: scope.roomId, userId: b.id });
    await blockedRoom(b, scope.roomId);
    ensure(
      (
        await b.web
          .dataClient()
          .rpc("access_invite", { p_room_id: scope.roomId, p_role: "observer" })
      ).error,
      "Removed member RPC must be denied",
    );
    const grants = await stack.db.query(
      "select has_table_privilege('authenticated','public.rooms','INSERT') as insert, has_table_privilege('anon','public.rooms','SELECT') as anon, has_table_privilege('authenticated','room_access_private.room_invites','SELECT') as invites",
    );
    assert.deepEqual(grants.rows[0], { insert: false, anon: false, invites: false });
    const config = await stack.db.query(
      "select p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'access_%'",
    );
    ensure(
      config.rowCount === 6 &&
        config.rows.every((row) => row.prosecdef && row.proconfig.includes('search_path=""')),
      "All fixed RPCs must use an empty definer search path",
    );
  }));

test("should prevent client roles and metadata from promoting room privileges", async () =>
  fixture("roles", async (stack) => {
    const a = await stack.person("owner");
    const scope = await stack.bootstrap(a);
    for (const role of ["observer", "participant"]) {
      const b = await stack.person(role);
      await stack.join(b, await stack.invite(a, scope.roomId, role));
      const session = b.web.sessionData();
      const client = b.web.dataClient();
      const update = await fetch(`${stack.config.api}/auth/v1/user`, {
        method: "PUT",
        headers: {
          apikey: stack.config.key,
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          data: { role: "owner", organization_id: scope.organizationId, room_id: scope.roomId },
        }),
      });
      ensure(update.ok, "Synthetic metadata update should be accepted independently of membership");
      // Metadata is not used to authorize either web or direct RPC mutations.
      await rejected(
        await b.web.post("/api/access/invite", { roomId: scope.roomId, role: "observer" }),
        403,
        "FORBIDDEN",
      );
      ensure(
        (await client.rpc("access_invite", { p_room_id: scope.roomId, p_role: "participant" }))
          .error,
        "Non-owner direct invite RPC must fail",
      );
      ensure(
        (
          await client
            .from("room_members")
            .update({ role: "owner" })
            .eq("room_id", scope.roomId)
            .eq("user_id", b.id)
        ).error,
        "Direct membership role promotion must fail",
      );
      ensure(
        (
          await client.from("organization_members").insert({
            organization_id: scope.organizationId,
            user_id: b.id,
            role: "owner",
            display_alias: "위조",
          })
        ).error,
        "Direct group ownership insertion must fail",
      );
      ensure(
        (
          await client
            .from("organization_members")
            .delete()
            .eq("organization_id", scope.organizationId)
        ).error,
        "Direct group membership deletion must fail",
      );
      ensure(
        (
          await client
            .from("organizations")
            .update({ owner_user_id: b.id })
            .eq("id", scope.organizationId)
        ).error,
        "Direct owner change must fail",
      );
      const actual = await stack.db.query(
        "select role from public.room_members where room_id=$1 and user_id=$2",
        [scope.roomId, b.id],
      );
      assert.equal(actual.rows[0].role, role);
      ensure(session.access_token, "Role test must use a real issued Auth session");
    }
    await rejected(
      await a.web.post("/api/access/invite", { roomId: scope.roomId, role: "owner" }),
      400,
      "INVALID_BODY",
    );
  }));

test("should consume an unexpired invitation once under concurrent requests", async () =>
  fixture("concurrent", async (stack) => {
    const a = await stack.person("issuer");
    const b = await stack.person("b");
    const c = await stack.person("c");
    const scope = await stack.bootstrap(a);
    const code = await stack.invite(a, scope.roomId);
    const results = await Promise.all(
      [b, c].map((person) =>
        person.web.dataClient().rpc("access_join", { p_code: code, p_display_alias: "동시 멤버" }),
      ),
    );
    ensure(
      results.filter((result) => !result.error).length === 1 &&
        results.filter((result) => result.error?.message === "INVITE_UNAVAILABLE").length === 1,
      "Concurrent real Auth clients must consume exactly once",
    );
    const rows = await stack.db.query(
      "select code_hash,consumed_at,expires_at <= created_at+interval '24 hours' as bounded_ttl from room_access_private.room_invites where room_id=$1",
      [scope.roomId],
    );
    ensure(
      rows.rowCount === 1 &&
        rows.rows[0].consumed_at &&
        rows.rows[0].code_hash === createHash("sha256").update(code).digest("hex") &&
        rows.rows[0].bounded_ttl,
      "Only an invitation hash and one consumption should be stored",
    );
    const membership = await stack.db.query(
      "select count(*)::integer as count from public.room_members where room_id=$1 and role='participant' and status='active'",
      [scope.roomId],
    );
    assert.equal(membership.rows[0].count, 1);
    const expired = await stack.invite(a, scope.roomId);
    await stack.db.query(
      "update room_access_private.room_invites set created_at=now()-interval '24 hours',expires_at=now()-interval '1 second' where room_id=$1 and consumed_at is null",
      [scope.roomId],
    );
    await rejected(
      await c.web.post("/api/access/join", { code: expired, displayAlias: "만료" }),
      409,
      "INVITE_UNAVAILABLE",
    );
    const otherScope = await stack.bootstrap(c);
    let crossScopeRejected = false;
    try {
      await stack.db.query(
        "update room_access_private.room_invites set organization_id=$2 where room_id=$1 and consumed_at is null",
        [scope.roomId, otherScope.organizationId],
      );
    } catch (error) {
      crossScopeRejected = (error as { code?: string }).code === "23503";
    }
    ensure(
      crossScopeRejected,
      "Invitation tenant/room foreign key must reject mismatched owned scopes",
    );
    const invalidScope = await stack.invite(a, scope.roomId);
    await stack.db.query(
      "update room_access_private.room_invites set organization_version=organization_version+1 where room_id=$1 and consumed_at is null and expires_at>now()",
      [scope.roomId],
    );
    await rejected(
      await b.web.post("/api/access/join", { code: invalidScope, displayAlias: "scope" }),
      409,
      "INVITE_UNAVAILABLE",
    );
  }));

test("should preserve active roles and restore removed members only with a fresh invitation", async () =>
  fixture("rejoin", async (stack) => {
    const a = await stack.person("owner");
    const scope = await stack.bootstrap(a);
    const people = [a, await stack.person("participant"), await stack.person("observer")];
    for (const [index, person] of people.entries()) {
      if (index)
        await stack.join(
          person,
          await stack.invite(a, scope.roomId, index === 1 ? "participant" : "observer"),
        );
      const code = await stack.invite(a, scope.roomId, "observer");
      const before = await state(stack, scope.organizationId, scope.roomId);
      await rejected(
        await person.web.post("/api/access/join", { code, displayAlias: "중복" }),
        409,
        "ALREADY_MEMBER",
      );
      ensure(
        (await state(stack, scope.organizationId, scope.roomId)) === before,
        "Duplicate active joins must preserve role, invite and audit",
      );
    }
    const b = people[1];
    const second = await a.web.mutate("room", {
      organizationId: scope.organizationId,
      title: "두번째",
      goal: "목표",
      observation: "근거",
      environment: "환경",
    });
    await stack.join(b, await stack.invite(a, second.roomId as string));
    const old = await stack.invite(a, scope.roomId);
    await a.web.mutate("revoke-group-member", {
      organizationId: scope.organizationId,
      userId: b.id,
    });
    await rejected(
      await b.web.post("/api/access/join", { code: old, displayAlias: "옛 초대" }),
      409,
      "INVITE_UNAVAILABLE",
    );
    await stack.join(b, await stack.invite(a, scope.roomId, "observer"));
    const group = await stack.db.query(
      "select role,status from public.organization_members where organization_id=$1 and user_id=$2",
      [scope.organizationId, b.id],
    );
    assert.deepEqual(group.rows[0], { role: "member", status: "active" });
    const member = await stack.db.query(
      "select role,status from public.room_members where room_id=$1 and user_id=$2",
      [scope.roomId, b.id],
    );
    assert.deepEqual(member.rows[0], { role: "observer", status: "active" });
    await blockedRoom(b, second.roomId as string);
    // The organization's active owner joins a new room without role demotion.
    const third = await a.web.mutate("room", {
      organizationId: scope.organizationId,
      title: "세번째",
      goal: "목표",
      observation: "근거",
      environment: "환경",
    });
    await rejected(
      await a.web.post("/api/access/join", {
        code: await stack.invite(a, third.roomId as string),
        displayAlias: "소유자",
      }),
      409,
      "ALREADY_MEMBER",
    );
    const owner = await stack.db.query(
      "select role from public.organization_members where organization_id=$1 and user_id=$2",
      [scope.organizationId, a.id],
    );
    assert.equal(owner.rows[0].role, "owner");
  }));

test("should revoke access and invalidate older invitations atomically", async () =>
  fixture("revoke", async (stack) => {
    const a = await stack.person("owner");
    const b = await stack.person("member");
    const c = await stack.person("other");
    const scope = await stack.bootstrap(a);
    await stack.join(b, await stack.invite(a, scope.roomId));
    const old = await stack.invite(a, scope.roomId);
    const before = await stack.db.query("select access_version from public.rooms where id=$1", [
      scope.roomId,
    ]);
    await a.web.mutate("revoke-room-member", { roomId: scope.roomId, userId: b.id });
    await blockedRoom(b, scope.roomId);
    await rejected(
      await b.web.post("/api/access/join", { code: old, displayAlias: "재참가" }),
      409,
      "INVITE_UNAVAILABLE",
    );
    const after = await stack.db.query("select access_version from public.rooms where id=$1", [
      scope.roomId,
    ]);
    ensure(
      BigInt(after.rows[0].access_version) === BigInt(before.rows[0].access_version) + 1n,
      "Removal and room version change must commit together",
    );
    await rejected(
      await a.web.post("/api/access/revoke-room-member", { roomId: scope.roomId, userId: a.id }),
      403,
      "FORBIDDEN",
    );
    await rejected(
      await a.web.post("/api/access/revoke-group-member", {
        organizationId: scope.organizationId,
        userId: a.id,
      }),
      403,
      "FORBIDDEN",
    );
    const code = await stack.invite(a, scope.roomId);
    await stack.disable(a);
    await rejected(
      await c.web.post("/api/access/join", { code, displayAlias: "중지 발급자" }),
      409,
      "INVITE_UNAVAILABLE",
    );

    const softIssuer = await stack.person("soft-deleted-issuer");
    const softScope = await stack.bootstrap(softIssuer);
    await stack.join(b, await stack.invite(softIssuer, softScope.roomId));
    const softCode = await stack.invite(softIssuer, softScope.roomId, "observer");
    await stack.softDeleteAccount(softIssuer);
    const issuerAuth = await stack.db.query("select deleted_at from auth.users where id=$1", [
      softIssuer.id,
    ]);
    ensure(
      issuerAuth.rowCount === 1 && issuerAuth.rows[0].deleted_at !== null,
      "Invitation issuer must have a real Auth soft-delete timestamp",
    );
    const beforeSoftJoin = await state(stack, softScope.organizationId, softScope.roomId);
    await rejected(
      await c.web.post("/api/access/join", { code: softCode, displayAlias: "삭제 발급자" }),
      409,
      "INVITE_UNAVAILABLE",
    );
    const softJoinRpc = await c.web
      .dataClient()
      .rpc("access_join", { p_code: softCode, p_display_alias: "삭제 발급자" });
    ensure(
      softJoinRpc.error?.code === "P0001" && softJoinRpc.error.message === "INVITE_UNAVAILABLE",
      "Direct join must reject a soft-deleted issuer's old invitation",
    );
    ensure(
      (await state(stack, softScope.organizationId, softScope.roomId)) === beforeSoftJoin,
      "Rejected soft-deleted issuer joins must preserve unconsumed invitations, member roles and audit",
    );
    const pendingInvite = await stack.db.query(
      "select consumed_at,consumed_by from room_access_private.room_invites where room_id=$1 and code_hash=$2",
      [softScope.roomId, createHash("sha256").update(softCode).digest("hex")],
    );
    ensure(
      pendingInvite.rowCount === 1 &&
        pendingInvite.rows[0].consumed_at === null &&
        pendingInvite.rows[0].consumed_by === null,
      "Soft-deleted issuer's invitation must remain unconsumed",
    );
    ensure(
      (await b.web.request(`/app/rooms/${softScope.roomId}`)).status === 200,
      "Unaffected member must retain access when only the issuer is soft deleted",
    );
    ensure(
      (await c.web.request("/app")).status === 200,
      "Unaffected joiner's Auth session must survive issuer soft deletion",
    );
  }));

test("should commit authoritative audit records with access changes", async () =>
  fixture("audit", async (stack) => {
    const a = await stack.person("owner");
    const b = await stack.person("member");
    const scope = await stack.bootstrap(a);
    const code = await stack.invite(a, scope.roomId, "observer");
    await stack.join(b, code);
    const rows = await stack.db.query(
      "select actor_user_id,actor_role,action,target_user_id,target_role,result from room_access_private.access_audit where organization_id=$1 order by created_at,id",
      [scope.organizationId],
    );
    ensure(
      rows.rowCount === 3,
      "Exactly one authoritative audit per successful mutation is required",
    );
    const join = rows.rows.find((row) => row.action === "join");
    ensure(
      join.actor_user_id === b.id &&
        join.target_user_id === b.id &&
        join.actor_role === "new-member" &&
        join.target_role === "observer" &&
        join.result === "success",
      "Audit must reflect the actual actor and granted role",
    );
    ensure(
      !JSON.stringify(rows.rows).includes(code),
      "Raw invitation must not appear in audit data",
    );
    const client = b.web.dataClient();
    const insert = await client.schema("room_access_private").from("access_audit").insert({
      organization_id: scope.organizationId,
      actor_user_id: a.id,
      action: "join",
      actor_role: "owner",
    });
    ensure(insert.error, "Client audit forgery must be rejected");
    ensure(
      (
        await client
          .schema("room_access_private")
          .from("access_audit")
          .update({ result: "success" })
          .eq("organization_id", scope.organizationId)
      ).error,
      "Client audit update must be rejected",
    );
    const before = await state(stack, scope.organizationId, scope.roomId);
    await rejected(
      await b.web.post("/api/access/invite", { roomId: scope.roomId, role: "participant" }),
      403,
      "FORBIDDEN",
    );
    ensure(
      (await state(stack, scope.organizationId, scope.roomId)) === before,
      "Failed authority checks must not write successful audit or membership changes",
    );
    const direct = await a.web.dataClient().rpc("access_bootstrap", {
      p_group_name: "失敗",
      p_title: "失敗",
      p_goal: "목표",
      p_observation: "근거",
      p_environment: "환경",
      p_display_alias: "",
    });
    ensure(direct.error, "Constraint failure must reject the full bootstrap transaction");
    const count = await stack.db.query(
      "select count(*)::integer as count from public.organizations where owner_user_id=$1",
      [a.id],
    );
    assert.equal(count.rows[0].count, 1);
  }));

test("should keep user responses cookies and invitation secrets out of shared caches", async () =>
  fixture("cache", async (stack) => {
    const a = await stack.person("owner");
    const b = await stack.person("other");
    const scope = await stack.bootstrap(a);
    for (const person of [a, b]) {
      const response = await person.web.request("/app");
      ensure(
        response.headers.get("cache-control")?.includes("private") &&
          response.headers.get("cache-control")?.includes("no-store"),
        "Protected personalized pages must disable shared cache",
      );
      const html = await response.text();
      ensure(
        !html.includes(String(person.web.sessionData().access_token)) &&
          !html.includes(String(person.web.sessionData().refresh_token)),
        "Session secrets must not appear in HTML",
      );
    }
    const response = await a.web.post("/api/access/invite", {
      roomId: scope.roomId,
      role: "observer",
    });
    ensure(
      response.headers.get("cache-control")?.includes("no-store"),
      "One-time invitation response must disable cache",
    );
    const envelope = await response.json();
    const code = envelope.data.code;
    ensure(!response.url.includes(code), "Invitation code must not be put in a URL");
    ensure(
      !(await (await a.web.request(`/app/rooms/${scope.roomId}`)).text()).includes(code),
      "Issued code must not be restored in a shared room response",
    );
    await blockedRoom(b, scope.roomId);
    const error = await b.web.post("/api/access/invite", {
      roomId: scope.roomId,
      role: "observer",
    });
    ensure(
      !(await error.text()).includes(code),
      "Rejected user's response must not contain another user's invite",
    );
  }));

test("should refuse integration setup and cleanup outside the owned local stack", async () => {
  // These pure guards run before docker, DB, Auth, fixture creation or cleanup.
  const owned: StackConfig = {
    workdir: "/owned-synthetic-workdir",
    project: "ai-collab-txxcvm61",
    api: "http://127.0.0.1:56321",
    db: "postgresql://fixture@127.0.0.1:56322/postgres",
    mail: "http://127.0.0.1:56324",
    app: "http://127.0.0.1:4318",
    key: "synthetic-publishable",
    adminKey: "synthetic-admin",
  };
  let sideEffects = 0;
  for (const altered of [
    { project: "other-project" },
    { api: "https://remote.invalid" },
    { db: "postgresql://fixture@remote.invalid:5432/postgres" },
    { mail: "http://127.0.0.1:56325" },
    { app: "http://127.0.0.1:4319" },
  ]) {
    assert.throws(() => {
      assertOwnedConfig({ ...owned, ...altered });
      sideEffects++;
    });
    await assert.rejects(() => LocalAccessStack.open("refused", { ...owned, ...altered }));
  }
  assert.equal(sideEffects, 0);
  const env = productEnvironment({
    PATH: "synthetic-path",
    SUPABASE_URL: owned.api,
    SUPABASE_PUBLISHABLE_KEY: owned.key,
    APP_ORIGIN: owned.app,
    LOCAL_ACCESS_ADMIN_KEY: "synthetic-admin",
    LOCAL_ACCESS_DB_URL: "synthetic-db",
    LOCAL_ACCESS_SIGNING_JWK: "synthetic-jwk",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
    PLAYWRIGHT_NO_COPY_PROMPT: "1",
  });
  assert.deepEqual(Object.keys(env).sort(), [
    "APP_ORIGIN",
    "PATH",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_URL",
  ]);
  await fixture("cleanup", async (stack) => {
    const a = await stack.person("owned");
    const scope = await stack.bootstrap(a);
    ensure(
      stack.users.size === 1 &&
        stack.users.has(a.id) &&
        stack.organizations.size === 1 &&
        stack.organizations.has(scope.organizationId),
      "Cleanup must record exact created IDs",
    );
    await assert.rejects(() => stack.trackOrganization("00000000-0000-4000-8000-000000000000"));
    const other = new WebSession(stack.config);
    await rejected(
      await other.post("/api/access/join", { code: "a".repeat(64), displayAlias: "미인증" }),
      401,
      "UNAUTHENTICATED",
    );
  });
});
