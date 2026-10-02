import { spawn } from "node:child_process";
const allowed = ["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "NODE_ENV", "NEXT_TELEMETRY_DISABLED", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "APP_ORIGIN"];
const env = Object.fromEntries(allowed.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "4318"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", code => { process.exitCode = code ?? 1; });
child.on("error", () => { process.stderr.write("Access web server failed to start\n"); process.exitCode = 1; });
