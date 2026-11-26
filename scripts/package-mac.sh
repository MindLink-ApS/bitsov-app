#!/usr/bin/env bash
# Build, sign and verify a native BitSov.app (optionally also a .dmg) on macOS.
# Ad-hoc by default; see docs/MAC_PACKAGE.md for Developer ID / notary hooks.
#
# No publishing. This script never opens, launches or executes the built app
# or the bundled node. Notarization is opt-in; nothing here binds a port.
#
# Usage: scripts/package-mac.sh [--arch arm64|x86_64] [--dmg] [--beta|--remote-only] [--call-seal] [--use-existing-sidecar]
#   --arch                  native host architecture; cross builds are refused
#   --beta                  use the separate signet-only beta profile
#   --remote-only           use the existing signet-only remote test profile,
#                           with no sidecar fetch or bundled node
#   --dmg                   create a plain .dmg from the verified app
#                           (no Finder layout or Applications shortcut)
#   --call-seal             enable sealed call audio for a test build
#   --use-existing-sidecar  bundle the sidecar already at
#                           src-tauri/bin/konsensus-<target> instead
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
CALL_SEAL=0
BETA=0
REMOTE_ONLY=0
ARCH=""
TARGETED=0
USE_EXISTING="${BITSOV_USE_EXISTING_SIDECAR:-0}"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch)
      case "${2:-}" in
        arm64|x86_64) ;;
        *) echo "--arch requires arm64 or x86_64" >&2; exit 2 ;;
      esac
      ARCH="$2"; TARGETED=1; shift ;;
    --dmg) WANT_DMG=1 ;;
    --call-seal) CALL_SEAL=1 ;;
    --beta) BETA=1 ;;
    --remote-only) REMOTE_ONLY=1 ;;
    --use-existing-sidecar) USE_EXISTING=1 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
if [ "$REMOTE_ONLY" = 1 ] && { [ "$BETA" = 1 ] || [ "$USE_EXISTING" = 1 ]; }; then
  echo "--remote-only cannot be combined with --beta or existing-sidecar mode." >&2
  exit 2
fi
if [ "$REMOTE_ONLY" = 1 ]; then
  node -e '
    const c = require("./src-tauri/tauri.remote-only.conf.json");
    if (c.identifier !== "tech.mindlink.bitsov.remotetest" ||
        c.productName !== "BitSov Remote Test" ||
        !Array.isArray(c.bundle.externalBin) || c.bundle.externalBin.length !== 0) {
      throw new Error("Remote-only packaging requires the remote test identifier, product and no external binaries");
    }
  '
fi

HOST_ARCH="$(uname -m)"
if [ "$(uname -s)" != Darwin ]; then
  echo "package-mac.sh requires a native macOS arm64 or x86_64 host." >&2
  exit 2
fi
ARCH="${ARCH:-$HOST_ARCH}"
case "$ARCH" in
  arm64) TRIPLE="aarch64-apple-darwin"; DMG_ARCH=aarch64 ;;
  x86_64) TRIPLE="x86_64-apple-darwin"; DMG_ARCH=x86_64; TARGETED=1 ;;
  *) echo "--arch must be arm64 or x86_64; universal packages are unsupported." >&2; exit 2 ;;
esac
if [ "$HOST_ARCH" != "$ARCH" ]; then
  echo "--arch $ARCH requires a native $ARCH host (found $HOST_ARCH)." >&2
  exit 2
fi
if [ "$ARCH" = x86_64 ]; then
  if ! TRANSLATED="$(sysctl -in sysctl.proc_translated 2>/dev/null)"; then
    echo "Cannot determine whether this Intel process is translated." >&2
    exit 2
  fi
  if [ "$TRANSLATED" = 1 ]; then
    echo "The Intel package requires a native Intel host; Rosetta builds are unsupported." >&2
    exit 2
  fi
fi
# Preserve the original implicit arm64 command and paths. Explicit native
# targets use Cargo's target subdirectory and honor the caller's target root.
TARGET_DIR="src-tauri/target"
BUNDLE_DIR="$TARGET_DIR/release/bundle"
if [ "$TARGETED" = 1 ]; then
  TARGET_DIR="${CARGO_TARGET_DIR:-src-tauri/target}"
  BUNDLE_DIR="$TARGET_DIR/$TRIPLE/release/bundle"
fi
case "$TARGET_DIR" in
  /*) CARGO_OUTPUT="$TARGET_DIR" ;;
  *) CARGO_OUTPUT="$ROOT/$TARGET_DIR" ;;
esac
SIDECAR="src-tauri/bin/konsensus-$TRIPLE"
# The MCP shim (crate bitsov-mcp), built from this checkout for the same target.
SHIM="src-tauri/bin/bitsov-mcp-$TRIPLE"
APP="$BUNDLE_DIR/macos/BitSov.app"
if [ "$BETA" = 1 ]; then
  APP="$BUNDLE_DIR/macos/BitSov Beta.app"
fi
if [ "$REMOTE_ONLY" = 1 ]; then
  APP="$BUNDLE_DIR/macos/BitSov Remote Test.app"
fi
DMG_DIR="$BUNDLE_DIR/dmg"

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
if [ "$REMOTE_ONLY" = 1 ]; then
  echo "→ remote-only profile: no sidecar"
else
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
fi

echo "== 1b. MCP shim =="
if [ "$REMOTE_ONLY" = 1 ]; then
  echo "→ remote-only profile: no MCP shim"
else
  # Never bundle a stale or foreign shim: build it from this checkout every time.
  rm -f src-tauri/bin/bitsov-mcp-*
  CARGO_TARGET_DIR="$CARGO_OUTPUT" cargo build --locked --release \
    --manifest-path src-tauri/Cargo.toml -p bitsov-mcp --target "$TRIPLE"
  cp "$CARGO_OUTPUT/$TRIPLE/release/bitsov-mcp" "$SHIM"
  chmod 0755 "$SHIM"
  test -x "$SHIM"
fi

echo "== 2. app bundle build =="
npm ci --ignore-scripts --no-audit --no-fund
# Never inspect or upload stale artifacts. Build only the app: Tauri's DMG
# would snapshot it before our final signing and verification.
rm -rf "$BUNDLE_DIR"
BUILD_LOG="$TARGET_DIR/package-mac.log"
mkdir -p "$TARGET_DIR"
BUILD_ARGS=(build --bundles app --no-sign --ci)
if [ "$TARGETED" = 1 ]; then
  BUILD_ARGS+=(--target "$TRIPLE")
  BUILD_LOG="$TARGET_DIR/package-mac-$TRIPLE.log"
fi
if [ "$BETA" = 1 ]; then
  BUILD_ARGS+=(--config src-tauri/tauri.beta.conf.json)
fi
if [ "$REMOTE_ONLY" = 1 ]; then
  BUILD_ARGS+=(--config src-tauri/tauri.remote-only.conf.json)
fi
if [ "$CALL_SEAL" = 1 ]; then
  BUILD_ARGS+=(--features call-seal)
  export VITE_CALL_SEAL=sealed
fi
# Tauri finishes sidecar placement, resources and Info.plist before returning.
# Its release environment also excludes assistant.html from dist.
# Use the same output root for Cargo and every packaging/checking step.
CARGO_TARGET_DIR="$CARGO_OUTPUT" CI=true TAURI_BUNDLER_DMG_IGNORE_CI=false \
  npm run tauri -- "${BUILD_ARGS[@]}" -- --locked 2>&1 | tee "$BUILD_LOG"

echo "== 3. static checks =="
CHECK_ARGS=(--arch "$ARCH" --app "$APP" --sidecar "$SIDECAR" --dist dist)
if [ "$REMOTE_ONLY" = 1 ]; then
  CHECK_ARGS+=(--remote-only)
else
  CHECK_ARGS+=(--shim "$SHIM")
fi
bash scripts/check-mac-bundle.sh "${CHECK_ARGS[@]}"

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
  KEYCHAIN_ENTITLEMENTS="$TARGET_DIR/mac-keychain-entitlements.plist"
  PROFILE_PLIST="$TARGET_DIR/mac-provision-profile.plist"
  security cms -D -i "$PROVISION_PROFILE" -o "$PROFILE_PLIST"
  CERTIFICATE_PREFIX="$TARGET_DIR/mac-signing-certificate-"
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
  NOTARY_ZIP="$TARGET_DIR/BitSov-notary.zip"
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
if [ "$REMOTE_ONLY" = 1 ]; then
  file "$APP/Contents/MacOS/bitsov-app"
  otool -L "$APP/Contents/MacOS/bitsov-app"
else
  file "$APP/Contents/MacOS/bitsov-app" "$APP/Contents/MacOS/konsensus"
  otool -L "$APP/Contents/MacOS/bitsov-app" "$APP/Contents/MacOS/konsensus"
  echo "sidecar Mach-O minimum:"
  otool -l "$APP/Contents/MacOS/konsensus" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print "  " $0; exit}'
fi
codesign -dvv "$APP" 2>&1 || true
du -sh "$APP"

if [ "$WANT_DMG" = 1 ]; then
  echo "== 7. dmg from verified app =="
  VERSION="$(node -p 'require("./src-tauri/tauri.conf.json").version')"
  DMG="$DMG_DIR/BitSov_${VERSION}_${DMG_ARCH}.dmg"
  mkdir -p "$DMG_DIR"
  # Hosted runners sometimes report a transient busy device. Retry that one
  # error once, from a clean path; every other failure stops at once.
  for attempt in 1 2; do
    rm -f "$DMG"
    if hdiutil_out="$(hdiutil create -srcfolder "$APP" -volname BitSov -format UDZO "$DMG" 2>&1)"; then
      printf '%s\n' "$hdiutil_out"
      break
    else
      hdiutil_status=$?
    fi
    printf '%s\n' "$hdiutil_out" >&2
    rm -f "$DMG"
    if [ "$attempt" = 1 ] && printf '%s' "$hdiutil_out" | grep -q 'Resource busy'; then
      echo "hdiutil reported Resource busy; retrying once in 15 s" >&2
      sleep 15
      continue
    fi
    exit "$hdiutil_status"
  done
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
