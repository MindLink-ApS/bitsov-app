# Android parity slice 2 — 22 October 2026

Based on main after #309 and #308. This addresses release-build item 6 in
`ANDROID-PARITY-GAPS-21OCT.md` and the P2 coverage finding in
`app309-fable-ded455b9.md`. No signing credentials, Play upload, physical device,
emulator, window-opening app binary, or `cargo fmt` is part of this slice.

## Release configuration and retention

- Release explicitly enables code minification and resource shrinking, and
  disables Java and JNI debugging. It uses the legacy `isMinifyEnabled` /
  `isShrinkResources` DSL consistently with Tauri's `.pro` files, plus Android's
  optimizing default rules. AGP 9.3's newer `optimization` DSL uses a different
  keep-rule source set; see [Android's R8 configuration documentation](https://developer.android.com/topic/performance/app-optimization/enable-app-optimization).
- Required app and generated Tauri rules are named explicitly. Missing ProGuard
  files now fail the build; the pinned Tauri 2.12.0 and barcode scanner 2.5.0
  both have consumer-rule files, so the old missing-file workaround is removed.
- `@TauriPlugin` classes retain their names, constructors and all members:
  `DeviceKeyPlugin` (Keystore/biometrics/sealed storage), `PhoneRecoveryPlugin`,
  `LocalNetworkPlugin`, `PairingLinkPlugin`, and `BarcodeScannerPlugin`.
  This also retains permission and activity callbacks. `@InvokeArg` classes
  retain constructors, fields and accessors, including all device-key payloads,
  `LanRequest` and the scanner's `ScanOptions`. A generic `@Command` rule
  protects annotated command entry points even outside annotated plugin classes.
- Runtime annotations and signatures remain. The small `app.tauri` bridge is
  kept, including built-in plugins, `PluginManager`, `Invoke`, `Channel`,
  `JSObject` and `JSArray`. Named generated Wry/Tauri classes keep all members
  because Rust calls Java methods by name as well as registering native methods.
  Native method descriptor classes and WebView JavaScript interfaces are kept.
  These are deliberate conservative rules at the native/reflection boundary;
  they do not disable R8 for the entire application or ML Kit/AndroidX.
- The first actual R8 run exposed missing `BarcodeScanner`, `BarcodeScanning`
  and `BarcodeScannerOptions` classes. The old global exclusion of
  `play-services-mlkit-barcode-scanning` also removed a required transitive API
  dependency of the bundled `com.google.mlkit:barcode-scanning:17.3.0` artifact.
  The exclusion is removed; the bundled offline model remains, as prescribed
  by [ML Kit's bundled-model setup](https://developers.google.com/ml-kit/vision/barcode-scanning/android).
  The guard rejects reintroducing this exclusion. No `-dontwarn` suppression
  was added for these required classes.

## Network, backup and signing review

Release still sets `usesCleartextTraffic=false` and a network security
`base-config` denying cleartext, with no release domain exception. The only
cleartext exceptions are in the **debug** resource overlay: `localhost`,
`127.0.0.1`, and the emulator host alias `10.0.2.2`, for the development server.
The local-network permission path is separate: Rust resolves allowed addresses
and performs the pinned, encrypted Noise transport over TCP. LAN permission
does not require enabling cleartext HTTP in the WebView. No LAN-wide cleartext
exception was added.

#290's `allowBackup=false`, `backup_rules.xml`, and `data_extraction_rules.xml`
remain unchanged. All credential-bearing storage domains are excluded from
cloud backup and device transfer; the existing storage regression test remains
in the full Vitest suite.

Release has no signing configuration and must not fall back to the debug key.
This slice does not add/read keys or secrets. An unsigned artifact is build
evidence only. Distribution signing and a signed release-device smoke test
remain separate work before any Android distribution.

## CI check and coverage repair

`python3 scripts/check-android-release.py --generated` checks the app's keep
rules and release defaults, the generated `proguard-tauri.pro` activity rule,
and the actual locked Tauri consumer rules selected by generated Gradle
settings. Tauri 2.12 puts the plugin/argument rules in its consumer file, not
the generated app rule file. Missing output fails the check.

The existing Android Rust CI job supplies the code-generation environment and
rebuilds just `tauri` before its check: that build script does not track changes
to `TAURI_ANDROID_PROJECT_PATH`, so an older restored cache could otherwise omit
the generated file. No Gradle, Kotlin compilation, SDK installation or APK is
added to CI. Changes to the guard itself also select this job. The guard is a
text/configuration regression check, **not proof of optimized DEX retention or
runtime behavior**. Without generated files, omit `--generated` to check the
committed app rules and release defaults only.

`remote_access::second_tests` is again `#[cfg(test)]`. Only its enrollment wire
fixtures/imports remain under macOS + non-mobile cfg; the neutral ticket-expiry
test is outside that gate. The existing test body is unchanged. Full Vitest
also exposed a stale straight-apostrophe scan-button selector left by #308 in
the slice-1 clipboard-clear tests; it now matches the visible label on both
phone platforms.

## Verification

- `npx --no-install tsc --noEmit`: pass.
- `npm test`: 109 files, 1,960 tests passed after the stale selector correction.
  The initial run had two failures in `phone-onboarding.test.tsx` (the Android
  and iOS manual-paste reset/scanner-handoff cases); both now pass.
- `npm run build`: pass; existing chunk-size advisory.
- `npm run authority`: pass.
- `cargo test --offline --locked -p bitsov-app --features dev-node,local-owner-ceremony --lib -- --test-threads=4`:
  1,084 passed.
- `cargo test --offline --locked -p bitsov-app --features dev-node,local-owner-ceremony,sit-mock --test '*'`:
  58 non-window integration tests passed.
- `cargo check --offline --locked -p bitsov-app --target aarch64-linux-android --lib --tests`:
  pass without warnings, using the already installed NDK 27.2.12479018 API-24 compiler.
- Exact neutral ticket test with `cargo test --features mobile --lib`: one test
  passed with macOS-only fixtures excluded. The existing host-mobile
  `home_keychain::save_password` dead-code warning remains.
- Generated-rules guard: pass; eight temporary-copy mutations (removed plugin,
  argument or native rules, disabled shrinking/minification, enabled debugging,
  renamed activity bridge and missing generated file) all rejected.
- CI regeneration simulation: removed generated Kotlin, Gradle settings/build
  and Tauri rules; the exact targeted-clean/check sequence regenerated them and
  passed the guard in 11 seconds using the existing cache.
- Local ARM64 release APK: **pass**, via
  `npm run tauri -- android build --target aarch64 --apk --ci`, with installed
  SDK 37, NDK 27.2.12479018 and JDK 17. SDK downloads were disabled. Initial
  direct Gradle attempts exposed missing offline lint dependencies and the
  required Tauri CLI session; the first CLI build then exposed the barcode
  dependency exclusion described above. The final R8 build succeeds. Existing
  AGP legacy-API and upstream Kotlin deprecation warnings remain.
- `apkanalyzer` inspection of the optimized APK: all five plugins, 20 annotated
  commands/callbacks, eight argument classes and their fields, and seven named
  JNI classes retain their names. All 13 plugin/argument classes also retain
  their runtime annotations. Packaged manifest is not debuggable, denies
  cleartext and backups; packaged network XML has no cleartext exception, and
  all nine storage domains remain excluded in each backup/transfer section.
  `lib/arm64-v8a/libbitsov_app.so` and bundled barcode `libbarhopper_v3.so` are
  present. `apksigner verify` rejects the artifact as unsigned, as expected.

Local artifact (ignored, not committed):
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk`.
The universal flavor was built with **only ARM64** selected. R8 evidence is in
`app/build/outputs/mapping/universalRelease/`; no physical-device runtime claim
is made from this build or DEX inspection.

Host tests use `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`, caches under
`/tmp`, and loopback access for the mock servers. No sidecar/app was launched.

## Manual release-APK verification before distribution

On an Android build machine with the SDK/NDK already provisioned, build through
`npm run tauri -- android build --target aarch64 --apk --ci`. Direct
`./gradlew assembleRelease` needs a live Tauri CLI options session for its Rust
task. Use `-Pandroid.builder.sdkDownload=false` for direct Gradle, or
`GRADLE_OPTS=-Dorg.gradle.project.android.builder.sdkDownload=false` through
Tauri when SDK installation must remain disabled.

1. Inspect the release variant's R8 `configuration.txt`, `seeds.txt` and
   `mapping.txt` under `app/build/outputs/mapping/`. Confirm app/generated/
   consumer rules were consumed and names and command/callback members survive
   for the five plugins, their argument classes and the JNI classes above.
   Check the optimized DEX as well; source greps cannot prove retention.
2. Inspect the merged release manifest and packaged network/backup resources:
   not debuggable, no cleartext exception, backups and transfers excluded.
   Confirm the packaged native library is ARM64 and uses release compilation.
3. On a separately authorized, appropriately signed device build, cold launch
   and invoke every plugin: device-key availability/create/sign/publicKey,
   home-item store/read and seal/unseal; Settings/Tailscale recovery; LAN
   permission grant/denial callback; pairing inbox cold/warm link consumption;
   barcode scan/cancel and permission/activity callbacks. Exercise argument
   decoding and verify no missing-class/method or reflection errors in logcat.
4. Complete slice 1's physical-device checks, including biometrics, storage
   lifecycle and transport behavior. Neither this static guard nor a successful
   APK build establishes those runtime results.
