# U1: measured iPhone safe areas

Resumed on `ui/u1-safe-areas` and fast-forwarded to `origin/main` at
`9c623ed` (includes #304 and U3). No native configuration changes are required.

## Why viewport-fit=cover is needed

The original WKWebView measurement is retained in
[before/onboarding-start-portrait.json](before/onboarding-start-portrait.json).
Without cover, `env(safe-area-inset-*)` returned zero. The visible viewport was
393 × 793, while #297's `100svh` onboarding container measured 393 × 852.
“Other options” ended at y=828 and was clipped in the corresponding screenshot.
The sample shell's separate baseline was 393 × 759 with zero CSS insets.

With cover, the native viewport is 393 × 852 and reports top=59, bottom=34,
left/right=0. Onboarding's existing `max(spacing, env(...))` padding then places
“Other options” at y=770–818, above the home-indicator area. Cover alone was
unsafe: [before/chat-cover-unfixed-portrait.png](before/chat-cover-unfixed-portrait.png)
shows why the shell also needs the measured insets.

Landscape reports 852 × 393, left/right=59, top=0, bottom=20 on this simulator.
Browser tests also cover a 21px bottom inset and 390 × 844 portrait geometry.

## Final behavior

- Runtime `data-platform` gates the new inset variables and surface layout to
  iOS/Android. #297's onboarding safe-area CSS is reused unchanged.
- The shell reserves each inset once. The composer retains its ordinary 16px
  bottom padding; adding another inset there would double-count it.
- #304's call-card offsets remain the single source of positioning. Call and
  meeting cards share one height limit using `max(spacing, env(...))`, and mobile
  card width reserves both landscape edges.
- Wallet content and fixed overlays stay within the safe rectangle. Settings
  and Contact have an inset scrollport, so scrolling body text is clipped before
  the status bar; padding alone protected the sticky header but not that text.
- “Remember unlock” and incoming/reviewing pairing banners have safe content
  spacing, including landscape sides. The existing locked-node spacing passed.
- Unrelated tap feedback, selection/callout rules, and native build churn are
  excluded. No dependency or native configuration changes.

## Simulator evidence

Device: **BitSov U1 iPhone 16**, UUID
`71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS **27.0** runtime (Xcode 27.1 tooling).
The other booted simulator was not used or changed.

`after/` contains fresh `simctl io <U1 UUID> screenshot` captures and matching
WKWebView JSON measurements, in portrait/landscape at the default `large` content
size and `accessibility-extra-extra-extra-large` (the `-large` suffix). This
changes the OS setting; the app's current px-based text does not automatically
scale with Dynamic Type. Implementing Dynamic Type remains U2b.

Screens: onboarding start/words/fingerprint/done/local-network error; sample
chat, wallet, Settings, scrolled Settings; inert call/meeting cards, locked and
remember-unlock gates, incoming pairing banner and pairing review. No Ring,
Call, Pay, Send, Approve, unlock, or other consequential action was invoked.
Only local fixture navigation, profile-menu navigation, Settings tab navigation,
and scrolling were used. Baseline call images from the earlier run are retained;
the final call/meeting images use explicitly inert static fixtures.

The existing simulator debug app hosts a real Tauri WKWebView loading the local
Vite preview at `127.0.0.1:1423`. Its temporary probe reads DOM geometry and
navigates the preview. This instrumentation lives only in ignored `.cache/u1/`;
it is absent from the production build. The UI source is the merged worktree.
The fixture entry points are in `tests/fixtures/` and excluded from production.

## Verification

The safe-area DOM test substitutes nonzero device env values and runs the real
stylesheet cascade for iOS, Android, desktop and an unset platform. Playwright
uses the production CSS/fonts with synthetic insets, checks card/composer bounds,
scrolling Settings, unlock gates and both pairing-banner modes. Native captures
provide the WKWebView check that desktop browser emulation cannot supply.

[desktop-parity.json](desktop-parity.json) records 18 matching settled geometry
comparisons against merged main: nine surfaces at 390px and 1280px desktop widths.
Final test results are recorded in the commit message.
