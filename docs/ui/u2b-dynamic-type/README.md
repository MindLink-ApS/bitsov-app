# U2b — iOS Dynamic Type

The production root uses `font: -apple-system-body` only for `data-platform=ios`.
Type and spacing tokens use rem. The 16px browser root preserves the existing
macOS/Android default sizes; WebKit regression checks cover those defaults.
Inter remains the body face. No money wording, amount formatting, approval
payload, signing, or production native/Rust code changed.

## Scaling policy

- iOS reading text starts at 17px and grows to 34px (200%). Smaller reading
  tokens start at 15/16px and also support 200%.
- Money and controls cap at 22px; approval-sheet headings cap at 24px and the
  pinned first-spend quote caps at 20px. Long sentences wrap, while `.sats`
  amount spans remain unbroken. The outgoing receipt sentence has its own
  wrapping class because it contains fee words as well as an amount;
  `break-word` preserves digit runs when flex items calculate their minimum width.
  The top-rail connection status wraps within a bounded pill instead of ellipsizing;
  its 20px cap keeps ordinary en/da words intact.
- The wallet headline restores the 64px default and scales up to the 80px
  hero cap, additionally fitting its container using the displayed amount
  character count. The smaller unit has a separate width allowance. Tests cover `Number.MAX_SAFE_INTEGER` msat
  in English and Danish without changing or rounding that amount.
- Spacing grows to 150%. The location-radio check, approvals count and Touch ID
  check glyph grow from at least 15px to 20px; their boxes grow with them.
- Long sheets and the wallet remain vertically scrollable. The keyboard
  controller measures the actual bottom of a sticky quote, including its
  position inside the sheet padding, before revealing the focused input.
  If both actions do not fit, it reveals Allow alone with the input. It does
  not scroll on each keystroke. Allow reserves the same border when enabled
  and disabled, keeping the following Not now button stationary. A narrow
  sheet (at most 20em of its own type size) reserves two label lines on Allow
  while editing so the Danish fractional-msat label does not shift Not now.
  Older iOS without container queries reserves both lines at every size and
  trades some scrollable validation space for the extra button height.

## Native evidence

`ios-{en,da}-{chat,wallet,first-spend,settings,approval}-{default,ax5}.png`
and the adjacent JSON files come from an actual WKWebView on **BitSov U1 iPhone
16**, simulator `71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS 27.0, **393×852 CSS
pixels**. The active iPhone Duo was not used.

The harness applies the actual system preference before launching each group:

```sh
xcrun simctl ui "$DEVICE" content_size large
xcrun simctl ui "$DEVICE" content_size accessibility-extra-extra-extra-large
```

The measured root is **17px at default and 53px at AX5**; reading body text
is **17px and 34px**. `baseline.txt` records the failing pre-change check:
root/body stayed 16/14px at both OS settings and the marks were 10/11px.
The harness restores the simulator to `large` even after assertion failure.

First-spend mounts the real component directly, opens Other options/Custom,
and XCTest taps the amount field and types `1250` to summon the real software
keyboard. No Send, Pay, Allow, Approve or Call is pressed. The preview uses
sample data and rejects transaction callbacks. No node is connected.

**Owner approval limitation:** the production shell excludes the M1a/M1b owner
sheet on mobile (`!isMobilePlatform()`). The `approval` images are additional
isolated-component WKWebView coverage, not evidence that this sheet mounts in
the iOS shell. The exact signed English terms remain English in the Danish
sheet, as in production. These captures are not a signed Tauri-app/device run.
Existing sample conversation text and untranslated settings/wallet copy are
unchanged by this ticket.

Each JSON records the system content-size category, root/body fonts, spacing,
viewport/keyboard state, element bounds, scroll dimensions, and overflow
failures. Capture rejects stale files, incomplete mounts and unloaded fonts;
it requires a fresh timestamp, matching scene/language, and the expected
native root size before saving a screenshot. Keep the preview source unchanged
while capturing to prevent a hot reload between the JSON and screenshot.

The automated native check rejects horizontal overflow, viewport/ancestor
horizontal clipping, hidden vertical overflow, text extending outside its
element, a line break within a money digit run, an amount input covered by the
sticky quote or keyboard, and Allow outside the visible keyboard viewport.
The connection status text is included in the clipping checks. Vertical
scrolling content is allowed: a long wallet or sheet need not fit in one image.
This is targeted money/approval geometry coverage, not an exhaustive audit of
every screen or every possible transaction value.

## Reproduce

Requires Xcode, the installed iOS simulator runtime, xcodegen, and npm dependencies.
From the repository root:

```sh
npm ci
sh docs/ui/u2b-dynamic-type/harness/prepare.sh
# Serve the real components and stylesheet on loopback in a separate process:
BITSOV_VITE_PORT=1438 npm run dev -- --host 127.0.0.1
# With the named simulator booted:
python3 docs/ui/u2b-dynamic-type/harness/capture.py
npx playwright test -c playwright.dynamic-type.config.ts
```

`DEVICE` can select another compatible simulator for prepare/capture. The fast
WebKit test emulates the native-measured 53px root; it supplements, rather than
replaces, the actual OS-size check. It also checks fractional first-spend input,
maximum safe wallet balances, and unchanged desktop/Android defaults. The
padded sticky-quote scroll regression runs in Vitest.

## Validation — 23 October 2026

- `npx tsc --noEmit`: passed.
- `npx vitest run`: **120 files, 2,202 tests passed**. Existing Solid disposal
  warnings remain in the output.
- `npx playwright test -c playwright.dynamic-type.config.ts`: **14 passed**.
- Native capture matrix: **20 captures**, default/AX5 × en/da × five scenes;
  zero targeted geometry failures. Chat/wallet were refreshed with explicit
  composer fee-quote and wallet-total selectors; those eight checks also passed.
- `npm run build`: passed (existing bundle-size warning).
- `npm run authority`: passed.
- Independent read-only review: no unresolved blocking findings after correcting
  the padded sticky boundary, long-number sizing and screenshot freshness.
- Rust was not touched; the conditional Rust test was not required. `cargo fmt`
  was never run. No prohibited transaction/approval/call button was pressed.

## U2b follow-ups — 23 October 2026

The regression checks first reproduced the AX5 primary-button fallback failure,
the 40px default wallet headline, clipped status text, and a digit run breaking
inside a flex receipt. The refreshed #318 native typing check also caught a 2px
Not now movement when Allow lost its disabled border; the enabled border now
reserves the same space. WebKit additionally reproduced a second-line Danish
fractional-msat label moving Not now at AX5; the narrow-sheet reservation fixes it.

The default first-spend assertion still requires both actions inside the visible
height. At AX5 it requires Allow inside that height, even when Not now cannot fit.
Typing whole/fractional amounts and deleting back must leave the actions and sheet
scroll position unchanged. No amount formatting, money wording, or signed bytes
were changed.

Follow-up validation:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: **120 files, 2,204 tests passed**; existing Solid disposal warnings.
  A repeat during native capture hit the 5s timeout in
  `i18n-source.test.ts` (hardcoded-copy guard); its isolated rerun passed in 811ms.
  Final `npx vitest run --maxWorkers=2`: **120 files, 2,204 tests passed**.
- `npx playwright test -c playwright.dynamic-type.config.ts`: **27 passed**.
  This includes the shipped legacy fallback rules activated on modern WebKit;
  it is not an older-iOS runtime test.
- Native default/AX5 matrix: **20 refreshed captures**, zero targeted geometry
  failures. Both AX5 languages keep Allow inside the software keyboard viewport.
- #318 first-spend: **six refreshed captures** at 17px root / 17px body, en/da
  across standard, starts-now and may-start-now variants. All nine typing samples
  per capture keep both actions visible and their positions and scrollTop fixed.
- Independent read-only review approved after adding the older-iOS fallback.
- No Rust changes, `cargo fmt`, prohibited button presses, money wording changes,
  or signed-byte changes.
