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
  ceiling. A proven `call_not_live` refusal closes the admission for free.
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
#278's allow-list and fresh-operation/retry conditions remain intact; no new
node `call_not_found` refusal mapping is inferred.

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
history. The panel remains available for a later check after evidence is restored.

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

## Validation

Verified on 2026-10-21: 1,019 app library tests and 12 FFI tests passed
(one Touch ID test ignored); 1,772 Vitest tests across 98 files passed.
TypeScript, production build, authority, and `git diff --check` passed.

Run headlessly, without `cargo fmt` or launching the app:

```sh
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1
npx tsc --noEmit
npx vitest run --configLoader runner --maxWorkers=4
npm run build
npm run authority
```
