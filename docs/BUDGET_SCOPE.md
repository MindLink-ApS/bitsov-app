# App payment principal budget

B2 caps **app payment principal in a rolling 24 hours**: automatic and manual-window messages, room sends, files, app invoice payments and keysend. Reported admission principal also counts. It is not a wallet-wide daily spending or loss limit, and it does not include routing fees.

Every covered send must fit the same saved daily book and any applicable contact or room limit. Automatic messages additionally need a live approval; files and direct app payments still require the manual window. The app reserves the enforceable principal allowance before paid dispatch and records reported principal on completion. Files are checked before upload and again before paid dispatch. When G1 can pay re-admission, the reservation includes the full enforceable recipient allowance, so a quoted file price can fit while the possible total does not. Existing per-message, per-recipient, room, first-contact and G1 restrictions still apply; the narrowest applicable limit wins.

Uncertain outcomes retain their reservation and the pending-payment fence, including beyond 24 hours. A direct payment can be reconciled only from an exact outgoing payment hash and terminal status, without resending. Confirmed failed principal is zero; fees remain outside B2. Accounting is saved before settling the reservation and clearing the journal.

Successful direct payments are accounted once by their canonical payment hash. The book saves each hash and its principal atomically with settlement, retaining the identity across restart, ledger compaction and expiry of the rolling window. Replayed receipts settle only the new reservation at zero; an unresolved replay keeps its reservation until terminal evidence arrives. Separate keysend attempts and messages still count independently. Books written before payment identities were recorded retain their existing charges, but those missing historical hashes cannot be reconstructed for replay detection.

The book and tally survive restart. Manual sends cannot bypass the saved ceiling even when automatic approval is off. Invoice and keysend totals have separate rows because Lightning destinations are not BitSov contact IDs; they do not create contact budgets. Existing books need no migration. Older direct-payment journals remain readable, but past files/payments that were not recorded cannot be reconstructed. “Daily” means rolling 24 hours, not a midnight reset.

| Action | App daily book | Owner control / warning |
| --- | --- | --- |
| Automatic or manual direct/room message | Included, with reported admission principal | App payment budget, contact/room limits, existing node caps |
| File send in the manual window | Included, sharing the contact tally | File composer; refuses before paid dispatch if either limit is exceeded |
| App invoice payment / keysend | Included, principal only | Pay composer states scope and additional routing-fee exposure; manual approval, confirmed amount and any finite node grant still apply |
| Channel open / cooperative or force close | Outside | Wallet warns before the owner leaves the app to act. Check committed capital, funding/closing/sweep fees and recovery delays at the owner CLI/API action. The pinned app has no channel dispatch control. |
| On-chain transfer | Outside | Wallet warning; separately review amount and fee policy at the owner CLI/API action. The pinned app has no on-chain transfer control. |
| Owner-direct CLI/API actions, including calendar fanout | Outside | Do not rely on B2 or a paired G1 grant: review amount, recipients and fee policy before each owner action. |
| Background workers; routing/on-chain fees | Outside | Separate node policies apply. They are listed in Budget exclusions; this app limit does not bound their debit. |

**G1 is a separate finite node grant, not a rolling daily limit.** It has a remaining principal balance, per-call/recipient restrictions and an expiry. It does not refill when B2 charges age out. Replacing or renewing a grant can authorize more spending; it does not reset the app book.

“Pause app payments” refuses new app money requests. It cannot cancel in-flight payments, stop independent owner commands/background workers, or revoke a node grant.

Scope: app base `7bda72c`, genome integration target `4aa5089` (read-only). These changes do not resolve routing-fee exposure or qualify real-sat operation.
