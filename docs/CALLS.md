# 1:1 calls (regtest prototype)

## M6 A1: node-routed audio

Owner decision (M6): **the node is the cell.** Call audio goes app → own node →
peer node → peer app. Direct app-to-app WebRTC media is **off** in M6 builds and
is never the call path. Signalling (the four paid kinds 400–403) is unchanged.

- **Build flag.** `VITE_CALL_MEDIA` (parent build process, like
  `VITE_STARTER_BALANCE`; fixed at build time in `vite.config.ts`). Unset or
  anything but the exact value `webrtc` is the M6 profile: node-routed audio
  on, app-to-app media, video and meetings hidden and unreachable
  (`src/control/callFlags.ts`). `VITE_CALL_MEDIA=webrtc` is the pre-M6 lab
  profile only; the WebRTC code stays in the tree for it and for the lab
  checks below, not for users. The Playwright a11y servers
  (`playwright.webkit.config.ts`, `playwright.safe-areas.config.ts`) and
  `scripts/ui-layout/meeting-planner-check.mjs` pin it, because their
  meeting-planner specs exercise that hidden UI.
- **The host owns the socket.** The Rust host opens the node's owner-scoped
  `GET /api/v1/calls/:call_id/media?peer=<counterparty>` WebSocket exactly as
  it owns `/ws` (`src-tauri/src/control/media.rs`): same loopback API base (a
  local node, or the loopback proxy of the paired Noise remote-access tunnel),
  same local proxy credential, the `bitsov.v1` subprotocol, and the token as
  the `bitsov.jwt.<token>` subprotocol the node reads first (never in the URL).
  The node admits the socket only for a `(peer, call_id)` it knows, under a
  paired token with `spend`; the host reconnects with backoff while the call
  lasts and stops on a refusal. The node closes the socket when the token it
  opened with expires, so each open gets a new token of its own, which the host
  does not keep. Without one, it opens on the shared token. The renderer opens no socket and sees no
  token; the CSP keeps `connect-src 'self' ipc:` only. Three main-window
  commands: `call_media_open(call_id, peer, on_frame)`,
  `call_media_send(raw payload)`, `call_media_close()`. Frames reach the
  renderer on one Tauri channel (binary frames; link transitions as parsed
  JSON objects `{ link, detail }`); both directions pass through bounded queues
  (50 frames) that drop the oldest frame under backpressure.
- **Wire format.** Each binary message is `seq` (u32, big-endian) then the
  payload (at most 4096 bytes, the node's cap). The host assigns `seq` upward
  and validates the shape downward; the node forwards payloads opaquely. The payload is the app's "bitsov media
  payload v1" (`src/control/mediaFrame.ts`): a type byte, then bytes. `0x00`
  HELLO carries the codecs this app decodes; `0x01` is one 20 ms G.711 mu-law
  frame (160 bytes); `0x02` is one 20 ms Opus packet. Each app sends Opus only
  after the peer's HELLO said it decodes Opus, mu-law until then. A HELLO
  takes a `seq` but no playout time.
- **Renderer audio engine** (`src/control/callAudio.ts`). Microphone via the
  engine's existing `getUserMedia` (echo cancellation and noise suppression
  requested), 20 ms frames cut by an AudioWorklet, Opus through WebCodecs
  `AudioEncoder`/`AudioDecoder` where the webview has it, otherwise mu-law in
  pure TypeScript (no new dependency). Playout runs in an AudioWorklet whose
  jitter buffer (`src/control/jitterBuffer.ts`) reorders by `seq`, conceals
  loss by fading the last frame, drops late frames, and adapts its target
  delay between 60 and 120 ms. Webviews without AudioWorklet fall back to a
  ScriptProcessorNode and scheduled AudioBufferSourceNodes with the same
  buffer. Mute, and clean teardown (worklets, codecs, context, socket) on
  hangup. Opus failing mid-call falls back to mu-law: a broken encoder sends
  mu-law from the next frame; a broken decoder withdraws Opus with a fresh
  HELLO (repeated each second while Opus still arrives), and the peer switches
  on its next frame. If the peer still sends Opus after 5 s, or an audio
  worklet crashes, the engine reports a fatal error and the call ends.
- **Local audio statistics** (`src/control/callAudioStats.ts`). About every
  five seconds the engine closes one row of plain numbers: the jitter buffer's
  counters since the last row, the codec in use and frames received per codec,
  the microphone track's `getSettings()` (numeric and boolean fields only),
  peak, RMS (tenths of dBFS) and clipped-sample counts for the captured frames
  and for the decoded frames handed to playout, all-zero 128-sample blocks in
  the captured frames, frames the host's two queues dropped (read through
  `call_media_stats`, a counter read), gaps between received frames, the
  longest main-thread timer gap, and when the owner muted and unmuted. A
  last partial row is closed at hangup. Rows hold no audio samples, message
  content, device ids or labels; they are kept in memory for the last five
  calls (an hour each at most), never written to disk or sent anywhere, and
  appear only as extra lines of "Copy call report" for the owner to copy.
  Capture is measured on the main thread from frames the worklet already
  posts; the worklets are unchanged. Output device type is not recorded: the
  webview exposes no type without device ids or labels.
- **How the engine switches.** `call.ts` still drives one
  RTCPeerConnection-shaped object per call; in M6 builds that object is
  `src/control/nodeRoutedConnection.ts`, not an `RTCPeerConnection`. Its
  "SDP" is a placeholder carrying `a=x-bitsov-media:node-routed-v1` and the
  call id; once both descriptions are set it opens the host media socket for
  the call id and its counterparty, and reports `connected` only when the host
  reports the link open and the audio graph is ready. An audio graph that
  cannot be built (no AudioContext, worklet refused) closes the socket and
  ends the call rather than leaving a silent live call; so does a fatal audio
  error later in the call. It gathers no
  candidates and contacts no STUN or TURN server. A peer that
  answers with direct-media SDP (a pre-M6 app) ends the call as "their
  answer could not be used", nothing more paid. If the node link drops, the
  host reconnects; after 30 s without it the call ends. The node's refusal of
  the socket (for example an unknown call) ends it at once.
- **Label.** While a node-routed call is ringing, connecting or live the
  card shows, outside the **Details** disclosure, *The call goes through your box and theirs. Both boxes can hear it.* /
  *Opkaldet går gennem din boks og deres. Begge bokse kan høre det.* The audio is not end-to-end encrypted between the
  apps: both nodes forward it. The line stays visible until the apps encrypt
  end to end. The STUN,
  direct-recovery and relay notes are not shown.
- **Short card.** During a call the card shows the name, the timer, one cost
  line (the paid minutes on an outgoing routed call), mute and hang up; the
  longer notes sit behind **Details**. The in-call direct payment (*Pay*) is
  not offered on a node-routed call; its receipts and pending-result check
  stay on the card. Amounts and payment flows are unchanged.
- **Payment for the node leg is slice A2** (below). The node admits the media
  socket only once the call's first minute is paid, so payment starts at the
  answer, not on `onSession` `open`. `onSession` `closed` fires once when an
  open media session ends for good (fatal audio, the node ended the link, the
  30 s grace ran out, or the call closed); the shell then ends the call
  (`mediaClosed`), so its minutes stop being paid.
- **Audio only.** With the flag on a call is placed as audio and an incoming
  video offer rings and is answered as audio: the camera is never captured
  or sent.
- **Checks.** `npm test -- tests/g711.test.ts tests/media-frame.test.ts
  tests/jitter-buffer.test.ts tests/node-routed-connection.test.ts
  tests/call-audio-failure.test.ts tests/call-media-flag.test.tsx` (codec
  round trip, frame codec, mid-call Opus fallback and fatal teardown, jitter
  ordering/loss/late drop/reorder, the adapter, and the shell with the flag
  on: no `RTCPeerConnection`, no video or meeting controls, the label, live on
  the host's link). `cargo test control::media` (frame codec, drop-oldest
  queue, URL rule, a loopback media socket that assigns `seq` upward and
  validates downward, a refused handshake that does not reconnect). These are
  headless: they prove the wiring, not audio quality, device capture, or a
  node that serves the route. Two-device acceptance against a node with the
  media route is separate evidence.

## Sealed audio, first proof (off by default)

A test build only. It takes two switches together: `VITE_CALL_SEAL=sealed` for the
renderer and the host's `call-seal` Cargo feature (for example
`VITE_CALL_SEAL=sealed npm run tauri build -- --features call-seal`).
`src-tauri/build.rs` refuses a build with only one of them. Without both, the build
is today's: the same SDP, the same frames and the same host commands. No seal
command, permission or capability is generated, and no direct dependency is
added. Tests that also pass on the code before sealing existed hold this. The seal
tests themselves run only with the feature:
`VITE_CALL_SEAL=sealed cargo test --features call-seal`.

With it on, the host (`src-tauri/src/control/call_seal.rs`) seals audio between the
two apps. The node changes nothing: it forwards opaque frames, and metering,
admission and price never read them.

- **Key agreement.** The offer carries a hash commitment, the answer carries the
  callee's ephemeral X25519 key, and the first media frames reveal the caller's
  key. Public values only pass through the renderer and the nodes. No key derives
  from the node, its seed or a stored secret, and each call starts fresh.
- **Frames.** `0x11 | epoch | counter | ciphertext | tag`, ChaCha20-Poly1305, one key
  per direction, the inside padded to a multiple of 128 bytes. The host hands the
  renderer the plain frame, numbered by the authenticated `stream_seq`. Anything in
  the clear, or failing its tag, on a sealed call reaches nothing.
- **What it authenticates.** Each frame comes from whoever holds the key from this
  one exchange, for this call, direction, epoch and counter.
- **What it does not.** Who that is. A node that swaps both keys sits in the middle
  and reads everything, with "sealed" on both screens. Only comparing the words
  catches that, and no screen shows the words yet. The node ids come from the node.
  Nothing here has had an outside review.
- **The answer cannot be sealed.** A sealing caller whose answer has no attribute, or
  no capability bit, ends the call before any audio goes out. It says "This call
  could not be sealed, so it was ended. Nothing was said unsealed." and names no
  side, since an app that cannot seal and a node that stripped the line look the
  same. So a sealing build cannot call an app that cannot seal. A callee answering
  an offer without the attribute takes the call as today, labelled "Not sealed".
- **Never in the clear by surprise.** A wrong attribute, a bad or missing reveal (5 s
  from the call's first socket open), a low-order key, 10 s with no authentic frame
  (from the first open or the last authentic frame, whether or not anything
  arrives), or the last epoch running out ends the call with a reason. Reconnects
  do not move these deadlines. The label says "sealed" only after a frame from the
  far side authenticates, and only for the call on screen.
- **Secrets in memory.** Key derivations wipe the hash state and its output;
  `zeroize` is on for BLAKE3 and X25519 in this build. Moved copies, swap and
  the webview's plain audio stay out of reach.
- **Not built:** the words on screen, remembering a contact, "only private calls",
  video in the seal, messages.

## M6 A2: paid minutes

Node contract: genome M6 N1 (kind 404 `CALL_BLOCK`, 60-second blocks priced by
the callee's `[pricing] call_block_msat`, 10 s grace, hangup reason `unpaid`)
and N3 (one call-sized spend reservation made when the offer goes out, drawn
down per block, released on end, reported on `GET /api/v1/calls?peer=`).

- **Consent before Ring.** `call_quote` adds the callee's per-minute price
  (`block_msat`: their price advert's `kind:404`, or the `realtime_signaling`
  category it equals; none when the advert is stale or missing), the routing
  allowance per block (the offer's routing ceiling, which the node applies to
  each block), `reservation_max_msat` (240 blocks at that price plus
  allowance: the most any node may hold, since `max_call_minutes` is at most
  240) and `minutes_payable` (the session is a paired app spending under a
  grant, the only kind the node reserves for). A quote whose maximum
  overflows or exceeds what the renderer holds exactly
  (`Number.MAX_SAFE_INTEGER`) has no per-minute price. The Ring confirm shows
  the price and that ceiling, in Danish and English. With no per-minute price,
  or from an owner session (`/auth/local`, no reservation, so no minute could
  be paid), the call button is disabled and says why; the engine also
  refuses to place such a call. Ring then uses the existing spend approval
  (`authorize`), unchanged.
- **The host keeps the consent.** The offer goes to `call_signal` with
  `minutes` (`block_msat`, `block_max_routing_fee_msat`, `max_hold_msat`).
  The host refuses one the quote could not have shown, refuses it from an
  owner session (`call_minutes_unpayable`, nothing sent), and keeps it in
  memory for that node identity, contact and wire call id. It is write-once
  for the life of the call and after: the same terms again are a no-op while
  the call is open, a second offer while the first is with the node is
  refused (`call_offer_in_flight`), and other terms, or any terms for a call
  that was refused or ended, are refused (`invalid`), so a ceiling can never
  be widened or rebound. Payment authority and the node's side of the call
  are kept apart: a refusal, the app's hangup or a failed offer ends the
  call's payments at once, but only the node's own call status
  (`GET /calls?peer=`: the call no longer listed, its hold closed, or no hold
  and the call ended) shows that it is closed. Until then the call is pinned,
  whatever its state (open, refused or ended, including a refused call whose
  hangup failed or is not finished): never evicted, and counted against the
  limit of 16 per node identity. A new call is refused (`call_consents_full`) rather than evict
  one, after re-reading the node for every pinned call. "No longer listed"
  counts only once nothing of the call can still be on its way to the node
  (its offer was accepted, or no payment is pending at the host), and never
  while its offer is in flight. When the table (256) is full only the oldest
  call its node closed goes; a refusal stays the answer for as long as it is
  kept, and a call id evicted later can only pay again through a new offer
  that the node accepts within new limits.
- **Admission is bound to the consent.** The node makes the hold when it
  admits the offer, at the callee's live per-minute price. The offer carries
  the consent's ceilings (genome N3, BitSov-bitsov #460): `max_block_msat`
  (the agreed per-minute price) and `max_hold_msat` (the agreed most held).
  The node checks its live price and its computed hold against them before
  it reserves, pays or sends anything, and refuses with `not_dispatched`
  (`call_price_above_consent`, `call_hold_above_consent`), which the host
  names `call_offer_price_above_consent` / `call_offer_hold_above_consent`:
  the call ends with a plain reason in Danish and English, nothing sent,
  held or paid. The offer's routing ceiling, which the node applies to every
  block of the hold, is at most the agreed allowance per minute. Just before
  the offer the host reads the callee's advert again; a per-minute price
  above the agreed one (or none) sends nothing (`call_price_changed`). The
  host keeps its own checks as defence in depth: no hold listed under the
  call id is checked or admitted before the node accepted this very offer
  (`call_hold_unconfirmed` until then), and as soon as the offer returns the
  host checks the hold. Until a check passes no minute can be paid; a hold
  above the consent is refused for good before the hangup is sent, so a
  minute raced against it, a later confirmation or a retry never pays it,
  and the node releases the hold when it closes the call. An offer that did
  not go through ends its consent for good.
- **The node's own limit, confirmed.** The node's `max_call_minutes` is not
  visible before the offer (it is on the reservation only), so once the
  offer is out the card reads it through `call_hold(peer, call_id)` and shows
  "Your node holds X for this call: up to N minutes (its call limit) at P a
  minute plus up to F routing". The host checks the reservation against the
  consent first: no reservation (`call_no_reservation`) or a per-minute
  price, routing allowance or total above it (`call_hold_above_consent`)
  makes the host hang up the call through `op_end_call` before block 0;
  nothing is paid for minutes and the node releases the hold. Otherwise the
  owner presses Confirm hold, which calls `call_hold` with
  `confirm_reserved_msat`; the host records it only if it equals the node's
  reservation total (`call_hold_changed` otherwise).
- **Refusals.** The node reserves when the offer goes out, before paying it.
  `call_liquidity_insufficient` / `call_liquidity_unavailable` (its channel
  cannot hold the reservation, or it could not check) and the grant refusals
  (`grant_per_call`, `grant_exhausted`, `grant_recipient`) end the call card
  with a plain reason and "nothing was paid".
- **Paying.** From the callee's answer, once the hold is confirmed, the
  caller pays block 0 and each next block when the node's
  `next_block_due_ms` comes (plus 1 s for clock skew), through the host
  command `call_block(peer, call_id, seq)`; the renderer names no amount.
  The host repeats the hold check (and hangup) above, requires the owner's
  confirmation of exactly that reservation (`call_hold_unconfirmed`), pays
  only an outgoing, open call, only the node's `next_block_seq`, at the
  reservation's `per_block_msat` plus `per_block_fee_msat`. Without a
  consent kept in this run (say, after a restart) it pays nothing
  (`call_no_consent`). The body is the genome's minimal `{call_id, seq}`.
  Same authority, journal (`call_block` operations) and exactly-once path as
  every call signal; the local grant preflight is skipped because the node
  already holds the reservation under the grant.
- **Media waits for payment.** The node refuses the media socket until the
  first minute settles, so the node-routed adapter opens it only once
  `call_status` reports the call live with `paid_until_ms` (both sides). Not
  paid within 30 s: the call ends as "the first minute was not paid in time".
- **Running cost.** The card shows the node's figures from `call_status`
  every 5 s: per-minute price and routing allowance, paid so far
  (`spent_msat`), still reserved (`remaining_msat`). The callee pays nothing
  for minutes and sees no running cost; it only watches its node.
- **Stop states.** Each ends the call at once with a plain reason; nothing
  is left connected: their node's hangup `unpaid`; the node showing the call
  ended after its paid time and grace (`unpaid`) or for another reason; a
  minute refused before paying (`payment_failed`: tried again up to 4 times
  when the node proved it did not dispatch it; a passing refusal, `not_ready`,
  `peer_not_ready`, a rate breaker or a channel read that failed, is tried again
  every 2 seconds while paid time and grace remain, at most 15 times, each try a
  new operation); a budget with no room for the next minute (`budget_limit`,
  `budget_exhausted` or `ceiling_exhausted`: a limit the owner set, so the call
  ends at once with its own reason); a minute whose outcome
  is unknown (`payment_unknown`: never paid again on top of it); their node
  asking more per minute (`price_changed`); a hold the host refused
  (`hold_refused`: no reservation, or above the consent; the host hung up).
- **Ending a paid call.** After End begins, no new minute is issued: End,
  local teardown and a hangup (ours or theirs) revoke the call's consent at
  once, waiting for nothing, and a minute reads that consent under the money
  lock and again as its last step before the POST. At most one minute already
  issued may settle; it holds the money lock until its outcome is recorded.
  Anything later is refused by the node, from the call's own state and clock.
  Once the money lock is free the hangup still goes through its preparation
  and any pending-result check first, so it can be delayed or refused there.
  A hangup that is sent goes under that lock, so the node sees it
  after that minute. A client cannot unsend what it handed to the network, so
  the app promises no more than this. A minute whose POST got no answer stays
  pending with its outcome unknown, which fences the hangup, so End first asks
  the node about it by operation id. Not paid and abandoned, or a known result
  (accounted as that): End then hangs up. Still paying or unknown: End sends no
  hangup, its error carries the pending id, the card says the result is not
  known yet, and the node ends the call itself once its paid time runs out.
  When the admission is already closed (a peer hangup), End does not reconcile,
  and a lost minute stays pending until the owner's check.
- **A call the node already ended.** The minute cap, a minute that failed for
  good, an unpaid expiry and the ring deadline end the call at the caller's
  node with no hangup coming back. End still asks. The node refuses that hangup
  before anything is paid (`not_dispatched`, reason `call_not_live`), and that
  refusal closes the admission, so the contact can be called again. A contact
  left stuck by an earlier build recovers on its next End. Any other
  `not_dispatched` of a hangup leaves the admission open: while the node's own
  closing notice is being paid it answers `call_signal_in_flight`, and "Try
  ending it again" then closes it. A minute the wallet tried and failed stays
  pending first, as above, and no hangup goes out while that result is not
  known. A minute's refusal stays `not_dispatched` even with this reason,
  because the node also gives it to a minute that is early or out of order on
  a live call.
- **After the call.** The card reads the node for up to 20 s until it closes
  the reservation and then says "Minutes: paid X. Released back to your
  budget: Y." Until then it says what the node still holds.
- **A minute whose payment failed.** The node answers the POST with
  `payment_unknown`, and so does a lookup until its sweep (every 15 s). The
  sweep moves the row to `released`, keeping the payment hash. That reply proves
  the minute unpaid only if the status read for that send, recorded with it,
  showed this node on LDK with abandonment (rc15 or later), and the node still
  shows that. End or the owner's check then releases its reservation, the ledger
  says unpaid, and its operation id is never posted again. End then sends the
  hangup. A paired caller's node has already ended the call, so it refuses that
  hangup before paying and End closes the admission. Without that record, from an
  earlier build, an older node or another wallet, the reply keeps the fence, as
  unknown: a row survives an upgrade unchanged, so today's status cannot say what
  wrote it. The same holds for a message, an offer and a hangup whose payment
  failed. A resend is a new operation.
- **Not covered yet.** An owner session places no paid-minutes call (its
  node keeps no reservation, so the host would pay nothing). The node offers
  no pre-dial read of `max_call_minutes`; the Ring confirm shows the
  240-minute ceiling and the exact hold is confirmed once it rings.
- **Checks.** `npm test -- tests/call-payments.test.tsx` (block schedule and
  agreed-price ceiling, every stop state, settle and release, the paid-media
  gate, the engine's consent gating and refusals, and the shell's consent,
  running cost, Unpaid, refused minute, liquidity refusal and summary; the
  hold shown with `max_call_minutes` and confirmed before block 0; no
  reservation and a hold above the consent paying nothing; an owner session
  never ringing; audio-only routed calls; a closed media session stopping
  the minutes). `tests/node-routed-connection.test.ts` (the session closes
  once on fatal audio, a node end or the grace). Rust host:
  `a2_no_reservation_or_no_consent_pays_no_minute`,
  `a2_an_owner_session_places_no_paid_minutes_call`,
  `a2_a_minute_pays_the_reservation_amount_never_the_consent_and_only_once_confirmed`,
  `a2_a_hold_above_the_consent_is_hung_up_before_block_zero`,
  `a2_a_price_change_between_quote_and_offer_pays_no_minute`,
  `a2_an_advert_above_the_consent_sends_no_offer`,
  `a2_the_offer_binds_the_agreed_routing_allowance_and_admits_a_hold_within_it`,
  `a2_a_minute_raced_against_the_offers_admission_is_never_paid`,
  `a2_a_failed_offer_is_final_and_cannot_be_rebound_wider`,
  `a2_the_node_refuses_an_offer_above_the_consent_and_nothing_is_held_or_paid`,
  `a2_a_refused_call_whose_hold_is_still_open_stays_refused_under_table_pressure`,
  `a2_consents_are_write_once_and_only_a_call_its_node_closed_is_evicted`,
  `a2_end_revokes_minutes_before_a_failed_hangup_and_a_paused_minute_pays_nothing`,
  `a2_a_minute_waiting_for_the_money_lock_pays_nothing_once_its_call_ends`,
  `a2_a_minute_paused_at_each_await_is_never_sent_after_the_call_ends`,
  `a2_a_hangup_refused_while_prepared_still_revokes_the_minutes`,
  `a2_a_minute_revoked_first_is_never_sent_and_one_decided_first_goes_before_the_hangup`,
  `a2_a_minute_racing_end_or_teardown_goes_before_the_hangup_or_not_at_all`,
  `a2_a_refused_minutes_cleanup_holds_no_consent_lock_against_end`,
  `a_failed_minute_clears_after_the_sweep_and_end_pays_the_hangup`,
  `a_failed_minute_on_a_call_the_node_ended_leaves_no_fence_and_end_closes_it`,
  `a_failed_offer_or_hangup_clears_the_same_way`,
  `a_failed_message_clears_after_the_sweep_and_goes_again_as_a_new_operation`,
  `every_other_reply_stays_fenced`,
  `the_same_reply_from_another_wallet_or_an_older_node_stays_fenced`,
  `a_failure_read_against_a_payment_on_record_stays_fenced`,
  `checking_a_failed_payment_again_releases_and_accounts_nothing_more`,
  `checking_a_failed_minute_again_after_a_crash_changes_nothing`,
  `a_row_carried_across_an_upgrade_stays_fenced_pending_or_settled`,
  `a_status_that_cannot_vouch_at_dispatch_leaves_the_send_fenced`,
  `a_record_for_another_node_identity_does_not_count`,
  `a_resend_under_the_same_id_counts_only_over_a_proven_unsent_attempt`,
  `a_failed_payment_stuck_by_an_earlier_build_stays_fenced`,
  `a2_end_reconciles_a_minute_the_node_swallowed_then_pays_the_hangup`,
  `a2_end_with_its_minute_still_paying_reports_unknown_and_sends_no_hangup`,
  `a2_end_accounts_a_minute_with_a_known_result_then_pays_the_hangup`,
  `a2_end_needs_the_node_to_confirm_it_abandoned_a_swallowed_minute`,
  `a2_end_leaves_another_calls_pending_minute_fenced`,
  `end_closes_a_call_the_node_ended_at_its_minute_cap`,
  `end_closes_a_call_the_node_ended_after_a_failed_minute`,
  `end_closes_an_offer_nobody_answered`,
  `end_closes_a_call_the_node_ended_after_resolving_its_lost_minute`,
  `an_admission_stuck_by_an_older_build_recovers_on_its_next_end`,
  `end_refused_for_another_reason_stays_refused_until_the_call_is_over`,
  `end_stays_unknown_while_the_node_reports_a_hangup_payment_unresolved`,
  `end_sends_no_hangup_while_a_failed_minute_is_unresolved`,
  `a_minute_refused_not_dispatched_stays_not_dispatched`,
  `a_fresh_call_signal_refused_not_dispatched_keeps_only_the_closing_reason`,
  `a_resent_hangup_refused_not_dispatched_closes_nothing`;
  `control::tests::a_consent_holds_only_what_the_quote_showed_and_covers_only_holds_within_it`,
  `control::tests::a_minute_costs_the_callees_advertised_block_price_and_the_reservation_is_bounded`,
  `call_status_reads_the_node_reservation_fields_verbatim`,
  `act::tests::a_call_block_body_is_the_minimal_genome_payload`,
  `act::tests::a_reservation_the_node_could_not_check_is_named_not_generic`,
  `grant::tests::call_reservation_refusals_are_named`. Headless: two-device
  acceptance against nodes with N1-N3 is separate evidence.

### What a press and a minute may pay

- **Accept and Decline** show the most one answer or hangup can cost, and stay off until that price is read. A press reads the price again and pays only if the live signal price and routing ceiling are each at or below what the button showed. Otherwise nothing is sent, and the card says nothing was paid.
- **No live price.** Without their node's live answer, the only signal price is this node's own tariff. The host refuses an answer, ICE candidate or hangup on it (`call_price_unknown`). End can be tried again: it sends the hangup once the price is back, and closes with nothing sent once the node shows the call ended or no longer lists it. An incoming call whose price cannot be read cannot be answered or declined.
- **Ignore** is always on the incoming card. It stops the ring on this device, sends and pays nothing, and leaves no missed-call record. The caller's ring times out as usual.
- **Hangup ceiling.** Every offer carries the most its hangup was shown to cost (`max_hangup_msat`). If the live hangup costs more, the host refuses the offer before anything is sent. The ceiling it saves for End is the live one, so it is never above what was shown.
- **Out of range.** A call total that overflows, or that is above what the renderer holds exactly (2^53 - 1 msat), is no price: no offer, answer or hangup.
- **Minutes.** Before each minute, its whole ceiling is added to what the node reports spent, and to the ceilings of this call's minutes in the journal (attempts proven unpaid excluded). Above the smaller of the node's hold and the most the owner agreed to, the minute is refused (`call_minutes_above_hold`), nothing is paid for it and the call is hung up. Node rc21's hold is its minutes plus a closing reserve, so a call to its node's limit stays within it. The node's own cap on minutes still ends the call first.

## Pre-M6 lab path (`VITE_CALL_MEDIA=webrtc` only)

- **Media** goes directly between the two apps (WebRTC in the webview). It never passes through a node and is not billed.
- **Signalling** is four paid messages through your node: offer (the callee's call price, once per call), answer, ICE, hangup (the realtime price each). Same budget, approval and exactly-once rules as messages. Only contacts you have already paid can be called.
- **No third party by default.** The app ships no STUN or TURN server. With none set, calls use host candidates only, so they connect on the same network (or over a VPN).
- **Calls across routers (NAT)** need a STUN server you choose: Settings → Display → Calls, `stun:host` or `stun:host:port`. That server learns your public IP address each time you place or accept a call. TURN relays are not supported (a relay would carry your media), so pairs behind symmetric NAT or carrier-grade NAT will not connect.
- **Your own node as the STUN server:** if your node runs its STUN responder (genome `[calls] stun_listen`) and has a public address (`[network] advertised_addr`), Settings → Calls offers **Use my node (stun:host:port)**. Choosing it only fills the field; calls use it after you press Save. Nothing switches automatically. If the responder runs but the node has no public address, Settings says so and shows the port to enter yourself. The responder helps apps that reach your node from outside its network. An app behind the same router mostly learns its local address.
- **Ending a call:** Hang up pays one hangup message. Cancel while calling pays nothing if the offer has not gone out; if it is already being paid, the microphone stops at once and nothing more is sent. Tracks stop immediately, even if signalling hangs or refuses. After a recovery, Hang up closes both admitted call ids (one paid hangup per id). Closing the window, an expired recovery window or a call that never connects (30 s) ends locally without paying a hangup.
- **Phones (iOS, Android): a locked or hidden call ends.** A phone OS silences the microphone of an app it does not show, while the call and its paid minutes would go on. From the answer on, a call whose app is out of view (`visibilitychange`), whose microphone track the OS muted, or whose capture delivers only digital silence for 10 s, shows when it will end and is hung up through the normal Hang up after `SILENCED_GRACE_MS` (20 s). Coming back in time continues the call. A microphone track that ended hangs up at once. After the hangup no further minute is paid, and the card says why ("The call stopped because the phone was locked or the app was closed."). The owner's own mute never counts. Desktop is unchanged.
- **Recovery (1:1 calls):** `disconnected` shows **Reconnecting…** while keeping tracks and the original start time. A blip under 2 s needs no new payment. A longer disconnect or an ICE/connection failure attempts one ICE restart per call, with a fixed 30 s grace window. Repeated events do not extend it. Both apps must run this version for automatic continuation. No TURN server or new service is added; both apps still need a reachable STUN server across NAT, and some networks remain unreachable without a relay.
- **Recovery charges:** the node rejects repeated offers/answers on an existing call id. Recovery therefore uses one fresh paid admission, retaining the UI call id. The caller's upfront ceiling includes the original offer/hangup plus one recovery offer/hangup. The callee pays a recovery answer, possibly one restart request, and one hangup for each admitted id if they hang up. The initial grant preflight covers the ordinary call; recovery is optional, is not a budget reservation, and checks the remaining grant again before a new offer. Existing authorization, grants and host budgets apply to each signal. Refused or unknown payments are never retried automatically; the grace window ends the call. A subsequent drop gets a grace window but no second paid attempt.
- **Media failures:** denied permissions and missing/busy devices show actionable messages. Capture has a 15 s deadline; any stream arriving after cancellation is stopped. Camera re-enable failure leaves the audio call usable and the camera off.
- **UI state:** `CallView.state` exposes `idle | ringing | connecting | live | reconnecting | ended` through `onView` and the shell's `Actions.callView` accessor. `phase` retains the card's `calling` and `incoming` distinctions. `callId` and `liveAt` remain stable through recovery; dismiss moves ended → idle.
- **Camera off** stops the camera (its light goes off); camera on captures it again.
- Checks: `scripts/calls/media-check.py` (real WebRTC in Chromium through the app's call engine, loopback only) and `scripts/calls/regtest-demo.sh <genome>` (paid signalling on regtest plus the media check). Both need a build with `VITE_CALL_MEDIA=webrtc`.

## Native media permissions

- **Android:** `src-tauri/gen/android/app/src/main/AndroidManifest.xml` is the
  committed Android project source (see `.gitignore`), not a build output. It
  declares `CAMERA`, `RECORD_AUDIO`, and `MODIFY_AUDIO_SETTINGS`. The locked wry
  0.57.0 `RustWebChromeClient.kt` maps `RESOURCE_AUDIO_CAPTURE` and
  `RESOURCE_VIDEO_CAPTURE` to those Android permissions. Its
  `grantPermissionRequest` calls `WryActivity.requestPermissions` first, grants
  the WebView resources only when the permissions are granted, and denies on
  refusal. No app-specific WebChromeClient override is needed. Recheck this flow
  when upgrading wry; do not edit its generated Kotlin files.
- **macOS:** `src-tauri/Entitlements.plist`, referenced by
  `bundle.macOS.entitlements`, enables microphone and camera access under the
  hardened runtime. Usage descriptions remain in `src-tauri/Info.plist`.
- **iOS:** `src-tauri/gen/apple` is the committed Xcode project (see
  `.gitignore`). The usage descriptions live in `src-tauri/Info.ios.plist`,
  referenced by `bundle.iOS.infoPlist` in `tauri.ios.conf.json`; Tauri merges
  it into `gen/apple/bitsov-app_iOS/Info.plist` on each iOS build
  ([configuration reference](https://v2.tauri.app/reference/config/#iosconfig)).
  It repeats the macOS wording for `NSMicrophoneUsageDescription` and
  `NSCameraUsageDescription` (keep both files in step) and adds
  `NSLocalNetworkUsageDescription`, because node endpoints and host-only call
  candidates can be LAN addresses. The desktop `Info.plist` is unchanged.

Headless checks validate configuration and compilation, not OS permission prompts
or real-device capture. Native media acceptance still requires separate device
testing.

## Recovery wire conventions

The existing node v1 schema is unchanged. Only the original caller creates a restart offer (`restartIce()` plus `createOffer({ iceRestart: true })`). The SDP carries `a=x-bitsov-restart-of:<original-call-id>` under a fresh 32-hex `call_id`. The callee auto-answers only an active, negotiated call with that original id, the same authenticated peer and media, and no prior accepted restart. The attribute is removed before applying the SDP. Duplicate offers cannot trigger another answer payment. Unmatched restart offers are ignored, including after a call ended.

If only the callee observes failure, it sends one kind 402 request with an empty `candidate` and `sdp_mid: "bitsov-restart-v1"`. This reserved app marker fits the existing node's candidate/mid limits; it is intercepted before `addIceCandidate`. Ordinary candidates continue through the existing path. Both sides failing still produce only one new admission. Hangup accepts either admitted id so it works during negotiation; the current id is closed first. Unknown payment results remain owned by the host journal.

Headless coverage: `npm test -- tests/control-calls.test.tsx tests/control-meetings.test.tsx`. These tests use peer-connection/track doubles and the real engine and shell. They do **not** establish WKWebView, TCC, real media or cross-network connectivity. Those require a separate two-Mac smoke test; do not substitute the mock result for that evidence.

## Meetings (up to 4, regtest prototype)

- **A meeting is a set of 1:1 calls.** The roster is you plus 1 to 3 contacts, fixed when you invite. Every pair of participants is one ordinary paid call ("leg"), placed and paid by whoever is earlier in the roster: the host rings everyone, the first invitee rings the later ones, and so on. No new price, no per-minute payment, no relay.
- **Invite:** Call buttons → **Meeting**, pick up to 3 contacts. Prices are read afresh when the planner opens; contacts without a call price are greyed out. The button shows the all-in ceiling (each invitee's call price plus one hangup) before anyone is rung, and that ceiling binds: each leg pays at most the price you were shown (and at most the live price). If a price went up in between, that leg is refused with nothing paid. Legs are paid one at a time through the same budget, approval and exactly-once path as a call.
- **Join:** the invite card names everyone in it and the join ceiling (an answer and a hangup to each earlier participant, a call to each later one). Joining answers every ringing leg and rings the later participants; a leg that rings after you joined is answered without another click. The prices are read afresh when the card opens and bind the same way, including legs answered after you joined. **Decline** pays one hangup per ringing leg (its price is on the button); ignoring an invite pays nothing (it ends after 60 s).
- **Leave:** media stops at once, then one paid hangup per leg the other side knows about. A leg still being placed is cancelled and pays nothing more; if its offer was already being paid, that person may keep ringing for up to a minute. A microphone that was still opening is stopped the moment it arrives. The others stay connected; the host has no "end for all".
- **When a leg fails** (their node takes no calls, they are not your contact, the payment is refused) that pair shows **No link** and the rest of the meeting goes on. Two invitees who are not each other's contacts will not hear each other. Nothing retries on its own.
- **Media** is full mesh: one direct connection per other participant, sharing one microphone (and camera). Upload grows with each participant. Same STUN rule as calls: none unless you set one.
- **Only nodes that take meetings are rung.** A node older than the meetings change would refuse a meeting leg only after it was paid. So a contact can be picked, and a leg is ever sent, only if they are connected and their node advertises `call_meeting_v1` (genome #139), and your own node lists it too. Others show **needs update** or **not connected**. When joining, a later participant without it gets no leg (No link, nothing paid).
- Your node refuses a leg out of roster order (or to someone not in the roster) before paying anything. One meeting or one call at a time.
- Checks: `scripts/calls/meeting-media-check.py` (real WebRTC between three Chromium pages through the app's meeting engine, loopback only) and genome `real_ldk_regtest_meeting` (three nodes on real LDK regtest, msat-exact).
