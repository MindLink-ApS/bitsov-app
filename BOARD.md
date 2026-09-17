# BOARD.md — BitSov App Factory Lane Ledger

Single source of truth for the `bitsov-app` factory lane.
Updated each PR; read before starting work.

LANE: BitSov app factory (`MindLink-ApS/bitsov-app`)

---

## QUEUE-HEAD

**rc7 app re-pin and internal Mac package check** (2026-09-17). PR #10 (rc6 re-pin) and #11 (docs reconciliation) are merged. PR #13 (Mac package spike) awaits human merge; the rc7 follow-up builds on its reviewed head `0889f17`. Claude independently reviews the follow-up. No public package, live runtime start, or mill arming.

Runs on Linux + macOS since `v0.3.0-rc5` (Darwin SKIP retired, PR #9). Publish stays human. No PriceOpen, no live relay, no cloud/seed.

## EVIDENCE

| What | SHA / ref |
|---|---|
| Main baseline | `93c56e0a` at start of this follow-up; includes #10 and #11 |
| Protocol pin | This branch: `v0.3.0-rc7`, source `958e3997`; main baseline uses rc6. rc7 published 2026-09-15 |
| Internal Mac package | rc7 build and sidecar byte-match PASS; see `docs/MAC_PACKAGE_SPIKE.md`. No local runtime test |
| Local node | Not inspected or changed in this ticket; no current health/identity claim |
| Open factory PRs | Query GitHub before dispatch; do not rely on a stored count |

## BLOCKED

- **Darwin / Windows notarization** — signed macOS/Windows node sidecars ship since `v0.3.0-rc5` (B10 landed; Darwin SKIP retired, PR #9), but they are GPG-signed only, not notarized / Authenticode-signed — Gatekeeper/SmartScreen block by default. No Mac/Win app build ships without a verified signed node sidecar; publish stays human.
- **Publish** — human-only. Genome rc7 is published; the app itself is unpublished (`/bitsov/app` stays a waitlist, G5). Package-time sidecar verification must be enforced before public downloads.

## HUMAN

Publish stays human. No PriceOpen. No live relay. No cloud/seed.

## OPEN LOOPS

| Owner | Loop | Next reversible action |
|---|---|---|
| Codex / Claude | rc7 re-pin | Code, CI smoke, internal package evidence, then independent Claude review |
| Human | Merge / publish | Review #13 and its dependent rc7 follow-up; no public app release in this ticket |

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
