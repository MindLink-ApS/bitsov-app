#!/usr/bin/env bash
# Fetch + VERIFY the pinned, signed BitSov node binary and place it as the Tauri
# sidecar for this host. The node binary is NEVER committed (Gate G1: bundled binary,
# fetched + verified, not vendored). v0.3.0-rc6 publishes Linux, macOS and Windows node
# binaries, so all three hosts can produce a sidecar. Release assets carry no .exe suffix
# on any host; only the installed Windows sidecar is renamed to .exe (Tauri's resolver).
# rc6 is a PUBLISHED pre-release: `gh release download` reaches it with any gh, a CI
# repo-scoped GITHUB_TOKEN included. Nothing here publishes anything.
#
# Verification is fail-closed, in two steps:
#   1. SHA256SUMS.asc must be a VALIDSIG by the pinned release key ($KEY_FPR). If that key
#      is not in the caller's keyring, RELEASE_KEY.asc is fetched from the genome's main
#      into a THROWAWAY keyring (under $TMP, removed on exit) and its fingerprint must
#      equal the pin. The caller's keyring is never written to.
#   2. The downloaded binary must match its line in the signed SHA256SUMS.
set -euo pipefail

TAG="v0.3.0-rc6"
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

# GNU coreutils on Linux, perl shasum on macOS; same check either way.
sha256_check() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi; }
sha256_of()    { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "→ downloading $ASSET + trust bundle from $REPO@$TAG"
gh release download "$TAG" --repo "$REPO" -p "$ASSET" -p "SHA256SUMS" -p "SHA256SUMS.asc" --dir "$TMP" --clobber

echo "→ verifying GPG signature (pinned release key $KEY_FPR)"
if ! gpg --batch --list-keys "$KEY_FPR" >/dev/null 2>&1; then
  echo "  pinned key not in the local keyring; importing RELEASE_KEY.asc from $REPO@main into a throwaway keyring"
  export GNUPGHOME="$TMP/gnupg"
  mkdir -m 0700 "$GNUPGHOME"
  gh api "repos/$REPO/contents/RELEASE_KEY.asc?ref=main" -H "Accept: application/vnd.github.raw" > "$TMP/RELEASE_KEY.asc"
  gpg --batch --import "$TMP/RELEASE_KEY.asc" >/dev/null 2>&1 \
    || { echo "  FAIL: could not import RELEASE_KEY.asc from $REPO@main" >&2; exit 1; }
  imported="$(gpg --batch --with-colons --list-keys 2>/dev/null || true)"
  if ! grep -q "^fpr:.*:${KEY_FPR}:\$" <<<"$imported"; then
    echo "  FAIL: RELEASE_KEY.asc from $REPO@main does not carry the pinned fingerprint $KEY_FPR" >&2
    exit 1
  fi
fi
status="$(gpg --batch --status-fd 1 --verify "$TMP/SHA256SUMS.asc" "$TMP/SHA256SUMS" 2>/dev/null || true)"
if ! grep -q "^\[GNUPG:\] VALIDSIG .* ${KEY_FPR}\$" <<<"$status"; then
  echo "  FAIL: SHA256SUMS.asc is not a valid signature by the pinned key $KEY_FPR" >&2
  exit 1
fi
echo "  ✓ SHA256SUMS is signed by $KEY_FPR"

echo "→ verifying sha256 of $ASSET against the signed SHA256SUMS"
( cd "$TMP" && grep " $ASSET\$" SHA256SUMS | sha256_check )

mkdir -p src-tauri/bin
install -m 0755 "$TMP/$ASSET" "$SIDECAR"
echo "✓ sidecar ready: $SIDECAR"
echo "  sha256: $(sha256_of "$SIDECAR")"
