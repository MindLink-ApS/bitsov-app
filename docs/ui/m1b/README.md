# M1b — Mac approval notifications

Updated by merging M1a (`75e1237`) into M1b, originally built on `30d9028`.
A newly observed, live owner-approval request may
produce one local notification when the main Mac window is in the background
(including minimized). Focus is checked on arrival and again before delivery.
Focused arrivals stay in the M1a sheet and are not notified later on blur.

The click listener and a localized Review request action are registered before
delivery. The locked macOS backend needs an action to wait for body clicks. Both
the body click and Review request open the same sheet. Each notification carries only
a process-local numeric identifier and static localized copy. The mapping to the
approval op ID stays in memory. Clicking restores the window and selects that
exact request in the M1a sheet, including when another request was open. An
in-flight approval and unrelated active modal retain M1a's serialization rules.
Expired, withdrawn, completed, and unknown requests cannot be reopened by a stale
notification. Clicking never approves or signs anything.

The approval controller checks permission only for a background request; if permission is absent,
the plugin permission API is requested once per mounted approval session. Nothing
requests permission on launch. Denial or native API failures silently leave the
in-app sheet available. The OS can suppress notifications independently.

## NEW-DEPENDENCY

- Official `tauri-apps/plugins-workspace` crate `tauri-plugin-notification`,
  exactly `=2.7.0`, macOS target only.
- Official `@tauri-apps/plugin-notification`, exactly `2.7.0`.
- Both match the existing Tauri **2** major. Cargo and npm lockfiles are committed.
  Cargo adds the plugin's notification backends transitively; no separate direct
  notification dependency is introduced.
- Local OS notifications only: no push registration, push service, cloud endpoint,
  remote attachment, or remote notification content.
- Capability `approval-notification` is macOS-only and grants only `main` the
  permission-check/request, local notify, action/listener registration/removal, focus
  check, and show/unminimize/focus commands. The assistant has no grant. Release
  builds include the capability; mobile builds exclude it.
- Copy: title `BitSov`; en `An app is asking for your approval`; da
  `En app beder om din godkendelse`. No amounts, memo, trip-code, name, key,
  signed message, or op ID enters notification text or metadata. The title,
  body and action label all pass through `safeApprovalText`, shared with
  #316's approval prompt sanitizer.

Official sources: [plugin source at 2.7.0](https://github.com/tauri-apps/plugins-workspace/tree/notification-v2.7.0/plugins/notification)
and [Tauri notification guide](https://v2.tauri.app/plugin/notification/).

### Platform limits and manual verification

The official plugin's desktop permission implementation returns `granted` and
does not expose macOS's notification authorization status. macOS owns any system
prompt and notification suppression; this code cannot force a prompt or detect
an OS-level denial through that API. The denied/error fallback is covered at the
API boundary. Version 2.7.0 supports desktop `onAction` callbacks; older versions'
mobile-only callback assumptions must not be used here. In development the
upstream macOS backend uses Terminal's identity; validate real OS permission,
notification appearance and click behavior in an installed BitSov `.app`.

Manual Mac check (not automated): with notifications allowed, background then
minimize BitSov and deliver two requests; click the second notification and check
its terms in the restored sheet. Repeat focused (no notification), denied in
System Settings (sheet only), with an expired request, and in English and Danish.

## Original M1b verification (before the M1a update)

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 114 files, 2,096 tests passed. Existing Solid
  computations-outside-root warnings remain.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`: the
  unrestricted run hit M1a's documented
  `supervised_refusal_waits_for_consent_then_repairs_and_starts_normally` timeout.
  The complete rerun with `RUST_TEST_THREADS=4` passed: 1,092 app tests plus
  12 FFI tests; one existing FFI test ignored.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast`:
  all 88 integration tests passed.
- `npm run build` and `npm run authority`: passed. Existing bundle-size
  advisory remains.

Independent review approved after fixing the release capability glob, native
click action requirement, arrival-time focus race, and notification mapping
recovery after a temporary failed poll. Focused tests cover those regressions,
foreground/background delivery, exact request selection, permission denial,
generic copy without request data, lifecycle cleanup, and English/Danish in-app fallback.
No installed-app notification smoke test was performed. No `cargo fmt` was run.

## M1a merge integration

Merged `origin/ui/m1a-owner-approval-sheet` at `75e1237` into M1b at
`997de8d` with a merge commit. Git reported no textual conflicts. Two integration
adjustments were needed:

- `OwnerApprovalSheet.tsx`: explicit notification selection now clears any old
  expiry/status notice, matching M1a's automatic queue selection. The global
  busy guard remains in place: a click for another request waits for Touch ID
  to finish and never unlocks dismissal in the meantime.
- `ownerApproval.ts` / `ownerApprovalNotification.ts`: exported #316's existing
  sanitizer as `safeApprovalText` and applied it to the generic notification
  title, body and action label. Request data remains outside the OS payload.

Regression tests first reproduced both the unsanitized notification copy and
the old expiry notice resurfacing after a notification-opened request closed.
Both now pass. Notification-click tests also exercise all five dismissal paths
during Touch ID, exact selection after completion, and one open dialog.
Independent review found no material correctness issues.

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 114 files, 2,139 tests passed; existing Solid
  computations-outside-root warnings remain.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast`:
  all 88 integration tests passed with localhost socket access.
- `RUST_TEST_THREADS=4 TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`:
  1,092 app tests and 12 FFI tests passed; one existing FFI test ignored.
  The initial sandboxed run was blocked by localhost socket permissions.
  With socket access, default concurrency passed 1,091 app tests and timed out
  in `price_floor_refusal_is_only_offered_after_failed_stderr_exit`. The full
  rerun passed using M1a's documented four-thread supervisor workaround.

No installed-app smoke test or `cargo fmt` was run for this merge.

## Main re-cut follow-up (2026-10-22)

On the M1b re-cut at `77e87cc`, based on main `e9e602b` after #317's
squash merge, the full default-thread library run reproduced 1,091 passes
and one failure:
`app::post_rc7_tests::supervised_refusal_waits_for_consent_then_repairs_and_starts_normally`.
It hit `Elapsed(())` at the five-second termination polling deadline.
The supervisor test file and the `spawn_node` implementation were byte-identical
between main and the original M1b commit: this was the previously documented
timing flake, not a notification regression.

The two affected supervisor tests now register a per-app `Notify` and await
completion after the real waiter drains output and records exit, then assert
the termination state. `notify_one` retains an early completion permit. The
signal hook is compiled only for tests; no production behavior, sleeps, or
thread-count settings changed. The sibling price-floor test uses the same
handshake because it had the same polling deadline and documented failure.

The sheet now shows one short requester fingerprint line immediately
under the title, using English/Danish copy. The signed terms remain verbatim
and appear once. A regression test in both languages failed before the fix
and now checks the line, its position, and nonduplicated budget terms.

The first repetition sequence passed seven full runs, then low-battery
hibernation interrupted run 8 (system power log: 13:56:35–19:21:43).
Four existing `app::control_act_tests` failed with `spend_expired` after wake:
`nothing_paid_resend_reuses_the_same_operation_id`,
`nodes_without_operations_and_rooms_never_get_an_operation_id`,
`operation_error_context_refreshes_after_waiting_for_money_lock`, and
`ledger_success_and_paid_undelivered_are_retained`. Both supervisor tests
passed in that run. All four affected tests passed immediately after wake
without code changes. The consecutive-run count was restarted from zero;
the interrupted sequence is not included in the final verification count.

The next sequence passed 19 full runs, then exposed a separate pre-existing
fixture flake in
`app::control_act_tests::second_device_poll_skips_bad_entries_and_keeps_valid_comparisons`.
Its fixture globally replaced `1300` with the expiry timestamp after inserting
a random approver key, corrupting identifiers containing those digits. A
deterministic identifier-collision regression failed against that fixture.
The test-only builder now substitutes only expiry fields; no production
validation changed. This regression adds one library test, bringing the app
count to 1,093. Verification was restarted again on the final patch.

The #318 amount-spacing change is limited to display-only `groupDigits`
formatting explicitly opted into by `.sats` containers (`white-space: nowrap`).
General amount text, approval summaries, and native Touch ID prompts retain
U+202F narrow no-break grouping. The shared approval fixture is byte-identical
to main; Rust and TypeScript tests assert the prompt bytes, including the
native contact-intent path. The input parser accepts both U+202F and U+2009.
A rendered-text regression checks that U+2009 amounts are inside nowrap
containers across English/Danish shell panels and both denominations.

Notification review preserves busy Settings and Wallet panels. Their activity
scopes cover money actions, device setup, starter requests, profile publishing,
and node switching, and still propagate to the app-wide pairing guard. The
clicked request remains selected and opens when the panel is closed; idle
panels can close immediately. Regression tests cover busy and idle navigation.

Final follow-up checks: `npx tsc --noEmit` passed; `npx vitest run`
passed all 2,141 tests in 114 files (with Solid disposal warnings).
`TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast`
passed 88 integration tests across 16 targets. The initial sandboxed library
attempt could not bind loopback fixture servers (`Operation not permitted`;
620 passed, 473 failed), so it is excluded from the repetition evidence;
the requested runs use permissions that allow those local test servers.

The resumed verification completed three more full `cargo test --lib` runs
with `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` and default test threads:
1,093 app tests passed in each, with zero failures or ignored app tests.
Each invocation also passed 12 workspace library tests with one existing
ignored test. Both supervisor handshake tests passed in all three runs.
Together with the 15 consecutive successful runs reported by the preceding
session, this gives 18 successful full default-thread runs of the deterministic
supervisor fix. The earlier interrupted/fixture-failure sequences and the
sandbox-blocked attempt above are excluded. Run 16 used the carried-over patch;
runs 17 and 18 also include the U+2009 native display changes. The supervisor
handshake and identifier-collision fixture fix were unchanged throughout.
No `cargo fmt` or installed-app smoke test was run in this follow-up.

## PR #320 fix round

- Restored main's U+202F consent formatting and unchanged shared fixture.
- `npx tsc --noEmit`: passed.
- `npx vitest run`: 119 files, 2,182 tests passed. The subsequent notification
  regression run also passed the two added idle-panel cases (26 tests across
  notification and activity-scope suites). Existing Solid root warnings remain.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`: 1,093 app
  tests and 12 FFI tests passed; one Touch ID enrollment test ignored.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast`:
  all 88 integration tests passed. Rust tests used unrestricted local sockets;
  the first sandboxed attempt could not bind test listeners.
- No `cargo fmt` or installed-app notification smoke test was run.
