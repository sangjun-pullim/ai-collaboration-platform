#!/bin/bash
# The verified launcher also clears these before creating this shell.
set -euo pipefail
builtin unset BASH_ENV ENV NODE_OPTIONS NODE_PATH PERL5OPT PERL5DB PERL5LIB PERLLIB PERLIO PERL_USE_UNSAFE_INC LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
umask 077

ticket=""
attempt=""
sequence=0
report_startup() {
  [ -n "$ticket" ] && [ -n "$attempt" ] || return 0
  sequence=$((sequence + 1))
  /usr/bin/curl --disable --silent --fail --proto '=http,https' --max-redirs 0 --connect-timeout 1 --max-time 2 --max-filesize 16384 \
    --request POST --header 'Content-Type: application/json' --header "Authorization: Bearer $ticket" \
    --data "{\"attemptId\":\"$attempt\",\"sequence\":$sequence,\"stage\":\"$1\",\"reason\":$2}" \
    --output /dev/null "$origin/api/connection-setup/startup-report" 2>/dev/null || true
}
fail() {
  /usr/bin/printf '%s\n' "로컬 연결을 시작하지 못했습니다: $1" "Mac의 터미널에서 운영체제·다운로드·연결 상태를 확인한 뒤 같은 연결로 재개하세요." >&2
  case "$1" in
    FORBIDDEN|CONFLICT|MACOS_REQUIRED|MACOS_13_5_REQUIRED|UNSUPPORTED_ARCHITECTURE|DOWNLOAD_FAILED|DOWNLOAD_DIGEST|INVALID_MANIFEST|INVALID_ARCHIVE|INVALID_DESCRIPTION|RUNTIME_VERSION|RUNTIME_ARCHIVE|RUNTIME_FILE|REDIRECT_OR_HTTP_ERROR|DOWNLOAD_SIZE|MACOS_VERSION) reason=$1 ;;
    *) reason=UNCONFIRMED ;;
  esac
  report_startup FAILED "\"$reason\""
  exit 1
}
[ "$#" -eq 4 ] || [ "$#" -eq 5 ] || [ "$#" -eq 7 ] || [ "$#" -eq 8 ] || fail INVALID_ARGUMENTS
origin=$1
[[ "$origin" =~ ^https://[^/?\#@[:space:]]+$ || "$origin" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]] || fail UNSAFE_ORIGIN
if [ "$#" -eq 4 ]; then
  [ "$2" = --setup-ticket ] || fail INVALID_ARGUMENTS
  [[ "$3" =~ ^[a-f0-9]{64}$ && "$4" =~ ^[a-f0-9]{64}$ ]] || fail INVALID_ARGUMENTS
  ticket=$3
  description_sha=$4
  attempt=$(/usr/bin/uuidgen | /usr/bin/tr 'A-F' 'a-f')
  report_startup PREPARING null
  set --
else
profile=$2
device_alias=$3
organization=$4
room=$5
[[ "$profile" =~ ^web-[a-f0-9]{32}$ ]] || fail INVALID_PROFILE
if [ "$#" -ge 7 ]; then
  previous_profile=$6
  recovery_id=$7
  [[ "$previous_profile" =~ ^web-[a-f0-9]{32}$ ]] || fail INVALID_PREVIOUS_PROFILE
  [[ "$recovery_id" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]] || fail INVALID_RECOVERY_ID
  [ "$previous_profile" != "$profile" ] || fail INVALID_PROFILE_RELATION
  expected=$(/usr/bin/printf '["connection-recovery","%s","%s"]' "$previous_profile" "$recovery_id" | /usr/bin/shasum -a 256)
  expected=${expected%% *}
  [ "$profile" = "web-${expected:0:32}" ] || fail INVALID_PROFILE_RELATION
  if [ "$#" -eq 8 ]; then
    recovery_chain=$8
    [ "${#recovery_chain}" -le 16384 ] || fail INVALID_RECOVERY_CHAIN
    set -- --previous-profile "$previous_profile" --recovery-id "$recovery_id" --recovery-chain "$recovery_chain"
  else
    set -- --previous-profile "$previous_profile" --recovery-id "$recovery_id"
  fi
else
  set --
fi
fi
[ "$(/usr/bin/uname -s)" = Darwin ] || fail MACOS_REQUIRED
os=$(/usr/bin/sw_vers -productVersion)
[[ "$os" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || fail MACOS_VERSION
IFS=. read -r major minor patch <<< "$os"
(( major > 13 || (major == 13 && minor >= 5) )) || fail MACOS_13_5_REQUIRED
case "$(/usr/bin/uname -m)" in
  arm64) arch=arm64; node_sha=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
  x86_64) arch=x64; node_sha=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
  *) fail UNSUPPORTED_ARCHITECTURE ;;
esac
work=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/ai-collab-connect.XXXXXXXX")
work=$(cd "$work" && builtin pwd -P)
child=""
started=0
verified=0
cleanup() {
  if [ "$started" -eq 0 ] || [ "$verified" -eq 1 ]; then
    /bin/rm -rf "$work"
  else
    /usr/bin/printf '%s\n' "종료 확인이 불완전해 임시 실행 파일을 보존했습니다: $work" >&2
  fi
}
trap cleanup EXIT
download() {
  local url=$1 destination=$2 maximum=$3 status bytes
  status=$(ulimit -f "$(( (maximum + 1023) / 1024 ))"; /usr/bin/curl --disable --fail --silent --show-error --proto '=http,https' --max-redirs 0 --connect-timeout 10 --max-time 120 --max-filesize "$maximum" --write-out '%{http_code}' --output "$destination" "$url") || fail DOWNLOAD_FAILED
  [ "$status" = 200 ] || fail REDIRECT_OR_HTTP_ERROR
  bytes=$(/usr/bin/wc -c < "$destination")
  [ "$bytes" -le "$maximum" ] || fail DOWNLOAD_SIZE
}
verify() {
  local digest
  digest=$(/usr/bin/shasum -a 256 "$1")
  [ "${digest%% *}" = "$2" ] || fail DOWNLOAD_DIGEST
}

node=$(builtin type -P node || true)
version=""
if [ -n "$node" ]; then version=$("$node" --version 2>/dev/null || true); fi
if [[ ! "$version" =~ ^v24\.[0-9]+\.[0-9]+$ ]]; then
  report_startup DOWNLOADING null
  /usr/bin/printf '%s\n' "Node 실행 프로그램을 준비하고 있습니다."
  node_package="node-v24.21.0-darwin-$arch"
  download "https://nodejs.org/download/release/v24.21.0/$node_package.tar.gz" "$work/node.tar.gz" 157286400
  verify "$work/node.tar.gz" "$node_sha"
  /usr/bin/tar -xzf "$work/node.tar.gz" -C "$work" -- "$node_package/bin/node" "$node_package/LICENSE" || fail RUNTIME_ARCHIVE
  node="$work/$node_package/bin/node"
  [ -f "$node" ] && [ ! -L "$node" ] && [ -x "$node" ] || fail RUNTIME_FILE
  [ "$("$node" --version)" = v24.21.0 ] || fail RUNTIME_VERSION
  export PATH="$work/$node_package/bin:$PATH"
fi

# Only verified Node and builtin modules interpret download metadata and ustar entries.
node_tool() {
  "$node" --input-type=commonjs - "$@" <<'NODE'
try {
  const fs = require("node:fs");
  const path = require("node:path");
  const zlib = require("node:zlib");
  const [mode, input, output] = process.argv.slice(2);
  const exact = (value, keys) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((k) => Object.hasOwn(value, k));
  if (mode === "description") {
    const crypto = require("node:crypto");
    const bytes = fs.readFileSync(input);
    if (bytes.length > 16384) throw Error("DESCRIPTION_SIZE");
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!exact(envelope, ["ok", "data"]) || envelope.ok !== true ||
        !exact(envelope.data, ["payload", "payloadHash", "expiresAt"])) throw Error("DESCRIPTION_ENVELOPE");
    const { payload, payloadHash, expiresAt } = envelope.data;
    if (typeof payload !== "string" || Buffer.byteLength(payload) > 16384 ||
        payloadHash !== process.argv[5] || crypto.createHash("sha256").update(payload).digest("hex") !== payloadHash ||
        !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw Error("DESCRIPTION_HASH");
    const b = JSON.parse(payload);
    const id = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
    const hash = parts => "web-" + crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0,32);
    if (!exact(b, ["version", "origin", "ownerUserId", "organizationId", "roomId", "deviceAlias", "selection"]) || b.version !== 1 ||
        b.origin !== process.argv[6] || !id(b.ownerUserId) || !id(b.organizationId) || !id(b.roomId) ||
        typeof b.deviceAlias !== "string" || !/^[\p{L}\p{N} ._-]{1,40}$/u.test(b.deviceAlias) || b.deviceAlias.trim() !== b.deviceAlias || b.deviceAlias.startsWith(".") || b.deviceAlias.includes("..") || /^[a-f0-9-]{36}$/i.test(b.deviceAlias) || /^[A-Za-z0-9_-]{24,}$/.test(b.deviceAlias)) throw Error("DESCRIPTION_SCOPE");
    const s = b.selection;
    if (!exact(s, ["version", "baseProfile", "chain"]) || s.version !== 1 || s.baseProfile !== hash([b.origin,b.ownerUserId,b.roomId]) ||
        !Array.isArray(s.chain) || s.chain.length > 32) throw Error("DESCRIPTION_CHAIN");
    let previous = s.baseProfile;
    for (const g of s.chain) {
      if (!exact(g,["previousProfile","recoveryId","profile"]) || g.previousProfile !== previous ||
          typeof g.recoveryId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(g.recoveryId) ||
          g.profile !== hash(["connection-recovery",previous,g.recoveryId]) || g.profile === previous) throw Error("DESCRIPTION_CHAIN");
      previous = g.profile;
    }
    const g = s.chain.at(-1);
    const args = [previous,b.deviceAlias,b.organizationId,b.roomId,
      ...(g ? ["--previous-profile",g.previousProfile,"--recovery-id",g.recoveryId,"--recovery-chain",JSON.stringify(s)] : [])];
    fs.writeFileSync(output,args.join("\n")+"\n",{flag:"wx",mode:0o600});
  } else if (mode === "manifest") {
    const bytes = fs.readFileSync(input);
    if (bytes.length > 4096) throw Error("MANIFEST_SIZE");
    const m = JSON.parse(bytes.toString("utf8"));
    if (!exact(m, ["version", "code", "bootstrap"]) || m.version !== 1)
      throw Error("MANIFEST_VERSION");
    for (const [kind, prefix, extension, maximum] of [
      ["code", "connector", ".tar.gz", 16777216],
      ["bootstrap", "bootstrap", ".sh", 131072],
    ]) {
      const a = m[kind];
      if (
        !exact(a, ["path", "sha256", "bytes"]) ||
        !/^[a-f0-9]{64}$/.test(a.sha256) ||
        !Number.isSafeInteger(a.bytes) ||
        a.bytes < 1 ||
        a.bytes > maximum ||
        a.path !== `/local-connection/${prefix}-${a.sha256}${extension}`
      )
        throw Error("MANIFEST_ASSET");
    }
    fs.writeFileSync(output, `${m.code.path}\n${m.code.sha256}\n${m.code.bytes}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } else if (mode === "extract") {
    const tar = zlib.gunzipSync(fs.readFileSync(input), { maxOutputLength: 71303168 });
    const entries = [];
    const names = new Set();
    let offset = 0,
      total = 0;
    while (
      offset + 512 <= tar.length &&
      tar.subarray(offset, offset + 512).some((byte) => byte !== 0)
    ) {
      const h = tar.subarray(offset, offset + 512);
      const field = (start, length) =>
        h
          .subarray(start, start + length)
          .toString("ascii")
          .replace(/\0.*$/s, "")
          .trim();
      const octal = (start, length) => {
        const text = field(start, length);
        if (!/^[0-7]+$/.test(text)) throw Error("ARCHIVE_NUMBER");
        return parseInt(text, 8);
      };
      const name = field(0, 100);
      const checksum = h.reduce(
        (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
        0,
      );
      if (
        checksum !== octal(148, 8) ||
        field(257, 6) !== "ustar" ||
        field(345, 155) !== "" ||
        h[156] !== 48 ||
        field(157, 100) !== "" ||
        !(name === "package.json" || /^src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/.test(name)) ||
        names.has(name)
      )
        throw Error("ARCHIVE_ENTRY");
      const length = octal(124, 12);
      total += length;
      if (total > 67108864 || entries.length >= 4096 || offset + 512 + length > tar.length)
        throw Error("ARCHIVE_SIZE");
      names.add(name);
      entries.push([name, tar.subarray(offset + 512, offset + 512 + length)]);
      offset += 512 + Math.ceil(length / 512) * 512;
    }
    if (
      !names.has("src/cli.js") ||
      !names.has("package.json") ||
      tar.length - offset < 1024 ||
      tar.subarray(offset).some((byte) => byte !== 0)
    )
      throw Error("ARCHIVE_INCOMPLETE");
    fs.mkdirSync(output, { mode: 0o700 });
    for (const [name, content] of entries) {
      const target = path.join(output, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
    }
  } else if (mode === "shutdown") {
    const info = fs.lstatSync(input);
    if (!info.isFile() || info.isSymbolicLink() || fs.readFileSync(input, "utf8") !== "VERIFIED\n")
      process.exit(1);
  } else process.exit(1);
} catch {
  process.stderr.write("DOWNLOAD_VALIDATION_FAILED\n");
  process.exitCode = 1;
}

NODE
}

if [ -n "$ticket" ]; then
  status=$(ulimit -f 16; /usr/bin/curl --disable --silent --show-error --proto '=http,https' --max-redirs 0 --connect-timeout 10 --max-time 30 --max-filesize 16384 \
    --request POST --header 'Content-Type: application/json' --header "Authorization: Bearer $ticket" --data '{}' \
    --write-out '%{http_code}' --output "$work/description.json" "$origin/api/connection-setup/resolve") || fail INVALID_DESCRIPTION
  case "$status" in
    403) fail FORBIDDEN ;;
    409) fail CONFLICT ;;
    200) ;;
    *) fail INVALID_DESCRIPTION ;;
  esac
  node_tool description "$work/description.json" "$work/description.args" "$description_sha" "$origin" || fail INVALID_DESCRIPTION
  description_args=()
  while IFS= read -r argument; do description_args+=("$argument"); done < "$work/description.args"
  [ "${#description_args[@]}" -ge 4 ] || fail INVALID_DESCRIPTION
  profile=${description_args[0]}
  device_alias=${description_args[1]}
  organization=${description_args[2]}
  room=${description_args[3]}
  set -- "${description_args[@]:4}"
fi
report_startup DOWNLOADING null
download "$origin/local-connection/manifest.json" "$work/manifest.json" 4096
node_tool manifest "$work/manifest.json" "$work/code.metadata" || fail INVALID_MANIFEST
{ read -r code_path; read -r code_sha; read -r code_bytes; } < "$work/code.metadata"
download "$origin$code_path" "$work/connector.tar.gz" 16777216
[ "$(/usr/bin/wc -c < "$work/connector.tar.gz")" -eq "$code_bytes" ] || fail DOWNLOAD_SIZE
verify "$work/connector.tar.gz" "$code_sha"
node_tool extract "$work/connector.tar.gz" "$work/code" || fail INVALID_ARCHIVE
forward() { if [ -n "$child" ]; then /bin/kill "-$1" "$child" 2>/dev/null || true; fi; }
wait_interrupted=0
stop_requested=0
interrupt() { wait_interrupted=1; stop_requested=1; forward "$1"; }
trap 'interrupt INT' INT
trap 'interrupt TERM' TERM
report_startup CONNECTING null
started=1
"$node" --input-type=module -e '
import {writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";
import {pathToFileURL} from "node:url";
// Keep argv[1] separate from the imported CLI entry so its direct-run guard stays idle.
const [, entry, proof, origin, ticket, attempt, initialSequence, codeSha256, ...args] = process.argv.slice(1);
let hint;
try {
  const module = await import(pathToFileURL(entry).href);
  hint = module.connectionFailureHint;
  const {main} = module;
  await main(args);
  // Main has completed every owned cleanup. A forwarded duplicate signal must
  // not kill this process while its final shutdown proof is being written.
  const completed = () => {};
  process.on("SIGINT", completed);
  process.on("SIGTERM", completed);
  await writeFile(proof, "VERIFIED\n", {flag:"wx",mode:0o600});
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : "UNAVAILABLE";
  process.stderr.write(JSON.stringify({state:"disconnected",error:code}) + "\n");
  try {
    // Persist only bounded code locations, never the raw error, arguments or local data.
    const base = pathToFileURL(entry).href.slice(0, -"src/cli.js".length);
    const frames = [];
    for (const line of String(error?.stack ?? "").slice(0, 16384).split("\n")) {
      const index = line.indexOf(base);
      if (index < 0) continue;
      const match = /^(src\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js):(\d{1,9}):(\d{1,9})\)?$/.exec(line.slice(index + base.length).trim());
      if (match) frames.push({file:match[1],line:Number(match[2]),column:Number(match[3])});
      if (frames.length === 8) break;
    }
    const diagnostic = join(dirname(proof), "connection-diagnostic.json");
    await writeFile(diagnostic, JSON.stringify({version:1,failedAt:new Date().toISOString(),pid:process.pid,
      nodeVersion:process.version,codeSha256,error:code,frames}) + "\n", {flag:"wx",mode:0o600});
    process.stdout.write("연결 실패 진단 파일: " + diagnostic + "\n");
  } catch {
    process.stderr.write("연결 실패 진단 파일을 저장하지 못했습니다. 위 오류 코드와 보존된 실행 폴더를 확인하세요.\n");
  }
  if (ticket) {
    const reasons = new Set(["FORBIDDEN","CONFLICT","RUNTIME_BUSY","SNAPSHOT_CHANGED","POLICY_UNCONFIRMED","CONTEXT_UNCONFIRMED","CLEANUP_INCOMPLETE","UNAUTHENTICATED","UNAVAILABLE","PROVIDER_UNAVAILABLE"]);
    try { await fetch(origin+"/api/connection-setup/startup-report", {method:"POST",redirect:"error",signal:AbortSignal.timeout(2000),
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+ticket},
      body:JSON.stringify({attemptId:attempt,sequence:Number(initialSequence)+1,stage:"FAILED",reason:reasons.has(code)?code:"UNCONFIRMED"})}); } catch {}
  }
  process.stdout.write((typeof hint === "function" ? hint(error) : "내 AI 연결에서 이전 연결 취소 여부와 연결 명령을 확인하세요.") + "\n");
  process.exitCode = 1;
}' ai-collab-bootstrap "$work/code/src/cli.js" "$work/shutdown" "$origin" "$ticket" "$attempt" "$sequence" "$code_sha" connect --server "$origin" --profile "$profile" --device-alias "$device_alias" --organization-id "$organization" --room-id "$room" "$@" <&0 &
child=$!
set +e
while true; do
  wait_interrupted=0
  wait "$child"
  result=$?
  # A trap interrupts wait before it reports the child's actual exit, even if the
  # child has finished by the time the trap returns. Reap that status explicitly.
  [ "$wait_interrupted" -eq 1 ] || break
done
set -e
# A terminal interrupt can leave Bash reporting the signal status after main has
# finished its verified cleanup. Normalize only an owned, fully exited child
# with that exact proof; errors or an unconfirmed shutdown remain failures.
if [ "$stop_requested" -eq 1 ] && { [ "$result" -eq 130 ] || [ "$result" -eq 143 ]; } &&
   ! /bin/kill -0 "$child" 2>/dev/null && node_tool shutdown "$work/shutdown"; then
  result=0
fi
child=""
if [ "$result" -eq 0 ] && node_tool shutdown "$work/shutdown"; then
  verified=1
else
  [ "$result" -ne 0 ] || result=1
  exit "$result"
fi
