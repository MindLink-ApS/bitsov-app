#!/usr/bin/env bash
# DEV ONLY — start the app (`tauri dev`) against a `konsensus` built from genome main.
#
#   BITSOV_DEV_SIDECAR=/abs/path/to/konsensus \
#   BITSOV_DEV_DATA_DIR=/abs/path/to/fresh-dir \
#   npm run tauri:dev:mainnode
#
# !!! SIDECAR VERIFICATION IS BYPASSED. !!! The binary is not signature- or hash-checked.
# Debug builds only: the `dev-node` feature is a compile error in release. Never use this
# to ship, and never point it at a data dir that holds a real node.
# See docs/DEV_NODE_FROM_MAIN.md.
set -euo pipefail

die() { echo "dev-node: $*" >&2; exit 1; }

: "${BITSOV_DEV_SIDECAR:?set BITSOV_DEV_SIDECAR to an absolute path to a konsensus binary}"
: "${BITSOV_DEV_DATA_DIR:?set BITSOV_DEV_DATA_DIR to an absolute path to a dev-only data dir}"
case "$BITSOV_DEV_SIDECAR" in /*) ;; *) die "BITSOV_DEV_SIDECAR must be absolute" ;; esac
case "$BITSOV_DEV_DATA_DIR" in /*) ;; *) die "BITSOV_DEV_DATA_DIR must be absolute" ;; esac
test -x "$BITSOV_DEV_SIDECAR" || die "not an executable: $BITSOV_DEV_SIDECAR"

# The host refuses these too (src-tauri/src/dev_node.rs); failing here is just earlier.
case "$BITSOV_DEV_DATA_DIR" in
  "$HOME"/.konsensus|"$HOME"/.konsensus/*) die "refusing ~/.konsensus" ;;
  "$HOME/Library/Application Support/tech.mindlink.bitsov"|"$HOME/Library/Application Support/tech.mindlink.bitsov/"*)
    die "refusing the product app data dir" ;;
esac

cat >&2 <<BANNER
================================================================================
  DEV NODE — UNVERIFIED BINARY. SIDECAR SIGNATURE CHECK BYPASSED. DEV ONLY.
  binary:   $BITSOV_DEV_SIDECAR
  sha256:   $(shasum -a 256 "$BITSOV_DEV_SIDECAR" | cut -d' ' -f1)
  version:  $("$BITSOV_DEV_SIDECAR" --version 2>/dev/null || echo unknown)
  data dir: $BITSOV_DEV_DATA_DIR
  This node is a MAINNET node. Fund it only with money you can afford to lose.
================================================================================
BANNER

cd "$(dirname "$0")/.."
export BITSOV_DEV_SIDECAR BITSOV_DEV_DATA_DIR
exec npx tauri dev --features dev-node --config src-tauri/tauri.dev-node.conf.json "$@"
