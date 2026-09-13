# CLAUDE_GOAL_BITSOV_APP — the sovereign conversational client

> Point `/goal` at this file. **Objective (v1): ship the Linux desktop self-host MVP now** —
> a **Linux desktop** app (Linux was the only OS with a signed, released node binary until
> `v0.3.0-rc5`) where a person can **fund their node and start talking**, keys and Lightning
> hidden behind the UX. **Roadmap (preserved, gated):** the same one app extends to **macOS,
> Windows, iPhone, Android** — each unlocked as its **signed node binary + gates** land
> (macOS/Windows node binaries ship since `v0.3.0-rc5` — B10 landed — but are not yet
> notarized / Authenticode-signed). The user carries their own
> **node / bank / (later) AI**, connects to their own node and to others, and
> everything collapses into a conversation organized as **rooms**. Ship human
> connection first (chat, then files/scheduling); **mobile, calls, hosted, and AI stay
> gated behind their blockers (§7)** and are never marketed as shipped before they
> exist. A sovereign, federated network — a person can hold.

**Status:** charter (2026-08-12). Protocol is PUBLIC (source-first developer debut,
`MindLink-ApS/BitSov-bitsov`). This is the *consumer* build that turns the protocol
into a product. Grounded by a 5-agent discovery + adversarial charter audit
(QUALIFIED GO — see the 6 gates below and `CODEX_APP_AUTHORITY.md`).

---

## 0. Immutable constraints (inherit the protocol charter — never violate)
- **Payment IS the connection.** Every inbound unit of work is backed by a settled,
  recipient-bound Bitcoin/Lightning payment. The app hides Lightning behind UX but
  **never** removes or bypasses the per-message gate (`PaymentGate::verify`).
- **No plaintext outside the user's chosen trust boundary.** The protocol is E2EE,
  zero-plaintext end to end (immutable). The app must never leak plaintext or the node
  token beyond the boundary the user has explicitly chosen — **on-device by default**;
  **all remote transport must be confidential** (TLS/Noise — Gate G2). A hosted tier is
  an explicit, disclosed extension of that boundary the user opts into (§4), never the
  default and never blurred into a sovereignty claim.
- **The node is the identity anchor.** The app is a *face*, not the authority.
- **Honesty ceiling.** No "replaces Slack/Zoom/Workspace", no "surveillance-proof /
  unhackable", no "node in your pocket / always-on" before the relay ships, no
  "call any phone" before NAT traversal exists. Vision language stays labeled as vision.

---

## 1. Repo root — CREATE `MindLink-ApS/bitsov-app` (private → public at app launch)
No existing repo is a viable home. Investigated candidates (all rejected):
`bitzov-horizon` (grant/research docs), `MindLink` (company legals), `mindlink-services`
(empty commercial-billing skeleton — README forbids protocol/app source), `mindlink-ops`
(empty infra skeleton). **`bitsov-app` is the already-reserved canonical name** in
`BitSov-bitsov/docs/ops/PUBLIC_REPO_DECISION.md` ("open reference desktop app/client that
consumes the public node API") and `SECURITY.md` (separate-policy "public reference app").

**Clean four-repo boundary — keep it:**
| Repo | Owns |
|---|---|
| `BitSov-bitsov` | protocol (Rust, `konsensus-*`, public) |
| **`bitsov-app`** | **the consumer app (this goal)** |
| `mindlink-services` | commercial billing / relay-subscription (consumes public releases) |
| `mindlink-ops` | deploy / monitoring / secrets |

**Boundary rule (Gate G1):** the app **consumes the public node API over loopback** and
bundles the released `konsensus-node` binary as a supervised subprocess. It does **not**
fork or vendor protocol logic. "Must remain optional" per `PUBLIC_REPO_DECISION.md`.

## 2. Stack — Tauri v2 + SolidJS, node-as-subprocess
- **Tauri v2** (Rust host) → one codebase to iOS + Android + macOS + Windows. Chosen over
  Flutter (keeps team's Rust+TS skills, reuses Website components; Flutter adds Dart) and
  over React Native (loses desktop-from-one-codebase).
- **Frontend:** SolidJS (protocol-doc precedent) — reassess vs React only if the chat/call
  component ecosystem forces it.
- **Node coupling:** bundle + spawn + supervise the `konsensus-node` binary; auth via
  `POST /api/v1/auth/local` on `127.0.0.1`; drive it over the documented HTTP + `/ws`
  surface. **No in-process crate linking** (avoids protocol drift; honors G1).
- **Honest caveat:** Tauri's weak spot (mobile WebRTC calling / background VoIP) is exactly
  the deferred part — fine for chat-first MVP. If mobile media proves painful, the fallback
  is Flutter (keeps clean Rust bridge + desktop), never React Native.

## 3. Product model — rooms, participants, own node/AI/bank
- **Room, not channel.** A room = a set of **participants** (each a `node_id`) + metadata.
  1:1 and many-party are the *same* primitive at different sizes. Do not emulate Slack's
  channel/workspace hierarchy. (Already first-class: `Room{id,members,metadata}`, `/rooms`
  API, UKM kinds 910–914, MLS group crypto 960–962.)
- **Participants inline.** Humans are `node_id` participants today. Every participant carries
  their **own node / bank / (later) AI** into the room — the room owns no accounts; it's a
  convenience view over node-to-node relationships, each member individually payment-gated.
- **AI deferred (Gate G4).** Build the participant model **AI-ready** (a `node_id` may later
  be an AI agent that joins inline **only when explicitly invoked** — never ambient/always-
  listening), but **ship humans-only**. MindLink is not yet an on-prem AI-model company; no
  agent runtime in the MVP. AI slots in later as just-another-node over the same paid lanes.

## 4. Custody tiers — sequenced by what the charter permits today
| Tier | When | Sovereignty | Note |
|---|---|---|---|
| **T-SELF** | **now** | full | desktop bundles + runs the user's own node; keys+plaintext local. Shippable today. |
| **T-PAIRED** | M6 | full (user-custodied) | phone/laptop = remote face of your home node via device attestation; mnemonic never leaves primary device. Needs pairing (unbuilt) + transport confidentiality (G2). |
| **T-HOSTED** | M10 | **reachability convenience, NOT custody** | "MindLink-hosted" means **only** a **ciphertext relay** (keys, funds and the node stay on the user's device; the relay holds ciphertext — disclose what a relay operator can see) or **NaaS** (the user's seed on a box the user controls). **Never a key-holding hosted node**; never "MindLink funds/opens your channels". Matches the genome charter line. |
| **T-PHONE-NATIVE** | M8 | reduced-sovereign | "node in your pocket," reachable via relay+push. **BLOCKED on #216 relay (B1)** — never claim before it's live. |

## 5. MVP — desktop-first, humans-only ("fund your node and start talking")
Ships **now** against the existing protocol surface. Nine-call client contract, keys+invoices
fully hidden: `auth/local` → `identity` (create/restore mnemonic) → `onboarding/start`
(funding-address QR, poll `onboarding/state`) → `payments/open-channel` (liquidity) → `peers`
(add contact + safety number) → `rooms` (+members) → **`messages/compose`** (the one call that
E2EE-encrypts and Lightning-pays per message) → `ws` (live receive, own-node plaintext) →
`messages` (history). Files optional. **Calls are OUT of the MVP contract** (Gate G3).

---

## 6. Milestones (phases)
**Gates G1–G6 (§9) are pass/fail conditions, NOT build steps.** Ordered by dependency; a
phase does not start until its entry gate passes. M-numbers are stable IDs (not order).

| Phase | # | Milestone | Repo | Depends | Entry gate |
|---|---|---|---|---|---|
| **1 · Desktop MVP (ship now · T-SELF)** | M0 | App shell + node embed/supervise; `/auth/local` | bitsov-app | — | **G1** |
| 1 | M1 | First-run fund flow (mnemonic, funding QR, balance) — keys hidden | bitsov-app | M0 | — |
| 1 | M2 | Conversation MVP: rooms + threaded chat + long-form; transparent E2EE; payment-gated send behind one "sending" state | bitsov-app | M1 | — |
| 1 | M3 | Files + calendar/scheduling inline in rooms | bitsov-app | M2 | — |
| **2 · Mobile prerequisites (protocol)** | M5 | Device pairing core (device_attestation L1/L2/L3, DeviceWhitelist, pair routes) | BitSov-bitsov | M1 | **G2** |
| **3 · Mobile** | M6 | Mobile paired companion (iOS+Android as paired thin client) | bitsov-app | M5 | G2 |
| **4 · Reachability & scale** | M7 | Ciphertext relay live (#216): SEAM-B dispatch 600–604 + SEAM-C store, push-wake | BitSov-bitsov | M2 | — |
| 4 | M8 | Phone-native thin node (relay+push) — the honest "node in your pocket" | bitsov-app | M7 | — |
| 4 | M9 | Multi-party meet (MLS 960–962 + relay/SFU fan-out) | bitsov-app | M7 | — |
| **gated track** | M4 | 1:1 VoIP, directly-reachable peers only (kinds 400–403 → WebRTC) — **do NOT market as calling** | bitsov-app | M2 | **G3** |
| gated track | M10 | Hosted convenience tier (ciphertext relay or NaaS only — no key-holding hosted node; disclose relay-operator visibility) | Website/services | M7 | — |
| gated track | M11 | Sovereign AI participant (node_id-as-agent, invoked inline only) | BitSov-bitsov | M6 | **G4** |

## 7. Blockers
- **B1 [critical]** — Ciphertext relay #216 not live (`relay.rs` is R3 SEAM-A engine only, dead_code, default-off). Gates phone-native reachability, offline store-and-forward, push-wake. *The* gating blocker for the phone vision.
- **B2 [high]** — Multi-device pairing is design-only (`REMOTE_ACCESS_IDENTITY.md` specs L1/L2/L3; no `device_attestation.rs`). Only same-key `/auth/token` + loopback `/auth/local` exist → phone-as-remote-face impossible until built.
- **B3 [high]** — Call media transport missing (no WebRTC/RTP/TURN in-repo). Only direct-reachable 1:1 calls; "call any phone" needs NAT traversal (→ B1).
- **B4 [high]** — Mobile-node-vs-paired unresolved: a real node (LDK + esplora + always-listening) can't honestly run reachable on a sleeping/NATed phone → phones ship as paired-thin (B2) or honest-hosted (B5); native is strictly post-relay.
- **B5 [high]** — Honest custody: a key-holding hosted node would see keys+plaintext, so it is **not offered**. "MindLink-hosted" = ciphertext relay or NaaS only (§4), with disclosure of what a relay operator can see; never "MindLink funds/opens your channels".
- **B6 [medium]** — Greenfield: no app repo/code exists; shell + node-embed + first-run funding is the critical path.
- **B7 [medium]** — Payment-UX vs charter: funding is mandatory friction; hide Lightning, never remove the gate.
- **B8 [medium]** — Group-crypto maturity: MLS 960–962 scaffolded; verify production-ready before multi-party meet / large rooms.
- **B9 [low]** — AI-deferral discipline: keep participants as node_ids; do NOT build an agent runtime now.
- **B10 [landed — `v0.3.0-rc5`, 2026-09-03]** — rc4 published only Linux node binaries (`bitsov-linux-x86_64/aarch64`), so CS-1 shipped Linux-only. rc5 (and rc6, 2026-09-13) publish five signed CLI targets — linux x86_64/aarch64, darwin aarch64/x86_64, windows x86_64 — with `SHA256SUMS` signed by release key `B299…EF6E`; the app fetches macOS/Windows sidecars (PR #4) and the CS-1 smoke runs on Linux + macOS (Darwin SKIP retired, PR #9). **Residual:** Darwin/Windows binaries are not notarized / Authenticode-signed (Gatekeeper/SmartScreen block by default), and the standing rule holds — the app must never ship a Mac/Windows build without a verified signed node sidecar.

## 8. Coding sessions (hand to a builder)
**bitsov-app:** CS-1 shell+node embed · CS-2 first-run fund · CS-3 rooms+conversation UI ·
CS-4 transparent E2EE session UX · CS-5 payment-gated send UX · CS-6 files+calendar inline ·
CS-7 1:1 VoIP (direct only) · CS-9 mobile paired-face build.
**BitSov-bitsov (protocol):** CS-8 device pairing core · CS-10 relay dispatch+store (SEAM-B/C) ·
CS-11 relay deploy + push-wake ops · CS-14 AI participant seam (deferred, seam only) ·
**+ new:** room membership propagation (admit/notify/join) + participant-profile endpoint ·
remote transport confidentiality (G2) · `/auth/local` hardening (G6).
**Website:** CS-12 honest hosted tier · CS-13 app landing + download/run-a-node page.

## 9. Charter gates (from the adversarial audit — MUST hold; enforced by `CODEX_APP_AUTHORITY.md`)
- **G1 — API-consumer boundary.** App consumes the public node API over loopback; **no forked/vendored protocol logic, no in-process crate linking.** Decide + document before CS-1.
- **G2 — Remote transport confidentiality.** Build TLS/Noise channel confidentiality **and** per-device delegated auth **before any paired/mobile/hosted client touches a non-loopback node.** `/ws` carries decrypted plaintext and `/auth/local` has no TLS — signing is auth, not encryption. Non-negotiable for zero-plaintext.
- **G3 — Don't market calls.** VoIP (M4/CS-7) is directly-reachable only; **remove "call/meet" from launch copy** until NAT traversal (relay) lands or the direct-only scope is stated plainly.
- **G4 — AI genuinely deferred.** Participants stay node_ids; AI-ready seam only; no agent runtime; no user/website copy implying an AI participant before M11.
- **G5 — Website stays inert.** `/bitsov/app` is a waitlist only; **never** add an app artifact to `website-release-metadata.json` until a real signed app binary exists (the fail-closed gate must flip on real artifacts, never placeholder copy).
- **G6 — Harden `/auth/local`.** App-binding or explicit local-trust disclosure before the funds-holding "your bank" framing ships (any loopback process can currently mint a full node JWT).
- **Also:** room membership is local-only bookkeeping — fix admit/notify/join **or** scope the first ship to 1:1 + already-peered members so "add participant" can't silently fail.

## 10. Website connection (do now, honest + inert)
New page **`/bitsov/app`** (distinct from the CLI `/bitsov/download`): headline *"Coming: fund
your node and start talking,"* inert waitlist (reuse `WaitlistSection` pattern — no "Download
now", no store badges), and a **"Source code"** link to the public repo (decoupled from the
download gate). Set `public_repositories.core` in the metadata; keep `app`/links/artifacts empty
(gate stays closed). Files: `src/pages/BitSovRelease/BitSovApp.tsx` (new), `src/App.tsx` +
`vite.config.ts` BASE_ROUTES (route + prerender), `Navbar.tsx`/`Footer.tsx` (nav entries),
`locales/*.json`, `Download.tsx` (source link), `public/bitsov/website-release-metadata.json`
(core URL only).

## Definition of done (this goal)
`bitsov-app` repo exists with CS-1..CS-6 shipping the desktop MVP (fund → rooms → chat → live
receive, keys hidden, payment-gated) · website `/bitsov/app` live as honest waitlist + source
link · G1–G6 gates satisfied for anything shipped · milestones tracked · Codex authority checks
green. Mobile/paired/hosted/calls/AI remain **gated** behind their blockers and are never
marketed as shipped before they are.
