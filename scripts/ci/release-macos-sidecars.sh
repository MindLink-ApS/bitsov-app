#!/usr/bin/env bash
# Combine authenticated thin binaries; verify both slices again before bundling.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source scripts/fetch-node-sidecar.sh

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --verify-only ]; }; then
  echo "Usage / Brug: $0 [--verify-only]" >&2
  exit 2
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
require_complete_checksum_pin
download_verified_checksums "$TMP"
out=src-tauri/target/release-sidecar
if [ "${1:-}" != --verify-only ]; then
  mkdir -p src-tauri/bin "$out"
  for triple in aarch64-apple-darwin x86_64-apple-darwin; do
    asset="$(sidecar_asset "konsensus-$triple")"
    gh release download "$TAG" --repo "$REPO" -p "$asset" --dir "$TMP" --clobber
    verify_asset_checksum "$TMP/$asset" "$asset" "$TMP/SHA256SUMS"
    install -m 0755 "$TMP/$asset" "src-tauri/bin/konsensus-$triple"
    install -m 0755 "$TMP/$asset" "$out/konsensus-$triple"
  done
  lipo -create "$out/konsensus-aarch64-apple-darwin" "$out/konsensus-x86_64-apple-darwin" \
    -output "$out/konsensus-universal-apple-darwin"
fi
verify_installed_sidecars
lipo -verify_arch arm64 x86_64 "$out/konsensus-universal-apple-darwin"
for pair in arm64:aarch64 x86_64:x86_64; do
  arch="${pair%%:*}"
  triple="${pair#*:}-apple-darwin"
  cmp "src-tauri/bin/konsensus-$triple" "$out/konsensus-$triple"
  lipo "$out/konsensus-universal-apple-darwin" -thin "$arch" -output "$TMP/$arch"
  cmp "src-tauri/bin/konsensus-$triple" "$TMP/$arch"
done
