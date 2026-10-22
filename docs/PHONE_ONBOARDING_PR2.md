# Phone onboarding PR 2 — integrated

N-2DEV PR C merged as #300 (`a54e285b`). This branch merged `origin/main` with a normal merge commit (`56ddead`), then activated the phone screens. The code-free enrollment blocker is removed. PR #297 remains a draft pending physical-device evidence.

## Runtime behavior

- First-run Android and iOS: Start → scan or incoming link → automatic preview/connect → SAS v2 words and owner-device approval → Done → explicit remote-trust acknowledgment. The phone never approves its own enrollment or requests a claim code for a second device.
- `beginJoin()` invokes `join_device` with `start_second`. The host's `second_device` flag gates that action; a legacy enrollment instead asks for an updated box/new QR. No fabricated code, SAS downgrade, or renderer-granted authority.
- An unclaimed preview produces E6 before any connection. The existing first-claim/claim-code path remains available outside this phone flow.
- Startup routing waits until the host has inspected the saved descriptor. Temporary `remote=false` cannot auto-import a cold link over an existing pairing. Saved, unredeemed and consumed enrollment descriptors return to phone onboarding; established pairings retain explicit incoming-link review. Descriptor read failures expose existing recovery instead of leaving a blank startup.
- A foreground return reconnects through `pairing_retry` using the saved descriptor. A process restart does not persist or reconstruct comparison words: a pending comparison without its in-memory state offers cancellation and a new QR. A locked box exposes the existing unlock prompt while keeping the phone ceremony mounted.
- The legacy onboarding panels, shell, error cards and queued-link banner are suppressed during the new flow. Each step has one primary action and one short instruction; secondary actions and diagnostics start under collapsed **Other options**. English and Danish copy leave the host's SAS words unchanged. The full remote-trust disclosure remains available under Other options, with an explicit acknowledgment before the shell/funding UI.
- Settings and Tailscale use fixed host commands, restricted to the main mobile webview. Android opens app details or the Tailscale package/Play Store; iOS opens app settings or Tailscale/App Store. No general URL opener, shell or clipboard capability is granted. Scanner cancellation is the only extra barcode capability.
- Android network recovery names **Nearby devices**; iOS names **Local Network**. Camera denial is structured for Settings recovery. QR scanning validates the pairing-link envelope before preview. Clipboard access happens only on tap; refusal offers a masked manual-paste input under Other options, cleared on submission and never stored in a signal.

## Still needs physical devices

Browser fixtures and Rust target checks do not establish native runtime behavior. Use test nodes and synthetic or disposable tickets; never capture tickets, claim codes, recovery phrases or SAS words in logs.

1. iPhone/iPad and Android: fresh install → scan → compare → approve on an existing owner using Face ID/Touch ID/Android biometrics → Done → trust acknowledgment. Verify the enrolled phone can subsequently approve another device, including the phone-first policy from #300.
2. Cold/warm `bitsov://pair/` links, cancellation, invalid QR, incoming links during comparison, and explicit review on already-paired phones. Kill/relaunch before redemption and during pending enrollment; verify the honest new-QR recovery after loss of comparison state.
3. Deny camera permission (including Android “Don't ask again”), open Settings, grant permission and return. Verify scanner cancellation releases the camera and another scan works.
4. Deny iOS Local Network / Android 17 Nearby devices, grant in Settings, and return. Verify reconnection uses the persisted descriptor without importing the original ticket again.
5. Tailscale installed, absent, signed out and disconnected: verify native launch/store fallback and foreground retry. Verify behavior when the system refuses an external launch.
6. Refuse clipboard reads in WKWebView and Android WebView; use the native long-press Paste action in the masked fallback. Verify a delayed clipboard response cannot replace a later ceremony.
7. Background/foreground, screen lock, node lock/unlock, owner rejection, mismatch, approval expiry and network interruption during comparison. Confirm no competing legacy panels appear.
8. VoiceOver/TalkBack, larger text, safe areas and software keyboards. Validate release builds' native plugin registration (including Android R8); Cargo target checks do not compile/test the Kotlin plugin or prove installed-app behavior.

## Verification

The fixture under `tests/fixtures` is not a production entry. The headless Playwright spec uses 390×844 and covers English/Danish states, Android permission copy and the compact trust screen.

Commands used (all Rust commands set `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`):

```sh
npx tsc --noEmit
npm test -- --maxWorkers=4
npm run build
npm run authority
npx playwright test -c playwright.a11y.config.ts tests/a11y/phone-onboarding.spec.ts
cargo test --locked --features sit-mock --lib \
  --test android_device_key_contract --test android_pairing_contract \
  --test delegation_contract --test mac_keychain_contract --test mac_pairing_errors \
  --test mac_typed_unlock_contract --test onboarding_assistant --test pairing \
  --test platform_gating --test pr47_budget -- --test-threads=4
cargo check --locked -p bitsov-app --target aarch64-linux-android --lib --tests
cargo check --locked -p bitsov-app --target aarch64-apple-ios --lib --tests
```

The Android check uses the installed NDK 27.2.12479018 API-24 clang/llvm-ar. `sit-mock` enables the non-window onboarding integration suite. All ten integration targets in `src-tauri/tests` are explicitly included. No app/window-opening binary or `cargo fmt` was run.

Verification on 2026-10-21:

- TypeScript, production build and authority: PASS (the existing >500 kB bundle warning remains).
- Full Vitest: 1,848 tests in 102 files passed. After the final single-line copy and banner adjustment, 88 focused onboarding/pairing tests also passed.
- Rust: 1,071 app library tests and 58 non-window integration tests passed; the workspace also ran 19 FFI/mock-node tests successfully, with one pre-existing hardware-dependent test ignored.
- Android `aarch64-linux-android` and iOS `aarch64-apple-ios` cargo checks with lib/tests: PASS.
- Headless 390×844 Playwright: 44 English/Danish cases passed, including Android copy and trust disclosure; instruction paragraphs are checked to fit one visible line at this size.

The initial highly parallel Rust run timed out in two unchanged process-supervision tests; the complete four-thread rerun passed. Swift caches initially failed because `/tmp` and `/private/tmp` module paths conflicted; rebuilding those caches resolved it. An integration assertion listing the original Swift source array was updated to allow the additional bridge. Existing Vitest Solid disposal notices and Rust dead-code warnings remain.

Independent implementation review approved the fixes. Final-commit review and branch push are recorded in the PR/task handoff; this does not replace physical-device evidence.
