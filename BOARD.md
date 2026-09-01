# BOARD.md — BitSov App Factory Lane Ledger

Single source of truth for the `bitsov-app` factory lane.
Updated each PR; read before starting work.

LANE: BitSov app factory (`MindLink-ApS/bitsov-app`)

---

## QUEUE-HEAD

**Next reversible factory loop after CS-2** (`eafb30d`, PR #6 — fund flow on main). Open factory PRs: 0.

Darwin SKIP. Publish stays human. No PriceOpen, no live relay, no cloud/seed.

## EVIDENCE

| What | SHA / ref |
|---|---|
| origin/main | `eafb30d` — PR #6 first-run fund flow (onboarding, deposit QR, funding poll, restore) |
| Protocol pin | `v0.3.0-rc5` source-ref `1ae4d8c9…` (`MindLink-ApS/BitSov-bitsov`) — rc5 draft unpublished |
| Local node | `node_id` `93acaebf…` on NOVA loopback |
| Open factory PRs | 0 |

## BLOCKED

- **Darwin** — SKIP (macOS signed node binary not in this loop).
- **Publish** — human-only; rc5 draft unpublished.

## HUMAN

Publish stays human. No PriceOpen. No live relay. No cloud/seed.

## OPEN LOOPS

| Owner | Loop | Next reversible action |
|---|---|---|
| Atlas / factory | Next factory loop after CS-2 | Pick the next reversible CS step; not Darwin, not publish |
| Human | Publish / rc5 | Unpublished draft; operator publishes |

## HUDDLE

None this cycle. Factory loop is sequential CS steps, not a client meeting.

## CHARTER LOCKS

- No PriceOpen.
- No live relay.
- No cloud/seed.
- Darwin SKIP.
- Publish stays human.
- Authority gates stay in `CODEX_APP_AUTHORITY.md` — do not rewrite them from a board refresh.
- Protocol charter wins over this file on invariants/gates; this file is the live operating ledger only.
