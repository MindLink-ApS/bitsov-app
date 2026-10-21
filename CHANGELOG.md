# Changelog

## Unreleased

- Treat Tauri iOS/iPadOS as mobile independently of Android scanning; use biometric approval wording and name iPad correctly in pairing, unlock, and device copy, with rendered iPhone/iPad regression coverage.

- Update `solid-js` to 1.9.16 and lock `seroval` / `seroval-plugins` to 1.6.8 to fix GHSA-p6vx-979v-rg4c and GHSA-jp82-f5mq-hwhp without overrides.
- Update `rustls` to 0.23.46, `rustls-webpki` to 0.103.16, and `webpki-roots` to 1.0.10 to fix RUSTSEC-2026-0346, RUSTSEC-2026-0347, RUSTSEC-2026-0348, RUSTSEC-2026-0349, RUSTSEC-2026-0382, and RUSTSEC-2026-0381.
- Update `rustls` to 0.23.45 to fix RUSTSEC-2026-0285 (TLS 1.3 handshake messages accepted across encryption levels).
- Update `quinn-proto` to 0.11.18 to fix RUSTSEC-2026-0338, RUSTSEC-2026-0339, RUSTSEC-2026-0340, RUSTSEC-2026-0341, and RUSTSEC-2026-0342.
