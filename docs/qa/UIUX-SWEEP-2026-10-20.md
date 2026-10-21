# UI/UX sweep — 2026-10-20

Walk of the BitSov web shell in dev sample mode (`npm run dev`, `?sample` / `?sample=first-run` / `?sample&peers=0`) plus a stubbed host for screens sample mode cannot reach (locked node, offline node, pairing failure, add-device QR, four comparison words). Desktop 1280×820, phone 390×844, and a 320×700 check. Dark and light. Tokens in `src/styles.css` (`--s-*` 4px grid, type scale `--t-xs` 11.5px through `--t-display` 40px, orange `--money` only where sats move).

Contrast was measured against WCAG AA (4.5:1 for text under 18px, 3:1 for large text). Axe (`wcag2a` / `wcag2aa`) was run on the same pages. Screenshots under `docs/qa/screenshots/` are the sweep captures (the bugs, before the fixes in this change).

Not in this walk: the Tauri host, the iOS/Android shells as native apps (the phone width is the web layout those shells use), and `assistant.html` (it only renders rows the host injects).

## Counts

| Severity | Found | Fixed here | Left as findings |
| --- | ---: | ---: | ---: |
| High | 2 | 2 | 0 |
| Medium | 11 | 8 | 3 |
| Low | 14 | 9 | 5 |
| **Total** | **27** | **19** | **8** |

## Findings

### 1. Composer “+” disappears on hover

- **Screen:** Chat composer (dark and light)
- **Severity:** High
- **Screenshot:** `docs/qa/screenshots/chat-more-plus-hover-dark.png`
- **What:** `.attach.soft:hover` set `color: var(--accent-ink)` on `background: var(--line-strong)`. That ink is for orange fills. Measured 1.69:1 in dark (`#1a0f05` on `#423a32`) and 1.60:1 in light (`#ffffff` on `#d0ccc4`).
- **Fix:** Hover uses `color: var(--ink)`. The recording pill still uses accent ink on the orange fill.

### 2. Touch ID check fails contrast in dark mode

- **Screen:** Onboarding, selected “This Mac” card
- **Severity:** High
- **Screenshot:** `docs/qa/screenshots/onboarding-dark.png`
- **What:** `.touchid-check` was white `#fff` on dark-theme `--ok` `#5bc98a` (2.07:1) at 10px.
- **Fix:** The check uses `color: var(--bg)` (9.12:1 dark, about 5.8:1 light). The glyph stays 10px so it fits the 16px disc (see 24).

### 3. “Node locked” is under AA in light mode

- **Screen:** Locked node
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/locked-light.png`
- **What:** `.target-badge.honest` is `--warn` `#8a6500` on a 14% warn tint. 4.24:1 at 11.5px.
- **Fix:** Light-theme honest/warn badges use `#6b4c00` (6.28:1 on the tint).

### 4. “Encrypted seed” pill is under AA in light mode

- **Screen:** Wallet
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/wallet-light.png`
- **What:** `.contact-pill.ok` paints `--ok` on a 16% green tint. Axe reported a serious contrast failure on the light wallet. On white the same green is 5.58:1; on the tint it falls to about 4.65:1, which axe still flagged.
- **Fix:** Light-theme ok pills and target badges use `#146338` (5.83:1 on the tint).

### 5. Amount field has no focus ring

- **Screen:** Wallet → Receive and Send
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/wallet-receive-dark.png`
- **What:** `.amount-field .amount-input:focus { outline: none }` beat the global `:focus-visible` rule, so the amount people type had no visible focus.
- **Fix:** `:focus-visible` draws a 2px accent outline. The field still has no extra border while focused, so the number layout stays put.

### 6. Emoji picker is an invalid listbox

- **Screen:** Chat, emoji popover
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/chat-emoji-dark.png`
- **What:** `role="listbox"` with `<button>` children. Axe: critical `aria-required-children`.
- **Fix:** `role="group"`. The buttons stay buttons.

### 7. Metabolism grid used broken table roles

- **Screen:** Settings → Body
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/settings-body-dark.png`
- **What:** `role="table"` with `columnheader` / `rowheader` spans and no rows. Axe: critical `aria-required-parent` / `aria-required-children`.
- **Fix:** A real `<table class="energy">` with a screen-reader header “Direction”. Same figures, same accent colour.

### 8. Phone rail clips “Ask your node” and “Profiles”

- **Screen:** Inbox rail below 680px
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/chat-phone-dark.png`
- **What:** The rail becomes a horizontal scroller, but `.track-link` is `width: 100%` and `.name` is `flex: 1; min-width: 0`, so the labels ellipsize instead of scrolling. Measured on “Ask your node” and “Profiles”. Desktop still ellipsizes long peer names inside the 248px rail (see 22).
- **Fix:** Under 680px, rail links are `width: max-content` and the name does not ellipsize.

### 9. Add-a-device copy names a control that is not on screen

- **Screen:** Settings → Devices, pairing ticket (QR + four words)
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/pairing-qr-dark.png`
- **What:** The ticket said to choose “Use a node you already run at home”. The control is the disclosure summary “Advanced: use a node you already run at home”.
- **Fix:** The sentence quotes that summary. The four-word comparison itself (order, Touch ID, “Words differ”) matched the steps and was left as-is.

### 10. Denomination hint says “millisatoshis” without relating it to sats

- **Screen:** Settings → General
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/settings-general-dark.png`
- **What:** The Sats/BTC toggle was followed by “Payment amounts to the node stay in millisatoshis.” The word never appears elsewhere in the UI.
- **Fix:** “Your node still counts each payment in millisatoshis (1 sat = 1,000).”

### 11. Every load logs a favicon 404

- **Screen:** All routes
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/onboarding-dark.png` (console, not the picture)
- **What:** `index.html` had no icon, so the browser requested `/favicon.ico` and logged a 404.
- **Fix:** Inline SVG favicon. No network request.

### 12. Connection card used a token that does not exist

- **Screen:** Settings → Node
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/settings-general-dark.png` (same sheet; Node tab uses the card)
- **What:** `border-radius: var(--r-md, 10px)`. `--r-md` is not in the scale. `--r-control` is 10px.
- **Fix:** `var(--r-control)`.

### 13. Live-node dot glow was a different green than `--ok`

- **Screen:** Rail, node pill and peer dots
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/chat-maya-dark.png`
- **What:** The glow was `rgba(79, 191, 123, …)`. `--ok` in dark mode is `#5bc98a` (91, 201, 138).
- **Fix:** `color-mix` with `var(--ok)`.

### 14. Selecting a node location used the money colour

- **Screen:** Onboarding
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/onboarding-dark.png`
- **What:** The selected card’s border, icon, and radio used `--money`. The token note says orange is only where sats move. This is the first screen, so orange read as “selected”, not “payment”.
- **Fix:** Selection uses `--ink` with a `--bg` check.

### 15. Welcome home says the app cannot scan a camera

- **Screen:** Welcome home (`?sample&peers=0`)
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/welcome-dark.png`
- **What:** “Camera scanning is not available in this app.” Pairing on desktop and Android can scan a QR. Profile cards are paste-only.
- **Fix:** “Camera scanning is not available for profile cards.”

### 16. Several reading sizes sat below the type scale

- **Screen:** AI provider meta, sample tag, refusal counts, profile link, media captions, coming-soon badge
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/settings-body-dark.png`
- **What:** 10px and 11px text. The scale starts at `--t-xs` (11.5px). Combined with `--faint` / `--muted` this is the small type the inventory already called hard to read.
- **Fix:** Those reading styles use `var(--t-xs)`. Disc glyphs are unchanged (23, 24).

### 17. The wallet total was off the type scale

- **Screen:** Wallet
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/wallet-light.png`
- **What:** `.wallet-total` was a raw 64px. `--t-display` stops at 40px.
- **Fix:** Named `--t-hero: 64px` and used it. The size is unchanged.

### 18. Error chrome used a red that is not `--err`

- **Screen:** Failed send artifact, refused door card
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/chat-maya-dark.png` (token; the refused state is on the organism view)
- **What:** Hardcoded `rgba(217, 96, 63, …)`. `--err` is `#ec7356` / light `#c0391f`.
- **Fix:** `color-mix` with `var(--err)`.

### 19. An empty local-model list was a listbox with no options

- **Screen:** Ask your node, local server running but no models yet
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/chat-maya-dark.png` (the assistant track; the empty list is the same control)
- **What:** `role="listbox"` while `models` is empty fails `aria-required-children`.
- **Fix:** `role="group"` until there is at least one option.

### 20. The chat stream is not a keyboard scroll region

- **Screen:** Chat, especially under 680px
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/chat-phone-dark.png`
- **What:** Axe serious `scrollable-region-focusable` on `.stream`. Keyboard users cannot move the history without tabbing into a control inside it.
- **Fix:** Not changed. Adding `tabindex="0"` inserts a new tab stop and changes keyboard order. `npm run a11y` disables this one rule and points here.

### 21. The hub disclosure says MindLink, the product says BitSov

- **Screen:** Locked node, and Settings → Node when the hub note is open
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/locked-light.png`
- **What:** The title is “What MindLink's hub can and can't do”. Every other screen says BitSov. `HubTrust.tsx` marks the sentences as approved copy.
- **Fix:** Not changed. Renaming the hub is a product decision, not a typo fix.

### 22. The rail hides the part of an unnamed contact that tells them apart

- **Screen:** Inbox rail
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/chat-maya-dark.png`
- **What:** `peerName` is `Unnamed contact (cccccccc…cccccccc)`. The rail ellipsizes the end, which is the id. Two unnamed contacts can look the same. The name is intentional (`tests/petnames.test.ts`).
- **Fix:** Not changed. Splitting the id into the meta slot would change the control’s name on every surface that uses `peerName`.

### 23. The location radio and the approvals badge stay under `--t-xs`

- **Screen:** Onboarding radio; You button badge
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/onboarding-dark.png`
- **What:** 11px type inside a 20px radio and an 18px badge. Bumping them to 11.5px crowds the disc.
- **Fix:** Not changed.

### 24. The Touch ID check glyph stays 10px

- **Screen:** Onboarding
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/onboarding-dark.png`
- **What:** 10px so the check fits a 16px circle. Colour is fixed in finding 2; the size is not.
- **Fix:** Not changed.

### 25. A few gaps are inline instead of space tokens

- **Screen:** Onboarding location badges, contact verify actions, chat header sub row
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/onboarding-dark.png`
- **What:** `style={{ gap: '8px' }}` and `style={{ gap: 'var(--s-2)' }}` instead of a class. 8px matches `--s-2`, so the pixels are on the grid. The inline style is the inconsistency.
- **Fix:** Not changed. It does not move anything a person sees.

### 26. Disabled controls drop to 50% opacity

- **Screen:** Chat when the price is unknown (Josh); welcome actions that are unavailable
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/chat-price-unavailable-dark.png`
- **What:** `button:disabled { opacity: 0.5 }` makes Send and other disabled actions faint. WCAG contrast does not apply to disabled text.
- **Fix:** Not changed. A stronger disabled style would be a new visual rule, not a correction.

### 27. Sample rooms exist in data and the rail says rooms are unsupported

- **Screen:** Inbox rail
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/chat-empty-dark.png` (empty peer is the same rail; the rooms line is “This node does not support rooms yet.”)
- **What:** `SAMPLE_ROOMS` includes “Mexico build”, and `showLegacyRoomsUi` is false, so the rail never lists them. The copy matches the flag.
- **Fix:** Not changed. Turning legacy rooms back on is behaviour.

## States that were walked and looked consistent

QR ticket, four comparison words (amber / cinder / harbor / quartz in the stub), Touch ID approve on that screen, offline node (remote, with retry), pairing failure, price-unavailable chat (Josh, Send disabled), empty thread (“Nothing here yet”), welcome empty inbox, wallet activity / channels / receive / send, settings tabs, light and dark chat. Terms for units in the thread were `sat` / `sats` via `amount()`, not `SAT`. “This Mac” vs “this device” follows the desktop vs phone copy already in those screens.

## Local check

`npm run a11y` starts Vite on port 1421 and runs Playwright + axe against onboarding, inbox, and welcome (dark and light), the emoji picker, the body table, the light wallet custody pill, and phone-rail ellipsis. It needs Google Chrome (`channel: 'chrome'`). It is not added to GitHub Actions. `scrollable-region-focusable` is disabled in that script because of finding 20.
