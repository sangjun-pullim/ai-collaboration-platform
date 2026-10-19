import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { digest } from "../src/runtime-contracts.ts";
import { imageContent, imageProof, inputText, checkImage } from "../src/workflow/image-content.ts";
import { NativeInputProof } from "../src/claude/input-proof.ts";

function fixture() {
  const bytes = Buffer.from("synthetic image bytes");
  const descriptor = {
    attachmentId: randomUUID(),
    mime: "image/png" as const,
    bytes: bytes.length,
    width: 10,
    height: 10,
    sha256: digest(bytes),
  };
  const image = { descriptor, bytes },
    text = "Describe this image";
  return { image, text, proof: imageProof(text, descriptor), content: imageContent(text, image) };
}
test("should verify image input ACK against exact text and image manifest", () => {
  const f = fixture(),
    session = randomUUID(),
    input = randomUUID();
  const proof = new NativeInputProof(session, input, digest(f.text), undefined, undefined, f.proof);
  assert.equal(
    proof.user({
      type: "user",
      uuid: input,
      session_id: session,
      parent_tool_use_id: null,
      message: { role: "user", content: f.content },
    }),
    "INPUT_ACK",
  );
  assert.equal(inputText(f.content, f.proof), f.text);
});
test("should reject altered, omitted, reordered or unreserved images", () => {
  const f = fixture();
  const altered = structuredClone(f.content);
  altered[1].source!.data = Buffer.from("other").toString("base64");
  for (const content of [altered, [f.content[0]], [...f.content].reverse(), f.text])
    assert.equal(inputText(content, f.proof), null);
  assert.equal(inputText(f.content), null);
  assert.throws(() => checkImage({ ...f.image, bytes: Buffer.from("other") }, f.image.descriptor));
});
test("should preserve legacy text string and single text block hashes", () => {
  assert.equal(inputText("hello"), "hello");
  assert.equal(inputText([{ type: "text", text: "hello" }]), "hello");
});
