# Control center: acting from the track (slice B)

Code: `src-tauri/src/act.rs` (rules), the action commands in `src-tauri/src/main.rs`,
and `src/control/Shell.tsx` (composer, approval, receipts). Node contract: rc7 `958e399`
for the action routes; #76/#77 (`56c0ee0`) for pairing and elevation.

## Spend authority: the app can only narrow it

| Node | What the app token can do | What the owner's one tap does |
|---|---|---|
| **rc7 sidecar** (bundled today) | Everything. rc7 tokens carry no scopes. | Opens the app's own 10-minute spend window. Nothing on the node enforces it. The UI says so. |
| **#77, paired, owner-run** (`--owner-control`) | `read + receive` | `POST /pair/elevation-request {scopes:["spend"]}`. The UI shows the node's `owner_action` verbatim (`konsensus grant --op …`). The owner types the phrase printed at the node's terminal. Once `/pair/elevation/:op` says `granted`, the host re-issues the token, and the window opens only if that token now carries `spend`. |
| **#77, paired, sidecar** | `read + receive`, and never more | The request is created, but the node says it cannot be granted in this deployment. The UI shows that and keeps sending off. Receiving still works. |

- **In memory only.** The window lives in host memory (`NodeState::spend`) for 10 minutes. It is never written to disk and ends when the app quits.
- **Pairing record.** The pairing record stores only the scopes the ceremony gave: never `spend`. A test asserts nothing about a grant reaches the app's store.
- **Grant lifetime.** The node's own grant lasts 30 days (`SPEND_GRANT_TTL_SECS`) until the owner revokes it. That is the owner's grant on their node, not something the app stores. The app uses it only inside a 10-minute window per approval.
- **No self-approval.** The app never touches `control.sock` and has no path that approves its own request. That separation is the node's whole mechanism (`pairing_routes.rs`).
- **Checked before any request.** Every spending or node-changing command checks the window *before* making a request.
- **Refusals.** A 403 on a spend route locks the window (`spend_refused`). A 403 on an admin route (invites, file upload) returns `owner_only` and leaves the window alone.

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

**Receipts.** Receipts carry amount, status and time. Preimages and payment hashes are dropped in the host.

**Delivery status.** The status starts from the compose reply: `sent` or `queued`. It then follows `/ws` `delivery_status`: `delivered`, or `rejected` with the recipient node's own reason.

## Not in this slice

Channel open/close, on-chain send, adding a peer by address, creating rooms and room membership changes (membership is local-only; see the product gates), and payment history.

## Tests

- **`cargo test`**
  - `act::tests`: 13 tests covering the window, bodies, bolt11, room cost, receipts, invites and files.
  - `control_act_tests`: 13 tests against a loopback fake node, including:
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
- **`vitest`**
  - `tests/control-act.test.tsx` covers the UI flows: approve, send, delivered, rejected, expired, failure record, first contact, room, pay, request, file, invite, unavailable.
  - It also covers the sample source.
