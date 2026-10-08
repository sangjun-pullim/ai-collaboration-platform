import { createHash } from "node:crypto";
import { Client } from "pg";

// Explicit administrative provisioning; this credential never reaches the app.
async function configure() {
  if (process.argv.length !== 3 || process.argv[2] !== "--apply")
    throw new Error("Explicit apply is required");
  const connectionString = process.env.TEAM_ENTRY_DB_URL;
  if (!connectionString) throw new Error("Database configuration is required");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024) throw new Error("Code input is too large");
    chunks.push(chunk);
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const code = raw.replace(/\r?\n$/, "");
  if (!code.length || code.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(code))
    throw new Error("Invalid code input");
  const digest = createHash("sha256").update(code, "utf8").digest("hex");
  const db = new Client({
    connectionString,
    ssl:
      url.hostname === "127.0.0.1" || url.hostname === "localhost"
        ? false
        : { rejectUnauthorized: true },
  });
  try {
    await db.connect();
    await db.query(
      "insert into team_entry_private.configuration(id,verifier) values(1,extensions.crypt($1,extensions.gen_salt('bf',10))) on conflict(id) do update set verifier=excluded.verifier,changed_at=clock_timestamp()",
      [digest],
    );
    process.stdout.write("회사 입장 코드를 설정했습니다. 기존 사용자 접속은 유지됩니다.\n");
  } finally {
    await db.end();
  }
}
configure().catch(() => {
  // Do not forward database errors, URL credentials, code or verifier values.
  process.stderr.write(
    "코드 설정 실패: --apply, DB 설정, 표준 입력과 마이그레이션을 확인하세요.\n",
  );
  process.exitCode = 1;
});
