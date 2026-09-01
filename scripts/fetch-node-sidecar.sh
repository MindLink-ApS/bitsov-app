#!/usr/bin/env bash
# Fetch + VERIFY the pinned, signed BitSov node binary and place it as the Tauri
# sidecar for this host. The node binary is NEVER committed (Gate G1: bundled binary,
# fetched + verified, not vendored). v0.3.0-rc5 publishes Linux, macOS and Windows node
# binaries, so all three hosts can produce a sidecar. Release assets carry no .exe suffix
# on any host; only the installed Windows sidecar is renamed to .exe (Tauri's resolver).
# rc5 is still a DRAFT release: `gh release download` reaches it with an authenticated gh,
# and this script must not publish it.
set -euo pipefail

TAG="v0.3.0-rc5"
REPO="MindLink-ApS/BitSov-bitsov"
KEY_FPR="B299274C200301714DC6F51A7C2D6F8AC842EF6E"
OS="$(uname -s)"; ARCH="$(uname -m)"
EXT=""   # sidecar filename suffix; Windows only
case "$OS/$ARCH" in
  Linux/x86_64)    ASSET="bitsov-linux-x86_64";   TRIPLE="x86_64-unknown-linux-gnu"  ;;
  Linux/aarch64)   ASSET="bitsov-linux-aarch64";  TRIPLE="aarch64-unknown-linux-gnu" ;;
  Darwin/arm64|Darwin/aarch64) ASSET="bitsov-darwin-aarch64"; TRIPLE="aarch64-apple-darwin" ;;
  Darwin/x86_64)   ASSET="bitsov-darwin-x86_64";  TRIPLE="x86_64-apple-darwin" ;;
  MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64|Windows_NT/x86_64)
                   ASSET="bitsov-windows-x86_64"; TRIPLE="x86_64-pc-windows-msvc"; EXT=".exe" ;;
  *) echo "No signed node binary is published for $OS/$ARCH at $TAG." >&2
     echo "Published hosts: Linux x86_64/aarch64, macOS arm64/x86_64, Windows x86_64." >&2
     exit 2 ;;
esac
SIDECAR="src-tauri/bin/konsensus-$TRIPLE$EXT"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "→ downloading $ASSET + trust bundle from $REPO@$TAG"
gh release download "$TAG" --repo "$REPO" -p "$ASSET" -p "SHA256SUMS" -p "SHA256SUMS.asc" --dir "$TMP" --clobber

echo "→ verifying GPG signature (key $KEY_FPR)"
if gpg --list-keys "$KEY_FPR" >/dev/null 2>&1; then
  gpg --verify "$TMP/SHA256SUMS.asc" "$TMP/SHA256SUMS"
else
  echo "  WARN: release key not in keyring; import RELEASE_KEY.asc from $REPO to verify the signature." >&2
fi
echo "→ verifying sha256"
( cd "$TMP" && grep " $ASSET\$" SHA256SUMS | shasum -a 256 -c - )

mkdir -p src-tauri/bin
install -m 0755 "$TMP/$ASSET" "$SIDECAR"
echo "✓ sidecar ready: $SIDECAR"
echo "  sha256: $(shasum -a 256 "$SIDECAR" | awk '{print $1}')"

# Released-node workaround (still needed at rc5): the node resolves SQLite migrations at runtime from
# KONSENSUS_SQLITE_MIGRATIONS_DIR (else the build-host CARGO_MANIFEST_DIR, absent on the target),
# but the release ships only the binary. Fetch the migrations from the SAME source-ref as the
# node binary ($TAG) so schema and binary match; they are bundled beside the node (tauri.conf
# resources) and pointed at by KONSENSUS_SQLITE_MIGRATIONS_DIR in main.rs / the smoke. Remove when
# a node release embeds/ships migrations. See docs/CS1_RUNBOOK.md + the BitSov-bitsov issue.
echo "→ fetching node SQLite migrations pinned to $TAG"
mkdir -p src-tauri/migrations
gh api "repos/$REPO/contents/crates/konsensus-storage/migrations?ref=$TAG" \
  --jq '.[] | select(.name | endswith(".sql")) | "\(.name)\t\(.download_url)"' \
  | while IFS=$'\t' read -r name url; do
      curl -fsSL "$url" -o "src-tauri/migrations/$name"
    done
echo "✓ migrations ready: $(ls src-tauri/migrations/*.sql 2>/dev/null | wc -l | tr -d ' ') file(s) in src-tauri/migrations/ (pinned $TAG)"
