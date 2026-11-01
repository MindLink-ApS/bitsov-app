# Devices and people: locked phones, several devices, several people

Status: **design proposal, docs only.** Nothing here is built. It needs a
two-vendor review and the owner decisions listed at the end before any slice
starts. No code, node contract or release note may cite this file as shipped
behavior.

Three questions, in the order they will hurt users:

- **(a)** A call or a paid message arrives while the phone is locked or the app
  is in the background. Today the phone does not ring.
- **(b)** One person has a phone and a Mac. Both should show the same
  conversations, and a call should ring on both and stop on both when one
  answers.
- **(c)** Several people (for example a family) share one box. What is the
  foundation, and what must never be faked?

## 1. Principle, as the code already states it

Owner decision (M6), written in `docs/CALLS.md`, `src/control/callFlags.ts`
and the call wiring in `src/control/Shell.tsx`: **the node is the cell.** Call
audio goes app → own node → peer node → peer app. The app never talks to
another person's app directly in M6 builds.

What follows from that, and what this document keeps:

- **One box = one identity.** The node holds the identity key, the wallet and
  the channels. The app holds no seed and no funds.
- **Owner devices share the identity and its funds.** A phone and a Mac paired
  to the same box are the same person to everyone else. Each device has its own
  client key and its own device key (`src-tauri/src/device.rs`), but they speak
  for one identity.
- **No sub-accounts, no sub-seeds, no multisig** exist anywhere in the app or
  the node contract it pins today. Nothing in this document pretends one does.
  Option (c)2 below is the only path that would add them, and it is new node
  and protocol work.

## 2. Current state

### 2.1 Notifications are macOS only

- `src/control/messageNotifications.tsx` creates local OS notifications for
  live arrivals only (paid messages of kind 0/200 and incoming calls). It never
  prompts on arrival; the settings panel owns the permission tap. It does not
  notify when the window is focused, and the call notification carries an
  "Open call" action that shows, unminimizes and focuses the window.
- `src/control/Shell.tsx` creates it only when
  `isTauri() && /Macintosh|Mac OS X/ && !isMobilePlatform()`. On iPhone and
  Android the object is `null`: no notification is ever posted.
- `src/control/ownerApprovalNotification.ts` posts a content-free "review an
  approval" notification (static localized text, no names, amounts, memo or op
  id in the OS payload; ids are process-local). `OwnerApprovalSheet.tsx` mounts
  it only on macOS.
- All of these are **local** notifications raised by a running process. They
  exist only while the app runs and holds its live connection to the node.

### 2.2 No push, no system call UI

- There is no APNs, PushKit, CallKit, FCM or any push dependency in the app,
  the Rust host or the Apple/Android projects.
- `src-tauri/gen/apple/bitsov-app_iOS/Info.plist` declares
  `UIBackgroundModes = [audio]` with the comment that it is used only by a live
  call, "no VoIP push/CallKit".
- `src-tauri/native/call_audio.swift` only switches the shared
  `AVAudioSession` to `playAndRecord`/`voiceChat` while a call is live and
  restores it afterwards. It explicitly does no silent audio, background task,
  timers or call signalling.

### 2.3 What a locked phone does today

- Incoming calls are paid messages (kinds 400–403) that arrive on the host's
  live `/ws` connection to the node. When iOS suspends the app, that connection
  stops, so the offer is not seen until the app is opened again.
- `src/control/call.ts`: an offer rings for `RING_MS = 60_000`. If the app is
  opened later, an offer older than that is already timed out.
- `Shell.tsx` wires `document.visibilitychange` to `calls.setBackgrounded()`
  on phones. A live call that stays hidden, locked or with a silenced
  microphone is hung up after `SILENCED_GRACE_MS = 20_000`
  (`stopWhenSilenced`), so no paid minute runs while the user cannot hear it.
  This is deliberate and stays until (a) gives the OS a real call to show.

**Result: a locked or backgrounded phone cannot ring, and cannot show a
message alert.** The Mac rings only while BitSov is running and not focused.

### 2.4 Each install is its own paired client

- `docs/ONBOARDING_PAIRING.md`: each install loads or creates its own Ed25519
  client key under `<app data dir>/app-client/` and pairs with the node on its
  own.
- `docs/SECOND_DEVICE_JOIN.md`: a later device joins with word comparison and
  approval from an already-enrolled owner device. The node registers each
  device and labels it by platform (iPhone, Android phone, Mac, Windows).
- `src-tauri/src/device.rs`: each device has its own enclave device key and
  signs its own approvals with Touch ID / biometrics.

### 2.5 Shared through the node vs. kept per install

Shared, because the node holds it:

- messages and history, contacts, rooms, the wallet balance and channels;
- the list of owner devices and pending owner approvals on the node;
- call records the node keeps (`GET /api/v1/calls?peer=`).

Per install, because the host keeps it locally:

- **Budget book** — `src-tauri/src/budget.rs`,
  `app-spend/budget-<node>.json`: budget numbers and a rolling 24-hour ledger
  of what *this* app reserved and paid. The autopay approval (`Autopay`) lives
  only in host memory for at most the budget window and ends when the app quits.
- **Spend journal** — `src-tauri/src/spend_journal.rs` under `app-spend/`:
  the durable ambiguity fence for this install's sends and call blocks. It is
  not a payment authority, and it is never deleted.
- **Pending console approval** — `device.rs` `approvals_path()`,
  `approval-<node>.json`.
- **Notification settings** — `localStorage` keys in
  `messageNotifications.tsx`.

Consequence: a phone and a Mac paired to one box each have their own daily
book. A person with two devices can, in the worst case, spend up to twice the
daily total they approved, once per device. The node's per-message price cap
still applies to each send.

### 2.6 Two devices and one call today

Both devices hold their own `/ws` and both can see the same offer. Answering on
one does not stop the other: `call.ts` `receive()` drops any message whose
sender is the own identity, so the second device has no signal that the first
answered. It keeps ringing until the caller hangs up or `RING_MS` runs out.

## 3. Design (a): ring a locked phone

### 3.1 iOS: PushKit VoIP + CallKit

- Add the `voip` background mode and a PushKit VoIP push registration. Apple
  requires that every VoIP push is reported to CallKit at once
  (`reportNewIncomingCall`), or the app is terminated and later pushes are
  withheld. So VoIP push and CallKit come together or not at all.
- The push wakes the app; CallKit shows the system incoming-call screen on a
  locked phone. The app then reconnects to the node, fetches the offer by call
  id and either keeps the CallKit call or ends it at once if the offer is gone.
- On answer, the app takes the audio session from CallKit
  (`provider(_:didActivate:)`) instead of `call_audio.swift` activating it.
  `call_audio.swift` keeps its own path for builds without CallKit.
- With a real system call, `SILENCED_GRACE_MS` no longer needs to hang up a
  locked call: iOS keeps the microphone for a CallKit call. The grace stays for
  non-CallKit builds and for a microphone that is actually silent.
- Paid messages and owner approvals use a normal (alert) APNs push with
  static text, not VoIP. Approvals still open the in-app sheet; nothing is
  approved from the lock screen.

### 3.2 Android: FCM data message + foreground service

- An FCM **data** message (high priority) wakes the app. For a call it starts
  a short-lived foreground service with a full-screen call notification
  (`CATEGORY_CALL`, `USE_FULL_SCREEN_INTENT`), or a `ConnectionService` /
  Telecom integration if the review prefers the system call UI.
- During a live call the foreground service (type `phoneCall` or
  `microphone`) keeps the process and the microphone.
- Devices without Google Play services get no push. They behave as today and
  the settings screen says so.

### 3.3 Pushes carry no content

Every push payload is **content-free**:

- no sender name, number, avatar, amount, memo, room or message text;
- at most an opaque, random, single-use wake token and a type
  (`call` / `message` / `approval`);
- the app fetches everything else from its own node over its existing
  authenticated connection after it wakes, and builds the visible text locally,
  exactly like `ownerApprovalNotification.ts` already does.

For CallKit, the caller name shown on the lock screen is resolved by the app
after the fetch, then updated with `reportCall(with:updated:)`. If the fetch
fails in time, the screen says "BitSov call" and nothing else.

### 3.4 Who sends the push (open, privacy-critical)

APNs and FCM only accept pushes from a server holding the developer's
credentials (APNs key / FCM service account). The box cannot hold those
credentials safely, because every box would then hold a key that can push to
every BitSov device. So something central has to send. Options:

| Sender | What it learns | Cost |
|---|---|---|
| A. Relay run by the publisher | Device push token, the box that asked, time of each wake | One small stateless service; a new party in the metadata path |
| B. Relay per hub / operator | Same, but split across operators | Each operator needs push credentials; harder to run |
| C. No push; keep the phone connected | Nothing new | Not allowed by iOS for a suspended app; drains battery on Android |

Minimum rules if A or B is chosen:

- The relay never sees who calls whom. The box sends "wake token X"; the
  relay maps X to a push token and forgets the request. No caller id, no peer
  node id.
- Wake tokens rotate and are registered by the device through its own box,
  not by the caller's box. A peer can never trigger a push directly.
- Rate limits at the box (per peer, per minute) so a stranger cannot use
  pushes to drain a battery or probe whether a device is online. Calls from
  strangers that the node would refuse anyway never cause a push.
- The relay still learns "this box woke this device at this time". Apple and
  Google learn the same. This is a real leak and must be written down in the
  app's privacy text before release. Owner decision D1.

## 4. Design (b): one person, several devices

### 4.1 Same conversations

Already true for anything the node stores: messages, contacts, rooms and
history come from the node, so the phone and the Mac show the same threads.
Remaining gaps, for later slices:

- read state and "last seen" per thread are local; they should move to the
  node as owner-scoped metadata, or stay per device by design;
- an outgoing message sent from the phone appears on the Mac when the node
  delivers history, not live, unless the node echoes own sends on `/ws`.

### 4.2 Ring every device of the identity; first answer wins

- The callee's **node** owns the ring. On an incoming offer it fans out to
  every registered owner device: live `/ws` where connected, a content-free
  push (section 3) where not.
- The first device that sends a valid answer for the call id wins. The node
  binds the call (and its media socket, which it already admits per
  `(peer, call_id)`) to that device's pairing, and rejects a second answer for
  the same call id.
- The node then tells the other devices "answered elsewhere" (a new owner-only
  event on `/ws`, or a VoIP push with type `cancel` that maps to
  `CXCallEndedReason.answeredElsewhere`). The app stops ringing and shows
  nothing more.
- Declining on one device does **not** decline everywhere by default; it only
  silences that device. A real "Decline" (hangup to the caller) is a separate
  button. Owner decision D3.
- The app change is small: `call.ts` keeps ignoring messages from the own
  identity as peer messages, but handles the new node event to end a ringing
  offer locally with no hangup and no payment.

### 4.3 One spend limit for the person, not per device

Section 2.5 shows the gap: each install keeps its own budget book. Two ways
to close it:

1. **Sync the book through the box.** Each install keeps `budget.rs`, but the
   ledger and numbers are stored on the node as owner-scoped data and merged.
   Hard: two devices can reserve at the same moment; a merge needs the node to
   serialize reservations anyway.
2. **The box grant is the single source (recommended).** The node already
   enforces signed limits for explicit payments and grant ids for app-grant
   calls. Extend that: the owner's daily budget and per-contact budgets become
   a node-side grant signed once with a device key. Every device spends against
   the same node counter. The local book becomes a cache and a display, never
   the authority.

The spend journal stays per install. It records what *this* install may have
sent and must keep doing so; it is a fence, not a limit. Approvals already live
on the node; the per-install part is only the pending view, which can be
re-read from the node after a restart.

## 5. Design (c): several people on one box

Calls and messages must reach **a person**, not a box. Today person = box.
Three options:

### Option 1: one box per person (works today)

Each family member has their own box (or their own hosted node), their own
identity, wallet and devices. A parent and a spouse are two contacts of each
other. Nothing new to build. Cost: one box each, or a hosted node each.

### Option 2: node-side sub-identities (new node and protocol work)

One box runs several identities, each with its own keys and its own devices.
Funds are either:

- **2a. split by accounting** on one wallet: the node keeps a per-identity
  balance and enforces it; on chain it is still one wallet, so the operator of
  the box can move everyone's funds; or
- **2b. a derived sub-seed per identity**: each person's keys and funds are
  separate cryptographically; the box hosts them, but recovery and export are
  per person.

Either way this is a new identity model in the node: routing, pricing, call
admission, pairing scopes and backups all change. It cannot be done in the app.

### Option 3: shared household identity with device labels (no privacy)

One identity, one wallet; each device is labelled ("kitchen iPad",
"a parent's phone"). Everyone in the house reads every message and can spend
the shared balance. Calls ring every device (section 4.2). Easy, and honest
only if the app says so loudly.

### Trade-offs

| | 1. Box per person | 2. Sub-identities | 3. Shared identity |
|---|---|---|---|
| Works today | Yes | No | Mostly (labels only) |
| Privacy between people | Full | 2a: from each other, not from the box owner. 2b: stronger | None |
| Separate funds | Yes | 2a: accounting only. 2b: yes | No |
| Call rings the right person | Yes | Yes, after node work | Rings everyone |
| Hardware / hosting cost | One box each | One box | One box |
| Node / protocol work | None | Large | Small (labels) |
| Recovery | Per person | 2a: shared. 2b: per person | Shared |
| Risk of misleading copy | Low | Medium | High |

### Recommendation

- **Now:** option 1. It needs nothing new and keeps "one box = one identity"
  true. Onboarding can say "each person in the house gets their own BitSov".
- **After M6:** write the node design for option 2, with 2b as the default
  candidate because it keeps funds separate by keys, not by trust in one
  operator. App work waits for that design.
- **Not recommended:** option 3 as a product. Device labels are useful for
  section 4 anyway, but a shared identity must not be offered as "family
  accounts".

## 6. Phased plan

Each phase is its own PR set with its own review. No phase moves funds in
tests beyond regtest.

| Phase | Scope | Depends on |
|---|---|---|
| P0 | This document; owner decisions D1–D6 | — |
| P1 | Notifications on phones while the app is running (lift the macOS-only gate in `Shell.tsx` and `OwnerApprovalSheet.tsx`; same content-free text) | — |
| P2 | Node: owner-only "answered elsewhere" event; app: stop ringing on it (section 4.2) | Node release |
| P3 | Push sender (D1), wake-token registration through the box, rate limits | D1, node release |
| P4 | iOS PushKit + CallKit; Android FCM + foreground service; privacy text | P3 |
| P5 | Node-side budget grant as single source; local book becomes a cache | Node release, D4 |
| P6 | Node design for sub-identities (option 2) | M6 done, D5 |

## 7. Open owner decisions

- **D1.** Who sends pushes (relay by the publisher, per operator, or none),
  and is the "box woke device at time T" leak acceptable with disclosure?
- **D2.** Is a Google-free Android build allowed to have no locked-phone
  ringing, or is a self-hosted push (for example UnifiedPush) required?
- **D3.** Does "Decline" on one device decline on all, or only silence that
  device?
- **D4.** Single daily budget per person enforced by the node (recommended),
  or synced per-device books?
- **D5.** For several people: confirm option 1 now and option 2 (2a or 2b)
  as the post-M6 node design.
- **D6.** May a CallKit lock screen show the caller's contact name after the
  app has fetched it, or must it always show only "BitSov call"?
