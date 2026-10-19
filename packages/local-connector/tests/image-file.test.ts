import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  chmod,
  rm,
  writeFile,
  stat,
  unlink,
  symlink,
  readFile,
  link,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { digest } from "../src/runtime-contracts.ts";
import {
  createImageFile,
  imageFilePath,
  removeImageFile,
  removeRecoveredImageFile,
} from "../src/workflow/image-file.ts";
import { uuid } from "./runtime-fixture.ts";

for (const stoppedAt of ["missing-marker", "partial-marker", "partial-image"] as const)
  test(`should clean a request interrupted at ${stoppedAt} before ownership publication`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "image-interrupted-create-")));
    const bytes = Buffer.from("image");
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 1,
      height: 1,
      sha256: digest(bytes),
    };
    const owner = digest(uuid());
    try {
      const image = await createImageFile(root, descriptor, bytes, owner);
      // Creation now remains unpublished until both files are durable.
      const pending = join(root, `.image-${owner}.pending`);
      await rename(join(root, `image-${owner}`), pending);
      if (stoppedAt === "missing-marker") await unlink(join(pending, "owner.json"));
      if (stoppedAt === "partial-marker")
        await writeFile(join(pending, "owner.json"), '{"version":');
      if (stoppedAt === "partial-image") await writeFile(join(pending, "input"), "im");
      await removeRecoveredImageFile(root, owner, descriptor);
      await assert.rejects(stat(image.path!), { code: "ENOENT" });
      await assert.rejects(stat(pending), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

for (const tamper of ["symlink", "hardlink", "permissions", "unexpected-file"] as const) {
  test(`should preserve unsafe pending image files after ${tamper}`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "image-pending-guard-")));
    const bytes = Buffer.from("image");
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 1,
      height: 1,
      sha256: digest(bytes),
    };
    const owner = digest(uuid());
    try {
      await createImageFile(root, descriptor, bytes, owner);
      const pending = join(root, `.image-${owner}.pending`);
      await rename(join(root, `image-${owner}`), pending);
      const input = join(pending, "input");
      if (tamper === "symlink") {
        await unlink(input);
        await symlink(join(root, "foreign"), input);
      }
      if (tamper === "hardlink") await link(input, join(root, "foreign"));
      if (tamper === "permissions") await chmod(input, 0o644);
      if (tamper === "unexpected-file")
        await writeFile(join(pending, "foreign"), "preserve", { mode: 0o600 });
      await assert.rejects(removeRecoveredImageFile(root, owner, descriptor));
      await stat(join(pending, "owner.json"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("should persist exact request ownership and clean the image after process memory is lost", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "image-restart-")));
  const bytes = Buffer.from("synthetic image");
  const descriptor = {
    attachmentId: uuid(),
    mime: "image/png" as const,
    bytes: bytes.length,
    width: 1,
    height: 1,
    sha256: digest(bytes),
  };
  const owner = digest("agent-a:attempt-a");
  try {
    await createImageFile(root, descriptor, bytes, owner);
    await stat(join(root, `image-${owner}`, "owner.json"));
    await removeRecoveredImageFile(root, owner, descriptor);
    await assert.rejects(stat(join(root, `image-${owner}`)), { code: "ENOENT" });
    await removeRecoveredImageFile(root, owner, descriptor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const interruption of ["input", "metadata"] as const) {
  test(`should resume image cleanup after ${interruption} was already removed`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "image-partial-cleanup-")));
    const bytes = Buffer.from("image");
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 1,
      height: 1,
      sha256: digest(bytes),
    };
    const owner = digest(uuid());
    try {
      const image = await createImageFile(root, descriptor, bytes, owner);
      await unlink(image.path!);
      if (interruption === "metadata") await unlink(join(root, `image-${owner}`, "owner.json"));
      await removeRecoveredImageFile(root, owner, descriptor);
      await assert.rejects(stat(join(root, `image-${owner}`)), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
for (const tamper of [
  "owner",
  "descriptor",
  "inode",
  "hash",
  "symlink",
  "hardlink",
  "permissions",
] as const) {
  test(`should refuse recovered image cleanup after ${tamper} changes`, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "image-tamper-")));
    const bytes = Buffer.from("image");
    const descriptor = {
      attachmentId: uuid(),
      mime: "image/png" as const,
      bytes: bytes.length,
      width: 1,
      height: 1,
      sha256: digest(bytes),
    };
    const owner = digest(uuid());
    try {
      const image = await createImageFile(root, descriptor, bytes, owner);
      const marker = join(root, `image-${owner}`, "owner.json");
      if (["owner", "descriptor", "inode"].includes(tamper)) {
        const metadata = JSON.parse(await readFile(marker, "utf8"));
        if (tamper === "owner") metadata.owner = digest("another owner");
        if (tamper === "descriptor") metadata.descriptor.attachmentId = uuid();
        if (tamper === "inode") metadata.ino++;
        await writeFile(marker, JSON.stringify(metadata));
      }
      if (tamper === "hash") await writeFile(image.path!, "other");
      if (tamper === "symlink") {
        await unlink(image.path!);
        await symlink(join(root, "outside"), image.path!);
      }
      if (tamper === "hardlink") await link(image.path!, join(root, "another-link"));
      if (tamper === "permissions") await chmod(marker, 0o644);
      await assert.rejects(removeRecoveredImageFile(root, owner, descriptor));
      await stat(marker);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
