# iPhone Live call background audio

## Implementation

`Info.ios.plist` (selected by `tauri.ios.conf.json`) and the checked-in Xcode
Info.plist both declare `UIBackgroundModes = [audio]`.

The one-to-one call engine requests `call_audio_session(true)` only on entry
to Live. It requests `false` when leaving Live, including reconnecting, local
teardown, peer closure and terminal connection errors. Idle, incoming, ringing
and connecting do not acquire a native session. Repeated Live updates do not
reactivate it. Calls are serialized so an in-flight activation is followed by
its release; obsolete queued activations are skipped.

The command uses the existing `bitsov-ffi` static Swift bridge and dispatches
onto UIKit's main thread. `native/call_audio.swift` configures AVAudioSession
with `.playAndRecord` and `.voiceChat`, activates it, and on release deactivates
with `.notifyOthersOnDeactivation` and restores the previous category/mode/options.
A failed activation attempts rollback and returns an error to the call card;
it does not send a signal, retry a payment, or end an admission. A failed release
is reported and remains owned so termination can retry cleanup. Swift handles
`UIApplication.willTerminateNotification`; the Tauri exit path also releases
and latches termination so queued activations cannot reopen it. iOS does not
promise a termination callback on force-kill: the OS then releases process
resources. This does not promise to keep a call alive after force-quit.

On iOS visibility changes, video capture stops and its sender is detached;
audio tracks and the peer connection remain intact. Returning to the app leaves
the camera off until the user turns it on. Capture finishing after backgrounding
is discarded. Remote video is muted and an independent audio-only playback
element carries the voice, avoiding video playback suspension also pausing
received audio. Microphone mute remains the user's choice.

No silent playback, background task, new signalling or automatic payment is
introduced. Hang up, `op_end_call`, and in-call Pay use their existing paths.
There is no background session acquired at app startup or while simply viewing
the app. Meetings are not changed by this one-to-one call lifecycle hook.

Apple documents [voiceChat with playAndRecord](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/voicechat).
WebKit's [background microphone issue](https://bugs.webkit.org/show_bug.cgi?id=233419)
was closed after UIBackgroundModes support; its report confirms iOS 17.5.1.
The app's iOS deployment floor is older, so check the oldest supported physical
OS as well as the current release. Host/simulator results cannot establish
background microphone or network continuity on those devices.

## Automated checks

From the repository root:

```sh
bash scripts/test-ios-call-audio.sh
cd src-tauri
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast
TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo check --target aarch64-apple-ios --lib
cd ..
npx tsc --noEmit
npx vitest run
```

The Swift host test executes the production lifecycle with an injected session
driver: idle, Live, repeated updates, end, activation error, failed release and
termination (including a late activation). It also parses both shipping plists.
The macOS Rust integration suite runs this script. TS tests exercise call-engine
transitions, pending activation/end ordering, failure without new signals,
background video/capture races, and independent audio playback. Existing call
and payment regression tests remain in the full suite.

## Verification record (2026-10-23)

- Rust library suite: 1,107 passed; one existing Touch ID enrollment test ignored.
- Rust integration suite: 92 passed, including the Swift lifecycle/plist runner.
- `npx tsc --noEmit`: passed.
- `npx vitest run`: 2,217 passed across 121 files.
- `cargo check --target aarch64-apple-ios --lib`: passed with the installed toolchain.
- Independent review: camera capture/replacement races fixed and rechecked.

Rust tests needed sandbox access to ephemeral loopback ports; the iOS check
needed access to Swift compiler caches. No `cargo fmt` was run. Device QA below
remains outstanding; these results do not claim physical lock-screen continuity.

## Physical-device verification (required; not performed by these tests)

Use two paired devices on a working network and a test/signet node with explicit
small spend limits. Record app commit, iPhone model, iOS version, network and
route (receiver/speaker/Bluetooth). Install the iOS build with the iOS config.
Test without an attached debugger, which can mask suspension.

1. With no call, background/lock for 30 seconds. Confirm there is no ongoing
   call audio, microphone indicator or call-owned active audio session.
2. Place an audio call and wait for **Live** and two-way speech. Lock the iPhone,
   wait **30 seconds** while both sides keep speaking, then unlock. The call
   must still be **Live**, with uninterrupted two-way audio and the same call
   admission. Check for no new recovery offer, charge or spend slot.
3. Repeat by switching to another app for 30 seconds, then returning. Repeat
   for an accepted incoming call, muted microphone and a Bluetooth route.
4. Repeat with a video call: camera capture stops in the background, two-way
   audio continues, and on return the call is Live with camera off. Use Camera
   to resume video. No new call offer/payment should have occurred.
5. Hang up locally, then repeat and hang up from the peer while the iPhone is
   locked. Verify media ends, the session releases, and the existing admission
   closes. If the node refuses/returns unknown, use the existing End-call/check
   flow and verify no automatic retry or new payment.
6. During a foreground Live call use in-call Pay with explicit confirmation;
   verify its existing amount/fee/approval behavior and that audio remains live.
   Cancelling approval must send nothing. Repeat around lock/unlock.
7. Cause a terminal connection failure and confirm media/session cleanup.
   Force-quit during a call and reopen: there must be no revived audio session
   or automatic signal/payment. Resolve any retained admission through the
   existing recovery UI; force-quit is not an End-call payment instruction.
8. After an ended or declined call, lock/background again for 30 seconds.
   Confirm normal app suspension and no retained audio/microphone activity.

A passing UI label alone is insufficient: verify audible speech in **both**
directions during the locked interval. Record failures by OS version and audio
route before calling the device verification complete.

## Follow-ups

- CallKit for system call controls/audio interruption integration.
- VoIP push for incoming-call wakeup, with a separate reviewed admission flow.
- Native audio interruption/media-services-reset recovery and physical-device
  coverage across the supported iOS range; no automatic paid recovery added here.
