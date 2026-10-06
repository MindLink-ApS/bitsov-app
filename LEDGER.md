# LEDGER

Dated ticket rows. Each row: id | opened | evidence | state.
`BOARD.md` is the live lane SoT; this file is the ticket index.

## Active (this cycle)

Current change: rc9 pin (`cd75c69`) and bundled local-owner capability; tests and
upgrade details in [NODE_RC9_UPGRADE.md](docs/NODE_RC9_UPGRADE.md). Release asset
verification awaits CI. The September workflow rows below are historical.

| id | opened | evidence | state |
|---|---|---|---|
| F1 pairing onboarding | 2026-09-27 | #32 `factory/pairing-onboarding` head `90a154bd`; genome #77 shapes; now included in rc9 | draft, in Codex review |
| F2 assistant local broker | 2026-09-27 | `factory/assistant-local-broker`, stacked on #32; deny-by-default, no cloud | underway |
| F3 Mac packaging assessment | 2026-09-27 | revive vs replace #13; cloud agent on `docs/mac-package-plan` | underway |

## Shipped

| id | opened | evidence | state |
|---|---|---|---|
| Jarvis J5 sandbox | 2026-09-26 | #28 `33c5fed` sandbox-exec launcher; #31 `7fc9294` process-group reap | landed |
| Jarvis SIT mock | 2026-09-26 | #29 `91f20c8` SIT reader; #30 `66c57bf` mock rows in the assistant window | landed |
| Jarvis J1–J4 + J0 isolation | 2026-09-25 | #21 `8cc34eb` J1; #22 `3543229` J2; #20 `61dd969` J3; #26 `dbd3d9e` J4; #27 `32c49bc` J4 review; #24 `612b330` J0 macOS isolation spike | landed |
| APP-16 quit stops node | 2026-09-18 | #17 `0190baa` (fixes #16) | landed |
| APP-RC7 | 2026-09-17 | #14 `ec13f2a` rc7 pin (`958e3997`); untouched-init CI smoke; internal Mac package evidence in `docs/MAC_PACKAGE_SPIKE.md` | landed |
| Q4-APP-RC6 / Q5b | 2026-09-13 | #10 rc6 re-pin + signature hardening; #11 docs reconciliation; included in main `93c56e0a` | landed |
| Darwin (B10) | 2026-09-03 | genome `v0.3.0-rc5` ships signed macOS/Windows node sidecars (not notarized / Authenticode-signed); PR #4 mac/win hosts, PR #9 Darwin SKIP retired — CS-1 smoke runs on Linux + macOS | landed |
| CS-2 | 2026-09-01 | PR #6 `eafb30d` first-run fund flow + PR #8 `98bb49d` restore/restart on main | shipped |
| CS-1 | 2026-08-12 | PR #1 app shell + node embed; PR #3 `7ee23c6` durable two-run identity (`SMOKE: PASS` + `SMOKE: IDENTITY_STABLE`) | shipped |

## Hold / skip

| id | opened | evidence | state |
|---|---|---|---|
| rc9 release verification | 2026-10-06 | app pins rc9 (`cd75c69`); signed checksum attachment/publication and Sidecar/Mac Package checks pending | human / CI |
| #25 / #13 / #23 | — | J0 model eval spike (draft); Mac package spike (CONFLICTING); Windows icon | open, Rasmus's call |
| Publish | — | human-only; rc9 draft needs CI-accessible signed checksums; app unpublished; package-time sidecar verification and platform release gates remain open | hold |
| PriceOpen | — | out of lane | hold |
| Live relay | — | out of lane | hold |
| Cloud/seed | — | out of lane | hold |
