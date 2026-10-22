# M1a — Mac owner approval sheet

A pending owner-approval request opens one centred Mac sheet without visiting
Settings. Requests are presented one at a time; `1 of N` counts the current
request and every other pending request, including requests already shown or
deferred. Other open modals and an in-flight approval delay the next sheet. If
another flow opens a dialog later, the sheet suspends and resumes the same
request when that dialog closes, including its eventual approval result.

While idle, Not now, Escape, scrim dismissal and native dialog close grant
nothing. They leave the request in Settings → Node, where Review request opens
it again. During Touch ID these dismissals are blocked and the sheet says
“Waiting for Touch ID…” instead of promising that Not now grants nothing.
The result remains attached to that request until Dismiss; only then can the
next request open. Expiry or withdrawal before approval closes the sheet with
a plain status line, which clears after five seconds or when another request
opens. A previous request’s status never appears inside the next sheet. A failed
read reports the read failure instead of claiming withdrawal. The sheet traps focus
and restores the original opener after the queue, including reopening from
Settings. Delayed native close events cannot dismiss a subsequent request.

The terms are `approvalReason(view)`, exactly the existing host Touch ID wording,
including U+202F space-grouped amounts and the requesting app's fingerprint.
The node does not supply a trustworthy app name. These host words deliberately
remain verbatim English in the Danish UI, with a short Danish explanation
below the terms. The sheet does not repeat the requester already present in
the signed terms. Controls, status and refusal copy use the en/da table. The
signed `approval_message` is shown unchanged under the disclosure, and the
existing approval action receives the same operation id and original message
bytes.

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
reopening from the retained list, all-pending queue counts, later-dialog
suspension and resumption, Tab/Shift-Tab containment, and focus restored to the
visible profile button. No browser errors occurred.

## Scope and verification

Round 1 merges `origin/main` at `ee1bb32` with a merge commit, retaining both
sides’ copy keys and main’s updated first-spend denomination wording. The fixes
add no dependencies, Rust changes, capabilities, signed bytes, or host command
semantics beyond that merge. Background notifications remain M1b. `cargo fmt`
was not run.

Round-1 verification:

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 113 files, 2,117 tests passed. Existing Solid
  computations-outside-root warnings remain.
- The new regression assertions first failed on the old implementation;
  all 35 sheet tests now pass. An independent code review found no actionable
  issues in the round-1 code and tests.
- Four refreshed native captures were visually inspected. Chromium interaction
  checks passed in en/da at default and 200% text, with no browser errors.

- From `src-tauri`, `RUST_TEST_THREADS=4
  TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`: 1,092 app tests
  and 12 FFI tests passed; one FFI test ignored. Four threads retain the prior
  verification’s workaround for the existing supervisor timing sensitivity.
- From `src-tauri`, `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'
  cargo test --test '*' --no-fail-fast`: 88 tests passed.
- Both Rust suites needed a rerun with localhost socket access; the first
  sandboxed runs failed because mock servers could not bind (`Operation not
  permitted`). Both socket-enabled runs exited 0.
