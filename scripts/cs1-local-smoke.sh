#!/usr/bin/env bash
# CS-1 local runtime smoke — durable two-run identity.
#
# Scope: prove the desktop self-host path AND that the node identity is DURABLE across a
# restart. Two runs share ONE data dir (no rm between them):
#   Run 1: init --tier full + start -> /health -> /auth/local -> /identity -> node_id A. Stop.
#   Run 2: start from the SAME dir (no re-init; config already exists) -> node_id B. Stop.
# PASS only if A == B and both are non-empty (identity survived the restart). This mirrors the
# app (src-tauri/src/main.rs): init once into the Tauri app_data_dir, skip re-init when
# konsensus.toml already exists.
#
# Runs on Linux and macOS (signed node sidecars ship for both since v0.3.0-rc5; the Darwin
# SKIP was retired then). Other hosts SKIP (exit 2). Does not test funding, rooms, messaging,
# mobile, calls, hosted, AI, relay, merge, or deploy.
#
# Both runs start konsensus.toml exactly as `konsensus init` wrote it: no port or migrations
# edits. The node's init defaults are non-colliding and its migrations are embedded since
# v0.3.0-rc6 (BitSov-bitsov #56/#57, fixed in #61).
#
# Optional, for CI / throttled networks only (BitSov-bitsov #66): CS1_SMOKE_ESPLORA_FALLBACK
# and CS1_SMOKE_ESPLORA_PRIMARY set the chain endpoints a user would put in konsensus.toml
# (see apply_chain_env). With neither set, the config is never touched.
set -euo pipefail

PORT="${PORT:-3141}"
BASE="http://127.0.0.1:${PORT}/api/v1"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS/$ARCH" in
  Linux/x86_64)                TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux/aarch64)               TRIPLE="aarch64-unknown-linux-gnu" ;;
  Darwin/arm64|Darwin/aarch64) TRIPLE="aarch64-apple-darwin" ;;
  Darwin/x86_64)               TRIPLE="x86_64-apple-darwin" ;;
  *)
    echo "SMOKE: SKIP - no signed node sidecar for this host; got $OS/$ARCH." >&2
    echo "Run this smoke on Linux (x86_64/aarch64) or macOS (arm64/x86_64)." >&2
    exit 2
    ;;
esac

for cmd in curl jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "SMOKE: FAIL - missing dependency: $cmd" >&2
    exit 1
  fi
done

SIDECAR="src-tauri/bin/konsensus-${TRIPLE}"
if [ ! -x "$SIDECAR" ]; then
  echo "SMOKE: sidecar missing; fetching signed node binary for $TRIPLE."
  ./scripts/fetch-node-sidecar.sh
fi

if ! grep -q 'node_status' src/App.tsx || ! grep -q 'class="node-id"' src/App.tsx; then
  echo "SMOKE: FAIL - identity screen does not bind node_status.node_id." >&2
  exit 1
fi

if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
  echo "SMOKE: FAIL - ${BASE} already responds; stop the existing node before running smoke." >&2
  exit 1
fi

DATA_DIR="$(mktemp -d)"
CONFIG="${DATA_DIR}/konsensus.toml"
LOG_FILE="${DATA_DIR}/konsensus-smoke.log"
NODE_PID=""
RESULT_NODE_ID=""

# Cleanup fires on EXIT only -- i.e. after run 2 completes, or on any FAIL. Never between the
# two runs: the data dir persisting across the restart is exactly what proves durability.
cleanup() {
  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# Chain-endpoint choice, applied right after init ONLY when the env is set (BitSov-bitsov #66).
# rc6 `init` writes mempool.space as the sole Esplora endpoint with no fallback, and LDK
# fail-closes at `start` when ldk-node's fee-estimate fetch from that endpoint fails -- which
# it does from GitHub runners even though the provider's own 2xx probe passes there, so a
# configured fallback alone is never consulted. The node already supports the keys a user
# would set in konsensus.toml: `[lightning].esplora_url` / `esplora_url_fallback` (with /api;
# LdkProvider::new probes the primary, then falls back) and `[chain].api_url` /
# `esplora_url_fallback` (base URL, no /api). This is that config choice, not a code splint;
# it never runs on a dev machine that leaves the env unset.
#   CS1_SMOKE_ESPLORA_PRIMARY=https://blockstream.info   -> replaces the primary in both
#   CS1_SMOKE_ESPLORA_FALLBACK=https://mempool.space     -> adds esplora_url_fallback to both
apply_chain_env() {
  local primary="${CS1_SMOKE_ESPLORA_PRIMARY:-}" fallback="${CS1_SMOKE_ESPLORA_FALLBACK:-}"
  [ -n "${primary}${fallback}" ] || return 0
  primary="${primary%/}"; fallback="${fallback%/}"
  awk -v p="$primary" -v f="$fallback" '
    /^[[:space:]]*\[/ {
      s=$0; print
      if (f != "" && s == "[lightning]") print "esplora_url_fallback = \"" f "/api\""
      if (f != "" && s == "[chain]")     print "esplora_url_fallback = \"" f "\""
      next
    }
    p != "" && s == "[lightning]" && /^[[:space:]]*esplora_url[[:space:]]*=/ { print "esplora_url = \"" p "/api\""; next }
    p != "" && s == "[chain]"     && /^[[:space:]]*api_url[[:space:]]*=/     { print "api_url = \"" p "\""; next }
    { print }
  ' "$CONFIG" > "${CONFIG}.tmp" && mv "${CONFIG}.tmp" "$CONFIG"
  echo "SMOKE: environment-forced chain fallback (genome #66): primary=${primary:-as written} fallback=${fallback:-none}"
}

# init-if-needed -- mirrors main.rs `if !config.exists()`: run 1 inits, run 2 reuses.
ensure_init() {
  if [ -s "$CONFIG" ]; then
    echo "SMOKE: config exists — skipping init, reusing $DATA_DIR (durable-identity restart)"
    return 0
  fi
  echo "SMOKE: init sidecar node in $DATA_DIR"
  "$SIDECAR" init --dir "$DATA_DIR" --non-interactive --tier full >"$LOG_FILE" 2>&1
  if [ ! -s "$CONFIG" ]; then
    echo "SMOKE: FAIL - node init did not create $CONFIG" >&2
    sed -n '1,120p' "$LOG_FILE" >&2
    exit 1
  fi
  apply_chain_env
}

# Start the (already-init'd) node, probe /health -> /auth/local -> /identity. Runs in the PARENT
# shell (never `$(run_node)`), so NODE_PID is a real global the trap + stop_node can reach; the
# captured node_id lands in RESULT_NODE_ID. Exits the script on any failure.
run_node() {
  local label="$1" jwt id
  RESULT_NODE_ID=""
  echo "SMOKE: ${label} — start sidecar on loopback ${BASE}"
  "$SIDECAR" start --config "$CONFIG" >>"$LOG_FILE" 2>&1 &
  NODE_PID=$!
  for _ in $(seq 1 60); do
    if ! kill -0 "$NODE_PID" 2>/dev/null; then
      echo "SMOKE: FAIL - node exited before health was ready (${label})" >&2
      sed -n '1,200p' "$LOG_FILE" >&2
      exit 1
    fi
    if curl -fsS "${BASE}/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    echo "SMOKE: FAIL - health never ready (${label})" >&2
    exit 1
  fi
  jwt="$(curl -fsS -X POST "${BASE}/auth/local" | jq -r '.token // empty')"
  [ -n "$jwt" ] || { echo "SMOKE: FAIL - /auth/local returned no token (${label})" >&2; exit 1; }
  id="$(curl -fsS -H "Authorization: Bearer ${jwt}" "${BASE}/identity" | jq -r '.node_id // empty')"
  [ -n "$id" ] || { echo "SMOKE: FAIL - /identity returned no node_id (${label})" >&2; exit 1; }
  RESULT_NODE_ID="$id"
  echo "SMOKE: ${label} node_id=${id}"
}

# Stop the current node and wait for the loopback API to release, so the next run can bind.
stop_node() {
  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  NODE_PID=""
  for _ in $(seq 1 30); do
    if ! curl -fsS "${BASE}/health" >/dev/null 2>&1; then break; fi
    sleep 1
  done
}

# ---- Run 1: fresh init, capture identity A ----
ensure_init
run_node "run 1"
NODE_ID_A="$RESULT_NODE_ID"
stop_node

# ---- Run 2: SAME dir, no re-init (config exists), capture identity B ----
ensure_init
run_node "run 2"
NODE_ID_B="$RESULT_NODE_ID"
stop_node

# ---- Verdict: identity must have survived the restart ----
if [ -n "$NODE_ID_A" ] && [ "$NODE_ID_A" = "$NODE_ID_B" ]; then
  echo "SMOKE: PASS node_id=${NODE_ID_A}"
  echo "SMOKE: IDENTITY_STABLE node_id=${NODE_ID_A}"
else
  echo "SMOKE: FAIL - identity not durable (run1=${NODE_ID_A} run2=${NODE_ID_B})" >&2
  exit 1
fi
