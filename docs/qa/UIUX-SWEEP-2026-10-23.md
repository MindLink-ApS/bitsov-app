# UI/UX sweep — 2026-10-23

Walk of the BitSov web shell against `321f437` (current `main`), starting from the 2026-10-22 report. That report walked `a54e285`. This pass reads the UI diff since then — phone onboarding, the first-spend sheet, the Mac owner-approval sheet, starter balance, and the shared English/Danish copy — with accessibility and contrast first, then whether the same thing has the same name.

Contrast is WCAG AA: 4.5:1 for text under 18px, 3:1 for large text and for the boundary of a control. Ratios below are computed from the tokens in `src/styles.css`, then checked on the phone-onboarding fixture in Chrome (dark and light, `color-scheme` set). `npm run a11y` is the same axe pass as 22 Oct (`wcag2a` / `wcag2aa` / `wcag21aa`).

Not in this walk: the Tauri host as a native window, the iOS/Android shells as installed apps, and `assistant.html`. Sample mode still cannot open a live owner-approval or first-spend sheet; those were read from `OwnerApprovalSheet.tsx`, `FirstSpendSheet.tsx`, and their tests.

## Counts

| Severity | Found | Fixed here | Left as findings |
| --- | ---: | ---: | ---: |
| High | 0 | 0 | 0 |
| Medium | 6 | 6 | 0 |
| Low | 8 | 2 | 6 |
| **Total** | **14** | **8** | **6** |

Two items from earlier reports are done (hub title, the “Mexico build” sample room). The rest that are still open are listed at the end and are not in this table.

## What changed since 22 Oct

`git log a54e285..321f437` is phone onboarding (one action, one line, everything else under “Other options”), the first-spend sheet, the owner-approval sheet, starter balance, Danish/English copy, iOS keyboard and edge-swipe Back, and the phone-layout fixes from PR #304. Icon-only call, emoji, voice, and composer buttons in that diff already have `aria-label`s. Both new sheets are native `<dialog>`s with `aria-labelledby`, a Tab trap, and focus returned to the opener.

Text tokens on `--bg` and `--surface` meet AA in both themes, including small text: `--muted` (9.99:1 dark / 7.73:1 light on `--bg`), `--faint` (5.17 / 5.10), `--err` (5.84 / 5.46 on `--surface`), `--ok` (8.30 / 5.82), `--warn` (8.55 / 5.33). `--accent-ink` on `--accent` is 8.04:1 dark and 5.79:1 light. Focus rings use `--accent` (7.31:1 dark / 5.79:1 light against `--surface`).

## Findings

### 1. A phone step change drops keyboard focus

- **Screen:** Phone onboarding, and the trust question after it
- **Severity:** Medium
- **What:** Connecting and the word check unmount the primary button. Focus fell through to the page. The whole step was also `aria-live="polite"`, so a screen reader re-read the buttons as well as the heading.
- **Fix:** `PhoneOnboarding.tsx` focuses the heading on each step (`tabindex="-1"`) and points `aria-describedby` at the one line. The live region is gone; the connecting line and the toast keep `role="status"`. `PhoneTrust.tsx` focuses its heading the same way.

### 2. A first-spend preset can be selected with nothing to see

- **Screen:** First-spend sheet, Other options
- **Severity:** Medium
- **What:** The presets are `role="radio"` (`FirstSpendSheet.tsx` around the chip buttons) but they used `.chip`, whose fill is `--surface` — the same colour as the sheet. The border is `--line` on `--surface`, 1.19:1 in the dark theme. Nothing else paints the checked chip, so the chosen daily limit and the others look the same. `flex-wrap` was set without `display: flex`, so the row did not use the gap.
- **Fix:** The idle chip uses a `--faint` border (measured 5.17:1 dark, 5.32:1 light) and `--ink` text. The checked chip uses `--accent` / `--accent-ink` (measured 8.04:1 dark, 5.79:1 light), the same pair as the budget chips. Under 600px each chip is 44px tall. `docs/qa/screenshots/2026-10-23-sheets-dark.png`, `docs/qa/screenshots/2026-10-23-sheets-light.png`.

### 3. Owner approval fades its buttons while Touch ID is waiting

- **Screen:** Owner-approval sheet
- **Severity:** Medium
- **What:** `button:disabled { opacity: 0.5 }` still applies. On this sheet both buttons disable while the prompt is up, and the approve label changes to “Waiting for Touch ID…”. Composited at half opacity over the sheet, that orange button is 2.95:1 in dark and 2.25:1 in light. The “Not now” pill is 4.35:1 dark and 2.99:1 light. The first-spend sheet already opts out of the fade. Inactive text is exempt from WCAG 1.4.3; the label is still the only line that says the prompt is open.
- **Fix:** `.owner-approval-sheet button:disabled` matches the first-spend rule: full opacity, `--muted` on `--surface` (9.09:1 dark, 8.06:1 light).

### 4. Phone onboarding’s other actions borrowed the browser button

- **Screen:** Phone onboarding, Other options, and a disabled Scan
- **Severity:** Medium
- **What:** Paste, Use link, Cancel, and Forget had no background of their own, so they painted with the browser’s button face. A disabled primary used the same half opacity as finding 3: the light-theme primary falls to 3.18:1. The “Please wait…” line under it was already `--ink`.
- **Fix:** Those buttons use `--raised` / `--ink` (measured 13.13:1 dark, 14.06:1 light) and a `--faint` border. Disabled buttons in `.phone-onboarding` use the same full-opacity muted treatment as the sheets. `docs/qa/screenshots/2026-10-23-phone-options-dark.png`, `docs/qa/screenshots/2026-10-23-phone-options-light.png`. Keyboard order on the start step is the heading, then Scan, then Other options.

### 5. Wallet Back is named “Close wallet”

- **Screen:** Wallet, including the starter-balance step
- **Severity:** Medium
- **What:** The control shows “← Back” (`uiBack450`) and, while the wallet itself is open, its accessible name was “Close wallet”. WCAG 2.5.3 asks the name to contain the visible label. “Back” is not in “Close wallet”. Speech input for the word on the button misses it.
- **Fix:** The name is “← Back, Close wallet” (and the Danish pair). On the starter step the visible label and the name are both “← Back”, which is what that press does.

### 6. Danish approval terms are read as Danish

- **Screen:** Owner-approval sheet
- **Severity:** Medium
- **What:** `termLines()` is English, and the Danish sheet already says so. The paragraph had no `lang`, so a Danish page pronounces “Let this app spend” with a Danish voice. The signed message under the disclosure is the same.
- **Fix:** The terms and the signed message are `lang="en"`.

### 7. The contact title drops “Verified” and “Key changed” from its name

- **Screen:** Chat header, when the pill is showing
- **Severity:** Low
- **What:** The button’s visible contents are the name plus the pill. `aria-label` was only “Contact Maya”, which replaces those contents, so the pill was not in the name.
- **Fix:** The name gains “, Verified” or “, Key changed” (and the Danish strings) when that pill is showing. Sample Maya has no saved verification, so the sample name stays “Contact Maya”.

### 8. The owner-approval sheet ignores the safe area

- **Screen:** Owner-approval sheet and the expiry line under it
- **Severity:** Low
- **What:** The first-spend scrim pads with `env(safe-area-inset-*)`. This scrim used a flat `--s-4`, and the expiry status was `bottom: var(--s-4)`. On an edge-to-edge webview the home indicator covers the bottom of the sheet. Insets are 0 on the desktop window this sheet is aimed at.
- **Fix:** The scrim uses the same `max(--s-4, env(safe-area-inset-*))` padding. The status sits above the bottom inset.

## Left as findings

### 9. Disabled buttons everywhere else still fade to half opacity

- **Screen:** Send, call actions, and any other disabled button outside the three surfaces above
- **Severity:** Low
- **What:** `button:disabled { opacity: 0.5 }` in `src/styles.css`. Light primary text lands at 3.18:1; light money text at 2.25:1. This is finding 26 from 20 Oct. Inactive components are exempt from 1.4.3. Changing every disabled control is a wider look than the new sheets.
- **Fix:** Not changed.

### 10. A soft button’s edge is under 3:1

- **Screen:** “Not now” on the owner sheet, and every other `button.soft`
- **Severity:** Low
- **What:** `--raised` on `--surface` is 1.10:1 dark and 1.16:1 light. `--line-strong` on `--raised` is about 1.4:1. The label is `--ink` (13:1 or better), so the words are readable. The edge is how the design system draws a quiet button.
- **Fix:** Not changed.

### 11. First spend is several lines, and some of them are jargon

- **Screen:** First-spend sheet
- **Severity:** Low
- **What:** Besides the question and Allow, the sheet can show “Approve at your box”, “Allow starts owner approval…”, a node-grant line, and a cost line. Other options holds “App budget presets” and, for a fractional amount, “msat”. The product line is one short sentence and one action, with the rest behind Other options. The grant and the “this does not by itself grant permission” line are there on purpose.
- **Fix:** Not changed. Shorten only with the product owner.

### 12. “They don't match” and “Words differ” are the same refusal

- **Screen:** Phone onboarding error, and Add a device on the owner
- **Severity:** Low
- **What:** The phone button is “They don't match”. The phone’s stopped line still says to choose “Words differ” on the other device, and that device’s button is still “Words differ” (`AddDevice.tsx`, `RemoteOwnerCeremony.tsx`). Danish explains the English label in parentheses. The 20 Oct report left “Words differ” because it matched that step.
- **Fix:** Not changed.

### 13. Starter balance says “hub” and “Channel opening”

- **Screen:** Wallet → Get your starter balance
- **Severity:** Low
- **What:** The hub disclosure was renamed to “Your Lightning provider” (finding 21 from 20 Oct is done). This step still says “The hub funds your starter balance” and “Channel opening”, on the primary wallet step rather than behind Other options. The flag is off unless the host allows it.
- **Fix:** Not changed.

### 14. The approval sheets scroll without a tab stop of their own

- **Screen:** First-spend sheet and owner-approval sheet
- **Severity:** Low
- **What:** Both panels are `overflow-y: auto` and `tabindex="-1"`. A keyboard user reaches the buttons, and the browser scrolls those into view. The region itself is not a scroll stop. Same tradeoff as the chat stream (finding 20), which is why `npm run a11y` still disables `scrollable-region-focusable`.
- **Fix:** Not changed.

## Checked and left alone

- Phone onboarding’s main steps are already one heading, one line, and one primary action. Paste, cancel, and the fingerprint live under “Other options”. The progress marks are `aria-hidden`; the heading is the step.
- Icon buttons added or touched since 22 Oct (call, emoji, voice, attach, settings, the ✕ close) have an `aria-label`. Settings Close shows “Close” and is named “Close settings”, which contains the visible word.
- Error and success notes (`.err-note`, `.ok-note`) meet AA on `--surface` in both themes. See the ratios above.
- The on-call pill’s name is “Live · Return to call” and does not include the ticking clock. That is deliberate so the name does not change every second (`tests/network-polish.test.tsx`).
- Preset chips do not move with the arrow keys. Tab reaches each one, which is how the budget bar already works.

## Still open from earlier reports

Re-checked against `321f437` where the line is still in the tree. Not re-shot.

| From | Severity | Still true |
| --- | --- | --- |
| 20 Oct #20 | Medium | `.stream` is not a keyboard scroll region. `npm run a11y` still disables `scrollable-region-focusable`. |
| 20 Oct #22 | Medium | Desktop `.track-link .name` still ellipsizes at the end. The phone rule that keeps the full label is unchanged. |
| 20 Oct #23 | Low | Location radio stays 11px. The approvals badge stays 11px. |
| 20 Oct #24 | Low | Touch ID check glyph stays 10px. |
| 20 Oct #26 | Low | `button:disabled { opacity: 0.5 }` remains for every button outside findings 3 and 4. See finding 9. |
| 22 Oct #8 | Low | Settings tabs still scroll under the cut edge at a phone width. Not a new layout. |
| 22 Oct #9 | Medium | Unresolved-call repair is still a paragraph plus “Check repair / acknowledge”. |
| 22 Oct #10 | Medium | Add a device is still several sentences. |
| 22 Oct #11 | Medium | Desktop first run is still a lede and location cards. The phone path is the one-line flow. |
| 22 Oct #12 | Low | The recovery sentence is still on the call card for every phase except ended. |
| 22 Oct #13 | Low | Welcome home is still three actions. |
| 22 Oct #14 | Low | “A phone should not be your only owner device.” is still the only-owner hint, including on an iPad. |

Done since 22 Oct, and not carried forward: the hub title is “Your Lightning provider” (`hubTitle`). `SAMPLE_ROOMS` is “Open circle”; the “Mexico build” room name is gone.

## Local check

Commands run in this VM against the change. No Rust sources were edited. No workflow files were edited.

- `npx tsc --noEmit` — exit 0.
- `npm run build` (`tsc --noEmit` again, then Vite) — exit 0. The bundle warns that `main` is over 500 kB (808.50 kB); that warning was already there.
- `npm run a11y` — 89 passed. `scrollable-region-focusable` stays disabled for finding 20 from 20 Oct. Not part of GitHub Actions.
- Focused Vitest (`phone-onboarding`, `owner-approval-sheet`, `i18n-ui`, `first-spend-sheet`, `starter-balance`, `phone-app`, `onboarding-trust`) — 186 passed.
- `cargo +1.99.1 check --locked` — exit 0. `cargo +1.99.1 test --locked` — exit 0, 1137 passed, 0 failed. The VM’s default 1.83 cannot parse the lockfile’s edition-2024 crates, and the check needs the GTK/WebKit dev packages plus a file at the gitignored sidecar path `src-tauri/bin/konsensus-x86_64-unknown-linux-gnu`. A local placeholder satisfied Tauri’s path check; it is not committed.
