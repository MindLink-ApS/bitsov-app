# CODEX_APP_AUTHORITY — periodic authority check for the BitSov consumer app

**Live lane ledger:** `BOARD.md` (queue-head, blocked, human, charter locks). Dated tickets: `LEDGER.md`. Do not duplicate the board here. This file remains the authority-check charter; do not rewrite gates from a board refresh.

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
   settled, recipient-bound payment. The app uses `POST /api/v1/messages/compose` (node obtains the
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
- **G4 — Bounded v1 assistants (owner re-scope, 2026-10-07).** Named assistants may run
  on user invocation or while the app is open; **FAIL** unattended agent runtime.
  User-facing copy says **"assistant", not "agent"**, and must match shipped abilities.
  AI-as-a-client of the user's own node comes first; own-peer/`node_id` AI stays later
  (M11). The app brokers; **FAIL** any node-to-cloud-AI connection. **FAIL** any paid AI
  call above **55 sats all-in** (including fees), any paid AI without its **own separate
  pairing and small spend grant revocable without touching the owner's**, or **any AI
  pay path before a payee allowlist on the node grant lands**. v1 inbox access is counts
  only; **FAIL** message-body access without user opt-in per conversation. Assistants
  produce drafts; **FAIL** assistant-initiated payments or a bypass of the user's send
  through the existing budget/approval. See [AI assistants](docs/AI-ASSISTANTS.md).
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
- **Custody tiers honest.** T-HOSTED copy matches the genome charter line: "MindLink-hosted"
  means **only** a ciphertext relay (keys/funds/node on the user's device) or NaaS (the user's
  seed on a box the user controls) — never a key-holding hosted node, never "MindLink funds/opens
  your channels"; disclose what a relay operator can see. FAIL any copy that offers a key-holding
  hosted node or blurs hosting into a sovereignty claim.

## D. Sequencing rules (do not let order break the charter)
- No mobile/paired client work merges before **G2 (transport confidentiality) + device pairing
  (M5/CS-8)** land — pairing is auth, transport is confidentiality; **both** required.
- No "phone-native / node in your pocket" code or copy before **relay #216 (M7)** is live.
- No multi-party meet before **group-crypto (MLS 960–962)** is verified production-ready.
- Follow [AI assistants](docs/AI-ASSISTANTS.md): own-node client assistants first; separate
  paid-AI pairing/grant and a node-grant payee allowlist before any AI pay path, with
  the 55-sat all-in cap and existing budget/approval enforced. Own-peer AI (M11/CS-14)
  stays later; the v1 re-scope does not authorize an unattended runtime.

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
  (mobile/paired/hosted/calls/AI) according to each feature's applicable gates. v1
  own-node assistants use G4's rules; they do not require M11 or the relay.
- **NO-GO** on any A violation or an unmet gate for the thing being shipped.

## G. Executable checks (run these — don't eyeball it)
Pinned protocol: **release `v0.3.0-rc14`, source-ref `d55a88e439fd80dae89e263bef8378fd22c9a103`, repo `MindLink-ApS/BitSov-bitsov`**.
Five CLI targets: Linux x86_64/aarch64, Darwin aarch64/x86_64 and Windows x86_64.
The fetcher requires `SHA256SUMS.asc` signed by release key `B299…EF6E`; a signed
tag alone does not verify release bytes. rc14 is published and GPG-signed per
the supplied release facts. The five binary hashes are recorded;
no release assets were fetched or verified locally for this pin. Signature/byte
verification and package/runtime acceptance remain gates. The app remains
unpublished. See [rc14 upgrade checks](docs/NODE_RC14_UPGRADE.md) and
[API contract](docs/API_READINESS.md). Existing operator identities are preserved.
Machine form of these checks: `scripts/authority-check.sh` (CI "Authority Check"; the "Build" job
is the compile gate, PR #9). Run from the app repo root; adjust the Website path to your checkout.
**Any FAIL = that gate FAILs.**

**G1 — no forked / in-process protocol logic**
```bash
# FAIL if any konsensus-* is a path/git dependency (must be a bundled BINARY, not a linked crate)
! grep -REn 'konsensus[-_][a-z]+[[:space:]]*=[[:space:]]*\{?[[:space:]]*(path|git)' src-tauri/Cargo.toml Cargo.toml 2>/dev/null
test -x src-tauri/bin/konsensus-* || { echo "FAIL: node not bundled as a binary resource"; false; }
# pinned node integrity: this sha256 must equal the pinned release SHA256SUMS entry
# (sidecar is bin/konsensus-<host triple>, fetched + GPG/sha256-verified by scripts/fetch-node-sidecar.sh)
shasum -a 256 src-tauri/bin/konsensus-* | awk '{print $1}'
```
**G2 — no non-loopback client before transport confidentiality exists**
```bash
# until a TLS/Noise remote channel ships, the control plane binds loopback ONLY
if grep -REoh 'https?://[^"'"'"' )]*/api/v1' src/ src-tauri/ 2>/dev/null | grep -vE '://(127\.0\.0\.1|localhost)([:/]|$)'; then echo "FAIL: non-loopback control-plane URL"; false; fi
```
**G3 / G4 / honesty ceiling — copy-claims scan (must return NOTHING)**
```bash
grep -REin 'download now|app store|google play|replaces (slack|zoom|workspace)|surveillance-proof|unhackable|node in your pocket|always-on node|call (anyone|any phone)|\bAI (agent|participant)\b' \
  src/ ../Website/src/pages/BitSovRelease/ 2>/dev/null
```
Named "assistant" / "AI assistant" copy is allowed when it accurately describes shipped
abilities. Review user-facing uses of "agent" manually; technical identifiers are not
product copy. This scan does not verify runtime, privacy or spending controls: review
all G4 conditions above separately. `scripts/authority-check.sh` checks existing static
claims only; a pass does not establish compliance with the re-scoped G4.

**G5 — website download gate stays closed until a real signed app binary**
```bash
jq -e '.public_downloads_enabled==false and .public_repositories.app=="" and (.artifacts|length)==0' \
  ../Website/public/bitsov/website-release-metadata.json
```
**G6 — /auth/local hardened before the funds "your bank" framing ships**
```bash
grep -REn 'auth/local' src-tauri/ src/   # confirm app-binding OR an explicit local-trust disclosure
```
**Payment-gate not bypassed (static)** — the only send paths are `/messages/compose` (node-managed)
or `/messages` with a real proof; FAIL if the app builds+delivers an envelope itself.
```bash
grep -REn 'messages/compose|/api/v1/messages\b' src/ | head
```
**Local-auth smoke (runtime, against the running bundled node on its configured port)**
```bash
JWT=$(curl -s -X POST http://127.0.0.1:$PORT/api/v1/auth/local | jq -r .token)
test -n "$JWT" && curl -s -H "Authorization: Bearer $JWT" http://127.0.0.1:$PORT/api/v1/identity | jq -e .node_id
```
Report each as one line in the §E verdict: `<check> → PASS/FAIL`.

## F. Cadence & bootstrap
- **Now:** CS-1 (app shell + node embed + durable two-run identity — `SMOKE: PASS` +
  `SMOKE: IDENTITY_STABLE`; PRs #1/#3) and CS-2 (first-run fund PR #6, restore/restart PR #8) are
  **shipped** on main; the first authority pass ran against CS-1
  (`docs/authority/2026-08-12-cs1-scaffold.md`). `scripts/authority-check.sh` and the compile
  gate (PR #9) run on every PR. Next pass runs against **CS-3 (rooms + conversation UI)** — run
  §G before anything else, against `bitsov-app/docs/API_READINESS.md`.
- **Every milestone merge + weekly** while active. Re-read this file + the goal file + the readiness
  doc each pass; run §G; verify claims against the pinned protocol release, not memory.
- Record each verdict (append to `bitsov-app/docs/authority/` — format §E).
