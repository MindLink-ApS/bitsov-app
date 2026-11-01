#!/usr/bin/env bash
# Signed iOS archive for TestFlight. The Apple account owner runs this on their
# own Mac after choosing the team in Xcode (docs/IOS-TESTFLIGHT.md). It signs
# with that account; nothing here reads or changes signing settings itself.
set -euo pipefail

fail() { printf 'iOS TestFlight build failed: %s\n' "$*" >&2; exit 1; }
dry_run=0
case "${1:-}" in
  --dry-run) dry_run=1; shift ;;
  --help|-h)
    echo 'Usage: scripts/ios-testflight.sh [--dry-run] [-- extra tauri ios build arguments]'
    echo 'Build number: the commit count of HEAD, or IOS_BUILD_NUMBER if set.'
    exit 0 ;;
  --) shift ;;
  '') ;;
  *) fail "unknown argument: $1 (use --help)" ;;
esac
[[ ${1:-} != -- ]] || shift

cd "$(dirname "$0")/.."
# App Store Connect needs CFBundleVersion to grow with every upload of the same
# version. The commit count of main only grows and is a single integer, the
# simplest form App Store Connect accepts. (tauri's --build-number appends to
# the version instead, giving 0.0.1.<n>.) CFBundleShortVersionString stays the
# version in src-tauri/tauri.conf.json, which matches package.json.
number=${IOS_BUILD_NUMBER:-$(git rev-list --count HEAD)}
[[ $number =~ ^[1-9][0-9]{0,8}$ ]] || fail "build number must be a positive integer, got '$number'"
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
[[ -n $version ]] || fail 'no version in src-tauri/tauri.conf.json'
if [[ -n $(git status --porcelain --untracked-files=no -- src src-tauri/src src-tauri/Cargo.toml package.json) ]]; then
  echo 'Note: uncommitted source changes will be in this build.' >&2
fi

# Release profile, M6 node-routed calls (the default), no simulator overrides.
export VITE_CALL_MEDIA=node
unset BITSOV_IOS_SIM_PREBUILT
command=(npx tauri ios build --export-method app-store-connect
  --config "{\"bundle\":{\"iOS\":{\"bundleVersion\":\"$number\"}}}" "$@")
printf 'BitSov %s (build %s)\n' "$version" "$number"
printf '  '; printf '%q ' "${command[@]}"; printf '\n'
if [[ $dry_run == 1 ]]; then exit 0; fi
"${command[@]}"
cat <<EOF

The archive and .ipa are under src-tauri/gen/apple/build/.
Upload: open the .xcarchive (Xcode Organizer) → Distribute App → App Store Connect → Upload.
The build writes CFBundleVersion $number into src-tauri/gen/apple/bitsov-app_iOS/Info.plist;
do not commit that change.
EOF
