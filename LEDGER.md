# LEDGER

Dated ticket rows. Each row: id | opened | evidence | state.
`BOARD.md` is the live lane SoT; this file is the ticket index.

## Active (this cycle)

| id | opened | evidence | state |
|---|---|---|---|
| CS-NEXT | 2026-09-01 | next reversible factory loop after CS-2 (#6 `eafb30d` + #8 `98bb49d`); CI compile gate #9 `0052412` | queue-head |

## Shipped

| id | opened | evidence | state |
|---|---|---|---|
| Darwin (B10) | 2026-09-03 | genome `v0.3.0-rc5` ships signed macOS/Windows node sidecars (not notarized / Authenticode-signed); PR #4 mac/win hosts, PR #9 Darwin SKIP retired — CS-1 smoke runs on Linux + macOS | landed |
| CS-2 | 2026-09-01 | PR #6 `eafb30d` first-run fund flow + PR #8 `98bb49d` restore/restart on main | shipped |
| CS-1 | 2026-08-12 | PR #1 app shell + node embed; PR #3 `7ee23c6` durable two-run identity (`SMOKE: PASS` + `SMOKE: IDENTITY_STABLE`) | shipped |

## Hold / skip

| id | opened | evidence | state |
|---|---|---|---|
| Publish | — | human-only; genome rc5 (2026-09-03) + rc6 (2026-09-13) published; app unpublished; rc6 re-pin tracked as Q4-APP-RC6 (#10) | hold |
| PriceOpen | — | out of lane | hold |
| Live relay | — | out of lane | hold |
| Cloud/seed | — | out of lane | hold |
