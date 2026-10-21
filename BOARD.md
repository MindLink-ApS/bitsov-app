# BOARD.md — BitSov App Factory Lane Ledger

Single source of truth for the `bitsov-app` factory lane.
Updated each PR; read before starting work.

LANE: BitSov app factory (`MindLink-ApS/bitsov-app`)

---

## QUEUE-HEAD

**Draft rc19.1 pin** (2026-10-21), replacing main's rc14 pin and the stale
rc18 proposal #266. rc19.1 is not tagged or signed yet. All five checksum values are
placeholders; fetch and pre-bundle verification refuse before network access. No rc19.1
release bytes have been verified.
Changes include owner approvals, pairing v8, channel operations, call refusal
semantics, ONB5 on LDK and local API/CLI/release security hardening.
See [the upgrade and release checklist](docs/NODE_RC19_1_UPGRADE.md).

The September factory entries below are historical context, not current PR status:

- **F1 — #32 `factory/pairing-onboarding`** (draft, in Codex review, head `90a154bd`). App pairing client and first-run pairing UX. Mock-only, using genome #77 shapes. Falls back to `/auth/local` only on the rc7 sidecar (404 on `/pair/request`).
- **F2 — `factory/assistant-local-broker`** (underway, stacked on #32, not yet pushed). The assistant reads the local node through the broker. Deny-by-default, no cloud.
- **F3 — Mac packaging assessment** (handed to a cloud agent on `docs/mac-package-plan`, not yet pushed). Decides whether to revive or replace #13.

Runs on Linux + macOS since `v0.3.0-rc5` (Darwin SKIP retired, PR #9). Publish stays human. No PriceOpen, no live relay, no cloud/seed.

## EVIDENCE

| What | SHA / ref |
|---|---|
| Main baseline | `7fc9294` (2026-09-27) |
| Protocol pin | `v0.3.0-rc19.1`; source SHA and signed checksums pending; fetch intentionally blocked |
| Genome #77 | BitSov-bitsov #77 (pairing, identity-free bootstrap, owner CLI) merged at `56c0ee0` on 2026-09-26. Included in the rc19.1 pin |
| App quit stops node | #17 `0190baa` (fixes #16) |
| Jarvis J1–J4 | #21 `8cc34eb` J1 mock node + 50-question fixture; #22 `3543229` J2 broker with metadata allowlist; #20 `61dd969` J3 sealed assistant window + command ACL; #26 `dbd3d9e` J4 broker over the mock node, e2e; #27 `32c49bc` J4 review fixes |
| J0 macOS isolation | #24 `612b330` Phase 0.5 spike (mock-only) |
| SIT mock | #29 `91f20c8` mock-only SIT reader; #30 `66c57bf` 50 mock SIT rows in the assistant window |
| J5 sandbox | #28 `33c5fed` macOS sandbox-exec launcher for the local model; #31 `7fc9294` reaps the sandbox process group after the leader exits |
| Internal Mac package | rc7 build and sidecar byte-match PASS; see `docs/MAC_PACKAGE_SPIKE.md`. No local runtime test |
| Local node | Not inspected or changed in this ticket; no current health/identity claim |
| Open factory PRs | Query GitHub before dispatch; do not rely on a stored count |

## BLOCKED

- **rc19.1 acceptance.** Inspect Sidecar and Mac Package CI; runtime/packaging checks were not run locally. Remote first run is implemented on main (app #192 + node rc13); runtime acceptance on real hardware (Touch ID + a fresh Pi) is still pending.
- **Darwin / Windows notarization.** Signed macOS/Windows node sidecars have shipped since `v0.3.0-rc5` (B10 landed; Darwin SKIP retired, PR #9). They are GPG-signed only, not notarized or Authenticode-signed, so Gatekeeper and SmartScreen block them by default. No Mac/Win app build ships without a verified signed node sidecar. Publish stays human.
- **Publish** is human-only. rc19.1 is not tagged/signed yet; signed-byte verification remains a gate. The app itself is unpublished (`/bitsov/app` stays a waitlist, G5). Package-time sidecar verification must be enforced before public downloads.

## HUMAN

Publish stays human. No PriceOpen. No live relay. No cloud/seed.

- Genome: rc19.1 is not tagged/signed yet; no release publishing occurs in this app change.
- Tag, GPG signing, publish, seed.
- macOS notarization / Windows Authenticode.
- Rasmus decides on the open PRs: #25 (J0 local model eval spike, draft) and #13 (Mac package spike, CONFLICTING). #23 (Windows icon) is also open.

## OPEN LOOPS

| Owner | Loop | Next reversible action |
|---|---|---|
| Codex | F1 pairing onboarding (#32) | Finish review of head `90a154bd`; historical entry; rc9 now includes #77 |
| Factory agent | F2 assistant local broker | Build on #32; deny-by-default broker to the local node, no cloud |
| Cloud agent | F3 Mac packaging assessment | Write up revive vs replace #13 on `docs/mac-package-plan` |
| Human / CI | rc19.1 acceptance | Run the Sidecar and Mac Package checks; assess the documented app compatibility gaps |
| Human | #25 / #13 / #23 | Merge, close, or keep open; Rasmus's call |

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
