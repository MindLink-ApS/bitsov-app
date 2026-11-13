#!/usr/bin/env bash
# Headless macOS tests of the iOS policy with Keychain calls replaced by closures.
set -euo pipefail
cd "$(dirname "$0")/.."
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/bitsov-ios-keychain.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
xcrun swiftc -module-cache-path "$probe_dir/cache" \
  src-tauri/native/device_key.swift src-tauri/native/client_keychain.swift \
  src-tauri/native/tests/client-keychain/main.swift -o "$probe_dir/probe"
"$probe_dir/probe"
