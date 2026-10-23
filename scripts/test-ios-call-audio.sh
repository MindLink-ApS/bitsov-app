#!/usr/bin/env bash
# Exercise the production lifecycle on the host with an injected session driver.
set -euo pipefail
cd "$(dirname "$0")/.."
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/bitsov-ios-call-audio.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
xcrun swiftc -module-cache-path "$probe_dir/cache" \
  src-tauri/native/call_audio.swift src-tauri/native/tests/call-audio/main.swift \
  -o "$probe_dir/probe"
"$probe_dir/probe"
python3 - <<'PY'
import plistlib
for path in ('src-tauri/Info.ios.plist', 'src-tauri/gen/apple/bitsov-app_iOS/Info.plist'):
    with open(path, 'rb') as f:
        assert plistlib.load(f).get('UIBackgroundModes') == ['audio'], path
print('iOS source and generated plists: audio only')
PY
