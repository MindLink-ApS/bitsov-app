# Control center: acting from the track (slice B)

Code: `src-tauri/src/act.rs` (rules), the action commands in `src-tauri/src/main.rs`,
and `src/control/Shell.tsx` (composer, approval, receipts). Bundled node: rc11 `834968b`; retained rc7 compatibility
for the action routes; #76/#77 (`56c0ee0`) for pairing and elevation.

## Spend authority: the app can only narrow it

| Node | What the app token can do | What the owner's one tap does |
|---|---|---|
| **rc7 fallback** (older nodes) | Everything. rc7 tokens carry no scopes. | Opens the app's own 10-minute spend window. Nothing on the node enforces it. The UI says so. |
| **#77, paired, owner-run** (`--owner-control`) | `read + receive` | `POST /pair/elevation-request {scopes:["spend"]}`. The UI shows the node's `owner_action` verbatim (`konsensus grant --op …`). The owner types the phrase printed at the node's terminal. Once `/pair/elevation/:op` says `granted`, the host re-issues the token, and the window opens only if that token now carries `spend`. |
| **#77, paired, sidecar** | `read + receive`, and never more | The request is created, but the node says it cannot be granted in this deployment. The UI shows that and keeps sending off. Receiving still works. |

- **In memory only.** The window lives in host memory (`NodeState::spend`) for 10 minutes. It is never written to disk and ends when the app quits.
- **Pairing record.** The pairing record stores only the scopes the ceremony gave: never `spend`. A test asserts nothing about a grant reaches the app's store.
- **Grant lifetime.** The node's own grant lasts 30 days (`SPEND_GRANT_TTL_SECS`) until the owner revokes it. That is the owner's grant on their node, not something the app stores. The app uses it only inside a 10-minute window per approval.
- **No self-approval.** The app never touches `control.sock` and has no path that approves its own request. That separation is the node's whole mechanism (`pairing_routes.rs`).
- **Checked before any request.** Every spending or node-changing command checks the window *before* making a request.
- **Refusals.** A 403 on a spend route locks the window (`spend_refused`). A 403 on an admin route (invites, file upload) returns `owner_only` and leaves the window alone.
- **Late replies.** Polls are bound to the pending operation, generation and deadline. Locking invalidates the generation; neither a late grant nor a late request response can reopen it. Sending rechecks the generation after token refresh and before dispatch.

## Quote and ambiguity fences

Every message and file send requires the node's authenticated `/status` to
advertise `paid_send_caps_v1`; rooms also require `room_terminal_outcomes_v1`.
A missing, malformed, or unreadable capability list fails closed with
`price_cap_unavailable`, before a message POST or file upload. An older rc7
node lacks these capabilities, so variable-price actions remain unavailable
until the node is upgraded; opening the app's owner window cannot bypass this.

Message and file POSTs send the displayed ceiling as `max_total_msat`. Rooms
also send `max_recipient_msat` from the displayed member quote, without replacing
those ceilings with a later quote. The node refuses HTTP 409 with code
`price_cap_exceeded` before invoice/payment dispatch if prices or membership no
longer fit. The app can safely clear that refusal's pending journal and ask for
a fresh quote. Invoice and keysend commands retain their explicit fixed-amount
checks. Caps cover recipient principal; Lightning routing fees remain separate.
Capped first contact refuses unquoted admission before any payment; admission
must be established at the node before this message can be sent.

Room replies must contain one unique result per confirmed member, with bounded
amounts and a consistent aggregate. Missing, foreign, duplicate, malformed,
over-budget, `unknown`, or `pending` rows retain the durable ambiguity fence.
An unresolved member reserves its entire attempted principal in `amount_msat`;
that amount counts against both member and total caps and is not a settled receipt. A canonical
message ID proves only one member and can never reconcile the whole room.
All `settled`/`refused` rows can release the fence, but refused members or settled
payments without a stored message return `room_partial`, keep the draft and
explicitly warn against resending the whole room. Lost/unknown room replies
remain blocked because the node has no aggregate reconciliation endpoint.

Money requests have a 120-second timeout and are never automatically replayed,
including after 401. Before dispatch, a private `app-spend/spend-pending.json`
record is synced to disk, under an OS file lock. It contains a node ID, request
hash, ceiling and any returned node receipt ID, **not** the body, plaintext,
invoice, preimage, token, key or spending approval. The lock prevents concurrent
dispatch; crashes release the OS lock but leave the ambiguity record intact.
Transport loss, interrupted/malformed replies and non-authentication HTTP errors
retain that record and appear as **Outcome unknown / pending**, not "not sent".
This deliberately includes 4xx handler errors: some compose paths can pay before
reporting a later failure. Only pre-handler 401/403 refusals clear it immediately.

`Check pending result` is read-only. It matches a node-issued payment hash in
`/payments?limit=100` (outgoing, terminal) or a message ID in `/messages` (same
sender and recipient). It never dispatches a replacement. Missing, unrelated,
nonterminal, over-budget or wrong-identity evidence leaves spending blocked.
If the original reply was completely lost and supplied no ID, the current API
cannot safely correlate it: automatic reconciliation remains unavailable and
the owner must inspect the node. There is no UI clear/force-retry escape hatch.
This is an intentional fail-closed limitation, not exactly-once delivery.

## Actions

| Action | Route(s) | Needs the window | Cost shown before |
|---|---|---|---|
| Message / paid first contact | `POST /messages/compose` | yes | Peer's advertised price, or your own as an estimate (floored at 1 sat). An empty thread also notes first-contact admission, capped by the node at 100 sats. |
| Room message | `POST /messages/compose` `is_room` | yes | The sum of each member's own price (`room_quote`). Refused unless every member is a connected peer. |
| Request (invoice) | `POST /payments/invoice` | no, receiving | Amount you receive |
| Pay invoice | `POST /payments/pay` | yes | Amount read from the invoice's prefix by the host. Amountless or mismatched invoices are refused before the request. |
| Pay direct (keysend) | `POST /payments/keysend` | yes | The amount entered, plus routing fee |
| Invite create / accept | `POST /invites`, `POST /invites/accept` | yes (admin) | — |
| File | `POST /files` then `POST /files/:id/send` | yes | Node's `KIND_FILE_REF` price. Files are capped at 1.4 MB because of axum's 2 MB body limit. |

**Receipts.** Renderer receipts carry amount, status and time, never preimages
or payment hashes. A node-issued payment hash may be retained only in the host's
pending journal for reconciliation; preimages are never persisted.

**Delivery status.** The status starts from the compose reply: `sent` or `queued`. It then follows `/ws` `delivery_status`: `delivered`, or `rejected` with the recipient node's own reason.

## Not in this slice

Channel open/close, on-chain send, adding a peer by address, creating rooms and room membership changes (membership is local-only; see the product gates), and payment history.

## Tests

- **`cargo test`**
  - `act::tests`: window generations/deadlines, bodies, bolt11, room cost, receipts, invites and files.
  - `spend_journal::tests`: durable retry blocking, concurrent locks, inherited descriptors, and exact-reference reconciliation.
  - `control_act_tests`: tests against a loopback fake node, including:
    - refused before any request;
    - rc7 app lock;
    - expired window;
    - 403 lock;
    - node error text;
    - room blocked;
    - pay amount;
    - file two-step;
    - invite owner-only;
    - the paired elevation → owner grant → re-issued token path;
    - sidecar unavailable and lapsed request.
    - lock during an in-flight elevation poll;
    - a 2,000 to 999,000 msat quote increase and an over-ceiling receipt;
    - file re-quote after upload;
    - spend timeout override and no redispatch after timeout/restart;
    - pending payment reconciliation without another send.
- **`vitest`**
  - `tests/control-act.test.tsx` covers the UI flows: approve, send, delivered, rejected, expired, failure record, first contact, room, pay, request, file, invite, unavailable.
  - It also covers the sample source, confirmed ceilings on IPC, and unknown outcomes without a misleading "not sent" label.

## Review regression fixes

Changing tracks clears selected files and payment fields alongside the text
draft, so an empty file chooser cannot send the previous recipient's file.
The New track renders the shared spending status, owner grant command, errors,
lock and pending-result controls, including when no conversation exists yet.

Late action completion only clears the composer revision that was submitted.
Edits, replacement files, mode changes, and track navigation (including returning
to the same peer) preserve the newer input while the original action finishes.
