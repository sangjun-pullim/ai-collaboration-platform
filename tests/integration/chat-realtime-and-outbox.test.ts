import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";
const Serializer = createRequire(import.meta.url)(
  "@supabase/realtime-js/dist/main/lib/serializer.js",
).default as new () => {
  decode(payload: ArrayBuffer | string, callback: (decoded: unknown) => void): void;
};
import { randomUUID } from "node:crypto";
import { chromium, expect, type Browser } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  workflowCase,
  type WorkflowFixture,
  type HumanDirectScene,
} from "../helpers/workflow-fixture.js";
import { assertOwnedStack, type FixturePerson } from "../helpers/local-access-stack.js";
import { installOutboxHarness } from "../helpers/chat-outbox-browser.js";
import type { SpeechOutbox } from "../../src/features/investigation-coordinator/chat-outbox.js";
import type {
  Body,
  RecoveryHistoryPage,
} from "../../src/features/investigation-coordinator/contracts.js";
import type { RealtimeGrant } from "../../src/features/investigation-coordinator/realtime-contracts.js";

declare global {
  var outbox: SpeechOutbox;
  var Outbox: new (
    factory?: () => IDBFactory,
    now?: () => number,
    storage?: () => Storage,
  ) => SpeechOutbox;
}
async function chatCase(label: string, run: (fixture: WorkflowFixture) => Promise<void>) {
  return workflowCase(label, async (fixture) => {
    try {
      await run(fixture);
    } catch (error) {
      const stack = error instanceof Error ? (error.stack ?? "") : "";
      const frames = [...stack.matchAll(/chat-realtime-and-outbox\.test\.(?:js|ts):(\d+):(\d+)/g)]
        .slice(0, 4)
        .map((match) => ({ line: Number(match[1]), column: Number(match[2]) }));
      console.error(JSON.stringify({ source: "chat-realtime-outbox", fixture: label, frames }));
      throw error;
    }
  });
}
async function scope(f: WorkflowFixture, s: HumanDirectScene) {
  await assertOwnedStack(f.stack.config);
  assert.equal(f.rooms.get(s.scope.roomId), s.scope.organizationId);
  assert.ok(f.stack.users.has(s.requester.id));
  const installed = await f.stack.db.query(
    "select to_regprocedure('public.chat_realtime_authorize(jsonb)') is not null installed",
  );
  assert.equal(installed.rows[0].installed, true);
}
async function authorize(
  person: FixturePerson,
  roomId: string,
  clientId: string = randomUUID(),
  leaseId?: string,
) {
  const response = await person.web.post("/api/chat-realtime/authorize", {
    protocol: 1,
    roomId,
    expectedUserId: person.id,
    clientId,
    ...(leaseId ? { leaseId } : {}),
  });
  const envelope = await response.json();
  assert.equal(response.status, 200);
  assert.equal(envelope.ok, true);
  return envelope.data as RealtimeGrant;
}
async function browserPage(
  browser: Browser,
  f: WorkflowFixture,
  person: FixturePerson,
  roomId: string,
  width = 1440,
  measureMarkdown = false,
) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addCookies(
    f.stack
      .entryForBrowser(person)
      .cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
  );
  if (measureMarkdown)
    await context.addInitScript(() => {
      type Fiber = {
        elementType?: { displayName?: string };
        flags: number;
        memoizedProps?: { messageId?: string };
        alternate?: Fiber | null;
        child?: Fiber | null;
        sibling?: Fiber | null;
      };
      const renders = new Map<string, number>();
      const lastCommittedProps = new Map<string, object>();
      Object.defineProperty(globalThis, "__chatMarkdownRenderCounts", {
        get: () => Object.fromEntries(renders),
      });
      Object.assign(globalThis, {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: {
          supportsFiber: true,
          inject: () => 1,
          onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
            const visit = (fiber: Fiber | null | undefined) => {
              for (let current = fiber; current; current = current.sibling) {
                if (
                  current.elementType?.displayName === "ChatMarkdown" &&
                  current.memoizedProps?.messageId
                ) {
                  const id = current.memoizedProps.messageId;
                  if (lastCommittedProps.get(id) !== current.memoizedProps && current.flags & 1)
                    renders.set(id, (renders.get(id) ?? 0) + 1);
                  lastCommittedProps.set(id, current.memoizedProps);
                }
                visit(current.child);
              }
            };
            visit(root.current);
          },
          onCommitFiberUnmount: () => {},
        },
      });
    });
  const page = await context.newPage();
  await page.goto(`${f.stack.config.app}/app/rooms/${roomId}`);
  return { context, page };
}
async function read(person: FixturePerson, roomId: string, afterSequence = 0) {
  const response = await person.web.post("/api/investigations/read-recovery", {
    protocol: 1,
    roomId,
    expectedUserId: person.id,
    afterSequence,
    afterRetirementSequence: 0,
  });
  assert.equal(response.status, 200);
  return (await response.json()).data as RecoveryHistoryPage;
}
async function speak(
  f: WorkflowFixture,
  s: HumanDirectScene,
  text: string,
  operationId: string = randomUUID(),
) {
  const response = await f.human(s.requester, "speak", {
    roomId: s.scope.roomId,
    expectedUserId: s.requester.id,
    operationId,
    publicText: text,
  });
  assert.equal(response.status, 200);
  return operationId;
}

test(
  "should authorize exact session leases and isolate tabs including lost authorization responses",
  { timeout: 300_000 },
  async () =>
    chatCase("realtime-lease-risk", async (f) => {
      const s = await f.directScene("lease-risk");
      await scope(f, s);
      const a = await authorize(s.requester, s.scope.roomId),
        b = await authorize(s.requester, s.scope.roomId);
      assert.notEqual(a.leaseId, b.leaseId);
      assert.notEqual(a.topic, b.topic);
      const again = await authorize(s.requester, s.scope.roomId, a.clientId);
      assert.equal(again.leaseId, a.leaseId);
      const renewed = await authorize(s.requester, s.scope.roomId, a.clientId, a.leaseId);
      assert.equal(renewed.leaseId, a.leaseId);
      for (const fields of [
        { expectedUserId: s.owner.id, clientId: a.clientId, leaseId: a.leaseId },
        { clientId: b.clientId, leaseId: a.leaseId },
        { clientId: a.clientId, leaseId: b.leaseId },
      ]) {
        const response = await s.requester.web.post("/api/chat-realtime/authorize", {
          protocol: 1,
          roomId: s.scope.roomId,
          expectedUserId: s.requester.id,
          ...fields,
        });
        assert.equal(response.status, 403);
      }
      const outsider = await s.outsider.web.post("/api/chat-realtime/authorize", {
        protocol: 1,
        roomId: s.scope.roomId,
        expectedUserId: s.outsider.id,
        clientId: randomUUID(),
      });
      assert.equal(outsider.status, 403);
      const expired = await f.stack.db.query(
        "update chat_realtime_private.leases set expires_at=clock_timestamp()-interval '1 second' where id=$1 and user_id=$2 returning id",
        [a.leaseId, s.requester.id],
      );
      assert.equal(expired.rowCount, 1);
      const denied = await s.requester.web.post("/api/chat-realtime/authorize", {
        protocol: 1,
        roomId: s.scope.roomId,
        expectedUserId: s.requester.id,
        clientId: a.clientId,
        leaseId: a.leaseId,
      });
      assert.equal(denied.status, 403);
      const fresh = await authorize(s.requester, s.scope.roomId, a.clientId);
      assert.notEqual(fresh.topic, a.topic);
      const released = await s.requester.web.post("/api/chat-realtime/release", {
        protocol: 1,
        roomId: s.scope.roomId,
        expectedUserId: s.requester.id,
        clientId: fresh.clientId,
        leaseId: fresh.leaseId,
      });
      assert.equal(released.status, 200);
      const unaffected = await f.stack.db.query(
        "select revoked_at is null live from chat_realtime_private.leases where id=$1 and user_id=$2",
        [b.leaseId, s.requester.id],
      );
      assert.equal(unaffected.rows[0].live, true);
      const jwt = JSON.parse(
        Buffer.from(b.accessToken.split(".")[1], "base64url").toString("utf8"),
      );
      const deleted = await f.stack.db.query(
        "delete from auth.sessions where id=$1 and user_id=$2 returning id",
        [jwt.session_id, s.requester.id],
      );
      assert.equal(deleted.rowCount, 1);
      const afterLogout = await s.requester.web.post("/api/chat-realtime/authorize", {
        protocol: 1,
        roomId: s.scope.roomId,
        expectedUserId: s.requester.id,
        clientId: b.clientId,
        leaseId: b.leaseId,
      });
      assert.ok([401, 403].includes(afterLogout.status));
    }),
);

test(
  "should receive twenty synthetic messages over real WebSockets and stop publishing after membership revocation",
  { timeout: 300_000 },
  async () =>
    chatCase("realtime-ws-risk", async (f) => {
      const s = await f.directScene("ws-risk");
      await scope(f, s);
      const browser = await chromium.launch({ headless: true });
      try {
        const a = await browserPage(browser, f, s.requester, s.scope.roomId),
          b = await browserPage(browser, f, s.observer, s.scope.roomId, 390);
        const frames: number[][] = [[], []];
        console.log(JSON.stringify({ source: "realtime-ws", phase: "browser-created" }));
        for (const [index, entry] of [a, b].entries()) {
          entry.page.on("websocket", (socket) =>
            socket.on("framereceived", (frame) => {
              try {
                let packet: unknown;
                new Serializer().decode(
                  typeof frame.payload === "string"
                    ? frame.payload
                    : Uint8Array.from(frame.payload).buffer,
                  (decoded: unknown) => {
                    packet = decoded;
                  },
                );
                const hint = (value: unknown): boolean => {
                  if (!value || typeof value !== "object") return false;
                  if (Array.isArray(value)) return value.some(hint);
                  const envelope = value as { event?: unknown; payload?: { version?: unknown } };
                  return (
                    (envelope.event === "changed" && envelope.payload?.version === 1) ||
                    Object.values(value).some(hint)
                  );
                };
                if (hint(packet)) frames[index].push(Date.now());
              } catch {
                /* Heartbeat and binary transport frames are not change evidence. */
              }
            }),
          );
          await entry.page.reload();
          await expect(entry.page.getByRole("status", { name: "실시간 연결 상태" })).toHaveText(
            "실시간 연결",
            { timeout: 30_000 },
          );
        }
        console.log(JSON.stringify({ source: "realtime-ws", phase: "both-subscribed" }));
        const latencies: number[] = [];
        for (let i = 0; i < 20; i++) {
          console.log(JSON.stringify({ source: "realtime-ws", phase: "message", index: i }));
          const text = `WS 합성 발언 ${i} ${randomUUID()}`;
          const before = Date.now();
          const counts = frames.map((list) => list.length);
          await speak(f, s, text);
          for (const entry of [a, b])
            await expect(entry.page.getByLabel("확정 공동 이력")).toContainText(text, {
              timeout: 2000,
            });
          for (let index = 0; index < 2; index++) {
            await expect
              .poll(() => frames[index].length, { timeout: 2000 })
              .toBeGreaterThan(counts[index]);
            latencies.push(Date.now() - before);
          }
        }
        latencies.sort((x, y) => x - y);
        const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
        assert.ok(p95 <= 2000);
        console.log(
          JSON.stringify({ fixture: "20 synthetic messages, 2 real browser sockets", p95Ms: p95 }),
        );
        const secrets = await a.page.evaluate(async () => ({
          local: JSON.stringify(localStorage),
          session: JSON.stringify(sessionStorage),
          cookie: document.cookie,
          databases: await indexedDB.databases(),
        }));
        assert.ok(
          !secrets.local.includes("access_token") && !secrets.session.includes("access_token"),
        );
        const counts = frames.map((list) => list.length);
        await f.stack.db.query(
          "update public.room_members set status='removed' where room_id=$1 and user_id=$2",
          [s.scope.roomId, s.observer.id],
        );
        await speak(f, s, `철회 뒤 합성 발언 ${randomUUID()}`);
        await expect.poll(() => frames[0].length, { timeout: 5000 }).toBeGreaterThan(counts[0]);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(frames[1].length, counts[1]);
        await f.stack.db.query(
          "update public.room_members set status='active' where room_id=$1 and user_id=$2",
          [s.scope.roomId, s.observer.id],
        );
        await a.context.close();
        await b.context.close();
      } finally {
        await browser.close();
      }
    }),
);

test(
  "should serialize real IndexedDB reservations and restore the same speech after a browser context restart",
  { timeout: 300_000 },
  async () =>
    chatCase("outbox-browser-risk", async (f) => {
      const s = await f.directScene("outbox-risk");
      await scope(f, s);
      const profile = join(f.devices.root, "speech-browser-profile");
      let context = await chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: { width: 1440, height: 900 },
      });
      try {
        await context.addCookies(
          f.stack.entryForBrowser(s.requester).cookies.map((cookie) => ({
            ...cookie,
            sameSite: "Lax" as const,
            expires: Math.floor(Date.now() / 1000) + 3600,
          })),
        );
        let page = await context.newPage();
        await page.goto(`${f.stack.config.app}/app/rooms/${s.scope.roomId}`);
        let second = await context.newPage();
        await second.goto(f.stack.config.app + "/login");
        await installOutboxHarness(page);
        await installOutboxHarness(second);
        const make = (text: string): Body => ({
          protocol: 1,
          roomId: s.scope.roomId,
          expectedUserId: s.requester.id,
          operationId: randomUUID(),
          publicText: text,
        });
        const bodies = [make("첫 탭 저장 원문"), make("둘째 탭 저장 원문")];
        const results = await Promise.all(
          [page, second].map((p, index) =>
            p.evaluate(async (body) => {
              try {
                return { ok: true, entry: await outbox.reserve(body) };
              } catch {
                return { ok: false };
              }
            }, bodies[index]),
          ),
        );
        assert.equal(results.filter((result) => result.ok).length, 1);
        const winner = results.find((result) => result.ok)!.entry!;
        const duplicate = await second.evaluate((body) => outbox.reserve(body), winner.body);
        assert.equal(duplicate.operationId, winner.operationId);
        await context.close();
        context = await chromium.launchPersistentContext(profile, {
          headless: true,
          viewport: { width: 1440, height: 900 },
        });
        page = await context.newPage();
        const authRestored = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/investigations/read-recovery") &&
            response.request().method() === "POST",
        );
        await page.goto(`${f.stack.config.app}/app/rooms/${s.scope.roomId}`);
        const authenticatedRead = await authRestored;
        assert.equal(authenticatedRead.status(), 200);
        assert.equal(authenticatedRead.request().postDataJSON().expectedUserId, s.requester.id);
        second = await context.newPage();
        await second.goto(f.stack.config.app + "/login");
        await installOutboxHarness(second);
        await expect(
          page.getByRole("button", { name: "같은 메시지 확인", exact: true }),
        ).toBeVisible();
        let sent = 0;
        page.on("request", (request) => {
          if (request.url().endsWith("/api/investigations/speak")) sent++;
        });
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert.equal(sent, 0);
        await page.getByRole("button", { name: "같은 메시지 확인", exact: true }).click();
        await expect(page.getByLabel("확정 공동 이력")).toContainText(
          winner.body.publicText as string,
        );
        assert.equal(sent, 1);
        await installOutboxHarness(page);
        const newer = await page.evaluate(
          (body) => outbox.reserve(body),
          make("새 operation 보존"),
        );
        assert.equal(
          await second.evaluate(
            ({ userId, roomId, operationId }) => outbox.remove(userId, roomId, operationId),
            { userId: s.requester.id, roomId: s.scope.roomId, operationId: winner.operationId },
          ),
          false,
        );
        assert.equal(
          (
            await second.evaluate(({ userId, roomId }) => outbox.read(userId, roomId), {
              userId: s.requester.id,
              roomId: s.scope.roomId,
            })
          ).entry?.operationId,
          newer.operationId,
        );
        const records = await read(s.requester, s.scope.roomId);
        assert.equal(
          records.events.filter((event) => event.publicText === winner.body.publicText).length,
          1,
        );
        await context.close();
      } finally {
        await context.close();
      }
    }),
);

test(
  "should keep UNKNOWN stop details unobtrusive and preserve execution evidence",
  { timeout: 300_000 },
  async () =>
    chatCase("unknown-compact-browser", async (f) => {
      const s = await f.directScene("unknown-compact");
      await scope(f, s);
      const admitted = await f.ask(s);
      const attempt = await f.run(s.responder, admitted.requestId!);
      await f.human(s.requester, "cancel", {
        roomId: s.scope.roomId,
        operationId: randomUUID(),
        requestId: admitted.requestId!,
        expectedRoomRevision: (await read(s.requester, s.scope.roomId)).roomRevision,
      });
      await f.expire("lease", attempt.attemptId);
      await read(s.requester, s.scope.roomId);
      const browser = await chromium.launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const { context, page } = await browserPage(
            browser,
            f,
            s.requester,
            s.scope.roomId,
            width,
          );
          const mutations: string[] = [];
          page.on("request", (request) => {
            if (/\/api\/investigations\/(cancel|retire)$/.test(request.url()))
              mutations.push(request.url());
          });
          const panel = page.getByRole("region", { name: "AI 답변 상태", exact: true });
          await expect(panel).toContainText("종료 확인 대기");
          assert.ok((await panel.boundingBox())!.height <= 44);
          const height = await page
            .getByLabel("대화 기록 스크롤", { exact: true })
            .evaluate((element) => element.clientHeight);
          const trigger = panel.getByRole("button", { name: "상세", exact: true });
          await trigger.click();
          const dialog = page.getByRole("dialog", { name: "AI 답변 상태 상세", exact: true });
          await expect(dialog).toContainText("성공이나 중단이 확인되지");
          await page.keyboard.press("Escape");
          await expect(trigger).toBeFocused();
          await expect(dialog).toHaveCount(0);
          await page.evaluate(() => window.dispatchEvent(new Event("online")));
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await expect(dialog).toHaveCount(0);
          assert.equal(
            await page
              .getByLabel("대화 기록 스크롤", { exact: true })
              .evaluate((element) => element.clientHeight),
            height,
          );
          assert.equal(mutations.length, 0);
          assert.ok(
            await page.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1),
          );
          const notice = page
            .getByLabel("확정 공동 이력")
            .getByRole("button", { name: "안내 상세", exact: true });
          if (await notice.count()) {
            await notice.first().click();
            await expect(
              page.getByRole("dialog", { name: "사람 확인 필요 상세", exact: true }),
            ).toBeVisible();
            await page.keyboard.press("Escape");
          }
          await context.close();
        }
        const evidence = await f.stack.db.query(
          "select r.state,a.state attempt_state,a.terminal_text from workflow_private.requests r join workflow_private.attempts a on a.request_id=r.id where r.id=$1 and r.room_id=$2",
          [admitted.requestId, s.scope.roomId],
        );
        assert.equal(evidence.rows[0].state, "UNKNOWN");
        assert.equal(evidence.rows[0].terminal_text, null);
      } finally {
        await browser.close();
      }
    }),
);

test(
  "should bound two thousand variable-height records and reenter after the cached cursor",
  { timeout: 300_000 },
  async () =>
    chatCase("history-2000-browser", async (f) => {
      const s = await f.directScene("history-2000");
      await scope(f, s);
      const admitted = await f.ask(s, randomUUID(), "가상화 원문 이동 합성 질문");
      const attempt = await f.run(s.responder, admitted.requestId!);
      await f.complete(s.responder, attempt, "COMPLETED", "가상화 원문 이동 합성 답변");
      await f.stack.db.query("begin");
      try {
        await f.stack.db.query("select workflow_private.lock_room($1)", [s.scope.roomId]);
        await f.stack.db.query(
          "select workflow_private.event($1,'SPEECH',null,null,left('fixture #'||i::text||E'\\n```ts\\nconst n = 1;\\n```\\n'||repeat('x',1024),1024),null,'NONE',$2) from generate_series(1,2000) i",
          [s.scope.roomId, s.requester.id],
        );
        await f.stack.db.query("commit");
      } catch (error) {
        await f.stack.db.query("rollback");
        throw error;
      }

      const browser = await chromium.launch({ headless: true });
      try {
        for (const width of [1440, 390]) {
          const start = Date.now();
          const { context, page } = await browserPage(
            browser,
            f,
            s.requester,
            s.scope.roomId,
            width,
            true,
          );
          const bodies: { afterSequence: number }[] = [];
          page.on("request", (request) => {
            if (request.url().endsWith("/api/investigations/read-recovery"))
              bodies.push(request.postDataJSON());
          });
          await expect(page.getByLabel("확정 공동 이력")).toContainText("fixture #2000", {
            timeout: 120_000,
          });
          const firstMs = Date.now() - start;
          assert.ok((await page.locator("article[id^='message-']").count()) <= 100);
          const input = page.getByRole("textbox", { name: "AI에게 보낼 질문", exact: true });
          await page.waitForTimeout(1000);
          const parses = await page.evaluate(
            () =>
              (globalThis as unknown as { __chatMarkdownRenderCounts: Record<string, number> })
                .__chatMarkdownRenderCounts,
          );
          assert.ok(Object.keys(parses).length > 0);
          await input.pressSequentially("twenty keystrokes!!! ", { delay: 20 });
          const afterTyping = await page.evaluate(
            () =>
              (globalThis as unknown as { __chatMarkdownRenderCounts: Record<string, number> })
                .__chatMarkdownRenderCounts,
          );
          for (const [messageId, count] of Object.entries(parses))
            assert.equal(afterTyping[messageId], count);
          assert.ok((await page.locator("article[id^='message-']").count()) <= 100);
          const records = await read(s.requester, s.scope.roomId);
          const question = records.events.find(
            (event) => event.publicText === "가상화 원문 이동 합성 질문",
          )!;
          await page.evaluate((id) => {
            location.hash = `message-${id}`;
          }, question.eventId);
          await expect(page.locator(`#message-${question.eventId}`)).toBeFocused();
          const top = await page
            .getByLabel("대화 기록 스크롤", { exact: true })
            .evaluate((element) => element.scrollTop);
          await speak(f, s, `읽는 위치 유지 ${randomUUID()}`);
          await expect(
            page.getByRole("button", { name: "새 메시지 · 아래로 이동", exact: true }),
          ).toBeVisible();
          assert.ok(
            Math.abs(
              (await page
                .getByLabel("대화 기록 스크롤", { exact: true })
                .evaluate((element) => element.scrollTop)) - top,
            ) < 10,
          );
          await page
            .locator(`#message-${question.eventId}`)
            .getByRole("button", { name: "저장소·자료", exact: true })
            .click();
          const sourceDialog = page.getByRole("dialog", { name: "당시 저장소·자료", exact: true });
          await expect(sourceDialog).toContainText("질문 예약 당시 사람:");
          const sourceText = await sourceDialog.textContent();
          await page.evaluate(() => {
            const el = document.querySelector('[aria-label="대화 기록 스크롤"]')!;
            el.scrollTop = el.scrollHeight;
            el.dispatchEvent(new Event("scroll"));
          });
          await expect(sourceDialog).toHaveText(sourceText!);
          await page.keyboard.press("Escape");
          await expect(page.getByLabel("대화 기록 스크롤", { exact: true })).toBeFocused();
          const after = Number(
            (
              await f.stack.db.query(
                "select sequence from workflow_private.rooms where room_id=$1",
                [s.scope.roomId],
              )
            ).rows[0].sequence,
          );
          const navigation = page.getByRole("button", { name: "채팅방 목록 열기", exact: true });
          if (await navigation.isVisible()) await navigation.click();
          await page
            .getByRole("link", { name: "AI 채팅방", exact: true })
            .filter({ visible: true })
            .click();
          await expect(page).toHaveURL(/\/app$/);
          await page.keyboard.press("Escape");
          const back = Date.now();
          bodies.length = 0;
          await expect(
            page.getByRole("dialog", { name: "AI 채팅방 목록", exact: true }),
          ).toHaveCount(0);
          await page
            .locator(`a[href="/app/rooms/${s.scope.roomId}"]`)
            .filter({ visible: true })
            .first()
            .click();
          await expect(page.getByLabel("확정 공동 이력")).toContainText("읽는 위치 유지", {
            timeout: 30_000,
          });
          await expect.poll(() => bodies.length).toBeGreaterThan(0);
          assert.equal(bodies[0].afterSequence, after);
          assert.equal(bodies.filter((body) => body.afterSequence === 0).length, 0);
          assert.ok(
            await page.locator("body").evaluate((element) => element.scrollWidth <= innerWidth + 1),
          );
          console.log(
            JSON.stringify({
              fixture: "2000 speeches, each 1024 bytes with code fence",
              width,
              firstDisplayMs: firstMs,
              cachedReentryMs: Date.now() - back,
              renderedMessages: await page.locator("article[id^='message-']").count(),
            }),
          );
          await context.close();
        }
      } finally {
        await browser.close();
      }
    }),
);

test(
  "should enforce real storage expiration quotas upgrade conflict and unavailable writes before sending",
  { timeout: 300_000 },
  async () =>
    chatCase("outbox-storage-risk", async (f) => {
      const s = await f.directScene("outbox-storage");
      await scope(f, s);
      const browser = await chromium.launch({ headless: true });
      try {
        const { context, page } = await browserPage(browser, f, s.requester, s.scope.roomId);
        await installOutboxHarness(page);
        const result = await page.evaluate(
          async ({ userId, roomId }) => {
            const body = (room: string, index: number): Body => ({
              protocol: 1,
              roomId: room,
              expectedUserId: userId,
              operationId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
              publicText: "저장 quota synthetic",
            });
            await outbox.clear();
            const original = body(roomId, 1);
            await outbox.reserve(original);
            const future = new Outbox(
              () => indexedDB,
              () => Date.now() + 8 * 24 * 60 * 60 * 1000,
            );
            const expired = await future.read(userId, roomId);
            for (let index = 1; index <= 50; index++)
              await outbox.reserve(
                body(`00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`, index),
              );
            let quota = false;
            try {
              await outbox.reserve(body(roomId, 51));
            } catch {
              quota = true;
            }
            await outbox.clear(userId);
            const faulty = new Outbox(() => {
              throw new Error("Synthetic IDB unavailable");
            });
            let storage = false;
            try {
              await faulty.reserve(original);
            } catch {
              storage = true;
            }
            const old = indexedDB.open("chat-speech-outbox", 1);
            const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
              old.onsuccess = () => resolve(old.result);
              old.onerror = () => reject(new Error("fixture DB open failed"));
            });
            let blocked = false;
            const upgraded = indexedDB.open("chat-speech-outbox", 2);
            await new Promise<void>((resolve) => {
              upgraded.onblocked = () => {
                blocked = true;
                blocker.close();
              };
              upgraded.onsuccess = () => {
                upgraded.result.close();
                resolve();
              };
            });
            let migration = false;
            try {
              await outbox.reserve(original);
            } catch {
              migration = true;
            }
            const deleted = indexedDB.deleteDatabase("chat-speech-outbox");
            await new Promise<void>((resolve, reject) => {
              deleted.onsuccess = () => resolve();
              deleted.onerror = () => reject(new Error("fixture DB removal failed"));
            });
            await outbox.reserve(original);
            localStorage.setItem("chat-outbox-cleanup-required", "1");
            const cleaned = await outbox.read(userId, roomId);
            return {
              expired: expired.expired,
              noExpiredEntry: expired.entry === null,
              quota,
              storage,
              migration,
              blocked,
              cleanupEmpty: cleaned.entry === null,
              markerRemoved: localStorage.getItem("chat-outbox-cleanup-required") === null,
            };
          },
          { userId: s.requester.id, roomId: s.scope.roomId },
        );
        assert.deepEqual(result, {
          expired: true,
          noExpiredEntry: true,
          quota: true,
          storage: true,
          migration: true,
          blocked: true,
          cleanupEmpty: true,
          markerRemoved: true,
        });
        await context.close();
      } finally {
        await browser.close();
      }
    }),
);

test(
  "should block INSERT Presence wrong sessions and suspended users and preserve writes when publishing fails",
  { timeout: 300_000 },
  async () =>
    chatCase("realtime-policy-risk", async (f) => {
      const s = await f.directScene("policy-risk");
      await scope(f, s);
      const grant = await authorize(s.requester, s.scope.roomId);
      const claims = JSON.parse(
        Buffer.from(grant.accessToken.split(".")[1], "base64url").toString("utf8"),
      );
      async function authenticated(check: () => Promise<void>, jwt = claims) {
        await f.stack.db.query("begin");
        try {
          await f.stack.db.query(
            "select set_config('request.jwt.claims',$1,true),set_config('realtime.topic',$2,true)",
            [JSON.stringify(jwt), grant.topic],
          );
          await f.stack.db.query("set local role authenticated");
          await check();
        } finally {
          await f.stack.db.query("rollback");
        }
      }
      await authenticated(async () => {
        assert.equal(
          (
            await f.stack.db.query("select chat_realtime_private.allowed($1) allowed", [
              grant.topic,
            ])
          ).rows[0].allowed,
          true,
        );
        for (const extension of ["broadcast", "presence"]) {
          await f.stack.db.query("savepoint insert_denied");
          let code = "";
          try {
            await f.stack.db.query(
              "insert into realtime.messages(topic,event,extension,payload,private) values($1,'fixture',$2,'{}',true)",
              [grant.topic, extension],
            );
          } catch (error) {
            code = (error as { code: string }).code;
          }
          await f.stack.db.query("rollback to savepoint insert_denied");
          assert.equal(code, "42501");
        }
      });
      await authenticated(
        async () => {
          assert.equal(
            (
              await f.stack.db.query("select chat_realtime_private.allowed($1) allowed", [
                grant.topic,
              ])
            ).rows[0].allowed,
            false,
          );
        },
        { ...claims, session_id: randomUUID() },
      );
      await f.stack.db.query(
        "update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",
        [s.requester.id],
      );
      try {
        await authenticated(async () => {
          assert.equal(
            (
              await f.stack.db.query("select chat_realtime_private.allowed($1) allowed", [
                grant.topic,
              ])
            ).rows[0].allowed,
            false,
          );
        });
      } finally {
        await f.stack.db.query("update auth.users set banned_until=null where id=$1", [
          s.requester.id,
        ]);
      }
      const triggerName = `owned_realtime_failure_${randomUUID().replaceAll("-", "")}`;
      await f.stack.db.query(
        "create function pg_temp.owned_realtime_failure() returns trigger language plpgsql security definer set search_path='' as $$ begin if exists(select 1 from chat_realtime_private.leases where topic=new.topic and room_id=tg_argv[0]::uuid) then raise exception using message='SYNTHETIC_REALTIME_FAILURE'; end if; return new; end $$",
      );
      const create = (
        await f.stack.db.query(
          "select format('create trigger %I before insert on realtime.messages for each row execute function pg_temp.owned_realtime_failure(%L)', $1::text, $2::text) command",
          [triggerName, s.scope.roomId],
        )
      ).rows[0].command;
      await f.stack.db.query(create);
      try {
        const text = `알림 장애 뒤 저장 ${randomUUID()}`;
        await speak(f, s, text);
        const page = await read(s.requester, s.scope.roomId);
        assert.ok(page.events.some((event) => event.publicText === text));
      } finally {
        const drop = (
          await f.stack.db.query(
            "select format('drop trigger %I on realtime.messages',$1::text) command",
            [triggerName],
          )
        ).rows[0].command;
        await f.stack.db.query(drop);
      }
    }),
);

test(
  "should coalesce transaction hints and exclude heartbeat-only readiness updates",
  { timeout: 300_000 },
  async () =>
    chatCase("realtime-publication-risk", async (f) => {
      const s = await f.directScene("publication-risk");
      await scope(f, s);
      const grant = await authorize(s.requester, s.scope.roomId);
      const count = async () =>
        Number(
          (
            await f.stack.db.query(
              "select count(*) count from realtime.messages where topic=$1 and event='changed'",
              [grant.topic],
            )
          ).rows[0].count,
        );
      let before = await count();
      await f.stack.db.query("begin");
      try {
        await f.stack.db.query("select workflow_private.lock_room($1)", [s.scope.roomId]);
        await f.stack.db.query(
          "select workflow_private.event($1,'SPEECH',null,null,'합성 transaction 발언',null,'NONE',$2) from generate_series(1,2)",
          [s.scope.roomId, s.requester.id],
        );
        assert.equal(await count(), before + 1);
        await f.stack.db.query("commit");
      } catch (error) {
        await f.stack.db.query("rollback");
        throw error;
      }
      before = await count();
      const heartbeat = await f.stack.db.query(
        "update workflow_private.readiness set valid_until=clock_timestamp()+interval '1 minute' where agent_id=$1 and room_id=$2 returning agent_id",
        [s.responder.agentId, s.scope.roomId],
      );
      assert.equal(heartbeat.rowCount, 1);
      assert.equal(await count(), before);
      await f.stack.db.query(
        "update workflow_private.readiness set reported_ready=not reported_ready where agent_id=$1 and room_id=$2",
        [s.responder.agentId, s.scope.roomId],
      );
      assert.equal(await count(), before + 1);
    }),
);

test(
  "should stop joined socket hints after lease expiry replacement and session deletion",
  { timeout: 300_000 },
  async () =>
    chatCase("realtime-joined-session-risk", async (f) => {
      const s = await f.directScene("joined-session-risk");
      await scope(f, s);
      const clients: SupabaseClient[] = [];
      async function join(grant: RealtimeGrant) {
        const client = createClient(grant.url, grant.key, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        clients.push(client);
        await client.realtime.setAuth(grant.accessToken);
        let hints = 0;
        const channel = client
          .channel(grant.topic, { config: { private: true, presence: { enabled: false } } })
          .on("broadcast", { event: "changed" }, (message) => {
            assert.equal(message.payload.version, 1);
            assert.deepEqual(
              Object.keys(message.payload).filter((key) => key !== "id"),
              ["version"],
            );
            if (message.payload.id !== undefined)
              assert.match(
                message.payload.id,
                /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
              );
            hints++;
          });
        await new Promise<void>((resolve, reject) => {
          channel.subscribe((status) => {
            if (status === "SUBSCRIBED") resolve();
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
              reject(new Error("Owned joined socket authorization failed"));
          });
        });
        return { channel, hints: () => hints };
      }
      async function commit(text: string) {
        const response = await f.human(s.owner, "speak", {
          roomId: s.scope.roomId,
          expectedUserId: s.owner.id,
          operationId: randomUUID(),
          publicText: text,
        });
        assert.equal(response.status, 200);
      }
      try {
        const first = await authorize(s.requester, s.scope.roomId);
        const old = await join(first);
        await commit("합성 lease 만료 전");
        await expect.poll(old.hints, { timeout: 5000 }).toBe(1);
        const expired = await f.stack.db.query(
          "update chat_realtime_private.leases set expires_at=clock_timestamp()-interval '1 second' where id=$1 and user_id=$2 returning id",
          [first.leaseId, s.requester.id],
        );
        assert.equal(expired.rowCount, 1);
        assert.equal(old.channel.state, "joined");
        await commit("합성 만료 lease 행 유지 중");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(old.hints(), 1);
        const retained = await f.stack.db.query(
          "select expires_at<=clock_timestamp() expired from chat_realtime_private.leases where id=$1 and user_id=$2",
          [first.leaseId, s.requester.id],
        );
        assert.equal(retained.rowCount, 1);
        assert.equal(retained.rows[0].expired, true);
        const replacement = await authorize(s.requester, s.scope.roomId, first.clientId);
        assert.notEqual(replacement.topic, first.topic);
        const current = await join(replacement);
        await commit("합성 topic 교체 뒤");
        await expect.poll(current.hints, { timeout: 5000 }).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(old.hints(), 1);
        const claims = JSON.parse(
          Buffer.from(replacement.accessToken.split(".")[1], "base64url").toString("utf8"),
        );
        const deleted = await f.stack.db.query(
          "delete from auth.sessions where id=$1 and user_id=$2 returning id",
          [claims.session_id, s.requester.id],
        );
        assert.equal(deleted.rowCount, 1);
        await commit("합성 session 삭제 뒤");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(current.hints(), 1);
        assert.equal(old.hints(), 1);
        const page = await read(s.owner, s.scope.roomId);
        assert.ok(page.events.some((event) => event.publicText === "합성 session 삭제 뒤"));
      } finally {
        for (const client of clients) {
          await client.removeAllChannels();
          client.realtime.disconnect();
        }
      }
    }),
);
