#!/usr/bin/env bash
set -euo pipefail

archives="${RUNNER_TEMP:?}/tauri-apt"
mkdir -p "$archives/partial"
options=(-o "Dir::Cache::archives=$archives"
  -o Acquire::Retries=2 -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15
  -o APT::Keep-Downloaded-Packages=true)
packages=(libwebkit2gtk-4.1-dev build-essential curl wget file
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev)

# Bound only the network phase: never kill dpkg halfway through installation.
# Two attempts with a 15-second backoff fit inside the caller's five-minute
# step timeout, leaving time for the normal ~36-second local installation.
for attempt in 1 2; do
  if sudo timeout --kill-after=5s 110s bash -e -c '
    archives=$1
    option_count=$2
    shift 2
    apt-get "${@:1:option_count}" update --error-on=any
    python3 scripts/ci/verify-apt-cache.py "$archives"
    count() { find "$archives" -maxdepth 1 -name "*.deb" -type f | wc -l; }
    before=$(count)
    apt-get "${@:1:option_count}" install -y --download-only "${@:option_count+1}"
    after=$(count)
    if (( before > 0 && after == before )); then
      echo "Tauri prerequisites: installed from cache without download ($before verified archives)"
    else
      echo "Tauri prerequisites: downloaded $((after - before)) archives, reused $before verified cached archives"
    fi
  ' _ "$archives" "${#options[@]}" "${options[@]}" "${packages[@]}"; then
    # Restored debs were explicitly rehashed; newly downloaded debs are verified
    # by apt. Never unpack a cache directly into the filesystem.
    sudo apt-get "${options[@]}" install -y --no-download "${packages[@]}"
    exit 0
  fi
  if (( attempt == 1 )); then
    echo '::warning::apt download failed; retrying in 15 seconds'
    sleep 15
  fi
done
echo '::error::Tauri prerequisite download failed after two bounded attempts'
exit 1
