import sharp from "sharp";
import { createHash } from "node:crypto";
import { WorkflowError } from "../investigation-coordinator/contracts.ts";
import {
  IMAGE_MIMES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  type ImageMime,
} from "./contracts.ts";

export async function readImageBytes(request: Pick<Request, "headers" | "body">): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES)) {
    await request.body?.cancel();
    throw new WorkflowError("BODY_TOO_LARGE");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new WorkflowError("INVALID_BODY");
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new WorkflowError("BODY_TOO_LARGE");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new WorkflowError("INVALID_BODY");
  return Buffer.concat(parts, size);
}

export async function canonicalImage(bytes: Buffer, declaredMime: string) {
  if (
    !IMAGE_MIMES.includes(declaredMime as ImageMime) ||
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES
  )
    throw new WorkflowError("INVALID_BODY");
  const signatureMime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes.length >= 12 &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;
  if (signatureMime !== declaredMime) throw new WorkflowError("INVALID_BODY");
  try {
    // libvips may decode only the default frame of APNG. Reject its animation
    // control chunk explicitly instead of treating that decode as a static PNG.
    if (declaredMime === "image/png") {
      for (let offset = 8; offset + 12 <= bytes.length;) {
        const length = bytes.readUInt32BE(offset);
        if (length > bytes.length - offset - 12) throw new WorkflowError("INVALID_BODY");
        if (bytes.toString("ascii", offset + 4, offset + 8) === "acTL")
          throw new WorkflowError("INVALID_BODY");
        offset += length + 12;
      }
    }
    const image = sharp(bytes, {
      animated: true,
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "warning",
    });
    const meta = await image.metadata();
    const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[
      meta.format as string
    ];
    if (
      mime !== declaredMime ||
      (meta.pages ?? 1) !== 1 ||
      !meta.width ||
      !meta.height ||
      meta.width > MAX_IMAGE_EDGE ||
      meta.height > MAX_IMAGE_EDGE ||
      meta.width * meta.height > MAX_IMAGE_PIXELS
    )
      throw new WorkflowError("INVALID_BODY");
    // The default encoder drops EXIF, XMP and the original filename. Decode all pixels.
    const normalized = image.rotate().toColourspace("srgb");
    const encoded = await (
      mime === "image/png"
        ? normalized.png()
        : mime === "image/jpeg"
          ? normalized.jpeg({ quality: 85 })
          : normalized.webp({ quality: 85 })
    ).toBuffer({ resolveWithObject: true });
    if (encoded.data.length > MAX_IMAGE_BYTES) throw new WorkflowError("BODY_TOO_LARGE");
    return {
      data: encoded.data,
      mime: mime as ImageMime,
      bytes: encoded.data.length,
      width: encoded.info.width,
      height: encoded.info.height,
      sha256: createHash("sha256").update(encoded.data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("INVALID_BODY");
  }
}
