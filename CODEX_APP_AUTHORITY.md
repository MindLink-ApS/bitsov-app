# CODEX_APP_AUTHORITY — periodic authority check for the BitSov consumer app

**Role.** Codex acts as the standing **authority checker** for `bitsov-app` (charter:
`~/Desktop/CLAUDE_GOAL_BITSOV_APP.md`). Run this pass **once in a while** — before any
milestone merge, before any mobile/paired/hosted/AI/calls copy or code ships, and on a
routine cadence (≈ weekly while the app is in active build). You are adversarial by default:
**refute that the build is charter-clean; approve only what survives.** Claude builds
branch-only PRs; Codex reviews/ratifies bounded-safe ones; the operator ratifies
high-risk/irreversible ones. This doc is the checklist and the verdict format.

Authority precedence: **protocol charter (`BitSov-bitsov` CLAUDE.md + PUBLIC_REPO_DECISION.md
+ SECURITY.md) → this file → the app goal file.** If a build conflicts with the protocol
charter, the build is wrong.

---

## A. Immutable invariants (any violation = NO-GO, blocks ship)
1. **Payment gate never bypassed.** No app path sends/acts on an inbound unit of work without a
   settled, recipient-bound payment. The app uses `POST /messages/compose` (node obtains the
   proof); it must **never** reintroduce a free-send path or stub the gate. Grep the app for any
   direct-transport send that skips `compose`/`messages`; confirm `PaymentGate::verify` is
   fail-closed and unmodified in the pinned protocol release the app bundles.
2. **Zero plaintext, including in transit.** No plaintext message content or node JWT crosses a
   network unencrypted. `/ws` emits decrypted plaintext and `/auth/local` is loopback-only with
   no TLS — acceptable **only** on the device's own loopback. Any non-loopback client (mobile,
   paired, hosted) without channel confidentiality (TLS/Noise) is a **hard fail** (see Gate G2).
3. **Node is the identity anchor.** The app is a face; it must not mint or hold an authority the
   node doesn't grant. Device credentials (when built) are delegated sub-keys, never the mnemonic.
4. **Honesty ceiling.** No "replaces Slack/Zoom", "surveillance-proof/unhackable", "node in your
   pocket/always-on" (pre-relay), or "call anyone" (pre-NAT-traversal) in code, UI, website, or
   marketing. Vision stays labeled as vision.

## B. The six charter gates (from the launch audit — verify each pass)
- **G1 — API-consumer boundary.** Confirm the app **bundles + supervises the released
  `konsensus-node` binary** and talks the public HTTP/`/ws` API over loopback. **FAIL if** it
  links `konsensus-*` crates in-process, vendors/forks protocol logic, or makes the node
  non-optional. Check: no `konsensus-*` path/git deps in the app's Cargo/manifest; a pinned
  released node version; an ADR documenting the API-consumer decision.
- **G2 — Remote transport confidentiality + delegated auth.** Before ANY paired/mobile/hosted
  client touches a non-loopback node: a TLS/Noise confidential channel **and** per-device
  delegated auth (not the raw node key, not bare `/auth/local`) must exist and be used. **FAIL**
  any mobile/paired/hosted PR that predates this. Signing ≠ encryption.
- **G3 — Calls not marketed.** VoIP is directly-reachable-only until NAT traversal lands.
  **FAIL** any launch/website/app copy that presents "call/meet" as a working feature.
- **G4 — AI genuinely deferred.** Participants are `node_id`s; the AI seam is reserve-only
  (a node_id may *later* be an agent, invoked inline only on explicit request — never ambient).
  **FAIL** any shipped agent runtime, any always-listening bot, or any copy implying an AI
  participant exists before M11.
- **G5 — Website inert until real artifacts.** `/bitsov/app` is a waitlist. **FAIL** any
  `website-release-metadata.json` change that adds an app artifact, sets `public_repositories.app`,
  or flips `public_downloads_enabled` for the app before a real **signed** app binary exists. The
  fail-closed gate flips on real signed artifacts only. (A plain "Source code" repo link is OK.)
- **G6 — `/auth/local` hardened.** Before the funds-holding "your bank" framing ships, `/auth/local`
  must be app-bound or carry an explicit local-trust disclosure (today any loopback process can mint
  a full node JWT and drain the wallet / read history).

## C. Product-correctness gates (silent-failure / "looks-shippable-but-isn't")
- **Room membership propagation.** Adding a member is local-only bookkeeping — it does not
  admit/notify the peer, and per-member payment-gated fanout will silently fail for un-peered
  members. **Require** either a real admit/notify/join protocol + participant-profile endpoint, or
  an MVP explicitly scoped to 1:1 + already-peered members. FAIL a "rooms with inline participants"
  ship that can silently not connect.
- **Mobile push is wake-only/opaque.** APNs/FCM payloads transit Apple/Google. Enforce as an
  acceptance criterion: **no plaintext and no relationship metadata in push payloads** — wake tokens
  only.
- **Custody tiers honest.** T-HOSTED copy says "operator holds keys+plaintext — convenience, not
  full sovereignty" verbatim; ciphertext-relay hosting preferred; hosted never blurred into a
  sovereignty claim.

## D. Sequencing rules (do not let order break the charter)
- No mobile/paired client work merges before **G2 (transport confidentiality) + device pairing
  (M5/CS-8)** land — pairing is auth, transport is confidentiality; **both** required.
- No "phone-native / node in your pocket" code or copy before **relay #216 (M7)** is live.
- No multi-party meet before **group-crypto (MLS 960–962)** is verified production-ready.
- AI participant (M11/CS-14) stays seam-only until the operator explicitly re-scopes MindLink
  toward an on-prem AI-model posture.

## E. Verdict format (emit each pass)
```
CODEX APP AUTHORITY — <date> — commit/PR <ref>
Scope: <what was reviewed>
Invariants (A): PASS | FAIL — <notes>
Gates (B): G1 __ G2 __ G3 __ G4 __ G5 __ G6 __
Product gates (C): <pass/fail per item>
Sequencing (D): <ok / violation>
VERDICT: GO | QUALIFIED-GO (ship X, block Y) | NO-GO
Must-fix before next ship: <list>
```
- **GO** only when A holds, every applicable B/C gate passes, and D is respected for what's shipping.
- **QUALIFIED-GO** approves a safe subset (e.g. desktop T-SELF) while explicitly blocking the rest
  (mobile/paired/hosted/calls/AI) — the current expected state until G2 + relay land.
- **NO-GO** on any A violation or an unmet gate for the thing being shipped.

## F. Cadence & bootstrap
- **Now:** the charter is set; no app code exists yet. First authority pass runs against **CS-1
  (app shell + node embed)** — verify G1 (API-consumer, no crate linking) before anything else.
- **Every milestone merge + weekly** while active. Re-read this file and the goal file each pass;
  verify claims against the pinned protocol release, not memory.
- Record each verdict (append to a `bitsov-app/docs/authority/` ledger once the repo exists).
