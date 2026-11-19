#!/usr/bin/env bash
# Regression tests for verify_release_signature (scripts/fetch-node-sidecar.sh), the
# fail-closed predicate behind the sidecar fetch. No network: local test keys live in a
# throwaway GNUPGHOME under /tmp (short path — gpg-agent socket paths are length-limited).
#
# Covers the accept case and every refusal class GnuPG can report while STILL emitting
# VALIDSIG: a different key, a revoked signing key (REVKEYSIG), an
# expired signing key (EXPKEYSIG), an expired signature (EXPSIG), a tampered file (BADSIG)
# and a missing public key (NO_PUBKEY). Each case asserts the function's exit code AND the
# printed reason. bash 3.2 compatible (macOS /bin/bash). Exit 1 on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
source scripts/fetch-node-sidecar.sh   # functions only: main is guarded on BASH_SOURCE

T="$(mktemp -d /tmp/fnv.XXXXXX)"
trap 'gpgconf --kill gpg-agent >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
export GNUPGHOME="$T/g"
mkdir -m 0700 "$GNUPGHOME"
G=(gpg --batch --yes --quiet --pinentry-mode loopback --passphrase '')

# A moment safely in the past: keys and signatures made "then" with a 1-day life are expired now.
PAST="20260101T120000"

gen_key() { # <uid> <expire> [faked-system-time]  -> prints the new key's fingerprint
  local uid="$1" expire="$2" faked="${3:-}"
  if [ -n "$faked" ]; then
    "${G[@]}" --faked-system-time "$faked" --quick-gen-key "$uid" default default "$expire" 2>/dev/null
  else
    "${G[@]}" --quick-gen-key "$uid" default default "$expire" 2>/dev/null
  fi
  gpg --batch --with-colons --list-keys "$uid" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }'
}
sign() { # <fpr> <file> <out.asc> [extra gpg options...]
  local fpr="$1" file="$2" out="$3"; shift 3
  "${G[@]}" "$@" -u "$fpr" --armor --detach-sign -o "$out" "$file" 2>/dev/null
}

pass=0; fail=0
check() { # <label> <want-rc> <want-reason-regex or ''> <got-rc> <got-output>
  local label="$1" wrc="$2" wre="$3" rc="$4" out="$5"
  if [ "$rc" = "$wrc" ] && { [ -z "$wre" ] || printf '%s\n' "$out" | grep -Eq "$wre"; }; then
    echo "  ok    $label"; pass=$((pass + 1))
  else
    echo "  FAIL  $label (exit $rc, wanted $wrc; wanted reason /$wre/)"
    printf '%s\n' "$out" | sed 's/^/        /'
    fail=$((fail + 1))
  fi
}
run_case() { # <label> <want-rc> <want-reason-regex> <asc> <file> <pin>
  local out rc=0
  out="$(verify_release_signature "$4" "$5" "$6" 2>&1)" || rc=$?
  check "$1" "$2" "$3" "$rc" "$out"
}

printf 'SHA256SUMS test payload\n' > "$T/file"
cp "$T/file" "$T/tampered"; echo "tampered" >> "$T/tampered"

echo "== accept =="
A="$(gen_key "Test Release A <a@test.invalid>" 0)"
sign "$A" "$T/file" "$T/good.asc"
run_case "accept: good signature by the pinned key" 0 '' "$T/good.asc" "$T/file" "$A"

echo "== reject =="
B="$(gen_key "Test Other B <b@test.invalid>" 0)"
sign "$B" "$T/file" "$T/other.asc"
run_case "reject: signature by a different key" 1 'not by the pinned key' "$T/other.asc" "$T/file" "$A"

run_case "reject: tampered file (BADSIG)" 1 'BADSIG' "$T/good.asc" "$T/tampered" "$A"

mkdir -m 0700 "$T/empty"
out=""; rc=0
out="$( (export GNUPGHOME="$T/empty"; verify_release_signature "$T/good.asc" "$T/file" "$A") 2>&1 )" || rc=$?
check "reject: missing public key (NO_PUBKEY)" 1 'NO_PUBKEY' "$rc" "$out"

R="$(gen_key "Test Revoked R <r@test.invalid>" 0)"
sign "$R" "$T/file" "$T/revoked.asc"                       # signed BEFORE the revocation
sed 's/^://' "$GNUPGHOME/openpgp-revocs.d/$R.rev" | "${G[@]}" --import 2>/dev/null
run_case "reject: revoked signing key (REVKEYSIG)" 1 'REVKEYSIG' "$T/revoked.asc" "$T/file" "$R"

E="$(gen_key "Test Expired E <e@test.invalid>" 1d "$PAST")" # created in the past, 1-day life
sign "$E" "$T/file" "$T/expkey.asc" --faked-system-time "$PAST"
run_case "reject: expired signing key (EXPKEYSIG)" 1 'EXPKEYSIG' "$T/expkey.asc" "$T/file" "$E"

# The key must predate the signature, so it is created at PAST too (no expiry); only the
# signature carries a 1-day life. gpg refuses to sign at a faked time before the key existed.
S="$(gen_key "Test SigExpiry S <s@test.invalid>" 0 "$PAST")"
sign "$S" "$T/file" "$T/expsig.asc" --faked-system-time "$PAST" --default-sig-expire 1d
run_case "reject: expired signature (EXPSIG)" 1 'EXPSIG' "$T/expsig.asc" "$T/file" "$S"

echo
total=$((pass + fail))
if [ "$fail" -eq 0 ]; then
  echo "FETCH-VERIFY TESTS: PASS ($pass/$total) — gpg $(gpg --version | head -1 | awk '{print $NF}')"
else
  echo "FETCH-VERIFY TESTS: FAIL ($fail of $total failed)" >&2
  exit 1
fi
