# BitSov — the sovereign conversational client

**One app — iPhone, Android, Mac, PC — where you fund your node and start talking.**

BitSov is a Bitcoin-anchored sovereign mesh protocol; this repo is its **human-friendly
face**. You carry your own **node / bank / (later) AI**, connect to your own node and to
others, and everything collapses into a conversation organized as **rooms**. Payment is the
connection — reaching you costs a real Bitcoin/Lightning payment you price; the app hides
Lightning and keys behind simple UX.

## Status
Charter set, greenfield. First build: **CS-1 — app shell + node embed** (desktop, T-SELF).
Mobile / paired / hosted / calls / AI are **gated** behind their blockers and are never
marketed as shipped before they exist.

## Boundary (load-bearing — see `docs/ARCHITECTURE_BOUNDARY.md`)
This app **consumes the public BitSov node API over loopback** and bundles the released
`konsensus-node` binary as a supervised subprocess. It does **NOT** fork, vendor, or
in-process-link protocol logic. The app must remain optional to the protocol.

## Stack
Tauri v2 (Rust host) + SolidJS frontend → one codebase to iOS + Android + macOS + Windows.
The Rust host spawns/supervises the node binary and authenticates over `127.0.0.1`.

## Charter & governance
- Live lane ledger: `BOARD.md` (queue-head, blocked, human). Dated tickets: `LEDGER.md`.
- Product charter / milestones / blockers: operator's `CLAUDE_GOAL_BITSOV_APP.md` (also `docs/CHARTER.md`).
- Authority checks (Codex, adversarial): `CODEX_APP_AUTHORITY.md`; verdicts logged in `docs/authority/`.
- Protocol: https://github.com/MindLink-ApS/BitSov-bitsov

## CS-1 local run

The prepared bundled-node pin is `MindLink-ApS/BitSov-bitsov@v0.3.0-rc19.2`,
replacing rc14. rc19.2 is tagged; signing is in progress. All five checksum values are
placeholders; fetch and pre-bundle verification refuse before network access. No rc19.2
release bytes have been verified.
See [the upgrade note](docs/NODE_RC19_2_UPGRADE.md) before enabling the pin.
The release-key fingerprint pin is unchanged. Remote first run is implemented on
main (app #192 + node rc13); runtime acceptance on real hardware (Touch ID + a
fresh Pi) is still pending.

```bash
npm ci
./scripts/fetch-node-sidecar.sh
npm run authority
npm run smoke:cs1
npm run tauri dev
```

### Control center without a node (dev sample mode)

```bash
npm run dev            # open http://localhost:1420 in a browser: sample data, no host, no node
npm run tauri dev      # real host; add ?sample or ?sample=first-run to the URL in a debug build
```

With no Tauri host the shell runs on built-in sample data (`src/control/sample.ts`) and
says so in the rail. A release build inside the host never uses sample data. When the node
fails to start in a debug build, the error screen offers "Explore with sample data".

`npm run smoke:cs1` is the local Linux pass/fail smoke: it starts the signed
node sidecar on loopback, posts to `/auth/local`, reads `/identity`, and prints
`SMOKE: PASS node_id=<node_id>` when the identity path is working.

## Immutable constraints (inherited from the protocol charter)
Payment IS the connection · zero plaintext at any layer (incl. remote transport) · the node
is the identity anchor · honesty ceiling (no "replaces Slack/Zoom", no "surveillance-proof",
no "node in your pocket" before the relay, no "call anyone" before NAT traversal).
