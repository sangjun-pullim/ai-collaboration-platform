import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";

export const pins = {
  arm64: "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057",
  x64: "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097",
};
export const preloadNames = [
  "BASH_ENV",
  "ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5OPT",
  "PERL5DB",
  "PERL5LIB",
  "PERLLIB",
  "PERLIO",
  "PERL_USE_UNSAFE_INC",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function connectionFixture(
  t: TestContext,
  options: {
    fallback?: "arm64" | "x64";
    behavior?: "failure" | "no-proof" | "signal";
    corrupt?: boolean;
    redirect?: boolean;
    escape?: boolean;
    oversized?: boolean;
    badRuntime?: boolean;
    directEntry?: boolean;
  } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connection-bootstrap-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["packages/local-connector/src", "scripts", "bin", "work", "state"])
    await mkdir(join(root, dir), { recursive: true });
  const state = join(root, "state", "original.json"),
    runFile = join(root, "run.json"),
    log = join(root, "downloads.jsonl");
  await writeFile(state, '{"history":"must-survive"}\n', { mode: 0o600 });
  const uname = join(root, "bin", "uname"),
    sw = join(root, "bin", "sw_vers"),
    curl = join(root, "bin", "curl");
  await writeFile(
    uname,
    `#!/bin/bash\nif [ "$1" = -s ]; then echo Darwin; else echo ${options.fallback === "x64" ? "x86_64" : "arm64"}; fi\n`,
    { mode: 0o700 },
  );
  await writeFile(sw, "#!/bin/bash\necho 14.0\n", { mode: 0o700 });
  let bootstrap = (await readFile(resolve("scripts/local-connection-bootstrap.sh"), "utf8"))
    .replaceAll("/usr/bin/uname", quote(uname))
    .replaceAll("/usr/bin/sw_vers", quote(sw))
    .replaceAll("/usr/bin/curl", quote(curl));
  let runtimeFile: string | undefined;
  if (options.fallback) {
    const pkg = `node-v24.21.0-darwin-${options.fallback}`;
    await mkdir(join(root, pkg, "bin"), { recursive: true });
    await writeFile(
      join(root, pkg, "bin/node"),
      `#!/bin/bash\nif [ "$1" = --version ]; then echo v24.21.0; else exec ${quote(process.execPath)} "$@"; fi\n`,
      { mode: 0o700 },
    );
    await writeFile(join(root, pkg, "LICENSE"), "fixture-license\n");
    runtimeFile = join(root, "runtime.tar.gz");
    await promisify(execFile)(
      "/usr/bin/tar",
      ["-czf", runtimeFile, "-C", root, `${pkg}/bin/node`, `${pkg}/LICENSE`],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const sha = digest(await readFile(runtimeFile));
    bootstrap = bootstrap.replace(
      pins[options.fallback],
      options.badRuntime ? "f".repeat(64) : sha,
    );
    await writeFile(join(root, "bin", "node"), "#!/bin/bash\necho v20.0.0\n", { mode: 0o700 });
  } else await symlink(process.execPath, join(root, "bin", "node"));
  await writeFile(join(root, "scripts/local-connection-bootstrap.sh"), bootstrap);
  const build = (await import(pathToFileURL(resolve("scripts/build-local-connection.mjs")).href))
    .buildLocalConnection;
  const manifest = await build({
    root,
    compiler: async (_root: string, out: string) => {
      await mkdir(join(out, "src"));
      const behavior =
        options.behavior === "failure"
          ? 'throw Object.assign(new Error("private-marker"), {code:"UNAVAILABLE"});'
          : options.behavior === "no-proof"
            ? "process.exit(0);"
            : options.behavior === "signal"
              ? `await new Promise(resolve => { const timer = setInterval(() => {}, 1000); process.once("SIGTERM", () => { clearInterval(timer); fs.writeFileSync(${JSON.stringify(join(root, "stopped"))}, "stopped"); resolve(); }); });`
              : "";
      await writeFile(
        join(out, "src", "cli.js"),
        `import fs from "node:fs"; import {resolve} from "node:path"; import {pathToFileURL} from "node:url";
export async function main(args) {
  if (args[0] !== "connect") throw Object.assign(new Error("unexpected CLI arguments"), {code:"INVALID_BODY"});
  fs.writeFileSync(${JSON.stringify(runFile)}, JSON.stringify({args, path:process.env.PATH, preload:${JSON.stringify(preloadNames)}.filter(key => Object.hasOwn(process.env, key))})); ${behavior}
}
${options.directEntry ? `if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2)).catch(error => { process.stderr.write(JSON.stringify({state:"disconnected",error:error.code})+"\\n"); process.exitCode=1; });` : ""}`,
      );
    },
  });
  if (options.escape || options.oversized) {
    const original = join(root, "public", manifest.code.path);
    const tar = gunzipSync(await readFile(original));
    if (options.escape) {
      tar.fill(0, 0, 100);
      tar.write("../outside.js", 0);
      tar.fill(32, 148, 156);
      const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
      tar.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    }
    const code = options.oversized ? Buffer.alloc(16777217) : gzipSync(tar);
    const sha = digest(code);
    manifest.code = {
      path: `/local-connection/connector-${sha}.tar.gz`,
      sha256: sha,
      bytes: options.oversized ? 16777216 : code.length,
    };
    await writeFile(join(root, "public", manifest.code.path), code);
    await writeFile(join(root, "public/local-connection/manifest.json"), JSON.stringify(manifest));
  }
  if (options.corrupt)
    await writeFile(join(root, "public", manifest.code.path), Buffer.alloc(manifest.code.bytes));
  await writeFile(
    curl,
    `#!${process.execPath}\nimport {appendFileSync,readFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2), url=new URL(args.at(-1)), output=args[args.indexOf("--output")+1];
appendFileSync(${JSON.stringify(log)}, JSON.stringify({url:url.href,args,preload:${JSON.stringify(preloadNames)}.filter(key => Object.hasOwn(process.env,key))})+"\\n");
if (${!!options.redirect} && url.pathname.includes("connector-")) { writeFileSync(output, ""); process.stdout.write("302"); } else {
const file=url.hostname==="nodejs.org" ? ${JSON.stringify(runtimeFile ?? "")} : ${JSON.stringify(root + "/public")}+url.pathname;
writeFileSync(output,readFileSync(file)); process.stdout.write("200"); }
`,
    { mode: 0o700 },
  );
  // A package boundary makes the Node shebang fixture executable independently of the checkout.
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  const args = [
    "https://app.example",
    "web-" + "a".repeat(32),
    "내 Mac",
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: join(root, "bin") + ":/usr/bin:/bin",
    TMPDIR: join(root, "work"),
  };
  for (const key of preloadNames) delete env[key];
  return {
    root,
    manifest,
    curl,
    args,
    env,
    state,
    runFile,
    log,
    script: join(root, "scripts/local-connection-bootstrap.sh"),
    run: () =>
      promisify(execFile)(
        "/bin/bash",
        [
          "--noprofile",
          "--norc",
          "-p",
          join(root, "scripts/local-connection-bootstrap.sh"),
          ...args,
        ],
        { env, timeout: 15000, maxBuffer: 16384 },
      ),
  };
}
