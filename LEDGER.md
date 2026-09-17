# LEDGER

Dated ticket rows. Each row: id | opened | evidence | state.
`BOARD.md` is the live lane SoT; this file is the ticket index.

## Active (this cycle)

| id | opened | evidence | state |
|---|---|---|---|
| APP-RC7 | 2026-09-17 | rc7 pin; untouched-init CI smoke; exact sidecar-path exclusion; internal Mac package evidence in `docs/MAC_PACKAGE_SPIKE.md`; depends on #13 | in review, not merged |

## Shipped

| id | opened | evidence | state |
|---|---|---|---|
| Q4-APP-RC6 / Q5b | 2026-09-13 | #10 rc6 re-pin + signature hardening; #11 docs reconciliation; included in main `93c56e0a` | landed |
| Darwin (B10) | 2026-09-03 | genome `v0.3.0-rc5` ships signed macOS/Windows node sidecars (not notarized / Authenticode-signed); PR #4 mac/win hosts, PR #9 Darwin SKIP retired — CS-1 smoke runs on Linux + macOS | landed |
| CS-2 | 2026-09-01 | PR #6 `eafb30d` first-run fund flow + PR #8 `98bb49d` restore/restart on main | shipped |
| CS-1 | 2026-08-12 | PR #1 app shell + node embed; PR #3 `7ee23c6` durable two-run identity (`SMOKE: PASS` + `SMOKE: IDENTITY_STABLE`) | shipped |

## Hold / skip

| id | opened | evidence | state |
|---|---|---|---|
| Publish | — | human-only; genome rc7 published; app unpublished; package-time sidecar verification and platform release gates remain open | hold |
| PriceOpen | — | out of lane | hold |
| Live relay | — | out of lane | hold |
| Cloud/seed | — | out of lane | hold |
