import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { type FixturePerson } from "../helpers/local-access-stack.js";
import { projectHistoryWindow } from "../../src/features/investigation-coordinator/history-window-contracts.js";

test(
  "should preserve the reading anchor when the final older page removes the loader",
  { timeout: 120_000 },
  async () => {
    await workflowCase("history-final", async (f) => {
      const owner = await f.stack.person("final-owner");
      const scope = await f.stack.bootstrap(owner);
      f.rooms.set(scope.roomId, scope.organizationId);
      await f.save();
      assert.equal(
        (await f.human(owner, "read", { roomId: scope.roomId, afterSequence: 0 })).status,
        200,
      );
      await f.stack.db.query(
        "select workflow_private.event($1,'SPEECH',null,null,'마지막 페이지 #'||i::text,null,'NONE',$2) from generate_series(1,65) i",
        [scope.roomId, owner.id],
      );
      const browser = await chromium.launch({ headless: true });
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await context.addCookies(
          f.stack
            .entryForBrowser(owner)
            .cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
        );
        const page = await context.newPage();
        await page.goto(`${f.stack.config.app}/app/rooms/${scope.roomId}`);
        await expect(page.getByLabel("확정 공동 이력")).toContainText("마지막 페이지 #65");
        const scroll = page.getByLabel("대화 기록 스크롤", { exact: true });
        await scroll.evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.waitForTimeout(300);
        const first = page.locator("article[id^='message-']").first();
        const id = await first.getAttribute("id"),
          before = (await first.boundingBox())!.y;
        await page.getByRole("button", { name: "이전 대화 보기", exact: true }).click();
        await expect(page.getByRole("button", { name: "이전 대화 불러오는 중…" })).toHaveCount(0);
        await page.waitForTimeout(300);
        const delta = (await page.locator(`#${id}`).boundingBox())!.y - before;
        assert.ok(Math.abs(delta) < 12, `final page anchor delta ${delta}`);
      } catch (error) {
        if (error instanceof assert.AssertionError) console.error(error.message);
        throw error;
      } finally {
        await browser.close();
      }
    });
  },
);

test(
  "should page ten thousand events with scoped access and stable browser history",
  { timeout: 300_000 },
  async () => {
    await workflowCase("recent-window", async (f) => {
      try {
        const owner = await f.stack.person("window-owner");
        const requester = await f.stack.person("window-requester");
        const observer = await f.stack.person("window-observer");
        const outsider = await f.stack.person("window-outsider");
        const scope = await f.stack.bootstrap(owner);
        f.rooms.set(scope.roomId, scope.organizationId);
        await f.save();
        await f.stack.join(requester, await f.stack.invite(owner, scope.roomId), "질문 참가자");
        await f.stack.join(
          observer,
          await f.stack.invite(owner, scope.roomId, "observer"),
          "관찰자",
        );
        const s = { owner, requester, observer, outsider, scope };
        const roomId = s.scope.roomId;
        const request = (person: FixturePerson, beforeSequence: number | null = null, extra = {}) =>
          person.web.post("/api/chat-history", {
            protocol: 1,
            expectedUserId: person.id,
            roomId,
            beforeSequence,
            ...extra,
          });
        const read = async (person: FixturePerson, beforeSequence: number | null = null) => {
          const response = await request(person, beforeSequence);
          assert.equal(response.status, 200);
          assert.match(response.headers.get("cache-control") ?? "", /no-store/);
          const text = await response.text();
          assert.ok(Buffer.byteLength(text) <= 262144);
          return projectHistoryWindow(JSON.parse(text).data);
        };
        const empty = await read(s.requester);
        assert.equal(empty.events.length, 0);
        await f.stack.db.query("begin");
        try {
          await f.stack.db.query("select workflow_private.lock_room($1)", [roomId]);
          await f.stack.db.query(
            "select workflow_private.event($1,'SPEECH',null,null,'최근 기록 #'||i::text||E'\\n**강조**\\n'||repeat('내용 ',i%5),null,'NONE',$2) from generate_series(1,10000) i",
            [roomId, s.requester.id],
          );
          await f.stack.db.query("commit");
        } catch (error) {
          await f.stack.db.query("rollback");
          throw error;
        }
        const recent = await read(s.requester);
        assert.equal(recent.events.length, 40);
        assert.equal(recent.oldestSequence, 9961);
        assert.equal(recent.snapshot.nextCursor, 10000);
        assert.equal((await read(s.observer)).oldestSequence, 9961);
        const older = await read(s.requester, recent.oldestSequence);
        assert.equal(older.oldestSequence, 9921);
        assert.equal(older.events.at(-1)?.sequence, 9960);
        assert.equal((await read(s.requester, 2)).hasOlder, false);
        assert.equal((await read(s.requester, 1)).events.length, 0);
        assert.equal((await request(s.outsider)).status, 403);
        assert.equal(
          (await request(s.requester, null, { expectedUserId: s.owner.id })).status,
          403,
        );
        assert.equal((await request(s.requester, 10002)).status, 409);
        assert.equal((await request(s.requester, 0)).status, 400);
        const legacy = await f.human(s.requester, "read-recovery", {
          roomId,
          afterSequence: 0,
          afterRetirementSequence: 0,
        });
        assert.equal(legacy.status, 200);
        assert.equal((legacy.data.data as { events: unknown[] }).events.length, 16);
        const browser = await chromium.launch({ headless: true });
        try {
          for (const width of [1440, 390]) {
            const context = await browser.newContext({ viewport: { width, height: 900 } });
            await context.addCookies(
              f.stack
                .entryForBrowser(s.requester)
                .cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
            );
            const page = await context.newPage();
            const windows: (number | null)[] = [];
            page.on("request", (req) => {
              if (req.url().endsWith("/api/chat-history"))
                windows.push(req.postDataJSON().beforeSequence);
            });
            await page.goto(`${f.stack.config.app}/app/rooms/${roomId}`);
            const scroll = page.getByLabel("대화 기록 스크롤", { exact: true });
            await expect(page.getByLabel("확정 공동 이력")).toContainText("최근 기록 #10000", {
              timeout: 30_000,
            });
            await page.waitForTimeout(600);
            assert.deepEqual(windows, [null]);
            await scroll.evaluate((el) => {
              el.scrollTop = 0;
            });
            await page.waitForTimeout(300);
            assert.deepEqual(windows, [null]);
            const first = page.locator("article[id^='message-']").first();
            const anchorId = await first.getAttribute("id");
            const before = (await first.boundingBox())!.y;
            await scroll.hover();
            await page.mouse.wheel(0, -80);
            await expect.poll(() => windows.length).toBe(2);
            await expect(page.getByRole("button", { name: "이전 대화 불러오는 중…" })).toHaveCount(
              0,
            );
            await page.waitForTimeout(300);
            const after = (await page.locator(`#${anchorId}`).boundingBox())!.y;
            assert.ok(
              Math.abs(after - before) < 12,
              `prepend shifted anchor by ${after - before}px at ${width}`,
            );
            assert.equal(windows[1], width === 1440 ? 9961 : 9962);
            // Exercise a late image-size change above the reader through the real ResizeObserver.
            await page.locator(`#${anchorId}`).evaluate((anchor) => {
              const previous = anchor.closest("li")?.previousElementSibling;
              if (!previous) throw new Error("Expected preceding virtual row");
              const image = document.createElement("img");
              image.alt = "합성 지연 이미지";
              image.width = 240;
              image.height = 120;
              image.src =
                "data:image/svg+xml," +
                encodeURIComponent(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="teal"/></svg>',
                );
              previous.querySelector("article")!.append(image);
            });
            await page.waitForTimeout(300);
            assert.ok(
              Math.abs((await page.locator(`#${anchorId}`).boundingBox())!.y - after) < 12,
              "Late media must preserve the reading anchor",
            );
            await f.human(s.requester, "speak", {
              roomId,
              operationId: crypto.randomUUID(),
              publicText: `동시 새 메시지 ${width}`,
            });
            await expect(
              page.getByRole("button", { name: "새 메시지 · 아래로 이동", exact: true }),
            ).toBeVisible({ timeout: 20_000 });
            assert.ok(Math.abs((await page.locator(`#${anchorId}`).boundingBox())!.y - after) < 12);
            await page.reload();
            await expect(page.getByLabel("확정 공동 이력")).toContainText(
              `동시 새 메시지 ${width}`,
            );
            assert.equal(windows.at(-1), null);
            await page.evaluate(() => {
              location.hash = "message-00000000-0000-4000-8000-000000000001";
            });
            await expect(
              page.getByRole("status").filter({ hasText: "이 메시지는 이전 대화에 있습니다" }),
            ).toBeVisible();
            await context.close();
          }
        } finally {
          await browser.close();
        }
        const afterInsert = await read(s.requester, recent.oldestSequence);
        assert.deepEqual(
          afterInsert.events.map((event) => event.eventId),
          older.events.map((event) => event.eventId),
        );
        assert.equal(afterInsert.snapshot.highWaterSequence, 10002);
        await s.owner.web.mutate("revoke-room-member", { roomId, userId: s.observer.id });
        assert.equal((await request(s.observer)).status, 403);
        await f.stack.db.query(
          "select workflow_private.event($1,'SPEECH',null,null,repeat('한',2700),null,'NONE',$2) from generate_series(1,40)",
          [roomId, s.requester.id],
        );
        const large = await read(s.requester);
        assert.ok(large.events.length > 0 && large.events.length < 40);
        assert.equal(large.events.at(-1)?.sequence, 10042);
        const raw = s.requester.web.dataClient();
        assert.equal(
          (
            await raw.rpc("workflow_human_history_window", {
              p_body: { protocol: 1, expectedUserId: s.owner.id, roomId, beforeSequence: null },
            })
          ).error?.message,
          "FORBIDDEN",
        );
        await f.stack.disable(s.requester);
        assert.ok([401, 403].includes((await request(s.requester)).status));
        assert.ok(
          (
            await raw.rpc("workflow_human_history_window", {
              p_body: { protocol: 1, expectedUserId: s.requester.id, roomId, beforeSequence: null },
            })
          ).error,
        );
      } catch (error) {
        if (error instanceof Error)
          console.error({
            name: error.name,
            frames: error.stack?.match(/chat-history-window\.test\.js:\d+:\d+/g),
            message: error.name === "AssertionError" ? error.message : undefined,
          });
        throw error;
      }
    });
  },
);
