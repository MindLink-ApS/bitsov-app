# CODEX APP AUTHORITY — 2026-10-21 — feat/second-device-join

Scope: N-2DEV PR C app contract against node main
`22ab59ba372a377793de119943d4a9ff10e29d9a` (#356/#357). Code-free second-device
SAS v2, biometric owner decisions, provisional-scope promotion and public iOS
trust metadata. No release or phone-screen activation.

Invariants (A): PASS — node remains authoritative for pairing, owner status,
expiry, replay and revocation. The renderer neither signs nor contacts the node.
No node crate is linked. Existing claim-code SAS v1 remains separate.

Gates (B): G1 PASS (source); G2 PASS (pinned Noise, host-only credentials and
signing); G3/G4 unchanged; G5 unchanged (no publication); G6 PASS (existing trust
disclosure retained). The authority script passes all its source checks; this is
not a new binary/signature or deployment acceptance decision.

Product gates (C): capability-gated enrollment and negative/interoperability
contracts PASS. Physical Touch ID/Face ID, camera/link lifecycle and packaged
native end-to-end acceptance remain integration checks.

Sequencing (D): OK — uses existing Noise confidentiality and device pairing.
No node-in-phone, relay, payment, assistant or meeting authority is added.

VERDICT: QUALIFIED-GO for the requested development branch. Release acceptance
and activating phone onboarding PR 2 remain outside this change.

Must-fix before next ship: complete physical-device acceptance and the remaining
phone PR 2 integration gates before shipping that combined flow.

## Executed checks

- No-sidecar Rust library suite → PASS (1,048 app + 12 FFI; 1 hardware test ignored).
- TypeScript → PASS (`npm run build` runs `tsc --noEmit`).
- Vitest → PASS (1,795 tests).
- Build → PASS (existing large-chunk warning).
- Authority source checks → PASS.
- Mobile feature, iOS and Android Cargo checks → PASS.
- Headless iOS Keychain and public metadata policy tests → PASS.
- Independent code review and whitespace check → PASS.

See [implementation and verification notes](../SECOND_DEVICE_JOIN.md) for the
host contract, fixture provenance, retry coverage and the earlier child-exit test
timeout that passed in the final full run. No `cargo fmt` or window-opening
binary was run; no real tickets, claim codes or comparison words were logged.

## PR #300 round 1 — fixes after e10306b1

The Apple Keychain contract now deliberately covers the shared macOS/iOS cfg
and separately pins iOS secret refusal, the two public metadata item names,
WhenUnlockedThisDeviceOnly on insert and update, and disabled synchronization.
Second-device validation, ticket import and renderer deadlines reuse the v1
30-second skew allowance; the node still enforces expiry. A bad pending item
is skipped with a fixed diagnostic without preventing other comparisons.
The provisional one-use path requires a node identity before saving its pairing
record. Successful enrollment clears the consumed ticket hash from disk and
memory only after access refresh and setup succeed, with replacement/forget
protection. Waiting copy directs the new device to its other device.

Verification:

- Full workspace test run, including the app's `tests/` integration suites:
  `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --locked --manifest-path src-tauri/Cargo.toml --features dev-node,local-owner-ceremony --no-fail-fast -- --test-threads=4`
  → 1,173 passed, 0 failed, 1 existing hardware test ignored. This includes
  1,074 app unit tests and 53 app integration tests.
- `npx tsc --noEmit` → PASS.
- `npm test` → 100 files / 1,804 tests PASS.
- `npm run build` → PASS (existing large-chunk warning).
- `npm run authority` → PASS.
- `cargo check --locked -p bitsov-app --target aarch64-linux-android --lib --tests`
  with NDK 27.2 API 24 clang and the no-sidecar override → PASS.
- `cargo check --locked -p bitsov-app --target aarch64-apple-ios --lib --tests`
  with the no-sidecar override → PASS.
- Independent review → no actionable findings; `git diff --check` → PASS.

The first parallel full Rust run hit three unchanged short-timeout tests;
all passed in the complete four-thread rerun. Mobile checks required normal
access to Tauri's generated Cargo-registry cache and Swift's module cache.
No `cargo fmt` or window-opening application was run.
