# Signet starter balance

The wallet's “Get your starter balance” entry is disabled by default. Build
with `VITE_STARTER_BALANCE=1` to enable discovery. It appears only when the
node reports `network: "signet"`, advertises `starter_channel_request_v1`, and
the authenticated starter GET returns `hub_configured: true`. Mainnet and
unknown networks remain hidden. Opening the entry shows a dedicated screen
with one request action; Back returns to the wallet.

Requires node main `aebaa5f9` (#373), following
`docs/design/N-M7A-STARTER-REQUEST.md` (Hub discovery and no-approval ruling)
and `docs/ops/starter-hub.md` in BitSov-bitsov. Before a request, GET returns
200 `not_requested`; a 404 is not an empty state. The optional hub alias is
display text only. No node config, funding amount or fee is chosen by the app.

The host uses the paired receive session to POST only `{request_id}`. There
is no owner approval or spend-window action. The renderer saves a UUIDv4 in
device storage, keyed by node identity, before sending it. Replays after a
timeout or app restart use that UUID. Storage failure prevents dispatch.
Keep device storage intact while a request is unresolved.

The app polls every five seconds while the wallet is mounted. Node-scheduled
retries preserve the original request lineage; delivery exhaustion offers
same-ID replay. Only a terminal refusal offers an explicit fresh request.
An older terminal response cannot clear a newer uncertain request ID.

“Ready” requires both `state: "ready"` and `verified: true`. Any displayed
amount is a historical, node-confirmed receipt. Current wallet spendability
continues to come from the node's wallet breakdown, since a historical starter
receipt does not prove a channel remains usable. Copy is available in English
and Danish and uses the app's space-grouped amount formatter.
