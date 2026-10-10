import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function migrationSources(root) {
  let directory = await realpath(root);
  for (const part of ["supabase", "migrations"]) {
    directory = join(directory, part);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_MIGRATION_PATH");
  }
  const versions = new Set();
  const sources = [];
  let totalBytes = 0;
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith(".sql")) continue;
    const match = /^(\d{14})[-_]([a-z][a-z0-9-]*)\.sql$/.exec(name);
    if (!match) throw new Error("INVALID_MIGRATION_NAME");
    if (versions.has(match[1])) throw new Error("DUPLICATE_MIGRATION_VERSION");
    const stat = await lstat(join(directory, name));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("UNSAFE_MIGRATION_PATH");
    if (stat.size > 2 * 1024 * 1024 || sources.length >= 256)
      throw new Error("MIGRATION_SIZE_LIMIT");
    const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error("UNSAFE_MIGRATION_PATH");
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
    totalBytes += bytes.length;
    if (bytes.length !== stat.size || totalBytes > 16 * 1024 * 1024)
      throw new Error("MIGRATION_SIZE_LIMIT");
    versions.add(match[1]);
    sources.push({
      originalName: name,
      preparedName: `${match[1]}_${match[2]}.sql`,
      version: match[1],
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    });
  }
  if (!sources.length) throw new Error("NO_MIGRATIONS");
  return sources;
}

// Prepare CLI-compatible copies only; this command never connects to a database.
export async function prepareSupabaseCloud({ root = projectRoot, parent = tmpdir() } = {}) {
  const sources = await migrationSources(root);
  const workdir = await realpath(await mkdtemp(join(parent, "ai-collab-supabase-")));
  try {
    const destination = join(workdir, "supabase/migrations");
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const source of sources)
      await writeFile(join(destination, source.preparedName), source.bytes, {
        flag: "wx",
        mode: 0o600,
      });
    const migrations = sources.map(({ bytes, ...source }) => ({ ...source, bytes: bytes.length }));
    await writeFile(
      join(workdir, "migration-manifest.json"),
      JSON.stringify(migrations, null, 2) + "\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    return { status: "PREPARED", workdir, migrations, modelInputs: 0 };
  } catch (error) {
    await rm(workdir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2) throw new Error("UNEXPECTED_ARGUMENT");
    process.stdout.write(JSON.stringify(await prepareSupabaseCloud()) + "\n");
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ status: "BLOCKED", code: error.message, modelInputs: 0 }) + "\n",
    );
    process.exitCode = 1;
  }
}
