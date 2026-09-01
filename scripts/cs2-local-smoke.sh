#!/usr/bin/env bash
# CS-2 local smoke — first-run fund flow, STATIC binding checks.
#
# Scope: prove the fund flow is wired the way the charter requires, without a running
# node. It is static on purpose: the runtime half of CS-2 ends in "the node saw your
# deposit", which needs real on-chain funds and cannot be asserted in a smoke. The
# node-side contract itself is pinned and verified in docs/API_READINESS.md; the
# runtime identity path stays covered by scripts/cs1-local-smoke.sh (Linux-only).
#
# Checks, in charter terms:
#   - the fund flow is host-mediated: renderer -> Tauri command -> loopback API (G2)
#   - no node credential can reach the renderer (invariant A.3)
#   - the funds UI sits behind an explicit local-trust disclosure (G6)
#   - the recovery-phrase input is write-only and cleared on submit
#   - the pinned onboarding contract (v0.3.0-rc5 / 1ae4d8c9) is what the host calls
#
# Runs on any OS. Does not touch funding at runtime, rooms, messaging, mobile, calls,
# hosted, AI, relay, merge, or deploy.
set -uo pipefail

APP="src/App.tsx"
HOST="src-tauri/src/main.rs"
fail=0

chk() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  PASS  $label"
  else
    echo "  FAIL  $label"
    fail=1
  fi
}
has() { grep -REq "$1" "${@:2}"; }
lacks() { ! grep -REq "$1" "${@:2}"; }

for f in "$APP" "$HOST" src/qr.ts package.json; do
  if [ ! -s "$f" ]; then
    echo "SMOKE: FAIL - missing $f" >&2
    exit 1
  fi
done

CREDENTIAL='(token|jwt|mnemonic|secret|passphrase|privkey|private_key)'

# Field declarations of every #[derive(..., Serialize, ...)] struct in the host, i.e.
# exactly the shapes a Tauri command can hand back to the renderer.
command_response_fields() {
  awk '
    /^#\[derive\(/            { der = $0; next }
    /^(pub )?struct /         { inside = (der ~ /Serialize/); der = ""; next }
    inside && /^}/            { inside = 0; next }
    inside                    { print }
  ' "$HOST"
}
no_credential_in_responses() {
  ! command_response_fields | grep -Eqi "$CREDENTIAL"
}

# The renderer's own model of every host response.
renderer_response_types() {
  awk '/^type /{inside=1} inside{print} inside && /};[[:space:]]*$/{inside=0}' "$APP"
}
no_credential_in_renderer_types() {
  ! renderer_response_types | grep -Eqi "$CREDENTIAL"
}

# Renderer source minus comment-only lines, so architecture notes that *describe* the
# JWT seam are not mistaken for code that handles one.
renderer_code() { cat "$APP" src/qr.ts | grep -vE '^[[:space:]]*(//|\*|/\*)'; }
no_credential_in_renderer_code() {
  ! renderer_code | grep -Eqi '\b(jwt|bearer|auth/local)\b'
}
# The phrase may be written to the host exactly once, and never read back.
mnemonic_is_write_only() {
  [ "$(renderer_code | grep -c 'mnemonic')" = "1" ] &&
    renderer_code | grep 'mnemonic' | grep -q "invoke<RestoreOutcome>"
}

# The command names the renderer is actually allowed to reach.
registered_commands() {
  awk '/generate_handler!\[/{inside=1} inside{print} inside && /\]/{inside=0}' "$HOST"
}
registers_cs2_commands() {
  local name
  for name in node_status fund_state fund_start funding_address payments_balance identity_restore; do
    registered_commands | grep -q "\b${name}\b" || return 1
  done
}

# The body of one top-level `fn` / `async fn` in the host, up to its column-0 brace.
host_fn() {
  awk -v name="$1" '
    index($0, "fn " name "(") == 1       { inside = 1 }
    index($0, "async fn " name "(") == 1 { inside = 1 }
    inside                               { print }
    inside && /^}/                       { exit }
  ' "$HOST"
}

# CS-2.1: adopt the 3141 listener only when GET /identity matches RestoreResponse.node_id.
# RestoreOutcome.restarted stays false unless that listener restarted onto the restored id.
# POST restore writes files; a still-running node keeps the old id until that process is
# replaced. Otherwise actually restart the listener that holds 3141. RestoreOutcome.restarted
# is true only after the process answering 3141 restarted onto the restored identity.
adopt_only_matching_identity() {
  host_fn adopt_matching_identity | grep -q 'fetch_node_id' &&
    host_fn adopt_matching_identity | grep -q 'expected_node_id' &&
    host_fn adopt_matching_identity | grep -Fq 'live != expected_node_id' &&
    host_fn restart_node | grep -q 'adopt_matching_identity' &&
    host_fn restart_node | grep -q 'stop_loopback_listener' &&
    host_fn restart_node | grep -q 'expected_node_id' &&
    host_fn identity_restore | grep -q 'restart_node(&app, &restored.node_id)' &&
    host_fn identity_restore | grep -Fq 'restarted,' &&
    ! host_fn identity_restore | grep -q 'restarted: restored.restart_required'
}
# A random healthy loopback process is never adopted.
never_adopt_random_healthy() {
  ! grep -q 'adopt_healthy_loopback' "$HOST" &&
    grep -q 'A random healthy loopback process is never adopted' "$HOST" &&
    host_fn adopt_matching_identity | grep -q 'live != expected_node_id'
}
http_timeouts_on_health_auth() {
  grep -q 'connect_timeout' "$HOST" &&
    grep -q '\.timeout(' "$HOST"
}
wait_for_health_fails_on_terminated() {
  host_fn wait_for_health | grep -q 'sidecar_terminated' &&
    host_fn spawn_node | grep -q 'CommandEvent::Terminated' &&
    host_fn spawn_node | grep -q 'sidecar_terminated'
}
# IdentityGate restore retry/error is NOT gated on ready.
restore_error_not_gated_on_ready() {
  grep -q 'showIdentityGate' "$APP" &&
    grep -q 'restoreError' "$APP" &&
    grep -q 'setRestoreError' "$APP" &&
    grep -q 'status().ready || restoring() || restoreError()' "$APP" &&
    grep -q 'trustAck() && status().ready' "$APP" &&
    grep -q 'Keep IdentityGate visible while ready is false' "$APP"
}
# A restart re-uses the identity that was just restored: init stays on the first-run path.
restore_path_never_inits() {
  ! host_fn restart_node | grep -q 'init_node' &&
    ! host_fn adopt_matching_identity | grep -q 'init_node' &&
    ! host_fn identity_restore | grep -q 'init_node' &&
    ! host_fn stop_loopback_listener | grep -q 'init_node'
}

echo "== host: fund commands over the loopback control plane =="
chk "host registers the CS-2 commands (and keeps node_status)" \
  registers_cs2_commands
chk "POST /onboarding/start with tier full + funding_amount_sats" \
  has '/onboarding/start' "$HOST"
chk "tier is \"full\" (fund-your-own-node)" \
  has '"tier":\s*"full"' "$HOST"
chk "GET /onboarding/state polled for the funding step" \
  has '/onboarding/state' "$HOST"
chk "pinned step literal funding-seen (v0.3.0-rc5 / 1ae4d8c9)" \
  has 'funding-seen' "$HOST"
chk "GET /payments/funding-address" \
  has '/payments/funding-address' "$HOST"
chk "GET /payments/balance" \
  has '/payments/balance' "$HOST"
chk "POST /identity/restore" \
  has '/identity/restore' "$HOST"
chk "restore restarts the supervised node, never re-inits" \
  has 'restart_node' "$HOST"
chk "adopt only if GET /identity matches RestoreResponse.node_id" \
  adopt_only_matching_identity
chk "do not adopt a random healthy loopback process" \
  never_adopt_random_healthy
chk "wrong-identity listener on 3141 is actually restarted" \
  has 'stop_loopback_listener' "$HOST"
chk "HTTP timeouts on health/auth so restore cannot hang" \
  http_timeouts_on_health_auth
chk "wait_for_health fails when the sidecar Terminated" \
  wait_for_health_fails_on_terminated
chk "restore retry/error path is not gated on ready" \
  restore_error_not_gated_on_ready
chk "restart kills the supervised child before replacing 3141" \
  has 'state\.child\.lock\(\)\.unwrap\(\)\.take\(\)' "$HOST"
chk "restart keeps the node's migrations env (KONSENSUS_SQLITE_MIGRATIONS_DIR)" \
  has 'KONSENSUS_SQLITE_MIGRATIONS_DIR' "$HOST"
chk "restore never re-runs init_node" \
  restore_path_never_inits

echo "== keys stay in the host =="
chk "JWT is held in host state and attached there" \
  has 'bearer_auth' "$HOST"
chk "no command response type carries a credential" \
  no_credential_in_responses
chk "no renderer-side response type carries a credential" \
  no_credential_in_renderer_types
chk "renderer code never handles a token/JWT" \
  no_credential_in_renderer_code
chk "recovery phrase is written to the host once, never read back" \
  mnemonic_is_write_only

echo "== renderer is host-mediated only (G2) =="
chk "no direct network calls from the renderer" \
  lacks 'fetch\(|new WebSocket|XMLHttpRequest' src/
chk "no URL of any kind in the renderer" \
  lacks 'https?://' src/
chk "renderer reaches the node only through invoke()" \
  has "invoke<" "$APP"
chk "control plane is loopback-only" \
  lacks 'https?://(?!127\.0\.0\.1|localhost)' "$HOST"

echo "== G6: local-trust disclosure gates the funds UI =="
chk "disclosure element is present and marked" \
  has 'data-gate="g6-local-trust"' "$APP"
chk "disclosure names the loopback full-access risk" \
  has '127\.0\.0\.1' "$APP"
chk "funding UI renders only after the disclosure is accepted" \
  has 'when=\{trustAck\(\) && status\(\)\.ready\}' "$APP"

echo "== recovery phrase is write-only =="
chk "phrase input is masked" \
  has 'id="restore-phrase"' "$APP"
chk "phrase input is type=password, no autocomplete" \
  has 'type="password"' "$APP"
chk "phrase is cleared on submit" \
  has "setPhrase\('')" "$APP"

echo "== funding UI is bound to node state =="
chk "deposit address is rendered as selectable text" \
  has 'class="address"' "$APP"
chk "deposit address is rendered as a QR" \
  has 'class="qr"' "$APP"
chk "received/required progress is shown while funding" \
  has 'funding_amount_sats_received' "$APP"
chk "balance is shown from balance_msat" \
  has 'balance_msat' "$APP"
chk "QR encoder is in-tree, not a third-party dependency" \
  lacks '"(qrcode|qr-code|qrcode-generator|react-qr)' package.json

echo
if [ "$fail" -eq 0 ]; then
  echo "SMOKE: PASS - CS-2 fund flow is host-mediated, key-free, and G6-gated."
else
  echo "SMOKE: FAIL - see the failing checks above." >&2
fi
exit $fail
