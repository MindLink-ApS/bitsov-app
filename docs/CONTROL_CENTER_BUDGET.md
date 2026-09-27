# Control center: invisible payments (B2)

Code: `src-tauri/src/budget.rs` (rules, book, approval), the budget commands and
`money_post` reservation in `src-tauri/src/main.rs`, and `BudgetBar` /
`BudgetPanel` in `src/control/Shell.tsx`. Builds on slice B
([CONTROL_CENTER_ACT.md](CONTROL_CENTER_ACT.md)).

Why: paid messaging fails when every message is a prompt (Szabo's mental
transaction costs; Penny Black) and works when payment is ambient (zaps,
Stacker News). Payment stays the connection at the protocol layer; the UX hides
it inside a budget the owner sets once.

## What the owner does

1. **Approve a daily total once.** Presets: Careful 500 sats/day (50 per
   contact, 100 per room), Everyday 2,000, Generous 10,000. One tap.
2. **Chat.** Inside the budget, a message to a budgeted contact or room just
   goes. The composer still shows the recipient's own price before sending.
3. **Someone new asks once.** The first paid message to a contact or room not
   in the book shows "First paid message to Nadia", with budget choices in their
   own price as the unit ("50 sats a day · 25 messages"). Sending it records
   their budget.
4. **Budget used up.** The composer says how much was used and offers to raise
   it: one tap within the daily total, or a new approval for a higher total.
5. **Pause all.** One tap in the Budget panel (or the composer line). Every
   payment stops, including the ten-minute window, and stays paused across
   restarts until resumed.

## Authority: what is stored, what is not

| | Where | Survives restart |
|---|---|---|
| Budget numbers (daily total, per contact, per room, preset, paused) | `app-spend/budget-<node16>.json`, 0600, write-then-rename, unknown fields refused | yes |
| Rolling 24 h ledger (reservations and payments by message sends) | same file | yes |
| The owner's budget approval | `NodeState::autopay`, host memory, 24 h | **no** |
| Node spend grant (paired #77 nodes) | the node, 30 days (`SPEND_GRANT_TTL_SECS`) | node-side only |

- **One approval, via the existing elevation route.** On rc7 the approval is
  the app's own lock (the node scopes nothing). On a paired node without
  `spend`, it goes through `POST /pair/elevation-request` like slice B; the
  owner types `konsensus grant --op …` once. A grant opens only what was asked:
  a budget ask arms the budget approval, never the ten-minute window.
- **Node gap, stated plainly.** The node has no TTL parameter on elevation; its
  grant lasts 30 days until the owner revokes it. The app uses it only inside
  a 24-hour in-memory approval and never writes it down. Replacing the
  per-session `konsensus grant` step fully needs a node-side budget-scoped
  grant; that is a node ticket, not this slice.
- **Budgets are limits, approvals are authority.** A contact's budget holds
  even inside a ten-minute window. Only the budget route is automatic.
- **Narrow only.** A contact or room budget can be set up to the approved daily
  total without a new approval. Lowering the total narrows every budget above
  it and narrows an open approval in place. Raising the total is a new approval.
- **Rolling 24 hours**, not a calendar day: no midnight reset that doubles the
  budget, no time zone to trust. Entries dated in the future (clock moved back)
  still count.

## One message, in order

1. `plan_message` (before any request): pause → the target's budget → if the
   budget approval is open: first-contact confirmation, then the daily total
   → otherwise the ten-minute window. Refusals: `budget_paused`,
   `budget_exhausted`, `first_contact`, `ceiling_exhausted`, `spend_locked`.
2. `max_total_msat` = the displayed price, as in slice B. The node enforces it
   per message (`paid_send_caps_v1`); the budget can only refuse, never widen it.
3. Under the journal lock, the book is re-read and re-planned, and the full
   cap is **reserved** before dispatch. The approval is rechecked afterwards.
4. Outcome: settled to the node's reported amount on success; **released**
   only on refusals before any payment (401/403, `price_cap_exceeded`, approval
   changed before dispatch); **kept at the cap** when the outcome is unknown
   (transport loss, 5xx, unresolved room). A crash between reserve and dispatch
   also keeps the cap counted. The tally can over-count, never under-count.

A 401/403 on a money route ends the budget approval as well as the window.

## Not in this slice

Files, invoices and direct (keysend) payments keep the ten-minute window and
are not counted in budgets. Free starter credits, earning back from recipients,
and a node-side budget-scoped grant are follow-ups.

## Tests

- `cargo test`
  - `budget::tests` (13): auto-pay inside budget, strangers never auto-paid,
    exhaustion with numbers, daily total across contacts, rolling window and
    clock skew, pause first, window fallback, narrow-only limits, reserve /
    settle / release, **restart keeps numbers and no authority** (file scanned
    for grant/scope/token/approval words, 0600), damaged or foreign book fails
    closed, approval expiry/narrow/lock, view rows.
  - `control_act_tests` (8 new) against the loopback fake node: one approval
    pays with the window shut and every body carries `max_total_msat`;
    exhaustion refused before any request, even inside a window; daily total
    and in-place narrowing; restart keeps the tally and drops the approval (no
    plaintext or grant on disk); pause stops everything across a restart;
    unknown outcome keeps the cap reserved, cap refusal releases it; a 403 ends
    the approval; a paired budget grant opens autopay, not the window.
- `vitest`: `tests/control-budget.test.tsx` (11) — approve once then send twice
  with no prompt, first contact asks once with the budget in the recipient's
  price, exhausted explains and raises, a used-up total is a new approval, tally
  and pause-all in the context panel, lower a budget from the panel, host budget
  refusals are composer notes (not failed sends), pay still uses the window,
  `budgetStand` rules, and the sample source's budget semantics.

Screens (`docs/control-center/`, sample data): `40-budget-approve`,
`40-budget-waiting`, `40-budget-auto-send`, `40-budget-first-contact`,
`40-budget-exhausted`, `40-budget-tally`, `40-budget-paused`, `40-budget-phone`.
