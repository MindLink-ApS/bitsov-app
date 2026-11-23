#!/usr/bin/env bash
# Local Intel remote-only package from an exact source archive or checkout.
# Usage: bash scripts/build-local-mac-intel.sh <full-source-sha>
# No app launch, signing credentials, notarization or publishing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "$#" != 1 ] || [[ ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "A full 40-character lowercase source SHA is required." >&2
  exit 2
fi
SOURCE_SHA="$1"
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Local Intel packaging requires a native x86_64 macOS host." >&2
  exit 2
fi
if ! TRANSLATED="$(sysctl -in sysctl.proc_translated 2>/dev/null)"; then
  echo "Cannot determine whether this Intel process is translated." >&2
  exit 2
fi
case "$TRANSLATED" in
  0|"") ;;
  *) echo "Local Intel packaging refuses Rosetta or an unknown translation state." >&2; exit 2 ;;
esac

# The source SHA is supplied by the archive producer; no Git credentials or
# repository metadata are needed on the build host.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
export BITSOV_MAC_SIGNING_IDENTITY=-
export BITSOV_MAC_NOTARY_PROFILE=
export BITSOV_MAC_PROVISION_PROFILE=
export BITSOV_USE_EXISTING_SIDECAR=0
bash scripts/package-mac.sh --arch x86_64 --dmg --remote-only

BUNDLE="$CARGO_TARGET_DIR/x86_64-apple-darwin/release/bundle"
APP="$BUNDLE/macos/BitSov Remote Test.app"
OUT="$BUNDLE/dmg"
PLIST="$APP/Contents/Info.plist"
BUNDLE_ID="$(plutil -extract CFBundleIdentifier raw -o - "$PLIST")"
PRODUCT="$(plutil -extract CFBundleName raw -o - "$PLIST")"
PLIST_MIN="$(plutil -extract LSMinimumSystemVersion raw -o - "$PLIST")"
test "$BUNDLE_ID" = tech.mindlink.bitsov.remotetest
test "$PRODUCT" = 'BitSov Remote Test'
test -n "$PLIST_MIN"

# Record every Mach-O deployment minimum, including legacy load commands.
# Stage metadata until inspection succeeds; an incomplete receipt has no manifest.
INFO="$(mktemp "$OUT/.build-info.XXXXXX")"
trap 'rm -f "$INFO"' EXIT
PROFILE_HASH="$(shasum -a 256 src-tauri/src/profile.rs | awk '{print $1}')"
CONFIG_HASH="$(shasum -a 256 src-tauri/tauri.remote-only.conf.json | awk '{print $1}')"
NODE_VERSION="$(node --version)"
NPM_VERSION="$(npm --version)"
RUST_VERSION="$(rustc --version)"
CARGO_VERSION="$(cargo --version)"
CLANG_VERSION="$(xcrun clang --version | sed -n '1p')"
MACOS_VERSION="$(sw_vers -productVersion)"
{
  echo "source.sha=$SOURCE_SHA"
  echo "bundle.identifier=$BUNDLE_ID"
  echo "product.name=$PRODUCT"
  echo "app.arch=x86_64"
  echo "target=x86_64-apple-darwin"
  echo "LSMinimumSystemVersion=$PLIST_MIN"
  echo "profile=remote-only; signet-only (selected by bundle identifier)"
  echo "bundled.node=absent (checked before signing)"
  echo "profile.rs.sha256=$PROFILE_HASH"
  echo "config.sha256=$CONFIG_HASH"
  echo "signing=ad-hoc"
  echo "notarization=none"
  echo "node=$NODE_VERSION"
  echo "npm=$NPM_VERSION"
  echo "rustc=$RUST_VERSION"
  echo "cargo=$CARGO_VERSION"
  echo "clang=$CLANG_VERSION"
  echo "macOS=$MACOS_VERSION"
} > "$INFO"
while IFS= read -r -d '' code; do
  description="$(file -b "$code")"
  case "$description" in
    *Mach-O*)
      minima="$(otool -l "$code" | awk '
        $1 == "cmd" { mode=$2 }
        mode == "LC_BUILD_VERSION" && $1 == "minos" { print $2 }
        mode == "LC_VERSION_MIN_MACOSX" && $1 == "version" { print $2 }
      ')"
      if [ -z "$minima" ]; then
        echo "Missing Mach-O deployment minimum: ${code#"$APP/"}" >&2
        exit 1
      fi
      while IFS= read -r minimum; do
        echo "Mach-O ${code#"$APP/"} minos=$minimum" >> "$INFO"
      done <<< "$minima"
      ;;
  esac
done < <(find "$APP/Contents" -type f -print0)
mv "$INFO" "$OUT/build-info.txt"
ZIP="$OUT/BitSov-remote-test-macos-x86_64.app.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
(
  cd "$OUT"
  shasum -a 256 ./*.dmg "${ZIP##*/}" build-info.txt | sed 's@  \./@  @' > SHA256SUMS
  shasum -a 256 -c SHA256SUMS
)
echo "Local Intel artifacts and verified SHA256SUMS: $OUT"
