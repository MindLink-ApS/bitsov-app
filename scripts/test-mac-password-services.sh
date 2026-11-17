#!/usr/bin/env bash
# Compile the real parser with pure tests; no Keychain or enclave operations.
set -euo pipefail
cd "$(dirname "$0")/.."
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/bitsov-password-services.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
cat src-tauri/native/device_key.swift src-tauri/native/tests/password_services.swift > "$probe_dir/main.swift"
xcrun swiftc -swift-version 5 -module-cache-path "$probe_dir/cache" \
  "$probe_dir/main.swift" -o "$probe_dir/probe"
"$probe_dir/probe"
