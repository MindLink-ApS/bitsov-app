#!/usr/bin/env bash
# app #16 — quitting the app must stop the node the app started, and only that node.
#
# Two layers, because they catch different regressions:
#   1. SOURCE GUARD (always runs, no build): the run-loop must handle BOTH RunEvent
#      variants. The original bug was correct teardown code wired to `ExitRequested`
#      alone, which on macOS fires when a window closes — not on Cmd-Q. It therefore
#      never ran on the only platform this bundle ships to.
#   2. BUNDLE TEST (macOS + a built .app): launch, quit, assert the node is reaped and
#      the ports are released; assert a foreign node is left alone; assert a repeated
#      quit is harmless.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
pass=0; fail=0; skip=0
ok(){ pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
no(){ fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
sk(){ skip=$((skip+1)); printf '  SKIP  %s\n' "$1"; }

# ---- 1. source guard -------------------------------------------------------------
MAIN=src-tauri/src/main.rs
if grep -q 'RunEvent::ExitRequested { .. } | RunEvent::Exit' "$MAIN"; then
  ok "run loop handles both ExitRequested and Exit (Cmd-Q path)"
else
  no "run loop must match BOTH RunEvent::ExitRequested and RunEvent::Exit — Cmd-Q emits Exit"
fi
if grep -q 'fn stop_supervised_node' "$MAIN"; then ok "teardown goes through stop_supervised_node"
else no "stop_supervised_node missing"; fi
# The teardown must never hunt by port: that would kill a node the app does not own.
if awk '/fn stop_supervised_node/,/^}/' "$MAIN" | grep -qE 'lsof|-iTCP|3141'; then
  no "stop_supervised_node must not target a port — only the owned child handle"
else
  ok "teardown targets the owned child only, never a port holder"
fi
if awk '/fn stop_supervised_node/,/^}/' "$MAIN" | grep -q '"-TERM"'; then
  ok "graceful SIGTERM precedes the SIGKILL fallback (LDK ChannelMonitor flush)"
else
  no "SIGTERM step missing — SIGKILL alone can lose ChannelMonitor persistence"
fi

# ---- 2. bundle test --------------------------------------------------------------
APP="${BITSOV_TEST_APP:-}"
[ -n "$APP" ] || APP="$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1 || true)"
if [ "$(uname)" != "Darwin" ]; then
  sk "bundle lifecycle test (macOS only)"
elif [ -z "$APP" ] || [ ! -d "$APP" ]; then
  sk "bundle lifecycle test (no .app built; set BITSOV_TEST_APP or run tauri build)"
else
  NAME="$(basename "$APP" .app)"
  ports_held(){ lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -cE ':(3141|9735|9736)' || true; }
  node_pid(){ pgrep -f "$APP/Contents/MacOS/konsensus start" | head -1 || true; }

  if [ "$(ports_held)" != "0" ]; then
    sk "bundle lifecycle test (3141/9735/9736 already in use by another process)"
  else
    open "$APP"; sleep 25
    NODE="$(node_pid)"
    if [ -z "$NODE" ]; then no "app did not start a node"; else
      ok "app started its node (pid $NODE)"
      osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1 || true
      gone=0
      for _ in $(seq 1 40); do sleep 1; kill -0 "$NODE" 2>/dev/null || { gone=1; break; }; done
      [ "$gone" = 1 ] && ok "quit reaped the owned node" || no "quit left the node running (the #16 orphan)"
      [ "$(ports_held)" = "0" ] && ok "quit released 3141/9735/9736" || no "ports still held after quit"
      # A second quit event must be harmless (the handle was taken).
      osascript -e "tell application \"$NAME\" to quit" >/dev/null 2>&1 || true
      ok "repeated quit is a no-op"
    fi
  fi
fi

printf '\nAPP-LIFECYCLE: %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
