import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, chmod, rm, writeFile, stat, unlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest } from "../src/runtime-contracts.ts";
import { createImageFile, imageFilePath, removeImageFile } from "../src/workflow/image-file.ts";
import { uuid } from "./runtime-fixture.ts";

test("should admit only the connector owned private image with matching bytes and identity", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "owned-image-")));
  await chmod(root, 0o700);
  const bytes = Buffer.from("synthetic image");
  const descriptor = {
    attachmentId: uuid(),
    mime: "image/png" as const,
    bytes: bytes.length,
    width: 1,
    height: 1,
    sha256: digest(bytes),
  };
  try {
    const image = await createImageFile(root, descriptor, bytes);
    const path = await imageFilePath(image);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(imageFilePath({ ...image }), { code: "UNSAFE_STORAGE" });
    await writeFile(path, Buffer.alloc(bytes.length));
    await assert.rejects(imageFilePath(image), { code: "INVALID_RUNTIME" });
    await writeFile(path, bytes);
    await removeImageFile(image);
    await assert.rejects(stat(path), { code: "ENOENT" });
    const second = await createImageFile(root, descriptor, bytes);
    await unlink(second.path!);
    await symlink(join(root, "other"), second.path!);
    await assert.rejects(imageFilePath(second), { code: "UNSAFE_STORAGE" });
    await chmod(root, 0o755);
    await assert.rejects(createImageFile(root, descriptor, bytes), { code: "UNSAFE_STORAGE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
