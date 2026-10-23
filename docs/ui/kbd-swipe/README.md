# iOS keyboard and edge Back

The iOS renderer owns the left-edge gesture. It never calls `history.back()`.
The locked Wry 0.57.0 `WebViewAttributes::default()` sets
`back_forward_navigation_gestures: false`; its WKWebView constructor explicitly
calls `setAllowsBackForwardNavigationGestures` with that value. Tauri does not
turn it on. Keep this setting off when upgrading the native webview. The evidence
preview explicitly sets `allowsBackForwardNavigationGestures = false` too.
The production flag cannot be read from page JavaScript, and this app exposes
no bridge for it. A runtime assertion would require a native application change
(`with_webview` plus a WKWebView property read); no native change is included in
this keyboard fix. The preview's explicit setting proves only the preview, not
the signed Tauri app. On Tauri/Wry upgrades, check the locked Wry default and its
`setAllowsBackForwardNavigationGestures` call, and verify the signed app on iOS.
No Rust or native application source changed.

## Keyboard layout

`src/ios/keyboard.ts` publishes the visible viewport height, focus-pan offset and
bottom occlusion. It uses `documentElement.clientHeight`: on this WKWebView,
`innerHeight` shrinks to the visual height while the document remains 852 px.
Subtracting the keyboard from `innerHeight` would shrink the app twice.
Pinch zoom is ignored. Resize and viewport-scroll events continue through blur
and keyboard dismissal; there is no delayed blur reset or CSS height animation.

The root, fixed overlays and top-layer first-spend dialog use that geometry.
Onboarding has a scroll region clipped below the status bar. The home-indicator
inset is reserved only when the keyboard is closed; left/right insets remain.
The keyboard editing layout gives the rail's space to the conversation, retaining
Back and the recipient. While the keyboard is open, first-spend pins the live
daily amount and the complete entry/message/routing-max/total quote above its
scrolling options. It reuses the exact, grant-clamped daily amount and cost text.
Validation, the verbose title and the immediate-payment timing paragraphs have
reserved space while editing so enabling Allow or switching between sats and
integer msat does not move the buttons. Typing does not trigger programmatic scrolling.
Focusing the composer pins the stream to the last message. Other focused inputs
scroll only their inner containers, also revealing a following primary and sheet
Cancel when they fit together. Longer sheets remain scrollable. This applies to
amount/invoice forms, the Wallet/M7 starter screen, pairing and settings too.

## Back routing

The gesture activates the same explicit button as a tap, one level at a time:

| Visible screen | Destination |
| --- | --- |
| Contact detail | Conversation |
| Settings sub-page | Settings Body overview |
| Settings overview | Previous screen |
| Wallet | Previous screen |
| Conversation or another track | Welcome home |
| Welcome home | No action |

The branch keeps the existing settings tabs, contact rail and Welcome home,
including Add sats, Share and moneyBlocked behavior even when contacts exist.
The review-round-one fix removes the unrelated iOS contact-list replacement.
The starter screen retains its explicit Back button, but has no swipe route:
its money blocker intentionally prevents edge navigation.

Money forms/sheets (including starter), pending local or node approvals, owner
approvals, AI disclosure approval, pairing comparisons, call confirmations and
unrecognized dialogs block swiping. All non-idle/non-ended call and meeting
phases block it even if their card is behind another screen. The blocker and
destination are checked again on release, including the actual button identity.
A new route/approval arriving during a gesture cannot dismiss the new screen.
A single finger must start within 24 CSS px of the left edge and move right at
least 64 px within a second, with vertical movement at most half the horizontal
movement. Vertical drags, cancellation, multitouch and pinch zoom do nothing.

## Evidence

The `ios-{en,da}-{composer,first-spend,pairing}-default.png` captures are
from a real WKWebView on **BitSov U1 iPhone 16**, simulator
`71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS 27.0, **393 × 852 CSS pixels**.
Each JSON beside an image records the native page's visual viewport, focused
control and element bounds. The active iPhone Duo simulator was untouched.
The additional `ios-{en,da}-first-spend-{starts-now,may-start-now}-default.*`
captures exercise both immediate-payment timing variants with the same typing
and geometry assertions.
The OS content size is `large` (the default). The previous `-large` images and
JSON were removed: their geometry was identical because Dynamic Type did not
reach the WKWebView. These captures make **no large-text accessibility claim**;
Dynamic Type conversion remains U2b.

The isolated preview renders the actual `ControlCenter`, `FirstSpendSheet` and
`PhoneOnboarding` with the production stylesheet/controllers and sample data.
First-spend is mounted directly; no Send press opens it. Pairing uses its supported
manual-entry fallback with a deliberately unavailable clipboard. No real pairing
link or clipboard contents were used. No Send, Pay, Allow, Approve or Call button
was pressed. Host payment/approval/send/call methods are blocked in the harness.

XCTest taps only an input to summon the real software keyboard. A separate native
swipe test verified conversation → Welcome home (and keyboard dismissal), and that
an identical edge swipe leaves the first-spend sheet and keyboard open. A native
Done tap also restored the same chat to 852 px with zero viewport offset and
its safe-bottom inset, captured in `ios-en-composer-dismissed.*`. English
message bodies are sample conversation content, not untranslated application UI.
The simulator's keyboard language is independent of the application's en/da choice.

`harness/` preserves the evidence source. To rerun, execute
`sh docs/ui/kbd-swipe/harness/prepare.sh` after `npm ci`, boot the named simulator,
and serve the repository with Vite on 127.0.0.1:1437.
`capture.py` installs the preview, sets the default OS text size, launches each
scene, runs XCTest and saves screenshots/geometry. First-spend types `1250`,
adds `.5`, then deletes it without submitting; its JSON records before/after-keystroke geometry. Capture
assertions require the pinned summary, complete cost, input and both buttons to
fit the visual viewport and the buttons/scroll position to stay fixed as Allow
enables. To recapture just that scene in both languages:

```sh
python3 docs/ui/kbd-swipe/harness/capture.py ios-en-first-spend-default ios-da-first-spend-default
```
The preview is separate from the signed Tauri application; these are native
WKWebView layout checks with sample data, not a real-node transaction run.

## Validation (round one, 2026-10-22)

- `npx tsc --noEmit`: passed.
- `npx vitest run`: **116 files, 2,152 tests passed**. Includes exact daily amount
  and quote updates, no input-triggered scroll, Welcome home after Back, keyboard
  calculations and approval/money/call blockers, including the starter screen.
  Existing Solid disposal warnings remain in the suite output.
- `cd src-tauri && TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`:
  **1,104 passed, one ignored** (1,092 app and 12 FFI). The initial sandboxed
  attempt failed because local socket/process fixtures were blocked; rerunning
  with those available passed, including the known `supervised_refusal` flake.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast`:
  **88 passed**, no failures.
- Refreshed en/da first-spend native captures, including both immediate-payment
  timing variants: full summary and cost visible;
  Allow and Not now stay at the same coordinates, and sheet scrollTop stays
  unchanged, while typing whole/fractional amounts and deleting back to `1250`.
  The capture asserts positive element dimensions and Allow's disabled-to-enabled
  transition as well as viewport bounds and stationary buttons.
- Native edge Back passed: conversation returns to Welcome home and dismisses
  the keyboard; first-spend blocks the same edge swipe and keeps its keyboard.
- Read-only code review found no blocking issues. Its suggestion to assert
  positive dimensions and the enable transition was incorporated into the harness.
  Its follow-up suggested timing-variant coverage; native testing reproduced and
  fixed the same wrapping issue in that copy.
- `cargo fmt` was not run. No real Send, Pay, Allow, Approve or Call was pressed.
