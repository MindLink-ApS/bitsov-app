# LEDGER

Dated ticket rows. Each row: id | opened | evidence | state.
`BOARD.md` is the live lane SoT; this file is the ticket index.

## Active (this cycle)

| id | opened | evidence | state |
|---|---|---|---|
| CS-NEXT | 2026-09-01 | next reversible factory loop after CS-2 #6 `eafb30d` | queue-head |

## Shipped

| id | opened | evidence | state |
|---|---|---|---|
| CS-2 | 2026-09-01 | PR #6 `eafb30d` first-run fund flow on main | shipped |
| CS-1 | 2026-08-12 | PR #1 app shell + node embed | shipped |

## Hold / skip

| id | opened | evidence | state |
|---|---|---|---|
| Darwin | — | SKIP this loop | skip |
| Publish | — | human-only; rc5 draft unpublished | hold |
| PriceOpen | — | out of lane | hold |
| Live relay | — | out of lane | hold |
| Cloud/seed | — | out of lane | hold |
