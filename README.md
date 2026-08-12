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
- Product charter / milestones / blockers: operator's `CLAUDE_GOAL_BITSOV_APP.md` (also `docs/CHARTER.md`).
- Authority checks (Codex, adversarial): `CODEX_APP_AUTHORITY.md`; verdicts logged in `docs/authority/`.
- Protocol: https://github.com/MindLink-ApS/BitSov-bitsov

## Immutable constraints (inherited from the protocol charter)
Payment IS the connection · zero plaintext at any layer (incl. remote transport) · the node
is the identity anchor · honesty ceiling (no "replaces Slack/Zoom", no "surveillance-proof",
no "node in your pocket" before the relay, no "call anyone" before NAT traversal).
