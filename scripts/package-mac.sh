#!/usr/bin/env bash
# Build an unsigned local BitSov.app (optionally also a .dmg) on Apple Silicon,
# then check it statically (docs/MAC_PACKAGE.md, plan docs/MAC_PACKAGE_PLAN.md §5).
#
# No signing, notarization or publishing. This script never opens, launches or
# executes the built app or the bundled node: inspection is file / otool /
# plutil / codesign -dvv / hdiutil verify only. Nothing here binds a port.
#
# Usage: scripts/package-mac.sh [--dmg] [--use-existing-sidecar]
#   --dmg                   also build the .dmg (CI=true skips Finder layout;
#                           falls back to a plain image if bundle_dmg.sh fails)
#   --use-existing-sidecar  local dev only: bundle the sidecar already at
#                           src-tauri/bin/konsensus-aarch64-apple-darwin instead
#                           of fetching. This script does NOT re-verify it; use
#                           only a file scripts/fetch-node-sidecar.sh installed.
#                           Same as BITSOV_USE_EXISTING_SIDECAR=1.
# Default: remove every src-tauri/bin/konsensus-* and fetch the pinned release
# with scripts/fetch-node-sidecar.sh (fail-closed signature + sha256 check) into
# a throwaway GNUPGHOME.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WANT_DMG=0
USE_EXISTING="${BITSOV_USE_EXISTING_SIDECAR:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dmg) WANT_DMG=1 ;;
    --use-existing-sidecar) USE_EXISTING=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "package-mac.sh builds the Apple Silicon package on macOS arm64 only." >&2
  exit 2
fi
TRIPLE="aarch64-apple-darwin"
SIDECAR="src-tauri/bin/konsensus-$TRIPLE"
APP="src-tauri/target/release/bundle/macos/BitSov.app"
DMG_DIR="src-tauri/target/release/bundle/dmg"

echo "== 1. sidecar =="
if [ "$USE_EXISTING" = 1 ]; then
  if [ ! -x "$SIDECAR" ]; then
    echo "--use-existing-sidecar: $SIDECAR is missing or not executable" >&2
    exit 1
  fi
  for f in src-tauri/bin/konsensus-*; do
    if [ "$f" != "$SIDECAR" ]; then rm -f "$f"; fi
  done
  echo "→ using existing $SIDECAR (local dev; not re-verified by this script)"
  echo "  sha256: $(shasum -a 256 "$SIDECAR" | awk '{print $1}')"
else
  rm -f src-tauri/bin/konsensus-*
  GPG_TMP="$(mktemp -d)"
  trap 'rm -rf "$GPG_TMP"' EXIT
  GNUPGHOME="$GPG_TMP" bash scripts/fetch-node-sidecar.sh
fi
test -x "$SIDECAR"

echo "== 2. unsigned bundle build =="
npm ci --ignore-scripts --no-audit --no-fund
# A stale .app or .dmg from an earlier run (or a restored CI cache) must not be
# what gets checked or uploaded.
rm -rf src-tauri/target/release/bundle
BUNDLES="app"
if [ "$WANT_DMG" = 1 ]; then BUNDLES="app,dmg"; fi
# The Tauri CLI sets TAURI_ENV_PLATFORM and no TAURI_ENV_DEBUG for this
# release build, so vite.config.ts leaves assistant.html out of dist (checked
# below).
# --ci only disables CLI prompts. The DMG bundler independently reads CI and
# TAURI_BUNDLER_DMG_IGNORE_CI before passing --skip-jenkins to bundle_dmg.sh.
# Force both here so a caller's environment cannot enable Finder automation.
BUILD_LOG="src-tauri/target/package-mac.log"
mkdir -p src-tauri/target
DMG_FALLBACK=0
if CI=true TAURI_BUNDLER_DMG_IGNORE_CI=false \
  npm run tauri -- build --bundles "$BUNDLES" --no-sign --ci -- --locked 2>&1 | tee "$BUILD_LOG"; then
  :
else
  BUILD_STATUS=("${PIPESTATUS[@]}")
  # Only recover the generated DMG script's failure, never npm, compilation,
  # app bundling, or logging failures. The bundle tree was cleared above, and
  # the fresh app must still pass every static check before image creation.
  if [ "${BUILD_STATUS[0]}" -ne 0 ] && [ "${BUILD_STATUS[1]}" -eq 0 ] && \
    [ "$WANT_DMG" = 1 ] && [ -f "$DMG_DIR/bundle_dmg.sh" ] && \
    grep -qF 'error running bundle_dmg.sh' "$BUILD_LOG"; then
    DMG_FALLBACK=1
    echo "Tauri bundle_dmg.sh failed (see $BUILD_LOG); checking the app before falling back to a plain DMG." >&2
  else
    echo "Bundle build failed; see $BUILD_LOG. No DMG fallback attempted." >&2
    exit 1
  fi
fi

echo "== 3. static checks =="
bash scripts/check-mac-bundle.sh --app "$APP" --sidecar "$SIDECAR" --dist dist

echo "== 4. inspection (informational) =="
file "$APP/Contents/MacOS/bitsov-app" "$APP/Contents/MacOS/konsensus"
otool -L "$APP/Contents/MacOS/bitsov-app" "$APP/Contents/MacOS/konsensus"
echo "sidecar Mach-O minimum:"
otool -l "$APP/Contents/MacOS/konsensus" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print "  " $0; exit}'
codesign -dvv "$APP" 2>&1 || true
du -sh "$APP"

if [ "$WANT_DMG" = 1 ]; then
  echo "== 5. dmg =="
  if [ "$DMG_FALLBACK" = 1 ]; then
    VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
    DMG="$DMG_DIR/BitSov_${VERSION}_aarch64.dmg"
    # Discard partial images from the failed bundler. Use only the checked app
    # as input, never the macos directory (which may contain a temporary DMG).
    rm -f "$DMG_DIR"/*.dmg
    echo "→ falling back to hdiutil create -srcfolder BitSov.app -format UDZO (no Finder layout or Applications shortcut)"
    hdiutil create -srcfolder "$APP" -volname BitSov -format UDZO "$DMG"
  fi
  DMG="$(find "$DMG_DIR" -maxdepth 1 -name '*.dmg' -print | head -n 1)"
  if [ -z "$DMG" ] || [ ! -s "$DMG" ]; then
    echo "no .dmg under $DMG_DIR" >&2
    exit 1
  fi
  # Checksum verification of the image; does not mount it.
  hdiutil verify "$DMG"
  du -h "$DMG"
fi

echo
echo 'PACKAGE: PASS (structure and sidecar integrity only)'
