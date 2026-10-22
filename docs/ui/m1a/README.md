# M1a — Mac owner approval sheet

A pending owner-approval request opens one centred Mac sheet without visiting
Settings. Requests are presented one at a time; `1 of N` counts the current
request and those still queued for presentation. Other open modals and an
in-flight approval delay the next sheet.

Not now, Escape, scrim dismissal and native dialog close grant nothing. They
leave the request in Settings → Node, where Review request opens it again.
Expiry or withdrawal closes the sheet with a plain status line. A failed read
reports the read failure instead of claiming withdrawal. The sheet traps focus
and restores the original opener after the queue, including reopening from
Settings. Delayed native close events cannot dismiss a subsequent request.

The terms are `approvalReason(view)`, exactly the existing host Touch ID wording,
including U+202F space-grouped amounts and the requesting app's fingerprint.
The node does not supply a trustworthy app name. These host words deliberately
remain verbatim English in the Danish UI; controls, attribution explanation,
status and refusal copy use the en/da table. The signed `approval_message` is
shown unchanged under the disclosure, and the existing approval action receives
the same operation id and original message bytes.

## Native captures

The four `mac-{en,da}-{default,large}.png` files are window-only macOS captures,
including the native title bar. Following U4's method, a temporary AppKit app
hosts a real WKWebView loading this checkout's `ControlCenter` and stylesheet
with sample data. The content viewport is 1280 × 800. The temporary harness is
under ignored `.cache/m1a`; it does not enter the production bundle.

The default captures use the existing 14px body token. The large captures
explicitly double the CSS text tokens (28px body) and root rem size to exercise
200% text. This is a text/layout stress check, not a claim that macOS text-size
settings scale the app's existing px tokens. Native geometry is recorded in the
matching JSON files; the sheet and both actions fit inside the viewport in all
four cases. All four images were visually inspected.

The sample harness blocks approval and paid methods. No Approve or paid action
was pressed during native captures or browser interaction checks. These are
layout checks, not real-node or biometric approval runs.

`browser-checks.json` records additional Chromium checks in both languages and
text sizes: one sheet, queue advancement after Not now, Escape dismissal,
reopening from the retained list, Tab/Shift-Tab containment, and focus restored
to the visible profile button. No browser errors occurred.

## Scope and verification

No dependencies, Rust files, capability definitions, signed bytes, or host
command semantics changed. Background system notification remains M1b and is
not included. `cargo fmt` was not run. Rust integration tests are not required
because Rust is untouched.

Verified commands:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 113 files, 2,081 tests passed. The suite still emits its
  existing Solid computations-outside-root warnings.
- `npm run build`: passed; existing bundle-size advisory remains.
- `npm run authority`: passed.
- `RUST_TEST_THREADS=4 TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`
  from `src-tauri`: 1,092 app tests and 12 FFI tests passed; one FFI test ignored.
  The sandboxed run could not open local mock-server sockets. With socket access,
  unrestricted parallel runs timed out in the existing
  `supervised_refusal_waits_for_consent_then_repairs_and_starts_normally` test;
  that test passed alone, and the complete four-thread run passed.

Independent review found and verified fixes for the disposed-dialog close race,
next-request attribution while an approval is in flight, and publishing a read
error before clearing the list. Focused regressions cover these alongside en/da,
arrival, queue order/count, every dismissal, reopening, expiry, withdrawal,
focus containment/restoration, and unchanged approval arguments.
