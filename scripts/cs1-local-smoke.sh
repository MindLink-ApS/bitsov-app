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
# Linux-only (CS-1 has signed Linux node sidecars only). Does not test funding, rooms,
# messaging, mobile, calls, hosted, AI, relay, merge, or deploy.
set -euo pipefail

PORT="${PORT:-3141}"
BASE="http://127.0.0.1:${PORT}/api/v1"
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS/$ARCH" in
  Linux/x86_64)  TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux/aarch64) TRIPLE="aarch64-unknown-linux-gnu" ;;
  *)
    echo "SMOKE: SKIP - CS-1 sidecar smoke is Linux-only; got $OS/$ARCH." >&2
    echo "Fetch/run the app on Linux x86_64 or aarch64 for this smoke." >&2
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

# rc4 workaround: point the released node at its SQLite migrations (fetched pinned beside the
# sidecar by fetch-node-sidecar.sh). Both runs inherit it; without it the node fail-closes
# resolving migrations.
export KONSENSUS_SQLITE_MIGRATIONS_DIR="$(pwd)/src-tauri/migrations"
echo "SMOKE: migrations dir = $KONSENSUS_SQLITE_MIGRATIONS_DIR ($(ls "$KONSENSUS_SQLITE_MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ') files)"

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
}

# rc4 workaround (section-aware, idempotent): `konsensus init --tier full` writes
# [network].listen_addr (P2P) and [lightning].listening_address both on 0.0.0.0:9735; `start`
# fail-closes on the collision. Move ONLY [network].listen_addr to :9736 when it collides with
# Lightning. Must not touch [api].listen_addr (shares the key name). Called before every start,
# mirroring main.rs. Idempotent -- after run 1 the ports no longer collide, so run 2 is a no-op.
port_in() { awk -v sec="[$1]" -v key="$2" '/^[[:space:]]*\[/{s=$0} s==sec && $0 ~ ("^[[:space:]]*" key "[[:space:]]*=") {if(match($0,/:[0-9]+/)){print substr($0,RSTART+1,RLENGTH-1);exit}}' "$CONFIG"; }
patch_ports() {
  local net ln
  net=$(port_in network listen_addr)
  ln=$(port_in lightning listening_address)
  if [ -n "$net" ] && [ "$net" = "$ln" ]; then
    awk '/^[[:space:]]*\[/{s=$0} {if(s=="[network]" && $0 ~ /^[[:space:]]*listen_addr[[:space:]]*=/) sub(/:[0-9]+"/, ":9736\""); print}' "$CONFIG" > "${CONFIG}.tmp" && mv "${CONFIG}.tmp" "$CONFIG"
    echo "SMOKE: rc4 workaround - [network] listen_addr -> :9736 (collided with Lightning :${ln}); [api] untouched"
  fi
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
patch_ports
run_node "run 1"
NODE_ID_A="$RESULT_NODE_ID"
stop_node

# ---- Run 2: SAME dir, no re-init (config exists), capture identity B ----
ensure_init
patch_ports
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
