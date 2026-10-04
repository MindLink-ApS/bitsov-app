# BitSov design choice board

> **Decided 2026-10-04 (Rasmus):**
> - Direction: **F blend**
> - Type: **Instrument Serif headings + Inter**. He first picked Inter only, then chose to keep the serif after
>   seeing the F onboarding. Machine strings stay in system mono; there is no JetBrains Mono.
> - Colour: **warm dark-first**
> - Motion: **purposeful**
> - Onboarding: **3 focused steps**
>
> Implementation is on `feat/design-ember`.

Rasmus: pick one option per decision (the AskUserQuestion buttons mirror this page). Every screenshot is
in `design/mocks/shots/`, and the clickable mock is `design/mocks/mock.html?d=<A–F>&s=<onboarding|chat|wallet>&t=<light|dark>`.
Typing in a mock composer and pressing Send shows that direction's motion: a sending state, then the settled
payment with the actual routing fee.

Inputs to this board:
- `design/inventory/INVENTORY.md`: 30 current surfaces, light and dark.
- `design/research/DIRECTIONS.md`: sources, licences and Bitcoin Design Guide rules.

## The six directions

| | Onboarding | Chat (priced send) | Wallet |
|---|---|---|---|
| **A. Quiet Instrument**: greyscale tool; orange only where sats move | ![](mocks/shots/A-onboarding-light.png) | ![](mocks/shots/A-chat-light.png) | ![](mocks/shots/A-wallet-light.png) |
| **B. Ledger Paper**: green ledger paper, navy ink, a receipt under every message | ![](mocks/shots/B-onboarding-light.png) | ![](mocks/shots/B-chat-light.png) | ![](mocks/shots/B-wallet-light.png) |
| **C. Wallet-native**: Bitcoin Design Guide made visible, with big balance, unit toggle and fee review row | ![](mocks/shots/C-onboarding-dark.png) | ![](mocks/shots/C-chat-dark.png) | ![](mocks/shots/C-wallet-dark.png) |
| **D. Signal-clear**: bright consumer messenger; price on the Send button | ![](mocks/shots/D-onboarding-light.png) | ![](mocks/shots/D-chat-light.png) | ![](mocks/shots/D-wallet-light.png) |
| **E. Command Deck**: dense, keyboard-first node console | ![](mocks/shots/E-onboarding-dark.png) | ![](mocks/shots/E-chat-dark.png) | ![](mocks/shots/E-wallet-dark.png) |
| **F. Ember 2.0**: today's warm BitSov on accessible scales; orange kept for money | ![](mocks/shots/F-onboarding-dark.png) | ![](mocks/shots/F-chat-dark.png) | ![](mocks/shots/F-wallet-dark.png) |

Each direction also has the other theme (`*-light.png` / `*-dark.png`).

## Trade-offs

| | Strength | Risk | New deps |
|---|---|---|---|
| A | Price signal is unmistakable; calm; fast to build | Can feel cold or like a developer tool to consumer testers | Geist + Geist Mono fonts (OFL, about 100 KB local) |
| B | Warmest and most explanatory; receipts make "payment is the connection" literal | Low density for heavy chat; the most work | Fraunces + IBM Plex (OFL, about 200 KB) |
| C | Best money clarity (Bitcoin Design Guide units, fees, custody) | Reads as "a wallet with chat" | Inter (OFL, about 70 KB) |
| D | Most "modern messenger"; directly answers test #5 | Friendliness can imply guarantees we can't make; generic | Inter (OFL, about 70 KB) |
| E | Ideal for node operators | Wrong for the test #5 audience; better as a later "advanced" mode | Inter + JetBrains Mono (OFL) |
| F | Keeps brand recognition; lowest risk; no architecture change | Least visibly new | Instrument Serif + Inter + JetBrains Mono (OFL, about 180 KB) |

No direction needs a JavaScript dependency. Motion uses plain CSS, WAAPI and View Transitions, and
`prefers-reduced-motion` turns movement into fades. Fonts would ship as local `woff2` files in the bundle
(Tauri and the CSP must not fetch Google Fonts at runtime). That is the only "heavy" addition, at roughly
70–200 KB. Kobalte (MIT, headless Solid) stays optional and is not proposed for the first PRs.

## Doctrine check (applies to all mocks)

- **Prices are ceilings.** Every mock shows "up to 7 sats" with the breakdown: peer price, routing at most 5, total
  at most 7. Settled messages show the actual amount ("3 sats, 2 + 1 routing").
- **Unknown stays unknown.** Spendable, reserved and closing amounts say "Not reported". "New contact" shows "price
  unknown". No fiat value is shown without a rate.
- **Custody.** The only label is "Self-custody, this Mac / your server". No hosted option is shown, because the app has
  none today.
- **No connection claims.** Mocks say "last paid message 10:21", never "connected" or "online".
- **No account or server wording.** The node is "yours"; the B onboarding says "No account, no company in between".

## Decisions

1. **Overall direction**: A / B / C / D / E / F / a blend.
2. **Typography**:
   - Instrument Serif + Inter + JetBrains Mono (F)
   - Geist + Geist Mono (A)
   - Fraunces + IBM Plex (B)
   - Inter only (C/D)
3. **Colour and theme**:
   - warm dark-first with an equal light theme (F)
   - cool greyscale light-first (A)
   - ledger green paper (B)
   - neutral with Bitcoin orange (C/D)
4. **Motion level**:
   - none
   - **purposeful**: message enter, a payment-settle highlight, panel and popover transitions, view transitions
     between sections, about 150–250 ms
   - expressive: springs, balance count-up, bolt pulse
5. **Onboarding structure**:
   - 3 focused steps with one choice per screen (A/F)
   - conversational (D)
   - editorial pages with a side explainer (B)
   - persistent checklist + ⌘K (E)

## Recommendation

**F. Ember 2.0, with A's discipline, C's money rules and D's motion.**

- **Base: F.** Keep the warm-dark identity and the serif wordmark. Rebuild colours on Radix sand/orange scales (MIT) so
  contrast passes in both themes, and give the light theme equal care.
- **From A: orange means money, and nothing else.** Today orange marks brand, buttons, outgoing bubbles, price
  chips and warnings, so it stops telling you anything. Under this rule:
  - primary buttons go neutral
  - outgoing bubbles become a warm dark tint
  - orange is reserved for prices, the send action and the wallet
- **From C: the fee breakdown and unit rules.**
  - The price chip opens "peer price / routing at most / you pay at most".
  - Settled messages show actual cost.
  - Use tabular numbers everywhere.
  - Unit toggle on the balance.
- **From D: purposeful motion.**
  - bubble enter
  - "sending → settled" highlight
  - popover and panel transitions
  - nothing ambient except the onboarding glow
- **Onboarding: 3 focused steps.**
  1. Where your node runs
  2. Identity
  3. Add sats (optional)
  - Remote pairing becomes a second screen of step 1, not the same long page.
- **E later**, possibly as an "advanced" density setting.

Implementation plan after the pick (branch `feat/design-<name>`, small draft PRs, each needing Fable + Grok review):
1. Tokens: new `:root` scales and semantic tokens (`--money`, `--paid-bg`, `--unknown-ink`), local fonts and a
   reduced-motion base. Visual only; no markup changes.
2. Onboarding: 3-step structure. All `data-*` hooks and capability gates are kept.
3. Home and rail.
4. Chat and composer: price chip + breakdown and motion. Send/pay logic is untouched.
5. Wallet.

`npx vitest run` and `npm run build` must pass on every PR.
