#!/usr/bin/env bash
# Compile the real pairing storage bridge with pure tests; the enclave probe is
# replaced, so no Keychain, Secure Enclave or authentication UI is touched.
set -euo pipefail
cd "$(dirname "$0")/.."
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/bitsov-secure-storage.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
cat src-tauri/native/device_key.swift src-tauri/native/tests/secure_storage.swift > "$probe_dir/main.swift"
xcrun swiftc -swift-version 5 -module-cache-path "$probe_dir/cache" \
  "$probe_dir/main.swift" -o "$probe_dir/probe"
"$probe_dir/probe"
