#!/usr/bin/env bash
# Guard tests for scripts/build-windows-remote.sh. No build, no network: every case
# stops at --check-only or earlier. The script runs from a throwaway copy of the
# tree (no git), with stub host tools on PATH, so results do not depend on the host.
# bash 3.2 compatible. Exit 1 on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/root/scripts" "$T/root/src-tauri/src" "$T/root/packaging/windows" "$T/bin" "$T/cache"
cp scripts/build-windows-remote.sh "$T/root/scripts/"
cp src-tauri/src/profile.rs "$T/root/src-tauri/src/"
cp packaging/windows/tauri.windows-beta.conf.json "$T/root/packaging/windows/"
SCRIPT="$T/root/scripts/build-windows-remote.sh"
GOOD="$T/root/packaging/windows/tauri.windows-beta.conf.json"
SHA=0123456789abcdef0123456789abcdef01234567

# Stub host tools; only the preflight looks at them.
for tool in cargo-xwin makensis; do printf '#!/bin/sh\nexit 0\n' > "$T/bin/$tool"; done
printf '#!/bin/sh\necho x86_64-pc-windows-msvc\n' > "$T/bin/rustup"
chmod +x "$T/bin/"*
NODE_DIR="$(dirname "$(command -v node)")"
SAFE_PATH="$T/bin:$NODE_DIR:/usr/bin:/bin"

FAILS=0
run() { # <expected-exit> <expected-text> <args...>
  local want="$1" text="$2" got=0 out
  shift 2
  out="$(env PATH="$SAFE_PATH" XWIN_CACHE_DIR="$XWIN" BITSOV_TAURI_NSIS_CACHE="$NSIS" \
    bash "$SCRIPT" "$@" 2>&1)" || got=$?
  if [ "$got" != "$want" ] || ! printf '%s' "$out" | grep -qF -- "$text"; then
    echo "FAIL: $* -> exit $got (want $want), output:"; echo "$out"; FAILS=$((FAILS + 1))
  else
    echo "ok: exit $got, $text"
  fi
}
overlay() { # <name> <node expression applied to config c>
  node -e 'const fs=require("fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));'"$2"';fs.writeFileSync(process.argv[2],JSON.stringify(c));' \
    "$GOOD" "$T/$1.json"
  echo "$T/$1.json"
}

# Filled caches and node_modules: preflight passes without downloads.
XWIN="$T/cache/xwin"; NSIS="$T/cache/nsis"
mkdir -p "$XWIN/crt" "$NSIS/Plugins" "$T/root/node_modules/.bin"
printf '#!/bin/sh\n' > "$T/root/node_modules/.bin/tauri"; chmod +x "$T/root/node_modules/.bin/tauri"

run 0 "check only: nothing built" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "overlay ok: tech.mindlink.bitsov.beta" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "overlay ok: tech.mindlink.bitsov.remotetest" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay remotetest 'c.identifier="tech.mindlink.bitsov.remotetest"')"

# Signet-only and node-free are enforced.
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay mainnet 'c.identifier="tech.mindlink.bitsov"')"
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay lookalike 'c.identifier="tech.mindlink.bitsov.beta.extra"')"
run 3 "is not signet-only" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay noid 'delete c.identifier')"
run 3 "externalBin must be []" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay sidecar 'c.bundle.externalBin=["bin/konsensus"]')"
run 3 "externalBin must be []" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay inherit 'delete c.bundle.externalBin')"
run 3 'targets must be exactly ["nsis"]' --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay msi 'c.bundle.targets=["nsis","msi"]')"
run 3 "must replace the sidecar fetch" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay fetch 'c.build.beforeBundleCommand="bash scripts/fetch-node-sidecar.sh --verify-only"')"
run 3 "must replace the sidecar fetch" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only \
  --overlay "$(overlay nobefore 'delete c.build')"
printf '{ not json' > "$T/broken.json"
run 3 "not valid JSON" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --overlay "$T/broken.json"

# A profile.rs that no longer maps the beta identifier to signet_only stops the build.
cp "$T/root/src-tauri/src/profile.rs" "$T/profile.rs.bak"
sed 's/signet_only: matches!(identifier, BETA_IDENTIFIER | REMOTE_TEST_IDENTIFIER)/signet_only: identifier == REMOTE_TEST_IDENTIFIER/' \
  "$T/profile.rs.bak" > "$T/root/src-tauri/src/profile.rs"
run 3 "no longer maps the beta identifiers" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
cp "$T/profile.rs.bak" "$T/root/src-tauri/src/profile.rs"

# Arguments.
run 2 "--out <dir> is required" --runner xwin --source-sha "$SHA" --check-only
run 2 "pass --source-sha" --out "$T/out" --runner xwin --check-only
run 2 "40 lowercase hex" --out "$T/out" --runner xwin --source-sha ABC --check-only
run 2 "--runner must be" --out "$T/out" --runner docker --source-sha "$SHA" --check-only

# No download without --allow-downloads.
EMPTY="$T/cache/empty"; mkdir -p "$EMPTY"
XWIN="$EMPTY"
run 5 "MSVC CRT and Windows SDK" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "allowed download: cargo-xwin would download" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
XWIN="$T/cache/xwin"; NSIS="$EMPTY"
run 5 "NSIS tools" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
NSIS="$T/cache/nsis"
rm "$T/root/node_modules/.bin/tauri"
run 5 "npm ci would download" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only
run 0 "allowed download: npm ci" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads

# Missing host tools are reported, never installed.
rm "$T/bin/makensis"
run 4 "makensis" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only --allow-downloads
printf '#!/bin/sh\nexit 0\n' > "$T/bin/makensis"; chmod +x "$T/bin/makensis"
printf '#!/bin/sh\necho aarch64-apple-darwin\n' > "$T/bin/rustup"
run 4 "rustup target x86_64-pc-windows-msvc" --out "$T/out" --runner xwin --source-sha "$SHA" --check-only

[ ! -e "$T/out" ] || { echo "FAIL: --check-only created the output dir"; FAILS=$((FAILS + 1)); }
if [ "$FAILS" != 0 ]; then echo "$FAILS failure(s)"; exit 1; fi
echo "all build-windows-remote guard tests passed"
