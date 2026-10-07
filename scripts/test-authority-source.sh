#!/usr/bin/env bash
# Exercise the source gate after sidecar download, without starting a node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/src-tauri/"{bin,src,icons,capabilities,mobile-capabilities}
cp -R "$ROOT/src" "$TMP/src"
cp "$ROOT/package-lock.json" "$TMP/"
cp "$ROOT/scripts/authority-check.sh" "$ROOT/scripts/fetch-node-sidecar.sh" "$TMP/scripts/"
cp "$ROOT/src-tauri/Cargo.toml" "$ROOT/src-tauri/Cargo.lock" "$ROOT/src-tauri/tauri.conf.json" "$TMP/src-tauri/"
cp "$ROOT/src-tauri/src/main.rs" "$ROOT/src-tauri/src/app.rs" "$TMP/src-tauri/src/"
cp "$ROOT/src-tauri/icons/"*.png "$TMP/src-tauri/icons/"
cp "$ROOT/src-tauri/capabilities/default.json" "$TMP/src-tauri/capabilities/"
cp "$ROOT/src-tauri/mobile-capabilities/default.json" "$TMP/src-tauri/mobile-capabilities/"
cd "$TMP"

expect_gate() {
  local expected="$1" label="$2" rc=0
  bash scripts/authority-check.sh > result.log 2>&1 || rc=$?
  if [ "$rc" -ne "$expected" ]; then
    cat result.log
    echo "FAIL: $label (exit $rc, expected $expected)" >&2
    exit 1
  fi
  if [ "$expected" -eq 1 ]; then
    grep -q "FAIL  ${3:-G2: no non-loopback control-plane URL}" result.log
  else
    grep -q '^AUTHORITY: PASS$' result.log
  fi
  echo "PASS: $label"
}

expect_gate 0 'clean source'
for capability_dir in capabilities mobile-capabilities; do
  cat > "src-tauri/$capability_dir/unsafe.json" <<'JSON'
{"identifier":"unsafe","windows":["main"],"permissions":[{"identifier":"shell:allow-execute","allow":[{"name":"bin/konsensus","sidecar":true,"args":true}]}]}
JSON
  expect_gate 1 "unrestricted shell execute in $capability_dir is rejected" 'shell capability:'
  rm "src-tauri/$capability_dir/unsafe.json"
done
# Embedded public protocol URL, not an app control-plane connection.
printf '\0https://example.com/api/v1\0' > src-tauri/bin/konsensus-aarch64-apple-darwin
expect_gate 0 'downloaded binary is outside the app source gate'
printf '\n// https://example.com/api/v1\n' >> src-tauri/src/app.rs
expect_gate 1 'non-loopback URL in app Rust source is still rejected'
cp "$ROOT/src-tauri/src/app.rs" src-tauri/src/app.rs
mkdir -p src-tauri/src/bin src/bin
printf 'fn main() { let _ = "https://example.com/api/v1"; }\n' > src-tauri/src/bin/helper.rs
expect_gate 1 'nested Rust bin directory remains in the source gate'
rm src-tauri/src/bin/helper.rs
printf 'const endpoint = "https://example.com/api/v1";\n' > src/bin/tool.ts
expect_gate 1 'nested frontend bin directory remains in the source gate'
echo 'AUTHORITY SOURCE TESTS: PASS'
