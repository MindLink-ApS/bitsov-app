#!/usr/bin/env bash
# Fetch + VERIFY the pinned, signed BitSov node binary and place it as the Tauri
# sidecar for this host. The node binary is NEVER committed (Gate G1: bundled binary,
# fetched + verified, not vendored). CS-1 is LINUX-ONLY: the public v0.3.0-rc4 release
# ships only Linux node binaries. macOS/Windows sidecars await published signed builds.
set -euo pipefail

TAG="v0.3.0-rc4"
REPO="MindLink-ApS/BitSov-bitsov"
KEY_FPR="B299274C200301714DC6F51A7C2D6F8AC842EF6E"
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/x86_64)  ASSET="bitsov-linux-x86_64";  TRIPLE="x86_64-unknown-linux-gnu"  ;;
  Linux/aarch64) ASSET="bitsov-linux-aarch64"; TRIPLE="aarch64-unknown-linux-gnu" ;;
  *) echo "CS-1 is Linux-only: no signed node binary is published for $OS/$ARCH yet." >&2
     echo "See docs/CS1_RUNBOOK.md (blocker: publish signed macOS/Windows node binaries)." >&2
     exit 2 ;;
esac

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
install -m 0755 "$TMP/$ASSET" "src-tauri/bin/konsensus-$TRIPLE"
echo "✓ sidecar ready: src-tauri/bin/konsensus-$TRIPLE"
echo "  sha256: $(shasum -a 256 "src-tauri/bin/konsensus-$TRIPLE" | awk '{print $1}')"

# rc4 workaround: the released node resolves SQLite migrations at runtime from
# KONSENSUS_SQLITE_MIGRATIONS_DIR (else the build-host CARGO_MANIFEST_DIR, absent on the target),
# but the rc4 release ships only the binary. Fetch the migrations from the SAME source-ref as the
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
