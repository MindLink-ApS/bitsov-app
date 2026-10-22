#!/usr/bin/env bash
# Fetch + VERIFY the pinned, signed BitSov node binary and place it as the Tauri
# sidecar for this host. The node binary is NEVER committed (Gate G1: bundled binary,
# fetched + verified, not vendored). v0.3.0-rc19.2 targets Linux, macOS and Windows node
# binaries, so all three hosts can produce a sidecar. Release assets carry no .exe suffix
# on any host; only the installed Windows sidecar is renamed to .exe (Tauri's resolver).
# rc19.2 is signed and published. Fetch requires release access and
# both SHA256SUMS and SHA256SUMS.asc; missing assets fail closed. Nothing here publishes it.
#
# Verification is fail-closed, in two steps:
#   1. SHA256SUMS.asc must be ACCEPTED by verify_release_signature (below): gpg exits 0, a
#      GOODSIG is present, a VALIDSIG names the pinned release key ($KEY_FPR), and NONE of
#      REVKEYSIG / EXPKEYSIG / EXPSIG / BADSIG / ERRSIG / KEYREVOKED / KEYEXPIRED / SIGEXPIRED /
#      NO_PUBKEY appear. GnuPG emits VALIDSIG next to REVKEYSIG, EXPKEYSIG and EXPSIG too —
#      VALIDSIG is cryptographic validity, not acceptable key/signature status — so those
#      statuses are rejected explicitly and gpg's own exit status is never discarded.
#      If the pinned key is not in the caller's keyring, RELEASE_KEY.asc is fetched from the
#      genome's main into a THROWAWAY keyring (under $TMP, removed on exit) and its
#      fingerprint must equal the pin. The caller's keyring is never written to.
#   2. Each binary must match exactly one valid entry in the signed SHA256SUMS.
#
# Usage: bash scripts/fetch-node-sidecar.sh [--verify-only]
# --verify-only never installs or repairs binaries: it re-downloads the pinned trust
# bundle and verifies EVERY src-tauri/bin/konsensus-* before packaging (Gate G1).
#
# Sourceable: `source scripts/fetch-node-sidecar.sh` defines the functions and fetches
# nothing (main is guarded on BASH_SOURCE). scripts/test-fetch-verify.sh uses that to run
# verify_release_signature against local test keys, including every refusal class above.
set -euo pipefail

TAG="v0.3.0-rc19.2"
REPO="MindLink-ApS/BitSov-bitsov"
KEY_FPR="B299274C200301714DC6F51A7C2D6F8AC842EF6E"

# Binary pins copied from the verified, signed rc19.2 SHA256SUMS.
# Manifest sha256: 142cdd18c20352979bb318664551bbbef10b6e86b6708e14f4751e0c702c0fcb
# These are enforced pins, not illustrative hashes. No flag/environment bypass.
EXPECTED_SHA256SUMS='ebebac6106643a1cbdd3b074ef8cc4ae97ab8030e9db9f87ea2331e139db603a  bitsov-darwin-aarch64
5f0021dfdd48c43d562c5466af27a03cd009b1290cf0c6e9e3ae7bb68167ce3d  bitsov-darwin-x86_64
5579bde984273410e28dedc70e3b8a3152aab0637c95e105c6af0bcd65c14881  bitsov-linux-aarch64
df59ed5649b10dc317cd9c9643109b4e14104d4475661f02cefa8b28d45dcf27  bitsov-linux-x86_64
74905b8b6454722c15b3ddd8198c28551c5d70be83141bacad3608382fccb8d9  bitsov-windows-x86_64'

pinned_checksum() {
  printf '%s\n' "$EXPECTED_SHA256SUMS" | awk -v asset="$1" '
    $2 == asset { count++; hash = $1; if (NF != 2) malformed = 1 }
    END {
      if (count != 1 || malformed || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) exit 1
      print tolower(hash)
    }'
}

require_complete_checksum_pin() {
  local asset
  for asset in bitsov-darwin-aarch64 bitsov-darwin-x86_64 bitsov-linux-aarch64 bitsov-linux-x86_64 bitsov-windows-x86_64; do
    pinned_checksum "$asset" >/dev/null || {
      echo "  REFUSED: checksum pin incomplete for $TAG ($asset); replace every placeholder from verified signed SHA256SUMS" >&2
      return 1
    }
  done
}

# GNU coreutils on Linux, perl shasum on macOS; same check either way.
sha256_of()    { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# verify_release_signature <detached.asc> <file> <pinned-fingerprint>
#
# Accepts (returns 0) ONLY when all of the following hold, in this order of checking:
#   - none of the refusal statuses REVKEYSIG, EXPKEYSIG, EXPSIG, BADSIG, ERRSIG, KEYREVOKED,
#     KEYEXPIRED, SIGEXPIRED, NO_PUBKEY appear on gpg's status output;
#   - gpg --verify itself exited 0 (its exit status is captured, never discarded);
#   - a GOODSIG line is present;
#   - a VALIDSIG line names the pinned fingerprint, either as the signing key (field 1) or as
#     the primary key the signing subkey belongs to (last field).
# Otherwise prints "REFUSED: <reason>" (plus gpg's own diagnostics) to stderr and returns 1.
# Keyring: whatever GNUPGHOME resolves to at call time.
verify_release_signature() {
  local asc="$1" file="$2" pin="$3" out rc=0 bad
  out="$(gpg --batch --status-fd 1 --verify "$asc" "$file" 2>&1)" || rc=$?
  bad="$(printf '%s\n' "$out" | awk '
    $1 == "[GNUPG:]" && ($2 == "REVKEYSIG" || $2 == "EXPKEYSIG" || $2 == "EXPSIG" ||
                         $2 == "BADSIG"    || $2 == "ERRSIG"    || $2 == "KEYREVOKED" ||
                         $2 == "KEYEXPIRED" || $2 == "SIGEXPIRED" || $2 == "NO_PUBKEY") { print $2 }
  ' | sort -u | tr '\n' ' ')"
  if [ -n "$bad" ]; then
    echo "  REFUSED: gpg reported ${bad% }" >&2
    printf '%s\n' "$out" | grep -v '^\[GNUPG:\]' | sed 's/^/    /' >&2 || true
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "  REFUSED: gpg --verify exited $rc" >&2
    printf '%s\n' "$out" | grep -v '^\[GNUPG:\]' | sed 's/^/    /' >&2 || true
    return 1
  fi
  if ! printf '%s\n' "$out" | awk '$1 == "[GNUPG:]" && $2 == "GOODSIG" { ok = 1 } END { exit !ok }'; then
    echo "  REFUSED: no GOODSIG on the status output" >&2
    return 1
  fi
  if ! printf '%s\n' "$out" | awk -v pin="$pin" '
    $1 == "[GNUPG:]" && $2 == "VALIDSIG" && ($3 == pin || $NF == pin) { ok = 1 } END { exit !ok }'; then
    echo "  REFUSED: VALIDSIG is not by the pinned key $pin" >&2
    return 1
  fi
  return 0
}

# Shared by fetch and pre-bundle verification. A subshell confines GNUPGHOME
# changes to this check; neither path imports into the caller's keyring.
download_verified_checksums() (
  local dir="$1" imported
  echo "→ downloading trust bundle from $REPO@$TAG"
  gh release download "$TAG" --repo "$REPO" -p "SHA256SUMS" -p "SHA256SUMS.asc" --dir "$dir" --clobber \
    || { echo "  REFUSED: cannot obtain $REPO@$TAG signed SHA256SUMS" >&2; return 1; }
  echo "→ verifying GPG signature (pinned release key $KEY_FPR)"
  if ! gpg --batch --list-keys "$KEY_FPR" >/dev/null 2>&1; then
    echo "  pinned key not in the local keyring; importing RELEASE_KEY.asc from $REPO@main into a throwaway keyring"
    export GNUPGHOME="$dir/gnupg"
    mkdir -m 0700 "$GNUPGHOME" || return 1
    gh api "repos/$REPO/contents/RELEASE_KEY.asc?ref=main" -H "Accept: application/vnd.github.raw" > "$dir/RELEASE_KEY.asc" \
      || { echo "  REFUSED: cannot obtain RELEASE_KEY.asc from $REPO@main" >&2; return 1; }
    gpg --batch --import "$dir/RELEASE_KEY.asc" >/dev/null 2>&1 \
      || { echo "  FAIL: could not import RELEASE_KEY.asc from $REPO@main" >&2; exit 1; }
    imported="$(gpg --batch --with-colons --list-keys 2>/dev/null || true)"
    if ! grep -q "^fpr:.*:${KEY_FPR}:\$" <<<"$imported"; then
      echo "  FAIL: RELEASE_KEY.asc from $REPO@main does not carry the pinned fingerprint $KEY_FPR" >&2
      exit 1
    fi
  fi
  verify_release_signature "$dir/SHA256SUMS.asc" "$dir/SHA256SUMS" "$KEY_FPR" \
    || { echo "  FAIL: SHA256SUMS.asc was not accepted; no sidecar accepted" >&2; exit 1; }
  echo "  ✓ SHA256SUMS is signed by $KEY_FPR"
)

# Exact mapping, including Windows' installed-only .exe suffix. Unknown names
# must never be treated as a host default or silently ignored.
sidecar_asset() {
  case "${1##*/}" in
    konsensus-x86_64-unknown-linux-gnu) echo bitsov-linux-x86_64 ;;
    konsensus-aarch64-unknown-linux-gnu) echo bitsov-linux-aarch64 ;;
    konsensus-aarch64-apple-darwin) echo bitsov-darwin-aarch64 ;;
    konsensus-x86_64-apple-darwin) echo bitsov-darwin-x86_64 ;;
    konsensus-x86_64-pc-windows-msvc.exe) echo bitsov-windows-x86_64 ;;
    *) return 1 ;;
  esac
}

# Checks bytes without executing the binary. A missing/duplicate/malformed entry
# is not evidence of membership in the pinned release, even in a signed manifest.
verify_asset_checksum() {
  local file="$1" asset="$2" sums="$3" expected actual pinned
  actual="$(sha256_of "$file")" || return 1
  expected="$(awk -v asset="$asset" '
    $2 == asset || $2 == "*" asset {
      count++; hash = $1; if (NF != 2) malformed = 1
    }
    END {
      if (count != 1 || malformed || length(hash) != 64 || hash ~ /[^0-9a-fA-F]/) exit 1
      print tolower(hash)
    }' "$sums")" || {
      echo "  REFUSED: $file is not identified by $REPO@$TAG SHA256SUMS ($asset)" >&2
      echo "    expected sha256: unavailable (missing, duplicate or malformed release entry)" >&2
      echo "    actual sha256:   $actual" >&2
      return 1
    }
  pinned="$(pinned_checksum "$asset")" || {
    echo "  REFUSED: checksum pin incomplete for $TAG ($asset)" >&2
    return 1
  }
  if [ "$expected" != "$pinned" ]; then
    echo "  REFUSED: signed SHA256SUMS differs from the checksum pin for $TAG ($asset)" >&2
    return 1
  fi
  if [ "$actual" != "$expected" ]; then
    echo "  REFUSED: $file does not match $REPO@$TAG ($asset)" >&2
    echo "    expected sha256: $expected" >&2
    echo "    actual sha256:   $actual" >&2
    echo "    Re-fetch with: bash scripts/fetch-node-sidecar.sh" >&2
    return 1
  fi
  echo "  ✓ $file: sha256 $actual ($REPO@$TAG)"
}

verify_installed_sidecars() {
  local file asset actual found=0
  for file in src-tauri/bin/konsensus-*; do
    # A dangling symlink counts as an entry and must be refused too.
    if [ ! -e "$file" ] && [ ! -L "$file" ]; then continue; fi
    found=1
    if [ ! -f "$file" ] || [ -L "$file" ]; then
      echo "  REFUSED: $file must be a regular, non-symlink release binary" >&2
      return 1
    fi
    asset="$(sidecar_asset "$file")" || {
      actual="$(sha256_of "$file")" || return 1
      echo "  REFUSED: $file has no published target in $REPO@$TAG" >&2
      echo "    expected sha256: unavailable (no pinned release asset)" >&2
      echo "    actual sha256:   $actual" >&2
      return 1
    }
    verify_asset_checksum "$file" "$asset" "$TMP/SHA256SUMS" || return 1
  done
  if [ "$found" -eq 0 ]; then
    echo "  REFUSED: no src-tauri/bin/konsensus-* sidecars; run bash scripts/fetch-node-sidecar.sh" >&2
    return 1
  fi
  return 0
}

main() {
  local OS ARCH EXT ASSET TRIPLE SIDECAR
  if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --verify-only ]; }; then
    echo "Usage: $0 [--verify-only]" >&2
    return 2
  fi
  require_complete_checksum_pin || return 1
  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT   # TMP stays global for the trap
  if [ "${1:-}" = --verify-only ]; then
    download_verified_checksums "$TMP" || return 1
    verify_installed_sidecars
    return $?
  fi

  OS="$(uname -s)"; ARCH="$(uname -m)"
  EXT=""
  case "$OS/$ARCH" in
    Linux/x86_64)    TRIPLE="x86_64-unknown-linux-gnu" ;;
    Linux/aarch64)   TRIPLE="aarch64-unknown-linux-gnu" ;;
    Darwin/arm64|Darwin/aarch64) TRIPLE="aarch64-apple-darwin" ;;
    Darwin/x86_64)   TRIPLE="x86_64-apple-darwin" ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64|Windows_NT/x86_64)
                     TRIPLE="x86_64-pc-windows-msvc"; EXT=".exe" ;;
    *) echo "No signed node binary is published for $OS/$ARCH at $TAG." >&2
       echo "Published hosts: Linux x86_64/aarch64, macOS arm64/x86_64, Windows x86_64." >&2
       return 2 ;;
  esac
  SIDECAR="src-tauri/bin/konsensus-$TRIPLE$EXT"
  ASSET="$(sidecar_asset "$SIDECAR")"
  download_verified_checksums "$TMP" || return 1
  echo "→ downloading $ASSET from $REPO@$TAG"
  gh release download "$TAG" --repo "$REPO" -p "$ASSET" --dir "$TMP" --clobber
  verify_asset_checksum "$TMP/$ASSET" "$ASSET" "$TMP/SHA256SUMS" || return 1

  mkdir -p src-tauri/bin
  install -m 0755 "$TMP/$ASSET" "$SIDECAR"
  echo "✓ sidecar ready: $SIDECAR"
  echo "  sha256: $(sha256_of "$SIDECAR")"
}

if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  main "$@"
fi
