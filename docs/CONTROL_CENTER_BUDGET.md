# Control center: invisible payments (B2)

Code: `src-tauri/src/budget.rs` (rules, book, approval), `src-tauri/src/grant.rs`
(G1 node grants), the budget commands and `money_post` reservation in
`src-tauri/src/main.rs`, and `BudgetBar` / `BudgetPanel` in `src/control/Shell.tsx`. Builds on slice B
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
| The owner's budget approval | `NodeState::autopay`, host memory, 24 h or the node grant's expiry, whichever is first | **no** |
| Last read of the G1 node grant | `NodeState::node_grant`, host memory | **no** |
| Node spend grant, G1 node (`spend_budget_grant_v1`) | the node: budget, tally, absolute expiry ≤ 24 h | node-side only |
| Node spend grant, pre-G1 #77 node | the node, 30 days (`SPEND_GRANT_TTL_SECS`) | node-side only |

- **One approval, via the existing elevation route.** On rc7 the approval is
  the app's own lock (the node scopes nothing). On a paired node without
  `spend`, it goes through `POST /pair/elevation-request` like slice B; the
  owner types `konsensus grant --op …` once. A grant opens only what was asked:
  a budget ask arms the budget approval, never the ten-minute window.
- **G1 nodes: the node grant is the source of truth.** See the next section.
- **Pre-G1 nodes, stated plainly.** Without `spend_budget_grant_v1` the node
  has no TTL or budget on elevation; its grant lasts 30 days until the owner
  revokes it. The app uses it only inside a 24-hour in-memory approval and
  never writes it down.
- **Budgets are limits, approvals are authority.** A contact's budget holds
  even inside a ten-minute window. Only the budget route is automatic.
- **Narrow only.** A contact or room budget can be set up to the approved daily
  total without a new approval. Lowering the total narrows every budget above
  it and narrows an open approval in place. Raising the total is a new approval.
- **Rolling 24 hours**, not a calendar day: no midnight reset that doubles the
  budget, no time zone to trust. Entries dated in the future (clock moved back)
  still count.

## Budget-scoped node grants (genome G1)

The node advertises `spend_budget_grant_v1` in `/status` → `api_capabilities`
(genome `docs/SPEND_BUDGET_GRANTS.md`). A paired token's `spend` then comes
only from a grant with an absolute expiry (at most 24 h), a total, a per-call
maximum and optional per-recipient budgets, debited by the node before any
invoice or payment.

- **The ask carries a budget.** On a G1 node, `POST /pair/elevation-request`
  sends `{"scopes":["spend"],"budget":{…}}`. A budget ask proposes the daily
  total, `ttl_secs` 86400 and each contact's budget as `per_recipient_msat`
  (sent only when every entry is well formed, at most 256). A ten-minute
  window ask proposes the book's daily total for 600 s. It is only a proposal:
  `konsensus grant --op … [--budget …] [--for …]` overrides it field by field.
  Older nodes get the pre-G1 body.
- **`GET /pair/grant` is read, not assumed.** When the owner's grant lands
  (and when a token already claiming `spend` opens anything), the app reads the
  grant. The budget approval and the window then end at the grant's
  `expires_at`, and the approval's ceiling is `min(asked, budget_msat)`. The
  book's own numbers still apply on top: narrowest wins.
- **Relaunch reads current authority before restoring a pending request.**
  Startup polls spend status before budget status. That first poll reads
  `/status` and `/pair/grant` before a saved elevation can change the approval
  generations. A live grant restores the message budget within its terms and
  the saved daily ceiling; the ten-minute payment window stays closed. A
  token without `spend` is refreshed and the grant read again before opening.
  An unreadable response leaves startup restoration retryable. An old
  `/pair/elevation/{op_id}` result alone is never spend authority. Without a
  live grant, a saved pending request is restored and polled; autopay stays
  closed. The budget-status token refresh is limited to startup restoration.
  During a session, spend status polls any pending elevation regardless of
  token scope, so a token refreshed before that tick cannot strand approval.
- **Re-read before every paid request.** While approvals rest on a G1 grant,
  `money_post` reads `GET /pair/grant` again before journaling anything and
  refuses what the node would refuse: `per_call_max_msat`, `remaining_msat`
  and, for a peer message, file or keysend, that recipient's budget. No
  request is made.
- **`409 budget_exceeded`, per reason.** The node reserved and paid nothing,
  so the app releases its reservation and clears the journal (not an unknown
  outcome). `no_grant` → `grant_ended` and every approval closes (window,
  budget approval, pending wants). `per_call` → `grant_per_call`, `total` →
  `grant_exhausted`, `recipient` → `grant_recipient`, `unpriced` →
  `grant_unpriced` (amountless invoice or first-contact admission), `ledger` →
  `grant_ledger`, anything else → `grant_refused`. The renderer shows all of
  them as composer notes, not failed sends; `grant_ended` also re-reads the
  spend state.
- **Fail closed.** A grant that is null or expired when read closes
  everything (`grant_ended`). A `/status` or `/pair/grant` the app cannot read
  or parse at the moment authority would open opens nothing (`grant_unknown`);
  a reply without the `grant` key counts as unreadable, not "no grant". A
  token that still claims `spend` from a pre-G1 30-day grant is not trusted on
  a G1 node: with no live grant the app asks again.
- **The Budget panel** shows what the node grant still allows: "Your node
  allows X of Y sats more, at most Z per payment, for N min".

## One message, in order

1. `plan_message` (before any request): pause → the target's budget → if the
   budget approval is open: first-contact confirmation, then the daily total
   → otherwise the ten-minute window. Refusals: `budget_paused`,
   `budget_exhausted`, `first_contact`, `ceiling_exhausted`, `spend_locked`.
2. `max_total_msat` = the displayed price, as in slice B. The node enforces it
   per message (`paid_send_caps_v1`); the budget can only refuse, never widen it.
3. Under the journal lock, the book is re-read and re-planned, and the full
   spending bound is **reserved** before dispatch. The approval is rechecked afterwards.
   Re-admission is separate from `max_total_msat`: on nodes supporting it,
   a contact send reserves the remaining node contact allowance, capped by
   the node's remaining total; a room reserves the remaining node total.
   Without a node contact allowance, a one-time confirmation bounds admission
   separately from the message, so both amounts are reserved. Without either,
   the app asks for confirmation before dispatch.
   A wider node grant can therefore make a send refuse under a lower local
   daily or contact limit even when the displayed message price fits. Narrow
   the node grant to match the intended local allowance; editing the app's
   numbers alone does not change the node grant.
4. Outcome: settled to the node's reported message **plus re-admission** amount on success; **released**
   only on refusals before any payment (401/403, `price_cap_exceeded`, approval
   changed before dispatch); **kept at the full reserved bound** when the outcome is unknown
   (transport loss, 5xx, unresolved room). A crash between reserve and dispatch
   also keeps the reservation counted. Before settlement, the reported total
   is saved in the spend journal. If the book write fails, another spend stays
   blocked across restart. Reconciliation writes that total to the existing
   reservation before clearing the journal, without dispatching again or
   relying on message history that omits admission. Repeating this recovery
   does not count the payment twice.

A 401/403 on a money route ends the budget approval as well as the window.

## Not in this slice

Files, invoices and direct (keysend) payments keep the ten-minute window and
are not counted in the app's budgets (a G1 node still debits them against its
grant). Free starter credits and earning back from recipients are follow-ups.

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
  - `grant::tests` (4) and `control_act_tests` G1 (7) against a fake G1 node:
    the ask carries the budget and per-contact proposal, and the approval takes
    the node's ceiling and expiry; a window never outlives the grant;
    per-call, total and recipient refused before any request; a revoked or
    expired grant closes everything; each `budget_exceeded` reason releases the
    reservation and clears the journal; an unreadable grant opens nothing; a
    `spend` token without a live grant asks again.
- `vitest`: `tests/control-budget.test.tsx` (13) — approve once then send twice
  with no prompt, first contact asks once with the budget in the recipient's
  price, exhausted explains and raises, a used-up total is a new approval, tally
  and pause-all in the context panel, lower a budget from the panel, host budget
  refusals are composer notes (not failed sends), G1 grant refusals are too and
  `grant_ended` re-reads the spend state, the node grant line in the Budget
  panel, pay still uses the window,
  `budgetStand` rules, and the sample source's budget semantics.

Screens (`docs/control-center/`, sample data): `40-budget-approve`,
`40-budget-waiting`, `40-budget-auto-send`, `40-budget-first-contact`,
`40-budget-exhausted`, `40-budget-tally`, `40-budget-paused`, `40-budget-phone`.
