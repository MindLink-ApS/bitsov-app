# Phone onboarding: host recovery (PR 1 extension)

This extends `a88acf6` on `fix/mobile-import-connects`. The phone still imports
and attaches without restarting. No screens or node protocol changes are added.

## Host contract

`node_status.connection_error` is nullable and contains `{ kind, detail }`.
The TypeScript mirror is `ConnectionError` in `src/onboarding/pairing.ts`.
Existing `error` and pairing `reason` fields remain compatible.

- `unclaimed`: a bootstrap box key with an empty node identity. On phones,
  attachment returns this state before key creation, Noise authentication, or
  a socket dial. Persisted first-run descriptors receive the same result on retry.
- `local_network`: an iOS connect error classified as permission denied, network
  down, network unreachable, or host unreachable for a LAN IP or `.local` name.
  This means denied **or unavailable**, not a definitive permission verdict.
  Timeouts and refused connections alone do not imply a privacy restriction.
  Tailscale addresses and names do not become Local Network permission errors.
- `unreachable`, `busy`, `expired`, `other`: stable fallback classifications.
  Untrusted peer and local diagnostic strings are not copied into `detail`.

`NSLocalNetworkUsageDescription` explains access for connecting to the box and
call peers. A test pins that purpose. This PR does not add a permission prompt,
Settings button, or scanner screen.

Native mobile window-resume and main-window focus events call the existing
pairing retry path. The top-level Tauri `RunEvent::Resumed` is deliberately not
used: the runtime also emits it for event-loop polling. An in-flight recovery
owns the existing recovery mutex; concurrent foreground events do not start
another connection. No descriptor, a forgotten descriptor, or shutdown means
no automatic connection. Backoff and server rate limits remain intact.

Forget and a valid replacement import cancel the current connect generation,
including a pending dial or retry sleep, and wait for the recovery lock before
changing the saved descriptor. Invalid imports leave recovery running. A live
proxy still refuses in-place import; Forget preserves its established transport.
New attempts retain the process-wide retry budget. Desktop Reconnect also refuses
a remote switch while the first local startup is still initializing its config.
The generated Xcode plist and source iOS plist carry the same Local Network text.

Foreground recovery loads the persisted descriptor. It never parses or imports
the original QR again. After successful ticket consumption, the descriptor has
no ticket code and reconnect uses existing-client authentication. A ticket that
was never successfully consumed remains subject to the node's own expiry.

## Claim-free second-device enrollment: protocol blocker

Atlas's 21 October ruling requires QR → word match → approval on an already
paired owner device, without a claim code on the joining device. The current
host flow cannot implement that ruling against the pinned node contract.

At pinned node source `d55a88e439fd80dae89e263bef8378fd22c9a103`,
`crates/konsensus-api/src/pairing/device.rs` loads the claim commitment when
constructing the second-device SAS digest. `confirm_device_sas` compares the
submitted digest with that value; a mismatch removes the operation and counts
a failed attempt. The current app mirrors this in `add_device::join`.

An approved, versioned claim-free node enrollment contract is needed before
changing this path. This extension does not send a placeholder commitment,
downgrade SAS, expose a claim secret, or claim that requirement is implemented.
No node, live ticket, or claim-code operation was performed.

## Verification

Host tests cover unclaimed import/attach/retry without dialing, iOS error-class
mapping and serialization, safe diagnostic text, foreground event selection,
empty/forgotten/busy recovery, successful error recovery, and reconnect after QR
expiry with no ticket replay. Loopback fake responders and temporary data are
used. Physical iOS permission and lifecycle acceptance remain device checks.

Validation on 21 October 2026:

- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' CARGO_TARGET_DIR=target cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1`: 957 app tests and 12 FFI tests passed; one existing FFI test ignored. Concurrent runs hit intermittent five-second timeouts in existing mock process-supervision tests; both affected tests passed independently, and the complete serial run passed.
- Same override, `cargo test --manifest-path src-tauri/Cargo.toml -p bitsov-app --lib --features mobile`: 527 passed.
- `npx tsc --noEmit`: passed.
- `npm test`: 98 files, 1,700 tests passed.
- `npm run build`: passed; existing large-chunk warning.
- `npm run authority`: passed.
- Read-only review approved (a)–(c) after lifecycle-event, diagnostic privacy, and concurrent error-clearing fixes. This is not approval of (d) or device acceptance.

No `cargo fmt` or app/window-opening executable was run.

Connect-cancellation follow-up validation (21 October 2026): the no-sidecar
`cargo test --lib -- --test-threads=1` gate passed 970 app and 12 FFI tests
(one existing Touch ID test ignored); `-p bitsov-app --features mobile --lib`
passed 539 tests. `cargo check --target aarch64-apple-ios`, TypeScript, Vitest
(98 files / 1,705 tests), frontend build, and authority passed. Regression tests
cover stalled handshakes, retry sleeps, successful replacement and code removal,
rejected imports, proxy publication during cancellation, first local startup,
and parity between both iOS Local Network descriptions. Read-only review found
no remaining blockers. Physical-device acceptance was not performed.

## Android parity audit (#285–#288)

Android shares immediate connect-after-import, actual Reconnect authentication,
unclaimed-box rejection before key creation/dial, generation cancellation on
Forget/valid new tickets, and recovery after canceled startup. Invalid tickets
do not cancel recovery; Forget retains an already established proxy by design.
The mobile regression suite is now also included under actual Android test cfg.

The locked Tao/Tauri versions deliver Android Activity resume as main-window
`WindowEvent::Resumed`; focus also triggers recovery. Android launch/new intents
still use the bounded, take-once inbox and explicit owner confirmation before
import. Foreground recovery uses the saved descriptor, without replaying a
consumed QR code or resetting the shared retry budget.

Two Android-specific changes close gaps:

- This project targets SDK 37. Android 17 requires `ACCESS_LOCAL_NETWORK`, so
  the native plugin checks/requests it before LAN dialing (and before `.local`
  resolution). Denial reports `local_network` with Android Nearby devices
  Settings guidance, without an endless transport retry. Returning after a
  Settings grant uses existing foreground recovery. Requests are coalesced and
  prompt at most once per process; older Android requires no new grant. Local
  interface prefixes include globally addressed IPv6; denied LAN addresses do
  not discard public alternatives. Forget/replacement cancels connection work
  even while the native permission exchange completes.
- Explicit legacy/cloud/device-transfer exclusions keep identity, descriptors,
  and intent receipts install-bound. `allowBackup=false` alone is insufficient
  on some Android 12+ devices. A normal restart preserves the sealed client key;
  fresh app storage creates a new seed. Keystore failures never silently rotate
  an existing identity. These exclusions prevent future transfer; they do not
  delete already-restored data.

iOS's orphan-Keychain deletion and locked-cleanup startup gate do not apply:
Android's seed lives in app-private sealed storage, and its Keystore wrapping
key has no user-authentication/unlocked-device requirement. iOS socket-error
heuristics remain iOS-only; Android 17 permission denial is checked natively,
since TCP denial can appear as a timeout.

Platform references: [Android LAN permission](https://developer.android.com/privacy-and-security/local-network-permission)
and [Android 12 backup/transfer changes](https://developer.android.com/about/versions/12/behavior-changes-12#backup-restore).
Host tests and compile checks do not establish physical-device permission,
reinstall, or lifecycle acceptance.

Validation: no-sidecar `cargo test --lib -- --test-threads=1` passed 992 app
tests and 12 FFI tests (one existing FFI test ignored); `--features mobile`
passed 561 tests. `cargo check --target aarch64-linux-android --tests` passed,
including actual Android cfg. TypeScript, Vitest (99 files / 1,706 tests),
frontend build, and authority passed. The Kotlin plugin compiled against the
Android/Tauri APIs; three JVM policy tests and Android XML resource compilation
passed. Existing build-size and test/dead-code warnings remain.

The mobile run exposed an existing test race: polling the recovery mutex could
make recovery's own `try_lock` skip. Its regression now supplies the client
record a real attach saves and observes the resumed dial without competing for
the mutex. The corrected isolated test and complete mobile suite passed.
No `cargo fmt` or window-opening executable was run.
