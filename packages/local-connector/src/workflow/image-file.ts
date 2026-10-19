import { constants } from "node:fs";
import { lstat, realpath, mkdtemp, open, unlink, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeError } from "../runtime-contracts.ts";
import { checkImage, type PreparedImage } from "./image-content.ts";
import type { ImageDescriptor } from "../workflow-contracts.ts";

const owned = new WeakMap<
  PreparedImage,
  { directory: string; path: string; dev: number; ino: number }
>();
export async function createImageFile(root: string, descriptor: ImageDescriptor, bytes: Buffer) {
  const image: PreparedImage = {
    descriptor: structuredClone(descriptor),
    bytes: Buffer.from(bytes),
  };
  checkImage(image, descriptor);
  const parent = await lstat(root);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0 ||
    (await realpath(root)) !== root
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  const directory = await mkdtemp(join(root, "image-"));
  const path = join(directory, "input");
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const stat = await lstat(path);
  image.path = path;
  owned.set(image, { directory, path, dev: stat.dev, ino: stat.ino });
  return image;
}
export async function imageFilePath(image: PreparedImage): Promise<string> {
  const expected = owned.get(image);
  if (!expected || expected.path !== image.path) throw new RuntimeError("UNSAFE_STORAGE");
  const parent = await lstat(expected.directory),
    stat = await lstat(expected.path);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    parent.uid !== process.getuid?.() ||
    (await realpath(expected.directory)) !== expected.directory ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  const handle = await open(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== image.descriptor.bytes
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    // Read at most the admitted size plus one byte, even if the file grows concurrently.
    const buffer = Buffer.alloc(image.descriptor.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    const bytes = buffer.subarray(0, length);
    checkImage({ ...image, bytes }, image.descriptor);
  } finally {
    await handle.close();
  }
  return expected.path;
}
export async function removeImageFile(image: PreparedImage): Promise<void> {
  const path = await imageFilePath(image);
  const entry = owned.get(image)!;
  await unlink(path);
  await rmdir(entry.directory);
  owned.delete(image);
}
