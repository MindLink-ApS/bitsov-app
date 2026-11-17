#!/usr/bin/env bash
# DEV ONLY — wrap a built dev-external binary in a macOS .app so it gets a Dock icon.
#
#   scripts/make-dev-external-wrapper.sh <built-binary> <output.app>
#
# `src-tauri/tauri.dev-external.conf.json` sets `bundle.active=false`, so Tauri makes
# no .app and the bare binary shows a generic Dock icon. This writes a minimal
# bundle around the binary:
#
#   <output.app>/Contents/Info.plist          identifier tech.mindlink.bitsov.devexternal
#   <output.app>/Contents/MacOS/bitsov-app    copy of <built-binary>
#   <output.app>/Contents/Resources/icon.icns copy of src-tauri/icons/icon.icns
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
ID="tech.mindlink.bitsov.devexternal"
EXE="bitsov-app"

if ! { [ -f "$BIN" ] && [ -x "$BIN" ]; }; then die "not an executable file: $BIN"; fi
[ -s "$ICON" ] || die "missing icon: $ICON"
case "$OUT" in *.app) ;; *) die "output must end in .app: $OUT" ;; esac
[ ! -e "$OUT" ] || [ -f "$OUT/Contents/Info.plist" ] || die "refusing to replace a non-bundle path: $OUT"

env_block=""
if [ -n "${BITSOV_DEV_EXTERNAL_NODE:-}" ]; then
  case "$BITSOV_DEV_EXTERNAL_NODE" in /*) ;; *) die "BITSOV_DEV_EXTERNAL_NODE must be absolute" ;; esac
  case "$BITSOV_DEV_EXTERNAL_NODE" in *[\<\>\&]*) die "BITSOV_DEV_EXTERNAL_NODE has XML characters" ;; esac
  env_block="  <key>LSEnvironment</key>
  <dict>
    <key>BITSOV_DEV_EXTERNAL_NODE</key>
    <string>$BITSOV_DEV_EXTERNAL_NODE</string>
  </dict>
"
fi

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp "$BIN" "$OUT/Contents/MacOS/$EXE"
chmod 0755 "$OUT/Contents/MacOS/$EXE"
cp "$ICON" "$OUT/Contents/Resources/icon.icns"

cat > "$OUT/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>$ID</string>
  <key>CFBundleExecutable</key>
  <string>$EXE</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleName</key>
  <string>BitSov Dev External</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
${env_block}</dict>
</plist>
EOF

echo "wrote $OUT"
