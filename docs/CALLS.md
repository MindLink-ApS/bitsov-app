# 1:1 calls (regtest prototype)

## M6 A1: node-routed audio

Owner decision (M6): **the node is the cell.** Call audio goes app → own node →
peer node → peer app. Direct app-to-app WebRTC media is **off** in M6 builds and
is never the call path. Signalling (the four paid kinds 400–403) is unchanged.

- **Build flag.** `VITE_CALL_MEDIA` (parent build process, like
  `VITE_STARTER_BALANCE`; fixed at build time in `vite.config.ts`). Unset or
  anything but the exact value `webrtc` is the M6 profile: node-routed audio
  on, app-to-app media, video and meetings hidden and unreachable
  (`src/control/callFlags.ts`). `VITE_CALL_MEDIA=webrtc` is the pre-M6 lab
  profile only; the WebRTC code stays in the tree for it and for the lab
  checks below, not for users. The Playwright a11y servers
  (`playwright.webkit.config.ts`, `playwright.safe-areas.config.ts`) and
  `scripts/ui-layout/meeting-planner-check.mjs` pin it, because their
  meeting-planner specs exercise that hidden UI.
- **The host owns the socket.** The Rust host opens the node's owner-scoped
  `GET /api/v1/calls/:call_id/media?peer=<counterparty>` WebSocket exactly as
  it owns `/ws` (`src-tauri/src/control/media.rs`): same loopback API base (a
  local node, or the loopback proxy of the paired Noise remote-access tunnel),
  same local proxy credential, the `bitsov.v1` subprotocol, and the token as
  the `bitsov.jwt.<token>` subprotocol the node reads first (never in the URL).
  The node admits the socket only for a `(peer, call_id)` it knows, under a
  paired token with `spend`; the host reconnects with backoff while the call
  lasts and stops on a refusal. The renderer opens no socket and sees no
  token; the CSP keeps `connect-src 'self' ipc:` only. Three main-window
  commands: `call_media_open(call_id, peer, on_frame)`,
  `call_media_send(raw payload)`, `call_media_close()`. Frames reach the
  renderer on one Tauri channel (binary frames; link transitions as parsed
  JSON objects `{ link, detail }`); both directions pass through bounded queues
  (50 frames) that drop the oldest frame under backpressure.
- **Wire format.** Each binary message is `seq` (u32, big-endian) then the
  payload (at most 4096 bytes, the node's cap). The host assigns `seq` upward
  and validates the shape downward; the node forwards payloads opaquely. The payload is the app's "bitsov media
  payload v1" (`src/control/mediaFrame.ts`): a type byte, then bytes. `0x00`
  HELLO carries the codecs this app decodes; `0x01` is one 20 ms G.711 mu-law
  frame (160 bytes); `0x02` is one 20 ms Opus packet. Each app sends Opus only
  after the peer's HELLO said it decodes Opus, mu-law until then. A HELLO
  takes a `seq` but no playout time.
- **Renderer audio engine** (`src/control/callAudio.ts`). Microphone via the
  engine's existing `getUserMedia` (echo cancellation and noise suppression
  requested), 20 ms frames cut by an AudioWorklet, Opus through WebCodecs
  `AudioEncoder`/`AudioDecoder` where the webview has it, otherwise mu-law in
  pure TypeScript (no new dependency). Playout runs in an AudioWorklet whose
  jitter buffer (`src/control/jitterBuffer.ts`) reorders by `seq`, conceals
  loss by fading the last frame, drops late frames, and adapts its target
  delay between 60 and 120 ms. Webviews without AudioWorklet fall back to a
  ScriptProcessorNode and scheduled AudioBufferSourceNodes with the same
  buffer. Mute, and clean teardown (worklets, codecs, context, socket) on
  hangup.
- **How the engine switches.** `call.ts` still drives one
  RTCPeerConnection-shaped object per call; in M6 builds that object is
  `src/control/nodeRoutedConnection.ts`, not an `RTCPeerConnection`. Its
  "SDP" is a placeholder carrying `a=x-bitsov-media:node-routed-v1` and the
  call id; once both descriptions are set it opens the host media socket for
  the call id and its counterparty, and reports `connected` only when the host
  reports the link open and the audio graph is ready. An audio graph that
  cannot be built (no AudioContext, worklet refused) closes the socket and
  ends the call rather than leaving a silent live call. It gathers no
  candidates and contacts no STUN or TURN server. A peer that
  answers with direct-media SDP (a pre-M6 app) ends the call as "their
  answer could not be used", nothing more paid. If the node link drops, the
  host reconnects; after 30 s without it the call ends. The node's refusal of
  the socket (for example an unknown call) ends it at once.
- **Label.** While a node-routed call is ringing, connecting or live the card
  says *Encrypted between your node and theirs — both nodes can hear it* /
  *Krypteret mellem din node og deres — begge noder kan høre opkaldet*. The
  STUN, direct-recovery and relay notes are not shown.
- **Payment for the node leg is slice A2.** This slice pays nothing for media.
  The hook is `onSession` on `nodeRoutedConnection.ts` (media session opened
  / closed, with the call id and time), wired to `callMediaSession` in
  `Shell.tsx`; the card's `payment` slot stays where it is.
- **Checks.** `npm test -- tests/g711.test.ts tests/media-frame.test.ts
  tests/jitter-buffer.test.ts tests/node-routed-connection.test.ts
  tests/call-media-flag.test.tsx` (codec round trip, frame codec, jitter
  ordering/loss/late drop/reorder, the adapter, and the shell with the flag
  on: no `RTCPeerConnection`, no video or meeting controls, the label, live on
  the host's link). `cargo test control::media` (frame codec, drop-oldest
  queue, URL rule, a loopback media socket that assigns `seq` upward and
  validates downward, a refused handshake that does not reconnect). These are
  headless: they prove the wiring, not audio quality, device capture, or a
  node that serves the route. Two-device acceptance against a node with the
  media route is separate evidence.

## Pre-M6 lab path (`VITE_CALL_MEDIA=webrtc` only)

- **Media** goes directly between the two apps (WebRTC in the webview). It never passes through a node and is not billed.
- **Signalling** is four paid messages through your node: offer (the callee's call price, once per call), answer, ICE, hangup (the realtime price each). Same budget, approval and exactly-once rules as messages. Only contacts you have already paid can be called.
- **No third party by default.** The app ships no STUN or TURN server. With none set, calls use host candidates only, so they connect on the same network (or over a VPN).
- **Calls across routers (NAT)** need a STUN server you choose: Settings → Display → Calls, `stun:host` or `stun:host:port`. That server learns your public IP address each time you place or accept a call. TURN relays are not supported (a relay would carry your media), so pairs behind symmetric NAT or carrier-grade NAT will not connect.
- **Your own node as the STUN server:** if your node runs its STUN responder (genome `[calls] stun_listen`) and has a public address (`[network] advertised_addr`), Settings → Calls offers **Use my node (stun:host:port)**. Choosing it only fills the field; calls use it after you press Save. Nothing switches automatically. If the responder runs but the node has no public address, Settings says so and shows the port to enter yourself. The responder helps apps that reach your node from outside its network. An app behind the same router mostly learns its local address.
- **Ending a call:** Hang up pays one hangup message. Cancel while calling pays nothing if the offer has not gone out; if it is already being paid, the microphone stops at once and nothing more is sent. Tracks stop immediately, even if signalling hangs or refuses. After a recovery, Hang up closes both admitted call ids (one paid hangup per id). Closing the window, an expired recovery window or a call that never connects (30 s) ends locally without paying a hangup.
- **Recovery (1:1 calls):** `disconnected` shows **Reconnecting…** while keeping tracks and the original start time. A blip under 2 s needs no new payment. A longer disconnect or an ICE/connection failure attempts one ICE restart per call, with a fixed 30 s grace window. Repeated events do not extend it. Both apps must run this version for automatic continuation. No TURN server or new service is added; both apps still need a reachable STUN server across NAT, and some networks remain unreachable without a relay.
- **Recovery charges:** the node rejects repeated offers/answers on an existing call id. Recovery therefore uses one fresh paid admission, retaining the UI call id. The caller's upfront ceiling includes the original offer/hangup plus one recovery offer/hangup. The callee pays a recovery answer, possibly one restart request, and one hangup for each admitted id if they hang up. The initial grant preflight covers the ordinary call; recovery is optional, is not a budget reservation, and checks the remaining grant again before a new offer. Existing authorization, grants and host budgets apply to each signal. Refused or unknown payments are never retried automatically; the grace window ends the call. A subsequent drop gets a grace window but no second paid attempt.
- **Media failures:** denied permissions and missing/busy devices show actionable messages. Capture has a 15 s deadline; any stream arriving after cancellation is stopped. Camera re-enable failure leaves the audio call usable and the camera off.
- **UI state:** `CallView.state` exposes `idle | ringing | connecting | live | reconnecting | ended` through `onView` and the shell's `Actions.callView` accessor. `phase` retains the card's `calling` and `incoming` distinctions. `callId` and `liveAt` remain stable through recovery; dismiss moves ended → idle.
- **Camera off** stops the camera (its light goes off); camera on captures it again.
- Checks: `scripts/calls/media-check.py` (real WebRTC in Chromium through the app's call engine, loopback only) and `scripts/calls/regtest-demo.sh <genome>` (paid signalling on regtest plus the media check). Both need a build with `VITE_CALL_MEDIA=webrtc`.

## Native media permissions

- **Android:** `src-tauri/gen/android/app/src/main/AndroidManifest.xml` is the
  committed Android project source (see `.gitignore`), not a build output. It
  declares `CAMERA`, `RECORD_AUDIO`, and `MODIFY_AUDIO_SETTINGS`. The locked wry
  0.57.0 `RustWebChromeClient.kt` maps `RESOURCE_AUDIO_CAPTURE` and
  `RESOURCE_VIDEO_CAPTURE` to those Android permissions. Its
  `grantPermissionRequest` calls `WryActivity.requestPermissions` first, grants
  the WebView resources only when the permissions are granted, and denies on
  refusal. No app-specific WebChromeClient override is needed. Recheck this flow
  when upgrading wry; do not edit its generated Kotlin files.
- **macOS:** `src-tauri/Entitlements.plist`, referenced by
  `bundle.macOS.entitlements`, enables microphone and camera access under the
  hardened runtime. Usage descriptions remain in `src-tauri/Info.plist`.
- **iOS:** `src-tauri/gen/apple` is the committed Xcode project (see
  `.gitignore`). The usage descriptions live in `src-tauri/Info.ios.plist`,
  referenced by `bundle.iOS.infoPlist` in `tauri.ios.conf.json`; Tauri merges
  it into `gen/apple/bitsov-app_iOS/Info.plist` on each iOS build
  ([configuration reference](https://v2.tauri.app/reference/config/#iosconfig)).
  It repeats the macOS wording for `NSMicrophoneUsageDescription` and
  `NSCameraUsageDescription` (keep both files in step) and adds
  `NSLocalNetworkUsageDescription`, because node endpoints and host-only call
  candidates can be LAN addresses. The desktop `Info.plist` is unchanged.

Headless checks validate configuration and compilation, not OS permission prompts
or real-device capture. Native media acceptance still requires separate device
testing.

## Recovery wire conventions

The existing node v1 schema is unchanged. Only the original caller creates a restart offer (`restartIce()` plus `createOffer({ iceRestart: true })`). The SDP carries `a=x-bitsov-restart-of:<original-call-id>` under a fresh 32-hex `call_id`. The callee auto-answers only an active, negotiated call with that original id, the same authenticated peer and media, and no prior accepted restart. The attribute is removed before applying the SDP. Duplicate offers cannot trigger another answer payment. Unmatched restart offers are ignored, including after a call ended.

If only the callee observes failure, it sends one kind 402 request with an empty `candidate` and `sdp_mid: "bitsov-restart-v1"`. This reserved app marker fits the existing node's candidate/mid limits; it is intercepted before `addIceCandidate`. Ordinary candidates continue through the existing path. Both sides failing still produce only one new admission. Hangup accepts either admitted id so it works during negotiation; the current id is closed first. Unknown payment results remain owned by the host journal.

Headless coverage: `npm test -- tests/control-calls.test.tsx tests/control-meetings.test.tsx`. These tests use peer-connection/track doubles and the real engine and shell. They do **not** establish WKWebView, TCC, real media or cross-network connectivity. Those require a separate two-Mac smoke test; do not substitute the mock result for that evidence.

## Meetings (up to 4, regtest prototype)

- **A meeting is a set of 1:1 calls.** The roster is you plus 1 to 3 contacts, fixed when you invite. Every pair of participants is one ordinary paid call ("leg"), placed and paid by whoever is earlier in the roster: the host rings everyone, the first invitee rings the later ones, and so on. No new price, no per-minute payment, no relay.
- **Invite:** Call buttons → **Meeting**, pick up to 3 contacts. Prices are read afresh when the planner opens; contacts without a call price are greyed out. The button shows the all-in ceiling (each invitee's call price plus one hangup) before anyone is rung, and that ceiling binds: each leg pays at most the price you were shown (and at most the live price). If a price went up in between, that leg is refused with nothing paid. Legs are paid one at a time through the same budget, approval and exactly-once path as a call.
- **Join:** the invite card names everyone in it and the join ceiling (an answer and a hangup to each earlier participant, a call to each later one). Joining answers every ringing leg and rings the later participants; a leg that rings after you joined is answered without another click. The prices are read afresh when the card opens and bind the same way, including legs answered after you joined. **Decline** pays one hangup per ringing leg (its price is on the button); ignoring an invite pays nothing (it ends after 60 s).
- **Leave:** media stops at once, then one paid hangup per leg the other side knows about. A leg still being placed is cancelled and pays nothing more; if its offer was already being paid, that person may keep ringing for up to a minute. A microphone that was still opening is stopped the moment it arrives. The others stay connected; the host has no "end for all".
- **When a leg fails** (their node takes no calls, they are not your contact, the payment is refused) that pair shows **No link** and the rest of the meeting goes on. Two invitees who are not each other's contacts will not hear each other. Nothing retries on its own.
- **Media** is full mesh: one direct connection per other participant, sharing one microphone (and camera). Upload grows with each participant. Same STUN rule as calls: none unless you set one.
- **Only nodes that take meetings are rung.** A node older than the meetings change would refuse a meeting leg only after it was paid. So a contact can be picked, and a leg is ever sent, only if they are connected and their node advertises `call_meeting_v1` (genome #139), and your own node lists it too. Others show **needs update** or **not connected**. When joining, a later participant without it gets no leg (No link, nothing paid).
- Your node refuses a leg out of roster order (or to someone not in the roster) before paying anything. One meeting or one call at a time.
- Checks: `scripts/calls/meeting-media-check.py` (real WebRTC between three Chromium pages through the app's meeting engine, loopback only) and genome `real_ldk_regtest_meeting` (three nodes on real LDK regtest, msat-exact).
