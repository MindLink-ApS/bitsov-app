#!/usr/bin/env bash
# No-network test for scripts/make-dev-external-wrapper.sh. Wraps a fake binary and
# asserts the bundle has the Dock icon: CFBundleIconFile=icon.icns in Info.plist and
# a real icns at Contents/Resources/icon.icns. It also asserts every key of the app's
# macOS plist (src-tauri/Info.plist: mic, camera, local network usage strings) reaches
# the generated plist with the same value; without them macOS ends the app when it
# asks for the mic. Runs on Linux and macOS (python3 plistlib).
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
# kept <source> <generated>: every source key except the wrapper's own is in the
# generated plist with an equal value, and the source has at least one usage string.
WRAPPER_KEYS="CFBundleIdentifier CFBundleExecutable CFBundleIconFile CFBundleName CFBundlePackageType CFBundleInfoDictionaryVersion NSHighResolutionCapable LSEnvironment"
kept() {
  python3 - "$1" "$2" "$WRAPPER_KEYS" <<'PY'
import plistlib, sys
src = plistlib.load(open(sys.argv[1], "rb"))
out = plistlib.load(open(sys.argv[2], "rb"))
own = set(sys.argv[3].split())
if not [k for k in src if k.startswith("NS") and k.endswith("UsageDescription")]:
    sys.exit("source has no usage descriptions: " + sys.argv[1])
lost = [k for k in src if k not in own and out.get(k) != src[k]]
if lost:
    sys.exit("lost or changed: " + ", ".join(lost))
PY
}
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
check "keeps every key of src-tauri/Info.plist" kept "$ROOT/src-tauri/Info.plist" "$PLIST"
check "keeps the microphone usage string" test -n "$(key "$PLIST" NSMicrophoneUsageDescription)"
check "keeps the camera usage string" test -n "$(key "$PLIST" NSCameraUsageDescription)"

BITSOV_DEV_EXTERNAL_NODE=/abs/node-dir bash "$MAKE" "$TMP/bitsov-app" "$APP" >/dev/null
check "rerun keeps CFBundleIconFile" test "$(key "$PLIST" CFBundleIconFile)" = icon.icns
check "node dir goes to LSEnvironment" test "$(env_key "$PLIST" BITSOV_DEV_EXTERNAL_NODE)" = /abs/node-dir
check "rerun keeps every key of src-tauri/Info.plist" kept "$ROOT/src-tauri/Info.plist" "$PLIST"

# Stub repo: a copy of the script beside a stub icon and a stub source plist with more
# privacy keys, nested values, and clashing bundle keys that the wrapper must own.
STUB="$TMP/stub"
mkdir -p "$STUB/scripts" "$STUB/src-tauri/icons"
cp "$MAKE" "$STUB/scripts/"
printf 'icns-stub' > "$STUB/src-tauri/icons/icon.icns"
python3 - "$STUB/src-tauri/Info.plist" <<'PY'
import plistlib, sys
plistlib.dump({
    "NSMicrophoneUsageDescription": "stub mic <&> purpose",
    "NSCameraUsageDescription": "stub camera purpose",
    "NSLocalNetworkUsageDescription": "stub local network purpose",
    "NSBluetoothAlwaysUsageDescription": "stub bluetooth purpose",
    "NSBonjourServices": ["_bitsov._tcp"],
    "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
    "CFBundleIdentifier": "stub.should.not.win",
    "CFBundleExecutable": "stub-exe",
    "CFBundleIconFile": "stub.icns",
    "LSEnvironment": {"STUB_KEEP": "1"},
}, open(sys.argv[1], "wb"))
PY
SAPP="$TMP/out/Stub.app"
SPLIST="$SAPP/Contents/Info.plist"
BITSOV_DEV_EXTERNAL_NODE=/abs/stub-node bash "$STUB/scripts/make-dev-external-wrapper.sh" "$TMP/bitsov-app" "$SAPP" >/dev/null || true
check "stub: keeps every source key and value" kept "$STUB/src-tauri/Info.plist" "$SPLIST"
check "stub: icon key stays icon.icns" test "$(key "$SPLIST" CFBundleIconFile)" = icon.icns
check "stub: wrapper identifier wins" test "$(key "$SPLIST" CFBundleIdentifier)" = tech.mindlink.bitsov.devexternal
check "stub: wrapper executable wins" test "$(key "$SPLIST" CFBundleExecutable)" = bitsov-app
check "stub: node dir added to LSEnvironment" test "$(env_key "$SPLIST" BITSOV_DEV_EXTERNAL_NODE)" = /abs/stub-node
check "stub: source LSEnvironment kept" test "$(env_key "$SPLIST" STUB_KEEP)" = 1
rm "$STUB/src-tauri/Info.plist"

refuses() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$name"; else ok "$name"; fi; }
refuses "refuses a relative node dir" env BITSOV_DEV_EXTERNAL_NODE=rel bash "$MAKE" "$TMP/bitsov-app" "$TMP/x.app"
refuses "refuses an output without .app" bash "$MAKE" "$TMP/bitsov-app" "$TMP/plain"
refuses "refuses a missing binary" bash "$MAKE" "$TMP/nope" "$TMP/y.app"
refuses "refuses a missing source plist" bash "$STUB/scripts/make-dev-external-wrapper.sh" "$TMP/bitsov-app" "$TMP/z.app"
mkdir -p "$TMP/keep.app"; touch "$TMP/keep.app/data"
refuses "refuses to replace a non-bundle dir" bash "$MAKE" "$TMP/bitsov-app" "$TMP/keep.app"
check "non-bundle dir left intact" test -f "$TMP/keep.app/data"

[ "$fails" -eq 0 ] || { echo "$fails check(s) failed" >&2; exit 1; }
echo "all dev-external wrapper checks passed"
