#!/usr/bin/env bash
# Real WKWebView + real LDK A--C--B. No downloads. Fresh regtest keys only.
set -euo pipefail
umask 077
[[ $# == 1 ]] || { echo "Usage: $0 /path/to/genome-with-PR106" >&2; exit 2; }
APP=$(cd "$(dirname "$0")/.." && pwd -P)
GENOME=$(cd "$1" && pwd -P)
git -C "$GENOME" merge-base --is-ancestor a97ab0e HEAD || {
  echo 'Genome must include required main a97ab0e; integrate PR #106 tests with that main first.' >&2
  exit 2
}
: "${BITCOIND_EXE:?point to cached Bitcoin Core 28.2}"
: "${ELECTRS_EXE:?point to cached Esplora electrs}"
[[ -x "$BITCOIND_EXE" && -x "$ELECTRS_EXE" ]]
[[ -x "$APP/node_modules/.bin/tauri" ]]
export CARGO_NET_OFFLINE=true npm_config_offline=true BITCOIND_SKIP_DOWNLOAD=1 ELECTRS_SKIP_DOWNLOAD=1
export PYTHONDONTWRITEBYTECODE=1
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 CARGO_INCREMENTAL=0
export NO_PROXY='*' no_proxy='*'
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
WORK=$(mktemp -d /tmp/real-ui-e2e-run.XXXXXX)
EVIDENCE=$(mktemp -d /tmp/real-ui-e2e-evidence.XXXXXX)
# Build dirs are private to this run unless the caller shares a cache on purpose.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WORK/target}"
export APP_CARGO_TARGET_DIR="${APP_CARGO_TARGET_DIR:-$WORK/app-target}"
echo "Evidence: $EVIDENCE"
runner=''
finish() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$runner" ]] && kill -0 "$runner" 2>/dev/null; then
    kill -TERM "$runner"; wait "$runner" || true
  fi
  rm -rf -- "$WORK"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' HUP INT TERM
mkdir "$WORK/genome" "$WORK/tmp"
git -C "$GENOME" archive HEAD | tar -x -C "$WORK/genome"
git -C "$GENOME" rev-parse HEAD > "$EVIDENCE/genome-head.txt"
git -C "$APP" rev-parse HEAD > "$EVIDENCE/app-head.txt"
cp "$APP/scripts/real-ui-e2e/fixture.rs" "$WORK/genome/crates/konsensus-node/src/tests/real_ui_fixture.rs"
printf '\ninclude!("real_ui_fixture.rs");\n' >> "$WORK/genome/crates/konsensus-node/src/tests/regtest_e2e.rs"
export REAL_UI_ROOT="$WORK" TMPDIR="$WORK/tmp" TEMPDIR_ROOT="$WORK/tmp"
cargo rustc --offline --locked --manifest-path "$WORK/genome/Cargo.toml" -p konsensus-node --bin konsensus \
  -- --emit="link=$WORK/konsensus" > "$EVIDENCE/node-build.log" 2>&1
cargo test --offline --locked --manifest-path "$WORK/genome/Cargo.toml" -p konsensus-node \
  --features regtest-e2e --bin konsensus --no-run --message-format=json > "$WORK/build.jsonl" 2> "$EVIDENCE/fixture-build.log"
python3 - "$WORK" <<'PY'
import json,shutil,sys
from pathlib import Path
root=Path(sys.argv[1])
items=[json.loads(line) for line in (root/'build.jsonl').read_text().splitlines() if line.startswith('{')]
binary=next(x['executable'] for x in items if x.get('executable') and x.get('profile',{}).get('test') and x.get('target',{}).get('name')=='konsensus')
shutil.copy2(binary,root/'fixture')
PY
cat > "$EVIDENCE/loopback.sb" <<'SB'
(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network* (local unix-socket) (remote unix-socket))
SB
PYTHONDONTWRITEBYTECODE=1 python3 "$APP/scripts/real-ui-e2e/run.py" "$EVIDENCE" "$APP" "$WORK/konsensus" &
runner=$!
status=0
wait "$runner" || status=$?
runner=''
python3 "$APP/scripts/ui-e2e/scan.py" "$EVIDENCE" || status=1
echo "Summary: $EVIDENCE/summary.json"
exit "$status"
