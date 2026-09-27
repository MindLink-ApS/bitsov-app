# O1 node follow-ups: N1 energy read, N2 membrane events

**Status:** built in genome PR #82 (`feat/n1-n2-energy-membrane`) and consumed
by this app when `/status` advertises `energy_v1` / `membrane_v1`. See
`docs/CONTROL_CENTER_ORGANISM.md` (O1 v2). The shipped shapes are in the
genome's `docs/v2/API_ORGANISM_READS.md`. Where they differ from the sketch
below, the shipped shapes are authoritative: windows are `1h|24h|7d`, the read is
`?since=&limit=`, and refusals from `replay` onward name the verified sender.
The host commands are not in the AI broker schema.

For later, in the genome (`crates/konsensus-api`, `msg_handler.rs`). O1 v1 in the
app works without them and says so on screen. These two turn that into O1 v2.
Spec: `MindLink-Private/pm/projects/bitsov/O1-ORGANISM-VIEW-SPEC.md`.

Doctrine for both: local reads only, read scope, never gossiped, no network map.
Nothing is added to chain.

## N1 — `GET /api/v1/energy?window=1h|24h`

**Why:** Metabolism can only sum the tracks the app has loaded ("in N tracks read
here"). `GET /payments` has no counterparty, and summing `/messages` per peer
misses tracks the owner never opened.

**Shape** (read scope, local):

```json
{ "window": "24h", "as_of_ms": 0,
  "buckets": [ { "start_ms": 0, "in_msat": 0, "out_msat": 0 } ],
  "counterparties": [ { "counterparty": "<hex node id | room uuid>", "in_msat": 0, "out_msat": 0, "acts": 0 } ] }
```

- `buckets`: 24 hourly buckets for `24h`. An hour with no record is **omitted**,
  not zero, so the app draws a gap and does not interpolate.
- Counts settled message payments only, summed from the node's own message store.
  No preimage, payment hash or fee breakdown.
- Carries the existing `As-Of`/`Stale` headers like the other reads.

**Done when:** the app shows 24 bars from `buckets`, node-wide totals, and
removes the "tracks read here" caveat. Host command `energy_read`, allowlisted in
the broker schema.

## N2 — membrane `/ws` event + `GET /api/v1/membrane?since=`

**Why:** inbound refusals (`message.rejected`) exist only in the audit log (free
text) and a Prometheus counter, so the app cannot see them. The app shows
"Inbound refusals are not visible yet (node N2)".

**Event**, emitted where `msg_handler.rs` writes the audit entry:

```json
{ "type": "membrane", "verdict": "admitted" | "refused", "code": "...", "kind": 0,
  "required_msat": 0, "paid_msat": 0, "at": 0, "sender": "<hex, admitted only>" }
```

- `code` maps from `GateRejection`: `insufficient_payment`, `not_settled`,
  `proof_reused`, `invite_only`, `replay`, `bad_signature`, `stale`.
- `sender` **only** on admission, after the signature is verified. A refusal
  carries no identity, because it is unverified.
- Pre-handshake doorway (rate limit, cookie, IP guard): an aggregate count only,
  if exposed at all. Never an IP or an id.

**Read:** `GET /api/v1/membrane?since=<ms>` returns the same entries from a
bounded in-memory ring buffer (about 500). It is not persisted beyond that, has
no export route, and needs read scope.

**Done when:** the host forwards `membrane` events as `node-live`, and the Body
panel's Membrane organ shows inbound refusals by reason with the missing price
("refused · unpaid · needed 20 sat"). The app's own ring buffer
(`MEMBRANE_KEEP`) then holds node events alongside outbound refusals.

## Not here

N3 (evidence store, `POST /evidence`) comes after O1 v2. G1 read-only grant state
is already consumed through `BudgetView.node_grant` (PR #45).
