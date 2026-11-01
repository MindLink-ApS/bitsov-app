# Android M6 smoke check

## Emulator launch smoke

Prerequisites: Android SDK with platform-tools, the Emulator and one
`arm64-v8a` (Apple Silicon) or `x86_64` system image; NDK 27.2.12479018;
JDK 17; Node and npm. From the repo root:

```sh
npm ci
rustup target add aarch64-linux-android   # x86_64 image: x86_64-linux-android
# once: an AVD, if you have none
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n BitSov_Pixel \
  -k 'system-images;android-35;google_apis;arm64-v8a' -d pixel_7
scripts/android-emu-smoke.sh --dry-run
scripts/android-emu-smoke.sh
```

The script builds the same debug APK as `.github/workflows/android-preview.yml`
(`tauri android build --debug --apk`), installs it on a running emulator (or
boots `ANDROID_AVD` headless and stops it afterwards), launches it and saves
`test-results/android-smoke/launch.png` and `logcat.txt`. It fails if the app is
not running, another app is in front, or the middle of the screen stays black
or one flat colour after about 20 seconds. `--skip-build` reuses the last APK.

It only ever selects emulators (`emulator-NNNN`), never a phone. It builds a
debug APK only: no release build, no signing options and no release keystore.
Gradle signs debug APKs with its own disposable debug key, as in CI.
`launch.png` is launch evidence, not a completed M6 test.

## What the emulator can and cannot show

- **Network.** Inside the emulator `127.0.0.1` is the emulator itself, so the
  app's home-node proxy on `127.0.0.1:3141` cannot collide with a desktop app or
  node on this computer. `10.0.2.2` is this computer's loopback. A test node for
  the emulator therefore advertises `10.0.2.2:<port>` as its remote-access
  endpoint. Never add `adb reverse tcp:3141`; the smoke refuses to run with one.
- **Pairing links.** Open a link with
  `adb shell am start -a android.intent.action.VIEW -d '<link>' tech.mindlink.bitsov`
  (the same path as tapping a `bitsov://pair/` link). `adb shell input text`
  drops characters from a link this long, so typing it into "Paste link" gives
  a damaged link.
- **Pairing stops on the emulator.** The identity comparison screen appears,
  but "They match" then shows "Can't connect to your box". BitSov keeps its
  pairing key only in hardware-backed Keystore, and the emulator's Keystore is
  software only. This is by design; complete pairing on a phone.
- **Camera.** The emulated back camera shows a virtual room; it cannot scan a
  real QR code.

## Phone checklist

Use an Android 12 or later phone with a fingerprint or face unlock enrolled
(class 3 / strong biometrics), a reachable M6 home node, a second paired
tester/peer, funded test balances and small spending limits. The phone needs a
LAN or VPN address for the node; its `localhost` is the phone itself.

Install: enable **Developer options → USB debugging**, connect the phone,
accept the computer's key, then `adb install -r <debug APK>`.

- [ ] First launch: "Connect to your box" is readable, with no blank screen or crash.
- [ ] Scan the box's QR (camera prompt once), or open the pairing link, or
  **Other options → Paste link**. Compare the code and tap **They match**. The
  app reports the paired state.
- [ ] Check spending permission: state, limit and expiry are visible. If it
  is missing, request it and have the owner approve it.
- [ ] Approve with biometrics when asked ("Approve with BitSov").
- [ ] Send one paid message after reviewing the price. The peer receives it;
  capture the delivery/payment outcome and any error.
- [ ] Place an audio call. **Before Ring**, consent shows the price per minute,
  routing allowance and maximum hold. Cancel once, then reopen and confirm.
  Allow the microphone when Android asks.
- [ ] Answer on the peer: both sides reach Live and hear each other. Keep the
  call through a minute boundary and check the paid-minute status.
- [ ] Hang up: both sides leave Live, audio stops, and the cost/remaining hold
  settles or a clear recovery action is shown. Repeat with an incoming call
  answered and hung up on the Android phone.

Known Android limits for this test: keep BitSov in front with the screen on
for the whole call. Android silences the microphone of an app in the
background, and a backgrounded phone does not ring. The system Back button
closes BitSov (also from the QR scanner), so use the on-screen controls.

Record pass/fail with screenshots of first launch, pairing, spending
permission, message result, call consent (both amounts), Live and ended call.
Record the git commit, node version, phone model and Android version. Keep
pairing links, keys and private message content out of shared captures.
