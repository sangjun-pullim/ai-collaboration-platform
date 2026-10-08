import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  randomUUID,
  randomBytes,
  timingSafeEqual,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { realpath } from "node:fs/promises";
import { authBrowserChildEnvironment } from "./auth-browser-artifact-policy.js";
const execute = promisify(execFile);
export const OWNED_PROJECT = "ai-collab-txxcvm61";
export type StackConfig = {
  workdir: string;
  project: string;
  api: string;
  db: string;
  mail: string;
  app: string;
  key: string;
  adminKey: string;
};
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function readStackConfig(env: NodeJS.ProcessEnv = process.env): StackConfig {
  const config = {
    workdir: env.LOCAL_ACCESS_STACK_WORKDIR ?? "",
    project: env.LOCAL_ACCESS_PROJECT ?? "",
    api: env.SUPABASE_URL ?? "",
    db: env.LOCAL_ACCESS_DB_URL ?? "",
    mail: env.LOCAL_ACCESS_MAIL_URL ?? "",
    app: env.APP_ORIGIN ?? "",
    key: env.SUPABASE_PUBLISHABLE_KEY ?? "",
    adminKey: env.LOCAL_ACCESS_ADMIN_KEY ?? "",
  };
  assertOwnedConfig(config);
  ensure(config.key && config.adminKey, "Local fixture credentials are required");
  return config;
}
export function assertOwnedConfig(config: StackConfig) {
  ensure(
    config.project === OWNED_PROJECT && config.workdir.startsWith("/"),
    "Refusing an unowned project or workdir",
  );
  for (const [value, port, protocol] of [
    [config.api, "56321", "http:"],
    [config.db, "56322", "postgresql:"],
    [config.mail, "56324", "http:"],
    [config.app, "4318", "http:"],
  ] as const) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Refusing an invalid local endpoint");
    }
    ensure(
      url.hostname === "127.0.0.1" && url.port === port && url.protocol === protocol,
      "Refusing a non-owned loopback endpoint",
    );
    if (protocol === "http:")
      ensure(
        url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password,
        "Refusing an altered local endpoint",
      );
    else
      ensure(
        url.pathname === "/postgres" && !url.search && !url.hash,
        "Refusing an altered fixture database",
      );
  }
}
export async function assertOwnedStack(config: StackConfig) {
  assertOwnedConfig(config);
  let names: string[];
  let expectedWorkdir: string;
  try {
    expectedWorkdir = await realpath(config.workdir);
    const output = (
      await execute(
        "docker",
        [
          "ps",
          "-a",
          "--filter",
          `label=com.supabase.cli.project=${OWNED_PROJECT}`,
          "--format",
          "{{.Names}}",
        ],
        { timeout: 10_000, maxBuffer: 16_384 },
      )
    ).stdout;
    names = output.trim().split("\n").filter(Boolean);
  } catch {
    throw new Error("Owned local stack identity could not be verified");
  }
  ensure(
    names.length === 6 &&
      names.every((name) => name.startsWith("supabase_") && name.endsWith(`_${OWNED_PROJECT}`)),
    "Owned stack must contain exactly its six containers",
  );
  for (const service of ["kong", "db", "inbucket"])
    ensure(
      names.includes(`supabase_${service}_${OWNED_PROJECT}`),
      "Owned stack service is missing",
    );
  const found = new Set<string>();
  for (const name of names) {
    let output: string;
    try {
      output = (
        await execute(
          "docker",
          [
            "inspect",
            "--format",
            '{"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}',
            name,
          ],
          { timeout: 10_000, maxBuffer: 16_384 },
        )
      ).stdout;
    } catch {
      throw new Error("Owned container metadata could not be verified");
    }
    const metadata = JSON.parse(output) as {
      labels: Record<string, string>;
      running: boolean;
      ports: Record<string, { HostIp: string; HostPort: string }[] | null>;
    };
    ensure(
      metadata.labels["com.supabase.cli.project"] === OWNED_PROJECT && metadata.running === true,
      "Owned container project or state does not match",
    );
    let workdir: string;
    try {
      workdir = await realpath(metadata.labels["com.supabase.cli.workdir"]);
    } catch {
      throw new Error("Owned container workdir could not be verified");
    }
    ensure(workdir === expectedWorkdir, "Owned container canonical workdir does not match");
    for (const bindings of Object.values(metadata.ports))
      for (const binding of bindings ?? []) {
        const service =
          binding.HostPort === "56321"
            ? "kong"
            : binding.HostPort === "56322"
              ? "db"
              : binding.HostPort === "56324"
                ? "inbucket"
                : null;
        ensure(
          binding.HostIp === "127.0.0.1" &&
            service &&
            name === `supabase_${service}_${OWNED_PROJECT}` &&
            !found.has(binding.HostPort),
          "Refusing an unexpected external stack binding",
        );
        found.add(binding.HostPort);
      }
  }
  ensure(found.size === 3, "Owned stack loopback bindings are incomplete");
}
export function productEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = [
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SYSTEMROOT",
    "LANG",
    "NODE_ENV",
    "NEXT_TELEMETRY_DISABLED",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "APP_ORIGIN",
  ];
  return Object.fromEntries(
    keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
  );
}
export type Envelope =
  { ok: true; data: Record<string, string | boolean> } | { ok: false; error: { code: string } };
export class WebSession {
  readonly jar = new Map<string, string>();
  constructor(readonly config: StackConfig) {}
  cookieHeader() {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  absorb(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (!value || /max-age=0(?:;|$)/i.test(cookie)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Cookie", this.cookieHeader());
    const response = await fetch(`${this.config.app}${path}`, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.absorb(response);
    return response;
  }
  post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.request(path, {
      method: "POST",
      headers: { Origin: this.config.app, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
  async mutate(
    action: string,
    body: unknown,
    expected = 200,
  ): Promise<Record<string, string | boolean>> {
    const response = await this.post(`/api/access/${action}`, body);
    ensure(response.status === expected, "Unexpected mutation HTTP status");
    const result = (await response.json()) as Envelope;
    ensure(result.ok, "Expected a successful mutation envelope");
    return result.data;
  }
  sessionData(): Record<string, unknown> {
    const base = `sb-${new URL(this.config.api).hostname.split(".")[0]}-auth-token`;
    const whole =
      this.jar.get(base) ??
      [...this.jar]
        .filter(([name]) => name.startsWith(`${base}.`))
        .sort(([a], [b]) => Number(a.slice(base.length + 1)) - Number(b.slice(base.length + 1)))
        .map(([, value]) => value)
        .join("");
    const encoded = decodeURIComponent(whole);
    ensure(encoded.startsWith("base64-"), "Expected an SSR session cookie");
    return JSON.parse(Buffer.from(encoded.slice(7), "base64url").toString("utf8"));
  }
  replaceSession(data: Record<string, unknown>) {
    const base = `sb-${new URL(this.config.api).hostname.split(".")[0]}-auth-token`;
    for (const name of this.jar.keys())
      if (name === base || name.startsWith(`${base}.`)) this.jar.delete(name);
    const value = "base64-" + Buffer.from(JSON.stringify(data)).toString("base64url");
    const chunks = value.match(/.{1,3000}/g)!;
    chunks.forEach((chunk, index) =>
      this.jar.set(chunks.length === 1 ? base : `${base}.${index}`, encodeURIComponent(chunk)),
    );
  }
  expireSignedSession() {
    const raw = process.env.LOCAL_ACCESS_SIGNING_JWK;
    ensure(raw, "Owned test ES256 signing fixture is required");
    const data = this.sessionData();
    const parts = String(data.access_token).split(".");
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    const jwk = JSON.parse(raw);
    ensure(
      header.alg === "ES256" && header.kid === jwk.kid && jwk.kty === "EC" && jwk.crv === "P-256",
      "Expired JWT fixture must match the actual Auth signer",
    );
    const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
    const publicKey = createPublicKey(privateKey);
    ensure(
      verify(
        "sha256",
        Buffer.from(parts[0] + "." + parts[1]),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(parts[2], "base64url"),
      ),
      "Original Auth JWT signature must verify before expiry adjustment",
    );
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    ensure(
      typeof payload.iss === "string" && payload.exp > Date.now() / 1000,
      "Expiry fixture must start from a current actual Auth session",
    );
    payload.exp = Math.floor(Date.now() / 1000) - 60;
    const input = parts[0] + "." + Buffer.from(JSON.stringify(payload)).toString("base64url");
    data.access_token =
      input +
      "." +
      sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      );
    data.expires_at = payload.exp;
    this.replaceSession(data);
  }
  dataClient(): SupabaseClient {
    const session = this.sessionData();
    ensure(typeof session.access_token === "string", "Expected an Auth access session");
    return createClient(this.config.api, this.config.key, {
      global: { headers: { Authorization: `Bearer ${session.access_token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
}
export type FixturePerson = { id: string; email: string; web: WebSession };
export class LocalAccessStack {
  readonly users = new Set<string>();
  readonly organizations = new Set<string>();
  readonly organizationOwners = new Map<string, string>();
  onOwnedIdentity?: () => Promise<void>;
  readonly inboxes = new Set<string>();
  readonly namespace: string;
  readonly db: Client;
  readonly admin: SupabaseClient;
  private constructor(
    readonly config: StackConfig,
    label: string,
  ) {
    this.namespace = `access-${label.replace(/[^a-z0-9]/gi, "").slice(0, 24)}-${randomUUID()}`;
    this.db = new Client({ connectionString: config.db, ssl: false, statement_timeout: 15_000 });
    this.admin = createClient(config.api, config.adminKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  static async open(label: string, config = readStackConfig()) {
    await assertOwnedStack(config);
    const fixture = new LocalAccessStack(config, label);
    try {
      await fixture.db.connect();
    } catch {
      throw new Error("Owned fixture database connection failed");
    }
    return fixture;
  }
  async firstTimeSignup(label: string): Promise<FixturePerson> {
    await assertOwnedStack(this.config);
    const email = `${this.namespace}-${label}-${randomUUID()}@example.test`;
    this.inboxes.add(email);
    const web = new WebSession(this.config);
    await this.requestCode(email);
    // Record only the exact newly requested synthetic account before verification.
    const created = await this.db.query("select id,created_at from auth.users where email=$1", [
      email,
    ]);
    ensure(created.rowCount === 1, "First email request must create its own synthetic signup");
    const id = created.rows[0].id as string;
    this.users.add(id);
    await this.onOwnedIdentity?.();
    const response = await web.post("/api/auth/verify", { email, code: await this.code(email) });
    ensure(response.status === 200, "First-time OTP signup must verify");
    const verified = await web.dataClient().auth.getUser(web.sessionData().access_token as string);
    ensure(
      !verified.error && verified.data.user?.id === id,
      "New signup must have a verified actual Auth identity",
    );
    return { id, email, web };
  }
  async person(label: string, login = true): Promise<FixturePerson> {
    await assertOwnedStack(this.config);
    const email = `${this.namespace}-${label}-${randomUUID()}@example.test`;
    this.inboxes.add(email);
    const { data, error } = await this.admin.auth.admin.createUser({ email, email_confirm: true });
    ensure(!error && data.user, "Could not create an owned synthetic account");
    this.users.add(data.user.id);
    await this.onOwnedIdentity?.();
    const person = { id: data.user.id, email, web: new WebSession(this.config) };
    if (login) await this.signIn(person);
    return person;
  }
  async requestCode(email: string) {
    ensure(this.inboxes.has(email), "Refusing an unowned inbox");
    const response = await new WebSession(this.config).post("/api/auth/code", { email });
    ensure(response.status === 200, "Synthetic email code request failed");
  }
  async code(email: string, previous?: string): Promise<string> {
    ensure(this.inboxes.has(email), "Refusing an unowned inbox");
    for (let attempt = 0; attempt < 80; attempt++) {
      const search = await fetch(
        `${this.config.mail}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
      );
      ensure(search.ok, "Owned mailbox query failed");
      const list = (await search.json()) as {
        messages?: { ID: string; To: { Address: string }[]; Created: string }[];
      };
      const messages = (list.messages ?? [])
        .filter((m) => m.To.some((to) => to.Address === email))
        .sort((a, b) => b.Created.localeCompare(a.Created));
      if (messages.length) {
        const response = await fetch(
          `${this.config.mail}/api/v1/message/${encodeURIComponent(messages[0].ID)}`,
        );
        const detail = (await response.json()) as { Text?: string; HTML?: string };
        const text = `${detail.Text ?? ""} ${detail.HTML ?? ""}`;
        const match = text.match(/\b(\d{6})\b/);
        ensure(
          text.includes("조사실 로그인 코드") && match,
          "Owned Auth template does not contain the expected OTP",
        );
        if (match[1] !== previous) return match[1];
      }
      await delay(100);
    }
    throw new Error("Owned synthetic OTP did not arrive");
  }
  async signIn(person: FixturePerson) {
    await this.requestCode(person.email);
    const response = await person.web.post("/api/auth/verify", {
      email: person.email,
      code: await this.code(person.email),
    });
    ensure(response.status === 200 && person.web.jar.size > 0, "Real email code login failed");
    const data = person.web.sessionData();
    ensure(
      typeof data.access_token === "string" && typeof data.refresh_token === "string",
      "Real Auth session was not issued",
    );
    const verified = await person.web.dataClient().auth.getUser(data.access_token as string);
    ensure(
      !verified.error && verified.data.user?.id === person.id,
      "Local Auth identity did not match the owned account",
    );
  }
  async trackOrganization(id: string) {
    const result = await this.db.query(
      "select owner_user_id from public.organizations where id=$1",
      [id],
    );
    ensure(
      result.rowCount === 1 && this.users.has(result.rows[0].owner_user_id),
      "Refusing an unowned organization",
    );
    this.organizations.add(id);
    this.organizationOwners.set(id, result.rows[0].owner_user_id as string);
    await this.onOwnedIdentity?.();
  }
  async bootstrap(person: FixturePerson) {
    const data = await person.web.mutate("bootstrap", {
      groupName: "합성 검사 그룹",
      title: "초대된 조사방",
      goal: "권한 검사",
      observation: "합성 관찰",
      environment: "격리 검사",
      displayAlias: "소유자",
    });
    const organizationId = data.organizationId as string;
    const roomId = data.roomId as string;
    await this.trackOrganization(organizationId);
    return { organizationId, roomId };
  }
  async invite(person: FixturePerson, roomId: string, role = "participant") {
    const data = await person.web.mutate("invite", { roomId, role });
    return data.code as string;
  }
  async join(person: FixturePerson, code: string, displayAlias = "합성 멤버") {
    return person.web.mutate("join", { code, displayAlias });
  }
  async expireCode(person: FixturePerson) {
    ensure(this.users.has(person.id), "Refusing an unowned token fixture");
    await assertOwnedStack(this.config);
    // GoTrue uses confirmation or recovery timestamps for signup or magic-link OTP.
    const before = await this.db.query(
      "select confirmation_sent_at,recovery_sent_at from auth.users where id=$1",
      [person.id],
    );
    ensure(before.rowCount === 1, "Owned token timestamp fixture is missing");
    await this.db.query(
      "update auth.users set confirmation_sent_at=now()-interval '2 hours',recovery_sent_at=now()-interval '2 hours' where id=$1",
      [person.id],
    );
    return async () => {
      ensure(this.users.has(person.id), "Refusing an unowned timestamp restoration");
      await assertOwnedStack(this.config);
      await this.db.query(
        "update auth.users set confirmation_sent_at=$2,recovery_sent_at=$3 where id=$1",
        [person.id, before.rows[0].confirmation_sent_at, before.rows[0].recovery_sent_at],
      );
    };
  }
  async deleteAccount(person: FixturePerson) {
    ensure(this.users.has(person.id), "Refusing an unowned account deletion");
    await assertOwnedStack(this.config);
    const { error } = await this.admin.auth.admin.deleteUser(person.id);
    ensure(!error, "Owned account deletion failed");
    this.users.delete(person.id);
    await this.onOwnedIdentity?.();
  }
  async disable(person: FixturePerson) {
    ensure(this.users.has(person.id), "Refusing an unowned account mutation");
    await assertOwnedStack(this.config);
    const { error } = await this.admin.auth.admin.updateUserById(person.id, {
      ban_duration: "24h",
    });
    ensure(!error, "Could not disable the owned fixture account");
  }
  async softDeleteAccount(person: FixturePerson) {
    ensure(this.users.has(person.id), "Refusing an unowned account soft deletion");
    await assertOwnedStack(this.config);
    const { error } = await this.admin.auth.admin.deleteUser(person.id, true);
    ensure(!error, "Owned account soft deletion failed");
    // Retain the exact owned ID so close physically deletes the remaining Auth row.
  }
  async close() {
    try {
      await assertOwnedStack(this.config);
      for (const id of this.organizations) {
        await this.db.query(
          "delete from public.organizations where id=$1 and owner_user_id=any($2::uuid[])",
          [id, [...this.users]],
        );
      }
      for (const id of this.users) {
        const { error } = await this.admin.auth.admin.deleteUser(id);
        ensure(!error, "Owned account cleanup failed");
      }
      // Mail deletion is scoped to exact synthetic inbox message IDs.
      for (const email of this.inboxes) {
        const response = await fetch(
          `${this.config.mail}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
        );
        const list = (await response.json()) as {
          messages?: { ID: string; To: { Address: string }[] }[];
        };
        const ids = (list.messages ?? [])
          .filter((message) => message.To.some((to) => to.Address === email))
          .map((message) => message.ID);
        if (ids.length)
          await fetch(`${this.config.mail}/api/v1/messages`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ IDs: ids }),
          });
      }
    } finally {
      await this.db.end();
    }
  }
}
// The parent owns admin/DB credentials; Playwright and Next receive only scoped env.
async function runBrowserParent() {
  const fixture = await LocalAccessStack.open("browser-parent");
  const secret = randomBytes(32).toString("hex");
  const people = new Map<string, FixturePerson>();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store");
    const supplied = request.headers.authorization?.slice(7) ?? "";
    if (
      Buffer.byteLength(supplied) !== Buffer.byteLength(secret) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))
    ) {
      response.writeHead(403).end();
      return;
    }
    try {
      let body = "";
      for await (const part of request) {
        body += part.toString();
        ensure(body.length <= 4096, "Fixture request too large");
      }
      const input = JSON.parse(body);
      let data: unknown;
      if (request.url === "/person") {
        const person = await fixture.person(String(input.label), false);
        people.set(person.id, person);
        data = { id: person.id, email: person.email };
      } else if (request.url === "/code") {
        const person = people.get(input.id);
        ensure(person, "Unknown fixture identity");
        data = { code: await fixture.code(person.email) };
      } else if (request.url === "/track") {
        await fixture.trackOrganization(input.organizationId);
        data = {};
      } else throw new Error("Unknown fixture action");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(data));
    } catch {
      response.writeHead(500).end('{"error":"Fixture action failed"}');
    }
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const env = {
      ...productEnvironment(),
      LOCAL_ACCESS_FIXTURE_URL: `http://127.0.0.1:${port}`,
      LOCAL_ACCESS_FIXTURE_TOKEN: secret,
      ...authBrowserChildEnvironment,
    };
    const child = spawn(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.auth.config.ts"],
      { env, stdio: "inherit" },
    );
    const code = await new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
    process.exitCode = code;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fixture.close();
  }
}
if (process.argv.includes("--e2e-runner")) {
  runBrowserParent().catch(() => {
    process.stderr.write("Owned Auth browser setup failed\n");
    process.exitCode = 1;
  });
}

if (process.argv.includes("--device-e2e-runner")) {
  import("./device-binding-fixture.js")
    .then((module) => module.runDeviceBrowserParent())
    .catch(() => {
      process.stderr.write("Owned device browser setup failed\n");
      process.exitCode = 1;
    });
}
