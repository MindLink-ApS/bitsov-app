# LEDGER

Dated ticket rows. Each row: id | opened | evidence | state.
`BOARD.md` is the live lane SoT; this file is the ticket index.

## Active (this cycle)

Current change: rc14 pin (`d55a88e`) from rc13 (`d625e85`, app #193).
The supplied release facts identify rc14 as published and GPG-signed. All five
binary hashes are recorded without fetching or local release verification.
[NODE_RC14_UPGRADE.md](docs/NODE_RC14_UPGRADE.md) records pairing v6, grant
breakers, console recovery, LAN limits and CLN's receive/read-only preview.
Tagged node source confirms unchanged full-tier LDK bootstrap defaults. Remote
first run is implemented on main (app #192 + node rc13); runtime acceptance on
real hardware remains pending. The September workflow rows below are historical.

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
| APP-RC13 | 2026-10-08 | #193 `9f10373`; rc13 pin (`d625e85`), supplied hashes and bootstrap defaults aligned | landed |
| APP-RC12 | 2026-10-07 | #178 `a20bf2c`; rc12 pin (`41b9e78`), expected hashes and source review recorded in that change | landed |
| APP-RC11 | 2026-10-07 | #174 `81ee030`; rc11 pin (`834968b`), signed manifest and Darwin arm64 bytes verified in that change | landed |
| APP-RC9 | 2026-10-06 | #160 `fb2ce6f`; rc9 pin (`cd75c69`) and gated bundled local owner ceremony | landed |
| APP-RC7 | 2026-09-17 | #14 `ec13f2a` rc7 pin (`958e3997`); untouched-init CI smoke; internal Mac package evidence in `docs/MAC_PACKAGE_SPIKE.md` | landed |
| Q4-APP-RC6 / Q5b | 2026-09-13 | #10 rc6 re-pin + signature hardening; #11 docs reconciliation; included in main `93c56e0a` | landed |
| Darwin (B10) | 2026-09-03 | genome `v0.3.0-rc5` ships signed macOS/Windows node sidecars (not notarized / Authenticode-signed); PR #4 mac/win hosts, PR #9 Darwin SKIP retired — CS-1 smoke runs on Linux + macOS | landed |
| CS-2 | 2026-09-01 | PR #6 `eafb30d` first-run fund flow + PR #8 `98bb49d` restore/restart on main | shipped |
| CS-1 | 2026-08-12 | PR #1 app shell + node embed; PR #3 `7ee23c6` durable two-run identity (`SMOKE: PASS` + `SMOKE: IDENTITY_STABLE`) | shipped |

## Hold / skip

| id | opened | evidence | state |
|---|---|---|---|
| rc14 acceptance | 2026-10-11 | published and GPG-signed per supplied facts; signature/bytes, Sidecar/Mac Package and runtime acceptance pending | human / CI |
| #25 / #13 / #23 | — | J0 model eval spike (draft); Mac package spike (CONFLICTING); Windows icon | open, Rasmus's call |
| Publish | — | human-only; rc14 release is published and GPG-signed per supplied facts; app unpublished; package-time sidecar verification and platform release gates remain open | hold |
| PriceOpen | — | out of lane | hold |
| Live relay | — | out of lane | hold |
| Cloud/seed | — | out of lane | hold |
