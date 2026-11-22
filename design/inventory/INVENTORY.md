# BitSov UI inventory (2026-10-03, `main` @ b5259b1)

Captured from `npm run dev` in **sample mode** (`?sample`, `?sample=first-run`, no node, no host) at 1280×820,
dark and light. Regenerate with:

```bash
PLAYWRIGHT_DIR=/path/to/node_modules/playwright node scripts/design/capture-inventory.cjs
```

Every file exists as `NN-name-dark.png` and `NN-name-light.png`.

| # | Surface | What is on it | Design notes (test #5 lens) |
|---|---------|---------------|-----------------------------|
| 01 | Onboarding: first run | Left rail with empty states; "Your node, your seat" serif title; 3 node-location cards (This computer / A node on my network / A cloud node); 4-step list (Start node · Pair this app · Create or restore identity · Fund); "This app is paired" card | Long single scroll: location choice, a progress list and the pairing status all on one page. Rail is shown but empty ("Available after setup"). Copy is technical ("Loopback authenticated", "file-backed"). |
| 02 | Onboarding: scrolled | Pairing card, access line (read + receive), identity/fund steps further down | Most of the page is below the fold, so there is no clear single next action. |
| 03 | Onboarding: cloud chosen | Same page, cloud card selected, paste-link field | The remote choice reuses the long page instead of a focused step. |
| 10 | Chat (Robin) | Header (name, truncated id, call/video/meeting/settings icons); STUN warning; date chips; bubbles (incoming grey, outgoing orange-red) with "⚡2 sats 10:12" under each; composer (emoji, input, mic, +, Send); "up to 7 sats · includes max routing fee"; ▸ⓘ toggle; **Approval needed** budget band (Careful / Everyday / Generous); "Check pending result" | Warm and functional. Three stacked bands under the composer (price, info toggle, approval) feel heavy. The STUN note sits above every chat. Nothing moves. |
| 11 | Emoji picker | 5×5 grid popover | No enter animation. |
| 12 | More menu | Pay / Request / Attach | Plain list; no icons. |
| 13 | Cost & rules expanded | "Cost to send 7 sats · Robin's price, updated…" | The useful breakdown is hidden behind a tiny ▸ⓘ. |
| 14 | Composer typed | Draft text in field | — |
| 15 | Chat (Kim): price unavailable | "price unavailable · peer has not shared a price · Retry", Send disabled | Unknown stays unknown, which is good. The Retry link is small. |
| 16–17 | Empty chats | "Nothing here yet / Your first message … is a paid first contact" | A good honest empty state; the typography is the strongest part of the app. |
| 18 | Contact panel | Petname field, fingerprint verify grid, QR, "Mark verified" | Dense. The fingerprint grid is hard to scan. |
| 20–21 | Call / video confirm | Popover "Calling Robin … Calls may not connect across networks…" + Cancel | Warning copy is repeated in several places. |
| 22 | Meeting planner | Checkbox list of contacts, price note, Invite / Video invite / Cancel | Small popover crammed into the bottom-right corner. |
| 23 / 40 | You popover | Wallet 482,500 sats · Profile and settings | Fine; could be a proper menu with icons. |
| 30 | Ask your node (AI) | Mode pills (On this computer / Shared open model / Frontier), suggestion chips, composer | Monospace badges in the header feel like a debug UI. |
| 31–32 | Browse: Profiles / Porch | Paste profile link field; Porch explainer | Very sparse: a text wall plus one input. |
| 33 | + New | "Start something": share node id (QR + id), starter bitcoin request, invite someone | Three unrelated ideas on one page. |
| 36 / 50–54 | Settings modal (Body / Node / Wallet / Budget / Profile tabs) | Display (theme, units), Calls STUN, then tab content: metabolism / membrane panels (Body), node facts (Node), wallet summary (Wallet), app payment budget (Budget), front-door card editor (Profile) | Display + Calls repeat at the top of **every** tab. Biology vocabulary (metabolism, membrane) is distinctive but opaque to testers. |
| 41 | Wallet: Activity | "Node-reported total 482,500 sats", 3 Unknown tiles (Spendable / Reserved / Closing), two notes, Receive / Send, tabs, filter chips, activity list | Honest about unknowns. The hero is good; the three "Unknown" tiles take a lot of space. |
| 42 | Wallet: Channels | Per-channel capacity bars (send / receive / size) | Readable. Uses raw "Unnamed contact (02a1…)" names. |
| 43 | Wallet: Receive | Lightning / On-chain toggle, amount, "What for?", Create invoice | Fine. Low hierarchy. |
| 44 | Wallet: Send | Amount, invoice/node field, "Total at most", Approve spending, Touch ID link | The ceiling wording is good. |
| 60 | Organism v2 (Body) | Metabolism bar chart, per-peer energy | Most "designed" surface; it is buried in settings. |

**Not reachable in sample mode:** Welcome home (`WelcomeHome.tsx`, shown only when no chat is open; sample mode
opens the first peer automatically), the node-unavailable SoftError, incoming call / meeting panels, room panels
(sample node reports no room support), the Gate G6 identity disclosure (accepted automatically in `?sample`).

## Cross-cutting observations

1. **Type:** a serif display (New York / Iowan) plus `system-ui` and mono. The serif headings carry the brand
   well, but body text is small (12–13 px) with low contrast for muted text.
2. **Colour:** a single warm-brown dark palette with orange used for brand, buttons, outgoing bubbles, price
   chips *and* warnings. Orange means everything, so it means nothing in particular. The light theme is a straight
   inversion.
3. **Hierarchy:** chat has up to four stacked bands under the composer. Settings repeats global prefs on every
   tab.
4. **Motion:** none, apart from the spinner.
5. **Copy:** honest but technical ("Loopback authenticated", "STUN", "membrane", "msat").
6. **Strengths to keep:** honest unknowns, "up to N sats" ceilings, the paid-first-contact empty state, and the
   serif identity.
