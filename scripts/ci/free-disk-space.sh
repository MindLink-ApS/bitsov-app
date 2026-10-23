#!/usr/bin/env bash
set -euo pipefail

# Keep a 12-GiB floor before restoring/linking Tauri caches. The old cleanup
# always removed Android, taking a median 1.6 minutes even with ample space.
# Stop as soon as enough is free; retain Android and all tools this job uses.
enough_space() { (( $(df -Pk / | awk 'NR == 2 { print $4 }') >= 12 * 1024 * 1024 )); }
df -h /
for unused in /usr/share/dotnet /opt/ghc /opt/hostedtoolcache/CodeQL /usr/local/share/boost; do
  if enough_space; then break; fi
  sudo rm -rf "$unused"
done
df -h /
if ! enough_space; then
  echo '::warning::Less than 12 GiB free before the Rust cache restore; inspect final disk usage'
fi
