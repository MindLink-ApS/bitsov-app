#!/usr/bin/env bash
# UI-E2E: the real app window against two throwaway mock nodes. DEV ONLY. No money.
#
#   scripts/ui-e2e-two-node.sh /absolute/path/to/genome-checkout
#
# The genome checkout is what you want to test (for example main with open PRs
# merged in a /tmp worktree). This script builds `konsensus` from it into
# the caller's CARGO_TARGET_DIR cache, then runs scripts/ui-e2e/runner.py, which:
#   - creates node-a/node-b inside a private /tmp/uie2e-run.* directory
#     (refuses if either exists),
#     each with a fresh identity, mock chain and a shared mock Lightning ledger;
#   - starts node B (price_open stranger) with loopback binds and lsof observations;
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
[[ -x /usr/sbin/lsof ]] || { echo "Native lsof required." >&2; exit 1; }
python3 -c 'import tomllib' 2>/dev/null || { echo 'Python 3.11+ required.' >&2; exit 1; }

EVIDENCE=$(mktemp -d /tmp/uie2e-evidence.XXXXXX)
echo "Evidence: $EVIDENCE"

# Cache dependencies, but link into a private runtime directory. Another build
# must never replace the executable this invocation launches.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-/tmp/bitsov-target-l1}"
WORK=''
runner_pid=''
finish() {
  rc=$?
  trap - EXIT HUP INT TERM
  if [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" || rc=1
  fi
  if ! python3 "$APP/scripts/ui-e2e/scan.py" "$EVIDENCE"; then
    echo 'FAIL: unsafe evidence removed by final secret scan.' >&2
    rc=1
  fi
  if [[ -L "$WORK" ]]; then
    echo 'FAIL: refusing cleanup of replaced runtime symlink.' >&2
    rc=1
  elif [[ -n "$WORK" ]]; then
    rm -rf -- "$WORK" || rc=1
  fi
  exit "$rc"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
WORK=$(mktemp -d /tmp/uie2e-run.XXXXXX)
git -C "$GENOME" rev-parse HEAD > "$EVIDENCE/genome-head.txt"
git -C "$APP" rev-parse HEAD > "$EVIDENCE/app-head.txt"
git -C "$GENOME" log --oneline -12 | python3 "$APP/scripts/two_node_evidence.py" --build-log "$EVIDENCE/genome-log.txt"
git -C "$APP" log --oneline -12 | python3 "$APP/scripts/two_node_evidence.py" --build-log "$EVIDENCE/app-log.txt"
cargo rustc --locked --offline \
  --manifest-path "$GENOME/Cargo.toml" -p konsensus-node --bin konsensus \
  -- --emit="link=$WORK/konsensus" 2>&1 |
  python3 "$APP/scripts/two_node_evidence.py" --build-log "$EVIDENCE/node-build.log"
BIN="$WORK/konsensus"
[[ -x "$BIN" ]] || { echo 'Missing private executable.' >&2; exit 1; }
shasum -a 256 "$BIN" > "$EVIDENCE/node-sha256.txt"

# Seatbelt localhost includes this Mac's LAN addresses. The runner checks actual
# node sockets with lsof; snapshots detect observed violations, not every packet.
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
PYTHONDONTWRITEBYTECODE=1 python3 "$APP/scripts/ui-e2e/runner.py" "$EVIDENCE" "$APP" "$BIN" &
runner_pid=$!
wait "$runner_pid" || status=$?
runner_pid=''
# Render only evidence that has already passed the credential scan.
python3 "$APP/scripts/two_node_evidence.py" --scan "$EVIDENCE" || exit 1

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
