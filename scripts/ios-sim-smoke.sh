#!/usr/bin/env bash
# Unsigned native M6 smoke launch. Simulator only; never invokes signing tools.
set -Eeuo pipefail
STEP="read arguments"
trap 'printf "iOS smoke failed: %s.\n" "$STEP" >&2; exit 1' ERR

fail() { printf 'iOS smoke failed: %s\n' "$*" >&2; exit 1; }
dry_run=0
case "${1:-}" in
  --dry-run) dry_run=1; shift ;;
  --help|-h)
    echo 'Usage: scripts/ios-sim-smoke.sh [--dry-run]'
    echo 'Optional: IOS_SIM_UDID selects an available iPhone simulator.'
    exit 0 ;;
  '') ;;
  *) fail "unknown argument: $1 (use --help)" ;;
esac
[[ $# == 0 ]] || fail 'too many arguments (use --help)'

STEP="find repository root"
cd "$(dirname "$0")/.."
root="$PWD"
apple="$root/src-tauri/gen/apple"
out="$root/test-results/ios-smoke"
case "$(uname -m)" in
  arm64|aarch64) arch=arm64; target=aarch64-apple-ios-sim ;;
  x86_64) arch=x86_64; target=x86_64-apple-ios ;;
  *) fail 'unsupported host architecture; use an Apple Silicon or Intel Mac' ;;
esac

run() {
  STEP="$1"; shift
  printf '\n%s\n' "$STEP"
  printf '  '; printf '%q ' "$@"; printf '\n'
  if [[ $dry_run == 0 ]]; then "$@"; fi
}

# Node's optional system CA lookup can read the login keychain. Builds only
# need the bundled public roots. No signing credentials are passed to a CLI.
export NODE_USE_SYSTEM_CA=0
export VITE_CALL_MEDIA=node

if [[ $dry_run == 0 ]]; then
  [[ $(uname -s) == Darwin ]] || fail 'iOS Simulator requires macOS with full Xcode'
  for tool in xcodebuild xcrun rustup cargo node npm; do
    command -v "$tool" >/dev/null || fail "missing $tool; install the toolchain first"
  done
fi
run 'Xcode version' xcodebuild -version
run 'Cargo version' cargo --version
run "Required Rust iOS simulator target: $target" rustup target list --installed
if [[ $dry_run == 0 ]]; then
  STEP="check Rust simulator target $target"
  installed=$(rustup target list --installed)
  [[ $'\n'"$installed"$'\n' == *$'\n'"$target"$'\n'* ]] ||
    fail "missing Rust simulator target; run rustup target add $target"
fi
run 'Node version' node --version
run 'npm version' npm --version
STEP="locate iOS Simulator SDK"
if [[ $dry_run == 0 ]]; then
  sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
  printf 'iOS Simulator SDK: %s\n' "$sdk"
else
  run "$STEP" xcrun --sdk iphonesimulator --show-sdk-path
  sdk='<iPhoneSimulator SDK path>'
fi

if [[ $dry_run == 0 ]]; then
  [[ -d "$apple/bitsov-app.xcodeproj" ]] || fail 'missing checked-in iOS Xcode project'
  [[ -f node_modules/.bin/vite ]] || fail 'missing npm dependencies; run npm ci first'
  STEP="read existing Tauri iOS config"
  ios_config=$(cat src-tauri/tauri.ios.conf.json)
else
  ios_config='<contents of src-tauri/tauri.ios.conf.json>'
fi
run 'Create gitignored smoke output' mkdir -p "$out" "$apple/assets" "$apple/Externals/$arch/debug"
run 'Build bundled frontend (M6 node-routed calls)' npm run build
# custom-protocol embeds dist even in Debug, so no Vite server is needed.
# Cargo and Xcode reuse the existing iOS config, native sources and project.
run 'Build Rust simulator library (Debug)' env \
  SDKROOT="$sdk" TAURI_CONFIG="$ios_config" \
  TAURI_IOS_PROJECT_PATH="$apple" TAURI_IOS_APP_NAME=bitsov-app \
  CARGO_TARGET_DIR="$out/cargo" \
  cargo build --manifest-path src-tauri/Cargo.toml --locked --lib \
  --target "$target" --features tauri/custom-protocol
run 'Stage simulator library for the existing Xcode target' \
  cp "$out/cargo/$target/debug/libbitsov_app.a" "$apple/Externals/$arch/debug/libapp.a"
run 'Build unsigned Debug app with the simulator SDK' xcodebuild \
  -project "$apple/bitsov-app.xcodeproj" -scheme bitsov-app_iOS \
  -configuration debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$out/derived-data" \
  "ARCHS=$arch" "VALID_ARCHS=$arch" ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  BITSOV_IOS_SIM_PREBUILT=1 build

app="$out/derived-data/Build/Products/debug-iphonesimulator/BitSov.app"
if [[ $dry_run == 0 ]]; then
  [[ -d "$app" ]] || fail 'Xcode returned success but the simulator .app is missing'
  STEP="read built app bundle identifier"
  bundle_id=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")
  [[ -n "$bundle_id" ]] || fail 'built app bundle identifier is empty'
  STEP="list available simulators"
  xcrun simctl list devices available --json > "$out/devices.json"
  STEP="select an available iPhone simulator"
  selection=$(node --input-type=module - "$out/devices.json" <<'JS'
import fs from 'node:fs';
const { devices } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const phones = Object.entries(devices)
  .filter(([runtime]) => runtime.startsWith('com.apple.CoreSimulator.SimRuntime.iOS-'))
  .flatMap(([, list]) => list)
  .filter(d => d.isAvailable && d.deviceTypeIdentifier?.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-'));
const requested = process.env.IOS_SIM_UDID;
const phone = requested ? phones.find(d => d.udid === requested)
  : phones.find(d => d.state === 'Booted') ?? phones.find(d => d.state === 'Shutdown');
if (!phone || !['Booted', 'Shutdown'].includes(phone.state)) {
  console.error('No available iPhone simulator matches. Install an iOS runtime and create an iPhone simulator in Xcode, or check IOS_SIM_UDID.');
  process.exit(1);
}
console.error(`Using ${phone.name} (${phone.udid})`);
console.log(`${phone.udid} ${phone.state}`);
JS
  )
  read -r udid state <<< "$selection"
else
  run 'List available simulators; select IOS_SIM_UDID or prefer an already booted iPhone (never an iPad or physical device)' \
    xcrun simctl list devices available --json
  udid='<selected iPhone simulator UUID>'; state=Shutdown; bundle_id='<built app bundle identifier>'
fi
if [[ $state != Booted ]]; then
  run 'Boot selected iPhone simulator (skip if already booted)' xcrun simctl boot "$udid"
fi
run 'Wait for simulator boot' xcrun simctl bootstatus "$udid" -b
run 'Install simulator app' xcrun simctl install "$udid" "$app"
run 'Launch simulator app' xcrun simctl launch --terminate-running-process "$udid" "$bundle_id"
run 'Allow the first screen to render' sleep 3
run 'Capture launch screenshot' xcrun simctl io "$udid" screenshot "$out/launch.png"
if [[ $dry_run == 0 ]]; then
  [[ -s "$out/launch.png" ]] || fail 'simulator screenshot is missing or empty'
  printf '\nLaunch screenshot: %s/launch.png\nContinue with docs/IOS-SMOKE.md.\n' "$out"
fi
