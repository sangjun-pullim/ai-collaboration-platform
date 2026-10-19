import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { chromium } from "@playwright/test";
import { installOutboxHarness } from "../helpers/chat-outbox-browser.js";
import { productEnvironment } from "../helpers/local-access-stack.js";
import type { SpeechOutbox } from "../../src/features/investigation-coordinator/chat-outbox.js";
import { MAX_IMAGE_BYTES } from "../../src/features/chat-attachments/contracts.js";

test(
  "should prepare actual browser pixels and persist exact image descriptors in real IndexedDB",
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({
      headless: true,
      env: Object.fromEntries(
        Object.entries(productEnvironment()).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });
    try {
      const page = await browser.newPage();
      await page.route("http://127.0.0.1/attachment-harness", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Isolated attachment harness</title>",
        }),
      );
      await page.goto("http://127.0.0.1/attachment-harness");
      await installOutboxHarness(page);
      const code = ts.transpileModule(
        readFileSync("src/features/chat-attachments/prepare.ts", "utf8"),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
      ).outputText;
      await page.evaluate(
        ({ code, limit }) => {
          const exports: Record<string, unknown> = {};
          new Function("exports", "require", code)(exports, () => ({ MAX_IMAGE_BYTES: limit }));
          Object.assign(globalThis, { prepareAttachment: exports.prepareImage });
        },
        { code, limit: MAX_IMAGE_BYTES },
      );
      const prepared = await page.evaluate(async () => {
        const prepare = (
          globalThis as unknown as { prepareAttachment: (file: File) => Promise<Blob> }
        ).prepareAttachment;
        const canvas = document.createElement("canvas");
        canvas.width = 2700;
        canvas.height = 1350;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#a04030";
        context.fillRect(0, 0, 2700, 1350);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((value) => resolve(value!), "image/png"),
        );
        const image = await prepare(
          new File([blob], "private-original-name.png", { type: "image/png" }),
        );
        const bitmap = await createImageBitmap(image);
        const dimensions = {
          width: bitmap.width,
          height: bitmap.height,
          bytes: image.size,
          mime: image.type,
        };
        bitmap.close();
        let rejected = false;
        try {
          await prepare(new File(["<svg/>"], "image.png", { type: "image/png" }));
        } catch {
          rejected = true;
        }
        return { ...dimensions, rejected };
      });
      assert.equal(prepared.width, 2048);
      assert.equal(prepared.height, 1024);
      assert.ok(prepared.bytes <= MAX_IMAGE_BYTES);
      assert.equal(prepared.mime, "image/webp");
      assert.equal(prepared.rejected, true);
      const body = {
        protocol: 1,
        roomId: randomUUID(),
        expectedUserId: randomUUID(),
        operationId: randomUUID(),
        attachmentId: randomUUID(),
        publicText: "이미지를 첨부했습니다",
      };
      const image = {
        attachmentId: body.attachmentId,
        mime: "image/png" as const,
        bytes: 100,
        width: 10,
        height: 10,
        sha256: "a".repeat(64),
      };
      const result = await page.evaluate(
        async ({ body, image }) => {
          const outbox = (globalThis as unknown as { outbox: SpeechOutbox }).outbox;
          const first = await outbox.reserve(body, image);
          const again = await outbox.reserve(body, image);
          let conflict = false;
          try {
            await outbox.reserve(
              { ...body, attachmentId: crypto.randomUUID() },
              { ...image, attachmentId: crypto.randomUUID() },
            );
          } catch {
            conflict = true;
          }
          const stored = await outbox.read(body.expectedUserId, body.roomId);
          return {
            first: first.operationId,
            again: again.operationId,
            descriptor: stored.entry?.attachment,
            conflict,
          };
        },
        { body, image },
      );
      assert.equal(result.first, body.operationId);
      assert.equal(result.again, body.operationId);
      assert.deepEqual(result.descriptor, image);
      assert.equal(result.conflict, true);
      await page.reload();
      await installOutboxHarness(page);
      const restored = await page.evaluate(
        async (body) =>
          (globalThis as unknown as { outbox: SpeechOutbox }).outbox.read(
            body.expectedUserId,
            body.roomId,
          ),
        body,
      );
      assert.deepEqual(restored.entry?.attachment, image);
      assert.equal(restored.entry?.body.attachmentId, image.attachmentId);
    } finally {
      await browser.close();
    }
  },
);
