# Changelog

## Unreleased

- M6 A2: node-routed calls are paid while they run. Before Ring the confirm shows the callee's per-minute price (their node's kind-404 advert) and the most the caller's node will hold for the minutes (240 blocks plus routing), in Danish and English; no call is placed without it. From the answer on the caller pays one 60-second block per minute (`call_block`, kind 404) drawn from the reservation the node made with the offer, never above the agreed price; the media socket opens only once the node reports the first minute paid. The card shows the node's own running cost (per-minute price, paid so far, still reserved) from `call_status`; `unpaid` hangups, refused or unknown minutes, a raised price, and liquidity or grant refusals end the call with a plain reason; afterwards it says what the minutes cost and what the node released.
- M6 A2 fix round 3: every paid-minutes offer carries the agreed per-minute price and most held (`max_block_msat`, `max_hold_msat`), so the caller's node itself refuses to ring above them, before it holds or pays anything; the card says so in plain words. A call's agreement is kept until the node's own call status shows the call and its hold closed: a refused call whose hangup failed or is not finished stays refused, counts against the open-call limit, and can never be rebound to wider terms or paid, however many calls follow. A hold is checked only once the node accepted that very offer, and an offer that did not go through can never pay a minute. A call its node no longer lists no longer shows its last reservation as still held.
- M6 A2 fix round 2: a call's agreed minutes are bound to its offer's admission. The offer's routing ceiling (which the node applies to every minute of the hold) is at most the agreed allowance, the callee's advertised per-minute price is checked again just before the offer (above the agreed one, nothing is sent), and the hold is checked as soon as the offer returns: one above the agreement is refused for good before the hangup, so no raced, confirmed or retried minute ever pays it. A call's agreement is write-once for its life and after (never evicted while the call is open, never rebound to other terms). Node-routed calls are audio only, also when an incoming offer asks for video, and a media session that dies (fatal audio, the node ending the link) ends the call so its minutes stop.
- M6 A2 fix: the host keeps the minutes agreed before Ring (sent with the offer) and pays a call's minutes only from the node's reservation for exactly that call, never a renderer amount: with no reservation, or one above the agreed per-minute price, routing allowance or total, it hangs up before block 0 and pays nothing. Once the call rings the card shows the node's exact hold under its own call limit (`max_call_minutes`), and no minute is paid until the owner confirms it (`call_hold`). An owner session, whose node keeps no reservation, places no paid-minutes call; quotes whose maximum cannot be represented have no per-minute price.

- M6 A1: route call audio through both nodes. The host owns the node's per-call media socket like `/ws` (loopback or the remote-access proxy, bounded drop-oldest queues, three main-window commands); the renderer encodes 20 ms frames with WebCodecs Opus or pure-TypeScript G.711 mu-law, plays them through an AudioWorklet with a 60–120 ms adaptive jitter buffer, and labels the call as encrypted between the two nodes. App-to-app WebRTC media, video and meetings are off in M6 builds (`VITE_CALL_MEDIA=webrtc` keeps the lab path); node payment for the media leg is slice A2.

- Restore in-call Pay after a successful wallet/chat check, reject delayed checks of older payments, and explain failed receipts. Price owner call repairs with a host-enforced ceiling, keep unpriced repair checks payment-free, and refuse acknowledgement of verified foreign-identity records. Pin the call-slot proof guards with mutation regressions and make call timeout/refusal tests independent of preflight scheduling.

- Keep caller recovery refused while the original admission is open, with clear End call and priced Call again controls. Expose unresolved call records for host repair or acknowledgement without releasing unproven liabilities. Bind early peer hangup/busy events to fresh dispatches, preserve stale-event protection for reused call IDs, and retain durable proof for node-refused unsent call slots.

- Show restart guidance after Forget cancels desktop startup, resume the previous phone connection after a ticket-save failure, and retry locked-Keychain fresh-install cleanup once on foreground while keeping identity use blocked. Make remote cancellation tests tolerant of loaded CI.

- Let Forget and replacement phone tickets cancel a stalled remote connection without restarting; preserve retry backoff and consumed-ticket handling, prevent desktop Reconnect during local startup, and align the generated iOS Local Network description.

- Security: Give fresh iOS installs a new client identity by removing orphaned Keychain and legacy client keys before setup; preserve existing app/pairing data and safely retry interrupted cleanup.
- Expose structured phone connection errors for unclaimed boxes and unavailable iOS Local Network access; reconnect from the saved descriptor when the phone returns to the foreground, without replaying a consumed ticket. Claim-free second-device enrollment remained blocked on the node contract at this stage.

- Connect phones immediately after importing a remote ticket, allow reconnect from saved tickets before remote mode starts, and direct first-run box tickets to Mac setup; add mobile pairing and Noise framing regression coverage.

- Replace the default Tauri iOS and Android launcher icons with the BitSov mark, with opaque iOS assets on the mark's dark background.
- Fall back to uncached Rust compilation when sccache setup or its cache backend fails, so cache outages do not fail CI (app #280).

- Release the pending spend slot and budget reservation for proven unpaid call-rules refusals, retain the operation receipt, and allow later payments after an expired hangup.
- Align Android unlock and Remember copy with supported biometrics, remove Touch ID wording from missing-contact approval errors, ignore unrelated Android pairing intents, and cover phone flows with rendered Android Tauri tests.

- Restore focus after Wallet and info/hub dialogs close, stack dialog Escape handling, focus incoming calls, expose AI composer expansion, and show pending-result checks only for pending work (UI/UX audit 2-8–2-11, 2-21).

- Treat Tauri iOS/iPadOS as mobile independently of Android scanning; use biometric approval wording and name iPad correctly in pairing, unlock, and device copy, with rendered iPhone/iPad regression coverage.

- Update `solid-js` to 1.9.16 and lock `seroval` / `seroval-plugins` to 1.6.8 to fix GHSA-p6vx-979v-rg4c and GHSA-jp82-f5mq-hwhp without overrides.
- Update `rustls` to 0.23.46, `rustls-webpki` to 0.103.16, and `webpki-roots` to 1.0.10 to fix RUSTSEC-2026-0346, RUSTSEC-2026-0347, RUSTSEC-2026-0348, RUSTSEC-2026-0349, RUSTSEC-2026-0382, and RUSTSEC-2026-0381.
- Update `rustls` to 0.23.45 to fix RUSTSEC-2026-0285 (TLS 1.3 handshake messages accepted across encryption levels).
- Update `quinn-proto` to 0.11.18 to fix RUSTSEC-2026-0338, RUSTSEC-2026-0339, RUSTSEC-2026-0340, RUSTSEC-2026-0341, and RUSTSEC-2026-0342.
