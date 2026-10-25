#!/usr/bin/env bash
# Build, sign and verify BitSov.app (optionally also a .dmg) on Apple Silicon.
# Ad-hoc by default; see docs/MAC_PACKAGE.md for Developer ID / notary hooks.
#
# No publishing. This script never opens, launches or executes the built app
# or the bundled node. Notarization is opt-in; nothing here binds a port.
#
# Usage: scripts/package-mac.sh [--dmg] [--use-existing-sidecar]
#   --dmg                   create a plain .dmg from the verified app
#                           (no Finder layout or Applications shortcut)
#   --use-existing-sidecar  bundle the sidecar already at
#                           src-tauri/bin/konsensus-aarch64-apple-darwin instead
#                           of fetching. Every sidecar is still re-verified
#                           against the pinned release before packaging.
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

# The certificate must already be imported/unlocked by the caller. Keep the
# default independent of Tauri's APPLE_* environment variables.
SIGNING_IDENTITY="${BITSOV_MAC_SIGNING_IDENTITY:--}"
NOTARY_PROFILE="${BITSOV_MAC_NOTARY_PROFILE:-}"
PROVISION_PROFILE="${BITSOV_MAC_PROVISION_PROFILE:-}"
if [ "$SIGNING_IDENTITY" != - ] && [ ! -f "$PROVISION_PROFILE" ]; then
  echo "A signed package requires BITSOV_MAC_PROVISION_PROFILE for private Keychain access." >&2
  exit 2
fi
if [ -n "$NOTARY_PROFILE" ] && [ "$SIGNING_IDENTITY" = - ]; then
  echo "BITSOV_MAC_NOTARY_PROFILE requires a Developer ID signing identity." >&2
  exit 2
fi
SIGN_ARGS=(--force --sign "$SIGNING_IDENTITY")
if [ "$SIGNING_IDENTITY" != - ]; then
  SIGN_ARGS+=(--options runtime --timestamp)
fi
APP_SIGN_ARGS=("${SIGN_ARGS[@]}")
if [ "$SIGNING_IDENTITY" != - ]; then
  APP_SIGN_ARGS+=(--entitlements "${BITSOV_MAC_ENTITLEMENTS:-src-tauri/Entitlements.plist}")
fi

echo "== 1. sidecar =="
if [ "$USE_EXISTING" = 1 ]; then
  if [ ! -x "$SIDECAR" ]; then
    echo "--use-existing-sidecar: $SIDECAR is missing or not executable" >&2
    exit 1
  fi
  echo "→ using existing $SIDECAR (subject to pinned-release verification)"
else
  rm -f src-tauri/bin/konsensus-*
  GPG_TMP="$(mktemp -d)"
  trap 'rm -rf "$GPG_TMP"' EXIT
  GNUPGHOME="$GPG_TMP" bash scripts/fetch-node-sidecar.sh
fi
test -x "$SIDECAR"
# No existing-sidecar bypass: verify every entry, including other targets.
bash scripts/fetch-node-sidecar.sh --verify-only

echo "== 2. app bundle build =="
npm ci --ignore-scripts --no-audit --no-fund
# Never inspect or upload stale artifacts. Build only the app: Tauri's DMG
# would snapshot it before our final signing and verification.
rm -rf src-tauri/target/release/bundle
BUILD_LOG="src-tauri/target/package-mac.log"
mkdir -p src-tauri/target
# Tauri finishes sidecar placement, resources and Info.plist before returning.
# Its release environment also excludes assistant.html from dist.
# Pin the output path even if the caller sets a different Cargo target dir.
CARGO_TARGET_DIR="$ROOT/src-tauri/target" CI=true TAURI_BUNDLER_DMG_IGNORE_CI=false \
  npm run tauri -- build --bundles app --no-sign --ci -- --locked 2>&1 | tee "$BUILD_LOG"

echo "== 3. static checks =="
bash scripts/check-mac-bundle.sh --app "$APP" --sidecar "$SIDECAR" --dist dist

# This byte-for-byte comparison must precede signing: codesign changes the
# bundled sidecar, but must never change the authenticated source in bin/.
echo "== 4. final signing (inside out) =="
# Do not use --deep to sign. Visit real files/directories deepest first;
# framework symlinks are deliberately not followed or signed twice.
while IFS= read -r -d '' code; do
  if [ -f "$code" ] && [ ! -L "$code" ]; then
    if file -b "$code" | grep -q 'Mach-O'; then
      # The main executable is signed with its containing app below.
      if [ "$code" != "$APP/Contents/MacOS/bitsov-app" ]; then
        codesign "${SIGN_ARGS[@]}" "$code"
      fi
    fi
  elif [ -d "$code" ] && [ ! -L "$code" ]; then
    case "$code" in
      *.framework|*.app|*.xpc|*.appex|*.bundle)
        codesign "${SIGN_ARGS[@]}" "$code" ;;
    esac
  fi
done < <(find "$APP/Contents" -depth -print0)
codesign "${APP_SIGN_ARGS[@]}" "$APP"

if [ "$SIGNING_IDENTITY" != - ]; then
  # Read the actual signing team, then seal a private Keychain access group.
  # No team identifiers or machine-specific signing settings live in source.
  TEAM_ID="$(codesign -dv --verbose=4 "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
  BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$APP/Contents/Info.plist")"
  KEYCHAIN_ENTITLEMENTS="src-tauri/target/mac-keychain-entitlements.plist"
  PROFILE_PLIST="src-tauri/target/mac-provision-profile.plist"
  security cms -D -i "$PROVISION_PROFILE" -o "$PROFILE_PLIST"
  CERTIFICATE_PREFIX="src-tauri/target/mac-signing-certificate-"
  rm -f "${CERTIFICATE_PREFIX}0"
  codesign --display --extract-certificates "$CERTIFICATE_PREFIX" "$APP"
  python3 scripts/mac-keychain-entitlements.py \
    "${BITSOV_MAC_ENTITLEMENTS:-src-tauri/Entitlements.plist}" \
    "$KEYCHAIN_ENTITLEMENTS" "$TEAM_ID" "$BUNDLE_ID" "$PROFILE_PLIST" "${CERTIFICATE_PREFIX}0"
  cp "$PROVISION_PROFILE" "$APP/Contents/embedded.provisionprofile"
  codesign "${SIGN_ARGS[@]}" --entitlements "$KEYCHAIN_ENTITLEMENTS" "$APP"
fi

verify_app() {
  # A linker signature on a standalone executable is not a bundle seal.
  test -s "$APP/Contents/_CodeSignature/CodeResources"
  codesign --verify --deep --strict --verbose=2 "$APP"
}

echo "== 5. signature verification =="
verify_app
# Optional future release path. Submit a zip, then staple the app BEFORE DMG
# creation, so both app.zip and the image can carry the notarization ticket.
if [ -n "$NOTARY_PROFILE" ]; then
  NOTARY_ZIP="src-tauri/target/BitSov-notary.zip"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"
  xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$NOTARY_ZIP"
  verify_app
fi
# Gatekeeper trust is separate from signature integrity. Ad-hoc is expected
# to be rejected; preserve diagnostics without making that rejection fatal.
if spctl -a -vv -t exec "$APP"; then
  echo "Gatekeeper assessment: accepted"
else
  echo "Gatekeeper assessment: rejected (informational; expected for ad-hoc builds)"
fi

echo "== 6. inspection (informational) =="
file "$APP/Contents/MacOS/bitsov-app" "$APP/Contents/MacOS/konsensus"
otool -L "$APP/Contents/MacOS/bitsov-app" "$APP/Contents/MacOS/konsensus"
echo "sidecar Mach-O minimum:"
otool -l "$APP/Contents/MacOS/konsensus" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print "  " $0; exit}'
codesign -dvv "$APP" 2>&1 || true
du -sh "$APP"

if [ "$WANT_DMG" = 1 ]; then
  echo "== 7. dmg from verified app =="
  VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
  DMG="$DMG_DIR/BitSov_${VERSION}_aarch64.dmg"
  mkdir -p "$DMG_DIR"
  hdiutil create -srcfolder "$APP" -volname BitSov -format UDZO "$DMG"
  if [ "$SIGNING_IDENTITY" != - ]; then
    codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$DMG"
  fi
  if [ -n "$NOTARY_PROFILE" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
  # Checksum verification of the image; does not mount it.
  hdiutil verify "$DMG"
  du -h "$DMG"
fi

echo
echo 'PACKAGE: PASS (structure, source sidecar integrity and final code signature)'
