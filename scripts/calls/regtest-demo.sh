#!/usr/bin/env bash
# 1:1 calls prototype demo, regtest only (overnight ticket A, step 2).
#
#   scripts/calls/regtest-demo.sh /absolute/path/to/genome-with-calls [OUT_DIR]
#
# 1. Genome: two real konsensus nodes (A, B) and a routing node C on real
#    Bitcoin Core + electrs + LDK regtest (A -- C -- B). A asks B's call price,
#    pays one call offer at B's call_msat, B answers, ICE, B hangs up; a reused
#    call id and a signal after hangup are refused before paying; channels and
#    budgets reconcile to the msat. (`real_ldk_regtest_calls`)
# 2. App: real WebRTC media between two isolated Chromium pages running the
#    app's own call engine (src/control/call.ts), host candidates only.
#
# Needs cached BITCOIND_EXE / ELECTRS_EXE (see genome docs/regtest-e2e.md) and
# Python Playwright with a cached Chromium. Nothing is downloaded. Mainnet and
# any running pilot node are never touched: every node here is disposable.
set -euo pipefail
GENOME="${1:?usage: $0 /path/to/genome [OUT_DIR]}"
APP="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${2:-$(mktemp -d "${TMPDIR:-/tmp}/calls-demo.XXXXXX")}"
mkdir -p "$OUT"
echo "Evidence: $OUT"
(cd "$GENOME" && REGTEST_TEST="regtest_e2e::real_ldk_regtest_calls" bash scripts/regress/regtest_e2e.sh) 2>&1 \
  | tee "$OUT/regtest-calls.log" | grep -E "STEP PASS|CALL RECONCILED|REGTEST-CALLS|offer paid|answer paid|A asked|test result|panicked"
grep -q "REGTEST-CALLS complete" "$OUT/regtest-calls.log"
python3 "$APP/scripts/calls/media-check.py" --out "$OUT" | tee "$OUT/media-check.log"
echo "CALLS DEMO PASS: $OUT"
