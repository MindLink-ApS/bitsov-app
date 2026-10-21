#!/usr/bin/env bash
# Headless tests of iOS public metadata storage; native calls are injected.
set -euo pipefail
cd "$(dirname "$0")/.."
probe_dir=$(mktemp -d "${TMPDIR:-/tmp}/bitsov-ios-metadata.XXXXXX")
trap 'rm -rf "$probe_dir"' EXIT
xcrun swiftc -module-cache-path "$probe_dir/cache" \
  src-tauri/native/home_metadata.swift src-tauri/native/tests/home-metadata/main.swift \
  -o "$probe_dir/probe"
"$probe_dir/probe"
