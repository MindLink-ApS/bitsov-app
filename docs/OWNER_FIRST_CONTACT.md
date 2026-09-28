# First-contact owner approval

Genome main (`15deed5`, contract from #85) reserves
`POST /api/v1/pair/first-contact-grant` for independent node owner authority.
A paired app token or its stored spend grant cannot authorize this route.
The app rejects attempts to call it through its authenticated API client.
Genome has no owner-control first-contact operation in this version.

After the overall message budget is approved, the owner chooses a contact
budget and submits the first draft. The app holds the draft and displays one
copyable command with `recipient`, `max_total_msat`, `contact_budget_msat`,
`grant_op_id` and `client_id` filled in from that contact and the live budget
grant. This is the single owner approval for that contact budget.

Run the displayed command in the local node's terminal, where
`BITSOV_OWNER_TOKEN` contains an independently obtained node owner credential.
Do not use the app's paired token or spend grant. The command reads that
credential on the node side, sends its header through curl's standard input,
and writes only the public response to the app's private temporary receipt
file. It disables shell tracing, follows no redirects, uses restrictive file
permissions and publishes the receipt by rename after a successful response.
On Unix, the receipt directory is created with mode `0700` regardless of a
permissive umask. The command keeps `umask 077` and opens `receipt.part` with
shell noclobber before curl runs; an existing file or symlink causes refusal
without writing a response or touching the symlink target. Cancel and request
approval again if a partial file already exists.
The credential never enters the app, renderer, command text or receipt.

The app polls the public receipt and the paired client's budget grant once per
second. Genome main has no first-contact status GET; `/pair/grant` describes
the budget, not the single-use contact grant. The receipt is therefore a
readiness signal, **not authority**. The host checks its recipient, cap and
expiry, binds the request to the budget's client and operation IDs, and checks
local pause/approval fences. The node still independently validates and
consumes its actual contact grant when the app composes the held message.
A forged receipt cannot authorize spending that the node has not approved.

Cancel stops the wait and discards the receipt directory. Editing the draft,
changing contact, budget or mode, pausing, or replacing the budget grant also
prevents the old request from sending. Cancel cannot revoke an approval already
issued at the node; its single-use first-contact grant expires within two
minutes. An expired or changed quote still requires a fresh user action; the
app does not silently raise the cap or retry a spend.

This handoff supports the existing same-host, loopback node arrangement. A
remote terminal without access to the receipt path cannot complete it. A future
genome owner-control operation can replace the HTTP/receipt handoff without
putting owner credentials into the app.

The real-window UI-E2E labels its independent node A operator step **FIXTURE**
and executes the exact displayed command in a separate subprocess. Production
code never performs that step. Host regression tests reject paired tokens on
the owner route, require an independent owner fixture before sending, and
cover cancellation, pause, stale grants, mismatched/expired receipts, and a
receipt without an actual node grant.
