# U5 — phone shell

iPhones/iPods and Android handsets use Chats · Wallet · You in both portrait
and landscape, including widths above 680 CSS pixels. Detection requires the
existing Tauri mobile platform signal plus an iPhone/iPod UA or Android UA with
`Mobile`. iPads (including their Macintosh UA) and Android tablets retain the
680px compact breakpoint; Mac builds always retain the rail.

Calls appears only after a history read or an observed call. Startup performs
one sequential has-any-call search, stopping at the first matching contact.
Results and in-flight reads are cached for the mounted shell; opening Calls
lazily checks the remaining contacts. A cold negative search can still traverse
old pages once, preserving calls older than the newest page. Ordinary refreshes
reuse the cache; live call events replace negative results immediately. After
an actual websocket gap, negative results check only pages newer than their
last completed read, so missed events cannot hide Calls forever. Failed reads
remain retryable. Rows open conversations; they do not call.

Chats is the root screen. Its list retains contacts, rooms, first contacts at
the door, assistants, Browse, Porch and New. A conversation pushes over the list;
the Back button is also the destination used by the existing edge-swipe handler.
Tapping Chats while already on Chats returns to the list. Changing tabs
preserves the selected conversation/draft, but incoming messages
are unread while that conversation is hidden. Returning to Chats clears them.

Wallet retains its existing screens and adds the explicitly named Add sats
entry. You exposes Share my card / QR, profile/settings, add device, and waiting
approvals where available. Connection status and the money-readiness notice
remain above every tab. Offline Retry and unresolved-call repairs also remain
in that status area, which scrolls within 45vh so large text cannot push content
or tabs offscreen. Contact loading/error state belongs to the Chats list, with
Reconnect on failure and no false “No contacts yet” message. New labels are in the English/Danish copy table.

The tab bar has no overlay z-index. First-spend and owner-approval dialogs retain
the native top layer; starter retains its full-screen layer above the tabs.
The navigation guard keeps the tabs and status controls inert behind money and
approval surfaces, including the existing Pay panel. Tabs and edge Back share one blocked-surface predicate, including pending
node approvals, disclosure previews and onboarding ceremonies. Wallet Receive
remains a tab destination; only edge Back treats it as a blocker. Pay's existing form, money copy and submission behavior
are unchanged; converting its inner flow is the separate S2 ticket.

The bottom inset belongs to the tab bar once. iOS keeps #318's viewport owner;
Android tracks keyboard viewport shrinkage while preserving the pre-keyboard
height across input focus changes. The tab bar hides under the keyboard.
U2b's type tokens/caps remain in use. No Rust, money wording, approval payload,
signed bytes, or payment/call operations changed.

## Native evidence

`ios-{en,da}-{list,chat,wallet,you,first-spend}-{default,ax5}.{png,json}`:
20 captures of production components in a WKWebView on **BitSov U1 iPhone 16**,
393×852 CSS pixels, simulator `71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS 27.0.
The companion JSON records native content size, fonts, safe areas, viewport,
status/tab geometry and targeted overflow checks. Captures reject stale JSON,
incomplete mounts and unloaded fonts.

The harness applies the actual OS preferences, then restores `large`:

```sh
xcrun simctl ui "$DEVICE" content_size large
xcrun simctl ui "$DEVICE" content_size accessibility-extra-extra-extra-large
```

The root measured 17px at default and 53px at AX5. All 20 captures have zero
targeted overflow failures, viewport scale 1, and the tab bar ends at y=852.
Long chat lists, wallet content and sheets remain vertically scrollable.

`ios-{en,da}-keyboard-{default,ax5}.{png,json}` adds four actual software-keyboard
captures. XCTest focuses the message field and types **Draft only**, without a
newline. In all four, `keyboard=true` and the tab bar has `display:none`.
No Send, Pay, Allow, Approve or Call button was pressed during evidence capture.

These are read-only sample-data WKWebView runs, not a signed Tauri build or a
real-node/device transaction test. The first-spend scene mounts the real dialog
over the real phone shell directly, without Send. M1a/M1b remains desktop-only
in production, as before U5; its existing tests and U2b isolated-component
captures remain applicable. Existing sample conversation text and untranslated
legacy wallet/settings content are unchanged.

## Reproduce

```sh
npm ci
sh docs/ui/u5-phone-shell/harness/prepare.sh
# In a separate process, while the dedicated simulator is booted:
BITSOV_VITE_PORT=1445 VITE_STARTER_BALANCE=1 npm run dev -- --host 127.0.0.1
python3 docs/ui/u5-phone-shell/harness/capture.py
python3 docs/ui/u5-phone-shell/harness/keyboard.py
npx playwright test -c playwright.phone-shell.config.ts
```

`DEVICE` selects another compatible iPhone simulator. The preview source uses
sample data and refuses transaction callbacks. The starter fixture supplies
an explicitly configured sample hub and the build flag; it makes no request.

## Verification — 23 October 2026

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 122 files, 2,220 tests passed. Existing Solid disposal warnings remain.
- Phone WebKit regression suite: 7 passed.
- Native matrix: 20 captures passed; real keyboard matrix: 4 captures passed.
- `npm run build`: passed, with the existing bundle-size warning.
- `npm run authority`: passed.
- Independent review found unread handling, Android focus transfer, old call
  history and double safe-area issues. Each was corrected and verified.
- Rust was not touched; conditional Rust tests were not required. `cargo fmt`
  was never run.

## Round 1 revision

The original evidence above describes the initial U5 pass. Round 1 refreshes
all 20 shell captures and adds 12 native captures for `offline`, `repair` and
`contacts-error` in English/Danish at default/AX5. `webkit-landscape-list.png`
records the 852×393 iPhone layout. The recovery captures retain existing English
recovery copy even when the navigation language is Danish. Offline and repair
captures scroll the status pane to the recovery action without pressing it.

The regression fixtures now explicitly open a phone conversation instead of
assuming a wide iPhone starts in the desktop rail. Validation results and the
capture inventory are recorded in `verification.json`.

Round 1 validation: TypeScript passed; Vitest **122 files / 2,236 tests** passed;
WebKit phone shell **14/14** and Dynamic Type **27/27** passed. All **36 native
captures** (32 shell/recovery, 4 keyboard) passed their checks. An earlier
concurrent full run hit the existing source-copy audit's 5-second timeout;
its isolated rerun and the final full run passed. Existing Solid disposal
warnings remain. No Rust changes or `cargo fmt`.
