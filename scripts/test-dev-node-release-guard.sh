#!/usr/bin/env bash
# Proves the dev-node path cannot reach a release build: compiling `dev-node` with the
# release profile must fail on the guard in src-tauri/src/dev_node.rs.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri"

# tauri-build needs both bundled binaries to exist; empty placeholders, as in CI.
TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
created=()
for PLACEHOLDER in "bin/konsensus-${TRIPLE}" "bin/bitsov-mcp-${TRIPLE}"; do
  if [ ! -e "$PLACEHOLDER" ]; then : > "$PLACEHOLDER"; created+=("$PLACEHOLDER"); fi
done
cleanup() { if [ "${#created[@]}" -gt 0 ]; then rm -f "${created[@]}"; fi; }
trap cleanup EXIT

log="$(mktemp)"
if cargo check --release --features dev-node --bin bitsov-app >"$log" 2>&1; then
  cat "$log"; echo "FAIL: release + dev-node compiled"; exit 1
fi
if ! grep -q 'feature `dev-node` is DEV ONLY' "$log"; then
  cat "$log"; echo "FAIL: release + dev-node failed, but not on the dev-node guard"; exit 1
fi
echo "PASS: release + dev-node is a compile error"

# The product config still bundles the verified sidecar; only the dev overlay drops it.
grep -q '"bin/konsensus"' tauri.conf.json || { echo "FAIL: tauri.conf.json lost externalBin"; exit 1; }
grep -q '^default = \[\]' Cargo.toml || { echo "FAIL: default features changed"; exit 1; }
echo "PASS: product config unchanged"
