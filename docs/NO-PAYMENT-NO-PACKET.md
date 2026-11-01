# No payment, no service — a layer-by-layer audit

The doctrine is officially worded **"No payment, no service"** (owner
decision, section 9). "No payment, no packet" stays as the original slogan;
it was reframed because a packet must arrive before anyone can tell whether
it is paid, so the rule binds the service a node gives, not each packet.

Status: analysis and design proposal. Docs only. Draft; needs two independent reviews and
an owner decision before any ticket below is started. Hardened after an
independent review (round 1): quote oracle, signed receipts, push fan-out
bound, block-boundary media cases, ticket A-6, a restated pre-payment bound,
and a merged harness (section 7). The wording "No payment, no service" is
**decided by the owner** (section 9, item 1); items 2 to 4 are still open.

## 1. The doctrine as first stated

> No payment, no packet.

This is the original slogan. The official wording is "No payment, no
service" (section 4, decided by the owner).

The owner's intent: ideally all traffic into and out of a BitSov node is paid
in sats, and AI or MCP clients that talk to the node use sats as their token.

This document checks that sentence against the code on `main` and against the
network stack the node sits on. For each layer it answers five questions:

1. What traffic exists?
2. Who sends it?
3. Is it paid today? (yes / no / partly, with file references)
4. Can it be paid? (**holds** / **holds with change** / **impossible**)
5. Why?

The short answer: the sentence cannot hold literally. A packet must arrive
before anyone can tell whether it carries a payment, and the payment rail
itself (Lightning, Bitcoin, the transport under them) cannot be paid with
itself. What *can* hold, end to end, is a narrower rule about **processing,
delivery and forwarding** of peer-to-peer application traffic. Section 4
states that rule precisely. Sections 5 to 7 list what is free today, what to
change, and how to test it.

Scope note: this repository is the app (SolidJS renderer plus Tauri/Rust
host). Node behaviour is described from the node contract the app relies on
(the genome capabilities the app reads from `/status`, its refusal codes and
docs in this repo). Where a claim is about node internals the app cannot see,
it is marked *node-side* and should be confirmed in the node repository.

## 2. Vocabulary

- **Cell.** The owner's node plus the owner's own apps and devices paired to
  it. Owner decision M6: "the node is the cell" (`docs/CALLS.md`,
  `src/control/callFlags.ts`).
- **Peer.** Any other node. Peer-to-peer application traffic is what crosses
  between two cells.
- **Paid kind.** A message kind sent through `POST /messages/compose` that
  the sending node pays for over Lightning before the receiving node
  delivers it (chat, file ref 200, call signals 400–403, call block 404,
  page request 500; `src-tauri/src/act.rs`, `src-tauri/src/porch.rs`).
- **Pre-payment work.** Anything the receiving node does with a packet before
  it knows a valid payment is attached: parse, decrypt, look up, reply.

## 3. Layer audit

### 3.1 Physical, link, IP routing, NAT

- **Traffic.** Ethernet/Wi-Fi frames, ARP/NDP, IP packets, ICMP, NAT
  mappings, DHCP leases.
- **Sender.** The OS, the router, the ISP. The node process never sees most
  of it.
- **Paid today.** No.
- **Can it be paid.** **Impossible.**
- **Why.** These packets are produced and consumed below the node. The node
  cannot attach or check a payment on an ARP reply or a router's ICMP. Any
  host on a network receives them whether it wants to or not. The doctrine
  must exclude this layer by definition.

### 3.2 DNS

- **Traffic.** OS resolver lookups: for node endpoints named by hostname in
  pairing links, front-door cards and introductions; for the chain backend;
  for any remote model API.
- **Sender.** The OS resolver, on behalf of the host or the node.
- **Paid today.** No. Note that the node pins DNS when it dials an
  introduction or a front door ("verifies the card again, pins its DNS and
  dials unprivileged", `src-tauri/src/app.rs`, K1 introductions block), which
  limits *what* is resolved, not whether it costs sats.
- **Can it be paid.** **Impossible.** It can be *avoided*: endpoints may be
  literal IPs, or Tailscale MagicDNS names that resolve inside the tailnet.
- **Why.** The resolver is an external service with its own protocol. Sats
  cannot flow over it. Reducing DNS is a privacy and availability goal, not a
  payment one.

### 3.3 Transport overlays: Tailscale / WireGuard, Tor

- **Traffic.** WireGuard handshakes and keepalives, DERP relay traffic,
  coordination-server polls (Tailscale); circuit build, cell padding and
  keepalives (Tor, if used).
- **Sender.** The overlay daemon, not the node.
- **Paid today.** No. The app only knows that an endpoint is a tailnet
  address, to explain a failure (`is_tailscale_endpoint` and
  `ConnectionErrorKind::Tailscale` in `src-tauri/src/remote_access.rs`).
- **Can it be paid.** **Impossible.**
- **Why.** Overlay control packets are below the node's application layer
  and are produced by third-party software. A WireGuard keepalive has no
  field for a payment and must be accepted for the tunnel to exist.

### 3.4 Encrypted sessions between nodes (Noise / TLS handshakes)

- **Traffic.** (a) App to own node over the pinned Noise tunnel
  (`Noise_XX_25519_ChaChaPoly_BLAKE2s`, `NOISE_PROTOCOL` in
  `src-tauri/src/remote_access.rs`): XX handshake, encrypted auth request,
  then framed transport (16 KiB plaintext cap, 60 s idle timeout, handshake
  limit `HANDSHAKE_UNAVAILABLE`). (b) Node to node federation session: the
  peer handshake and Hello with capabilities (`porch::PEER_CAPABILITY` shows
  the Hello lists `Custom("porch_read_v1")`).
- **Sender.** (a) The owner's app. (b) Any node that dials ours, including
  one dialed via a front door or introduction (`/front-door/open`,
  `src-tauri/src/app.rs`).
- **Paid today.** (a) No, and it should not be (intra-cell, see 3.8).
  (b) No. The node counts handshakes it refuses before payment under the
  reason `session_before_payment` (`src-tauri/src/control/refusals.rs`,
  shown by `src/control/RefusalCounts.tsx`).
- **Can it be paid.** **Impossible** for the first packets;
  **holds with change** for everything after the session is up.
- **Why: the payment-bootstrap paradox.** To learn that a packet is unpaid,
  the node must receive it, and for an encrypted session it must do at least
  one Diffie-Hellman to read it. To pay a peer you must first be able to talk
  to it to learn its price and identity. So some bounded, unpaid exchange is
  unavoidable. What the doctrine can require is that this exchange is small,
  fixed in cost, and ends in either a paid request or a refusal.

### 3.5 Bitcoin chain sync and Lightning

- **Traffic.** Esplora or Electrum queries for chain data; Lightning peer
  connections (BOLT 8 Noise), gossip (channel and node announcements,
  updates), channel management (open, close, fee updates, pings), HTLC
  updates and onion packets for every payment the node sends, receives or
  forwards.
- **Sender.** The node's wallet and Lightning stack; its channel peers.
- **Paid today.** Partly, in Lightning's own terms: forwarded HTLCs pay
  routing fees (the app bounds them: `max_routing_fee_msat`,
  `block_max_routing_fee_msat`, `docs/CALLS.md`). Chain sync, gossip, pings
  and channel management are unpaid. The node refuses some BitSov-level
  requests about Lightning before payment (`lightning_info_before_payment`,
  `gossip_before_payment`, `invoice_error_before_payment` in
  `src-tauri/src/control/refusals.rs`); those are BitSov wrapper requests,
  not Lightning's own protocol messages.
- **Can it be paid.** **Impossible** for the payment plane itself.
- **Why.** Every sat moves as HTLC and onion packets. Paying for those
  packets would need another payment, recursively. Gossip and channel
  updates are what make routing possible at all. Chain sync talks to an
  external service with its own (fiat or free) terms. The doctrine must
  exempt the payment plane by definition, as it exempts the transport.

### 3.6 Node-to-node application traffic

This is the layer where the doctrine is meant to live. Item by item:

| Traffic | Sender | Paid today | Verdict | Notes and refs |
| --- | --- | --- | --- | --- |
| Admission (first contact / front door) | stranger's node | **Yes**, once, via first-contact grant | holds | `POST /messages/first-contact/quote` is free and stateless; then admission plus first message are paid together (`read_first_contact_quote_with_cap`, `src-tauri/src/app.rs`; `FIRST_CONTACT_CAPABILITY`, `src-tauri/src/grant.rs`). Non-admitted requests are refused as `admission_required`. |
| Front-door open (dial) | own node, at owner's request | No | holds with change | `/front-door/open` makes the node dial the card's endpoint unprivileged; the peer receives a session and Hello before any payment. Covered by 3.4. |
| Chat / file / room messages | sender's node | **Yes** | holds | Every compose goes through `money_post_with` with a node-side debit under the grant (`src-tauri/src/app.rs`; per-payment cap `MESSAGING_PER_CALL_MAX_MSAT`, `src-tauri/src/grant.rs`). |
| Delivery receipts / acks | receiving node | No | holds with change | The app reads delivery state (`messageDelivery` in `src/control/polling.ts`; `PaidUndelivered` in `src-tauri/src/app.rs`). The ack travels back unpaid; the node counts unpaid delivery replies as `delivery_before_payment`. A receipt is part of the paid message (the sender paid for delivery *and* its proof), so it should be bundled, not priced separately. The receipt must be **signed by the receiving node**, so a sender (or a third node) cannot forge delivery state; a receipt for an unpaid message is a free refusal and is **counted**. |
| Call signals 400–403 (offer, answer, ICE/restart, hangup) | each side's node | **Yes**, each signal paid by its sender | holds | `KIND_CALL_OFFER..=KIND_CALL_HANGUP` (`src-tauri/src/act.rs`); `call_signal` (`src-tauri/src/app.rs`). Ringing is covered by the paid offer. A callee who ignores pays nothing (`docs/CALLS.md`, meetings). |
| Call minute blocks 404 | caller's node | **Yes**, 60 s blocks, reservation up front | holds | `KIND_CALL_BLOCK`, `do_call_block` (`src-tauri/src/app.rs`); node contract N1/N3, 10 s grace, hangup `unpaid` (`docs/CALLS.md`). |
| Node-routed media frames | both nodes | **Partly**: covered by minute blocks, not per packet | holds (by block) | Media socket admitted only after block 0 settles (`docs/CALLS.md`, "Media waits for payment"). Per-packet payment would be absurd: 50 frames/s. The block is the unit. Callee's outbound frames ride the caller's minutes. At a block boundary, frames between `paid_until_ms` and the end of the 10 s grace still forward, and a block paid late within grace extends `paid_until_ms` without a gap (T8b, T8c). |
| Call refusals (`call_busy`, `call_not_live`, `call_id_used`) | callee's node | No | holds (refusal is free) | `src-tauri/src/app.rs` near the kind 400–403 refusal mapping. A proven `call_not_live` closes the admission for free (`docs/M6-CALL-ADMISSION.md`). |
| Porch quote `/browse/quote` | reader's node to owner's node | **No** (free by design) | holds with change (bound it) | `read_porch_quote` (`src-tauri/src/app.rs`): "Free availability and recipient price". Gated on admission (`admission_required` maps to `porch_knock_first`). **Quote oracle:** the reply's `status` (`NotFound` / `Forbidden` / `Ok`) and per-path price let an admitted peer enumerate paths for free; NotFound and Forbidden must look the same for paths outside the manifest, and quotes are rate-limited per peer. |
| Porch fetch `/browse/fetch` (kind 500) | reader's node | **Yes**, page price, 1 sat floor | holds | `porch_post`, `porch::read_price`, `MIN_READ_MSAT` (`src-tauri/src/porch.rs`). Reply bound to the payment. |
| Card read `/front-door.json` over porch | reader's node | **Yes** (it is a porch path) | holds | `CARD_PATH` is a valid `porch_path`, so it is fetched and paid like a page (`src-tauri/src/porch.rs`). |
| Front-door card carried as QR / link | humans | No network traffic | n/a | `front_door::read` is local: "no request, no payment" (`src-tauri/src/front_door.rs`). |
| Cached cards `/browse/cards` | own node to own app | No | exempt (intra-cell) | `read_porch_cards`, `porch::cached_cards`: reads the node's local cache, no peer traffic. |
| Price adverts / price tables | peers | No | holds with change | `/pricing/peers` and adverts are exchanged before any payment (counted as `price_before_payment`). Must stay free (you cannot pay without a price) but must be bounded. |
| Peer exchange | peers | No | holds with change | Counted as `peer_exchange_before_payment`. Either remove for strangers or bound. |
| Rate-limit / busy / refusal replies | receiving node | No | holds (free by definition) | Refusing must never cost the refuser more than the request cost the sender. |

### 3.7 Rate-limit, busy and refusal replies

A refusal is a packet. It cannot be paid by the refused party (that is why it
was refused) and charging the refuser is pointless. The doctrine must say
plainly: **the refusal itself is free**, and it must be the cheapest reply the
node can make. The node already measures this: eight pre-payment refusal
reasons, aggregated hourly (`src-tauri/src/control/refusals.rs`). That
counter is the right place to also count bytes and CPU spent before refusal
(ticket N-3).

### 3.8 Intra-cell traffic

- **Traffic.** App to own node: the control API through the loopback proxy
  or the Noise tunnel (`src-tauri/src/remote_access.rs`), the `/ws` live
  socket, the call media socket (`src-tauri/src/control/media.rs`), status
  and background polling (`/status`, `nodeOverview`, `wallet`, `spendStatus`,
  `budgetStatus` and others, `src/control/polling.ts`), pairing and token
  refresh (`docs/ONBOARDING_PAIRING.md`), owner approvals, grant reads
  (`GET /pair/grant`, `src-tauri/src/grant.rs`), first-run funding polls.
- **Sender.** The owner's own app and devices.
- **Paid today.** No.
- **Can it be paid.** **Impossible to be meaningful**, and should be
  **exempt by doctrine**.
- **Why.** The cell is one economic actor. Paying yourself moves sats from
  one pocket to the other and adds Lightning load for nothing. Worse,
  pricing pairing or the grant read would block the owner from ever opening
  a spending session (a second bootstrap paradox). The protection the cell
  needs is authentication and authority (pinned Noise, paired tokens,
  grants, Touch ID / owner approvals), not payment.

Edge: a *second device* or a *paired client with a spend grant* is still in
the cell. Its spending is bounded by the grant, not by per-request fees.

### 3.9 STUN / TURN and NAT traversal

- **Traffic.** STUN binding requests; TURN allocations and relayed media.
- **Sender.** The app's WebRTC stack, only in the pre-M6 lab profile.
- **Paid today.** No.
- **Status on main.** In the M6 profile (default) calls are node-routed:
  `nodeRoutedConnection.ts` "contacts no STUN or TURN server"
  (`docs/CALLS.md`, `src/control/nodeRoutedConnection.ts`). STUN is only
  used when `VITE_CALL_MEDIA=webrtc` (`stunServer`, `iceServers` in
  `src/control/call.ts`). The default STUN URL comes from owner-only
  `/status` (the node's own responder or one its owner configured); the app
  ships none (`src/control/prefs.ts`, charter gate G2).
- **Can it be paid.** **Impossible** for third-party STUN/TURN;
  **holds with change** for the node's own STUN responder (restrict it to
  the cell or to admitted peers).
- **Why.** STUN and TURN are standard protocols with no payment field.
  M6 already removed the dependency for calls, which is the best answer.

### 3.10 Push notifications and updates

- **Traffic.** Push (APNs / FCM) would wake a phone app; app and node
  updates fetch signed binaries.
- **Sender.** Apple / Google push services; the release host.
- **Paid today.** No. On `main` the app has no push integration and no
  in-app updater in the Rust host or Tauri config (searched
  `src-tauri/src/*.rs`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`).
  Node binaries are pinned and verified at build time from a signed manifest
  (`docs/ONBOARDING_PAIRING.md`, `docs/RELEASE_CHECKLIST.md`).
- **Can it be paid.** **Impossible.**
- **Why.** External services with their own terms. They are outside the
  node. If push is added, the paid event (the message) should cause the push;
  the push payload should carry no content and no price.

### 3.11 AI

| Path | Traffic | Paid today | Verdict | Refs |
| --- | --- | --- | --- | --- |
| Local model | Host to a model server on `127.0.0.1` only (Ollama 11434, llama.cpp 8080) | No | exempt (intra-cell) | `src-tauri/src/ai/local.rs`: "no host other than loopback, no spend path". |
| Broker reads | Host reads node topics through the closed read broker | No | exempt (intra-cell) | `src-tauri/src/ai.rs`: "The node never talks to a model." |
| Remote model API | Host sends an owner-approved, disclosed body to an external endpoint | No sats; fiat or key-billed, off-node | impossible to price in sats today | `src-tauri/src/ai.rs`: off by default, two-step disclose then send. Billing is between owner and provider. |
| Proposed MCP clients | An AI client calling node tools | Not built (`docs/AI-MCP-DESIGN.md` is not on main) | holds with change | Treat each MCP client as an in-cell client with its own paired token and its own sats grant (`spend_budget_grant_v1`). Sats are the token in the sense that every paid tool call debits that grant; reads stay free inside the cell. |

The phrase "AI clients use sats as their token" holds best as: **an AI client
gets a budget grant, not a key**. Its authority to cause outbound paid
traffic is exactly the grant's total, per-call cap, recipients and expiry
(`src-tauri/src/grant.rs`). It never gets a fiat API key or the owner's
token.

### 3.12 DoS and abuse

Unsolicited inbound packets cost the receiver: bandwidth, a socket, a
handshake, parsing, maybe a database lookup. Payment cannot prevent this; it
can only make the *useful* response depend on payment. The goal therefore is
**minimal pre-payment work**:

1. Exactly one free application operation per kind of interaction: a bounded
   quote (first-contact quote, porch quote, price advert).
2. Cheap rejection, with an honest fixed cost. Inside an encrypted session
   the header is itself inside the ciphertext, so "refuse from a cleartext
   header before decryption" is not possible. The fixed pre-payment cost is
   **one Diffie-Hellman plus one AEAD open of a bounded first frame** (16 KiB
   plaintext cap, as in the Noise framing of `src-tauri/src/remote_access.rs`;
   the federation session's cap is *node-side* and must be confirmed). After
   that, no store lookup, state write or signature check beyond the
   session's happens before "unpaid, refuse". N-2 publishes this cost in
   bytes and microseconds.
3. Rate limits per source on every free operation, and on handshakes.
4. Quotes that are stateless (the first-contact quote already is: "Pays and
   reserves nothing", `src-tauri/src/app.rs`) and constant-size.
5. No amplification: a refusal or quote must be no larger than the request
   that caused it. Stricter form: the refusal bytes **plus any push bytes the
   request caused** must be no larger than the request bytes.
6. Bounded fan-out: one paid offer causes at most one push per registered
   device of the callee (devices × 1), so a single small offer cannot cause
   an unbounded number of pushes.

## 4. The reframed doctrine (official wording, decided)

The literal sentence fails at 3.1–3.5 and 3.9–3.10. The wording below can
hold end to end and is the doctrine's **official wording, decided by the
owner** (section 9, item 1). "No payment, no packet" remains the original
slogan:

> **No payment, no service.** A BitSov node does no processing, delivery or
> forwarding of peer-to-peer application traffic that has not been paid in
> sats. The only free operations a peer may cause are (1) a bounded,
> stateless quote and (2) the refusal itself. Traffic inside the cell (the
> owner's own apps, devices and in-cell clients holding a grant) and the
> planes the node stands on (link, IP, DNS, transport overlays, encrypted
> session setup, Bitcoin and Lightning) are exempt by definition. In-cell
> clients, including AI and MCP clients, spend only through a sats grant.

Corollaries:

- **Unit of payment is the service, not the packet.** A paid message covers
  its delivery and its receipt. A paid minute covers all media frames in
  both directions for that minute.
- **Bounded pre-payment.** Every free operation has a documented maximum
  request size, response size and rate per source.
- **Refusal before work.** For every paid kind, the node decides "refuse"
  before it writes state, contacts a third party or forwards anything.
- **Measured.** Pre-payment refusals and pre-payment bytes are counted and
  visible to the owner (extends `RefusalCounts`).

## 5. Free (unpaid) operations that exist today

| # | Operation | Where | Who can cause it | Recommendation |
| --- | --- | --- | --- | --- |
| F1 | Session handshake and Hello | node federation (node-side) | any dialer | **Bound.** Per-IP handshake rate; fixed-size Hello; drop silently past the limit. Keep counting `session_before_payment`. |
| F2 | First-contact quote | `/messages/first-contact/quote` (`src-tauri/src/app.rs`) | any connected stranger | **Bound.** Already stateless. Add per-source rate and a response-size cap. |
| F3 | Porch quote | `/browse/quote` (`read_porch_quote`) | admitted peers only | **Keep, bound.** Admission already gates it. Rate-limit per peer; cap response size; make `NotFound` and `Forbidden` indistinguishable (byte-identical) for paths outside the manifest, so the quote is not a free path oracle; consider folding into the fetch's price-cap check so a separate quote is optional. |
| F4 | Price adverts / peer price tables | `/pricing/peers` (node-side) | peers | **Bound.** One advert per peer per epoch; signed; cacheable. Cannot be priced (needed to pay). |
| F5 | Peer exchange | node-side (`peer_exchange_before_payment`) | peers | **Remove for non-admitted peers; price or bound for admitted ones.** |
| F6 | Delivery receipts / acks | node-side | receiving node | **Bundle and sign.** Define as part of the paid message. The receipt is signed by the receiving node so the sender cannot forge delivery state. A receipt for a message that was never paid is a free refusal, and it is counted. |
| F7 | Call refusals and `call_not_live` close | node-side, mapped in `src-tauri/src/app.rs` | callee node | **Keep free.** It is a refusal. Ensure fixed size. |
| F8 | Call ringing before answer | covered by paid kind 400 | caller | **Already paid; bound the fan-out.** Ignoring is free for the callee; keep. The callee's node still works for up to 60 s (routing to devices, pushes), so one paid offer causes at most one push per registered device (devices × 1). |
| F9 | Call grace period (10 s) and first-block wait (30 s) | node contract N1; `docs/CALLS.md` | caller | **Bound (already).** Media socket is refused until block 0 settles; the 10 s grace is a tolerance, not free service. Document as such. |
| F10 | Front-door card (QR / link) | `src-tauri/src/front_door.rs` | humans | **Keep.** No network traffic. |
| F11 | Front-door open dial | `/front-door/open` | own owner | **Keep.** Owner-initiated; peer side is F1. |
| F12 | Cached cards | `/browse/cards` | own app | **Exempt (intra-cell).** |
| F13 | Node STUN responder | owner-only `/status` reports it (`src/control/prefs.ts`) | anyone who can reach it (node-side) | **Restrict** to the cell or admitted peers, or turn it off in M6 builds, where calls use no STUN. |
| F14 | Lightning info / invoice errors | node-side (`lightning_info_before_payment`, `invoice_error_before_payment`) | peers | **Bound.** Invoice errors are refusals; Lightning info should be admitted-only. |
| F15 | Gossip wrapper | node-side (`gossip_before_payment`) | peers | **Remove for strangers.** Lightning's own gossip is exempt (3.5); a BitSov-level gossip request is not. |

## 6. Follow-up tickets

App (this repo):

- **A-1 Doctrine text.** Once the owner decides (section 9, item 1), adopt
  the chosen wording in the product docs and Control Center copy; stop
  saying "every packet is paid".
- **A-2 Pre-payment panel.** Extend `RefusalCounts` to show pre-payment
  bytes and the free-operation rates once the node reports them (N-3).
- **A-3 Lab STUN.** When `VITE_CALL_MEDIA=webrtc` is retired, delete the
  STUN setting and `stunServer` so no build can contact a STUN server.
- **A-4 MCP as grant holder.** If MCP lands, require each MCP client to pair
  as its own client with its own `spend_budget_grant_v1` grant; no shared
  token, no fiat key in the node.
- **A-5 Receipt wording.** In delivery UI, describe a receipt as part of the
  paid message ("paid and delivered"), not a separate event.
- **A-6 No minute block after End.** Known open issue: the P1 tracked in PR
  #366 (not fixed here). Today End ends the consent only after the hangup
  request returns, and a block that passed its last consent check can still
  post afterwards, so a minute can be paid for silence; a failed hangup can
  leave the consent open. That pays for a service not received, against the
  doctrine's spirit. Test (T16): End called while a block is in `money_post`;
  assert the block is not posted, or is posted and then counted as
  `failed_paid` with no further block. Second test (T17): the hangup POST
  fails; assert the consent is Ended and the next block is refused
  `call_not_live`.

Node:

- **N-1 Refusal-before-work audit.** For each paid kind (chat, 200, 400–404,
  500) and each free operation (F1–F15), document the exact code path from
  socket read to refusal and prove no state write, third-party call or
  forward happens before it.
- **N-2 Bounds table.** Publish request-size, response-size and per-source
  rate limits for every free operation; enforce them.
- **N-3 Pre-payment byte counter.** Extend the genome #96 refusal buckets
  with bytes received and bytes sent before payment, per reason.
- **N-4 Receipts bundled and signed.** Make the delivery receipt part of the
  paid message contract, signed by the receiving node; refuse and count
  receipt-shaped packets for unpaid messages.
- **N-5 STUN responder scope.** Bind the node's STUN responder to the cell
  (or admitted peers), or disable it by default for M6.
- **N-6 Stranger surface.** Remove peer exchange and BitSov gossip requests
  for non-admitted peers.
- **N-7 Porch quote oracle.** Return byte-identical replies for `NotFound`
  and off-manifest `Forbidden`; rate-limit quotes per peer (for example 20 a
  minute).
- **N-8 Push fan-out bound.** At most one push per registered device per
  paid offer; never a push for an unpaid or refused offer; push bytes count
  toward the no-amplification bound (3.12, point 5).
- **N-9 Media at block boundaries.** Forward frames between `paid_until_ms`
  and the end of grace; a late block within grace extends `paid_until_ms`
  without a gap (T8b, T8c).

Ops:

- **O-1 Reach without DNS.** Prefer IP or tailnet endpoints in pairing links
  and cards where possible; document the DNS that remains.
- **O-2 Overlay posture.** Document what Tailscale/WireGuard (and Tor, if
  offered) send on the owner's behalf, so the "exempt plane" is explicit.
- **O-3 Abuse runbook.** What the owner sees and does when pre-payment
  counters spike.

## 7. Test plan: simulating "no payment, no packet"

Goal: show that an unpaid peer gets nothing but a bounded quote or a refusal,
and measure what that costs the receiver.

### 7.1 Harness

A regtest harness (like the existing two-node UI E2E,
`docs/UI_E2E_TWO_NODE.md`) with three nodes, **A** (owner), **B** (contact)
and **H** (hostile peer, speaks the federation protocol, never pays, can
replay captured frames), plus two headless app hosts (A's and B's). It runs
in CI only, on private regtest nodes. It never touches mainnet, real funds,
or any public service.

### 7.2 Cases

For each case: send the request (unpaid unless the case says otherwise),
assert the expected reply, and assert the side effects listed did **not**
happen.

Each case lists the matching case of the independent review's harness
(S1 to S22) where one exists; the two lists are merged here without
duplicates.

| Case | Review | Setup and request | Expected | Must not happen / bound |
| --- | --- | --- | --- | --- |
| T1 | S1 | Session handshake flood: H opens 500 sessions a minute to A | after N (default 30 a minute per IP) silent drop | unbounded sockets; `bytes_out` > `bytes_in`; CPU per refused handshake above one DH plus one AEAD open |
| T2 | S2 | Chat compose (kind 0) without payment | refusal | message stored (`store_writes` > 0), `/ws` event at A's app, notification, receipt sent, `pushes_sent` > 0 |
| T3 | S3 | File ref 200 without payment | refusal | file fetched or stored |
| T4 | S4 | Call offer 400 without payment | refusal | ring event at callee app; `pushes_sent` > 0 |
| T4b | S5 | Paid offer from B to A, A has 3 registered devices | ring on live `/ws`; at most 3 pushes | pushes > registered devices (one push per device per offer); push payload > 64 bytes |
| T5 | S6 | Call answer/ICE/hangup 401–403 with a random `call_id` | refusal | admission created |
| T6 | S7 | Call block 404 without payment; B sends `seq + 2` | refusal | `paid_until_ms` advanced |
| T7 | S8 | Media socket before block 0 settles | socket refused | any frame forwarded |
| T8 | S10 | B stops paying; media frames after `paid_until_ms` plus grace | link closed, hangup `unpaid`; A's app shows "unpaid" | frames forwarded past grace |
| T8b | S9 | Media frames after `paid_until_ms` but **before** the 10 s grace ends | frames still forwarded | frames dropped by the node at a block boundary (legitimate calls would stutter at every block) |
| T8c | S9 | Block n paid **late**, within grace | `paid_until_ms` extended with no gap; frames forwarded continuously | 0 frames dropped between `paid_until_ms` and the late payment |
| T9 | S13 | Porch quote from a non-admitted peer | `admission_required` | page read, size, hash or path state revealed; reply bytes > request bytes |
| T10 | S14 | Admitted B quotes 50 unknown paths, then floods | NotFound and off-manifest Forbidden return byte-identical bodies; rate-limited after 20 a minute | path enumeration possible; unbounded replies |
| T11 | S15 | Porch fetch without payment | refusal | page bytes sent |
| T12 | S16 | H sends a delivery receipt for a message A never sent, or an unsigned / wrongly signed receipt | drop and count | delivery state changed at A's app |
| T13 | S17 | Peer exchange / gossip / Lightning info from a stranger | refusal | peer list or channel data sent |
| T14 | S18 | First-contact quote flood (200 a minute) | rate-limited, stateless | state written per quote (`store_writes` > 0) |
| T15 | S19 | STUN binding from outside the cell | no reply (M6 default, after N-5) | binding response; any bytes out |
| T16 | S11 | **Block after End (A-6).** A's host calls End while block n is in `money_post` (mock node delays 2 s) | block n not posted; or posted, then counted `failed_paid` and no block n+1 | a `call_block` record created after End's timestamp |
| T17 | S12 | A's hangup POST returns 500, then a block is due | consent Ended; block refused `call_not_live` | any further payment |
| T18 | S20 | Fake MCP client: pay to an off-allowlist recipient, over the per-call cap, 11 writes in a minute, idempotency key replayed with a new body | each refused at host and node; node 409 reasons match | audit rows ≠ attempts; any payment |
| T19 | S21 | Self grant: mutated `approval_message`; second key enrolled mid-flow; signature replayed on another op | refused, no prompt | any grant written |
| T20 | S22 | Package fetch: tampered blob; price raised after quote; path off manifest | refused before payment / `price_cap_exceeded` / refused | any msat paid in any of the three |

### 7.3 Measurements

- **Bytes processed pre-payment**: per case, bytes read and written by the
  receiving node before refusal. Assert each is under the published bound
  (N-2), and that response bytes never exceed request bytes (no
  amplification).
- **Work before refusal**: count of store writes, outbound connections and
  Lightning calls during T2–T15. Expected: zero.
- **Per-case counters**, recorded by an instrumented node build (N-3):
  `bytes_in_pre_pay`, `bytes_out_pre_pay`, `cpu_us_pre_pay`,
  `store_writes_pre_pay`, `outbound_conns_pre_pay`, `ln_calls_pre_pay`,
  `pushes_sent`, and the refusal bucket deltas.
- **Report format**: one table per run, each case with measured bytes, CPU
  and writes against the published bound (N-2), plus the refusal bucket
  deltas. A case passes only if its assertion holds **and** every "must not
  happen" counter is zero.
- **Refusal counters**: the genome #96 buckets increase by exactly the
  number of refused requests per reason.

### 7.4 App-side checks (this repo, headless)

- Host refuses to dispatch any paid kind without a live grant and consent
  (existing tests around `money_post_with`, `call_block`, `porch_post`).
- No renderer path opens a network socket (CSP `connect-src 'self' ipc:`,
  `docs/CALLS.md`).
- The M6 build makes no STUN contact (`tests/call-media-flag.test.tsx`
  asserts no `RTCPeerConnection`).
- **A-6 host tests** (T16, T17): End during a delayed `money_post`, and a
  failed hangup; see A-6. These reference the open P1 in PR #366 and pass
  only once that is fixed.
- The renderer never names a minute amount: it calls
  `call_block(peer, call_id, seq)` only.
- A `recipient_left` of `None` (no per-recipient entry) is treated as
  "unbudgeted, pass" in the pre-ring compare, never as zero.

## 8. Verdict summary

| Layer | Verdict |
| --- | --- |
| Physical / link / IP / NAT | impossible; exempt by definition |
| DNS | impossible; reduce via IPs or tailnet names |
| Overlays (Tailscale, WireGuard, Tor) | impossible; exempt |
| Session handshakes (Noise / TLS) | impossible for the first packets; bound them |
| Bitcoin chain sync and Lightning | impossible; the payment plane is exempt |
| Node-to-node application traffic | holds today for messages, calls, minutes, porch fetch and cards; holds with change for quotes, adverts, receipts, peer exchange |
| Media frames | holds by minute block, not per packet |
| Intra-cell (apps, pairing, polling, approvals) | exempt by doctrine; protected by authority, not payment |
| STUN / TURN, push, updates | impossible; M6 already avoids STUN for calls |
| AI | local and broker exempt; remote model is fiat, off-node; MCP holds with change as grant holders |
| DoS | payment cannot stop packets; minimise and measure pre-payment work |

## 9. Decisions needed from the owner

1. **Decided by the owner:** the doctrine is officially worded **"No
   payment, no service"** (section 4: one bounded free quote and a free
   refusal; everything inside your own cell and the planes below the node
   are exempt), in place of "every packet is paid". "No payment, no packet"
   stays as the original slogan; it was reframed because a node can only
   refuse service, not stop an unpaid packet from arriving.
2. Confirm the cell boundary: own apps, own devices, in-cell clients with a
   grant. Confirm that intra-cell traffic is never priced.
3. Confirm which free operations stay free (F2 first-contact quote, F3 porch
   quote, F4 price adverts) and their bounds.
4. Approve the node tickets N-1 to N-9 for scheduling, and the hostile-peer
   harness of section 7.
