import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const maxUnpacked = 64 * 1024 * 1024;
const maxCompressed = 16 * 1024 * 1024;

async function filesIn(dir) {
  if ((await lstat(dir)).isSymbolicLink()) throw new Error("DISTRIBUTION_SYMLINK");
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isSymbolicLink()) throw new Error("DISTRIBUTION_SYMLINK");
    if (item.isDirectory()) files.push(...(await filesIn(path)));
    else if (item.isFile()) files.push(path);
    else throw new Error("DISTRIBUTION_FILE_TYPE");
  }
  return files.sort();
}

function imports(source, name) {
  const result = [];
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) throw new Error("DISTRIBUTION_IMPORT");
      result.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))
        throw new Error("DISTRIBUTION_IMPORT");
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return result;
}

async function inventory(compiled) {
  const entries = new Map();
  let bytes = 0;
  for (const path of await filesIn(compiled)) {
    if (entries.size >= 4096) throw new Error("DISTRIBUTION_SIZE");
    const name = relative(compiled, path).split("\\").join("/");
    if (!/^src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/.test(name)) throw new Error("DISTRIBUTION_FILE");
    const info = await lstat(path);
    bytes += info.size;
    if (bytes > maxUnpacked) throw new Error("DISTRIBUTION_SIZE");
    entries.set(name, await readFile(path));
  }
  if (!entries.has("src/cli.js")) throw new Error("DISTRIBUTION_ENTRY");
  for (const [name, content] of entries) {
    for (const specifier of imports(content.toString("utf8"), name)) {
      if (isBuiltin(specifier)) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../"))
        throw new Error("DISTRIBUTION_DEPENDENCY");
      const target = relative(compiled, resolve(compiled, dirname(name), specifier));
      if (!entries.has(target)) throw new Error("DISTRIBUTION_DEPENDENCY");
    }
  }
  entries.set("package.json", Buffer.from('{"type":"module"}\n'));
  return entries;
}

function archive(entries) {
  const chunks = [];
  for (const [name, content] of [...entries].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (Buffer.byteLength(name) > 100) throw new Error("DISTRIBUTION_PATH");
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    const octal = (value, offset, width) =>
      header.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
    octal(0o600, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257, 6);
    header.write("00", 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const result = gzipSync(Buffer.concat(chunks), { level: 9 });
  if (result.length > maxCompressed) throw new Error("DISTRIBUTION_SIZE");
  return result;
}

async function compile(root, output) {
  const compiler = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  await promisify(execFile)(
    process.execPath,
    [
      compiler,
      "-p",
      join(root, "packages/local-connector/tsconfig.distribution.json"),
      "--outDir",
      output,
    ],
    { cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
}

async function publish(output, name, bytes) {
  const destination = join(output, name);
  try {
    const stat = await lstat(destination);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== bytes.length ||
      sha256(await readFile(destination)) !== sha256(bytes)
    )
      throw new Error("DISTRIBUTION_EXISTING_ASSET");
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
}

async function directoryChain(root, parts, create = false) {
  let current = resolve(root);
  for (const part of ["", ...parts]) {
    current = join(current, part);
    if (create)
      await mkdir(current).catch((error) => {
        if (error.code !== "EEXIST") throw error;
      });
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("DISTRIBUTION_SYMLINK");
    if (!info.isDirectory()) throw new Error("DISTRIBUTION_FILE_TYPE");
  }
  return current;
}

export async function buildLocalConnection({ root = projectRoot, compiler = compile } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "ai-collab-distribution-"));
  try {
    await filesIn(await directoryChain(root, ["packages", "local-connector", "src"]));
    const compiled = join(temp, "compiled");
    await mkdir(compiled);
    await compiler(root, compiled);
    const code = archive(await inventory(compiled));
    const bootstrapFile = join(
      await directoryChain(root, ["scripts"]),
      "local-connection-bootstrap.sh",
    );
    const bootstrapInfo = await lstat(bootstrapFile);
    if (!bootstrapInfo.isFile() || bootstrapInfo.isSymbolicLink())
      throw new Error("DISTRIBUTION_SYMLINK");
    if (bootstrapInfo.size > 128 * 1024) throw new Error("DISTRIBUTION_SIZE");
    const bootstrap = await readFile(bootstrapFile);
    if (!bootstrap.length || bootstrap.length > 128 * 1024) throw new Error("DISTRIBUTION_SIZE");
    const codeHash = sha256(code);
    const bootstrapHash = sha256(bootstrap);
    const codeName = `connector-${codeHash}.tar.gz`;
    const bootstrapName = `bootstrap-${bootstrapHash}.sh`;
    const manifest = {
      version: 1,
      code: { path: `/local-connection/${codeName}`, sha256: codeHash, bytes: code.length },
      bootstrap: {
        path: `/local-connection/${bootstrapName}`,
        sha256: bootstrapHash,
        bytes: bootstrap.length,
      },
    };
    const output = await directoryChain(root, ["public", "local-connection"], true);
    await publish(output, codeName, code);
    await publish(output, bootstrapName, bootstrap);
    const pending = join(output, `manifest-${process.pid}-${Date.now()}.tmp`);
    try {
      await writeFile(pending, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o644 });
      await rename(pending, join(output, "manifest.json"));
    } finally {
      await rm(pending, { force: true });
    }
    return manifest;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  buildLocalConnection().then(
    (manifest) =>
      process.stdout.write(
        JSON.stringify({ status: "BUILT", version: manifest.version, modelInputs: 0 }) + "\n",
      ),
    () => {
      process.stderr.write(
        '{"status":"BLOCKED","code":"DISTRIBUTION_BUILD_FAILED","modelInputs":0}\n',
      );
      process.exitCode = 1;
    },
  );
}
