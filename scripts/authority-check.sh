#!/usr/bin/env bash
# Executable authority gate for bitsov-app (CODEX_APP_AUTHORITY.md §G, machine form).
# Fails (non-zero) on any charter or build-readiness violation. Run in CI + before merge.
set -uo pipefail
fail=0
chk(){ if eval "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; fail=1; fi; }
png_icons_ok(){
  local found=0
  local f
  while IFS= read -r -d '' f; do
    found=1
    file "$f" | grep -Eq "PNG image data.*RGBA" || return 1
  done < <(find src-tauri/icons -type f -name '*.png' -print0)
  [ "$found" -eq 1 ]
}

echo "== charter gates =="
chk "G1: no konsensus-* path/git dependency" \
  '! grep -REqn "konsensus[-_][a-z]+[[:space:]]*=[[:space:]]*\{?[[:space:]]*(path|git)" src-tauri/Cargo.toml Cargo.toml 2>/dev/null'
chk "G1: node declared as bundled sidecar (externalBin)" \
  'grep -q "\"externalBin\"" src-tauri/tauri.conf.json && grep -q "bin/konsensus" src-tauri/tauri.conf.json'
chk "G2: no non-loopback control-plane URL" \
  '! (grep -REoh "https?://[^\"'"'"' )]*/api/v1" src/ src-tauri/ 2>/dev/null | grep -qvE "://(127\.0\.0\.1|localhost)([:/]|\$)")'
chk "G3/G4/honesty: no banned/premature claims in copy" \
  '! grep -REqin "download now|app store|google play|replaces (slack|zoom|workspace)|surveillance-proof|unhackable|node in your pocket|always-on node|call (anyone|any phone)" src/ 2>/dev/null'
chk "shell capability: no broad spawn/kill, sidecar-scoped only" \
  '! grep -Eq "\"shell:allow-(spawn|kill)\"" src-tauri/capabilities/default.json && grep -q "\"sidecar\": true" src-tauri/capabilities/default.json'
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
