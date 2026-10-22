# Changelog

## Unreleased

- Restore in-call Pay after a successful wallet/chat check, reject delayed checks of older payments, and explain failed receipts. Price owner call repairs with a host-enforced ceiling, keep unpriced repair checks payment-free, and refuse acknowledgement of verified foreign-identity records. Pin the call-slot proof guards with mutation regressions and make call timeout/refusal tests independent of preflight scheduling.

- Keep caller recovery refused while the original admission is open, with clear End call and priced Call again controls. Expose unresolved call records for host repair or acknowledgement without releasing unproven liabilities. Bind early peer hangup/busy events to fresh dispatches, preserve stale-event protection for reused call IDs, and retain durable proof for node-refused unsent call slots.

- Show restart guidance after Forget cancels desktop startup, resume the previous phone connection after a ticket-save failure, and retry locked-Keychain fresh-install cleanup once on foreground while keeping identity use blocked. Make remote cancellation tests tolerant of loaded CI.

- Let Forget and replacement phone tickets cancel a stalled remote connection without restarting; preserve retry backoff and consumed-ticket handling, prevent desktop Reconnect during local startup, and align the generated iOS Local Network description.

- Security: Give fresh iOS installs a new client identity by removing orphaned Keychain and legacy client keys before setup; preserve existing app/pairing data and safely retry interrupted cleanup.
- Expose structured phone connection errors for unclaimed boxes and unavailable iOS Local Network access; reconnect from the saved descriptor when the phone returns to the foreground, without replaying a consumed ticket. Claim-free second-device enrollment remains blocked on the node contract (see `docs/PHONE_ONBOARDING_PR1.md`).

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
