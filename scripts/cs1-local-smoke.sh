#!/usr/bin/env bash
# CS-1 local runtime smoke.
#
# Scope: prove the desktop self-host path only:
# sidecar node -> loopback /health -> POST /auth/local -> GET /identity -> node_id.
# Then assert the renderer binds node_status.node_id into the identity screen.
#
# This is intentionally local-only because CS-1 has signed Linux node sidecars
# only. It does not test funding, rooms, messaging, mobile, calls, hosted, AI,
# relay, merge, or deploy.
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
LOG_FILE="${DATA_DIR}/konsensus-smoke.log"
cleanup() {
  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT

# rc4 workaround: point the released node at its SQLite migrations (fetched pinned beside the
# sidecar by fetch-node-sidecar.sh). Without this the node fail-closes resolving migrations.
export KONSENSUS_SQLITE_MIGRATIONS_DIR="$(pwd)/src-tauri/migrations"
echo "SMOKE: migrations dir = $KONSENSUS_SQLITE_MIGRATIONS_DIR ($(ls "$KONSENSUS_SQLITE_MIGRATIONS_DIR"/*.sql 2>/dev/null | wc -l | tr -d ' ') files)"

echo "SMOKE: init sidecar node in $DATA_DIR"
"$SIDECAR" init --dir "$DATA_DIR" --non-interactive --tier full >"$LOG_FILE" 2>&1

CONFIG="${DATA_DIR}/konsensus.toml"
if [ ! -s "$CONFIG" ]; then
  echo "SMOKE: FAIL - node init did not create $CONFIG" >&2
  sed -n '1,120p' "$LOG_FILE" >&2
  exit 1
fi

# rc4 workaround: `konsensus init --tier full` writes [network].listen_addr (P2P) and
# [lightning].listening_address both on 0.0.0.0:9735; `start` fail-closes on the collision.
# Move ONLY [network].listen_addr to :9736 (the node's own hint) when it collides with Lightning.
# Section-aware so [api].listen_addr (shares the key name) keeps its own port. See docs/CS1_RUNBOOK.md.
port_in() { awk -v sec="[$1]" -v key="$2" '/^[[:space:]]*\[/{s=$0} s==sec && $0 ~ ("^[[:space:]]*" key "[[:space:]]*=") {if(match($0,/:[0-9]+/)){print substr($0,RSTART+1,RLENGTH-1);exit}}' "$CONFIG"; }
NET_PORT=$(port_in network listen_addr)
LN_PORT=$(port_in lightning listening_address)
if [ -n "$NET_PORT" ] && [ "$NET_PORT" = "$LN_PORT" ]; then
  awk '/^[[:space:]]*\[/{s=$0} {if(s=="[network]" && $0 ~ /^[[:space:]]*listen_addr[[:space:]]*=/) sub(/:[0-9]+"/, ":9736\""); print}' "$CONFIG" > "${CONFIG}.tmp" && mv "${CONFIG}.tmp" "$CONFIG"
  echo "SMOKE: rc4 workaround - [network] listen_addr -> :9736 (collided with Lightning :${LN_PORT}); [api] untouched"
fi

echo "SMOKE: start sidecar on loopback ${BASE}"
"$SIDECAR" start --config "$CONFIG" >>"$LOG_FILE" 2>&1 &
NODE_PID=$!

for _ in $(seq 1 60); do
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "SMOKE: FAIL - node exited before health was ready" >&2
    sed -n '1,160p' "$LOG_FILE" >&2
    exit 1
  fi
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

curl -fsS "${BASE}/health" >/dev/null

JWT="$(curl -fsS -X POST "${BASE}/auth/local" | jq -r '.token // empty')"
if [ -z "$JWT" ]; then
  echo "SMOKE: FAIL - /auth/local returned no token" >&2
  exit 1
fi

NODE_ID="$(curl -fsS -H "Authorization: Bearer ${JWT}" "${BASE}/identity" | jq -r '.node_id // empty')"
if [ -z "$NODE_ID" ]; then
  echo "SMOKE: FAIL - /identity returned no node_id" >&2
  exit 1
fi

echo "SMOKE: PASS node_id=${NODE_ID}"
