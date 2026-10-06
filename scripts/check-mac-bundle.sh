#!/usr/bin/env bash
# shellcheck disable=SC2317  # check functions below are invoked indirectly via chk (older shellcheck flags them unreachable)
# Static checks on an unsigned BitSov.app (docs/MAC_PACKAGE.md). Structure,
# sidecar integrity, and the release exclusion of the sealed assistant page and
# its 50-question fixture. Reads files only: it never opens or executes the
# bundle or anything inside it.
#
# Usage: scripts/check-mac-bundle.sh [--app PATH] [--sidecar PATH] [--dist PATH]
#   --app      default src-tauri/target/release/bundle/macos/BitSov.app
#   --sidecar  the fetched, signature-verified node; default
#              src-tauri/bin/konsensus-aarch64-apple-darwin
#   --dist     the frontend dist the release build embedded; default dist
# Exit 0 and "MAC BUNDLE CHECK: PASS", or exit 1 and "MAC BUNDLE CHECK: FAIL".
# The check functions below are invoked indirectly, through chk.
# shellcheck disable=SC2329
set -euo pipefail

# shellcheck source=scripts/fetch-node-sidecar.sh disable=SC1091
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fetch-node-sidecar.sh"

APP="src-tauri/target/release/bundle/macos/BitSov.app"
SIDECAR="src-tauri/bin/konsensus-aarch64-apple-darwin"
DIST="dist"
MIN_MACOS="11.0"
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --sidecar) SIDECAR="$2"; shift 2 ;;
    --dist) DIST="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

MACOS="$APP/Contents/MacOS"
PLIST="$APP/Contents/Info.plist"

# Strings that exist only in assistant.html, its Vite chunk, or
# jarvis/fixtures/questions.json. "/assistant.html" itself is NOT a marker:
# main.rs compiles that navigation literal into every build. Tauri stores asset
# keys uncompressed but brotli-compresses asset bodies, so the asset key and the
# fixture (include_str!, uncompressed) are the reliable binary markers; the CSP
# line catches an uncompressed embed. The dist check below is the primary gate
# for the page.
MARKERS=(
  "assistant asset key|assets/assistant-"
  "assistant.html CSP|script-src 'self'; style-src 'self'; img-src 'none'"
  "fixture rule|Positive controls are answerable from a fresh read"
  "fixture key first_channel_local_msat|first_channel_local_msat"
)

fail=0
chk() {
  if "${@:2}"; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi
}

plist_lint() {
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$PLIST" >/dev/null
  else
    python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$PLIST" 2>/dev/null
  fi
}

plist_min_ok() {
  local v
  if command -v plutil >/dev/null 2>&1; then
    v="$(plutil -extract LSMinimumSystemVersion raw -o - "$PLIST" 2>/dev/null)" || return 1
  else
    v="$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["LSMinimumSystemVersion"])' "$PLIST" 2>/dev/null)" || return 1
  fi
  [ "$v" = "$MIN_MACOS" ]
}

sidecar_matches() { [ -f "$SIDECAR" ] && [ -f "$MACOS/konsensus" ] && cmp -s "$SIDECAR" "$MACOS/konsensus"; }
no_sb_files() { [ -d "$APP" ] && [ -z "$(find "$APP" -name '*.sb' -print)" ]; }
no_loose_page() { [ -d "$APP" ] && [ -z "$(find "$APP" -name 'assistant.html' -print)" ]; }
dist_has_index() { [ -s "$DIST/index.html" ]; }
dist_has_no_assistant() {
  [ -d "$DIST" ] && [ -z "$(find "$DIST" \( -name 'assistant.html' -o -name 'assistant-*' \) -print)" ]
}

binary_clean() {
  local bin="$MACOS/bitsov-app" entry label needle hit=0
  [ -f "$bin" ] || return 1
  for entry in "${MARKERS[@]}"; do
    label="${entry%%|*}"; needle="${entry#*|}"
    if LC_ALL=C grep -aqF -- "$needle" "$bin"; then
      echo "        found $label" >&2; hit=1
    fi
  done
  [ "$hit" -eq 0 ]
}

echo "== mac bundle: $APP (node $TAG) =="
chk "app executable is executable" test -f "$MACOS/bitsov-app" -a -x "$MACOS/bitsov-app"
chk "bundled sidecar is executable" test -f "$MACOS/konsensus" -a -x "$MACOS/konsensus"
chk "bundled sidecar matches the verified sidecar ($SIDECAR)" sidecar_matches
chk "icon.icns is present" test -s "$APP/Contents/Resources/icon.icns"
chk "Info.plist is well-formed" plist_lint
chk "LSMinimumSystemVersion is $MIN_MACOS" plist_min_ok
chk "no *.sb file in the bundle" no_sb_files
echo "== release excludes the assistant page and fixture =="
chk "release dist has index.html ($DIST)" dist_has_index
chk "release dist has no assistant page (assistant.html, assistant-*)" dist_has_no_assistant
chk "bundle has no assistant.html file" no_loose_page
chk "app binary has no assistant page or fixture marker" binary_clean

echo
if [ "$fail" -eq 0 ]; then echo "MAC BUNDLE CHECK: PASS"; else echo "MAC BUNDLE CHECK: FAIL"; fi
exit "$fail"
