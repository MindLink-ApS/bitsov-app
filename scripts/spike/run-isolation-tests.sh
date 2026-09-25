#!/usr/bin/env bash
# J0 Phase 0.5 — macOS isolation test runner (mock only, disposable canaries only).
#
# Recreates every canary from scratch on each run under a fresh mktemp dir, runs the
# probe UNCONFINED first (baseline: proves each attack works without the sandbox) and
# then CONFINED (must be denied), checks positive controls, verifies canary hashes,
# and cleans up: the dummy broker it started, the throwaway keychain it created
# (by exact path), and the temp dir.
#
# Never touches: port 3141, the login keychain or keychain search list, any real node
# data, anything outside its own mktemp dir.
#
# Usage: scripts/spike/run-isolation-tests.sh [--keep] [--evidence-dir DIR]
# Exit 0 iff every required control PASSes.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
KEEP=0
EVID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --evidence-dir) EVID="$2"; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done

ROOT="$(cd "$(mktemp -d /tmp/j0-canary-XXXX)" && pwd -P)"   # canonical /private/tmp/...
BIN="$ROOT/bin"; HOSTCODE="$ROOT/hostcode"; HOSTCONF="$ROOT/hostconfig"; NODE="$ROOT/nodedata"
SIB="$ROOT/sibling-child"; WEIGHTS="$ROOT/weights"; IPC="$ROOT/ipc"; SCRATCH="$ROOT/scratch"
SCRATCH_LLM="$ROOT/scratch-llm"; LISTEN="$ROOT/llm-listen"; NOIPC="$ROOT/no-ipc-for-llm"
KCDIR="$ROOT/keychain"; KC="$KCDIR/j0-throwaway.keychain-db"; RES="$ROOT/results"
PROFILE="$HERE/j0-confined-child.sb"
BROKER_PID=""; KC_CREATED=0

cleanup() {
  if [ -n "$BROKER_PID" ] && kill -0 "$BROKER_PID" 2>/dev/null; then kill "$BROKER_PID" 2>/dev/null; wait "$BROKER_PID" 2>/dev/null; fi
  if [ "$KC_CREATED" = 1 ]; then security delete-keychain "$KC" && echo "cleanup: deleted throwaway keychain $KC"; fi
  if [ -n "$EVID" ] && [ -d "$RES" ]; then mkdir -p "$EVID" && cp "$RES"/* "$EVID"/ 2>/dev/null; fi
  if [ "$KEEP" = 0 ]; then rm -rf "$ROOT"; else echo "kept $ROOT"; fi
}
trap cleanup EXIT
timeout() { local t=$1; shift; /usr/bin/perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$t" "$@"; }

mkdir -p "$BIN" "$HOSTCODE" "$HOSTCONF" "$NODE/pairing" "$SIB" "$WEIGHTS" "$IPC" "$SCRATCH" "$SCRATCH_LLM" "$LISTEN" "$KCDIR" "$RES"
chmod 700 "$ROOT"

echo "== build"
for f in j0spawn j0probe dummy_broker; do
  clang -O1 -Wall -Wno-deprecated-declarations -Wno-for-loop-analysis -o "$BIN/$f" "$HERE/$f.c" || exit 2
done
# get-task-allow on the dummy broker so an UNCONFINED debugger can attach (baseline positive).
cat > "$ROOT/gta.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>
EOF
codesign -s - -f --entitlements "$ROOT/gta.plist" "$BIN/dummy_broker" 2>/dev/null

# ---------------------------------------------------------------- canaries
make_canaries() {
  for d in "$HOSTCODE" "$HOSTCONF" "$NODE" "$SIB" "$WEIGHTS"; do
    find "$d" -mindepth 1 ! -name '*.sock' ! -path "$NODE/pairing" -exec rm -rf {} + 2>/dev/null
  done
  mkdir -p "$NODE/pairing"
  echo "CANARY-hostcode $(openssl rand -hex 8)"   > "$HOSTCODE/canary.txt"
  printf '#!/bin/sh\necho CANARY-fake-host-binary\n' > "$HOSTCODE/bitsov-app"; chmod 755 "$HOSTCODE/bitsov-app"
  echo "CANARY-hostconfig $(openssl rand -hex 8)" > "$HOSTCONF/canary.txt"
  echo '{"CANARY":"fake tauri config"}'            > "$HOSTCONF/tauri.conf.json"
  echo "CANARY-nodedata $(openssl rand -hex 8)"   > "$NODE/canary.txt"
  echo "CANARY-wallet-db $(openssl rand -hex 8)"  > "$NODE/wallet.db"
  echo "CANARY-pairing-challenge $(openssl rand -hex 8)" > "$NODE/pairing/challenge-0001.txt"
  echo "CANARY-pairing-nonce $(openssl rand -hex 8)"     > "$NODE/pairing/owner-console.nonce"
  echo "CANARY-sibling $(openssl rand -hex 8)"    > "$SIB/canary.txt"
  echo "CANARY-weights $(openssl rand -hex 8)"    > "$WEIGHTS/canary.txt"
  find "$SCRATCH" "$SCRATCH_LLM" "$LISTEN" -mindepth 1 -delete 2>/dev/null
  echo "CANARY-scratch assistant $(openssl rand -hex 8)" > "$SCRATCH/canary.txt"
  echo "CANARY-scratch llm $(openssl rand -hex 8)"       > "$SCRATCH_LLM/canary.txt"
  echo "CANARY-pairing-dir $(openssl rand -hex 8)" > "$NODE/pairing/canary.txt"
  echo "CANARY-root $(openssl rand -hex 8)"        > "$ROOT/canary.txt"
}
manifest() {  # every protected file: path + sha256 (sockets excluded); $1 = the other child's scratch
  { find "$HOSTCODE" "$HOSTCONF" "$NODE" "$SIB" "$WEIGHTS" "$KCDIR" "$1" -mindepth 1 ! -name '*.sock' -print0
    printf '%s\0' "$ROOT/canary.txt"; } | sort -z |
    while IFS= read -r -d '' p; do
      if [ -f "$p" ]; then printf '%s %s\n' "$(shasum -a 256 "$p" | cut -c1-16)" "$p"; else printf 'dir %s\n' "$p"; fi
    done
}

# ---------------------------------------------------------------- dummy broker + keychain
echo "== start dummy broker (node port is kernel-chosen, never 3141)"
"$BIN/dummy_broker" "$ROOT/broker.state" "$NODE/control.sock" "$IPC/llm.sock" "$IPC/broker.sock" > "$RES/broker-log.txt" 2>&1 &
BROKER_PID=$!
for _ in $(seq 50); do [ -s "$ROOT/broker.state" ] && break; sleep 0.1; done
NODE_PORT=$(sed -n 's/^port=//p' "$ROOT/broker.state")
[ "$(sed -n 's/^pid=//p' "$ROOT/broker.state")" = "$BROKER_PID" ] || { echo "broker did not start"; exit 2; }
[ "$NODE_PORT" != 3141 ] || { echo "refusing 3141"; exit 2; }
echo "broker pid=$BROKER_PID node_port=$NODE_PORT"

echo "== throwaway keychain $KC"
SL_BEFORE="$(security list-keychains -d user)"
KC_PW="$(openssl rand -hex 24)"
KC_SECRET="CANARY-keychain-$(openssl rand -hex 8)"
security create-keychain -p "$KC_PW" "$KC" && KC_CREATED=1
security add-generic-password -A -s j0-canary -a j0 -w "$KC_SECRET" "$KC"
SL_AFTER="$(security list-keychains -d user)"
[ "$SL_BEFORE" = "$SL_AFTER" ] && echo "keychain search list unchanged" || echo "WARNING: search list changed"

make_canaries

# ---------------------------------------------------------------- probe invocations
MACHS=(com.apple.SecurityServer com.apple.securityd com.apple.securityd.xpc com.apple.secd
       com.apple.coreservices.appleevents com.apple.tccd com.apple.tccd.system
       com.apple.pasteboard.1 com.apple.windowserver.active com.apple.CoreServices.coreservicesd
       com.apple.lsd.mapdb com.apple.distributed_notifications@Uv3)
probe_args() {  # $1 = baseline|confined, $2 = assistant|llm
  local mode=$1 role=$2 own other listen
  if [ "$role" = llm ]; then own=$SCRATCH_LLM; other=$SCRATCH; listen="$LISTEN/llm.sock"
  else own=$SCRATCH; other=$SCRATCH_LLM; listen="$IPC/assistant-may-not-serve.sock"; fi
  local a=(--mode "$mode" --scratch "$own" --listen "$listen" --write "other_child_scratch=$other" --node-port "$NODE_PORT" --control "$NODE/control.sock"
           --llm "$IPC/llm.sock" --broker-ipc "$IPC/broker.sock" --broker-pid "$BROKER_PID"
           --read "nodedata_file=$NODE/canary.txt" --read "nodedata_wallet=$NODE/wallet.db"
           --read "nodedata_dir=$NODE" --read "pairing_challenge=$NODE/pairing/challenge-0001.txt"
           --read "pairing_nonce=$NODE/pairing/owner-console.nonce" --read "pairing_dir=$NODE/pairing"
           --read "keychain_file=$KC" --read "hostconfig_file=$HOSTCONF/tauri.conf.json"
           --read "sibling_file=$SIB/canary.txt" --read "hostcode_file=$HOSTCODE/canary.txt"
           --write "hostcode=$HOSTCODE" --write "hostconfig=$HOSTCONF" --write "nodedata=$NODE"
           --write "pairing=$NODE/pairing" --write "sibling=$SIB" --write "weights=$WEIGHTS" --write "canary_root=$ROOT")
  for m in "${MACHS[@]}"; do a+=(--mach "$m"); done
  printf '%s\n' "${a[@]}"
}
SPAWN_PARAMS=(--param "SCRATCH=$SCRATCH" --param "IPC_DIR=$IPC" --param "EXEC_DIR=$BIN"
              --param "LIB_DIR=$BIN" --param "WEIGHTS=$WEIGHTS" --param "ROLE=assistant")
SPAWN_PARAMS_LLM=(--param "SCRATCH=$SCRATCH_LLM" --param "IPC_DIR=$NOIPC" --param "EXEC_DIR=$BIN"
              --param "LIB_DIR=$BIN" --param "WEIGHTS=$WEIGHTS" --param "ROLE=llm" --param "LISTEN_DIR=$LISTEN")
SPAWN_ENV=(--env "PATH=/usr/bin:/bin" --env "HOME=$SCRATCH" --env "TMPDIR=$SCRATCH/" --env "LANG=C")

# Hostile parent state the launcher must NOT pass on: token-ish env and stray descriptors.
export BITSOV_TOKEN="canary-token-$(openssl rand -hex 8)" KONSENSUS_API_TOKEN="canary-token-x"
export HTTPS_PROXY="http://canary-proxy.invalid:9" ALL_PROXY="socks5://canary-proxy.invalid:9"
exec 7<"$NODE/canary.txt"      # stray fd to a node-data file
exec 8<"$NODE/pairing/challenge-0001.txt"

PB=(); while IFS= read -r l; do PB+=("$l"); done < <(probe_args baseline assistant)
PC=(); while IFS= read -r l; do PC+=("$l"); done < <(probe_args confined assistant)
PL=(); while IFS= read -r l; do PL+=("$l"); done < <(probe_args confined llm)

echo "== [1/4] baseline: probe UNCONFINED (same launcher, --no-sandbox) — attacks should work"
"$BIN/j0spawn" --no-sandbox "${SPAWN_ENV[@]}" -- "$BIN/j0probe" "${PB[@]}" </dev/null > "$RES/probe-baseline.txt" 2>&1
BASE_USR1=$(grep -c '^SIGUSR1' "$RES/broker-log.txt")
make_canaries

echo "== [2/4] leak control: raw sandbox-exec WITHOUT the launcher scrub (shows the fd/env tests detect leaks)"
/usr/bin/sandbox-exec -f "$PROFILE" -D "SCRATCH=$SCRATCH" -D "IPC_DIR=$IPC" -D "EXEC_DIR=$BIN" -D "LIB_DIR=$BIN" -D "WEIGHTS=$WEIGHTS" \
  "$BIN/j0probe" --mode baseline </dev/null > "$RES/probe-leak-control.txt" 2>&1
make_canaries

echo "== [3/4] CONFINED probe, ROLE=assistant"
manifest "$SCRATCH_LLM" > "$RES/manifest-before-assistant.txt"
USR1_BEFORE_assistant=$(grep -c '^SIGUSR1' "$RES/broker-log.txt")
"$BIN/j0spawn" --profile "$PROFILE" "${SPAWN_PARAMS[@]}" "${SPAWN_ENV[@]}" -- "$BIN/j0probe" "${PC[@]}" </dev/null > "$RES/probe-confined-assistant.txt" 2>&1
echo "confined probe exit=$?"
sleep 0.5
manifest "$SCRATCH_LLM" > "$RES/manifest-after-assistant.txt"
USR1_AFTER_assistant=$(grep -c '^SIGUSR1' "$RES/broker-log.txt")
make_canaries

echo "== [3b/4] CONFINED probe, ROLE=llm (Metal + serve one unix socket; no outbound at all)"
manifest "$SCRATCH" > "$RES/manifest-before-llm.txt"
USR1_BEFORE_llm=$(grep -c '^SIGUSR1' "$RES/broker-log.txt")
LLM_ENV=(--env "PATH=/usr/bin:/bin" --env "HOME=$SCRATCH_LLM" --env "TMPDIR=$SCRATCH_LLM/" --env "LANG=C")
"$BIN/j0spawn" --profile "$PROFILE" "${SPAWN_PARAMS_LLM[@]}" "${LLM_ENV[@]}" -- "$BIN/j0probe" "${PL[@]}" </dev/null > "$RES/probe-confined-llm.txt" 2>&1
echo "confined probe exit=$?"
sleep 0.5
manifest "$SCRATCH" > "$RES/manifest-after-llm.txt"
USR1_AFTER_llm=$(grep -c '^SIGUSR1' "$RES/broker-log.txt")
exec 7<&- 8<&-
unset BITSOV_TOKEN KONSENSUS_API_TOKEN HTTPS_PROXY ALL_PROXY

echo "== [4/4] keychain + debugger with real tools"
{
  echo "--- baseline: security find-generic-password (unconfined)"
  security find-generic-password -s j0-canary -a j0 -w "$KC" 2>&1 | sed "s/$KC_SECRET/<SECRET:$KC_SECRET>/"
  echo "exit=${PIPESTATUS[0]}"
  echo "--- confined: security find-generic-password"
  "$BIN/j0spawn" --profile "$PROFILE" "${SPAWN_PARAMS[@]}" "${SPAWN_ENV[@]}" -- /usr/bin/security find-generic-password -s j0-canary -a j0 -w "$KC" </dev/null 2>&1
  echo "exit=$?"
  echo "--- confined: security dump-keychain (no -d)"
  "$BIN/j0spawn" --profile "$PROFILE" "${SPAWN_PARAMS[@]}" "${SPAWN_ENV[@]}" -- /usr/bin/security dump-keychain "$KC" </dev/null 2>&1 | head -5
  echo "exit=${PIPESTATUS[0]}"
  echo "--- confined (ROLE=llm): security find-generic-password"
  "$BIN/j0spawn" --profile "$PROFILE" "${SPAWN_PARAMS_LLM[@]}" "${LLM_ENV[@]}" -- /usr/bin/security find-generic-password -s j0-canary -a j0 -w "$KC" </dev/null 2>&1
  echo "exit=$?"
  # Deliberately no query against the default search list: the login keychain is never touched.
} > "$RES/keychain.txt" 2>&1

# Debugger: lldb as the attacker. A widened profile lets lldb/debugserver themselves start
# (read+exec of the CLT), so the only thing tested is attaching to the broker.
DEV=/Library/Developer/CommandLineTools
{ cat "$PROFILE"; cat <<EOF
;; --- test-only widening: let the attacker's debugger binaries load ---
(allow file-read* (subpath "$DEV") (subpath "/private/var/folders") (subpath "/Library/Preferences"))
(allow process-exec (subpath "$DEV"))
(allow mach-lookup (global-name "com.apple.CoreServices.coreservicesd") (global-name "com.apple.lsd.mapdb"))
EOF
} > "$ROOT/profile-lldb.sb"
{
  echo "--- baseline: lldb attach to dummy broker (unconfined)"
  timeout 60 /usr/bin/lldb --batch -p "$BROKER_PID" -o "process status" -o "process detach" </dev/null 2>&1 | tail -6
  echo "exit=${PIPESTATUS[0]}"
  kill -0 "$BROKER_PID" && echo "broker alive after baseline detach"
  echo "--- confined: lldb attach to dummy broker (profile + lldb read/exec widening)"
  timeout 60 "$BIN/j0spawn" --profile "$ROOT/profile-lldb.sb" "${SPAWN_PARAMS[@]}" "${SPAWN_ENV[@]}" -- /usr/bin/lldb --batch -p "$BROKER_PID" -o "process status" -o "process detach" </dev/null 2>&1 | tail -6
  echo "exit=${PIPESTATUS[0]}"
  kill -0 "$BROKER_PID" && echo "broker alive after confined attempt"
  echo "--- confined (ROLE=llm): lldb attach to dummy broker (profile + lldb read/exec widening)"
  timeout 60 "$BIN/j0spawn" --profile "$ROOT/profile-lldb.sb" "${SPAWN_PARAMS_LLM[@]}" "${LLM_ENV[@]}" -- /usr/bin/lldb --batch -p "$BROKER_PID" -o "process status" -o "process detach" </dev/null 2>&1 | tail -6
  echo "exit=${PIPESTATUS[0]}"
  kill -0 "$BROKER_PID" && echo "broker alive after confined (llm) attempt"
} > "$RES/debugger.txt" 2>&1

# ---------------------------------------------------------------- evaluate
PASS=0; FAIL=0
res() { awk -v id="$2" '$1=="R" && $2==id {print $3; exit}' "$1"; }
line() { awk -v id="$2" '$1=="R" && $2==id {print; exit}' "$1"; }
: > "$RES/summary.txt"

B="$RES/probe-baseline.txt"
eval_role() {
local ROLE=$1 C="$RES/probe-confined-$1.txt"
out() { printf '%-4s %-66s %s\n' "$1" "$ROLE/$2" "$3" | tee -a "$RES/summary.txt"; if [ "$1" = PASS ]; then PASS=$((PASS+1)); elif [ "$1" = FAIL ]; then FAIL=$((FAIL+1)); fi; }
# Every probe test id seen in the confined run.
for id in $(awk '$1=="R"{print $2}' "$C"); do
  c=$(res "$C" "$id"); b=$(res "$B" "$id")
  case "$id" in
    fd.inventory) continue ;;
    env.no_sensitive_vars) [ "$c" = CLEAN ] && out PASS "$id" "confined env clean" || out FAIL "$id" "$(line "$C" "$id")"; continue ;;
    net.node_tcp_::1) out INFO "$id" "confined=$c baseline=${b:-n/a}"; continue ;;
    net.listen_unix)
      if [ "$ROLE" = llm ]; then [ "$c" = OK ] && out PASS "$id" "positive control: LLM serves its socket in LISTEN_DIR" || out FAIL "$id" "$(line "$C" "$id")"
      else [ "$c" = DENIED ] && out PASS "$id" "denied: assistant cannot serve sockets" || out FAIL "$id" "$(line "$C" "$id")"; fi; continue ;;
    pos.llm_sock|pos.broker_ipc_sock)
      if [ "$ROLE" = llm ]; then [ "$c" = DENIED ] && out PASS "${id#pos.}_outbound" "denied: LLM runtime has no outbound channel" || out FAIL "$id" "$(line "$C" "$id")"; continue; fi
      [ "$c" = OK ] && out PASS "$id" "positive control works confined" || out FAIL "$id" "$(line "$C" "$id")"; continue ;;
    pos.*|write.scratch.*)
      [ "$c" = OK ] && out PASS "$id" "positive control works confined" || out FAIL "$id" "$(line "$C" "$id")"; continue ;;
    mach.*)
      if [ "$c" = DENIED ]; then
        [ "$b" = OK ] && out PASS "$id" "denied (baseline reachable)" || out PASS "$id" "denied (baseline also unreachable: service absent)"
      else out FAIL "$id" "$(line "$C" "$id")"; fi; continue ;;
    *)
      if [ "$c" = DENIED ]; then
        if [ -z "$b" ]; then out PASS "$id" "denied ($(line "$C" "$id" | awk '{print $4}')) [no baseline run]"
        elif [ "$b" = OK ]; then out PASS "$id" "denied ($(line "$C" "$id" | awk '{print $4}')); baseline OK"
        else out PASS "$id" "denied ($(line "$C" "$id" | awk '{print $4}')); baseline also failed: $(line "$B" "$id" | awk '{print $4}')"; fi
      else out FAIL "$id" "$(line "$C" "$id")"; fi ;;
  esac
done

# Completeness: a crashed probe must not pass by omission.
NW=$(grep -c '^R write\.' "$C"); NWB=$(grep -c '^R write\.' "$B")
OPS=$(grep -c '^R write\.scratch\.' "$C"); NDIRS=$(( $(printf '%s\n' "${PC[@]}" | grep -c '^--write$') + 1 ))
if grep -q '^# j0probe done' "$C" && grep -q '^# j0probe done' "$B" && [ "$OPS" = 16 ] && [ "$NW" = $((OPS * NDIRS)) ] && [ "$NW" = "$NWB" ]; then
  out PASS probe.completed "confined and baseline probes ran to completion ($NW write attempts each)"
else out FAIL probe.completed "confined_done=$(grep -c '^# j0probe done' "$C") write_results=$NW baseline=$NWB"; fi

# Descriptors: exactly 0,1,2 (stdio) and 3 (bootstrap pipe).
FDS=$(awk '$2=="fd.inventory"' "$C")
FDNUMS=$(echo "$FDS" | grep -o '\[.*\]' | tr -d '[]' | tr ' ' '\n' | cut -d: -f1 | grep -v '^$' | tr '\n' ',')
FD3=$(echo "$FDS" | grep -o ' 3:[a-z]*' | cut -d: -f2)
[ "$FDNUMS" = "0,1,2,3," ] && [ "$FD3" = pipe ] && out PASS fd.only_stdio_and_bootstrap_pipe "fds=$FDNUMS fd3=$FD3" || out FAIL fd.only_stdio_and_bootstrap_pipe "$FDS"

# Canary integrity (independent of the probe's own reporting).
if diff -u "$RES/manifest-before-$ROLE.txt" "$RES/manifest-after-$ROLE.txt" > "$RES/manifest-$ROLE.diff"; then
  out PASS canary.integrity "$(wc -l < "$RES/manifest-before-$ROLE.txt" | tr -d ' ') protected paths byte-identical, no new files"
else out FAIL canary.integrity "see manifest.diff"; fi

# Signals: broker still alive, no SIGUSR1 delivered while confined; baseline did deliver one.
kill -0 "$BROKER_PID" 2>/dev/null && out PASS sig.broker_alive "dummy broker survived SIGSTOP/TERM/KILL attempts" || out FAIL sig.broker_alive "broker died"
eval "UB=\$USR1_BEFORE_$ROLE UA=\$USR1_AFTER_$ROLE"
[ "$UA" = "$UB" ] && [ "$BASE_USR1" -ge 1 ] && out PASS sig.no_delivery "broker SIGUSR1 count unchanged by confined run (baseline delivered $BASE_USR1)" || out FAIL sig.no_delivery "before=$UB after=$UA base=$BASE_USR1"

}
eval_role assistant
eval_role llm
out() { printf '%-4s %-66s %s\n' "$1" "$2" "$3" | tee -a "$RES/summary.txt"; if [ "$1" = PASS ]; then PASS=$((PASS+1)); elif [ "$1" = FAIL ]; then FAIL=$((FAIL+1)); fi; }

# Sensitivity of the fd/env checks.
LEAKFDS=$(awk '$2=="fd.inventory"' "$RES/probe-leak-control.txt" | grep -o '\[.*\]')
echo "$LEAKFDS" | grep -q '7:file' && out PASS fd.leak_control_detects "unscrubbed sandbox-exec run shows stray fd 7 (test is sensitive)" || out FAIL fd.leak_control_detects "$LEAKFDS"
grep -q 'env.no_sensitive_vars FOUND' "$RES/probe-leak-control.txt" && out PASS env.leak_control_detects "unscrubbed run shows BITSOV_TOKEN/proxy vars (test is sensitive)" || out FAIL env.leak_control_detects "leak control did not see planted env"

# Keychain.
KCB=$(awk '/^--- baseline/{f=1;next} /^---/{f=0} f' "$RES/keychain.txt")
echo "$KCB" | grep -q "<SECRET:" && KB=ok || KB=no
if [ "$(grep -c "$KC_SECRET" "$RES/keychain.txt")" = 0 ] || \
   [ "$(grep -c "$KC_SECRET" "$RES/keychain.txt")" = "$(grep -c "<SECRET:$KC_SECRET>" "$RES/keychain.txt")" ]; then
  CONF_LEAK=$(awk '/^--- confined/{f=1} f' "$RES/keychain.txt" | grep -c "$KC_SECRET")
else CONF_LEAK=1; fi
[ "$KB" = ok ] && [ "$CONF_LEAK" = 0 ] && out PASS keychain.item_unreadable "baseline read the item; confined security(1) could not (assistant and llm roles)" || out FAIL keychain.item_unreadable "baseline=$KB confined_leak=$CONF_LEAK"

# Debugger.
DBC=$(awk '/^--- confined/{f=1} f' "$RES/debugger.txt")
DBB=$(awk '/^--- baseline/{f=1;next} /^---/{f=0} f' "$RES/debugger.txt")
if echo "$DBC" | grep -qiE 'stopped|state = stopped|Process [0-9]+ (stopped|detached)'; then out FAIL debugger.lldb_attach "confined lldb attached"
else
  echo "$DBB" | grep -qiE 'Process [0-9]+ (stopped|detached)|state = stopped' && BA="baseline lldb attached" || BA="baseline lldb did NOT attach either"
  out PASS debugger.lldb_attach "confined lldb could not attach, assistant and llm roles ($BA)"
fi

echo "---"
echo "PASS=$PASS FAIL=$FAIL" | tee -a "$RES/summary.txt"
echo "results: $RES"
[ "$FAIL" = 0 ]
