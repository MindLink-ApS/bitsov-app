# iOS keyboard and edge Back

The iOS renderer owns the left-edge gesture. It never calls `history.back()`.
The locked Wry 0.57.0 `WebViewAttributes::default()` sets
`back_forward_navigation_gestures: false`; its WKWebView constructor explicitly
calls `setAllowsBackForwardNavigationGestures` with that value. Tauri does not
turn it on. Keep this setting off when upgrading the native webview. The evidence
preview explicitly sets `allowsBackForwardNavigationGestures = false` too.
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
Back and the recipient. Cost and approval text remain visible or scrollable.
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
| Conversation or another track | Contact list |
| Root contact list | No action |

The branch still uses the existing settings tabs and contact rail. An iOS contact
list and explicit Back controls provide the destinations without introducing the
U5/U6 tab-bar redesign. Empty contacts retain the existing welcome view.

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

The `ios-{en,da}-{composer,first-spend,pairing}-{default,large}.png` captures are
from a real WKWebView on **BitSov U1 iPhone 16**, simulator
`71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS 27.0, **393 × 852 CSS pixels**.
Each JSON beside an image records the native page's visual viewport, focused
control and element bounds. The active iPhone Duo simulator was untouched.
Default and large OS content sizes are `large` and
`accessibility-extra-extra-extra-large`. Existing px typography does not scale
with that OS setting; Dynamic Type conversion remains U2b.

The isolated preview renders the actual `ControlCenter`, `FirstSpendSheet` and
`PhoneOnboarding` with the production stylesheet/controllers and sample data.
First-spend is mounted directly; no Send press opens it. Pairing uses its supported
manual-entry fallback with a deliberately unavailable clipboard. No real pairing
link or clipboard contents were used. No Send, Pay, Allow, Approve or Call button
was pressed. Host payment/approval/send/call methods are blocked in the harness.

XCTest taps only an input to summon the real software keyboard. A separate native
swipe test verified conversation → contact list (and keyboard dismissal), and that
an identical edge swipe leaves the first-spend sheet and keyboard open. A native
Done tap also restored the same chat to 852 px with zero viewport offset and
its safe-bottom inset, captured in `ios-en-composer-dismissed.*`. English
message bodies are sample conversation content, not untranslated application UI.
The simulator's keyboard language is independent of the application's en/da choice.

`harness/` preserves the evidence source. To rerun, execute
`sh docs/ui/kbd-swipe/harness/prepare.sh` after `npm ci`, boot the named simulator,
and serve the repository with Vite on 127.0.0.1:1437.
`capture.py` installs the preview, sets OS text sizes, launches each scene, runs
XCTest and saves screenshots/geometry. It restores the default OS text size.
The preview is separate from the signed Tauri application; these are native
WKWebView layout checks with sample data, not a real-node transaction run.

## Validation

- `npx tsc --noEmit`: passed.
- `npx vitest run`: **115 files, 2,113 tests passed**. Covers keyboard calculations, DOM focus scrolling, route priorities, gesture
  cancellation and real shell integration; real incoming call and pre-existing
  pending node approval fixtures make no calls or approval requests. An earlier
  run timed out in `i18n-source.test.ts` (5-second limit) while native/Rust checks
  competed for CPU; the unchanged full-suite rerun passed. Existing Solid
  disposal warnings remain in the suite output.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`: **1,104 passed,
  one ignored** (1,092 app and 12 FFI). The sandboxed attempt could not bind mock
  server sockets; the rerun with local socket access passed.
- Independent code review: approval blocker findings fixed; final review approved.
- No Rust changed, so the conditional integration-test command was not needed.
  `cargo fmt` was not run.
