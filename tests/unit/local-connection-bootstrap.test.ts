import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { connectionFixture, pins, preloadNames } from "../helpers/local-connection-fixture.ts";
import { localConnectionCommand } from "../../src/features/device-binding/local-connection-command.ts";

const macOnly = { skip: process.platform !== "darwin" };
// Allow verified bootstrap startup before testing shutdown; keep all exit/proof assertions.
const startupPollAttempts = 1500;
test(
  "should carry the complete recovery selection through the generated shell and verified bootstrap",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t);
    const origin = f.args[0],
      userId = "33333333-3333-4333-8333-333333333333",
      roomId = f.args[4];
    const { readConnectionSelection, nextConnectionSelection } =
      await import("../../src/features/device-binding/local-connection-command.ts");
    let selection = await readConnectionSelection(null, origin, userId, roomId);
    for (let n = 0; n < 3; n++)
      selection = await nextConnectionSelection(
        selection,
        `12345678-1234-4123-8123-${String(n).padStart(12, "0")}`,
      );
    const command = (
      await localConnectionCommand({
        origin,
        userId,
        roomId,
        organizationId: f.args[3],
        deviceAlias: "검증 Mac",
        manifest: f.manifest,
        selection,
      })
    ).replaceAll("/usr/bin/curl", `'${f.curl}'`);
    await promisify(execFile)("/bin/zsh", ["-f", "-c", command], {
      env: f.env,
      timeout: 15000,
      maxBuffer: 16384,
    });
    const executed = JSON.parse(await readFile(f.runFile, "utf8"));
    assert.deepEqual(executed.args.slice(-6), [
      "--previous-profile",
      selection.chain.at(-1)!.previousProfile,
      "--recovery-id",
      selection.chain.at(-1)!.recoveryId,
      "--recovery-chain",
      JSON.stringify(selection),
    ]);
    assert.deepEqual(await readdir(join(f.root, "work")), []);
  },
);
test(
  "should pass exactly seven recovery arguments through the verified bootstrap",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t);
    const previous = f.args[1],
      id = "12345678-1234-4123-8123-123456789abc";
    f.args[1] = `web-${createHash("sha256")
      .update(JSON.stringify(["connection-recovery", previous, id]))
      .digest("hex")
      .slice(0, 32)}`;
    f.args.push(previous, id);
    await f.run();
    const executed = JSON.parse(await readFile(f.runFile, "utf8"));
    assert.deepEqual(executed.args.slice(-4), [
      "--previous-profile",
      previous,
      "--recovery-id",
      id,
    ]);
    assert.deepEqual(await readdir(join(f.root, "work")), []);
  },
);

for (const fault of ["partial", "same", "forged", "nonce"] as const)
  test(
    `should reject ${fault} recovery arguments before download or execution`,
    macOnly,
    async (t) => {
      const f = await connectionFixture(t);
      const previous = f.args[1],
        id = "12345678-1234-4123-8123-123456789abc";
      f.args.push(previous);
      if (fault !== "partial") f.args.push(fault === "nonce" ? "not-uuid" : id);
      if (fault !== "same") f.args[1] = `web-${"b".repeat(32)}`;
      await assert.rejects(f.run());
      await assert.rejects(readFile(f.runFile), { code: "ENOENT" });
      await assert.rejects(readFile(f.log), { code: "ENOENT" });
    },
  );
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
    for (let n = 0; n < startupPollAttempts; n++) {
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
  "should collect the actual child exit after its interrupted wait outlives shutdown",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t, { behavior: "signal" });
    // Scheduling can resume the shell trap only after the child has already exited.
    // Keep that timing deterministic without changing the child or its shutdown proof.
    await writeFile(
      f.script,
      (await readFile(f.script, "utf8")).replace(
        /trap '([^'\n]+)' TERM/,
        "trap '$1; /bin/sleep 0.05' TERM",
      ),
    );
    const child = spawn("/bin/bash", ["--noprofile", "--norc", "-p", f.script, ...f.args], {
      env: f.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    const ended = new Promise<{ code: number | null; stderr: string }>((done) => {
      let stderr = "";
      child.stderr.on("data", (bytes) => (stderr += bytes));
      child.on("exit", (code) => done({ code, stderr }));
    });
    for (let attempt = 0; attempt < startupPollAttempts; attempt++) {
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
    const retained = await readdir(join(f.root, "work"));
    const proof = await Promise.all(
      retained.map((name) =>
        readFile(join(f.root, "work", name, "shutdown"), "utf8").catch(
          (error: NodeJS.ErrnoException) => error.code,
        ),
      ),
    );
    assert.equal(result.code, 0, JSON.stringify({ ...result, proof }));
    assert.equal(await readFile(join(f.root, "stopped"), "utf8"), "stopped");
    assert.deepEqual(retained, []);
  },
);

test("should verify child shutdown after a terminal group interrupt", macOnly, async (t) => {
  const f = await connectionFixture(t, { behavior: "interrupt" });
  // Keep proof I/O pending after main settles so the terminal and forwarded INT
  // exercise the completed-main window rather than depending on disk timing.
  await writeFile(
    f.script,
    (await readFile(f.script, "utf8")).replace(
      'await writeFile(proof, "VERIFIED\\n",',
      'await new Promise(resolve => setTimeout(resolve, 50)); await writeFile(proof, "VERIFIED\\n",',
    ),
  );
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const child = spawn("/usr/bin/python3", [resolve("tests/helpers/local-connection-pty.py")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  child.stdin.write(
    JSON.stringify({
      command: ["/bin/bash", "--noprofile", "--norc", "-p", f.script, ...f.args]
        .map(quote)
        .join(" "),
      environment: { ...f.env, HOME: f.root },
    }) + "\n",
  );
  const ended = new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => (stdout += bytes));
    child.stderr.on("data", (bytes) => (stderr += bytes));
    child.on("exit", (code) => done({ code, stdout, stderr }));
  });
  for (let attempt = 0; attempt < startupPollAttempts; attempt++) {
    try {
      await readFile(f.runFile);
      break;
    } catch {
      await delay(10);
    }
  }
  await readFile(f.runFile);
  await delay(30);
  child.stdin.write("stop\n");
  const result = await ended;
  assert.equal(result.code, 0, result.stderr);
  const terminal = JSON.parse(result.stdout);
  const retained = await readdir(join(f.root, "work"));
  const proof = await Promise.all(
    retained.map((name) =>
      readFile(join(f.root, "work", name, "shutdown"), "utf8").catch(
        (error: NodeJS.ErrnoException) => error.code,
      ),
    ),
  );
  assert.equal(terminal.exitCode, 0, JSON.stringify({ ...terminal, proof }));
  assert.equal(await readFile(join(f.root, "stopped"), "utf8"), "stopped");
  assert.deepEqual(retained, []);
});

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

for (const fault of [
  "none",
  "tampered",
  "oversized",
  "expired",
  "scope",
  "chain",
  "redirect",
] as const)
  test(
    `should validate short launch description ${fault} before executing a connector`,
    macOnly,
    async (t) => {
      const f = await connectionFixture(t);
      const { readConnectionSelection, nextConnectionSelection } =
        await import("../../src/features/device-binding/local-connection-command.ts");
      const userId = "33333333-3333-4333-8333-333333333333",
        origin = f.args[0];
      let selection = await readConnectionSelection(null, origin, userId, f.args[4]);
      selection = await nextConnectionSelection(selection, "12345678-1234-4123-8123-123456789abc");
      const description = {
        version: 1,
        origin,
        ownerUserId: userId,
        organizationId: f.args[3],
        roomId: f.args[4],
        deviceAlias: "내 Mac",
        selection,
      };
      if (fault === "scope") description.origin = "https://other.example";
      if (fault === "chain") description.selection.chain[0].profile = "web-" + "0".repeat(32);
      const payload = JSON.stringify(description),
        payloadHash = createHash("sha256").update(payload).digest("hex");
      const endpoint = join(f.root, "public/api/connection-setup");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(endpoint, { recursive: true });
      await writeFile(
        join(endpoint, "resolve"),
        fault === "oversized"
          ? "x".repeat(16385)
          : JSON.stringify({
              ok: true,
              data: {
                payload: fault === "tampered" ? payload + " " : payload,
                payloadHash,
                expiresAt: new Date(
                  Date.now() + (fault === "expired" ? -1000 : 1800000),
                ).toISOString(),
              },
            }),
      );
      if (fault === "redirect") {
        const source = await readFile(f.curl, "utf8");
        await writeFile(
          f.curl,
          source.replace(
            'if (url.pathname.endsWith("startup-report"))',
            'if (url.pathname.endsWith("resolve")) { process.stdout.write("302"); process.exit(0); }\nif (url.pathname.endsWith("startup-report"))',
          ),
        );
      }
      f.args.splice(0, f.args.length, origin, "--setup-ticket", "c".repeat(64), payloadHash);
      if (fault === "none") {
        await f.run();
        const executed = JSON.parse(await readFile(f.runFile, "utf8"));
        assert.equal(executed.args[4], selection.chain[0].profile);
        assert.deepEqual(executed.args.slice(-2), ["--recovery-chain", JSON.stringify(selection)]);
      } else {
        await assert.rejects(f.run());
        await assert.rejects(readFile(f.runFile), { code: "ENOENT" });
      }
      const log = await readFile(f.log, "utf8");
      assert.ok(!log.includes("c".repeat(64)));
      const reports = log
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((x) => x.report);
      assert.ok(reports.length >= 1);
      assert.equal(reports[0].report.stage, "PREPARING");
      if (fault !== "none") assert.equal(reports.at(-1).report.reason, "INVALID_DESCRIPTION");
    },
  );

test(
  "should preserve the pre-Node failure when startup reporting is unavailable",
  macOnly,
  async (t) => {
    const f = await connectionFixture(t);
    await writeFile(
      f.script,
      (await readFile(f.script, "utf8")).replace("= Darwin ]", "= Linux ]"),
    );
    await writeFile(
      f.curl,
      (await readFile(f.curl, "utf8")).replace("process.exit(0);", "process.exit(22);"),
    );
    f.args.splice(0, f.args.length, f.args[0], "--setup-ticket", "c".repeat(64), "d".repeat(64));
    await assert.rejects(f.run(), (error: Error & { stderr?: string }) => {
      assert.match(error.stderr ?? "", /MACOS_REQUIRED/);
      return true;
    });
    await assert.rejects(readFile(f.runFile), { code: "ENOENT" });
  },
);

for (const [status, reason] of [
  [403, "FORBIDDEN"],
  [409, "CONFLICT"],
] as const)
  test(
    `should preserve bootstrap ${reason} with actionable public reporting`,
    macOnly,
    async (t) => {
      const f = await connectionFixture(t);
      const source = await readFile(f.curl, "utf8");
      await writeFile(
        f.curl,
        source.replace(
          'if (url.pathname.endsWith("startup-report"))',
          `if (url.pathname.endsWith("resolve")) { process.stdout.write("${status}"); process.exit(0); }\nif (url.pathname.endsWith("startup-report"))`,
        ),
      );
      f.args.splice(0, f.args.length, f.args[0], "--setup-ticket", "c".repeat(64), "d".repeat(64));
      await assert.rejects(f.run(), (error: Error & { stderr?: string }) => {
        assert.ok(error.stderr?.includes(reason));
        return true;
      });
      const reports = (await readFile(f.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((row) => row.report);
      assert.equal(reports.at(-1).report.reason, reason);
    },
  );
