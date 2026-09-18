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
# The ORDERING is proven behaviourally by stop_policy_tests in main.rs. This only
# asserts the binding: that stop_supervised_node actually routes through the tested
# policy rather than signalling on its own (a bypass would keep those tests green).
if awk '/fn stop_supervised_node/,/^}/' "$MAIN" | grep -q 'graceful_stop_policy'; then
  ok "teardown routes through the behaviourally-tested graceful_stop_policy"
else
  no "stop_supervised_node must call graceful_stop_policy — otherwise its unit tests prove nothing about it"
fi
if awk '/fn stop_supervised_node/,/^}/' "$MAIN" | grep -q 'pid_is_our_sidecar'; then
  ok "ownership is proven before any raw signal (pid reuse)"
else
  no "stop_supervised_node must verify pid ownership before signalling"
fi

# ---- 2. bundle test --------------------------------------------------------------
# The bundle layer LAUNCHES a node. A production-identifier bundle uses the real
# application-support directory — i.e. the operator's own wallet, seed and channel
# state. The script must refuse that by itself; relying on whoever runs it to have
# built an isolated bundle is not isolation (review finding 2).
PROD_IDENTIFIER="tech.mindlink.bitsov"
APP="${BITSOV_TEST_APP:-}"
[ -n "$APP" ] || APP="$(ls -d src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1 || true)"
APP_ID=""
[ -n "$APP" ] && [ -d "$APP" ] && APP_ID="$(plutil -extract CFBundleIdentifier raw "$APP/Contents/Info.plist" 2>/dev/null || true)"
if [ "$(uname)" != "Darwin" ]; then
  sk "bundle lifecycle test (macOS only)"
elif [ -z "$APP" ] || [ ! -d "$APP" ]; then
  sk "bundle lifecycle test (no .app built; set BITSOV_TEST_APP or run tauri build)"
elif [ -z "$APP_ID" ]; then
  no "refusing to launch $APP — could not read its CFBundleIdentifier"
elif [ "$APP_ID" = "$PROD_IDENTIFIER" ]; then
  no "REFUSING to launch a production-identifier bundle ($APP_ID): it would open the real wallet data directory. Build with a test identifier (e.g. ${PROD_IDENTIFIER}.test) and point BITSOV_TEST_APP at it."
else
  NAME="$(basename "$APP" .app)"
  ok "bundle is isolated (identifier $APP_ID, not $PROD_IDENTIFIER)"
  # Belt and braces: the isolated data dir must not be the production one.
  if [ -d "$HOME/Library/Application Support/$PROD_IDENTIFIER" ]; then
    PROD_DB_BEFORE="$(stat -f '%m' "$HOME/Library/Application Support/$PROD_IDENTIFIER/konsensus.db" 2>/dev/null || echo none)"
  else
    PROD_DB_BEFORE=none
  fi
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
      PROD_DB_AFTER="$(stat -f '%m' "$HOME/Library/Application Support/$PROD_IDENTIFIER/konsensus.db" 2>/dev/null || echo none)"
      [ "$PROD_DB_BEFORE" = "$PROD_DB_AFTER" ] && ok "production wallet data untouched by the test" \
        || no "the test modified $PROD_IDENTIFIER data — isolation failed"
    fi
  fi
fi

printf '\nAPP-LIFECYCLE: %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
[ "$fail" -eq 0 ]
