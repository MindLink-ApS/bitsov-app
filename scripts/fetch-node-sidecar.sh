#!/usr/bin/env bash
# Fetch + VERIFY the pinned, signed BitSov node binary and place it as the Tauri
# sidecar for this host. The node binary is NEVER committed (Gate G1: bundled binary,
# fetched + verified, not vendored). v0.3.0-rc8 publishes Linux, macOS and Windows node
# binaries, so all three hosts can produce a sidecar. Release assets carry no .exe suffix
# on any host; only the installed Windows sidecar is renamed to .exe (Tauri's resolver).
# DO-NOT-MERGE: v0.3.0-rc8 must be a PUBLISHED pre-release before this pin lands.
# After publish, `gh release download` reaches it with any gh, a CI
# repo-scoped GITHUB_TOKEN included. Nothing here publishes anything.
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
#   2. The downloaded binary must match its line in the signed SHA256SUMS.
#
# Sourceable: `source scripts/fetch-node-sidecar.sh` defines the functions and fetches
# nothing (main is guarded on BASH_SOURCE). scripts/test-fetch-verify.sh uses that to run
# verify_release_signature against local test keys, including every refusal class above.
set -euo pipefail

TAG="v0.3.0-rc8"
REPO="MindLink-ApS/BitSov-bitsov"
KEY_FPR="B299274C200301714DC6F51A7C2D6F8AC842EF6E"

# Placeholders for the signed release trust bundle. Fill after genome v0.3.0-rc8
# is tagged, CI has staged assets, and SHA256SUMS.asc is published. Verification
# still uses the downloaded SHA256SUMS / .asc; these fields are operator
# cross-checks for the pin PR that merges after publish.
# shellcheck disable=SC2034
EXPECTED_TAG_SOURCE_SHA="REPLACE_ME_AFTER_TAG"
EXPECTED_SHA256SUMS_SHA256="REPLACE_ME_AFTER_PUBLISH"
EXPECTED_SHA256SUMS_ASC_SHA256="REPLACE_ME_AFTER_PUBLISH"

# GNU coreutils on Linux, perl shasum on macOS; same check either way.
sha256_check() { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi; }
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

main() {
  local OS ARCH EXT ASSET TRIPLE SIDECAR imported
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

  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT   # TMP stays global: the trap runs after main returns
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
  verify_release_signature "$TMP/SHA256SUMS.asc" "$TMP/SHA256SUMS" "$KEY_FPR" \
    || { echo "  FAIL: SHA256SUMS.asc was not accepted; nothing installed" >&2; exit 1; }
  echo "  ✓ SHA256SUMS is signed by $KEY_FPR"

  echo "→ verifying sha256 of $ASSET against the signed SHA256SUMS"
  ( cd "$TMP" && grep " $ASSET\$" SHA256SUMS | sha256_check )

  mkdir -p src-tauri/bin
  install -m 0755 "$TMP/$ASSET" "$SIDECAR"
  echo "✓ sidecar ready: $SIDECAR"
  echo "  sha256: $(sha256_of "$SIDECAR")"
}

if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then
  main "$@"
fi
