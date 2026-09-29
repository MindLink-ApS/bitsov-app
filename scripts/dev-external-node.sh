#!/usr/bin/env bash
# DEV ONLY — start the app (`tauri dev`) attached to a node YOU already run.
#
#   BITSOV_DEV_EXTERNAL_NODE=/abs/path/to/your/node/data-dir \
#   npm run tauri:dev:external
#
# The app never inits, starts, restarts or stops that node. It talks only to
# 127.0.0.1:3141 and reads the node dir only for pairing challenge files and the
# routing policy in konsensus.toml. Its own files live under the dev app's data dir
# (identifier tech.mindlink.bitsov.devexternal). Debug builds only: the `dev-node`
# feature is a compile error in release. See docs/DEV_EXTERNAL_NODE.md.
set -euo pipefail

die() { echo "dev-external-node: $*" >&2; exit 1; }

: "${BITSOV_DEV_EXTERNAL_NODE:?set BITSOV_DEV_EXTERNAL_NODE to the absolute path of your node data dir}"
case "$BITSOV_DEV_EXTERNAL_NODE" in /*) ;; *) die "BITSOV_DEV_EXTERNAL_NODE must be absolute" ;; esac
[ -z "${BITSOV_DEV_SIDECAR:-}${BITSOV_DEV_DATA_DIR:-}" ] ||
  die "unset BITSOV_DEV_SIDECAR and BITSOV_DEV_DATA_DIR: external mode never starts a node"
test -f "$BITSOV_DEV_EXTERNAL_NODE/NODE_INITIALIZED" || die "not an initialised node dir: $BITSOV_DEV_EXTERNAL_NODE"
curl -fsS --max-time 3 http://127.0.0.1:3141/api/v1/health >/dev/null ||
  die "no node answers on 127.0.0.1:3141; start your node first"

cat >&2 <<BANNER
================================================================================
  DEV APP — EXTERNAL NODE. The app does not start, stop or restart this node.
  api:      http://127.0.0.1:3141
  data dir: $BITSOV_DEV_EXTERNAL_NODE
================================================================================
BANNER

cd "$(dirname "$0")/.."
export BITSOV_DEV_EXTERNAL_NODE
exec npx tauri dev --features dev-node --config src-tauri/tauri.dev-external.conf.json "$@"
