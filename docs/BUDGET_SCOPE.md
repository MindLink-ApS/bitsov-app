# App all-in payment budget

B2 caps **app payment principal plus maximum routing fees in a rolling 24 hours**: automatic and manual-window messages, room sends, files, app invoice payments and keysend, including admission. This is a conservative allowance, not an exact wallet-debit total. Channel operations, on-chain transfers/fees, owner-direct CLI/API commands and background workers remain outside this app limit.

Before paid dispatch, each action must fit the saved daily book, applicable contact/room limits and the node's finite grant. Automatic messages need a live approval; files and direct payments need the manual window. Files are checked before upload and again before paid dispatch. A validated first-contact quote containing an explicit routing-fee field identifies the all-in cap contract for the current node session. These nodes reserve the confirmed all-in cap. Legacy or unverified nodes retain the full enforceable recipient allowance for possible re-admission. The observation resets on node restart. Approval never bypasses a budget.

## Prices and routing ceilings

The app's ordinary per-payment routing allowance is `min(max(5000 msat, floor(principal / 100)), 10000 msat)` (zero for zero principal). Message, file and payment requests carry an explicit caller routing limit; the node may tighten it. A room's total and per-recipient caps include a separate allowance for each paid member. The node enforces the all-in caps even if its configured policy or a recipient's price changes.

First-contact quotes are authoritative: `total_msat = admission_msat + message_msat + max_routing_fee_msat`. The fee field is the aggregate allowance for admission and message. That exact total is displayed and passed to the independent owner approval and the compose cap. It is not passed as a per-payment fee limit. Signed introduction cards contain principal prices; their displayed all-in figures are estimates until the node supplies the fresh first-contact quote.

Every composer shows the total and an explicit fee ceiling, for example “up to 5 sats network fee”. Send/file receipts include admission and the aggregate fee allowance. Historical node message records expose principal only and are labelled accordingly; the app does not invent historical fees or add fee ceilings to wallet balances or received amounts.

## Settlement and recovery

Successful replies replace the reservation with reported principal, reported admission and `max_routing_fee_msat`. Missing fee fields preserve the approved allowance; missing never means zero. Exact canonical direct-payment hashes are recorded atomically with accounting, so a replay never charges the daily book again. Identities survive restart, ledger compaction and expiry. Separate keysend hashes and new messages remain independent.

Unknown results retain the reservation and journal, including beyond 24 hours. Reconciliation never redispatches. Direct-payment history exposes principal but not its fee allowance: new all-in journals conservatively settle the full confirmed allowance once on an exact outgoing terminal payment. Confirmed failures settle to zero. Old journals retain their original accounting semantics.

Existing budget numbers are not increased. Legacy book entries retain their recorded amounts; missing historical fees or payment identities cannot be reconstructed. Pending reservations and the once-only payment map remain intact. The user's approval remains memory-only and ends on restart.

**G1 is a separate finite all-in node grant.** It has a remaining balance, per-call/recipient restrictions and an expiry; it does not refill when B2 entries age out. Renewing a grant does not reset the app book.

APP-ALLIN is tested against genome `67f0bcc3df3bd94d6b7ea386410797693526fc27` (#99). This does not update the packaged sidecar release or establish real-sats readiness.
