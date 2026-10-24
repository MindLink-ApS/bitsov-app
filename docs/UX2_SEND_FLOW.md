# Send-flow audit batch 2

Scope: audit items 2–6 on `ui/ux1-dad-blockers`. Item 1's per-message cap decision remains open; approval amounts, signed consent, and biometric prompt text are unchanged.

## Delivery contract

Verified against BitSov-bitsov main (`a745318ecfaff7ddb55df6e0fa6472c14c7b2e47`):

- The [public API module](https://github.com/MindLink-ApS/BitSov-bitsov/blob/a745318ecfaff7ddb55df6e0fa6472c14c7b2e47/crates/konsensus-api/src/lib.rs) documents `GET /api/v1/ws` and mounts the same WS routes behind the encrypted remote router. The app already bridges that connection through its authenticated loopback proxy.
- The [session handler](https://github.com/MindLink-ApS/BitSov-bitsov/blob/a745318ecfaff7ddb55df6e0fa6472c14c7b2e47/crates/konsensus-node/src/session_handler.rs) logs “message delivery confirmed” and broadcasts `{"type":"delivery_status","message_id":"…","status":"delivered","reason":null}`. It identifies the message, not the operation.
- [Operation reads](https://github.com/MindLink-ApS/BitSov-bitsov/blob/a745318ecfaff7ddb55df6e0fa6472c14c7b2e47/crates/konsensus-api/src/handlers/messages/operations.rs) return the compose response shape. `accepted: true` / `state: "acked"` proves recipient acknowledgement. `delivered: true` alone indicates a transport write and must not produce a delivery tick.
- [Message history](https://github.com/MindLink-ApS/BitSov-bitsov/blob/a745318ecfaff7ddb55df6e0fa6472c14c7b2e47/crates/konsensus-api/src/handlers/messages/query.rs) does not expose operation delivery status. Reloading a thread cannot recover a lost acknowledgement event.

The app now follows successful compose receipts with a read-only operation lookup, binding both operation ID and message ID. One initial check closes the receipt/subscription race; disconnected streams receive additional checks every five seconds, with a catch-up check on reconnect. Work is capped at 12 reads and 60 seconds per message and 32 tracked messages. A WS terminal event cancels its check; late replies cannot overwrite it. Failure or timeout retains the last known delivery state. No check resends, abandons, pays, or changes the spend journal. Older receipts without an operation ID retain WS-only delivery.

## Composer

A fresh grant covering the recipient and displayed price suppresses the Touch ID banner and shows Send with the remaining grant/budget. Reopening an expired local window uses the existing host grant request and identity-bound continuation. A newer verified envelope read clears a remembered envelope refusal; older reads cannot clear it. Explicit pause, stale reads, and host payment checks remain in force.

Empty or whitespace drafts disable the primary action and show the same localized hint. The empty footer shows no payment result; settlement amounts remain on their bubbles. Details uses a full-width native button with a 44 px minimum height, visible focus, expanded state, and a controlled content region.

Regression coverage: `ux2-send-flow.test.tsx`, `delivery-poll.test.ts`, the host's `delivery_lookup_is_read_only_and_requires_matching_node_evidence`, and the EN/DA browser checks in `a11y/touch-details.spec.ts`.
