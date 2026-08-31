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

echo "SMOKE: init sidecar node in $DATA_DIR"
"$SIDECAR" init --dir "$DATA_DIR" --non-interactive --tier full >"$LOG_FILE" 2>&1

CONFIG="${DATA_DIR}/konsensus.toml"
if [ ! -s "$CONFIG" ]; then
  echo "SMOKE: FAIL - node init did not create $CONFIG" >&2
  sed -n '1,120p' "$LOG_FILE" >&2
  exit 1
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
