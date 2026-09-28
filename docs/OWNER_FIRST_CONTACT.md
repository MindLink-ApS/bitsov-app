# First-contact owner approval

Genome main `5e1b4cf` (#92/#94) provides `konsensus approve first-contact`
and `konsensus approve gift` through the independent owner's local control
socket. The app only displays commands; it never runs the CLI, opens that
socket, or holds an owner credential. Paired tokens cannot approve contacts
or gifts through the owner HTTP routes.

After the overall message budget is approved, the owner chooses a contact
budget and submits the first draft. The app holds the draft and displays one
copyable command with `recipient`, `max_total_msat`, `contact_budget_msat`,
`grant_op_id` and `client_id` filled in from that contact and the live budget
grant. This is the single owner approval for that contact budget.

Run the displayed command in the owner's terminal from the node's data
directory (`konsensus.toml`), with the node started using `--owner-control`.
The CLI line can instead take `--config '/path/to/konsensus.toml'`. Every
interpolated value is POSIX-shell quoted, including amounts and the gift code.
The app does not supply or discover the owner's config path.

The first-contact command contains this CLI invocation:

```sh
konsensus approve first-contact --client '<id>' --op '<grant_op_id>' --to '<recipient>' --max-msat '<N>' --contact-budget-msat '<M>'
```

A small shell wrapper publishes a public readiness receipt only after the CLI
exits successfully. This remains necessary: `/pair/grant` cannot report a
single-use contact approval, and an existing per-recipient budget does not
prove a fresh approval. The wrapper starts a conservative two-minute expiry
before calling the CLI, bounded by the underlying budget grant's expiry. A
slow command can leave an expired receipt, which fails closed.

The receipt directory is created with mode `0700` on Unix regardless of umask.
The wrapper uses `umask 077`, opens `receipt.part` with noclobber before the
CLI runs, refuses existing partial files or symlinks, and publishes by rename.
Cancel and request approval again if a partial file already exists. CLI output
remains visible in the owner's terminal; it is not parsed as an API contract.

Gift approval needs no file wrapper:

```sh
konsensus approve gift --intro '<id>' --newcomer '<key>' --hash '<payment_hash>' --gift-msat '<N>' --fee-max-msat '<F>' --code '012345'
```

The six-digit comparison code keeps leading zeros. Existing `/sponsor` reads
continue tracking the frozen candidate until funded or withdrawn.

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
read route for single-use approvals could remove the receipt without mistaking
a persisted contact budget for a fresh approval.

The real-window UI-E2E labels its independent node A operator step **FIXTURE**
and executes the exact displayed command in a separate subprocess, from node A's
data directory with the tested genome CLI on PATH. This step mints no token. Production
code never performs that step. Host regression tests reject paired tokens on
the owner route, require an independent owner fixture before sending, and
cover cancellation, pause, stale grants, mismatched/expired receipts, and a
receipt without an actual node grant.
