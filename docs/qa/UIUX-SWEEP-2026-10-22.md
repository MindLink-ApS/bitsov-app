# UI/UX sweep — 2026-10-22

Walk of the BitSov web shell in dev sample mode (`npm run dev`, `?sample` / `?sample=first-run` / `?sample&peers=0`). Phone widths 360×740, 390×844, and 430×932, plus a small desktop window at 800×700 and a 1024×640 check. Dark and light on onboarding and welcome. This pass looks at narrow layout (overflow, clipped text, 44px tap targets, safe areas, scroll traps) and at loading, empty, error, offline, and success states.

The 2026-10-20 report reviewed the tree just before its fixes merged (`738a4c0`, parent `059f416`). This walk starts at `a54e285` and concentrates on the UI diff since `738a4c0`: calls (in-call pay, recovery, admission repair), second-device pairing, remote connect without a restart, and iPad/phone copy. Screenshots under `docs/qa/screenshots/2026-10-22-*.png`. The cost-leak shot is the bug before the fix; the others are after.

Not in this walk: the Tauri host as a native window, the iOS/Android shells as installed apps (the phone width is the web layout those shells use), and `assistant.html`. Locked-node and offline-node screens are not reachable in sample mode; they were read from the components that changed (`LockedNode.tsx`, `App.tsx`).

## Counts

| Severity | Found | Fixed here | Left as findings |
| --- | ---: | ---: | ---: |
| High | 1 | 1 | 0 |
| Medium | 5 | 2 | 3 |
| Low | 10 | 4 | 6 |
| **Total** | **16** | **7** | **9** |

Eight findings from 2026-10-20 are still open. They are listed again at the end and are not in this table.

## Findings

### 1. The cost breakdown paints while its disclosure is closed

- **Screen:** Chat composer, every width; worst at 360px
- **Severity:** High
- **Screenshot:** `docs/qa/screenshots/2026-10-22-cost-leak-360.png` (before), `docs/qa/screenshots/2026-10-22-cost-closed-360.png` and `docs/qa/screenshots/2026-10-22-cost-open-360.png` (after)
- **What:** `.price-breakdown { display: grid }` overrides the user-agent rule that hides closed `<details>` children. With the ⓘ shut, “Robin’s price / 2 sats”, the routing line, and “You pay at most / 7 sats” still laid out in a 44px-wide box and ran 34px off the right edge of a 360px screen.
- **Fix:** `.composer-info:not([open]) > :not(summary) { display: none; }`. Opened, the same breakdown sits inside the composer (measured right edge 331 of 360).

### 2. A short chat title is under a 44px tap target

- **Screen:** Chat header under 480px
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/2026-10-22-chat-360.png`
- **What:** The phone rule set `.track-title-btn { min-width: 44px }`, but `.track-head > .track-title-btn { min-width: 0 }` wins on specificity. Measured “Robin” at 40×44 and “Kim” at 36×44. The name opens the contact sheet.
- **Fix:** The 480px rule now uses `.track-head > .track-title-btn { min-width: 44px }`. A long name can still shrink to that floor and ellipsize. Measured 44×44 after the change.

### 3. Call actions with a price can overflow a phone card

- **Screen:** Call card, meeting card, unresolved-call repair
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/2026-10-22-call-actions-360.png` (a fixture card on the sample shell, not a live call)
- **What:** `.call-actions button { flex: 1; white-space: nowrap }` will not shrink below the label. “Accept · 12,345 sats” beside “Decline · 12,345 sats” is wider than the call card (`min(340px, 100vw - 32px)`, 328px at 360). The new repair label “Repair and end / acknowledge” is in the same row.
- **Fix:** Under 480px those rows stack, the buttons are full width, and the label may wrap. The fixture measured each button at 294×44, inside the card. Live call confirm (“Ring Robin?”) already fitted at 360 and 800 and was left as a popover.

### 4. The call card ignores the safe area

- **Screen:** Call card and meeting card
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-call-confirm-360.png` (the card’s corner; insets are 0 in this browser)
- **What:** `.call-panel` is `bottom` / `right: var(--s-6)` and its new max-height is `100dvh - 48px`. On an edge-to-edge phone webview the home indicator and the notch eat that margin. The meeting card had the same max-height.
- **Fix:** Bottom and right use `max(var(--s-6), env(safe-area-inset-*))`. Max-height subtracts the top and bottom insets. With insets at 0 the used values match the previous rule.

### 5. The incoming-call glow is a different green than `--ok`

- **Screen:** Incoming call and meeting invite
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-call-confirm-360.png` (the glow is on the incoming card, not this confirm)
- **What:** `incoming-call-glow` used `rgba(79, 191, 123, …)`. Dark `--ok` is `#5bc98a`. The 2026-10-20 sweep fixed the same mismatch on the node dot and left this animation.
- **Fix:** The glow uses `color-mix` with `var(--ok)`.

### 6. Adding a device is blank while status loads

- **Screen:** Settings → Devices, and “Add this device”
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-settings-devices-360.png` (sample has no device API, so this is the unsupported state, not the wait)
- **What:** `JoinDevice` used to open on the claim-code form. It now waits for `status` so a second device does not flash the claim code, and the wait renders nothing under the heading. `AddDevice` had the same empty wait.
- **Fix:** Both show “Checking…” (`role="status"`) until the first reply. The claim field still stays hidden for a second device.

### 7. First-run guidance says “this phone” on an iPad

- **Screen:** Unclaimed node, phone and iPad
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-onboarding-360.png` (desktop sample; the sentence is the host error and the pairing preview)
- **What:** The host string is “Finish setup on a Mac, then add this phone.” The iPad copy pass names every other screen “iPad”, and this paragraph had no `role="status"`. The app matches the host string to hide Reconnect, so the string itself cannot change.
- **Fix:** An iPad shows “add this iPad”. The match still uses the host sentence. The paragraph is `role="status"`.

### 8. Settings tabs hide three sections at 360px

- **Screen:** Settings
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-settings-tabs-360.png`
- **What:** At 360px the tab strip is 258px wide and 502px of tabs. General, Body, and Node fit. Devices is cut (51 of 76px visible). Wallet, Budget, and Profile are fully off-screen. The strip scrolls and Close stays put, which is what the 21 Oct layout asked for. Nothing marks that the row continues.
- **Fix:** Not changed. A fade on the cut edge, or moving Wallet, Budget, and Profile behind one “More” tab, would be a new settings layout.

### 9. Unresolved-call repair is two actions and a paragraph

- **Screen:** Chat, when the host has an unresolved call record (`CallRepairs.tsx`)
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/2026-10-22-call-actions-360.png` (the same button row; the repair block is not in sample data)
- **What:** The block is a heading, a two-sentence hint, and one button labelled “Repair and end / acknowledge”. The button either ends the call or only acknowledges it. A failed `opList` is swallowed, so the first failure shows nothing. The section is `max-height: 35vh; overflow: auto` inside the scrolling track, a second scroll on a phone.
- **Fix:** Not changed. One short line, one verb on the button, and the acknowledge outcome in the result line. Let the track scroll instead of a nested scroller. Do not surface an error on hosts that have no repair list.

### 10. Adding a device is several sentences, not one line

- **Screen:** Add a device, and Add this device
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/2026-10-22-settings-devices-360.png` (the unsupported state; the ticket and claim-code steps are the same panel)
- **What:** The ticket step is two paragraphs (where to scan, then the claim code, the console command, and the sticker) plus the QR, the ticket text, and Close. The claim-code step is one paragraph of three sentences and a form. The second-device step is shorter (“Keep your owner device nearby…”) but still two sentences, and the waiting line offers the owner console and an enrolled device in one sentence. None of the extra paths sit behind “Other options”. The product preference is one action and at most one short line, with anything else behind that control. “Other ways” exists for Touch ID; this flow does not use it.
- **Fix:** Not changed. Copy this long is the enrollment instructions. Shorten only with the product owner.

### 11. Onboarding is still more than one line and one action

- **Screen:** First run
- **Severity:** Medium
- **Screenshot:** `docs/qa/screenshots/2026-10-22-onboarding-360.png`
- **What:** At a phone width the desktop sample still shows a lede, two location cards with a paragraph each, and “Advanced: use a node you already run at home”. The phone build (no “This Mac”) was updated in this diff to a lede of two sentences plus the pairing form. Pair-another-node confirmation is still four sentences and two buttons. Remember-unlock is a question plus two hint paragraphs and two buttons.
- **Fix:** Not changed. The advanced disclosure is the right place for the second location. The lede and the cards are still over the one-line preference.

### 12. A live call carries a recovery sentence the whole time

- **Screen:** Call card, every phase except ended
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-call-confirm-360.png` (confirm only; the sentence is on the card in `CallPanel`)
- **What:** “The connection may recover on its own. A new paid recovery admission waits until the original call is confirmed closed.” is on the card from incoming through live, next to the price line, the connection line, Pay, and Hang up. Offline, reconnecting, and ended add further lines. Each line is honest. Together they are not one short line.
- **Fix:** Not changed. Keep the recovery sentence for reconnecting and ended, not for a call that has not dropped.

### 13. Welcome home is three actions

- **Screen:** Empty inbox (`?sample&peers=0`)
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-welcome-360.png`
- **What:** “Share your profile”, “Add a contact”, and “Add sats” are three cards, each with a sentence and a button. Nothing is behind “Other options”. The screen did not change in this diff. At 360px the cards stack and nothing overflows.
- **Fix:** Not changed.

### 14. The only-owner hint still says “a phone” on an iPad

- **Screen:** Device approvals, one owner device
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-settings-devices-360.png` (sample does not reach the enrolled state)
- **What:** “A phone should not be your only owner device.” was left in place while the surrounding sentences learned “iPad”. On an iPad the warning names the wrong device. On a Mac it reads as advice about phones, which may be what was meant.
- **Fix:** Not changed. If the warning is “do not let this device be the only owner”, say that. If it is only about phones, show it on phones.

### 15. Price unavailable is one line and one Retry

- **Screen:** Kim
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-price-unavailable-360.png`
- **What:** “Their price is not available yet.” plus Retry. Send stays disabled. This matches the one-line preference. Retry is a text link (39×26) with the existing 44px hit slop, not a second full button. Recorded so the state is not mistaken for a gap.
- **Fix:** Not changed.

### 16. Wallet at 360px fits, including the hero balance

- **Screen:** Wallet
- **Severity:** Low
- **Screenshot:** `docs/qa/screenshots/2026-10-22-wallet-360.png`
- **What:** “482,500 sats” at `--t-hero` stays on screen. Receive and Send are 44px tall. Back and Refresh stay text links; their hit slop is 44px tall. The activity hint was updated for iPad (“on this iPad”) and still wraps inside the page. No overflow at 360, 390, or 430.
- **Fix:** Not changed. Noted so the hero size is checked at the new widths.

## States on the screens that changed

| Screen | Loading | Empty | Error | Offline / unreachable | Success |
| --- | --- | --- | --- | --- | --- |
| Chat thread | Spinner while the read is pending | “Nothing here yet” | Contact load uses SoftError and Reconnect | “Waiting for the connection…” when money is not live | Paid line under the send |
| Price | “price loading…” | — | Kim: one line and Retry; Send disabled | Same money notice | Orange price line |
| Call card | “Connecting” / “Ringing” titles | — | `data-call-error`, close refusal | “You are offline…” while the call is up | “This call paid up to …” / “This call paid nothing.” |
| Call repair | Button says “Checking…” | Hidden when there is no row | Result line on a thrown repair; a failed list read is silent (9) | — | “The repaired call is ended. You can call again.” or the acknowledge line |
| Add / join device | “Checking…” (6) | Unsupported paragraph, no button | `role="alert"` and Try again | — | “Device added…” / “Stopped. Nothing was added.” |
| First run | “Connecting to your node…” / “Starting your node…” | — | SoftError and Reconnect, except the unclaimed-node sentence (7) | Offline card and “Use a different node” (unchanged; not re-shot) | “saved… Connecting to your node…” when restart is not required |
| Welcome | — | The three cards (13) | — | — | — |

Call confirm at 360px keeps Cancel and Ring on screen (`docs/qa/screenshots/2026-10-22-call-confirm-360.png`). At 800×700 the rail and the thread share the window without a page-level overflow (`docs/qa/screenshots/2026-10-22-chat-800.png`). The unnamed contact in that rail still loses the id at the ellipsis; that is finding 22 from 20 Oct.

## Still open from 2026-10-20

Re-checked against `a54e285`. None of these were fixed by later commits.

| # | Severity | Still true |
| --- | --- | --- |
| 20 | Medium | `.stream` is not a keyboard scroll region. `npm run a11y` still disables `scrollable-region-focusable` for this. |
| 21 | Medium | Hub title is still “What MindLink's hub can and can't do” (`HubTrust.tsx`). |
| 22 | Medium | Desktop rail ellipsizes `Unnamed contact (cccccccc…cccccccc)` at the end, which is the id. Phone strip scrolls the full label (finding 8’s fix still holds). |
| 23 | Low | Location radio stays 11px; the approvals badge stays 11px. |
| 24 | Low | Touch ID check glyph stays 10px. Colour fix from finding 2 still holds. |
| 25 | Low | A few gaps are still inline `8px` / `var(--s-2)`. |
| 26 | Low | `button:disabled { opacity: 0.5 }` still fades disabled Send. |
| 27 | Low | `SAMPLE_ROOMS` still includes “Mexico build” while `showLegacyRoomsUi` is false. The rail says rooms are unsupported. |

## Local check

Commands run in this VM against the change. No Rust sources were edited.

- `npx tsc --noEmit` — exit 0.
- `npm run build` (`tsc --noEmit` again, then Vite) — exit 0. The bundle warns that `main` is over 500 kB; that warning was already there.
- `npm run a11y` — 5 passed (onboarding, inbox, and welcome in dark and light, emoji picker, body table, light wallet pill, phone rail). `scrollable-region-focusable` stays disabled for finding 20. Not part of GitHub Actions.
- `cargo check --locked` and `cargo test --locked` — exit 0 on Rust 1.99.1 (1112 tests, 0 failed). The VM’s default 1.83 cannot parse the lockfile’s edition-2024 crates, and the check needs the GTK/WebKit dev packages plus a file at the gitignored sidecar path `src-tauri/bin/konsensus-x86_64-unknown-linux-gnu` (the released node binary is not in the tree). A local placeholder satisfied Tauri’s path check; it is not committed.
- Focused Vitest for the edits (`add-device`, `ui-ux-sweep`, `mobile-platform-parity`, `onboarding-pairing`, `priced-send`) — 177 passed.
