import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const project = "ai-collab-txxcvm61";
const container = `supabase_db_${project}`;
const host = `unix://${join(homedir(), ".orbstack/run/docker.sock")}`;
const migrations = [
  [
    "20261005001000-owner-local-ai-setup.sql",
    "ae3fd6de59d0cfce80c4bfd01958d544271e60a45146d1f4c1bd78344f100106",
  ],
  [
    "20261006001100-own-ai-input-pause.sql",
    "12a0d8f986d5bf53345fd6b27a7a69ff954b4d8d84ea0166a457ac4a55e54466",
  ],
  [
    "20261006001200-owner-approved-repository-access.sql",
    "fc1c0aee8604cf1ec6516f680ebd60bcefd3415aa4f23e5fb8eba02526276403",
  ],
  [
    "20261006001300-shared-input-source-history.sql",
    "95e4f74d61e94dfe04e4beab31d602dc3d4a4c0c67f64c5f36db09a06d80c584",
  ],
];
const featureSql = `SELECT json_build_object(
  'aiSettings', to_regprocedure('public.runtime_settings_human(text,jsonb)') IS NOT NULL
    AND to_regprocedure('public.runtime_settings_device(text,jsonb,text)') IS NOT NULL,
  'aiPause', to_regprocedure('public.workflow_human_input_control(jsonb)') IS NOT NULL
    AND to_regprocedure('public.workflow_device_admission(jsonb,text)') IS NOT NULL,
  'folderAutoRead', EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='runtime_settings_private' AND p.proname='validate'
      AND p.pronargs=2 AND p.prokind='f' AND position('AUTO_CODE' IN pg_get_functiondef(p.oid))>0),
  'answerSources', to_regprocedure('public.workflow_device_source_support(jsonb,text)') IS NOT NULL
    AND to_regprocedure('public.workflow_device_source_confirm(jsonb,text)') IS NOT NULL
    AND to_regprocedure('public.workflow_human_source_read(jsonb)') IS NOT NULL
);`;
const baselineChecks = {
  requiredFunctions: `to_regprocedure('public.team_entry_admit(text,text)') IS NOT NULL
    AND to_regprocedure('public.team_entry_status()') IS NOT NULL
    AND to_regprocedure('team_entry_private.admitted(uuid)') IS NOT NULL
    AND to_regprocedure('room_access_private.actor()') IS NOT NULL
    AND to_regprocedure('workflow_private.history(uuid,bigint,uuid)') IS NOT NULL
    AND to_regprocedure('workflow_private.history_006(uuid,bigint,uuid)') IS NOT NULL
    AND to_regprocedure('workflow_private.human(text,jsonb)') IS NOT NULL
    AND to_regprocedure('workflow_private.device(text,jsonb,text)') IS NOT NULL`,
  receiptIntegrity: `(SELECT count(*)=3 FROM (VALUES
    ('device_binding_private.workspaces','workspaces_device_id_registration_credential_hash_fkey','registration_credential_hash'),
    ('device_binding_private.agents','agents_device_id_registration_credential_hash_fkey','registration_credential_hash'),
    ('device_binding_private.agents','agents_device_id_replacement_credential_hash_fkey','replacement_credential_hash')
    ) AS expected(table_name,constraint_name,receipt_column)
    JOIN pg_catalog.pg_constraint c
      ON c.conrelid=to_regclass(expected.table_name) AND c.conname=expected.constraint_name
    WHERE c.contype='f' AND c.confrelid=to_regclass('device_binding_private.credentials')
      AND c.confdeltype='a' AND c.confupdtype='a' AND c.confmatchtype='s'
      AND c.convalidated AND c.condeferrable AND c.condeferred
      AND c.conkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname='device_id' AND NOT attisdropped),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.conrelid AND attname=expected.receipt_column AND NOT attisdropped)]
      AND c.confkey=ARRAY[
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='device_id' AND NOT attisdropped),
        (SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=c.confrelid AND attname='hash' AND NOT attisdropped)])`,
  // These prosrc fingerprints are the unchanged SQL008 actor and public wrappers.
  actorPrecondition: `(SELECT count(*)=3 FROM (VALUES
    ('workflow_private.human_actor(text,jsonb)','05c01c19e99c056b4a359f12962b5601'),
    ('public.workflow_human_ask(jsonb)','5254fb014f777aba0c751ded72d65df5'),
    ('public.workflow_human_cancel(jsonb)','efb3c2894e83b06ee213a178d62d27f8')
    ) AS expected(signature,source_hash)
    JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(expected.signature)
    WHERE p.prosecdef AND p.prokind='f' AND md5(p.prosrc)=expected.source_hash
      AND p.proconfig @> ARRAY['search_path=""']::text[])`,
};
const baselineSql = `SELECT json_build_object(${Object.entries(baselineChecks)
  .map(([name, sql]) => `'${name}', (${sql})`)
  .join(",\n")});`;
const baselineReadySql = Object.values(baselineChecks)
  .map((sql) => `(${sql})`)
  .join(" AND\n");
const preconditionSql = `DO $local_settings_guard$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('ai-collab-local-settings-010-013')) THEN
    RAISE EXCEPTION USING MESSAGE='UPGRADE_BUSY', ERRCODE='P0001';
  END IF;
  IF (${baselineReadySql}) IS NOT TRUE THEN
    RAISE EXCEPTION USING MESSAGE='BASELINE_NOT_READY', ERRCODE='P0001';
  END IF;
  IF to_regnamespace('runtime_settings_private') IS NOT NULL
    OR to_regnamespace('own_input_private') IS NOT NULL
    OR to_regnamespace('source_history_private') IS NOT NULL THEN
    RAISE EXCEPTION USING MESSAGE='EXISTING_OR_PARTIAL_UPGRADE', ERRCODE='P0001';
  END IF;
END;
$local_settings_guard$;`;

class UpgradeError extends Error {
  constructor(code, sqlState = null) {
    super(code);
    this.code = code;
    this.sqlState = sqlState;
  }
}

function executeDocker(args, input = "") {
  return new Promise((accept, reject) => {
    const env = Object.fromEntries(
      ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
        process.env[key] ? [[key, process.env[key]]] : [],
      ),
    );
    const child = execFile(
      "docker",
      ["--host", host, ...args],
      { env, timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1_048_576 },
      (error, stdout, stderr) => {
        if (!error) return accept(stdout);
        const state = stderr.match(/ERROR:\s+([0-9A-Z]{5})\b/)?.[1] ?? null;
        reject(new UpgradeError(state ? "SQL_FAILED" : "LOCAL_DOCKER_UNAVAILABLE", state));
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function verifyContainer(execute) {
  let metadata;
  try {
    metadata = JSON.parse(
      await execute([
        "inspect",
        "--format",
        '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}',
        container,
      ]),
    );
  } catch (error) {
    if (error instanceof UpgradeError) throw error;
    throw new UpgradeError("UNVERIFIED_CONTAINER");
  }
  const bindings = Object.values(metadata?.ports ?? {}).flatMap((value) => value ?? []);
  if (
    typeof metadata?.id !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.id) ||
    metadata?.labels?.["com.supabase.cli.project"] !== project ||
    metadata.running !== true ||
    bindings.length !== 1 ||
    bindings[0].HostIp !== "127.0.0.1" ||
    bindings[0].HostPort !== "56322"
  )
    throw new UpgradeError("UNVERIFIED_CONTAINER");
  try {
    const base = await realpath(join(tmpdir(), "ai-collab-implementation-txxcvm61"));
    const workdir = await realpath(metadata.labels["com.supabase.cli.workdir"]);
    const child = relative(base, workdir);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || child.startsWith(sep))
      throw new Error("Unowned workdir");
  } catch {
    throw new UpgradeError("UNVERIFIED_WORKDIR");
  }
  return metadata.id;
}

async function migrationBodies() {
  return Promise.all(
    migrations.map(async ([name, hash], index) => {
      const bytes = await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url));
      if (createHash("sha256").update(bytes).digest("hex") !== hash)
        throw new UpgradeError("MIGRATION_INPUT_CHANGED");
      let sql = bytes.toString("utf8").trim();
      // Only these two reviewed files have their own outer transaction.
      if (index === 0 || index === 3) {
        if (!/^begin;\s/i.test(sql) || !/\scommit;$/i.test(sql))
          throw new UpgradeError("MIGRATION_TRANSACTION_CHANGED");
        sql = sql.replace(/^begin;\s*/i, "").replace(/\s*commit;$/i, "");
      }
      return sql;
    }),
  );
}

function flags(raw, keys = ["aiSettings", "aiPause", "folderAutoRead", "answerSources"]) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UpgradeError("UNVERIFIED_DATABASE_RESPONSE");
  }
  if (
    !value ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== "boolean")
  )
    throw new UpgradeError("UNVERIFIED_DATABASE_RESPONSE");
  return value;
}

/** Only the CLI selects the real Docker dependency; tests use a local protocol fixture. */
export async function runLocalSettingsUpgrade(apply = false, execute = executeDocker) {
  const containerId = await verifyContainer(execute);
  const args = [
    "exec",
    "-i",
    containerId,
    "psql",
    "-X",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-Atq",
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    "VERBOSITY=sqlstate",
  ];
  const inspect = (sql = featureSql) =>
    execute(args, `BEGIN READ ONLY;\nSET LOCAL statement_timeout='5s';\n${sql}\nROLLBACK;`);
  const before = flags(await inspect());
  if (!apply) return { status: "CHECKED", features: before, modelInputs: 0 };
  if (Object.values(before).every(Boolean))
    return { status: "ALREADY_PRESENT", features: before, modelInputs: 0 };
  if (Object.values(before).some(Boolean))
    throw new UpgradeError("PARTIAL_UPGRADE_REQUIRES_INSPECTION");
  const baseline = flags(await inspect(baselineSql), Object.keys(baselineChecks));
  if (!Object.values(baseline).every(Boolean)) throw new UpgradeError("BASELINE_NOT_READY");
  const bodies = await migrationBodies();
  const sql = `BEGIN;\nSET LOCAL lock_timeout='5s';\nSET LOCAL statement_timeout='30s';\n${preconditionSql}\n${bodies.join("\n")}\nNOTIFY pgrst, 'reload schema';\nCOMMIT;`;
  try {
    await execute(args, sql);
  } catch (error) {
    throw new UpgradeError(
      "APPLY_NOT_CONFIRMED",
      error instanceof UpgradeError ? error.sqlState : null,
    );
  }
  let after;
  try {
    after = flags(await inspect());
  } catch {
    throw new UpgradeError("APPLY_NOT_CONFIRMED");
  }
  if (!Object.values(after).every(Boolean)) throw new UpgradeError("APPLY_NOT_CONFIRMED");
  return {
    status: "APPLIED",
    migrations: migrations.map(([name]) => name),
    features: after,
    modelInputs: 0,
  };
}

async function main() {
  if (process.platform !== "darwin" || Number(process.versions.node.split(".")[0]) !== 24)
    throw new UpgradeError("MACOS_NODE24_REQUIRED");
  if (process.argv.slice(2).some((arg) => arg !== "--apply") || process.argv.length > 3)
    throw new UpgradeError("INVALID_ARGUMENTS");
  process.stdout.write(
    `${JSON.stringify(await runLocalSettingsUpgrade(process.argv[2] === "--apply"))}\n`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "BLOCKED", code: error instanceof UpgradeError ? error.code : "PREPARATION_FAILED", sqlState: error instanceof UpgradeError ? error.sqlState : null, modelInputs: 0 })}\n`,
    );
    process.exitCode = 1;
  });
