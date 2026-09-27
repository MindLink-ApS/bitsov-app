#!/usr/bin/env bash
# UI-E2E: the real app window against two throwaway mock nodes. DEV ONLY. No money.
#
#   scripts/ui-e2e-two-node.sh /absolute/path/to/genome-checkout
#
# The genome checkout is what you want to test (for example main with open PRs
# merged in a /tmp worktree). This script builds `konsensus` from it into
# /tmp/uie2e-target, then runs scripts/ui-e2e/runner.py, which:
#   - creates /tmp/uie2e-node-a and /tmp/uie2e-node-b (refuses if they exist),
#     each with a fresh identity, mock chain and a shared mock Lightning ledger;
#   - starts node B (price_open stranger) under a loopback-only sandbox;
#   - starts THIS app through the #44 dev-node path (scripts/dev-node-from-main.sh)
#     on node A's dir, with --owner-control so the owner can grant from A's terminal;
#   - drives the real window with tests/e2e/driver.js (injected by the dev server
#     only when BITSOV_UI_E2E=1) through tests/e2e/two_node_spec.py;
#   - quits the app, stops both nodes and deletes both data dirs.
# Evidence (logs, every UI command, node reads, DOM snapshots, PNG screenshots and a
# webm walk-through) goes to a fresh private /tmp/uie2e-evidence.* directory.
#
# Why not Playwright on the window: macOS has no WebDriver for WKWebView, so
# neither Playwright nor tauri-driver can attach to a Tauri window there. The
# driver runs inside the real window instead, and Playwright (Chromium) renders
# the DOM snapshots it takes into screenshots afterwards.
#
# Needs: macOS, cargo (offline deps), Python 3.11+, npm deps installed, and a
# Playwright install with Chromium for the screenshots (optional; set
# PLAYWRIGHT_MODULE=/path/to/node_modules/playwright if it is not found).
# Ports 127.0.0.1:3141 (node A, fixed by the app) and 1420 (vite) must be free.
set -euo pipefail
umask 077

[[ $# -eq 1 ]] || { echo "Usage: $0 /absolute/path/to/genome-checkout" >&2; exit 1; }
[[ $(uname -s) == Darwin ]] || { echo 'macOS only: the nodes run under sandbox-exec.' >&2; exit 1; }
GENOME=$(cd "$1" && pwd -P)
APP=$(cd "$(dirname "$0")/.." && pwd -P)
command -v cargo >/dev/null && command -v sandbox-exec >/dev/null && command -v npx >/dev/null
python3 -c 'import tomllib' 2>/dev/null || { echo 'Python 3.11+ required.' >&2; exit 1; }

EVIDENCE=$(mktemp -d /tmp/uie2e-evidence.XXXXXX)
echo "Evidence: $EVIDENCE"
git -C "$GENOME" rev-parse HEAD > "$EVIDENCE/genome-head.txt"
git -C "$GENOME" log --oneline -12 > "$EVIDENCE/genome-log.txt"
git -C "$APP" rev-parse HEAD > "$EVIDENCE/app-head.txt"
git -C "$APP" log --oneline -12 > "$EVIDENCE/app-log.txt"

# Dedicated target dir; never run a caller-supplied binary.
CARGO_TARGET_DIR=/tmp/uie2e-target cargo build --locked --offline \
  --manifest-path "$GENOME/Cargo.toml" -p konsensus-node --bin konsensus \
  > "$EVIDENCE/node-build.log" 2>&1
BIN=/tmp/uie2e-target/debug/konsensus
shasum -a 256 "$BIN" > "$EVIDENCE/node-sha256.txt"

cat > "$EVIDENCE/loopback.sb" <<'SANDBOX'
(version 1)
(allow default)
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network* (local unix-socket) (remote unix-socket))
SANDBOX

status=0
PYTHONDONTWRITEBYTECODE=1 python3 "$APP/scripts/ui-e2e/runner.py" "$EVIDENCE" "$APP" "$BIN" || status=$?

# Screenshots + walk-through video from the snapshots (best effort).
if [[ -z ${PLAYWRIGHT_MODULE:-} ]]; then
  PLAYWRIGHT_MODULE=$( (ls -d "$APP"/node_modules/playwright ~/.npm/_npx/*/node_modules/playwright 2>/dev/null || true) | head -1)
fi
if [[ -z ${PLAYWRIGHT_CHROMIUM:-} ]]; then
  PLAYWRIGHT_CHROMIUM=$( (ls -d ~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/*.app/Contents/MacOS/* 2>/dev/null || true) | tail -1)
fi
export PLAYWRIGHT_CHROMIUM
if [[ -n $PLAYWRIGHT_MODULE ]]; then
  PLAYWRIGHT_MODULE=$PLAYWRIGHT_MODULE node "$APP/scripts/ui-e2e/render.mjs" "$EVIDENCE" \
    || echo 'render: screenshots failed; the HTML snapshots are still in snapshots/' >&2
else
  echo 'render: no Playwright found; HTML snapshots only' >&2
fi
echo "Summary: $EVIDENCE/summary.json"
exit $status
