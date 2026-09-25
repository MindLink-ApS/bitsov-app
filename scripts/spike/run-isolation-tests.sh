#!/usr/bin/env bash
# J0 Phase 0.5 — macOS isolation test runner (mock only, disposable canaries only).
#
# Recreates every canary from scratch on each run under a fresh mktemp dir, runs the
# probe UNCONFINED first (baseline: proves each attack works without the sandbox) and
# then CONFINED (must be denied with the sandbox's own error), checks positive controls,
# verifies canary manifests, cross-checks denials against the kernel's sandbox log, and
# cleans up: the dummy broker and victims it started, the throwaway keychain it created
# (by exact path), and the temp dir.
#
# Scoring (per control):
#   PASS  confined attempt denied with the sandbox-specific error (EPERM/EACCES, bootstrap
#         1100, ...) AND the same operation SUCCEEDED in the unconfined baseline; or a
#         positive control that works confined.
#   WEAK  denied as required, but there is no successful same-operation baseline (or the
#         sandbox-log corroboration is missing): inconclusive, NOT counted as PASS.
#   FAIL  allowed, denied for an unrelated reason (wrong errno), or MISSING from the results.
#   INFO  recorded, not a required control.
#
# Never touches: port 3141, the login keychain or the keychain search list / default keychain,
# any real node data, anything outside its own mktemp dir. No internet egress: the egress
# control targets a dummy listener on this host's own LAN address that only answers itself.
#
# Usage: scripts/spike/run-isolation-tests.sh [--keep] [--evidence-dir DIR]
# Exit 0 iff FAIL=0 and WEAK=0.

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
die() { echo "FATAL: $*" >&2; exit 2; }

ROOT="$(mktemp -d /tmp/j0-canary-XXXXXXXX)" || die "mktemp"
ROOT="$(cd "$ROOT" && pwd -P)" || die "canonicalize"
case "$ROOT" in /private/tmp/j0-canary-????????) ;; *) die "unexpected temp root $ROOT" ;; esac
BIN="$ROOT/bin"; HOSTCODE="$ROOT/hostcode"; HOSTCONF="$ROOT/hostconfig"; NODE="$ROOT/nodedata"
SIB="$ROOT/sibling-child"; DV="$ROOT/nodedata-dv"; WEIGHTS="$ROOT/weights"; IPC="$ROOT/ipc"; SCRATCH="$ROOT/scratch"
SCRATCH_LLM="$ROOT/scratch-llm"; LISTEN="$ROOT/llm-listen"; NOIPC="$ROOT/no-ipc-for-llm"
KCDIR="$ROOT/keychain"; KC="$KCDIR/j0-throwaway.keychain-db"; RES="$ROOT/results"
PROFILE="$HERE/j0-confined-child.sb"
BROKER_PID=""; KC_CREATED=0; VICTIMS=(); EVID_DONE=0

# Evidence is copied with the home directory and user name redacted.
redact() { /usr/bin/perl -pe 'BEGIN{$h=shift @ARGV; $u=shift @ARGV} s/\Q$h\E/~/g; s#/Users/[^/\s]+#/Users/<user>#g; s/\Q$u\E/<user>/g' "$HOME" "$(id -un)" "$1"; }
copy_evidence() {
  [ -n "$EVID" ] && [ -d "$RES" ] || return 0
  mkdir -p "$EVID" || return 1
  rm -f "$EVID"/*.txt "$EVID"/*.diff 2>/dev/null
  for f in "$RES"/*; do [ -f "$f" ] && redact "$f" > "$EVID/$(basename "$f")"; done
  EVID_DONE=1
}
cleanup() {
  for v in "${VICTIMS[@]:-}"; do [ -n "$v" ] && kill -KILL "$v" 2>/dev/null; done
  if [ -n "$BROKER_PID" ] && kill -0 "$BROKER_PID" 2>/dev/null; then kill "$BROKER_PID" 2>/dev/null; wait "$BROKER_PID" 2>/dev/null; fi
  wait 2>/dev/null
  if [ "$KC_CREATED" = 1 ]; then security delete-keychain "$KC" && echo "cleanup: deleted throwaway keychain (exact path under $ROOT)"; fi
  [ "$EVID_DONE" = 1 ] || copy_evidence
  case "$ROOT" in
    /private/tmp/j0-canary-????????) if [ "$KEEP" = 0 ]; then rm -rf "$ROOT"; else echo "kept $ROOT"; fi ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP
timeout() { local t=$1; shift; /usr/bin/perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$t" "$@"; }

mkdir -p "$BIN" "$HOSTCODE" "$HOSTCONF" "$NODE/pairing" "$SIB" "$DV" "$WEIGHTS" "$IPC" "$SCRATCH" "$SCRATCH_LLM" "$LISTEN" "$KCDIR" "$RES" || die "mkdir"
chmod 700 "$ROOT"

echo "== build"
for f in j0spawn j0probe dummy_broker j0fdplant; do
  clang -O1 -Wall -Wno-deprecated-declarations -Wno-for-loop-analysis -o "$BIN/$f" "$HERE/$f.c" || die "build $f"
done
# Regression control only: the 8c64b3bf descriptor loop (close 4..min(rlim_cur,65536)).
clang -O1 -Wall -DJ0_LEGACY_RLIMIT_CLOSE -o "$BIN/j0spawn-legacy" "$HERE/j0spawn.c" || die "build legacy"
# get-task-allow on the dummy broker/victims so an UNCONFINED debugger can attach (baseline positive).
cat > "$ROOT/gta.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.get-task-allow</key><true/></dict></plist>
EOF
codesign -s - -f --entitlements "$ROOT/gta.plist" "$BIN/dummy_broker" 2>/dev/null || die "codesign"

# ---------------------------------------------------------------- canaries
make_canaries() {
  for d in "$HOSTCODE" "$HOSTCONF" "$NODE" "$SIB" "$DV" "$WEIGHTS"; do
    find "$d" -mindepth 1 ! -name '*.sock' ! -path "$NODE/pairing" -exec rm -rf {} + 2>/dev/null
  done
  find "$ROOT" -mindepth 1 -maxdepth 1 -name 'j0-*' -exec rm -rf {} + 2>/dev/null
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
  echo "CANARY-nodedata-dv $(openssl rand -hex 8)" > "$DV/canary.txt"   # written via /System/Volumes/Data
  echo "CANARY-weights $(openssl rand -hex 8)"    > "$WEIGHTS/canary.txt"
  find "$SCRATCH" "$SCRATCH_LLM" "$LISTEN" -mindepth 1 -delete 2>/dev/null
  echo "CANARY-scratch assistant $(openssl rand -hex 8)" > "$SCRATCH/canary.txt"
  echo "CANARY-scratch llm $(openssl rand -hex 8)"       > "$SCRATCH_LLM/canary.txt"
  echo "CANARY-pairing-dir $(openssl rand -hex 8)" > "$NODE/pairing/canary.txt"
  echo "CANARY-root $(openssl rand -hex 8)"        > "$ROOT/canary.txt"
}
# Every protected path: sha256 (files), mode, mtime, size, xattr names; plus the canary root's
# top-level entry names (catches files created directly in it). $1 = the other child's scratch.
manifest() {
  { find "$HOSTCODE" "$HOSTCONF" "$NODE" "$SIB" "$DV" "$WEIGHTS" "$KCDIR" "$1" ! -name '*.sock' -print0
    printf '%s\0' "$ROOT/canary.txt"; } | sort -z |
    while IFS= read -r -d '' p; do
      meta="$(stat -f '%Sp %m %z' "$p") xattr=[$(xattr "$p" 2>/dev/null | tr '\n' ',')]"
      if [ -f "$p" ]; then printf '%s %s %s\n' "$(shasum -a 256 "$p" | cut -c1-16)" "$meta" "$p"; else printf 'dir %s %s\n' "$meta" "$p"; fi
    done
  echo "root-entries: $(ls -A "$ROOT" | grep -v '^results$' | tr '\n' ' ')"
}

# ---------------------------------------------------------------- dummy broker + keychain
LAN="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
echo "== start dummy broker (node port chosen before bind, never 3141)"
"$BIN/dummy_broker" "$ROOT/broker.state" "$NODE/control.sock" "$IPC/llm.sock" "$IPC/broker.sock" ${LAN:+"$LAN"} > "$RES/broker-log.txt" 2>&1 &
BROKER_PID=$!
for _ in $(seq 50); do [ -s "$ROOT/broker.state" ] && break; sleep 0.1; done
NODE_PORT=$(sed -n 's/^port=//p' "$ROOT/broker.state")
PORT6=$(sed -n 's/^port6=//p' "$ROOT/broker.state")
EGRESS_PORT=$(sed -n 's/^egress_port=//p' "$ROOT/broker.state")
[ "$(sed -n 's/^pid=//p' "$ROOT/broker.state")" = "$BROKER_PID" ] || die "broker did not start"
[ -n "$NODE_PORT" ] && [ "$NODE_PORT" != 3141 ] || die "bad node port"
EGRESS=""; [ -n "$LAN" ] && [ "${EGRESS_PORT:-0}" != 0 ] && EGRESS="$LAN:$EGRESS_PORT"
echo "broker pid=$BROKER_PID node_port=$NODE_PORT v6=$PORT6 egress=${EGRESS:-none}"

echo "== throwaway keychain (under $ROOT/keychain)"
SL_BEFORE="$(security list-keychains -d user | shasum -a 256 | cut -c1-16)"
DK_BEFORE="$(security default-keychain -d user | shasum -a 256 | cut -c1-16)"
KC_PW="$(openssl rand -hex 24)"
KC_SECRET="CANARY-keychain-$(openssl rand -hex 8)"
security create-keychain -p "$KC_PW" "$KC" && KC_CREATED=1 || die "create-keychain"
security add-generic-password -A -s j0-canary -a j0 -w "$KC_SECRET" "$KC" || die "add-generic-password"
SL_AFTER="$(security list-keychains -d user | shasum -a 256 | cut -c1-16)"
DK_AFTER="$(security default-keychain -d user | shasum -a 256 | cut -c1-16)"
printf 'search-list sha256/16 before=%s after=%s\ndefault-keychain sha256/16 before=%s after=%s\n' "$SL_BEFORE" "$SL_AFTER" "$DK_BEFORE" "$DK_AFTER" > "$RES/keychain-searchlist.txt"

make_canaries

# ---------------------------------------------------------------- probe invocations
MACHS_REQUIRED=(com.apple.SecurityServer com.apple.securityd.xpc com.apple.securityd.general
       com.apple.security.octagon com.apple.ctkd.token-client
       com.apple.coreservices.appleevents com.apple.tccd com.apple.tccd.system
       com.apple.pasteboard.1 com.apple.windowserver.active com.apple.CoreServices.coreservicesd
       com.apple.lsd.mapdb com.apple.distributed_notifications@Uv3)
MACHS_ABSENT_OK=(com.apple.securityd com.apple.secd)   # legacy names, absent on macOS 26: INFO only
READS=("nodedata_file=$NODE/canary.txt" "nodedata_wallet=$NODE/wallet.db" "nodedata_dir=$NODE"
       "pairing_challenge=$NODE/pairing/challenge-0001.txt" "pairing_nonce=$NODE/pairing/owner-console.nonce"
       "pairing_dir=$NODE/pairing" "keychain_file=$KC" "hostconfig_file=$HOSTCONF/tauri.conf.json"
       "sibling_file=$SIB/canary.txt" "hostcode_file=$HOSTCODE/canary.txt"
       "nodedata_via_datavol=/System/Volumes/Data$NODE/canary.txt" "users_dir=/Users")
WRITES=("hostcode=$HOSTCODE" "hostconfig=$HOSTCONF" "nodedata=$NODE" "pairing=$NODE/pairing" "sibling=$SIB"
        "weights=$WEIGHTS" "canary_root=$ROOT" "nodedata_via_datavol=/System/Volumes/Data$DV")
V_stop=""; V_term=""; V_kill=""; V_ptrace=""
start_victims() {
  for k in stop term kill ptrace; do
    "$BIN/dummy_broker" --victim & eval "V_$k=$!"; VICTIMS+=($!)
  done
  sleep 0.3
}
# Records what happened to the victims; kills and reaps every one of them.
victim_fate() {  # $1 = label
  local st t k p
  st=$(ps -o stat= -p "$V_stop" 2>/dev/null | tr -d ' ')
  if kill -0 "$V_term" 2>/dev/null; then t="alive:$(ps -o stat= -p "$V_term" | tr -d ' ')"; else wait "$V_term"; t="exit=$?"; fi
  if kill -0 "$V_kill" 2>/dev/null; then k="alive:$(ps -o stat= -p "$V_kill" | tr -d ' ')"; else wait "$V_kill"; k="exit=$?"; fi
  p=$(ps -o stat= -p "$V_ptrace" 2>/dev/null | tr -d ' ')
  echo "$1 stop_victim_stat=${st:-gone} term_victim=$t kill_victim=$k ptrace_victim_stat=${p:-gone}" | tee -a "$RES/victims.txt"
  for v in "$V_stop" "$V_term" "$V_kill" "$V_ptrace"; do kill -KILL "$v" 2>/dev/null; wait "$v" 2>/dev/null; done
}
probe_args() {  # $1 = baseline|confined, $2 = assistant|llm
  local mode=$1 role=$2 own other listen listen2
  if [ "$role" = llm ]; then own=$SCRATCH_LLM; other=$SCRATCH; listen="$LISTEN/llm.sock"; listen2="$LISTEN/other.sock"
  else own=$SCRATCH; other=$SCRATCH_LLM; listen="$IPC/assistant-may-not-serve.sock"; listen2="$SCRATCH/assistant-other.sock"; fi
  local a=(--mode "$mode" --scratch "$own" --listen "$listen" --listen-other "$listen2" --write "other_child_scratch=$other"
           --node-port "$NODE_PORT" --control "$NODE/control.sock"
           --llm "$IPC/llm.sock" --broker-ipc "$IPC/broker.sock" --broker-pid "$BROKER_PID"
           --victim-stop "$V_stop" --victim-term "$V_term" --victim-kill "$V_kill" --victim-ptrace "$V_ptrace")
  [ -n "$EGRESS" ] && a+=(--egress "$EGRESS")
  for r in "${READS[@]}"; do a+=(--read "$r"); done
  for w in "${WRITES[@]}"; do a+=(--write "$w"); done
  for m in "${MACHS_REQUIRED[@]}" "${MACHS_ABSENT_OK[@]}"; do a+=(--mach "$m"); done
  printf '%s\n' "${a[@]}"
}
SPAWN_PARAMS=(--param "SCRATCH=$SCRATCH" --param "IPC_DIR=$IPC" --param "EXEC_DIR=$BIN"
              --param "LIB_DIR=$BIN" --param "WEIGHTS=$WEIGHTS" --param "ROLE=assistant")
SPAWN_PARAMS_LLM=(--param "SCRATCH=$SCRATCH_LLM" --param "IPC_DIR=$NOIPC" --param "EXEC_DIR=$BIN"
              --param "LIB_DIR=$BIN" --param "WEIGHTS=$WEIGHTS" --param "ROLE=llm" --param "LISTEN_SOCK=$LISTEN/llm.sock")
SPAWN_ENV=(--chdir "$SCRATCH" --env "PATH=/usr/bin:/bin" --env "HOME=$SCRATCH" --env "TMPDIR=$SCRATCH/" --env "LANG=C")
LLM_ENV=(--chdir "$SCRATCH_LLM" --env "PATH=/usr/bin:/bin" --env "HOME=$SCRATCH_LLM" --env "TMPDIR=$SCRATCH_LLM/" --env "LANG=C")
PLANT=("$BIN/j0fdplant" --fd 5000 --fd 70000 --soft-limit 256 --)

# Hostile parent state the launcher must NOT pass on: token-ish env, stray low descriptors, and
# (via j0fdplant) host-private pipes at fd 5000 and 70000 above a lowered soft limit of 256.
BITSOV_TOKEN_VAL="canary-token-$(openssl rand -hex 8)"
export BITSOV_TOKEN="$BITSOV_TOKEN_VAL" KONSENSUS_API_TOKEN="canary-token-x"
export HTTPS_PROXY="http://canary-proxy.invalid:9" ALL_PROXY="socks5://canary-proxy.invalid:9"
exec 7<"$NODE/canary.txt"      # stray fd to a node-data file
exec 8<"$NODE/pairing/challenge-0001.txt"

LOG_START="$(date '+%Y-%m-%d %H:%M:%S')"
udp_count() { grep -c '^UDP recv' "$RES/broker-log.txt"; }
usr1_count() { grep -c '^SIGUSR1' "$RES/broker-log.txt"; }

echo "== [1/5] baseline: probe UNCONFINED (same launcher, --no-sandbox) — attacks should work"
start_victims
PB=(); while IFS= read -r l; do PB+=("$l"); done < <(probe_args baseline assistant)
UDP0=$(udp_count)
"${PLANT[@]}" "$BIN/j0spawn" --no-sandbox --report "${SPAWN_ENV[@]}" -- "$BIN/j0probe" "${PB[@]}" </dev/null > "$RES/probe-baseline.txt" 2>&1
sleep 0.5
BASE_UDP=$(( $(udp_count) - UDP0 )); BASE_USR1=$(usr1_count)
victim_fate baseline
make_canaries

echo "== [2/5] leak controls: the fd/env checks must SEE a leak when the scrub is missing"
# (a) raw sandbox-exec, no launcher at all. env -i keeps the operator's real variables out of the log.
env -i PATH=/usr/bin:/bin BITSOV_TOKEN="$BITSOV_TOKEN_VAL" HTTPS_PROXY="$HTTPS_PROXY" \
  "${PLANT[@]}" /usr/bin/sandbox-exec -f "$PROFILE" -D "SCRATCH=$SCRATCH" -D "IPC_DIR=$IPC" -D "EXEC_DIR=$BIN" -D "LIB_DIR=$BIN" \
  -D "WEIGHTS=$WEIGHTS" -D "ROLE=assistant" "$BIN/j0probe" --mode baseline </dev/null > "$RES/probe-leak-control.txt" 2>&1
# (b) the 8c64b3bf launcher (rlimit-bounded close loop), confined: regression control for P1-1.
env -i PATH=/usr/bin:/bin "${PLANT[@]}" "$BIN/j0spawn-legacy" --profile "$PROFILE" "${SPAWN_PARAMS[@]}" "${SPAWN_ENV[@]}" \
  -- "$BIN/j0probe" --mode confined </dev/null > "$RES/probe-legacy-launcher.txt" 2>&1
make_canaries

run_confined() {  # $1 = role
  local role=$1 other params envs
  if [ "$role" = llm ]; then other=$SCRATCH; params=("${SPAWN_PARAMS_LLM[@]}"); envs=("${LLM_ENV[@]}")
  else other=$SCRATCH_LLM; params=("${SPAWN_PARAMS[@]}"); envs=("${SPAWN_ENV[@]}"); fi
  start_victims
  local P=(); while IFS= read -r l; do P+=("$l"); done < <(probe_args confined "$role")
  manifest "$other" > "$RES/manifest-before-$role.txt"
  eval "USR1_BEFORE_$role=$(usr1_count) UDP_BEFORE_$role=$(udp_count)"
  "${PLANT[@]}" "$BIN/j0spawn" --profile "$PROFILE" --report "${params[@]}" "${envs[@]}" -- "$BIN/j0probe" "${P[@]}" </dev/null > "$RES/probe-confined-$role.txt" 2>&1
  echo "confined probe ($role) exit=$?"
  sleep 0.5
  manifest "$other" > "$RES/manifest-after-$role.txt"
  eval "USR1_AFTER_$role=$(usr1_count) UDP_AFTER_$role=$(udp_count)"
  victim_fate "confined-$role"
  make_canaries
}
echo "== [3/5] CONFINED probe, ROLE=assistant"
run_confined assistant
echo "== [4/5] CONFINED probe, ROLE=llm (Metal + serve one unix socket; no outbound at all)"
run_confined llm
exec 7<&- 8<&-
unset BITSOV_TOKEN KONSENSUS_API_TOKEN HTTPS_PROXY ALL_PROXY

echo "== [5/5] keychain + debugger with real tools"
TOOL_PARAMS=("${SPAWN_PARAMS[@]}" --param "SYSTEM_EXEC=yes")
TOOL_PARAMS_LLM=("${SPAWN_PARAMS_LLM[@]}" --param "SYSTEM_EXEC=yes")
# The secret is never written to a log: outputs are compared in memory and only a verdict is kept.
kc_line() {  # $1 label, $2 exit, $3 output
  local o="$3" hit=no
  case "$o" in *"$KC_SECRET"*) hit=yes ;; esac
  o="${o//$KC_SECRET/<SECRET>}"
  printf -- '--- %s\nexit=%s secret_in_output=%s\n%s\n' "$1" "$2" "$hit" "$(printf '%s' "$o" | grep -v '^j0spawn: bootstrap' | head -8)"
}
{
  o=$(security find-generic-password -s j0-canary -a j0 -w "$KC" 2>&1); kc_line "baseline: security find-generic-password (unconfined)" $? "$o"
  o=$(security dump-keychain "$KC" 2>&1 | grep -E '"svce"|"acct"|^keychain|error' | head -4); kc_line "baseline: security dump-keychain (unconfined, no -d)" 0 "$o"
  o=$("$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_PARAMS[@]}" "${SPAWN_ENV[@]}" -- /usr/bin/security find-generic-password -s j0-canary -a j0 -w "$KC" </dev/null 2>&1); kc_line "confined assistant: security find-generic-password" $? "$o"
  o=$("$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_PARAMS[@]}" "${SPAWN_ENV[@]}" -- /usr/bin/security dump-keychain "$KC" </dev/null 2>&1); kc_line "confined assistant: security dump-keychain (no -d)" $? "$o"
  o=$("$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_PARAMS_LLM[@]}" "${LLM_ENV[@]}" -- /usr/bin/security find-generic-password -s j0-canary -a j0 -w "$KC" </dev/null 2>&1); kc_line "confined llm: security find-generic-password" $? "$o"
  o=$("$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_PARAMS_LLM[@]}" "${LLM_ENV[@]}" -- /usr/bin/security dump-keychain "$KC" </dev/null 2>&1); kc_line "confined llm: security dump-keychain (no -d)" $? "$o"
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
LLDB=(/usr/bin/lldb --batch -p "$BROKER_PID" -o "process status" -o "process detach")
{
  echo "--- baseline: lldb attach to dummy broker (unconfined)"
  timeout 60 "${LLDB[@]}" </dev/null 2>&1 | tail -6
  echo "exit=${PIPESTATUS[0]}"
  kill -0 "$BROKER_PID" && echo "broker alive after baseline detach"
  echo "--- confined assistant: lldb attach to dummy broker (profile + lldb read/exec widening)"
  timeout 60 "$BIN/j0spawn" --profile "$ROOT/profile-lldb.sb" --report "${TOOL_PARAMS[@]}" "${SPAWN_ENV[@]}" -- "${LLDB[@]}" </dev/null 2>&1 | grep -v '^j0spawn: bootstrap' | head -20
  echo "exit=${PIPESTATUS[0]}"
  kill -0 "$BROKER_PID" && echo "broker alive after confined attempt"
  echo "--- confined llm: lldb attach to dummy broker (profile + lldb read/exec widening)"
  timeout 60 "$BIN/j0spawn" --profile "$ROOT/profile-lldb.sb" --report "${TOOL_PARAMS_LLM[@]}" "${LLM_ENV[@]}" -- "${LLDB[@]}" </dev/null 2>&1 | grep -v '^j0spawn: bootstrap' | head -20
  echo "exit=${PIPESTATUS[0]}"
  kill -0 "$BROKER_PID" && echo "broker alive after confined (llm) attempt"
} > "$RES/debugger.txt" 2>&1

# ---------------------------------------------------------------- kernel sandbox log
# Kernel log entries reach `log show` with a delay: wait (max 60 s) until the LAST confined
# tool's pid is visible before collecting.
LASTPID=$(grep -ho '^j0spawn: child pid=[0-9]*' "$RES/debugger.txt" | tail -1 | cut -d= -f2)
for _ in $(seq 30); do
  /usr/bin/log show --start "$LOG_START" --style compact --predicate 'sender == "Sandbox"' 2>/dev/null | grep -q "(${LASTPID:-none}) deny" && break
  sleep 2
done
PIDS=$( { grep -ho '^# j0probe pid=[0-9]*' "$RES"/probe-confined-*.txt | cut -d= -f2
          grep -ho '^j0spawn: child pid=[0-9]*' "$RES"/probe-confined-*.txt "$RES/keychain.txt" "$RES/debugger.txt" 2>/dev/null | cut -d= -f2; } | sort -u | tr '\n' '|' | sed 's/|$//')
/usr/bin/log show --start "$LOG_START" --style compact --predicate 'sender == "Sandbox"' 2>/dev/null |
  grep -E "Sandbox: [^ ]+\((${PIDS:-none})\) deny|Sandbox: debugserver\([0-9]+\) deny" |
  sed -E 's/^([0-9-]+ [0-9:.]+).*Sandbox: /\1 /' > "$RES/sandbox-log.txt"
echo "sandbox log: $(wc -l < "$RES/sandbox-log.txt" | tr -d ' ') deny lines for this run's confined pids"

# ---------------------------------------------------------------- evaluate
PASS=0; WEAK=0; FAIL=0
: > "$RES/summary.txt"
out() { printf '%-4s %-62s %s\n' "$1" "$2" "$3" | tee -a "$RES/summary.txt"
        case "$1" in PASS) PASS=$((PASS+1)) ;; WEAK) WEAK=$((WEAK+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; esac; }
st()  { awk -v id="$2" '$1=="R" && $2==id {print $3; exit}' "$1"; }
er()  { awk -v id="$2" '$1=="R" && $2==id {print $4; exit}' "$1"; }
line(){ awk -v id="$2" '$1=="R" && $2==id {print; exit}' "$1"; }
has() { grep -q "^R $2 " "$1"; }
B="$RES/probe-baseline.txt"

# Denial with the sandbox's errno + successful same-operation baseline.
deny_errno() {  # role id
  local C="$RES/probe-confined-$1.txt" id=$2 c e b
  if ! has "$C" "$id"; then out FAIL "$1/$id" "MISSING from confined results"; return; fi
  c=$(st "$C" "$id"); e=$(er "$C" "$id"); b=$(st "$B" "$id")
  if [ "$c" != DENIED ]; then out FAIL "$1/$id" "ALLOWED: $(line "$C" "$id")"; return; fi
  case "$e" in EPERM|EACCES) ;; *) out FAIL "$1/$id" "denied with $e, not the sandbox's EPERM/EACCES"; return ;; esac
  if [ "$b" = OK ]; then out PASS "$1/$id" "denied $e; baseline OK"
  elif [ -z "$b" ]; then out WEAK "$1/$id" "denied $e; NO baseline result"
  else out WEAK "$1/$id" "denied $e; baseline also failed ($(er "$B" "$id")) — inconclusive"; fi
}
deny_kr() {  # role id expected-kr-regex
  local C="$RES/probe-confined-$1.txt" id=$2 c e b
  if ! has "$C" "$id"; then out FAIL "$1/$id" "MISSING from confined results"; return; fi
  c=$(st "$C" "$id"); e=$(er "$C" "$id"); b=$(st "$B" "$id")
  if [ "$c" != DENIED ]; then out FAIL "$1/$id" "ALLOWED: $(line "$C" "$id")"; return; fi
  [[ "$e" =~ ^($3)$ ]] || { out FAIL "$1/$id" "denied with $e, expected $3"; return; }
  if [ "$b" = OK ]; then out PASS "$1/$id" "denied $e; baseline OK"
  else out WEAK "$1/$id" "denied $e; baseline ${b:-missing} $(er "$B" "$id") — inconclusive"; fi
}
positive() {  # role id
  local C="$RES/probe-confined-$1.txt"
  if ! has "$C" "$2"; then out FAIL "$1/$2" "MISSING from confined results"; return; fi
  [ "$(st "$C" "$2")" = OK ] && out PASS "$1/$2" "positive control works confined" || out FAIL "$1/$2" "$(line "$C" "$2")"
}

WRITE_OPS=(create mkdir write truncate open_trunc chmod utimes setxattr rename_in_place rename_out_to_scratch
           rename_in_from_scratch symlink_create_in_target symlink_escape_write hardlink_create_in_target hardlink_escape unlink)
PLANTED=$(grep -ho 'j0fdplant: planted=[0-9,]*' "$RES/probe-baseline.txt" | head -1 | cut -d= -f2)
fdlist() { awk -v id="$2" '$1=="R" && $2==id' "$1" | grep -o 'open=\[[^]]*\]' | tr -d '[]' | sed 's/^open=//' | tr ' ' '\n' | cut -d: -f1 | grep -v '^$' | tr '\n' ','; }
LEAK_A=$(fdlist "$RES/probe-leak-control.txt" fd.inventory); LEAK_B=$(fdlist "$RES/probe-legacy-launcher.txt" fd.inventory)
hp() { grep -q "^R fd.content.$2 INFO hostprivate" "$1"; }
HIGH_BASE="no"
if [[ ",$PLANTED," == *",5000,"* && ",$PLANTED," == *",70000,"* ]] && hp "$RES/probe-leak-control.txt" 5000 && hp "$RES/probe-leak-control.txt" 70000 \
   && hp "$RES/probe-legacy-launcher.txt" 5000 && hp "$RES/probe-legacy-launcher.txt" 70000; then HIGH_BASE=yes; fi

eval_role() {
  local ROLE=$1 C="$RES/probe-confined-$1.txt" id
  # --- reads (every declared target; root_dir: listing only, stat of "/" is needed and allowed)
  for r in "${READS[@]}"; do
    id=${r%%=*}
    case "$id" in
      *_dir) deny_errno "$ROLE" "read.$id.stat"; deny_errno "$ROLE" "read.$id.listdir" ;;
      *) deny_errno "$ROLE" "read.$id.stat"; deny_errno "$ROLE" "read.$id.open" ;;
    esac
  done
  # --- writes (every target x every op) + positive scratch
  for w in "other_child_scratch=x" "${WRITES[@]}"; do
    id=${w%%=*}; for op in "${WRITE_OPS[@]}"; do deny_errno "$ROLE" "write.$id.$op"; done
  done
  for op in "${WRITE_OPS[@]}"; do positive "$ROLE" "write.scratch.$op"; done
  # --- exec
  for id in exec.child_inherits_sandbox exec.system_shell exec.system_bin_cat; do deny_errno "$ROLE" "$id"; done
  # --- network
  for id in net.node_tcp_127.0.0.1 net.control_sock net.udp_loopback_send net.tcp_listen_loopback net.listen_unix_other; do deny_errno "$ROLE" "$id"; done
  if [ "${PORT6:-0}" != 0 ]; then deny_errno "$ROLE" "net.node_tcp_::1"; else out INFO "$ROLE/net.node_tcp_::1" "no IPv6 loopback listener"; fi
  if [ -n "$EGRESS" ]; then deny_errno "$ROLE" net.egress_tcp_nonloopback; else out WEAK "$ROLE/net.egress_tcp_nonloopback" "no LAN IPv4: egress control not run"; fi
  if [ "$ROLE" = llm ]; then
    positive llm net.listen_unix
    deny_errno llm pos.llm_sock; deny_errno llm pos.broker_ipc_sock   # the LLM has no outbound channel
  else
    deny_errno assistant net.listen_unix
    positive assistant pos.llm_sock; positive assistant pos.broker_ipc_sock
  fi
  # --- mach services
  for m in "${MACHS_REQUIRED[@]}"; do deny_kr "$ROLE" "mach.$m" "KR1100"; done
  for m in "${MACHS_ABSENT_OK[@]}"; do out INFO "$ROLE/mach.$m" "confined=$(er "$C" "mach.$m") baseline=$(er "$B" "mach.$m") (absent on this OS)"; done
  # --- inspection / signals / debugger primitives
  for id in proc.pidinfo proc.pidpath proc.listallpids proc.sysctl_kern_proc_pid proc.sysctl_kern_procargs2 proc.sysctl_kern_procargs \
            sig.kill0 sig.SIGUSR1 sig.SIGSTOP sig.SIGTERM sig.SIGKILL proc.ptrace_attach; do deny_errno "$ROLE" "$id"; done
  deny_kr "$ROLE" proc.task_for_pid "KR5"; deny_kr "$ROLE" proc.task_name_for_pid "KR5"
  # --- victims: independent evidence of what the signals did
  local vb vc
  vb=$(grep '^baseline ' "$RES/victims.txt"); vc=$(grep "^confined-$ROLE " "$RES/victims.txt")
  if [[ "$vc" =~ stop_victim_stat=S[^\ ]*\ term_victim=alive:S[^\ ]*\ kill_victim=alive:S[^\ ]*\ ptrace_victim_stat=S ]]; then
    if [[ "$vb" =~ stop_victim_stat=T[^\ ]*\ term_victim=exit=143\ kill_victim=exit=137 ]]; then
      out PASS "$ROLE/sig.victims_unharmed" "confined: all victims running; baseline: stopped / TERM(143) / KILL(137)"
    else out WEAK "$ROLE/sig.victims_unharmed" "confined victims fine but baseline fate unexpected: $vb"; fi
  else out FAIL "$ROLE/sig.victims_unharmed" "$vc"; fi
  local UB UA DB DA
  eval "UB=\$USR1_BEFORE_$ROLE UA=\$USR1_AFTER_$ROLE DB=\$UDP_BEFORE_$ROLE DA=\$UDP_AFTER_$ROLE"
  if [ "$UA" = "$UB" ]; then [ "$BASE_USR1" -ge 1 ] && out PASS "$ROLE/sig.no_delivery" "SIGUSR1 count unchanged (baseline delivered $BASE_USR1)" || out WEAK "$ROLE/sig.no_delivery" "baseline delivered none"
  else out FAIL "$ROLE/sig.no_delivery" "before=$UB after=$UA"; fi
  if [ "$DA" = "$DB" ]; then [ "$BASE_UDP" -ge 1 ] && out PASS "$ROLE/net.udp_no_receipt" "broker received 0 datagrams (baseline: $BASE_UDP received)" || out WEAK "$ROLE/net.udp_no_receipt" "baseline datagram not received"
  else out FAIL "$ROLE/net.udp_no_receipt" "broker received $((DA-DB))"; fi
  kill -0 "$BROKER_PID" 2>/dev/null && out PASS "$ROLE/sig.broker_alive" "dummy broker running after the confined run" || out FAIL "$ROLE/sig.broker_alive" "broker died"
  # --- environment: exactly the launcher's four variables, no planted value
  local names
  names=$(awk '$2=="env.no_sensitive_vars"' "$C" | grep -o 'names=\[[^]]*\]')
  if [ "$names" = "names=[PATH,HOME,TMPDIR,LANG,]" ] && [ "$(st "$C" env.no_sensitive_vars)" = CLEAN ] && ! grep -q "$BITSOV_TOKEN_VAL" "$C"; then
    grep -q 'BITSOV_TOKEN' "$RES/probe-leak-control.txt" && out PASS "$ROLE/env.exact_minimal" "$names; leak control saw the planted BITSOV_TOKEN" \
      || out WEAK "$ROLE/env.exact_minimal" "$names; leak control did NOT see the planted variable"
  else out FAIL "$ROLE/env.exact_minimal" "$(line "$C" env.no_sensitive_vars)"; fi
  # --- descriptors: kernel table AND full fcntl scan show exactly 0-3, fd 3 is the pipe
  local inv scan
  inv=$(fdlist "$C" fd.inventory); scan=$(fdlist "$C" fd.scan)
  if [ "$inv" = "0,1,2,3," ] && [ "$scan" = "0,1,2,3," ] && grep -q '^R fd.inventory INFO 4 open=\[.* 3:pipe' "$C"; then
    [ "$HIGH_BASE" = yes ] && out PASS "$ROLE/fd.only_stdio_and_bootstrap_pipe" "table=$inv scan=$scan; planted 7,8,5000,70000 (soft limit 256) all closed" \
      || out WEAK "$ROLE/fd.only_stdio_and_bootstrap_pipe" "table=$inv but the high-fd positive baselines did not show the leak"
  else out FAIL "$ROLE/fd.only_stdio_and_bootstrap_pipe" "table=$inv scan=$scan"; fi
  # --- bootstrap secret: the child read exactly what the launcher sent (hash compare, no secret logged)
  local hl hc
  hl=$(grep -o '^j0spawn: bootstrap sha256=[0-9a-f]*' "$C" | cut -d= -f2); hc=$(line "$C" pos.bootstrap_pipe_fd3 | grep -o 'sha256=[0-9a-f]*' | cut -d= -f2)
  [ "$(st "$C" pos.bootstrap_pipe_fd3)" = OK ] && [ -n "$hl" ] && [ "$hl" = "$hc" ] && out PASS "$ROLE/pos.bootstrap_pipe_fd3" "child's fd-3 bytes hash-equal to the launcher's secret" \
    || out FAIL "$ROLE/pos.bootstrap_pipe_fd3" "launcher=$hl child=$hc"
  # --- integrity + completion
  if diff -u "$RES/manifest-before-$ROLE.txt" "$RES/manifest-after-$ROLE.txt" > "$RES/manifest-$ROLE.diff"; then
    out PASS "$ROLE/canary.integrity" "$(($(wc -l < "$RES/manifest-before-$ROLE.txt")-1)) protected paths: content, mode, mtime, size, xattrs unchanged; no new root entries"
  else out FAIL "$ROLE/canary.integrity" "see manifest-$ROLE.diff"; fi
  grep -q '^# j0probe done' "$C" && grep -q '^# j0probe done' "$B" && out PASS "$ROLE/probe.completed" "confined and baseline probes ran to the end" \
    || out FAIL "$ROLE/probe.completed" "a probe did not finish"
  # --- the kernel's own record: every class of denied operation shows up as a Sandbox deny
  local pid missing="" cls
  pid=$(grep -o '^# j0probe pid=[0-9]*' "$C" | cut -d= -f2)
  for cls in file-read file-write network-outbound network-bind mach-lookup process-info signal sysctl-read process-exec; do
    grep -qE "\($pid\) deny\([0-9]+\) $cls" "$RES/sandbox-log.txt" || missing="$missing $cls"
  done
  [ -z "$missing" ] && out PASS "$ROLE/sandbox_log.corroborates" "kernel logged denies of every class for probe pid $pid" \
    || out WEAK "$ROLE/sandbox_log.corroborates" "no Sandbox deny logged for:$missing"
}
eval_role assistant
eval_role llm

# --- sensitivity of the fd/env checks (positive baselines for the leak itself)
[[ ",$LEAK_A," == *",7,"* ]] && hp "$RES/probe-leak-control.txt" 5000 && hp "$RES/probe-leak-control.txt" 70000 \
  && out PASS fd.leak_control_detects "no launcher (raw sandbox-exec): fds $LEAK_A visible; 5000 and 70000 READABLE host-private pipes" \
  || out FAIL fd.leak_control_detects "fds=$LEAK_A planted=$PLANTED"
hp "$RES/probe-legacy-launcher.txt" 5000 && hp "$RES/probe-legacy-launcher.txt" 70000 \
  && out PASS fd.legacy_launcher_leaks "8c64b3bf launcher, confined: fds $LEAK_B — high fds above the lowered limit / >=65536 leak (the P1 bug is real)" \
  || out WEAK fd.legacy_launcher_leaks "legacy launcher did not show the high-fd leak (fds=$LEAK_B)"
grep -q 'env.no_sensitive_vars FOUND' "$RES/probe-leak-control.txt" && out PASS env.leak_control_detects "no launcher: planted BITSOV_TOKEN/HTTPS_PROXY visible" || out FAIL env.leak_control_detects "leak control did not see planted env"

# --- keychain (real tool), each confined attempt corroborated by a Sandbox deny on the keychain path
kc_block() { awk -v h="--- $1" 'index($0,h)==1{f=1;next} /^--- /{f=0} f' "$RES/keychain.txt"; }
kc_pid() { kc_block "$1" | grep -o 'j0spawn: child pid=[0-9]*' | cut -d= -f2; }
kc_logged() { local p; p=$(kc_pid "$1"); [ -n "$p" ] && grep -qE "security\($p\) deny\([0-9]+\) file-read[^ ]* $KCDIR" "$RES/sandbox-log.txt"; }
KB=$(kc_block "baseline: security find-generic-password"); KD=$(kc_block "baseline: security dump-keychain")
for role in assistant llm; do
  F=$(kc_block "confined $role: security find-generic-password"); D=$(kc_block "confined $role: security dump-keychain")
  if echo "$F" | grep -q 'secret_in_output=yes' || echo "$D" | grep -q 'secret_in_output=yes' || echo "$D" | grep -q 'j0-canary'; then
    out FAIL "$role/keychain.item_unreadable" "confined security(1) read the item"
  elif ! echo "$KB" | grep -q 'exit=0 secret_in_output=yes' || ! echo "$KD" | grep -q '"svce"<blob>="j0-canary"'; then
    out WEAK "$role/keychain.item_unreadable" "confined could not read, but the unconfined baseline did not read it either"
  elif kc_logged "confined $role: security find-generic-password" && kc_logged "confined $role: security dump-keychain"; then
    out PASS "$role/keychain.item_unreadable" "baseline read the secret + dump listed the item; confined find (exit $(echo "$F" | grep -o 'exit=[0-9]*' | cut -d= -f2)) and dump denied, Sandbox deny on the keychain file logged"
  else out WEAK "$role/keychain.item_unreadable" "confined could not read, but no Sandbox deny on the keychain file was logged"; fi
done
[ "$SL_BEFORE" = "$SL_AFTER" ] && [ "$DK_BEFORE" = "$DK_AFTER" ] && out PASS keychain.search_list_unchanged "search list and default keychain identical before/after (hashes in keychain-searchlist.txt)" \
  || out FAIL keychain.search_list_unchanged "the user search list or default keychain CHANGED — inspect manually; nothing was restored automatically"

# --- debugger (real tool)
DBB=$(awk '/^--- baseline/{f=1;next} /^---/{f=0} f' "$RES/debugger.txt")
for role in assistant llm; do
  DBC=$(awk -v h="--- confined $role:" 'index($0,h)==1{f=1;next} /^--- /{f=0} f' "$RES/debugger.txt")
  p=$(echo "$DBC" | grep -o 'j0spawn: child pid=[0-9]*' | cut -d= -f2)
  if echo "$DBC" | grep -qiE 'Process [0-9]+ (stopped|detached)|state = stopped'; then out FAIL "$role/debugger.lldb_attach" "confined lldb attached"
  elif ! echo "$DBC" | grep -q 'error: attach failed'; then out FAIL "$role/debugger.lldb_attach" "no 'attach failed' from confined lldb (did it run?)"
  elif ! echo "$DBB" | grep -qiE 'Process [0-9]+ (stopped|detached)'; then out WEAK "$role/debugger.lldb_attach" "confined failed, but baseline lldb did NOT attach either"
  elif [ -n "$p" ] && grep -qE "(lldb\($p\)|debugserver\([0-9]+\)) deny\([0-9]+\) (process-info|mach-priv-task-port|mach-task-name)" "$RES/sandbox-log.txt"; then
    out PASS "$role/debugger.lldb_attach" "baseline attached+detached; confined 'attach failed' with a Sandbox process-info/task-port deny logged"
  else out WEAK "$role/debugger.lldb_attach" "confined attach failed, but no matching Sandbox deny was logged"; fi
done

# --- evidence hygiene: no secret material in any log
LEAKED=""
grep -rqF "$KC_SECRET" "$RES" && LEAKED="$LEAKED keychain-secret"
grep -rqE 'J0-BOOTSTRAP-[0-9a-f]' "$RES" && LEAKED="$LEAKED bootstrap-secret"
grep -rqE 'J0-HOSTPRIVATE-[0-9a-f]' "$RES" && LEAKED="$LEAKED host-private-marker"
grep -rqF "$BITSOV_TOKEN_VAL" "$RES" && LEAKED="$LEAKED planted-token-value"
[ -z "$LEAKED" ] && out PASS evidence.no_secrets "no keychain secret, bootstrap secret, host-private marker or token value in any log" || out FAIL evidence.no_secrets "found:$LEAKED"

echo "---"
echo "PASS=$PASS WEAK=$WEAK FAIL=$FAIL  (WEAK = denied but inconclusive; not counted as PASS)" | tee -a "$RES/summary.txt"
copy_evidence
if [ -n "$EVID" ] && grep -rqF "$HOME" "$EVID"; then echo "WARNING: home path survived redaction in $EVID"; FAIL=$((FAIL+1)); fi
echo "results: $RES"
[ "$FAIL" = 0 ] && [ "$WEAK" = 0 ]
