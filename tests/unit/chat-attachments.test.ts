import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { imageOnlyText } from "../../src/features/chat-attachments/client.ts";
import { cachedImage, clearImageCache } from "../../src/features/chat-attachments/image-cache.ts";
import {
  validateBody,
  validImageDescriptor,
  projectResponse,
} from "../../src/features/investigation-coordinator/contracts.ts";
import { canonicalImage, readImageBytes } from "../../src/features/chat-attachments/validation.ts";
import {
  descriptor,
  deviceDownloadBody,
  MAX_IMAGE_BYTES,
  objectKey,
  readBody,
  userScope,
} from "../../src/features/chat-attachments/contracts.ts";

const scope = () => ({ protocol: 1, roomId: randomUUID(), expectedUserId: randomUUID() });
test("should reuse bounded room image downloads and discard them when access ends", async () => {
  const owner = { ...scope(), protocol: 1 as const };
  const image = {
    attachmentId: randomUUID(),
    mime: "image/png" as const,
    bytes: 1,
    width: 1,
    height: 1,
    sha256: "a".repeat(64),
  };
  let calls = 0;
  const signals: AbortSignal[] = [];
  const load = async (_scope: unknown, _image: unknown, signal: AbortSignal) => {
    calls++;
    signals.push(signal);
    return new Blob(["x"], { type: "image/png" });
  };
  await Promise.all([cachedImage(owner, image, load), cachedImage(owner, image, load)]);
  assert.equal(calls, 1);
  for (let i = 0; i < 16; i++)
    await cachedImage(owner, { ...image, attachmentId: randomUUID() }, load);
  assert.equal(signals[0].aborted, true);
  clearImageCache(owner);
  assert.ok(signals.every((signal) => signal.aborted));
  await cachedImage(owner, image, load);
  assert.equal(calls, 18);
  clearImageCache(owner);
});
test("should fix image-only captions before exact operation validation without allowing empty server text", () => {
  const body = {
    ...scope(),
    operationId: randomUUID(),
    attachmentId: randomUUID(),
    publicText: imageOnlyText("speak", "  "),
  };
  assert.equal(validateBody("speak", body).publicText, "이미지를 첨부했습니다");
  assert.equal(imageOnlyText("ask", "\n"), "첨부 이미지를 설명해주세요");
  assert.equal(imageOnlyText("ask", " 원래 질문 "), "원래 질문");
  assert.throws(() => validateBody("speak", { ...body, publicText: "" }));
  assert.throws(() => validateBody("start", { ...body, attachmentId: randomUUID() }));
});
test("should validate the six immutable descriptor fields and distinct attachment preinput receipt", () => {
  const image = {
    attachmentId: randomUUID(),
    mime: "image/png",
    bytes: 524288,
    width: 2048,
    height: 2048,
    sha256: "a".repeat(64),
  };
  assert.equal(validImageDescriptor(image), true);
  for (const patch of [
    { bytes: 524289 },
    { width: 2049 },
    { url: "https://example.com" },
    { sha256: "z".repeat(64) },
  ])
    assert.equal(validImageDescriptor({ ...image, ...patch }), false);
  const receipt = {
    requestId: randomUUID(),
    attemptId: randomUUID(),
    fence: 1,
    bindingEpoch: 1,
    state: "FAILED",
    kind: "ATTACHMENT_PREINPUT_REJECTED",
    proofHash: "a".repeat(64),
    adoption: "HUMAN_INPUT_REQUIRED",
  };
  assert.equal(projectResponse("fail-image-before-input", receipt), receipt);
  assert.throws(() => projectResponse("fail-before-input", receipt));
});
test("should reject paths and extra authority fields in attachment contracts", () => {
  assert.match(objectKey(randomUUID()), /^[a-f0-9-]{36}\/image$/);
  for (const value of [
    "../image",
    "https://example.com/image",
    `${randomUUID()}/other`,
    "chat-images/image",
  ])
    assert.throws(() => objectKey(value));
  assert.throws(() => userScope({ ...scope(), bucket: "public" }));
  assert.throws(() => readBody({ ...scope(), eventIds: Array.from({ length: 33 }, randomUUID) }));
  const id = randomUUID();
  assert.throws(() => readBody({ ...scope(), eventIds: [id, id] }));
  const body = {
    protocol: 1,
    attachmentId: randomUUID(),
    agentId: randomUUID(),
    requestId: randomUUID(),
    attemptId: randomUUID(),
    bindingEpoch: 1,
    fence: 1,
    imageInputVersion: 1,
  };
  assert.equal(deviceDownloadBody(body).fence, 1);
  for (const patch of [
    { fence: 0 },
    { bindingEpoch: 1.5 },
    { imageInputVersion: 0 },
    { path: "other" },
  ])
    assert.throws(() => deviceDownloadBody({ ...body, ...patch }));
});
test("should bound streamed images without relying on content length and cancel oversized streams", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
      controller.enqueue(new Uint8Array(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readImageBytes({ headers: new Headers(), body }), {
    message: "BODY_TOO_LARGE",
  });
  assert.equal(cancelled, true);
  await assert.rejects(
    readImageBytes(
      new Request("https://example.test", {
        method: "POST",
        body: "",
        headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
      }),
    ),
    { message: "BODY_TOO_LARGE" },
  );
});
test("should decode reencode and hash only canonical pixels while stripping metadata", async () => {
  for (const [format, mime] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const) {
    const source = await sharp({
      create: { width: 13, height: 17, channels: 3, background: "red" },
    })
      .withMetadata({ exif: { IFD0: { Artist: "PRIVATE ORIGINAL ARTIST" } } })
      .toFormat(format)
      .toBuffer();
    const image = await canonicalImage(source, mime);
    assert.equal(image.width, 13);
    assert.equal(image.height, 17);
    assert.equal(image.bytes, image.data.length);
    assert.equal(image.sha256, createHash("sha256").update(image.data).digest("hex"));
    const meta = await sharp(image.data).metadata();
    assert.equal(meta.exif, undefined);
    assert.equal(meta.xmp, undefined);
    assert.equal(image.data.includes(Buffer.from("PRIVATE ORIGINAL ARTIST")), false);
    assert.equal(descriptor({ attachmentId: randomUUID(), ...image }).mime, mime);
  }
});
test("should reject false MIME malformed images pixel bombs and animated formats", async () => {
  const source = await sharp({ create: { width: 2, height: 2, channels: 4, background: "blue" } })
    .png()
    .toBuffer();
  for (const [bytes, mime] of [
    [source, "image/jpeg"],
    [Buffer.from("<svg />"), "image/svg+xml"],
    [source.subarray(0, 35), "image/png"],
  ] as const)
    await assert.rejects(canonicalImage(bytes, mime));
  const large = await sharp({
    create: { width: 2049, height: 2049, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  await assert.rejects(canonicalImage(large, "image/png"));
  const animated = await sharp(Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), {
    raw: { width: 1, height: 2, pageHeight: 1, channels: 4 },
  })
    .webp({ loop: 0, delay: [100, 100] })
    .toBuffer();
  assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2);
  await assert.rejects(canonicalImage(animated, "image/webp"));
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8);
  chunk.write("acTL", 4);
  await assert.rejects(
    canonicalImage(
      Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)]),
      "image/png",
    ),
  );
});
