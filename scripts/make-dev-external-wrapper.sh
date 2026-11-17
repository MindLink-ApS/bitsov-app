#!/usr/bin/env bash
# DEV ONLY — wrap a built dev-external binary in a macOS .app so it gets a Dock icon.
#
#   scripts/make-dev-external-wrapper.sh <built-binary> <output.app>
#
# `src-tauri/tauri.dev-external.conf.json` sets `bundle.active=false`, so Tauri makes
# no .app and the bare binary shows a generic Dock icon. This writes a minimal
# bundle around the binary:
#
#   <output.app>/Contents/Info.plist          src-tauri/Info.plist + bundle keys below
#   <output.app>/Contents/MacOS/bitsov-app    copy of <built-binary>
#   <output.app>/Contents/Resources/icon.icns copy of src-tauri/icons/icon.icns
#
# The Info.plist starts from src-tauri/Info.plist, the same macOS plist Tauri merges
# into the real app, so the mic, camera and local network usage strings stay: macOS
# ends an app that asks for the mic without one. The wrapper then sets its own keys
# (identifier tech.mindlink.bitsov.devexternal, executable, icon, name, type).
#
# If BITSOV_DEV_EXTERNAL_NODE is set (absolute path), it is written to LSEnvironment
# so a Finder or Dock launch attaches to that node dir. Nothing is signed, built,
# launched or downloaded. See docs/DEV_EXTERNAL_NODE.md.
set -euo pipefail

die() { echo "make-dev-external-wrapper: $*" >&2; exit 1; }

[ "$#" -eq 2 ] || die "usage: $0 <built-binary> <output.app>"
BIN="$1"
OUT="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ICON="$ROOT/src-tauri/icons/icon.icns"
SRC_PLIST="$ROOT/src-tauri/Info.plist"
ID="tech.mindlink.bitsov.devexternal"
EXE="bitsov-app"

if ! { [ -f "$BIN" ] && [ -x "$BIN" ]; }; then die "not an executable file: $BIN"; fi
[ -s "$ICON" ] || die "missing icon: $ICON"
[ -s "$SRC_PLIST" ] || die "missing source plist: $SRC_PLIST"
command -v python3 >/dev/null || die "python3 is required to merge $SRC_PLIST"
case "$OUT" in *.app) ;; *) die "output must end in .app: $OUT" ;; esac
[ ! -e "$OUT" ] || [ -f "$OUT/Contents/Info.plist" ] || die "refusing to replace a non-bundle path: $OUT"

if [ -n "${BITSOV_DEV_EXTERNAL_NODE:-}" ]; then
  case "$BITSOV_DEV_EXTERNAL_NODE" in /*) ;; *) die "BITSOV_DEV_EXTERNAL_NODE must be absolute" ;; esac
fi

# Merge first, into a temp file, so a bad source plist leaves <output.app> untouched.
TMP_PLIST="$(mktemp)"
trap 'rm -f "$TMP_PLIST"' EXIT
python3 - "$SRC_PLIST" "$TMP_PLIST" "$ID" "$EXE" <<'PY' || die "could not merge $SRC_PLIST"
import os, plistlib, sys
src, out, ident, exe = sys.argv[1:5]
with open(src, "rb") as f:
    info = plistlib.load(f)
if not isinstance(info, dict):
    sys.exit("source plist is not a dictionary")
info.update({
    "CFBundleIdentifier": ident,
    "CFBundleExecutable": exe,
    "CFBundleIconFile": "icon.icns",
    "CFBundleName": "BitSov Dev External",
    "CFBundlePackageType": "APPL",
    "CFBundleInfoDictionaryVersion": "6.0",
    "NSHighResolutionCapable": True,
})
node = os.environ.get("BITSOV_DEV_EXTERNAL_NODE", "")
if node:
    env = dict(info.get("LSEnvironment") or {})
    env["BITSOV_DEV_EXTERNAL_NODE"] = node
    info["LSEnvironment"] = env
with open(out, "wb") as f:
    plistlib.dump(info, f, sort_keys=True)
PY

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/$EXE"
chmod 0755 "$OUT/Contents/MacOS/$EXE"
cp "$ICON" "$OUT/Contents/Resources/icon.icns"
cp "$TMP_PLIST" "$OUT/Contents/Info.plist"

echo "wrote $OUT"
