#!/usr/bin/env bash
# No-network test for scripts/check-mac-bundle.sh. Builds fake BitSov.app trees
# (text files standing in for the Mach-O executables) and asserts the checker
# passes the good tree and fails each broken one. Nothing is built, launched or
# downloaded. Runs on Linux (python3 plistlib) and macOS (plutil).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/check-mac-bundle.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cases=0

plist() {
  local min="$1"
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>bitsov-app</string>
  <key>CFBundleIdentifier</key>
  <string>tech.mindlink.bitsov</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>LSMinimumSystemVersion</key>
  <string>${min}</string>
</dict>
</plist>
EOF
}

# good_tree <dir>: a bundle the checker must accept. The app binary carries the
# legitimate "/assistant.html" navigation literal that app.rs compiles into
# every build; only the page's own markers are refused.
good_tree() {
  local d="$1" app="$1/BitSov.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$d/dist/assets" "$d/bin"
  printf 'fake app\0/assistant.html\0/index.html\0/assets/index-abc123.js\0' > "$app/Contents/MacOS/bitsov-app"
  printf 'fake node\0bytes\0' > "$d/bin/konsensus-aarch64-apple-darwin"
  cp "$d/bin/konsensus-aarch64-apple-darwin" "$app/Contents/MacOS/konsensus"
  chmod 0755 "$app/Contents/MacOS/bitsov-app" "$app/Contents/MacOS/konsensus" \
    "$d/bin/konsensus-aarch64-apple-darwin"
  printf 'icns' > "$app/Contents/Resources/icon.icns"
  plist 11.0 > "$app/Contents/Info.plist"
  printf '<!doctype html><title>BitSov</title>\n' > "$d/dist/index.html"
  printf 'console.log(1)\n' > "$d/dist/assets/index-abc123.js"
}

run_check() {
  local d="$1"
  bash "$CHECK" --app "$d/BitSov.app" --sidecar "$d/bin/konsensus-aarch64-apple-darwin" \
    --dist "$d/dist" > "$d/result.log" 2>&1
}

# expect <pass|fail> <label> <expected output substring> <mutation...>
expect() {
  local want="$1" label="$2" needle="$3" d rc=0
  shift 3
  cases=$((cases + 1))
  d="$TMP/case$cases"
  good_tree "$d"
  (cd "$d" && "$@")
  run_check "$d" || rc=$?
  if [ "$want" = pass ] && { [ "$rc" -ne 0 ] || ! grep -q '^MAC BUNDLE CHECK: PASS$' "$d/result.log"; }; then
    cat "$d/result.log"; echo "FAIL: $label (exit $rc, expected PASS)" >&2; exit 1
  fi
  if [ "$want" = fail ] && { [ "$rc" -ne 1 ] || ! grep -q '^MAC BUNDLE CHECK: FAIL$' "$d/result.log"; }; then
    cat "$d/result.log"; echo "FAIL: $label (exit $rc, expected FAIL)" >&2; exit 1
  fi
  if ! grep -qF -- "$needle" "$d/result.log"; then
    cat "$d/result.log"; echo "FAIL: $label (output lacks: $needle)" >&2; exit 1
  fi
  echo "PASS: $label"
}

noop() { :; }
append() { printf '%s' "$2" >> "$1"; }
default_min_plist() { plist 10.13 > BitSov.app/Contents/Info.plist; }

expect pass 'good bundle tree with rc19.2 expectation' '(node v0.3.0-rc19.2)' noop
expect fail 'bundled sidecar missing' 'FAIL  bundled sidecar is executable' \
  rm BitSov.app/Contents/MacOS/konsensus
expect fail 'bundled sidecar differs from the verified one' 'FAIL  bundled sidecar matches the verified sidecar' \
  append BitSov.app/Contents/MacOS/konsensus x
expect fail 'verified sidecar missing' 'FAIL  bundled sidecar matches the verified sidecar' \
  rm bin/konsensus-aarch64-apple-darwin
expect fail 'app executable missing' 'FAIL  app executable is executable' \
  rm BitSov.app/Contents/MacOS/bitsov-app
expect fail 'app executable not executable' 'FAIL  app executable is executable' \
  chmod 0644 BitSov.app/Contents/MacOS/bitsov-app
expect fail 'icon missing' 'FAIL  icon.icns is present' \
  rm BitSov.app/Contents/Resources/icon.icns
expect fail 'Info.plist malformed' 'FAIL  Info.plist is well-formed' \
  sh -c 'printf "<plist><dict>" > BitSov.app/Contents/Info.plist'
expect fail 'minimum macOS left at the 10.13 default' 'FAIL  LSMinimumSystemVersion is 11.0' \
  default_min_plist
expect fail 'sandbox profile file in the bundle' 'FAIL  no *.sb file in the bundle' \
  sh -c 'printf "(version 1)" > BitSov.app/Contents/Resources/j0-confined-child.sb'
expect fail 'assistant.html in the release dist' 'FAIL  release dist has no assistant page' \
  sh -c 'printf "<title>Assistant</title>" > dist/assistant.html'
expect fail 'assistant chunk in the release dist' 'FAIL  release dist has no assistant page' \
  sh -c 'printf "x" > dist/assets/assistant-deadbeef.js'
expect fail 'release dist missing' 'FAIL  release dist has index.html' \
  rm -rf dist
expect fail 'loose assistant.html in the bundle' 'FAIL  bundle has no assistant.html file' \
  sh -c 'printf "<title>Assistant</title>" > BitSov.app/Contents/Resources/assistant.html'
expect fail 'fixture rule text in the app binary' 'FAIL  app binary has no assistant page or fixture marker' \
  append BitSov.app/Contents/MacOS/bitsov-app 'Positive controls are answerable from a fresh read'
expect fail 'fixture question key in the app binary' 'fixture key first_channel_local_msat' \
  append BitSov.app/Contents/MacOS/bitsov-app '"key": "first_channel_local_msat"'
expect fail 'assistant chunk asset key in the app binary' 'assistant asset key' \
  append BitSov.app/Contents/MacOS/bitsov-app '/assets/assistant-deadbeef.js'
expect fail 'assistant page CSP in the app binary' 'assistant.html CSP' \
  append BitSov.app/Contents/MacOS/bitsov-app "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'"
expect fail 'bundle path does not exist' 'FAIL  app executable is executable' \
  rm -rf BitSov.app

echo "MAC BUNDLE CHECK TESTS: PASS ($cases cases)"
