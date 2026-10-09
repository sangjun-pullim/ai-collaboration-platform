#!/bin/bash
# The verified launcher also clears these before creating this shell.
set -euo pipefail
builtin unset BASH_ENV ENV NODE_OPTIONS NODE_PATH PERL5OPT PERL5DB PERL5LIB PERLLIB PERLIO PERL_USE_UNSAFE_INC LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FALLBACK_FRAMEWORK_PATH
umask 077

fail() { /usr/bin/printf '%s\n' "로컬 연결을 시작하지 못했습니다: $1" >&2; exit 1; }
[ "$#" -eq 5 ] || fail INVALID_ARGUMENTS
origin=$1
profile=$2
device_alias=$3
organization=$4
room=$5
[[ "$origin" =~ ^https://[^/?\#@[:space:]]+$ || "$origin" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]] || fail UNSAFE_ORIGIN
[[ "$profile" =~ ^web-[a-f0-9]{32}$ ]] || fail INVALID_PROFILE
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
  if (mode === "manifest") {
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

download "$origin/local-connection/manifest.json" "$work/manifest.json" 4096
node_tool manifest "$work/manifest.json" "$work/code.metadata" || fail INVALID_MANIFEST
{ read -r code_path; read -r code_sha; read -r code_bytes; } < "$work/code.metadata"
download "$origin$code_path" "$work/connector.tar.gz" 16777216
[ "$(/usr/bin/wc -c < "$work/connector.tar.gz")" -eq "$code_bytes" ] || fail DOWNLOAD_SIZE
verify "$work/connector.tar.gz" "$code_sha"
node_tool extract "$work/connector.tar.gz" "$work/code" || fail INVALID_ARCHIVE
forward() { if [ -n "$child" ]; then /bin/kill "-$1" "$child" 2>/dev/null || true; fi; }
trap 'forward INT' INT
trap 'forward TERM' TERM
started=1
"$node" --input-type=module -e '
import {writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
// Keep argv[1] separate from the imported CLI entry so its direct-run guard stays idle.
const [, entry, proof, ...args] = process.argv.slice(1);
try {
  const {main} = await import(pathToFileURL(entry).href);
  await main(args);
  await writeFile(proof, "VERIFIED\n", {flag:"wx",mode:0o600});
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : "UNAVAILABLE";
  process.stderr.write(JSON.stringify({state:"disconnected",error:code}) + "\n");
  process.exitCode = 1;
}' ai-collab-bootstrap "$work/code/src/cli.js" "$work/shutdown" connect --server "$origin" --profile "$profile" --device-alias "$device_alias" --organization-id "$organization" --room-id "$room" <&0 &
child=$!
set +e
while true; do
  wait "$child"
  result=$?
  /bin/kill -0 "$child" 2>/dev/null || break
done
set -e
child=""
if [ "$result" -eq 0 ] && node_tool shutdown "$work/shutdown"; then
  verified=1
else
  [ "$result" -ne 0 ] || result=1
  exit "$result"
fi
