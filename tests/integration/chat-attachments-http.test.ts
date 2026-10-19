import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { chromium } from "@playwright/test";
import { workflowCase } from "../helpers/workflow-fixture.js";
import { objectKey } from "../../src/features/chat-attachments/contracts.ts";

test(
  "should upload display enlarge and authorize real private Storage images in the room",
  {
    timeout: 180_000,
    skip: !process.env.LOCAL_ACCESS_DB_URL && "requires the owned local stack and built app",
  },
  async (t) =>
    workflowCase("image-http", async (f) => {
      const scene = await f.directScene("image-http");
      const browser = await chromium.launch({ headless: true });
      let stage = "open-room";
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.addCookies(
          f.stack
            .entryForBrowser(scene.requester)
            .cookies.map((cookie) => ({ ...cookie, sameSite: "Lax" as const })),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        await page.goto(`${f.stack.config.app}/app/rooms/${scene.scope.roomId}`);
        stage = "select-speech";
        await page.getByLabel("보낼 곳", { exact: true }).selectOption("speak");
        stage = "upload";
        const bytes = await sharp({
          create: { width: 640, height: 360, channels: 3, background: "#0f766e" },
        })
          .png()
          .toBuffer();
        await page
          .getByLabel("이미지 파일 선택", { exact: true })
          .setInputFiles({ name: "synthetic.png", mimeType: "image/png", buffer: bytes });
        stage = "send";
        await page.getByRole("button", { name: "공동 발언 저장", exact: true }).click();
        stage = "preview";
        const preview = page.getByRole("button", { name: "첨부 이미지 확대", exact: true });
        await preview.waitFor();
        await preview.click();
        await page.getByRole("dialog").waitFor();
        assert.equal(
          await page
            .getByAltText("첨부 이미지 확대 보기")
            .evaluate((element) => (element as HTMLImageElement).naturalWidth),
          640,
        );
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            true,
          );
          if (process.env.IMAGE_VISUAL_DIRECTORY)
            await page.screenshot({
              path: `${process.env.IMAGE_VISUAL_DIRECTORY}/chat-image-${width}.png`,
            });
          await preview.click();
          const dialog = page.getByRole("dialog");
          await dialog.waitFor();
          await dialog.evaluate(async (element) => {
            await Promise.all(element.getAnimations().map((animation) => animation.finished));
          });
          const bounds = await dialog.boundingBox();
          assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
          if (process.env.IMAGE_VISUAL_DIRECTORY)
            await page.screenshot({
              path: `${process.env.IMAGE_VISUAL_DIRECTORY}/chat-image-expanded-${width}.png`,
            });
          await page.keyboard.press("Escape");
          await dialog.waitFor({ state: "hidden" });
        }
        const rows = await f.stack.db.query(
          "select id from chat_attachments_private.images where room_id=$1",
          [scene.scope.roomId],
        );
        assert.equal(rows.rowCount, 1);
        const id = rows.rows[0].id;
        const path = `/api/chat-attachments/content/${id}?roomId=${scene.scope.roomId}&expectedUserId=${scene.outsider.id}`;
        const denied = await scene.outsider.web.request(path);
        assert.equal(denied.status, 403);
        const direct = await scene.requester.web
          .dataClient()
          .storage.from("chat-images")
          .download(objectKey(id));
        assert.ok(direct.error);
        await context.close();
      } catch (error) {
        t.diagnostic(`Image HTTP verification stage: ${stage}`);
        for (const context of browser.contexts())
          for (const page of context.pages()) {
            t.diagnostic(`Page pathname: ${new URL(page.url()).pathname}`);
            if (process.env.IMAGE_VISUAL_DIRECTORY)
              await page.screenshot({
                path: `${process.env.IMAGE_VISUAL_DIRECTORY}/image-http-failure.png`,
              });
          }
        throw error;
      } finally {
        await browser.close();
        const rows = await f.stack.db.query(
          "select id from chat_attachments_private.images where room_id=$1",
          [scene.scope.roomId],
        );
        for (const row of rows.rows) {
          const response = await fetch(`${f.stack.config.api}/storage/v1/object/chat-images`, {
            method: "DELETE",
            headers: {
              apikey: f.stack.config.adminKey,
              Authorization: `Bearer ${f.stack.config.adminKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ prefixes: [objectKey(row.id)] }),
          });
          assert.equal(response.ok, true, "Owned synthetic Storage object cleanup must succeed");
          await response.body?.cancel();
        }
        await f.stack.db.query(
          "delete from chat_attachments_private.publications where room_id=$1",
          [scene.scope.roomId],
        );
        await f.stack.db.query(
          "delete from chat_attachments_private.download_leases where attachment_id in (select id from chat_attachments_private.images where room_id=$1)",
          [scene.scope.roomId],
        );
        await f.stack.db.query(
          "with removed as (delete from chat_attachments_private.images where room_id=$1 returning bytes,state) update chat_attachments_private.budget set charged_bytes=charged_bytes-coalesce((select sum(bytes) from removed where state<>'DELETED'),0) where id=1",
          [scene.scope.roomId],
        );
      }
    }),
);
