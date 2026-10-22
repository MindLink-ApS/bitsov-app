# N-2DEV PR C: owner-approved second-device enrollment

Node contract: `MindLink-ApS/BitSov-bitsov` main
`22ab59ba372a377793de119943d4a9ff10e29d9a` (PRs #356 and #357).
Reference: `docs/design/N-2DEV-SECOND-DEVICE.md`,
`crates/konsensus-api/src/pairing/{second_device,ticket,device,approval}.rs`,
`crates/konsensus-api/src/sas.rs`, and the node's Noise ticket dispatcher.
No node crates are linked or vendored into the app.

## Host and renderer contract

The existing `remote_access_preview`, import and connect commands accept signed
PairLinks from the console (`second_` plus canonical 32-byte base64url) and owner
app (`owner_` plus 32-byte lowercase hex). The existing device-join command adds
`{ "action": "start_second" }`, a strict empty object that rejects a claim-code
field. `start` with a claim code retains the original SAS v1 behavior and cannot
be used for a provisional second-device pairing.

A phone (iPhone or Android) can be the first owner device. First claims use the
owner-entered console claim code; no enrolled computer or other non-phone device
is required. Later devices still require the word comparison and owner approval.
Both registration paths label devices by their actual platform: iPhone, Android
phone, Mac, or Windows.

`status` returns `{ "state": "idle", "second_device": true }` for a consumed
second-device ticket. Start returns `waiting` with four words and the node's
five-minute deadline; `poll` waits for registration. Waiting and done responses
also carry `second_device`, so remounting never restores claim-code instructions. `cancel` withdraws the
pending operation. There is no joining-device “They match” action.

`DeviceView.second_device` exposes the selected flow to existing screens.
`DeviceApprovals` continues using `JoinDevice`; the renderer only selects the
code-free action, hides claim instructions, and renders the same words. It shows
no claim input while status is loading. Phone onboarding PR 2 can implement its
existing `beginJoin()` boundary with `start_second` after import/connect, then use
`poll` and `cancel`. No phone onboarding screens are activated here.

Owner `AddDevice` uses `/status.api_capabilities` containing
`second_device_enrollment_v1`. It signs `bitsov-ticket-v2` with
`purpose:second_device`, discovers pending requests (including console tickets),
and shows their words. Approval requires the current ticket ID or console issuer;
other tickets show a disabled approval and its reason. “Words differ” signs the
separate reject domain and calls the node's rejection endpoint. Both decisions
use the existing biometric device-key signer. Closing the ticket only closes the
local view; it is distinct from rejecting a pending device.

## Protocol and lifecycle

A provisional Noise response has empty scopes. The node deliberately denies
`/status`, `/identity` and `/pair/device-keys` on that session. The joiner therefore
uses the authenticated provisional response as evidence of the node's second-device
mode, the signed descriptor as its identity pin, and only enrollment routes until
approval. It never infers support from an arbitrary 403 or downgrades to SAS v1.
The rollout flag remains node-owned and default off.

The host derives the ticket commitment from the scanned code and computes SAS v2
on one pinned Noise transcript shared by create/finalize. The consumed ticket is
retired on disk before its pairing proof is written; only its commitment remains.
A lost response reconnects with the same pairing keys and no ticket. Interrupted
sends can also recover from the retired descriptor. A definite refusal does not
resend the ticket. An already-paired device is directed to its existing pairing.
Neither claim codes nor SAS digests/words are persisted. No new logging records
tickets, codes, or words.

Owner-side validation reconstructs every signed field in the node's exact order,
checks the pinned identity and current approver client/epoch/key, validates canonical
encodings and expiry, and derives words from the supplied digest. The host fetches
the comparison again before signing and refuses any change. It validates expiry
again after the biometric prompt. The node remains authoritative for owner status,
revocation, one-use operations and provisional scope promotion.

Either the join poll or the app's background device-status poll refreshes the token
and normal authentication before exposing registered completion. This prevents
screen unmounting from skipping scope promotion. A completion marker remains
pending if token issuance succeeds but the identity check fails, so subsequent
polls retry rather than prematurely reporting success. Restarted pending enrollment can
be cancelled and retried while the provisional pairing remains valid; the app does
not restore persisted comparison words.

On iOS, the native public metadata bridge stores only box transport pins and
unlock bindings in exact node/profile-scoped Data Protection Keychain items.
It rejects password services and secret writes, disables interaction, and uses
ThisDeviceOnly accessibility with synchronization disabled. This supplies the
existing pin-store and authentication completion paths on iPhone without adding
password enrollment or unlock UI.

## Verification

Tests include the node's frozen SAS v2 digest/word vector and field-binding mutations,
an independently assembled approval fixture, a pinned Noise responder checking
registration proofs and independently computing the node's digest, lost pairing
responses, background-poll promotion, signed rejection, foreign-ticket approval
refusal, wrong words, changed operations, expiry, replay, non-owner/revoked owner,
flag-off refusal, and renderer absence of claim inputs/instructions.

The no-sidecar Rust override is `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'`.
Gates: `cargo test --lib`, `tsc --noEmit`, Vitest, build, authority,
`cargo check --features mobile --tests`, and native iOS/Android Cargo checks.
No `cargo fmt`, app launch, simulator launch, real QR, or real claim code is used.
Physical Touch ID / Face ID and camera testing remains a native-device integration
check; these automated tests use the existing non-prompting test key policy.

Verified 2026-10-21 on the final implementation:

- No-sidecar `cargo test --offline --locked --lib -- --test-threads=1`: 1,048
  app tests and 12 FFI tests passed; the existing hardware-dependent biometric
  creation test is ignored. An earlier run timed out at the unchanged
  `price_floor_refusal_is_only_offered_after_failed_stderr_exit` test's five-second
  child-exit wait; that test and the complete final run passed.
- `npm test -- --maxWorkers=4`: 1,795 tests in 100 files passed.
- `npm run build` (includes `tsc --noEmit`) and `npm run authority`: passed.
- `cargo check --features mobile --tests`, `--target aarch64-apple-ios --tests`,
  and `--target aarch64-linux-android --tests`: passed, with the no-sidecar override.
- `scripts/test-ios-home-metadata.sh` and `scripts/test-ios-keychain.sh`: passed
  headlessly with injected Security operations and no authentication UI.
- Independent code review: approved after completion-retry and remount regressions
  were fixed and verified. `git diff --check`: passed.

The production build retains its existing large-chunk warning; native checks
retain unused-code warnings. These are compile/contract checks, not physical-device
or release-package acceptance evidence.

Phone-first/platform-name follow-up (2026-10-21): no-sidecar library tests passed
1,053 app tests and 12 FFI tests, with the existing hardware test ignored. The
phone-first fixture exercises zero enrolled owners, required console claim input,
phone registration names and independently checked SAS v1 bytes on the host;
existing SAS v2 tests still cover waiting for owner approval. Four platform-name
unit tests cover iPhone, Android phone, Mac and Windows. TypeScript, all 1,795
Vitest tests, build, authority, mobile-feature and iOS/Android `cargo check --tests`
passed. After the copy adjustment, the 77 add-device/mobile-parity UI tests passed.
The phone cases use the host's non-prompting test key policy; native checks compile
the target paths and do not replace physical-device acceptance. No `cargo fmt`
or window-opening binary was run.
