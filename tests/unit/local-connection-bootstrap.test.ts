import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connectionFixture, pins, preloadNames } from "../helpers/local-connection-fixture.ts";
import { localConnectionCommand } from "../../src/features/device-binding/local-connection-command.ts";

const macOnly = { skip: process.platform !== "darwin" };
test("should import a CLI entry without also executing its direct command", macOnly, async (t) => {
  const f = await connectionFixture(t, { directEntry: true });
  const result = await f.run();
  assert.equal(result.stderr, "");
  const executed = JSON.parse(await readFile(f.runFile, "utf8"));
  assert.deepEqual(executed.args, [
    "connect",
    "--server",
    f.args[0],
    "--profile",
    f.args[1],
    "--device-alias",
    f.args[2],
    "--organization-id",
    f.args[3],
    "--room-id",
    f.args[4],
  ]);
  assert.deepEqual(await readdir(join(f.root, "work")), []);
});
test(
  "should reuse a supported runtime and preserve state after verified cleanup",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t);
    await f.run();
    assert.deepEqual(JSON.parse(await readFile(f.runFile, "utf8")).preload, []);
    assert.deepEqual(await readdir(join(f.root, "work")), []);
    assert.equal(await readFile(f.state, "utf8"), '{"history":"must-survive"}\n');
    assert.ok(!(await readFile(f.log, "utf8")).includes("nodejs.org"));
  },
);
for (const arch of ["arm64", "x64"] as const) {
  test(`should verify the pinned official ${arch} runtime before execution`, macOnly, async (t) => {
    const source = await readFile(resolve("scripts/local-connection-bootstrap.sh"), "utf8");
    assert.ok(source.includes(pins[arch]));
    const f = await connectionFixture(t, { fallback: arch });
    await f.run();
    const requests = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(
      requests[0].url,
      `https://nodejs.org/download/release/v24.21.0/node-v24.21.0-darwin-${arch}.tar.gz`,
    );
    assert.match(
      JSON.parse(await readFile(f.runFile, "utf8")).path,
      new RegExp(`node-v24.21.0-darwin-${arch}/bin`),
    );
    assert.deepEqual(await readdir(join(f.root, "work")), []);
    const bad = await connectionFixture(t, { fallback: arch, badRuntime: true });
    await assert.rejects(bad.run(), (e: Error & { stderr?: string }) =>
      /DOWNLOAD_DIGEST/.test(e.stderr ?? ""),
    );
    await assert.rejects(readFile(bad.runFile), { code: "ENOENT" });
  });
}
for (const fault of ["corrupt", "redirect", "escape", "oversized"] as const) {
  test(`should refuse ${fault} downloads before connector execution`, macOnly, async (t) => {
    const f = await connectionFixture(t, { [fault]: true });
    await assert.rejects(f.run());
    await assert.rejects(readFile(f.runFile), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(f.root, "work")), []);
    await assert.rejects(readFile(join(f.root, "outside.js")), { code: "ENOENT" });
  });
}
for (const behavior of ["failure", "no-proof"] as const) {
  test(`should retain temporary files when shutdown has ${behavior}`, macOnly, async (t) => {
    const f = await connectionFixture(t, { behavior });
    await assert.rejects(f.run(), (e: Error & { stderr?: string }) => {
      assert.match(e.stderr ?? "", /임시 실행 파일을 보존/);
      assert.ok(!e.stderr?.includes("private-marker"));
      return true;
    });
    assert.equal((await readdir(join(f.root, "work"))).length, 1);
    assert.equal(await readFile(f.state, "utf8"), '{"history":"must-survive"}\n');
  });
}
test(
  "should forward termination and wait for connector shutdown before cleanup",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t, { behavior: "signal" });
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-p", f.script, ...f.args], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ended = new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      child.stderr.on("data", (b) => (stderr += b));
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    for (let n = 0; n < 200; n++) {
      try {
        await readFile(f.runFile);
        break;
      } catch {
        await delay(10);
      }
    }
    await readFile(f.runFile);
    await delay(30);
    child.kill("SIGTERM");
    const result = await ended;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(join(f.root, "stopped"), "utf8"), "stopped");
    assert.deepEqual(await readdir(join(f.root, "work")), []);
  },
);
test(
  "should block preload markers before shell, validation tools and Node execute",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t),
      marker = join(f.root, "preload-marker");
    const shell = join(f.root, "shell-preload");
    await writeFile(shell, `echo injected >> '${marker}'\n`);
    await promisify(execFile)("/bin/bash", ["--noprofile", "--norc", "-c", ":"], {
      env: { ...f.env, BASH_ENV: shell },
    });
    assert.match(await readFile(marker, "utf8"), /injected/);
    await writeFile(marker, "");
    const node = join(f.root, "node-preload.cjs");
    await writeFile(
      node,
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},'node-injected\\n');`,
    );
    // Establish that the Node marker is executable when NODE_OPTIONS is retained.
    await promisify(execFile)(process.execPath, ["-e", ""], {
      env: { ...f.env, NODE_OPTIONS: `--require=${node}` },
    });
    assert.match(await readFile(marker, "utf8"), /node-injected/);
    const library = join(f.root, "preload.dylib"),
      librarySource = join(f.root, "preload.c");
    await writeFile(
      librarySource,
      `extern int open(const char *, int, ...); extern long write(int, const void *, unsigned long); extern int close(int); __attribute__((constructor)) static void injected(void) { int fd = open(${JSON.stringify(marker)}, 0x0001 | 0x0008 | 0x0200, 0600); if(fd >= 0) { write(fd, "library-injected\\n", 17); close(fd); } }`,
    );
    await promisify(execFile)("/usr/bin/clang", ["-dynamiclib", librarySource, "-o", library], {
      timeout: 15000,
    });
    await promisify(execFile)(process.execPath, ["-e", ""], {
      env: { ...f.env, DYLD_INSERT_LIBRARIES: library },
    });
    assert.match(await readFile(marker, "utf8"), /library-injected/);
    await writeFile(marker, "");
    let command = await localConnectionCommand({
      origin: f.args[0],
      userId: "33333333-3333-4333-8333-333333333333",
      roomId: f.args[4],
      organizationId: f.args[3],
      deviceAlias: f.args[2],
      manifest: f.manifest,
    });
    command = command.replaceAll("/usr/bin/curl", `'${f.curl}'`);
    const env = { ...f.env } as NodeJS.ProcessEnv;
    for (const key of preloadNames)
      env[key] =
        key === "NODE_OPTIONS"
          ? `--require=${node}`
          : key === "BASH_ENV" || key === "ENV"
            ? shell
            : key === "DYLD_INSERT_LIBRARIES"
              ? library
              : join(f.root, "absent-library");
    // zsh is the already running user's shell. The command clears startup variables before its first new process.
    await promisify(execFile)("/bin/zsh", ["-f", "-c", command], {
      env,
      timeout: 15000,
      maxBuffer: 16384,
    });
    assert.equal(await readFile(marker, "utf8"), "");
    assert.deepEqual(JSON.parse(await readFile(f.runFile, "utf8")).preload, []);
    const requests = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.ok(requests.length >= 3);
    for (const request of requests) assert.deepEqual(request.preload, []);
  },
);

test(
  "should block Perl preload code before the digest validation tool executes",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t),
      marker = join(f.root, "perl-marker");
    const injected = `BEGIN { open(my $fh, ">>", ${JSON.stringify(marker)}) or die; print {$fh} "PERL_EXECUTED\\n"; close($fh); exit(0); }`;
    const variables = {
      PERL5OPT: "-d",
      PERL5DB: injected,
      PERL5LIB: join(f.root, "perl-lib"),
      PERLLIB: join(f.root, "perl-lib"),
    };
    await promisify(execFile)("/usr/bin/shasum", ["-a", "256", f.script], {
      env: { ...f.env, ...variables },
    });
    assert.match(await readFile(marker, "utf8"), /PERL_EXECUTED/);
    await writeFile(marker, "");
    let command = await localConnectionCommand({
      origin: f.args[0],
      userId: "33333333-3333-4333-8333-333333333333",
      roomId: f.args[4],
      organizationId: f.args[3],
      deviceAlias: f.args[2],
      manifest: f.manifest,
    });
    command = command.replaceAll("/usr/bin/curl", `'${f.curl}'`);
    await promisify(execFile)("/bin/zsh", ["-f", "-c", command], {
      env: { ...f.env, ...variables },
      timeout: 15000,
      maxBuffer: 16384,
    });
    assert.equal(await readFile(marker, "utf8"), "");
    assert.deepEqual(JSON.parse(await readFile(f.runFile, "utf8")).preload, []);
  },
);

test(
  "should ignore the default curl configuration for every connection download",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t),
      curlHome = join(f.root, "curl-home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(curlHome);
    await writeFile(
      join(curlHome, ".curlrc"),
      'url = "http://127.0.0.1:9/unrequested"\ninsecure\n',
    );
    const probeArgs = [
      "--silent",
      "--connect-timeout",
      "1",
      "--max-time",
      "1",
      "--write-out",
      "%{url_effective}\\n",
      "http://127.0.0.1:9/requested",
    ];
    const probe = async (extra: string[]) => {
      try {
        return (
          await promisify(execFile)("/usr/bin/curl", [...extra, ...probeArgs], {
            env: { ...f.env, CURL_HOME: curlHome },
            timeout: 3000,
          })
        ).stdout;
      } catch (error) {
        return (error as { stdout: string }).stdout;
      }
    };
    assert.match(await probe([]), /unrequested/);
    const clean = await probe(["--disable"]);
    assert.match(clean, /requested/);
    assert.doesNotMatch(clean, /unrequested/);
    let command = await localConnectionCommand({
      origin: f.args[0],
      userId: "33333333-3333-4333-8333-333333333333",
      roomId: f.args[4],
      organizationId: f.args[3],
      deviceAlias: f.args[2],
      manifest: f.manifest,
    });
    command = command.replaceAll("/usr/bin/curl", `'${f.curl}'`);
    await promisify(execFile)("/bin/zsh", ["-f", "-c", command], {
      env: { ...f.env, CURL_HOME: curlHome },
      timeout: 15000,
      maxBuffer: 16384,
    });
    const downloads = (await readFile(f.log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const download of downloads) {
      const effective = await probe(download.args[0] === "--disable" ? [download.args[0]] : []);
      assert.doesNotMatch(effective, /unrequested/);
    }
  },
);
