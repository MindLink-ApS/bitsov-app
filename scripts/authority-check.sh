#!/usr/bin/env bash
# Executable authority gate for bitsov-app (CODEX_APP_AUTHORITY.md §G, machine form).
# Fails (non-zero) on any charter or build-readiness violation. Run in CI + before merge.
set -uo pipefail
fail=0
chk(){ if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }
# The gates audit SOURCE. Cargo/Tauri build output is generated, gitignored and never
# audited here, but it embeds crate URLs and would otherwise fail G2 on any machine that
# has run `cargo check`. The separately signature-verified sidecar under bin/ also contains
# protocol URLs; G2 below checks the app source, not the node binary's embedded strings.
control_plane_urls_ok(){
  local paths path matches rc
  paths="$(mktemp)" || return 1
  # Only this exact directory holds the downloaded sidecar. src/bin and
  # src-tauri/src/bin are source and must remain in the scan.
  if ! find src src-tauri \
    \( -path src-tauri/bin -o -type d \( -name target -o -name gen -o -name node_modules -o -name dist \) \) -prune \
    -o -type f -print0 > "$paths"; then
    rm -f "$paths"; return 1
  fi
  while IFS= read -r -d '' path; do
    if matches="$(grep -Eo "https?://[^\"' )]*/api/v1" "$path")"; then
      if printf '%s\n' "$matches" | grep -Ev '://(127\.0\.0\.1|localhost)([:/]|$)' >/dev/null; then
        echo "  non-loopback control-plane URL in $path" >&2
        rm -f "$paths"; return 1
      fi
    else
      rc=$?
      if [ "$rc" -ne 1 ]; then rm -f "$paths"; return 1; fi
    fi
  done < "$paths"
  rm -f "$paths"
}
png_icons_ok(){
  local found=0
  local f
  while IFS= read -r -d '' f; do
    found=1
    file "$f" | grep -Eq "PNG image data.*RGBA" || return 1
  done < <(find src-tauri/icons -type f -name '*.png' -print0)
  [ "$found" -eq 1 ]
}

# Fail when the renderer opens sockets or embeds absolute http(s) URLs outside
# the sample fixture module (dev/test data only; never executed as fetches).
renderer_no_direct_node_ok(){
  if grep -REqn 'fetch\(|new WebSocket|XMLHttpRequest' src/ 2>/dev/null; then
    echo "  direct network API in renderer" >&2
    return 1
  fi
  local bad
  bad="$(grep -REn 'https?://' src/ 2>/dev/null | grep -Ev '^src/control/sample\.ts:' || true)"
  if [ -n "$bad" ]; then
    printf '%s\n' "$bad" >&2
    return 1
  fi
  return 0
}

echo "== charter gates =="
chk "G1: no konsensus-* path/git dependency" \
  '! grep -REqn "konsensus[-_][a-z]+[[:space:]]*=[[:space:]]*\{?[[:space:]]*(path|git)" src-tauri/Cargo.toml Cargo.toml 2>/dev/null'
chk "G1: node declared as bundled sidecar (externalBin)" \
  'grep -q "\"externalBin\"" src-tauri/tauri.conf.json && grep -q "bin/konsensus" src-tauri/tauri.conf.json'
chk "G2: no non-loopback control-plane URL" \
  'control_plane_urls_ok'
chk "G3/G4/honesty: no banned/premature claims in copy" \
  '! grep -REqin "download now|app store|google play|replaces (slack|zoom|workspace)|surveillance-proof|unhackable|node in your pocket|always-on node|call (anyone|any phone)" src/ 2>/dev/null'
chk "G6: explicit local-trust disclosure gates the funds UI" \
  'grep -q "data-gate=\"g6-local-trust\"" src/App.tsx && grep -q "when={trustAck()}" src/App.tsx'
chk "G2: renderer holds no node credential and makes no direct node call" \
  'renderer_no_direct_node_ok'
chk "G2: no hard-coded STUN/TURN server (calls contact only an owner-set STUN)" \
  '! grep -REqin "(stuns?|turns?):(//)?[a-z0-9-]+\.[a-z0-9.-]+" src/ 2>/dev/null'
chk "shell capability: Rust owns execution; no renderer shell permissions" \
  '! grep -REq "\"shell:" src-tauri/capabilities/ src-tauri/mobile-capabilities/ src-tauri/tauri*.conf.json'
chk "CSP is set (not null)" \
  'grep -Eq "\"csp\"[[:space:]]*:[[:space:]]*\"" src-tauri/tauri.conf.json'

echo "== build readiness =="
chk "app icons are valid RGBA PNG files" 'png_icons_ok'
chk "npm lockfile committed" 'test -s package-lock.json'
chk "cargo lockfile committed" 'test -s src-tauri/Cargo.lock'
chk "signed-sidecar fetch script present + executable" 'test -x scripts/fetch-node-sidecar.sh'

echo
if [ "$fail" -eq 0 ]; then echo "AUTHORITY: PASS"; else echo "AUTHORITY: FAIL"; fi
exit $fail
