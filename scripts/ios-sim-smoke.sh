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
    echo 'Optional: IOS_SIM_NO_WINDOW=1 skips opening the Simulator window.'
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
# An unsigned simulator app has no application identifier, so every Keychain
# call fails and the app stops before its first screen. Embed simulator-only
# entitlements in the linked binary (as Xcode does for simulator builds); this
# is link-time data, not a signature, and never applies to a device build.
entitlements="$out/simulator.entitlements"
if [[ $dry_run == 0 ]]; then
  STEP="write simulator-only entitlements"
  mkdir -p "$out"
  cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>application-identifier</key>
  <string>SIMULATOR.tech.mindlink.bitsov</string>
  <key>keychain-access-groups</key>
  <array><string>SIMULATOR.tech.mindlink.bitsov</string></array>
</dict>
</plist>
PLIST
fi
run 'Build unsigned Debug app with the simulator SDK' xcodebuild \
  -project "$apple/bitsov-app.xcodeproj" -scheme bitsov-app_iOS \
  -configuration debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$out/derived-data" \
  "ARCHS=$arch" "VALID_ARCHS=$arch" ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  BITSOV_IOS_SIM_PREBUILT=1 \
  "OTHER_LDFLAGS=\$(inherited) -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __entitlements -Xlinker $entitlements" \
  build

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
  .filter(d => d.isAvailable && d.deviceTypeIdentifier?.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-'))
  // The foldable iPhone Duo renders only black frames when no Simulator window
  // is attached, so screenshots cannot show the app. Use a standard iPhone.
  .filter(d => !d.deviceTypeIdentifier.startsWith('com.apple.CoreSimulator.SimDeviceType.iPhone-Duo'));
const requested = process.env.IOS_SIM_UDID;
const phone = requested ? phones.find(d => d.udid === requested)
  : phones.find(d => d.state === 'Booted') ?? phones.find(d => d.state === 'Shutdown');
if (!phone || !['Booted', 'Shutdown'].includes(phone.state)) {
  console.error('No available iPhone simulator matches. Install an iOS runtime and create a standard (not foldable) iPhone simulator in Xcode, or check IOS_SIM_UDID.');
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
# Show the device to whoever runs the smoke. Screenshots do not depend on it:
# standard iPhone simulators render headless. Recent Xcode releases may not
# ship Simulator.app; then the run continues headless.
if [[ ${IOS_SIM_NO_WINDOW:-0} != 1 ]]; then
  if [[ $dry_run == 0 ]]; then
    STEP="find Simulator app"
    simulator_app=$(mdfind "kMDItemCFBundleIdentifier == 'com.apple.iphonesimulator'" 2>/dev/null | head -n 1 || true)
    developer=$(xcode-select -p 2>/dev/null || true)
    [[ -n "$simulator_app" || -z "$developer" || ! -d "$developer/Applications/Simulator.app" ]] ||
      simulator_app="$developer/Applications/Simulator.app"
    if [[ -n "$simulator_app" ]]; then
      run 'Open Simulator window for the selected iPhone' open -a "$simulator_app" --args -CurrentDeviceUDID "$udid"
    else
      printf '\nSimulator app not found; continuing headless (screenshots still render).\n'
    fi
  else
    run 'Open Simulator window for the selected iPhone (if Simulator.app exists)' \
      open -a Simulator --args -CurrentDeviceUDID "$udid"
  fi
fi
run 'Install simulator app' xcrun simctl install "$udid" "$app"
run 'Launch simulator app' xcrun simctl launch --terminate-running-process "$udid" "$bundle_id"
run 'Allow the launch animation to finish' sleep "${IOS_SMOKE_SCREENSHOT_DELAY:-2}"
run 'Capture launch screenshot; retry until the first screen renders' \
  xcrun simctl io "$udid" screenshot "$out/launch.png"
if [[ $dry_run == 0 ]]; then
  # The web view needs a few seconds on a cold simulator. A black or one-colour
  # frame after the last attempt fails the smoke instead of passing as evidence.
  STEP="check launch screenshot shows the app"
  attempts=${IOS_SMOKE_SCREENSHOT_ATTEMPTS:-10}
  for ((attempt = 1; ; attempt++)); do
    [[ -s "$out/launch.png" ]] || fail 'simulator screenshot is missing or empty'
    if check=$(trap - ERR; node "$root/scripts/ios-screenshot-check.mjs" "$out/launch.png" 2>&1); then
      printf '%s\n' "$check"
      break
    fi
    (( attempt < attempts )) || fail "$check ($out/launch.png)"
    sleep "${IOS_SMOKE_SCREENSHOT_DELAY:-2}"
    xcrun simctl io "$udid" screenshot "$out/launch.png" >/dev/null
  done
  printf '\nLaunch screenshot: %s/launch.png\nContinue with docs/IOS-SMOKE.md.\n' "$out"
fi
