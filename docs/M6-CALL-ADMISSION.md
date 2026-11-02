# M6 A2: host-owned call admission

This re-lands the H2 host and R2 renderer work from closed PRs #220 and
#222 together, directly on main (`1ecc0f2`). It retains main's call UI,
connection diagnostics, payment display, and #278 refusal handling.

## Admission rules

- **I1:** Under the money lock, an offer or recovery offer is refused while
  that peer has an open admission. Dispatching, unknown, paid-undelivered,
  failed-paid, and settled offers remain open until confirmed closure.
- **I2:** Hangups are bound to the exact offer operation. Concurrent cleanup
  joins the existing hangup. Reusing a wire call ID cannot reuse an older
  admission's closure. A bound hangup requires node operation support.
- **I5:** Cancel, timeout, and local failure request `op_end_call`. The host
  reconciles an uncertain offer and sends one hangup using its saved signal
  ceiling. A proven `call_not_live` refusal closes the admission for free:
  a fresh hangup of a call the node already ended gets it as `not_dispatched`
  (nodes since rc19.2).
  Paid-undelivered and failed-paid offers retain their payment history while
  cleanup proceeds; a paid-undelivered slot is retired only after accounting,
  with no retry in flight, no unresolved partial evidence, and no overrun.

Inbound closure is persisted against the host's receive-time admission
binding. Peer timestamps, local media failure, and elapsed ring time cannot
close an admission. Local teardown (`op_close_call`) validates identity but
does not settle money or close the admission. Window disposal remains
record-only; the next call exposes the host's existing-admission cleanup.

## Review regressions

| Finding | Protection and test |
| --- | --- |
| #220: 404/prepared can race the original POST | `a2_late_offer_cannot_be_released_by_empty_lookup_or_elapsed_grace` holds the POST before payment across timeout and an aged lookup, checks the admission/slot fence, then lets that original POST pay and cleans it once. Includes released snapshots, metadata-less legacy journals, and already-persisted grace releases with restored late-payment accounting. |
| #228 abandonment | `a2_only_confirmed_node_abandon_releases_a_call_offer` checks confirmed tombstones, conflicts reporting paying/prepared, and unsupported abandonment. Confirmed abandonment forces a fresh operation ID. |
| #278 fresh-operation guard | Existing refusal tests retain the HTTP/kind/room/retry constraints. Existing offer retries are stopped by I1; answer retries exercise the unchanged refusal guard and retain their earlier payment. |
| #222 Codex: reversed not-found/receipt replies | Renderer cleanup captures the actual offer promise before awaiting the host. Both reply orders are tested for cancel and timeout. |
| #222 Fable: paid errors treated as unpaid | The same matrix includes undelivered_pending, failed_paid, budget_unreadable, node errors, and rejected promises. Only proven non-dispatch skips a deferred host check. |
| Cleanup after paid errors | `a2_end_call_cleans_paid_errors_without_reclassifying_them_unpaid` checks exactly one hangup and retained paid history. |
| Capability downgrade during cleanup | `a2_cleanup_requires_operation_support_after_capability_downgrade` proves no unjournaled hangup is sent. |

The restored H2 tests additionally cover concurrent offers/hangups, restart,
stale inbound events, reused call IDs, identity changes, saved price ceilings,
failed-paid offers, damaged call indexes, and legacy nodes.

## Compatibility

Calls and metadata-less legacy operations cannot use #228's elapsed-time
fallback to declare an empty lookup unpaid. Nodes without abandonment may
therefore keep an uncertain payment fenced until they report a conclusive
result. Known message operations keep their existing reconciliation behavior.
On upgrade, a resumable/Unpaid call or untyped legacy slot that retains an
operation ID is restored to Unknown with its budget liability. Restoration is
idempotent; a confirmed abandonment has cleared that ID and remains released.
#278's allow-list and fresh-operation/retry conditions remain intact. A fresh
signal's `not_dispatched` refusal closes only on `call_not_live` or
`call_not_found` and only with no payment on record; rc21 sends only the first.

## Recovery and owner repair follow-up

Atlas confirmed that caller-side paid recovery stays refused while the original
admission is open. The recovery card says “Your last call is still closing. End
it, then call again.” End call uses `op_end_call` for the original admission;
only confirmed closure offers Call again, with a fresh quote and explicit Ring.
An uncertain or refused end cannot offer a successful redial.

`op_list.unresolved_calls` exposes opaque index references, including acknowledged
ones. The owner can ask `op_repair_call_index` to restore only an exact indexed
record or matching durable pending snapshot. A valid repaired record then goes
through ordinary `op_end_call`; repairing metadata does not close an admission.
Its durable repair entry remains visible until host evidence confirms closure,
including when ending is refused or unknown and after restart.
If the host cannot prove the record's identity, generation and call mapping,
it persists an acknowledgement and leaves every admission/payment fence and
original file intact. A corrupt mapping is never reconstructed by guessing from
history. A verified record belonging to another node is refused without writing
an acknowledgement under the current identity. The panel remains available for
a later check after evidence is restored.

Repair and end displays the exact record's saved hangup ceiling (the original
offer ceiling for legacy records). The renderer supplies that displayed limit
to `op_end_call`; the host uses the lower of it and its saved ceiling. A missing
or mismatched record has no price, so the first tap only repairs/acknowledges.
After repair exposes a verified price, a separate explicit tap may end the call.

A peer hangup/busy received during a fresh offer dispatch captures that exact
operation before waiting on the money lock. The renderer queues the bound event
until its offer receipt arrives. A reused wire ID retains the prior completed
binding so delayed old signals cannot close its new admission.

A node's capped-readmission refusal for a fresh or already-proven-unsent attempt
persists `non_dispatch_proven` in the pending slot before it becomes resumable.
Restoration respects that proof only with an Unpaid record and no payment or
partial-payment evidence. A new dispatch clears the proof durably before POST.
Legacy slots without proof still fail closed on nodes without abandonment.

The renderer retains presentation totals only. The host owns admission,
payment evidence, cleanup deduplication, and authorization. Meeting legs keep
their existing renderer engine; shared host call guards still apply.

## M6 polish regressions

- Successful reconciliation in the wallet or chat clears an existing unknown
  in-call payment. A check started before a newer payment cannot clear that
  payment, through either the shared result or the card's local callback.
- Host refusal to end a call while keysend is pending still tears down local
  media; the unresolved closure and late payment receipt remain on the ended card.
- `recovery_proof_release_requires_clean_resumable_unpaid_record` kills M1
  (trusting the proof bit alone). It checks resumability, all four evidence
  fields (including zero-valued evidence), and terminal record states.
- `recovery_capped_resend_cannot_invent_non_dispatch_proof` kills M2
  (setting proof unconditionally in the capped arm). A non-fresh message resend
  reaches that shared arm without bypassing the earlier call-admission fence;
  it must retain its previous proof value and operation ID.
- A held same-ID call redispatch verifies proof is cleared on disk before the
  POST can reply. Cancelling that future and reopening preserves the spend fence.
- Repair tests cover exact-generation pricing, legacy ceilings, missing evidence,
  foreign identities (including pending snapshots), and unknown end results.
- The 32-thread run reproduced `call_node_timeout_is_bounded_and_keeps_the_payment_pending`
  exceeding its outer two-second preflight/filesystem deadline. It now observes
  the actual POST, holds its response, and advances Tokio time to verify the
  configured spend timeout. The adjacent explicit-refusal test also stops
  timing preflight; it still asserts the refusal releases the reservation,
  disables automatic spending, and retains the saved preset. The original Grok report did not name its two tests,
  so attribution to that earlier run remains unconfirmed.

## Validation

Verified on 2026-10-21: 1,079 app library tests, 57 non-window app
integration tests (including four with `sit-mock`), 12 FFI tests
(one Touch ID test ignored), and seven mock-node pairing tests passed.
The library/integration gate used 32 test threads. The unsupported-platform
integration target is inactive on macOS. All 1,810 Vitest tests across 100 files,
TypeScript, production build, authority, and `git diff --check` passed.
M1 and M2 each failed their new regression when applied and passed after
restoration. Removing the money-request timeout also failed the deterministic
timeout regression; restoring it passed.

Run headlessly, without `cargo fmt` or launching the app:

```sh
export TAURI_CONFIG='{"bundle":{"externalBin":[]}}'
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  --features dev-node,local-owner-ceremony --lib \
  --test android_device_key_contract --test android_pairing_contract \
  --test delegation_contract --test mac_keychain_contract \
  --test mac_pairing_errors --test mac_typed_unlock_contract \
  --test onboarding_assistant --test pairing --test platform_gating \
  --test pr47_budget -- --test-threads=32
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  --features dev-node,local-owner-ceremony,sit-mock \
  --test onboarding_assistant -- --test-threads=32
npx tsc --noEmit
npx vitest run --configLoader runner --maxWorkers=4
npm run build
npm run authority
```
