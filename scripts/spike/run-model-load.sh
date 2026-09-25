#!/usr/bin/env bash
# J0 Phase 0.5 — the model still loads its weights under confinement (macOS, mock only).
#
#  M0  baseline: llama-simple UNCONFINED, -ngl 99 (must succeed; it is M1's positive control)
#  M1  llama-simple CONFINED (ROLE=llm, weights dir read-only), -ngl 99 → completion + full Metal offload
#  M2  weights immutability from the confined LLM role (create / append-open / hard-link out), each
#      with an UNCONFINED same-operation baseline, a specific "Operation not permitted" and a
#      kernel Sandbox deny for the confined attempt
#  M3  llama-server CONFINED (ROLE=llm) serving ONLY its unix socket; a CONFINED assistant
#      (ROLE=assistant, j0uclient) gets a completion over it (client exit status checked);
#      lsof must SUCCEED on the server and show the unix socket and no TCP/UDP
#  M4  model file sha256 unchanged (non-empty 64-hex both times; compared with Lane 2's marker)
#  M5  GPU only for ROLE=llm: unconfined and confined-llm list MTL0; confined-assistant runs to
#      exit 0 and lists no Metal device
#
# Scoring as in run-isolation-tests.sh: PASS / WEAK (no successful baseline or no kernel
# corroboration: inconclusive, not counted as PASS) / FAIL.
#
# Nothing is ever deleted from the model directory except a file this run itself created there:
# M2 uses fresh random names (mktemp -u), refuses to run if one already exists, and removes only
# that exact path, only after proving it was absent before.
# Weights are never copied into the repo. Nothing binds TCP; port 3141 is never used.
# Usage: scripts/spike/run-model-load.sh --model FILE.gguf [--llama-bin DIR] [--evidence-dir DIR] [--keep]

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PROFILE="$HERE/j0-confined-child.sb"
LLAMA_BIN="$HOME/Desktop/seat-drafts/llama.cpp/build/bin"
MODEL=""; EVID=""; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) MODEL="$2"; shift ;;
    --llama-bin) LLAMA_BIN="$2"; shift ;;
    --evidence-dir) EVID="$2"; shift ;;
    --keep) KEEP=1 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
  shift
done
die() { echo "FATAL: $*" >&2; exit 2; }
[ -f "$MODEL" ] || die "need --model FILE.gguf"
LLAMA_BIN="$(cd "$LLAMA_BIN" && pwd -P)" || die "llama bin"
MODEL="$(cd "$(dirname "$MODEL")" && pwd -P)/$(basename "$MODEL")" || die "model path"
WDIR="$(dirname "$MODEL")"

ROOT="$(mktemp -d /tmp/j0-canary-model-XXXXXXXX)" || die "mktemp"
ROOT="$(cd "$ROOT" && pwd -P)" || die "canonicalize"
case "$ROOT" in /private/tmp/j0-canary-model-????????) ;; *) die "unexpected temp root $ROOT" ;; esac
BIN="$ROOT/bin"; S_LLM="$ROOT/scratch-llm"; S_AS="$ROOT/scratch-assistant"
IPC="$ROOT/ipc"; LISTEN="$IPC/llm"; RES="$ROOT/results"
mkdir -p "$BIN" "$S_LLM" "$S_AS" "$LISTEN" "$RES" || die "mkdir"
SERVER_PID=""; EVID_DONE=0
redact() { /usr/bin/perl -pe 'BEGIN{$h=shift @ARGV; $u=shift @ARGV} s/\Q$h\E/~/g; s#/Users/[^/\s]+#/Users/<user>#g; s/\Q$u\E/<user>/g' "$HOME" "$(id -un)" "$1"; }
copy_evidence() {
  [ -n "$EVID" ] && [ -d "$RES" ] || return 0
  mkdir -p "$EVID" || return 1
  rm -f "$EVID"/*.txt 2>/dev/null
  for f in "$RES"/*; do [ -f "$f" ] && redact "$f" > "$EVID/$(basename "$f")"; done
  EVID_DONE=1
}
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null; fi
  [ "$EVID_DONE" = 1 ] || copy_evidence
  case "$ROOT" in
    /private/tmp/j0-canary-model-????????) if [ "$KEEP" = 0 ]; then rm -rf "$ROOT"; else echo "kept $ROOT"; fi ;;
  esac
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

clang -O1 -Wall -Wno-deprecated-declarations -o "$BIN/j0spawn" "$HERE/j0spawn.c" || die "build j0spawn"
# The assistant stand-in: /usr/bin/curl is unusable confined (Apple's LibreSSL insists on reading
# /private/etc/ssl/openssl.cnf and ignores OPENSSL_CONF), so a small unix-socket HTTP client is used.
clang -O1 -Wall -o "$BIN/j0uclient" "$HERE/j0uclient.c" || die "build j0uclient"

LLM_P=(--param "ROLE=llm" --param "SCRATCH=$S_LLM" --param "LISTEN_SOCK=$LISTEN/llm.sock" --param "IPC_DIR=$ROOT/none"
       --param "EXEC_DIR=$LLAMA_BIN" --param "LIB_DIR=$LLAMA_BIN" --param "WEIGHTS=$WDIR")
LLM_E=(--chdir "$S_LLM" --env "PATH=/usr/bin:/bin" --env "HOME=$S_LLM" --env "TMPDIR=$S_LLM/" --env "LANG=C")
AS_P=(--param "ROLE=assistant" --param "SCRATCH=$S_AS" --param "IPC_DIR=$IPC" --param "EXEC_DIR=$BIN"
      --param "LIB_DIR=$BIN" --param "WEIGHTS=$ROOT/none")
AS_E=(--chdir "$S_AS" --env "PATH=/usr/bin:/bin" --env "HOME=$S_AS" --env "TMPDIR=$S_AS/" --env "LANG=C")

PASS=0; WEAK=0; FAIL=0
out() { printf '%-4s %-40s %s\n' "$1" "$2" "$3" | tee -a "$RES/summary.txt"
        case "$1" in PASS) PASS=$((PASS+1)) ;; WEAK) WEAK=$((WEAK+1)) ;; FAIL) FAIL=$((FAIL+1)) ;; esac; return 0; }
: > "$RES/summary.txt"
LOG_START="$(date '+%Y-%m-%d %H:%M:%S')"

PROMPT="The three primary colors of light are"
{ echo "model: $MODEL"; ls -l "$MODEL"; echo "llama.cpp: $(git -C "$LLAMA_BIN/../.." rev-parse --short HEAD 2>/dev/null)"; sw_vers; sysctl -n machdep.cpu.brand_string; } > "$RES/env.txt"
echo "== M4a sha256 before"; SHA_BEFORE=$(shasum -a 256 "$MODEL" | cut -d' ' -f1); echo "sha256_before=$SHA_BEFORE" | tee -a "$RES/env.txt"

offload() { grep -o 'offloaded [0-9]*/[0-9]* layers to GPU' "$1" | head -1; }
full_offload() { local o; o=$(offload "$1"); [[ "$o" =~ offloaded\ ([0-9]+)/([0-9]+) ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] && [ "${BASH_REMATCH[1]}" -gt 0 ]; }
# The prompt followed by at least 20 more characters of generated text on the same line.
completed() { grep -qE "$PROMPT.{20,}" "$1"; }

echo "== M0 baseline (unconfined) llama-simple -ngl 99"
"$BIN/j0spawn" --no-sandbox "${LLM_E[@]}" -- "$LLAMA_BIN/llama-simple" -m "$MODEL" -ngl 99 -n 48 "$PROMPT" </dev/null > "$RES/M0-unconfined.txt" 2>&1
M0RC=$?; echo "exit=$M0RC" >> "$RES/M0-unconfined.txt"
M0OK=no; [ "$M0RC" = 0 ] && full_offload "$RES/M0-unconfined.txt" && completed "$RES/M0-unconfined.txt" && M0OK=yes

echo "== M1 CONFINED llama-simple -ngl 99"
"$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- "$LLAMA_BIN/llama-simple" -m "$MODEL" -ngl 99 -n 48 "$PROMPT" </dev/null > "$RES/M1-confined.txt" 2>&1
M1RC=$?; echo "exit=$M1RC" >> "$RES/M1-confined.txt"
OFF=$(offload "$RES/M1-confined.txt")
DEV=$(grep -oE 'using device [A-Za-z0-9]+ \([^)]*\)' "$RES/M1-confined.txt" | head -1)
SPEED1=$(grep -oE 'speed: [0-9.]+ t/s' "$RES/M1-confined.txt" | head -1)
SPEED0=$(grep -oE 'speed: [0-9.]+ t/s' "$RES/M0-unconfined.txt" | head -1)
if [ "$M1RC" = 0 ] && full_offload "$RES/M1-confined.txt" && completed "$RES/M1-confined.txt"; then
  [ "$M0OK" = yes ] && out PASS M1.confined_model_load_and_complete "$OFF; $DEV; confined $SPEED1 vs unconfined $SPEED0 (M0 baseline OK)" \
    || out WEAK M1.confined_model_load_and_complete "confined OK but the unconfined M0 baseline failed"
else out FAIL M1.confined_model_load_and_complete "exit=$M1RC offload='$OFF' (see M1-confined.txt)"; fi

echo "== M2 weights immutable from the confined LLM"
# Fresh random names in the model dir; refuse if either exists (never touch a pre-existing file).
NEW_B=$(mktemp -u "$WDIR/.j0-m2-baseline-XXXXXXXXXXXX"); NEW_C=$(mktemp -u "$WDIR/.j0-m2-confined-XXXXXXXXXXXX")
[ ! -e "$NEW_B" ] && [ ! -L "$NEW_B" ] && [ ! -e "$NEW_C" ] && [ ! -L "$NEW_C" ] || die "M2 test name already exists; refusing"
TOOL_P=("${LLM_P[@]}" --param "SYSTEM_EXEC=yes")
# Removes $1 only if it is a regular file created by this run (proved absent above).
rm_own() { if [ -f "$1" ] && [ ! -L "$1" ]; then rm -f -- "$1" && echo "removed own artefact $(basename "$1")"; fi; }
{
  echo "--- baseline (unconfined): touch new file in weights dir"
  /usr/bin/touch "$NEW_B" 2>&1; echo "exit=$?"; [ -f "$NEW_B" ] && echo "created=yes" || echo "created=no"; rm_own "$NEW_B"
  echo "--- baseline (unconfined): open model for append (zero bytes written)"
  /bin/sh -c 'exec 3>>"$1"' sh "$MODEL" 2>&1; echo "exit=$?"
  echo "--- baseline (unconfined): hard-link model into scratch"
  /bin/ln "$MODEL" "$S_LLM/model-hardlink-baseline.gguf" 2>&1; echo "exit=$?"; rm -f "$S_LLM/model-hardlink-baseline.gguf"
  echo "--- confined: touch new file in weights dir"
  "$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_P[@]}" "${LLM_E[@]}" -- /usr/bin/touch "$NEW_C" </dev/null 2>&1; echo "exit=$?"
  [ -e "$NEW_C" ] && echo "created=yes" || echo "created=no"; rm_own "$NEW_C"
  echo "--- confined: open model for append (zero bytes written)"
  "$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_P[@]}" "${LLM_E[@]}" -- /bin/sh -c 'exec 3>>"$1"' sh "$MODEL" </dev/null 2>&1; echo "exit=$?"
  echo "--- confined: hard-link model into own scratch"
  "$BIN/j0spawn" --profile "$PROFILE" --report "${TOOL_P[@]}" "${LLM_E[@]}" -- /bin/ln "$MODEL" "$S_LLM/model-hardlink.gguf" </dev/null 2>&1; echo "exit=$?"
  [ -e "$S_LLM/model-hardlink.gguf" ] && echo "created=yes" || echo "created=no"; rm -f "$S_LLM/model-hardlink.gguf"
} > "$RES/M2-weights-write.txt" 2>&1
blk() { awk -v h="--- $1" 'index($0,h)==1{f=1;next} /^--- /{f=0} f' "$RES/M2-weights-write.txt"; }
M2B_OK=yes
blk "baseline (unconfined): touch" | grep -q '^created=yes' || M2B_OK=no
blk "baseline (unconfined): open model" | grep -q '^exit=0$' || M2B_OK=no
blk "baseline (unconfined): hard-link" | grep -q '^exit=0$' || M2B_OK=no
M2C_OK=yes; M2_PIDS=""
for t in "confined: touch|$NEW_C: Operation not permitted" "confined: open model|$MODEL: Operation not permitted" \
         "confined: hard-link|model-hardlink.gguf: Operation not permitted"; do
  b=$(blk "${t%%|*}")
  echo "$b" | grep -q '^exit=0$' && M2C_OK=no
  echo "$b" | grep -q '^created=yes' && M2C_OK=no
  echo "$b" | grep -qF "${t#*|}" || M2C_OK=no
  M2_PIDS="$M2_PIDS $(echo "$b" | grep -o 'j0spawn: child pid=[0-9]*' | cut -d= -f2)"
done

echo "== M3 confined llama-server on a unix socket, queried by a confined assistant"
"$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- "$LLAMA_BIN/llama-server" -m "$MODEL" -ngl 99 -c 4096 \
  --host "$LISTEN/llm.sock" --no-webui </dev/null > "$RES/M3-server.txt" 2>&1 &
SERVER_PID=$!
READY=0
for _ in $(seq 120); do
  if [ -S "$LISTEN/llm.sock" ] && "$BIN/j0spawn" --profile "$PROFILE" "${AS_P[@]}" "${AS_E[@]}" -- "$BIN/j0uclient" "$LISTEN/llm.sock" GET /health </dev/null 2>/dev/null | grep -q '"ok"'; then READY=1; break; fi
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
CHILD=$(pgrep -P "$SERVER_PID" | head -1)
LSOF_ALL=$([ -n "$CHILD" ] && lsof -nP -a -p "$CHILD" 2>&1); LSOF_RC=$?
NET_LINES=$(printf '%s\n' "$LSOF_ALL" | grep -cE ' (IPv4|IPv6) ')
UNIX_LINES=$(printf '%s\n' "$LSOF_ALL" | grep -c ' unix ')
"$BIN/j0spawn" --profile "$PROFILE" "${AS_P[@]}" "${AS_E[@]}" -- "$BIN/j0uclient" "$LISTEN/llm.sock" POST /completion \
  "{\"prompt\":\"$PROMPT\",\"n_predict\":32,\"temperature\":0}" </dev/null > "$RES/M3-response.txt" 2>&1
CLIENT_RC=$?
{
  echo "--- server ready=$READY; server pid=${CHILD:-none}"
  echo "--- lsof -nP -a -p <server>: rc=$LSOF_RC, $(printf '%s\n' "$LSOF_ALL" | grep -c .) lines, IPv4/IPv6 lines=$NET_LINES, unix lines=$UNIX_LINES"
  printf '%s\n' "$LSOF_ALL" | grep -E ' (IPv4|IPv6|unix) ' | awk '{print $4, $5, $NF}'
  echo "--- confined assistant: POST /completion over the unix socket (client exit=$CLIENT_RC)"
  cut -c1-400 "$RES/M3-response.txt"
} > "$RES/M3-assistant.txt" 2>&1
rm -f "$RES/M3-response.txt"
if [ "$READY" = 1 ] && [ "$CLIENT_RC" = 0 ] && grep -q '"content":"[^"]\{10,\}' "$RES/M3-assistant.txt" && [ "$LSOF_RC" = 0 ] && [ "$NET_LINES" = 0 ] && [ "$UNIX_LINES" -ge 1 ]; then
  out PASS M3.socket_only_server_and_assistant "confined server answered a confined assistant (client exit 0) over its unix socket; lsof OK: $UNIX_LINES unix, 0 IPv4/IPv6"
else out FAIL M3.socket_only_server_and_assistant "ready=$READY client_rc=$CLIENT_RC lsof_rc=$LSOF_RC net=$NET_LINES unix=$UNIX_LINES"; fi
grep -o 'offloaded [0-9]*/[0-9]* layers to GPU' "$RES/M3-server.txt" | head -1 | sed 's/^/M3 server: /'
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""

echo "== M5 GPU only for ROLE=llm"
"$LLAMA_BIN/llama-cli" --list-devices </dev/null > "$RES/M5-unconfined-devices.txt" 2>&1; M5U=$?
"$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- "$LLAMA_BIN/llama-cli" --list-devices </dev/null > "$RES/M5-llm-devices.txt" 2>&1; M5L=$?
"$BIN/j0spawn" --profile "$PROFILE" --param "ROLE=assistant" --param "SCRATCH=$S_AS" --param "IPC_DIR=$IPC" \
  --param "EXEC_DIR=$LLAMA_BIN" --param "LIB_DIR=$LLAMA_BIN" --param "WEIGHTS=$ROOT/none" "${AS_E[@]}" \
  -- "$LLAMA_BIN/llama-cli" --list-devices </dev/null > "$RES/M5-assistant-devices.txt" 2>&1; M5A=$?
echo "exit=$M5U" >> "$RES/M5-unconfined-devices.txt"; echo "exit=$M5L" >> "$RES/M5-llm-devices.txt"; echo "exit=$M5A" >> "$RES/M5-assistant-devices.txt"
if [ "$M5L" = 0 ] && grep -q 'MTL0' "$RES/M5-llm-devices.txt" && [ "$M5A" = 0 ] && grep -q '^Available devices' "$RES/M5-assistant-devices.txt" && ! grep -q 'MTL0' "$RES/M5-assistant-devices.txt"; then
  [ "$M5U" = 0 ] && grep -q 'MTL0' "$RES/M5-unconfined-devices.txt" \
    && out PASS M5.gpu_only_for_llm_role "unconfined + llm: $(grep -o 'MTL0: [^(]*' "$RES/M5-llm-devices.txt" | head -1); assistant (exit 0): no Metal device" \
    || out WEAK M5.gpu_only_for_llm_role "role split holds, but the unconfined baseline did not list MTL0"
else out FAIL M5.gpu_only_for_llm_role "exits u=$M5U llm=$M5L assistant=$M5A (see M5-*.txt)"; fi

echo "== M4b sha256 after"
SHA_AFTER=$(shasum -a 256 "$MODEL" | cut -d' ' -f1); echo "sha256_after=$SHA_AFTER" >> "$RES/env.txt"
MARK=$(sed -n "s/^model_sha256=//p" "$HOME/Desktop/seat-drafts/models/LANE2-READY" 2>/dev/null)
MARKMODEL=$(sed -n "s/^model=//p" "$HOME/Desktop/seat-drafts/models/LANE2-READY" 2>/dev/null)
if [[ "$SHA_BEFORE" =~ ^[0-9a-f]{64}$ ]] && [ "$SHA_BEFORE" = "$SHA_AFTER" ]; then
  if [ "$MARKMODEL" = "$MODEL" ] && [ -n "$MARK" ]; then
    [ "$MARK" = "$SHA_AFTER" ] && out PASS M4.model_bytes_unchanged "sha256 $SHA_AFTER before = after = Lane 2 marker" || out FAIL M4.model_bytes_unchanged "matches before/after but NOT Lane 2's marker $MARK"
  else out PASS M4.model_bytes_unchanged "sha256 $SHA_AFTER before = after (no Lane 2 marker for this file)"; fi
else out FAIL M4.model_bytes_unchanged "before='$SHA_BEFORE' after='$SHA_AFTER'"; fi

# Kernel corroboration for M2 (wait for the log to catch up, max 60 s).
LAST=$(echo $M2_PIDS | awk '{print $NF}')
for _ in $(seq 30); do
  /usr/bin/log show --start "$LOG_START" --style compact --predicate 'sender == "Sandbox"' 2>/dev/null | grep -q "(${LAST:-none}) deny" && break
  sleep 2
done
PIDRE=$(echo $M2_PIDS | tr ' ' '|')
/usr/bin/log show --start "$LOG_START" --style compact --predicate 'sender == "Sandbox"' 2>/dev/null |
  grep -E "Sandbox: [^ ]+\((${PIDRE:-none})\) deny" | sed -E 's/^([0-9-]+ [0-9:.]+).*Sandbox: /\1 /' > "$RES/sandbox-log.txt"
M2_LOGGED=yes
for p in $M2_PIDS; do grep -qE "\($p\) deny\([0-9]+\) (file-write|file-link|forbidden-link)" "$RES/sandbox-log.txt" || M2_LOGGED=no; done
if [ "$M2C_OK" = yes ]; then
  if [ "$M2B_OK" = yes ] && [ "$M2_LOGGED" = yes ]; then out PASS M2.weights_immutable "create, append-open, hard-link-out: baseline OK, confined 'Operation not permitted' + kernel Sandbox deny each"
  else out WEAK M2.weights_immutable "confined denied, but baseline_ok=$M2B_OK kernel_deny_logged=$M2_LOGGED"; fi
else out FAIL M2.weights_immutable "a confined write succeeded or failed without EPERM (see M2-weights-write.txt)"; fi

echo "---"; echo "PASS=$PASS WEAK=$WEAK FAIL=$FAIL" | tee -a "$RES/summary.txt"
copy_evidence
[ -n "$EVID" ] && grep -rqF "$HOME" "$EVID" && { echo "WARNING: home path survived redaction"; FAIL=$((FAIL+1)); }
[ "$FAIL" = 0 ] && [ "$WEAK" = 0 ]
