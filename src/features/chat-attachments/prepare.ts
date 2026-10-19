import { MAX_IMAGE_BYTES } from "./contracts.ts";

export async function prepareImage(file: File): Promise<Blob> {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size < 1 ||
    file.size > 20 * 1024 * 1024
  )
    throw new Error("20MiB 이하의 정적 PNG, JPEG, WebP 파일을 선택하세요.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  const png =
    bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  if (!(
    (file.type === "image/png" && png) ||
    (file.type === "image/jpeg" && jpeg) ||
    (file.type === "image/webp" && webp)
  ))
    throw new Error("파일 내용이 이미지 형식과 일치하지 않습니다.");
  const view = new DataView(bytes.buffer);
  for (let offset = png ? 8 : webp ? 12 : bytes.length; offset + 8 <= bytes.length;) {
    const length = view.getUint32(offset + (webp ? 4 : 0), webp);
    const name = ascii(offset + (webp ? 0 : 4), 4);
    if (name === "acTL" || name === "ANIM" || name === "ANMF")
      throw new Error("애니메이션 이미지는 첨부할 수 없습니다.");
    offset += length + (webp ? 8 + (length % 2) : 12);
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  try {
    let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("이 브라우저에서는 이미지를 준비할 수 없습니다.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", Math.max(0.4, 0.85 - attempt * 0.1)),
      );
      if (blob && blob.size <= MAX_IMAGE_BYTES) return blob;
      scale *= 0.75;
    }
    throw new Error("이미지를 512KiB 이하로 줄이지 못했습니다. 더 작은 이미지를 선택하세요.");
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
