#!/usr/bin/env bash
# J0 Phase 0.5 — the model still loads its weights under confinement (macOS, mock only).
#
#  M0  baseline: llama-simple UNCONFINED, -ngl 99 (speed reference)
#  M1  llama-simple CONFINED (ROLE=llm, weights dir read-only), -ngl 99 → completion + Metal offload
#  M2  weights immutability from the confined LLM role (create / append-open / hard-link out)
#  M3  llama-server CONFINED (ROLE=llm) serving ONLY a unix socket; a CONFINED assistant
#      (ROLE=assistant, j0uclient) gets a completion over that socket; TCP to the server is impossible
#      because it has no TCP listener and the sandbox forbids one
#  M4  model file sha256 unchanged
#  M5  negative control: the same llama.cpp under ROLE=assistant sees no Metal device
#
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
[ -f "$MODEL" ] || { echo "need --model FILE.gguf" >&2; exit 2; }
LLAMA_BIN="$(cd "$LLAMA_BIN" && pwd -P)"
MODEL="$(cd "$(dirname "$MODEL")" && pwd -P)/$(basename "$MODEL")"
WDIR="$(dirname "$MODEL")"

ROOT="$(cd "$(mktemp -d /tmp/j0-canary-model-XXXX)" && pwd -P)"
BIN="$ROOT/bin"; S_LLM="$ROOT/scratch-llm"; S_AS="$ROOT/scratch-assistant"
IPC="$ROOT/ipc"; LISTEN="$IPC/llm"; RES="$ROOT/results"
mkdir -p "$BIN" "$S_LLM" "$S_AS" "$LISTEN" "$RES"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill "$SERVER_PID"; wait "$SERVER_PID" 2>/dev/null; fi
  if [ -n "$EVID" ] && [ -d "$RES" ]; then mkdir -p "$EVID" && cp "$RES"/* "$EVID"/ 2>/dev/null; fi
  if [ "$KEEP" = 0 ]; then rm -rf "$ROOT"; else echo "kept $ROOT"; fi
}
trap cleanup EXIT

clang -O1 -Wall -Wno-deprecated-declarations -o "$BIN/j0spawn" "$HERE/j0spawn.c" || exit 2
# The assistant stand-in: /usr/bin/curl is unusable confined (Apple's LibreSSL insists on reading
# /private/etc/ssl/openssl.cnf and ignores OPENSSL_CONF), so a 60-line unix-socket HTTP client is used.
clang -O1 -Wall -o "$BIN/j0uclient" "$HERE/j0uclient.c" || exit 2

LLM_P=(--param "ROLE=llm" --param "SCRATCH=$S_LLM" --param "LISTEN_DIR=$LISTEN" --param "IPC_DIR=$ROOT/none"
       --param "EXEC_DIR=$LLAMA_BIN" --param "LIB_DIR=$LLAMA_BIN" --param "WEIGHTS=$WDIR")
LLM_E=(--env "PATH=/usr/bin:/bin" --env "HOME=$S_LLM" --env "TMPDIR=$S_LLM/" --env "LANG=C")
AS_P=(--param "ROLE=assistant" --param "SCRATCH=$S_AS" --param "IPC_DIR=$IPC" --param "EXEC_DIR=$BIN"
      --param "LIB_DIR=$BIN" --param "WEIGHTS=$ROOT/none")
AS_E=(--env "PATH=/usr/bin:/bin" --env "HOME=$S_AS" --env "TMPDIR=$S_AS/" --env "LANG=C")

PASS=0; FAIL=0
out() { printf '%-4s %-40s %s\n' "$1" "$2" "$3" | tee -a "$RES/summary.txt"; [ "$1" = PASS ] && PASS=$((PASS+1)); [ "$1" = FAIL ] && FAIL=$((FAIL+1)); return 0; }
: > "$RES/summary.txt"

PROMPT="The three primary colors of light are"
{ echo "model: $MODEL"; ls -l "$MODEL"; echo "llama.cpp: $(git -C "$LLAMA_BIN/../.." rev-parse --short HEAD 2>/dev/null)"; sw_vers; sysctl -n machdep.cpu.brand_string; } > "$RES/env.txt"
echo "== M4a sha256 before"; SHA_BEFORE=$(shasum -a 256 "$MODEL" | cut -d' ' -f1); echo "$SHA_BEFORE"

echo "== M0 baseline (unconfined) llama-simple -ngl 99"
"$BIN/j0spawn" --no-sandbox "${LLM_E[@]}" -- "$LLAMA_BIN/llama-simple" -m "$MODEL" -ngl 99 -n 48 "$PROMPT" </dev/null > "$RES/M0-unconfined.txt" 2>&1
echo "exit=$?" >> "$RES/M0-unconfined.txt"

echo "== M1 CONFINED llama-simple -ngl 99"
"$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- "$LLAMA_BIN/llama-simple" -m "$MODEL" -ngl 99 -n 48 "$PROMPT" </dev/null > "$RES/M1-confined.txt" 2>&1
M1RC=$?; echo "exit=$M1RC" >> "$RES/M1-confined.txt"
OFF=$(grep -o 'offloaded [0-9]*/[0-9]* layers to GPU' "$RES/M1-confined.txt" | head -1)
DEV=$(grep -oE 'using device [A-Za-z0-9]+ \([^)]*\)|found device: [^,]*|GPU name: *[A-Za-z0-9 ]*' "$RES/M1-confined.txt" | head -1)
SPEED1=$(grep -oE 'speed: [0-9.]+ t/s' "$RES/M1-confined.txt" | head -1)
SPEED0=$(grep -oE 'speed: [0-9.]+ t/s' "$RES/M0-unconfined.txt" | head -1)
if [ "$M1RC" = 0 ] && grep -q "$PROMPT" "$RES/M1-confined.txt" && [ -n "$OFF" ]; then
  out PASS M1.confined_model_load_and_complete "$OFF; $DEV; confined $SPEED1 vs unconfined $SPEED0"
else out FAIL M1.confined_model_load_and_complete "exit=$M1RC offload='$OFF' (see M1-confined.txt)"; fi

echo "== M2 weights immutable from the confined LLM"
{
  echo "--- touch new file in weights dir"
  "$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- /usr/bin/touch "$WDIR/j0-created-by-confined-llm" </dev/null 2>&1; echo "exit=$?"
  echo "--- open model for append (zero bytes written)"
  "$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- /bin/sh -c 'exec 3>>"$1"' sh "$MODEL" </dev/null 2>&1; echo "exit=$?"
  echo "--- hard-link model into own scratch"
  "$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- /bin/ln "$MODEL" "$S_LLM/model-hardlink.gguf" </dev/null 2>&1; echo "exit=$?"
} > "$RES/M2-weights-write.txt" 2>&1
N_EXIT0=$(grep -c '^exit=0$' "$RES/M2-weights-write.txt")
if [ "$N_EXIT0" = 0 ] && [ ! -e "$WDIR/j0-created-by-confined-llm" ] && [ ! -e "$S_LLM/model-hardlink.gguf" ]; then
  out PASS M2.weights_immutable "create, append-open and hard-link-out all denied"
else
  out FAIL M2.weights_immutable "$N_EXIT0 attempt(s) succeeded (see M2-weights-write.txt)"
  rm -f "$WDIR/j0-created-by-confined-llm" "$S_LLM/model-hardlink.gguf"  # only our own artefacts
fi

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
{
  echo "--- server ready=$READY; TCP listeners owned by the confined server:"
  CHILD=$(pgrep -P "$SERVER_PID" | head -1)
  echo "server pid=$CHILD"; lsof -nP -a -p "$CHILD" -iTCP 2>/dev/null || echo "(none)"
  echo "--- confined assistant: POST /completion over the unix socket"
  "$BIN/j0spawn" --profile "$PROFILE" "${AS_P[@]}" "${AS_E[@]}" -- "$BIN/j0uclient" "$LISTEN/llm.sock" POST /completion \
    "{\"prompt\":\"$PROMPT\",\"n_predict\":32,\"temperature\":0}" </dev/null
  echo; echo "exit=$?"
} > "$RES/M3-assistant.txt" 2>&1
if [ "$READY" = 1 ] && grep -q '"content"' "$RES/M3-assistant.txt" && grep -q '(none)' "$RES/M3-assistant.txt"; then
  out PASS M3.socket_only_server_and_assistant "confined server answered a confined assistant over $LISTEN/llm.sock; no TCP listener"
else out FAIL M3.socket_only_server_and_assistant "ready=$READY (see M3-server.txt / M3-assistant.txt)"; fi
grep -o 'offloaded [0-9]*/[0-9]* layers to GPU' "$RES/M3-server.txt" | head -1 | sed 's/^/M3 server: /'
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""

echo "== M5 negative control: the assistant role gets no GPU (no IOKit/Metal allowance)"
"$BIN/j0spawn" --profile "$PROFILE" --param "ROLE=assistant" --param "SCRATCH=$S_AS" --param "IPC_DIR=$IPC" \
  --param "EXEC_DIR=$LLAMA_BIN" --param "LIB_DIR=$LLAMA_BIN" --param "WEIGHTS=$ROOT/none" "${AS_E[@]}" \
  -- "$LLAMA_BIN/llama-cli" --list-devices </dev/null > "$RES/M5-assistant-devices.txt" 2>&1
"$BIN/j0spawn" --profile "$PROFILE" "${LLM_P[@]}" "${LLM_E[@]}" -- "$LLAMA_BIN/llama-cli" --list-devices </dev/null > "$RES/M5-llm-devices.txt" 2>&1
if grep -q 'MTL0' "$RES/M5-llm-devices.txt" && ! grep -q 'MTL0' "$RES/M5-assistant-devices.txt"; then
  out PASS M5.gpu_only_for_llm_role "llm: $(grep -o 'MTL0: [^(]*' "$RES/M5-llm-devices.txt" | head -1); assistant: no Metal device"
else out FAIL M5.gpu_only_for_llm_role "see M5-*.txt"; fi

echo "== M4b sha256 after"
SHA_AFTER=$(shasum -a 256 "$MODEL" | cut -d' ' -f1)
[ "$SHA_BEFORE" = "$SHA_AFTER" ] && out PASS M4.model_bytes_unchanged "sha256 $SHA_AFTER" || out FAIL M4.model_bytes_unchanged "$SHA_BEFORE -> $SHA_AFTER"
echo "sha256=$SHA_AFTER" >> "$RES/env.txt"

echo "---"; echo "PASS=$PASS FAIL=$FAIL" | tee -a "$RES/summary.txt"
[ "$FAIL" = 0 ]
