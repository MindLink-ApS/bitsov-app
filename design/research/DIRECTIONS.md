# BitSov design directions: research (2026-10-03)

Licences were checked on 2026-10-03 against GitHub (`license.spdx_id` plus the LICENSE file itself) and the npm
registry. Proprietary products are studied for **patterns only**. No assets or code are copied from them.

## 1. Licence-checked sources

| Source | Repo | Licence | Reusable | Notes |
|---|---|---|---|---|
| Radix Colors | https://github.com/radix-ui/colors | MIT | 12-step light/dark scales (copy the hex values; no package needed) | Best palette base |
| Open Props | https://github.com/argyleink/open-props | MIT | Easings, spring curves, shadows, radii | Copy only the tokens used |
| Kobalte | https://github.com/kobaltedev/kobalte | MIT | Headless Solid Dialog, Popover, Combobox, Tabs, Toast, Tooltip | Stable 0.13.x; a 2.0 alpha is out, so expect API churn |
| Ark UI | https://github.com/chakra-ui/ark | MIT | Headless with Solid support; QR Code, Pin Input, Steps, Clipboard | Built on Zag state machines; heavier |
| corvu | npm `corvu` | MIT | Small Solid Dialog, Drawer, Resizable | Light alternative |
| shadcn-solid / solid-ui | github.com/hngngn/shadcn-solid, github.com/stefan-karger/solid-ui | MIT | Component structure | Assumes Tailwind, so use them as reference only |
| Catppuccin | https://github.com/catppuccin/catppuccin | MIT | Palette values | Reads as "developer" |
| Primer primitives | https://github.com/primer/primitives | MIT | Token architecture ideas | The package is 56 MB, so copy ideas, not the package |
| Carbon | https://github.com/carbon-design-system/carbon | Apache-2.0 | Motion model ("productive" vs "expressive") | Pattern reference |
| Inter | https://github.com/rsms/inter | OFL-1.1 | Font, tabular numbers | |
| Geist / Geist Mono | https://github.com/vercel/geist-font | OFL-1.1 | Fonts | Use @fontsource. The `geist` npm package peer-depends on Next.js |
| IBM Plex | https://github.com/IBM/plex | OFL-1.1 | Sans, Serif, Mono | |
| JetBrains Mono | https://github.com/JetBrains/JetBrainsMono | OFL-1.1 | Mono | |
| Instrument Serif | https://github.com/Instrument/instrument-serif | OFL-1.1 | Display serif (about 144 KB) | Regular and italic only |
| Fraunces | https://github.com/undercasetype/Fraunces | OFL-1.1 | Variable soft serif (opsz/SOFT/WONK axes) | Subset it to Latin |
| Lucide | https://github.com/lucide-icons/lucide | ISC + MIT (Feather part) | Icons (`lucide-solid`) | Keep both notices |
| Phosphor | github.com/phosphor-icons/core | MIT | Icons in 6 weights | Inline the SVGs |
| Tabler Icons | https://github.com/tabler/tabler-icons | MIT | `@tabler/icons-solidjs` | |
| Bitcoin Icons | https://github.com/BitcoinDesign/Bitcoin-Icons | MIT. ₿ is public domain. The **sat symbol is CC-licensed (the variant is unstated)** | Lightning, node, channel, key, QR icons | Check the sat-symbol terms before using it |
| Bitcoin Design Guide | https://github.com/BitcoinDesign/Guide | Apache-2.0 OR MIT for text; **CC-BY-4.0 for images** | Patterns; illustrations with attribution | |
| Bitcoin UI Kit (Figma) | https://www.bitcoinuikit.com | CC-BY-4.0 | Design reference only (no web code) | |
| Motion One / `@motionone/solid` | motiondivision/motionone | MIT, **archived / deprecated** | — | Do not adopt |
| solid-motionone | solidjs-community/solid-motionone | MIT | `<Motion>`/`<Presence>` | Depends on the archived `@motionone/dom` |
| `motion` (`motion/mini`) | https://github.com/motiondivision/motion | MIT | Tiny WAAPI `animate()` | Use it only if springs are needed |

**Motion recommendation for every direction: no dependency.** Use CSS transitions and keyframes,
`@starting-style`, the View Transitions API (Safari 18+, which is current macOS WKWebView) and WAAPI
`element.animate()`. Under `prefers-reduced-motion: reduce`, transforms become fades of 120 ms or less. Payment
feedback must never depend on motion alone: always pair it with a text change.

## 2. Bitcoin Design Guide rules that apply to every direction

- **Units** (https://bitcoin.design/guide/designing-products/units-and-symbols/):
  - Default to sats for Lightning.
  - Allow changing the unit in context (tap the balance to cycle sats → ₿ → hidden).
  - Use locale separators via `Intl.NumberFormat` and tabular figures.
  - Show fiat only when a rate is actually known, and never as `$0.00`.
- **Fees** (https://bitcoin.design/guide/daily-spending-wallet/sending/send-fees/):
  - Show routing fees separately, with an expandable explanation.
  - Flag, calmly, when the fee is a large share of the amount (≥ 50 %).
  - Keep fee customisation out of the main flow.
  - For BitSov: show "2 sats to Maya + up to 5 routing = up to 7 (ceiling)", then after settling show the
    actual amount, for example "Paid 3 sats (2 + 1 routing)".
- **First use** (https://bitcoin.design/guide/daily-spending-wallet/first-use/):
  - Use a flexible happy path where steps can be skipped, with reminders for any important step that was skipped.
  - Introduce information when it becomes relevant.
  - Don't hide the responsibility of self-custody.
  - Explain first-funding fees when the funds arrive.
- **Principles, nodes, LSPs, contacts:**
  - https://bitcoin.design/guide/getting-started/principles/
  - https://bitcoin.design/guide/how-it-works/nodes/
  - https://bitcoin.design/guide/how-it-works/lightning-services/
  - https://bitcoin.design/guide/daily-spending-wallet/contacts/
  - Honest custody labels; human petnames first and the fingerprint second; never auto-adopt a name a peer
    claims for itself.

## 3. Directions

| | A. Quiet Instrument | B. Ledger Paper | C. Wallet-native | D. Signal-clear | E. Command Deck | F. Ember 2.0 |
|---|---|---|---|---|---|---|
| Inspiration (patterns only) | Linear, Things, Raycast, Vercel | iA Writer, Readwise Reader, Stripe receipts | Phoenix, Breez, Muun, ZEUS, Bitcoin UI Kit | Signal, Telegram, iMessage, Arc onboarding | Raycast, Linear ⌘K, Superhuman, ZEUS advanced | Current BitSov + Arc warmth, Things polish, Phoenix calm |
| Palette | Radix slate greys; **orange only for money** (`#f76b15`) | Paper `#fbf8f3`; burnt orange `#c2561a`; "lamp" dark `#16130f` | White / near-black; Bitcoin orange `#f7931a` as fill only; amber for in-flight | White / `#111113`; orange outgoing bubbles | Catppuccin Mocha/Latte or Radix slate; peach for sats | Radix sand + orange scales mapped onto today's tokens |
| Type | Geist + Geist Mono | Fraunces + IBM Plex Sans/Mono | Inter (tnum) | Inter 15 px | Inter 13 px + JetBrains Mono | Instrument Serif + Inter + JetBrains Mono |
| Radius / density | 6–10 px, medium-high | 10–14 px, low | 12–16 px pills, low-medium | 18–20 px bubbles, medium | 4–6 px, high | 10–16 px, medium |
| Motion | 120–180 ms; price chip morphs to "paid" | 220–320 ms; a receipt slides up on settle | Balance tween, bolt pulse while routing | Bubble spring of about 300 ms, "paid" stamp | Almost none (80–120 ms) | Bubble enter, "ember" price chip settles, skeleton shimmer, view transitions |
| Onboarding | One centred card, 3 steps, dots | One idea per page, plain-language side note | Start node → Add sats → First contact, custody chips | Conversational cards, "What's this?" links | Persistent sidebar checklist + ⌘K | 3 focused steps, custody chips |
| Price line | Mono pill `up to 7 sats` with a breakdown popover | Italic note; receipt footer per message | Review row (message / routing / max) | Price on the Send button | Status-bar segment | Mono chip with a breakdown popover |
| Wallet | Big mono balance, custody chip, tabular activity | Serif balance, ruled ledger | Hero balance, unit toggle, Receive/Send, liquidity bar | Compact card + sheet | Table-first, liquidity bars | Serif balance hero, ember activity list |
| Required deps | Fonts about 60–120 KB | Fonts about 150–250 KB | Inter about 70 KB; optional Ark UI | Inter about 70 KB; optional Kobalte/corvu | Fonts about 100 KB; Kobalte Combobox | Fonts about 150–200 KB |
| Risk | Can feel cold, like a developer tool | Low density for heavy chat | Looks like "a wallet with chat" | Friendliness may imply guarantees we can't make | Alienates non-technical testers | Least visibly new |
| Fit (1–5) | 4 | 3 | 4 (rules: 5) | 4 | 3 (as a mode) | 5 |

Detailed palettes are in `design/mocks/directions.js` (the source of truth for the mocks).

## 4. Researcher's recommendation

Use **F as the base**, with A's discipline (orange reserved for money), C's Bitcoin Design rules (units, fee
breakdown, progressive onboarding, custody chips) and D's motion and bubble polish. E becomes an optional dense
mode later.

Cross-cutting components to build whichever direction is chosen:
- a two-layer token model (scale tokens → semantic tokens such as `--price-ink`, `--paid-bg`, `--unknown-ink`)
- one `<Sats>` amount component that handles ceiling, actual, unknown ("—") and hidden
- one custody chip with a fixed vocabulary

If one headless dependency is allowed, choose Kobalte.
