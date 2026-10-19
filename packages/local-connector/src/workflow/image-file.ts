import { constants } from "node:fs";
import {
  lstat,
  realpath,
  mkdtemp,
  mkdir,
  open,
  unlink,
  rmdir,
  rename,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { RuntimeError, stableJson } from "../runtime-contracts.ts";
import { checkImage, type PreparedImage } from "./image-content.ts";
import { validImageDescriptor, type ImageDescriptor } from "../workflow-contracts.ts";

const owned = new WeakMap<
  PreparedImage,
  { directory: string; path: string; dev: number; ino: number; owner?: string; root?: string }
>();
async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    (await realpath(path)) !== path
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  return stat;
}
async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
function ownerDirectory(root: string, owner: string) {
  if (!/^[a-f0-9]{64}$/.test(owner)) throw new RuntimeError("UNSAFE_STORAGE");
  return join(root, `image-${owner}`);
}
function pendingDirectory(root: string, owner: string) {
  ownerDirectory(root, owner);
  return join(root, `.image-${owner}.pending`);
}
/** Unpublished files are never passed to the provider, including a partial metadata write. */
async function removePendingImage(root: string, owner: string) {
  const path = pendingDirectory(root, owner);
  let directory;
  try {
    directory = await privateDirectory(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const names = await readdir(path);
  if (names.length > 2 || names.some((name) => name !== "input" && name !== "owner.json"))
    throw new RuntimeError("UNSAFE_STORAGE");
  // Validate every entry before deleting any, and never traverse a symbolic link.
  const entries = await Promise.all(
    names.map(async (name) => {
      const stat = await lstat(join(path, name));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > (name === "input" ? 524288 : 4096)
      )
        throw new RuntimeError("UNSAFE_STORAGE");
      return { name, stat };
    }),
  );
  for (const entry of entries) {
    const parent = await privateDirectory(path),
      current = await lstat(join(path, entry.name));
    if (
      parent.dev !== directory.dev ||
      parent.ino !== directory.ino ||
      current.dev !== entry.stat.dev ||
      current.ino !== entry.stat.ino ||
      current.nlink !== 1
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    await unlink(join(path, entry.name));
  }
  await syncDirectory(path);
  await rmdir(path);
  await syncDirectory(root);
}
export async function createImageFile(
  root: string,
  descriptor: ImageDescriptor,
  bytes: Buffer,
  owner?: string,
) {
  const image: PreparedImage = {
    descriptor: structuredClone(descriptor),
    bytes: Buffer.from(bytes),
  };
  checkImage(image, descriptor);
  await privateDirectory(root);
  let directory = owner ? pendingDirectory(root, owner) : await mkdtemp(join(root, "image-"));
  if (owner) await mkdir(directory, { mode: 0o700 });
  let path = join(directory, "input");
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
  if (owner) {
    const parent = await privateDirectory(directory);
    const metadata = await open(
      join(directory, "owner.json"),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await metadata.writeFile(
        JSON.stringify({
          version: 1,
          owner,
          descriptor,
          dev: stat.dev,
          ino: stat.ino,
          directoryDev: parent.dev,
          directoryIno: parent.ino,
        }),
      );
      await metadata.sync();
    } finally {
      await metadata.close();
    }
    await syncDirectory(directory);
    const destination = ownerDirectory(root, owner);
    // Never replace an earlier request's published directory, including an empty one.
    try {
      await lstat(destination);
      throw new RuntimeError("UNSAFE_STORAGE");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(directory, destination);
    directory = destination;
    path = join(directory, "input");
    await syncDirectory(root);
  }
  image.path = path;
  owned.set(image, {
    directory,
    path,
    dev: stat.dev,
    ino: stat.ino,
    ...(owner ? { owner, root } : {}),
  });
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
  if (entry.owner && entry.root) {
    await removeRecoveredImageFile(entry.root, entry.owner, image.descriptor);
    owned.delete(image);
    return;
  }
  await unlink(path);
  await rmdir(entry.directory);
  owned.delete(image);
}

/** Called only with a durable terminal or confirmed no-input closure for this exact request. */
export async function removeRecoveredImageFile(
  root: string,
  owner: string,
  descriptor: ImageDescriptor,
): Promise<void> {
  if (!validImageDescriptor(descriptor)) throw new RuntimeError("UNSAFE_STORAGE");
  await privateDirectory(root);
  await removePendingImage(root, owner);
  const directory = ownerDirectory(root, owner);
  let parent;
  try {
    parent = await privateDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const marker = join(directory, "owner.json"),
    path = join(directory, "input");
  let handle;
  try {
    handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A previous cleanup may have removed both files before its final rmdir.
    await rmdir(directory);
    await syncDirectory(root);
    return;
  }
  let metadata;
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 4096
    )
      throw new RuntimeError("UNSAFE_STORAGE");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) throw new RuntimeError("UNSAFE_STORAGE");
    metadata = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    const after = await lstat(marker);
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    )
      throw new RuntimeError("UNSAFE_STORAGE");
  } finally {
    await handle.close();
  }
  if (
    !metadata ||
    Object.keys(metadata).sort().join(",") !==
      "descriptor,dev,directoryDev,directoryIno,ino,owner,version" ||
    metadata.version !== 1 ||
    metadata.owner !== owner ||
    stableJson(metadata.descriptor) !== stableJson(descriptor) ||
    metadata.directoryDev !== parent.dev ||
    metadata.directoryIno !== parent.ino ||
    !Number.isSafeInteger(metadata.dev) ||
    !Number.isSafeInteger(metadata.ino)
  )
    throw new RuntimeError("UNSAFE_STORAGE");
  let exists = true;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    // Reuse the live-file identity/content checks without restoring execution authority.
    const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const stat = await input.stat();
      if (
        !stat.isFile() ||
        stat.size !== descriptor.bytes ||
        stat.dev !== metadata.dev ||
        stat.ino !== metadata.ino
      )
        throw new RuntimeError("UNSAFE_STORAGE");
      const buffer = Buffer.alloc(descriptor.bytes + 1);
      const { bytesRead } = await input.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, bytesRead);
    } finally {
      await input.close();
    }
    const image = { descriptor, bytes, path };
    owned.set(image, { directory, path, dev: metadata.dev, ino: metadata.ino });
    await imageFilePath(image);
    await unlink(path);
    owned.delete(image);
    await syncDirectory(directory);
  }
  await unlink(marker);
  await syncDirectory(directory);
  await rmdir(directory);
  await syncDirectory(root);
}
