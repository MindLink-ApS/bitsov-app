#!/usr/bin/env bash
# Android emulator smoke: build the debug APK the way android-preview.yml does,
# install it on an Android emulator, launch it, screenshot it and fail on a
# blank screen. Emulator only. Debug build only: it never builds a release,
# never passes signing options and never reads a release keystore. (Gradle
# signs debug APKs with its own disposable debug key, as in CI.)
set -Eeuo pipefail
STEP="read arguments"
trap 'printf "Android smoke failed: %s.\n" "$STEP" >&2; exit 1' ERR

fail() { printf 'Android smoke failed: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: scripts/android-emu-smoke.sh [--dry-run] [--skip-build]

  --dry-run     print every step without building, booting or installing
  --skip-build  reuse the APK from the last build

Environment (all optional):
  ANDROID_HOME     Android SDK (default: ~/Library/Android/sdk on macOS, ~/Android/Sdk on Linux)
  NDK_HOME         NDK (default: the newest under $ANDROID_HOME/ndk)
  JAVA_HOME        JDK 17 for Gradle
  ANDROID_SERIAL   use this running emulator (emulator-NNNN)
  ANDROID_AVD      boot this AVD if no emulator is running (default: the only AVD)
  ANDROID_SMOKE_KEEP_EMULATOR=1   leave an emulator this script booted running
  ANDROID_SMOKE_SCREENSHOT_ATTEMPTS / ANDROID_SMOKE_SCREENSHOT_DELAY   retry policy (10 x 2 s)
USAGE
}
dry_run=0
skip_build=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --skip-build) skip_build=1 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "unknown argument: $1 (use --help)" ;;
  esac
  shift
done

STEP="find repository root"
cd "$(dirname "$0")/.."
root="$PWD"
out="$root/test-results/android-smoke"
package=tech.mindlink.bitsov
activity="$package/.MainActivity"
apk_dir="$root/src-tauri/gen/android/app/build/outputs/apk/universal/debug"

case "$(uname -s)" in
  Darwin) default_sdk="$HOME/Library/Android/sdk" ;;
  *) default_sdk="$HOME/Android/Sdk" ;;
esac
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$default_sdk}}"
adb="$sdk/platform-tools/adb"
emulator="$sdk/emulator/emulator"

run() {
  STEP="$1"; shift
  printf '\n%s\n' "$STEP"
  printf '  '; printf '%q ' "$@"; printf '\n'
  if [[ $dry_run == 0 ]]; then "$@"; fi
}

if [[ $dry_run == 0 ]]; then
  for tool in node npm cargo rustup; do
    command -v "$tool" >/dev/null || fail "missing $tool; install the toolchain first"
  done
  [[ -x "$adb" ]] || fail "missing $adb; install Android SDK platform-tools or set ANDROID_HOME"
  [[ -f node_modules/.bin/tauri ]] || fail 'missing npm dependencies; run npm ci first'
fi

# --- Emulator -----------------------------------------------------------------
# Only emulators: a physical phone is never selected, even when one is plugged in.
started_emulator=''
cleanup() {
  if [[ -n "$started_emulator" && ${ANDROID_SMOKE_KEEP_EMULATOR:-0} != 1 ]]; then
    "$adb" -s "$started_emulator" emu kill >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

serial="${ANDROID_SERIAL:-}"
if [[ $dry_run == 0 ]]; then
  STEP="list connected emulators"
  "$adb" start-server >/dev/null 2>&1
  running=$("$adb" devices | awk 'NR > 1 && $2 == "device" && $1 ~ /^emulator-[0-9]+$/ {print $1}')
  if [[ -n "$serial" ]]; then
    [[ "$serial" =~ ^emulator-[0-9]+$ ]] || fail "ANDROID_SERIAL=$serial is not an emulator; this smoke never uses a physical device"
    grep -qx "$serial" <<< "$running" || fail "emulator $serial is not running"
  elif [[ -n "$running" ]]; then
    serial=$(head -n 1 <<< "$running")
  else
    [[ -x "$emulator" ]] || fail "no emulator running and $emulator is missing; install the Android Emulator"
    STEP="choose an AVD"
    avd="${ANDROID_AVD:-}"
    if [[ -z "$avd" ]]; then
      avds=$("$emulator" -list-avds 2>/dev/null | grep -v '^INFO' || true)
      [[ $(grep -c . <<< "$avds") == 1 ]] || fail 'set ANDROID_AVD to one of: '"$(tr '\n' ' ' <<< "$avds")"
      avd="$avds"
    fi
    port=5580
    while "$adb" devices | grep -q "^emulator-$port"; do port=$((port + 2)); done
    serial="emulator-$port"
    mkdir -p "$out"
    printf '\nBoot AVD %s headless as %s (log: %s)\n' "$avd" "$serial" "$out/emulator.log"
    "$emulator" -avd "$avd" -port "$port" -no-window -no-boot-anim -no-snapshot-save \
      -gpu swiftshader_indirect > "$out/emulator.log" 2>&1 &
    started_emulator="$serial"
    STEP="wait for $serial to boot"
    "$adb" -s "$serial" wait-for-device
    for _ in $(seq 1 120); do
      [[ $("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]] && break
      sleep 2
    done
    [[ $("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r') == 1 ]] ||
      fail "emulator $serial did not finish booting in 4 minutes ($out/emulator.log)"
  fi
  printf 'Using %s\n' "$serial"
  STEP="read emulator ABI"
  abi=$("$adb" -s "$serial" shell getprop ro.product.cpu.abi | tr -d '\r')
else
  run 'Use a running emulator (ANDROID_SERIAL), or boot ANDROID_AVD headless; never a physical device' \
    "$adb" devices
  serial='<emulator-NNNN>'; abi=arm64-v8a
fi
case "$abi" in
  arm64-v8a) target=aarch64 ;;
  x86_64) target=x86_64 ;;
  *) fail "unsupported emulator ABI $abi; use an arm64-v8a or x86_64 system image" ;;
esac

# The app's home-node proxy binds 127.0.0.1:3141 inside the emulator, which is
# the emulator's own loopback. An `adb reverse` rule for that port would route
# it to this computer instead (for example to a desktop app or node there).
if [[ $dry_run == 0 ]]; then
  STEP="check adb reverse rules"
  if "$adb" -s "$serial" reverse --list 2>/dev/null | grep -q 'tcp:3141'; then
    fail "an adb reverse rule maps the emulator's port 3141 to this computer; remove it with: adb -s $serial reverse --remove tcp:3141"
  fi
else
  run "Refuse an adb reverse rule for the app's loopback port 3141" "$adb" -s "$serial" reverse --list
fi

# --- Build ----------------------------------------------------------------------
if [[ $skip_build == 0 ]]; then
  if [[ $dry_run == 0 ]]; then
    STEP="check Rust Android target"
    rust_target=$([[ $target == aarch64 ]] && echo aarch64-linux-android || echo x86_64-linux-android)
    rustup target list --installed | grep -qx "$rust_target" ||
      fail "missing Rust target; run rustup target add $rust_target"
    STEP="find the NDK"
    if [[ -z "${NDK_HOME:-}" ]]; then
      NDK_HOME=$(ls -d "$sdk"/ndk/*/ 2>/dev/null | sort -V | tail -n 1)
      NDK_HOME="${NDK_HOME%/}"
    fi
    [[ -n "$NDK_HOME" && -d "$NDK_HOME" ]] || fail "no NDK under $sdk/ndk; install ndk;27.2.12479018 or set NDK_HOME"
    export NDK_HOME
    STEP="find a JDK"
    if [[ -z "${JAVA_HOME:-}" ]] && ! java -version >/dev/null 2>&1; then
      fail 'no JDK found; install JDK 17 and set JAVA_HOME'
    fi
  fi
  export ANDROID_HOME="$sdk" ANDROID_SDK_ROOT="$sdk"
  export CARGO_PROFILE_DEV_DEBUG="${CARGO_PROFILE_DEV_DEBUG:-0}"
  # Same command as .github/workflows/android-preview.yml: debug APK only.
  run "Build the Android debug APK for $target" \
    npm run tauri -- android build --ci --debug --apk --target "$target"
fi

if [[ $dry_run == 0 ]]; then
  STEP="find the debug APK"
  shopt -s nullglob
  apks=("$apk_dir"/*.apk)
  shopt -u nullglob
  [[ ${#apks[@]} == 1 ]] || fail "expected one debug APK in $apk_dir, found ${#apks[@]}"
  apk="${apks[0]}"
else
  apk="$apk_dir/app-universal-debug.apk"
fi

# --- Install, launch, screenshot ----------------------------------------------
run 'Create gitignored smoke output' mkdir -p "$out"
run 'Install the debug APK on the emulator' "$adb" -s "$serial" install -r "$apk"
run 'Stop a running copy so the launch is fresh' "$adb" -s "$serial" shell am force-stop "$package"
run 'Clear the emulator log' "$adb" -s "$serial" logcat -c
run 'Launch the app' "$adb" -s "$serial" shell am start -W -n "$activity"
printf '\n%s\n  %q -s %q exec-out screencap -p > %q\n  node scripts/android-screenshot-check.mjs %q\n' \
  'Capture the launch screenshot; retry until the app is in front and its first screen renders' \
  "$adb" "$serial" "$out/launch.png" "$out/launch.png"
if [[ $dry_run == 0 ]]; then
  STEP="check the launch screenshot shows the app"
  attempts=${ANDROID_SMOKE_SCREENSHOT_ATTEMPTS:-10}
  for ((attempt = 1; ; attempt++)); do
    sleep "${ANDROID_SMOKE_SCREENSHOT_DELAY:-2}"
    "$adb" -s "$serial" exec-out screencap -p > "$out/launch.png"
    pid=$("$adb" -s "$serial" shell pidof "$package" 2>/dev/null | tr -d '\r' || true)
    top=$("$adb" -s "$serial" shell dumpsys activity activities 2>/dev/null | grep -m 1 'topResumedActivity' || true)
    if [[ -z "$pid" ]]; then
      "$adb" -s "$serial" logcat -d > "$out/logcat.txt" 2>&1 || true
      fail "the app is not running after launch (crashed?); see $out/logcat.txt"
    fi
    # Android draws a system splash (the app icon) before the app's own window;
    # it has content, so it must not count as the first screen.
    splash=$("$adb" -s "$serial" shell dumpsys window windows 2>/dev/null | grep -c "Splash Screen $package" || true)
    if [[ -s "$out/launch.png" && "$top" == *"$package"* && $splash == 0 ]] &&
      check=$(trap - ERR; node "$root/scripts/android-screenshot-check.mjs" "$out/launch.png" 2>&1); then
      printf '%s\n' "$check"
      break
    fi
    [[ "$top" == *"$package"* ]] || check='another app is in front of BitSov'
    [[ $splash == 0 ]] || check='the launch splash is still showing; the app window never appeared'
    if (( attempt >= attempts )); then
      "$adb" -s "$serial" logcat -d --pid="$pid" > "$out/logcat.txt" 2>&1 || true
      fail "${check:-screenshot is missing or empty} ($out/launch.png)"
    fi
  done
  "$adb" -s "$serial" logcat -d --pid="$pid" > "$out/logcat.txt" 2>&1 || true
  printf '\nLaunch screenshot: %s/launch.png\nApp log: %s/logcat.txt\nContinue with docs/ANDROID-SMOKE.md.\n' "$out" "$out"
fi
