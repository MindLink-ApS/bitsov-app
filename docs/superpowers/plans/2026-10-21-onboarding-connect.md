# PR 1: connect without restart

Goal: execute the approved phone onboarding SPEC §6.2, §7 PR 1 and Fool verdict, with existing screens only.

Architecture: retain the pinned Noise transport, persisted descriptor, remote_recovery serialization and remote_change cancellation generation. Introduce remote_access_connect for explicit confirmed imports, wait for the old proxy to terminate before attachment, and use the same attach_remote path as bootstrap. Preserve the local-node and unresolved owner-recovery boundaries. Reuse existing foreground recovery and immediate take-once inbox polling.

Constraints: no cargo fmt, no window-opening binaries, no ticket/claim-code diagnostics; no new screens or copy redesign. Push only feat/onboarding-connect-no-restart.

- [x] Add regression tests for connect, proxy retirement/rebind, Forget cancellation and structured errors; observe failures.
- [x] Implement host command and main-window ACL; preserve existing import/replace compatibility.
- [x] Extend error contract (tailscale, clock, used, claim_mismatch); keep sanitized details.
- [x] Capture cold iOS scene URLs through a native bridge before scene connection; retain warm inbox delivery and Android intent behavior.
- [x] Wire existing import/replace callers to connect, enable native iOS QR scanner, and verify immediate mount inbox read.
- [x] Run no-sidecar cargo test --lib (desktop and mobile feature), tsc, vitest, build, authority, installed iOS/Android target checks.
- [x] Review final diff and prepare the authorized commit/push to HEAD:refs/heads/feat/onboarding-connect-no-restart (delivery recorded in the handoff).

Review focus: queued connect after Forget; shutdown while a local socket awaits authentication; old-node auth/approval state after replacement; first-run tickets never dial on phone; cold links retained until the first renderer read.


## Implementation decisions and verification

- Retained the already-landed foreground resume path and immediate `watchPairingLinks` read followed by the 750 ms poll. Existing tests cover persisted-descriptor retry after expiry, cancellation and recovery coalescing; the new inbox test covers immediate receipt before the first polling interval.
- Retained the existing `NSLocalNetworkUsageDescription`; no ATS exceptions or new networking path. Android `PairingLinkPlugin.load` takes the Activity launch intent into memory and leaves it pending until `takePendingLink`.
- `remote_access_connect` is the claimed-node join path. Desktop first-owner setup and switching away from a selected local sidecar retain legacy import behavior. Live remote replacement and phone imports use connect. This preserves existing desktop workflows without stopping a local node as an incidental pairing action.
- The native bridge is installed before the event loop. It waits for the application delegate, wraps the scene configuration callback, then hooks the returned delegate's cold and warm URL callbacks before scene creation. Original callbacks remain intact; the Rust inbox deduplicates warm Tauri delivery. No URL event broadcast, persistence, or logging is added.
- Error details use fixed local text. `clock` is a recovery hint for an expiry more than one day old, not a claim that clock skew was proven. Enrollment retains its existing error fields and adds `kind`/`detail` for compatibility.
- Review fixes: old token-refresh completion is fenced by the connection generation; every proxy task is retired before rebinding; another pinned node starts with a fresh retry budget while reconnecting the same node preserves its deadline. Regression tests reproduced both review findings before fixes.
- Host integration uses a real Noise/HTTP protocol fixture with an isolated pin store. It verifies ready/paired state and replacement on the same proxy address. No live regtest/signet service or physical phone was available in this no-window session. Native cold-launch kill/open and device-network permission smoke tests remain hardware acceptance work. Native protected-storage behavior is not substituted in the shipped app.

Recorded gates: desktop `cargo test --lib` with the no-sidecar override: 1,030 app tests passed, 12 FFI tests passed, one existing ignored FFI test. Mobile-feature app library: 574 tests passed. iOS aarch64 and Android aarch64 `cargo check --lib` passed. Final renderer rerun: 1,771 tests passed in 100 files. TypeScript, build and authority passed. The final targeted host run passed all nine connection regressions. Existing warnings remain: dead code on mobile targets, Solid test-owner disposal warnings, and the Vite large-chunk advisory.
