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

At the then-pinned rc14 node source `d55a88e439fd80dae89e263bef8378fd22c9a103`,
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
