#!/usr/bin/env bash
# No-network test for scripts/make-dev-external-wrapper.sh. Wraps a fake binary and
# asserts the bundle has the Dock icon: CFBundleIconFile=icon.icns in Info.plist and
# a real icns at Contents/Resources/icon.icns. Runs on Linux and macOS (python3 plistlib).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAKE="$ROOT/scripts/make-dev-external-wrapper.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fails=0

ok() { echo "ok    $1"; }
bad() { echo "FAIL  $1" >&2; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }

key() { python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb")).get(sys.argv[2],""))' "$1" "$2"; }
env_key() { python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb")).get("LSEnvironment",{}).get(sys.argv[2],""))' "$1" "$2"; }

printf '#!/bin/sh\nexit 0\n' > "$TMP/bitsov-app"
chmod 0755 "$TMP/bitsov-app"

APP="$TMP/out/BitSov Dev External.app"
PLIST="$APP/Contents/Info.plist"
mkdir -p "$TMP/out"
env -u BITSOV_DEV_EXTERNAL_NODE bash "$MAKE" "$TMP/bitsov-app" "$APP" >/dev/null

check "Info.plist parses" python3 -c 'import plistlib,sys; plistlib.load(open(sys.argv[1],"rb"))' "$PLIST"
check "CFBundleIconFile is icon.icns" test "$(key "$PLIST" CFBundleIconFile)" = icon.icns
check "identifier is the dev-external id" test "$(key "$PLIST" CFBundleIdentifier)" = tech.mindlink.bitsov.devexternal
check "CFBundleExecutable is present" test -x "$APP/Contents/MacOS/$(key "$PLIST" CFBundleExecutable)"
check "icon.icns exists" test -s "$APP/Contents/Resources/icon.icns"
check "icon.icns is an icns file" test "$(head -c 4 "$APP/Contents/Resources/icon.icns")" = icns
check "icon.icns is the repo icon" cmp -s "$APP/Contents/Resources/icon.icns" "$ROOT/src-tauri/icons/icon.icns"
check "no LSEnvironment without a node dir" test -z "$(env_key "$PLIST" BITSOV_DEV_EXTERNAL_NODE)"

BITSOV_DEV_EXTERNAL_NODE=/abs/node-dir bash "$MAKE" "$TMP/bitsov-app" "$APP" >/dev/null
check "rerun keeps CFBundleIconFile" test "$(key "$PLIST" CFBundleIconFile)" = icon.icns
check "node dir goes to LSEnvironment" test "$(env_key "$PLIST" BITSOV_DEV_EXTERNAL_NODE)" = /abs/node-dir

refuses() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }
refuses "refuses a relative node dir" env BITSOV_DEV_EXTERNAL_NODE=rel bash "$MAKE" "$TMP/bitsov-app" "$TMP/x.app"
refuses "refuses an output without .app" bash "$MAKE" "$TMP/bitsov-app" "$TMP/plain"
refuses "refuses a missing binary" bash "$MAKE" "$TMP/nope" "$TMP/y.app"
mkdir -p "$TMP/keep.app"; touch "$TMP/keep.app/data"
refuses "refuses to replace a non-bundle dir" bash "$MAKE" "$TMP/bitsov-app" "$TMP/keep.app"
check "non-bundle dir left intact" test -f "$TMP/keep.app/data"

[ "$fails" -eq 0 ] || { echo "$fails check(s) failed" >&2; exit 1; }
echo "all dev-external wrapper checks passed"
