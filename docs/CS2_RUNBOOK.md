# CS-2 runbook — first-run fund flow (M1)

**Scope (only):** create-or-restore identity → local-trust disclosure → start the tier-`full`
onboarding for an amount → show the deposit address (text + QR) → poll until the node reports
`funding-seen` → show the balance. No channel opening, no pricing, no rooms, no messaging,
no mobile, calls, hosted, or AI.

Builds on CS-1 (`docs/CS1_RUNBOOK.md`): the Rust host already bundles + supervises the node
sidecar, mints a loopback JWT via `/auth/local`, and reads `/identity`.

## The flow

1. **Identity.** `konsensus init` created one on first run (CS-1). To adopt an existing one
   instead, the recovery-phrase form calls `POST /api/v1/identity/restore {mnemonic}`; the node
   answers `restart_required: true`, and the host restarts the sidecar it already supervises —
   **same data dir, no re-init** (a re-init would mint a fresh identity over the restored one).
   CS-2.1: if a node is already healthy on `127.0.0.1:3141` the host **adopts** it (re-auth,
   re-read `/identity`, `ready`) instead of waiting out a health drop that never comes.
2. **Local-trust disclosure (Gate G6).** The funding UI is unreachable until the user reads and
   accepts it. See "Why the disclosure is not optional" below.
3. **Start funding.** `POST /api/v1/onboarding/start {tier: "full", funding_amount_sats: <u32>}`.
   The node returns the onboarding record with `current_step: "funding"` and a `funding_address`.
4. **Deposit.** The address is shown as selectable text **and** as a QR. `GET /payments/funding-address`
   (`{address, network, note}`) is the fallback if the onboarding record carries no address.
5. **Poll.** `GET /api/v1/onboarding/state` every 3s, showing `funding_amount_sats_received` of
   `funding_amount_sats_required`, until `current_step` is `funding-seen`. The node runs its own
   wallet poll every 10s and flips the step itself; the app only reads it.
6. **Balance.** `GET /api/v1/payments/balance` → `{balance_msat}`, displayed in sats.

## Run it

```bash
npm ci
./scripts/fetch-node-sidecar.sh     # fetch + VERIFY the signed node (Linux hosts today)
scripts/authority-check.sh          # must print AUTHORITY: PASS before you build
npm run smoke:cs2                   # static binding checks — runs on any OS
npm run tauri dev
```

`npm run smoke:cs1` (durable identity, **Linux-only**, `SKIP` exit 2 elsewhere) is unchanged.

## Boundary (do not break)

- **G1** — node stays a bundled binary; no `konsensus-*` crate dependency; the shell capability
  stays scoped to the `konsensus` sidecar.
- **G2** — the control plane is `127.0.0.1:3141` only. The renderer makes **no** network calls:
  every node interaction is a Tauri command (`fund_state`, `fund_start`, `funding_address`,
  `payments_balance`, `identity_restore`, plus CS-1's `node_status`).
- **Keys** — the JWT lives in the Rust host and is attached there. No command response type
  carries a token, mnemonic, or private key, and the app never asks for the seed
  (`/identity/mnemonic` needs a fresh signed challenge and is not called). The recovery-phrase
  input is write-only: masked, `autocomplete="off"`, cleared the moment it is submitted.
- **Pinned contract** — BitSov-bitsov `v0.3.0-rc5` / `1ae4d8c9`. The `funding-seen` literal lives
  in `src-tauri/src/main.rs` only; the renderer reads a derived `funded` boolean.

`scripts/cs2-local-smoke.sh` enforces all of the above statically, and
`scripts/authority-check.sh` gained a G6 check plus a renderer-isolation check.

## Why the disclosure is not optional (Gate G6)

`CODEX_APP_AUTHORITY.md` §B G6: before the funds-holding framing ships, `/auth/local` must be
app-bound **or** carry an explicit local-trust disclosure — today any loopback process can mint a
full node JWT and drain the wallet. CS-2 ships the disclosure, not app-binding: the funding UI is
gated behind an acknowledgement that names the risk in plain language. App-binding `/auth/local`
is node-side work and remains the durable fix.

## QR rendering

`src/qr.ts` is a ~300-line QR encoder (byte mode, EC level M, versions 1–10) vendored on purpose:
the deposit address is the money-critical pixel on the screen, so the code that draws it stays
auditable in-tree instead of being a third-party package that could re-encode a different address.
It was differential-tested against `python-qrcode` — **18/18 exact matrix matches** across versions
1–10, every block structure, and P2PKH/P2SH/bech32/taproot/testnet/regtest addresses — and the QR
as rendered in the app decodes back to the displayed address under a platform barcode scanner.

The address is always shown as text beside the QR: **the text is authoritative, the QR is a
convenience.** Rendering is inline SVG, so the CSP needs no `img-src data:` relaxation.

## Known gaps (by design, not defects)

- **No channel yet.** `funding-seen` means the node observed the deposit. Opening a channel
  (`/payments/open-channel`) and paid messaging are M1/M2, deliberately out of CS-2.
- **Funding is on-chain.** Confirmation latency is the chain's, not the app's; the screen says so.
- **Restore is pre-funding.** The recovery form lives on the identity screen, before money exists
  on the node. Restoring after funding would swap the identity out from under a funded wallet.
- **Darwin still has no signed node sidecar**, so the CS-1 runtime smoke stays `SKIP` (exit 2)
  there. The CS-2 smoke is static and runs everywhere.
