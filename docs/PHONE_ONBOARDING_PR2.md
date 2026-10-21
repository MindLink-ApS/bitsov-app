# Phone onboarding PR 2 — integration blocked

This branch prepares `PhoneOnboarding`, its English/Danish copy, and component/layout tests. **It does not activate the new flow in `App.tsx` and is not ready to merge as PR 2.** Desktop and existing phone runtime behavior are unchanged.

## Missing contract

The final ruling in the onboarding spec requires second devices to join without a claim code. Main at `b2199ca` does not implement that contract:

- `src-tauri/src/add_device.rs`: `JoinInput::Start { claim_code: Zeroizing<String> }` requires a code. `join()` calls `sas::claim_commitment(&claim_code)` before starting enrollment, then includes the commitment in the comparison digest.
- `src-tauri/src/sas.rs`: `claim_commitment` rejects an empty code. Supplying an empty string or removing the input in TypeScript cannot implement the requested flow.
- The locally available node source (`crates/konsensus-api/src/pairing/device.rs`) also loads the claim commitment when calculating enrollment SAS. Changing only the app digest would fail finalization. No protocol code was changed.

`PhoneOnboardingProps.beginJoin()` is deliberately a code-free boundary. A confirmed host/node implementation must supply it. The component does not supply a fabricated code, downgrade SAS, or grant authority itself.

## Prepared behavior

- Start → scanner → automatic preview/connect → words with owner-side approval → Done.
- No phone “They match” button for the words ceremony; the legacy non-delegating path retains explicit fingerprint confirmation.
- Unclaimed previews are rejected before connect. E1–E6 and connection error variants have one primary action. Every disabled primary has a visible accessible reason.
- Other options starts collapsed and contains Paste link, assisted pairing help, QR help and diagnostics. Clipboard contents are read only on tap, never rendered or kept in a signal.
- Incoming links enter directly when idle. Enrollment polling and clipboard results are invalidated when superseded; cancellation and expiry cannot be overwritten by late completion.
- Settings/foreground recovery uses the supplied persisted-descriptor retry callback, without reimporting the link.
- Danish interface copy leaves the host's comparison words unchanged. “Words differ” remains quoted verbatim because the unchanged owner UI uses that exact label.

## Remaining integration work

1. Supply the owner-approved, code-free second-device host/node contract and its interoperability tests.
2. Wire this component into the first-run phone path in `App.tsx`, preserving the existing trust disclosure and paired-phone incoming-link review. Suppress the legacy phone panels/banner/error presentation while this flow is active.
3. Wire native scanner cancellation/permission errors, Settings and Tailscale opening, and valid-QR-only scanning. The existing mobile capability does not yet grant barcode-scanner cancellation or opening app settings. Add only the required native capabilities and validate them on devices.
4. Exercise cold/warm native links, camera denial, local-network denial and background recovery on Android/iOS. The browser fixtures are not native smoke evidence.
5. Complete two independent reviews of the integrated implementation on the same commit.

## Verification

The test fixture lives under `tests/fixtures`; it is not a production Vite entry. `tests/a11y/phone-onboarding.spec.ts` uses the existing headless Playwright harness at 390×844 for English and Danish, checking overflow, visible controls, disabled explanations and collapsed options, and saving screenshots under ignored `test-results`.

Commands:

```sh
npx tsc --noEmit
npm test
npm run build
npm run authority
npx playwright test -c playwright.a11y.config.ts tests/a11y/phone-onboarding.spec.ts
```

No host code changed, so the conditional `cargo test --lib` gate does not apply. No `cargo fmt`, native app launch, real tickets, or real codes were used.

Verification on 2026-10-21: TypeScript, build and authority passed. The full Vitest rerun (`npm test -- --maxWorkers=4`) passed all 1,820 tests in 101 files, including 31 phone component tests. The initial default-worker run had one failure in `tests/control-calls.test.tsx:2499` (the reconnect countdown remained 30 after a 1.2-second wait); that unchanged test passed both in isolation and in the complete rerun. The production build retains its existing >500 kB chunk warning.

The final headless Playwright run passed 38 English/Danish cases at 390×844, including approval expiry. Two independent component reviews approved the prepared implementation; this is not approval to activate or merge the incomplete integrated flow.
