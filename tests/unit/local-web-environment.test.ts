import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

type Execute = (args: string[], input?: string) => Promise<string>;
const anon = `e30.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64url")}.signature`;

function consumerConfig(keys: string[] = [anon]) {
  return `consumers:\n  - username: anon\n    keyauth_credentials:\n${keys.map((key) => `      - key: ${JSON.stringify(key)}`).join("\n")}\n`;
}

function transformerConfig(headers: string[], querystring: string[] = []) {
  return `services:\n  - name: auth-v1\n    plugins:\n      - name: request-transformer\n        config:\n          add:\n            headers:\n${headers.map((header) => `              - ${JSON.stringify(header)}`).join("\n")}\n          replace:\n            querystring:\n${querystring.map((value) => `              - ${JSON.stringify(value)}`).join("\n")}\n`;
}

async function fixture(t: TestContext) {
  const base = join(tmpdir(), "ai-collab-implementation-txxcvm61");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "local-web-unit-"));
  const canonicalDir = await realpath(dir);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const driver = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  const database = {
    id: "a".repeat(64),
    labels: { "com.supabase.cli.project": "ai-collab-txxcvm61", "com.supabase.cli.workdir": dir },
    running: true,
    ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "56322" }] },
  };
  const f = {
    resolve: undefined as unknown as (
      execute: Execute,
      inherited?: Record<string, string>,
    ) => Promise<Record<string, string>>,
    dir,
    database,
    gateway: {
      ...database,
      labels: { ...database.labels },
      id: "b".repeat(64),
      ports: { "8000/tcp": [{ HostIp: "127.0.0.1", HostPort: "56321" }] },
    },
    features: { aiSettings: true, aiPause: true, folderAutoRead: true, answerSources: true },
    status: {
      API_URL: "http://127.0.0.1:56321",
      ANON_KEY: anon,
      SERVICE_ROLE_KEY: "private-admin-value",
      JWT_SECRET: "private-signing-value",
      DB_URL: "private-database-value",
    },
    statusReads: 0,
    statusFailure: null as Error | null,
    calls: [] as { args: string[]; input: string }[],
    execute: undefined as unknown as Execute,
  };
  f.resolve = (execute, inherited = {}) =>
    driver.localWebEnvironment(
      execute,
      inherited,
      async (workdir: string) => {
        assert.equal(workdir, canonicalDir);
        f.statusReads++;
        if (f.statusFailure) throw f.statusFailure;
        return JSON.stringify(f.status);
      },
      dir,
    );
  f.execute = async (args, input = "") => {
    f.calls.push({ args, input });
    if (args[0] === "exec") {
      assert.deepEqual(args.slice(0, 4), ["exec", "-i", database.id, "psql"]);
      assert.ok(input.startsWith("BEGIN READ ONLY;"));
      assert.ok(input.endsWith("ROLLBACK;"));
      return JSON.stringify(f.features);
    }
    assert.equal(args[0], "inspect");
    if (args.at(-1) === "supabase_db_ai-collab-txxcvm61") return JSON.stringify(database);
    if (args.at(-1) === "supabase_kong_ai-collab-txxcvm61") return JSON.stringify(f.gateway);
    assert.fail("Unexpected gateway key read: official Kong environment does not contain it");
  };
  return f;
}

async function checkCommand(t: TestContext, failure: boolean) {
  const f = await fixture(t);
  const webRoot = join(f.dir, "web");
  await mkdir(join(webRoot, "scripts"), { recursive: true });
  for (const name of ["dev-local-web.mjs", "apply-local-ai-settings.mjs"]) {
    await writeFile(join(webRoot, "scripts", name), await readFile(resolve("scripts", name)));
  }
  const marker = join(webRoot, "web-started");
  const nextDir = join(webRoot, "node_modules/next/dist/bin");
  await mkdir(nextDir, { recursive: true });
  await symlink(resolve("node_modules/js-yaml"), join(webRoot, "node_modules/js-yaml"), "dir");
  await writeFile(
    join(nextDir, "next"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started");`,
  );
  const config = failure ? "private-admin-value private-signing-value" : consumerConfig();
  const dockerBody = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[2] === "inspect") {
  process.stdout.write(JSON.stringify(args.at(-1).includes("_db_") ? ${JSON.stringify(f.database)} : ${JSON.stringify(f.gateway)}));
} else if (args[2] === "exec" && args[4] === "cat") {
  if (args[3] !== ${JSON.stringify(f.gateway.id)} || args[5] !== "/home/kong/kong.yml") process.exit(99);
  process.stdout.write(${JSON.stringify(config)});
} else {
  let input = "";
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => {
    if (!input.startsWith("BEGIN READ ONLY;") || !input.endsWith("ROLLBACK;")) process.exit(99);
    process.stdout.write(${JSON.stringify(JSON.stringify(f.features))});
  });
}
`;
  await writeFile(join(f.dir, "docker"), dockerBody, { mode: 0o700 });
  return {
    marker,
    run: async () =>
      promisify(execFile)(
        process.execPath,
        [await realpath(join(webRoot, "scripts/dev-local-web.mjs")), "--check"],
        {
          env: { PATH: f.dir, HOME: process.env.HOME, TMPDIR: tmpdir() },
          timeout: 5_000,
          maxBuffer: 16_384,
        },
      ),
  };
}

test(
  "should emit only the safe failure JSON in a check-only command",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const command = await checkCommand(t, true);
    await assert.rejects(command.run(), (error: Error & { stdout?: string; stderr?: string }) => {
      assert.equal(error.stdout, "");
      assert.deepEqual(JSON.parse(error.stderr ?? ""), {
        status: "BLOCKED",
        code: "GATEWAY_PUBLIC_KEY_UNVERIFIED",
        modelInputs: 0,
      });
      return true;
    });
  },
);

test(
  "should check the running gateway without starting Next or requiring a CLI",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const command = await checkCommand(t, false);
    const result = await command.run();
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "CHECKED",
      origin: "http://127.0.0.1:4318",
      modelInputs: 0,
    });
    await assert.rejects(readFile(command.marker), { code: "ENOENT" });
  },
);

test("should resolve matching local public settings without forwarding inherited secrets or remote overrides", async (t) => {
  const f = await fixture(t);
  const env = await f.resolve(f.execute, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    LOCAL_ACCESS_ADMIN_KEY: "private-admin-value",
    LOCAL_ACCESS_DB_URL: "private-database-value",
    ANTHROPIC_API_KEY: "private-provider-value",
    OPENAI_API_KEY: "private-provider-value",
    NODE_OPTIONS: "unsafe-node-options",
    SUPABASE_URL: "https://different-server.example",
    SUPABASE_PUBLISHABLE_KEY: "sb_secret_private-value",
    APP_ORIGIN: "https://different-web.example",
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin:/bin",
    HOME: "/home/operator",
    NODE_ENV: "development",
    NEXT_TELEMETRY_DISABLED: "1",
    SUPABASE_URL: "http://127.0.0.1:56321",
    SUPABASE_PUBLISHABLE_KEY: anon,
    APP_ORIGIN: "http://127.0.0.1:4318",
  });
  assert.equal(f.calls.length, 3);
  assert.equal(f.statusReads, 1);
});

test("should reject missing DB features before reading any gateway key", async (t) => {
  const f = await fixture(t);
  f.features.aiSettings = false;
  await assert.rejects(f.resolve(f.execute), { code: "DATABASE_FEATURES_MISSING" });
  assert.equal(f.calls.length, 2);
});

test("should reject a gateway from another project before reading its key", async (t) => {
  const f = await fixture(t);
  f.gateway.labels["com.supabase.cli.project"] = "another-project";
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_UNVERIFIED" });
  assert.equal(f.calls.length, 3);
});

test("should reject stopped or publicly exposed gateways before reading their key", async (t) => {
  const f = await fixture(t);
  f.gateway.running = false;
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_UNVERIFIED" });
  f.gateway.running = true;
  f.gateway.ports["8000/tcp"][0].HostIp = "0.0.0.0";
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_UNVERIFIED" });
  assert.equal(f.calls.length, 6);
});

test("should reject a gateway with a different canonical workdir before reading its key", async (t) => {
  const f = await fixture(t);
  f.gateway.labels["com.supabase.cli.workdir"] = process.cwd();
  await assert.rejects(f.resolve(f.execute), { code: "GATEWAY_WORKDIR_MISMATCH" });
  assert.equal(f.calls.length, 3);
});

test("should keep the verified workdir when the gateway name changes after inspection", async (t) => {
  const f = await fixture(t);
  const execute = f.execute;
  f.execute = async (args, input) => {
    const raw = await execute(args, input);
    if (args.at(-1) === "supabase_kong_ai-collab-txxcvm61") {
      f.gateway.id = "c".repeat(64);
      f.gateway.labels["com.supabase.cli.workdir"] = process.cwd();
    }
    return raw;
  };
  await f.resolve(f.execute, {});
  assert.equal(f.statusReads, 1);
});

test("should reject malformed or privileged keys without returning their contents", async (t) => {
  const f = await fixture(t);
  const privileged = `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  for (const value of [
    "",
    "private-diagnostic",
    "sb_secret_private-value",
    privileged,
    `SUPABASE_ANON_KEY=${anon}`,
  ]) {
    f.status.ANON_KEY = value;
    await assert.rejects(f.resolve(f.execute), (error: Error & { code?: string }) => {
      assert.equal(error.code, "PUBLIC_KEY_UNVERIFIED");
      assert.equal(error.message, "PUBLIC_KEY_UNVERIFIED");
      return true;
    });
  }
});

test("should resolve injected public status when the gateway has no public key environment variable", async (t) => {
  const f = await fixture(t);
  const env = await f.resolve(f.execute, {});
  assert.equal(env.SUPABASE_PUBLISHABLE_KEY, anon);
  assert.equal(f.statusReads, 1);
  assert.equal(f.calls.length, 3);
});

test("should reject root development environment files without reading their contents", async (t) => {
  const f = await fixture(t);
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    const file = join(f.dir, name);
    await writeFile(file, "LOCAL_ACCESS_ADMIN_KEY=private-admin-value\n", { mode: 0o000 });
    await assert.rejects(f.resolve(f.execute), { code: "ENVIRONMENT_FILES_PRESENT" });
    await rm(file);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.statusReads, 0);
});

test("should reject status for a different API endpoint before returning any configuration", async (t) => {
  const f = await fixture(t);
  for (const url of ["http://127.0.0.1:54321", "https://different-server.example", ""]) {
    f.status.API_URL = url;
    await assert.rejects(f.resolve(f.execute), { code: "LOCAL_STATUS_ENDPOINT_MISMATCH" });
  }
});

test("should mask failed status output instead of exposing private fields", async (t) => {
  const f = await fixture(t);
  f.statusFailure = new Error("private-admin-value private-database-value");
  await assert.rejects(f.resolve(f.execute), (error: Error & { code?: string }) => {
    assert.equal(error.code, "PUBLIC_KEY_UNVERIFIED");
    assert.equal(error.message, "PUBLIC_KEY_UNVERIFIED");
    return true;
  });
});

async function runningGateway(t: TestContext, config: string) {
  const f = await fixture(t);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  process.env.PATH = f.dir;
  const driver = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  const source = {
    config,
    reads: 0,
    failure: null as Error | null,
    afterInspect: undefined as (() => void) | undefined,
  };
  const execute: Execute = async (args, input = "") => {
    if (args[0] === "exec" && args[1] === "b".repeat(64)) {
      assert.deepEqual(args, ["exec", "b".repeat(64), "cat", "/home/kong/kong.yml"]);
      assert.equal(input, "");
      source.reads++;
      if (source.failure) throw source.failure;
      return source.config;
    }
    const raw = await f.execute(args, input);
    if (args[0] === "inspect" && args.at(-1) === "supabase_kong_ai-collab-txxcvm61")
      source.afterInspect?.();
    return raw;
  };
  return {
    ...f,
    source,
    run: (inherited: Record<string, string> = {}) =>
      driver.localWebEnvironment(execute, inherited, undefined, f.dir),
  };
}

test("should resolve the running gateway public key without a CLI or removed project config", async (t) => {
  const f = await runningGateway(t, consumerConfig());
  const environment = await f.run({ LOCAL_ACCESS_ADMIN_KEY: "private-admin-value" });
  assert.equal(environment.SUPABASE_PUBLISHABLE_KEY, anon);
  assert.equal(environment.SUPABASE_URL, "http://127.0.0.1:56321");
  assert.equal(environment.LOCAL_ACCESS_ADMIN_KEY, undefined);
  assert.equal(f.source.reads, 1);
});

test("should select only the unique anon JWT from the rendered gateway transformation config", async (t) => {
  const admin = `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  const f = await runningGateway(
    t,
    transformerConfig([
      `Authorization: $((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) or (headers.apikey == 'sb_secret_private' and 'Bearer ${admin}') or (headers.apikey == 'sb_publishable_public' and 'Bearer ${anon}') or headers.apikey)`,
      `Authorization: Bearer ${anon}`,
    ]),
  );
  const environment = await f.run();
  assert.equal(environment.SUPABASE_PUBLISHABLE_KEY, anon);
  assert.equal(JSON.stringify(environment).includes(admin), false);
  assert.equal(JSON.stringify(environment).includes("sb_secret_private"), false);
});

test("should reject privileged malformed or ambiguous rendered gateway keys without exposing content", async (t) => {
  const admin = `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  const anotherAnon = `e30.${Buffer.from(JSON.stringify({ role: "anon", aud: "different" })).toString("base64url")}.signature`;
  const f = await runningGateway(t, "");
  for (const value of [
    "",
    consumerConfig(["private-admin-value"]),
    consumerConfig([admin]),
    consumerConfig(["e30.invalid.signature"]),
    consumerConfig([anon, anotherAnon]),
  ]) {
    f.source.config = value;
    await assert.rejects(f.run(), (error: Error & { code?: string }) => {
      assert.equal(error.code, "GATEWAY_PUBLIC_KEY_UNVERIFIED");
      assert.equal(JSON.stringify(error).includes("private-admin-value"), false);
      assert.equal(JSON.stringify(error).includes(admin), false);
      return true;
    });
  }
});

test("should reject oversized rendered gateway config before using any of its keys", async (t) => {
  const f = await runningGateway(t, `${"a".repeat(65_536)} ${anon}`);
  await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
});

test("should ignore JWT examples in comments and unrelated rendered fields", async (t) => {
  const example = `e30.${Buffer.from(JSON.stringify({ role: "anon", aud: "example" })).toString("base64url")}.signature`;
  const f = await runningGateway(
    t,
    `# key: ${example}\n_comment: |\n  key: ${example}\n${consumerConfig()}# ${example}\n`,
  );
  const environment = await f.run();
  assert.equal(environment.SUPABASE_PUBLISHABLE_KEY, anon);
  f.source.config = `# key: ${example}\n_comment: ${example}\n`;
  await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
});

test("should preserve a redacted failure when the rendered gateway config cannot be read", async (t) => {
  const f = await runningGateway(t, "");
  f.source.failure = new Error("private-admin-value private-signing-value");
  await assert.rejects(f.run(), (error: Error & { code?: string }) => {
    assert.equal(error.code, "GATEWAY_PUBLIC_KEY_UNAVAILABLE");
    assert.equal(JSON.stringify(error).includes("private-"), false);
    return true;
  });
});

test("should complete ownership and DB checks before reading the running gateway config", async (t) => {
  const f = await runningGateway(t, consumerConfig());
  f.features.aiSettings = false;
  await assert.rejects(f.run(), { code: "DATABASE_FEATURES_MISSING" });
  f.features.aiSettings = true;
  f.gateway.labels["com.supabase.cli.project"] = "different-project";
  await assert.rejects(f.run(), { code: "GATEWAY_UNVERIFIED" });
  assert.equal(f.source.reads, 0);
});

test("should read the verified gateway container ID when its name is replaced after inspection", async (t) => {
  const f = await runningGateway(t, consumerConfig());
  f.source.afterInspect = () => {
    f.gateway.id = "c".repeat(64);
  };
  const environment = await f.run();
  assert.equal(environment.SUPABASE_PUBLISHABLE_KEY, anon);
  assert.equal(f.source.reads, 1);
});

test("should reject JWT examples inside YAML block descriptions", async (t) => {
  const f = await runningGateway(t, `_comment: |\n  key: ${anon}\n`);
  await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
});

test("should ignore unrelated nested credential names outside configured consumers", async (t) => {
  const f = await runningGateway(t, `examples:\n  key: ${anon}\n`);
  await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
});

test("should reject surrounding text in a configured consumer credential", async (t) => {
  const f = await runningGateway(t, "");
  for (const key of [`prefix ${anon}`, `${anon} suffix`, `prefix:${anon}:suffix`]) {
    f.source.config = consumerConfig([key]);
    await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
  }
});

test("should resolve the public key from rendered querystring transformation branches", async (t) => {
  const admin = `e30.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  const f = await runningGateway(
    t,
    transformerConfig(
      [],
      [
        `apikey: $((query_params.apikey == 'sb_secret_private' and '${admin}') or (query_params.apikey == 'sb_publishable_public' and '${anon}') or query_params.apikey)`,
      ],
    ),
  );
  assert.equal((await f.run()).SUPABASE_PUBLISHABLE_KEY, anon);
});

test("should reject surrounding text in header literals and transformation results", async (t) => {
  const f = await runningGateway(t, "");
  for (const header of [
    `Authorization: Bearer prefix:${anon}:suffix`,
    `Authorization: Bearer ${anon} suffix`,
    `Authorization: $((headers.apikey == 'a' and 'Bearer prefix:${anon}:suffix') or (headers.apikey == 'b' and 'Bearer ${anon} suffix') or headers.apikey)`,
    `Authorization: $((headers.apikey == 'a' and 'Bearer ${anon}') or (headers.apikey == 'b' and 'Bearer ${anon}') or headers.apikey)..'suffix'`,
  ]) {
    f.source.config = transformerConfig([header]);
    await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
  }
});

test("should ignore credentials in inactive or unrelated plugins and other consumers", async (t) => {
  const f = await runningGateway(t, "");
  for (const config of [
    consumerConfig().replace("username: anon", "username: another-consumer"),
    transformerConfig([`Authorization: Bearer ${anon}`]).replace("request-transformer", "example"),
    transformerConfig([`Authorization: Bearer ${anon}`]).replace(
      "config:\n",
      "enabled: false\n        config:\n",
    ),
  ]) {
    f.source.config = config;
    await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
  }
});

test("should reject invalid duplicate multi-document or deeply nested YAML without exposing contents", async (t) => {
  const f = await runningGateway(t, "");
  for (const config of [
    `consumers: [private-admin-value`,
    `${consumerConfig()}consumers: []\n`,
    `${consumerConfig()}---\nprivate-signing-value\n`,
    `_comment: ${"[".repeat(30)}private-signing-value${"]".repeat(30)}\n${consumerConfig()}`,
  ]) {
    f.source.config = config;
    await assert.rejects(f.run(), (error: Error & { code?: string }) => {
      assert.equal(error.code, "GATEWAY_PUBLIC_KEY_UNVERIFIED");
      assert.equal(error.message, "GATEWAY_PUBLIC_KEY_UNVERIFIED");
      assert.equal(JSON.stringify(error).includes("private-"), false);
      return true;
    });
  }
});

test("should support flow YAML credentials and replacement authorization headers", async (t) => {
  const f = await runningGateway(t, "");
  for (const config of [
    `consumers: [{username: anon, keyauth_credentials: [{key: ${anon}}]}]`,
    transformerConfig([`Authorization: Bearer ${anon}`])
      .replace("add:\n", "replace:\n")
      .replace("          replace:\n            querystring:\n\n", ""),
  ]) {
    f.source.config = config;
    assert.equal((await f.run()).SUPABASE_PUBLISHABLE_KEY, anon);
  }
});

test("should honor all YAML boolean spellings for enabled transformer credentials", async (t) => {
  const f = await runningGateway(t, "");
  const config = transformerConfig([`Authorization: Bearer ${anon}`]);
  for (const enabled of ["false", "False", "FALSE", "null", "[]", "{}", "unknown"]) {
    f.source.config = config.replace("config:\n", `enabled: ${enabled}\n        config:\n`);
    await assert.rejects(f.run(), { code: "GATEWAY_PUBLIC_KEY_UNVERIFIED" });
  }
  for (const enabled of ["true", "True", "TRUE"]) {
    f.source.config = config.replace("config:\n", `enabled: ${enabled}\n        config:\n`);
    assert.equal((await f.run()).SUPABASE_PUBLISHABLE_KEY, anon);
  }
});

test("should prepare the distribution before starting Next and refuse failed preparation", async () => {
  const { startLocalWeb } = await import(pathToFileURL(resolve("scripts/dev-local-web.mjs")).href);
  const order: string[] = [],
    env = { APP_ORIGIN: "http://127.0.0.1:4318" },
    child = { pid: 123 };
  assert.equal(
    await startLocalWeb(env, {
      build: async () => {
        order.push("build");
      },
      start: (given: unknown) => {
        assert.equal(given, env);
        order.push("start");
        return child;
      },
    }),
    child,
  );
  assert.deepEqual(order, ["build", "start"]);
  await assert.rejects(
    startLocalWeb(env, {
      build: async () => {
        throw Error("build-failed");
      },
      start: () => {
        assert.fail("must not start Next");
      },
    }),
    /build-failed/,
  );
});
