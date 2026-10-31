# iPhone M6 smoke check

On a Mac with full Xcode, an installed iOS Simulator runtime and an iPhone
simulator, run from the repo root:

```sh
npm ci
rustup target add aarch64-apple-ios-sim # Intel Mac: x86_64-apple-ios
scripts/ios-sim-smoke.sh --dry-run
scripts/ios-sim-smoke.sh
```

Optional: `IOS_SIM_UDID=<simulator UUID>` selects a particular available iPhone.
The script builds unsigned Debug with the simulator SDK and bundled frontend;
it never installs on a phone or uses signing identities, profiles or keychains.
It reuses simulator app data. For first-launch testing choose a fresh iPhone
simulator in Xcode. Open Simulator to continue manually if its window is closed.
Output is gitignored under `test-results/ios-smoke/`; `launch.png` is only launch
evidence, not a completed M6 test.

Use a reachable M6 home node, a second paired tester/peer, funded test balances,
and small spending limits. Obtain the node's actual connection/pairing details
from its owner. A phone needs a reachable LAN/VPN address; its `localhost` is
the phone itself.

- [ ] First launch: onboarding is readable, with no blank screen or crash.
- [ ] Connect to the home node; complete pairing and verify the shown node
  identity/short code. The app visibly reports the correct paired state.
- [ ] Check spending permission: its state, limit and expiry are visible.
  If permission is missing, request it and have the owner approve it.
- [ ] Send one paid message after reviewing the price. The peer receives it;
  capture the delivery/payment outcome and any error.
- [ ] Place an audio call. **Before Ring**, consent shows the price per minute,
  routing allowance and maximum hold. Cancel once, then reopen and confirm.
  Review/confirm the node's actual hold when requested.
- [ ] Answer on the peer: both sides reach Live and hear each other. Keep the
  call through a minute boundary and check the paid-minute status.
- [ ] Hang up: both sides leave Live, audio stops, and the cost/remaining hold
  settles or a clear recovery action is shown. Repeat with an incoming call
  answered and hung up on the iPhone.

Record pass/fail with screenshots of first launch, connection/pairing, spending
permission, message result, call consent (both amounts), Live and ended call.
Record app version/build (built app's `Info.plist`), git commit, node version
(from the node owner), simulator/phone model and iOS version. Keep pairing
links/tokens, keys and private message content out of shared captures.

Later, repeat the checklist on a phone using a separately installed build;
this script remains simulator-only. Include microphone permission and two-way
audio, then follow [the device background-audio checks](qa/ios-call-background-audio.md#physical-device-verification-required-not-performed-by-these-tests).
For layout-only regressions reuse `npx playwright test -c
playwright.phone-shell.config.ts` and [the existing phone-shell evidence](ui/u5-phone-shell/README.md).
