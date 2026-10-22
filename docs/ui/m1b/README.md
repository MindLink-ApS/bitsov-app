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
