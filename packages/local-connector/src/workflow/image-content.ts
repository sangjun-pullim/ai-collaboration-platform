import { digest, stableJson, RuntimeError } from "../runtime-contracts.ts";
import { validImageDescriptor, type ImageDescriptor } from "../workflow-contracts.ts";

export interface ImageInputProof {
  version: 1;
  contentHash: string;
  descriptor: ImageDescriptor;
}
export interface PreparedImage {
  descriptor: ImageDescriptor;
  bytes: Buffer;
  path?: string;
}
export function validImageInputProof(value: unknown): value is ImageInputProof {
  const v = value as ImageInputProof | null;
  return (
    !!v &&
    Object.keys(v).length === 3 &&
    v.version === 1 &&
    typeof v.contentHash === "string" &&
    /^[a-f0-9]{64}$/.test(v.contentHash) &&
    validImageDescriptor(v.descriptor)
  );
}
export function checkImage(image: PreparedImage, expected: ImageDescriptor): void {
  if (
    !validImageDescriptor(expected) ||
    !image ||
    !Buffer.isBuffer(image.bytes) ||
    stableJson(image.descriptor) !== stableJson(expected) ||
    image.bytes.length !== expected.bytes ||
    digest(image.bytes) !== expected.sha256
  )
    throw new RuntimeError("INVALID_RUNTIME");
}
export function imageProof(text: string, descriptor: ImageDescriptor): ImageInputProof {
  if (!validImageDescriptor(descriptor)) throw new RuntimeError("INVALID_RUNTIME");
  return {
    version: 1,
    descriptor: structuredClone(descriptor),
    contentHash: digest(stableJson({ version: 1, text, image: descriptor })),
  };
}
export function imageContent(text: string, image: PreparedImage) {
  checkImage(image, image.descriptor);
  return [
    { type: "text", text },
    {
      type: "image",
      source: {
        type: "base64",
        media_type: image.descriptor.mime,
        data: image.bytes.toString("base64"),
      },
    },
  ];
}
/** Text hashes remain unchanged; images are admitted only with the pinned manifest. */
export function inputText(content: unknown, proof?: ImageInputProof): string | null {
  if (!proof) {
    if (typeof content === "string") return content;
    if (
      Array.isArray(content) &&
      content.length === 1 &&
      content[0]?.type === "text" &&
      typeof content[0].text === "string"
    )
      return content[0].text;
    return null;
  }
  if (!validImageInputProof(proof) || !Array.isArray(content) || content.length !== 2) return null;
  const [text, image] = content;
  if (
    !text ||
    text.type !== "text" ||
    typeof text.text !== "string" ||
    Object.keys(text).length !== 2 ||
    !image ||
    image.type !== "image" ||
    Object.keys(image).length !== 2
  )
    return null;
  const source = image.source;
  if (
    !source ||
    Object.keys(source).length !== 3 ||
    source.type !== "base64" ||
    source.media_type !== proof.descriptor.mime ||
    typeof source.data !== "string" ||
    source.data.length > 699052 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)
  )
    return null;
  const bytes = Buffer.from(source.data, "base64");
  if (
    bytes.length !== proof.descriptor.bytes ||
    digest(bytes) !== proof.descriptor.sha256 ||
    bytes.toString("base64") !== source.data ||
    imageProof(text.text, proof.descriptor).contentHash !== proof.contentHash
  )
    return null;
  return text.text;
}
