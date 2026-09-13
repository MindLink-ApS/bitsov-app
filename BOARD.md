# BOARD.md — BitSov App Factory Lane Ledger

Single source of truth for the `bitsov-app` factory lane.
Updated each PR; read before starting work.

LANE: BitSov app factory (`MindLink-ApS/bitsov-app`)

---

## QUEUE-HEAD

**Next reversible factory loop after CS-2** (CS-2 complete on main: PR #6 `eafb30d` fund flow + PR #8 `98bb49d` restore/restart; CI compile gate PR #9 `0052412`). Open factory PRs: #10 (Q4-APP-RC6 rc6 re-pin) + Q5b-APP-DOCS (this reconciliation).

Runs on Linux + macOS since `v0.3.0-rc5` (Darwin SKIP retired, PR #9). Publish stays human. No PriceOpen, no live relay, no cloud/seed.

## EVIDENCE

| What | SHA / ref |
|---|---|
| origin/main | `0052412` — PR #9 CI compile gate; CS-2 = PR #6 `eafb30d` first-run fund flow + PR #8 `98bb49d` restore/restart |
| Protocol pin | `v0.3.0-rc5` source-ref `1ae4d8c9…` (`MindLink-ApS/BitSov-bitsov`) — rc5 published 2026-09-03; rc6 published 2026-09-13 (re-pin tracked as Q4-APP-RC6, PR #10) |
| Local node | `node_id` `93acaebf…` on NOVA loopback |
| Open factory PRs | 0 |

## BLOCKED

- **Darwin / Windows notarization** — signed macOS/Windows node sidecars ship since `v0.3.0-rc5` (B10 landed; Darwin SKIP retired, PR #9), but they are GPG-signed only, not notarized / Authenticode-signed — Gatekeeper/SmartScreen block by default. No Mac/Win app build ships without a verified signed node sidecar; publish stays human.
- **Publish** — human-only. Genome rc5 (2026-09-03) and rc6 (2026-09-13) are published; the app itself is unpublished (`/bitsov/app` stays a waitlist, G5).

## HUMAN

Publish stays human. No PriceOpen. No live relay. No cloud/seed.

## OPEN LOOPS

| Owner | Loop | Next reversible action |
|---|---|---|
| Atlas / factory | Next factory loop after CS-2 | Pick the next reversible CS step; not publish |
| Human | Publish / rc6 re-pin | rc5 + rc6 published; app publish stays human; rc6 re-pin lands via Q4-APP-RC6 (PR #10) |

## HUDDLE

None this cycle. Factory loop is sequential CS steps, not a client meeting.

## CHARTER LOCKS

- No PriceOpen.
- No live relay.
- No cloud/seed.
- No Mac/Windows app build without a verified signed node sidecar (B10 landed at `v0.3.0-rc5`; Darwin SKIP retired).
- Publish stays human.
- Authority gates stay in `CODEX_APP_AUTHORITY.md` — do not rewrite them from a board refresh.
- Protocol charter wins over this file on invariants/gates; this file is the live operating ledger only.
