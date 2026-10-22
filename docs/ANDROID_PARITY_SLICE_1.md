# Android parity slice 1 — 22 October 2026

Code-only follow-up to `ANDROID-PARITY-GAPS-21OCT.md`, based on main after
#297, #299, #300 and #306. No Gradle/APK build, physical-device run, call
lifecycle change, release signing change, or owner-policy change is included.

## Code and coverage

- **Android cfg warnings:** #299's Android job reported three library and five
  library-test warnings (seven definitions; `profile::current` appeared twice).
  Apple Keychain helpers now compile only for their consumers; blob-loading,
  message-send wrappers and receipt writing are test-only with the same cfg as
  their callers. The iOS startup guard remains active on iOS and in its desktop
  mock-runtime tests. Newer enrollment test helpers receive matching cfg too.
  No warning suppression was added; the old message wrapper suppression was
  replaced with cfg.
- **Open Settings / Open Tailscale:** already wired by #297 on both phones.
  `App.tsx` invokes the two argument-free host commands; `app.rs` rejects sealed
  windows and dispatches to `phone_recovery.rs`. Android registers
  `PhoneRecoveryPlugin`: application-details Settings uses the app's own package;
  Tailscale uses `com.tailscale.ipn`, then the fixed market URI, then its fixed
  Google Play HTTPS page. The manifest queries only that package. The iOS path
  uses `UIApplication.openSettingsURLString`, `tailscale://`, and its fixed App
  Store fallback. Neither path accepts destination input from the renderer.
  The only recovery grants are `allow-open-app-settings` and
  `allow-open-tailscale` in the main mobile capability; no desktop, assistant,
  generic opener, shell, or clipboard grant was added. App-level tests exercise
  both recovery commands on both phone platforms and assert an empty payload.
- **Clipboard fallback:** shared Android/iOS behavior already catches rejected
  or missing WebView `readText()` and opens a masked, autocomplete-off manual
  field. Tests now cover each platform and each failure mode. Manual submission
  uses the existing pairing-link validation and preview/connection path. This
  slice also clears an unfinished field on reset, scanner handoff, connection,
  and unmount, so a cancelled ticket does not remain in the DOM. No native
  clipboard permission or automatic clipboard polling was introduced.
- **Phone onboarding / #300:** audited the shared first-run gate, cold-link
  consumption, trust screen, saved enrollment, join path and platform naming.
  No accidental iOS-only branch was found. Saved-enrollment coverage now runs
  for Android too; existing cross-platform tests cover code-free join, legacy
  comparison before redemption, unlock, trust, phone-first ownership and names.
  The removed non-phone-owner gate remains removed.

## Still requires a physical Android device

Use a test node and signet amounts. These are outstanding runtime checks, not
claims established by Rust checking, mocked IPC, or browser tests:

1. **Biometrics / StrongBox:** register a key; require `BIOMETRIC_STRONG` for
   every signature; record StrongBox versus TEE; cancel and lock out; enroll a
   new fingerprint and verify invalidation/re-enrollment. Exercise older API
   biometric behavior where supported. Confirm non-invalidation errors retain
   the key. Test owner approvals and small in-call payments.
2. **Cold and warm links:** kill → `bitsov://pair/` → onboarding, without replay
   after restart. Scan and connect without restart; resume a saved enrollment;
   complete both first-phone ownership and second-device join with approval.
3. **LAN / camera / microphone prompts:** Android 17 Nearby devices denial and
   grant; Settings return and reconnect; camera denial including “Don't ask
   again”; scanner cancellation; clipboard refusal and the system Paste menu
   in the masked field. Check WebRTC LAN permission separately from Rust dial.
4. **Recovery destinations:** Settings opens this app; installed Tailscale
   opens; absent Tailscale falls back to the store/browser; return to BitSov
   resumes the intended recovery. Static wiring does not establish OS behavior.
5. **Calls on lock screen / app switch:** two-way phone ↔ Mac audio on the
   tailnet, then lock and background. Calls may drop: this slice adds no
   microphone foreground service, notification permission, or audio routing.
   Verify earpiece/speaker/Bluetooth, End call and spend-slot recovery.
6. **Storage lifecycle:** reinstall produces a fresh client identity; backup,
   restore and device transfer do not carry remote credentials or sealed keys.
7. **Release APK:** separately build and test R8/plugin retention and signing
   before distribution. No release or Kotlin/Gradle runtime evidence is supplied
   by this slice.

## Verification

The local Android target and NDK 27.2.12479018 are available. The actual
`cargo check --locked -p bitsov-app --target aarch64-linux-android --lib --tests`
passes without warnings using the NDK API-24 compiler. It does not link or run
an Android binary. No physical Android behavior is marked verified.

- `npm run build` (`tsc --noEmit` + Vite): pass; existing large-chunk advisory.
- `npm test`: 109 files, 1,954 tests pass.
- `npm run authority`: pass.
- `npm run a11y`: 65 tests pass with headless Chrome. A temporary config
  changed only the localhost port to 1437 because another worktree owned 1421;
  that config was removed afterward.
- `cargo test --locked -p bitsov-app --features dev-node,local-owner-ceremony --lib -- --test-threads=4`:
  1,084 tests pass. The first unrestricted run, alongside other suites, timed
  out in `app::post_rc7_tests::price_floor_refusal_is_only_offered_after_failed_stderr_exit`
  and `app::post_rc7_tests::supervised_refusal_waits_for_consent_then_repairs_and_starts_normally`.
  Both passed in a serial rerun, then the full suite passed with four threads.
- `cargo test --locked -p bitsov-app --features dev-node,local-owner-ceremony,sit-mock --test '*'`:
  58 non-window integration tests pass, including the mock assistant flow.
- Additional host `--features mobile --lib --tests` check: pass, with the
  pre-existing macOS simulation warning for `home_keychain::save_password`.
  The real Android check has zero warnings.

Cargo commands used the local cache with `--offline` and target directories
under `/tmp`. Host tests set `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`;
no bundled node or app was launched. Loopback-based tests and the headless
browser suite required execution outside the network-restricted sandbox.
An initial Swift cache alias conflict was resolved by consistently using
`/tmp` for the host target directory. No `cargo fmt` was run.
