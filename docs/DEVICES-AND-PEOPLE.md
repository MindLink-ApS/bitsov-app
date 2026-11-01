# Devices and people: locked phones, several devices, several people

Status: **design proposal, docs only.** Nothing here is built. It needs two
independent reviews and the owner decisions listed at the end before any slice
starts. No code, node contract or release note may cite this file as shipped
behavior. Hardened after an independent review (round 1): section 3.5 now
states the push credential path as an open owner decision with three honest
options, and adds token rotation and the wake-pattern leak.

Three questions, in the order they will hurt users:

- **(a)** A call or a paid message arrives while the phone is locked or the app
  is in the background. Today the phone does not ring.
- **(b)** One person has a phone and a Mac. Both should show the same
  conversations, and a call should ring on both and stop on both when one
  answers.
- **(c)** Several people (for example a family) use one box. The principle is
  already decided by the owner (section 5); this document lists what the code
  must change to follow it.

## 1. Principle, as the code already states it

Owner decision (M6), written in `docs/CALLS.md`, `src/control/callFlags.ts`
and the call wiring in `src/control/Shell.tsx`: **the node is the cell.** Call
audio goes app → own node → peer node → peer app. The app never talks to
another person's app directly in M6 builds.

What follows from that, and what this document keeps:

- **One person = one identity with their own seed.** Today a box hosts
  exactly one person, so in the code one box = one identity. The node holds the
  identity key, the wallet and the channels. The app holds no seed and no funds.
- **Owner devices share the identity and its funds.** A phone and a Mac paired
  to the same identity are the same person to everyone else. Each device has
  its own client key and its own device key (`src-tauri/src/device.rs`), but
  they speak for one identity.
- **A box may host several people** (owner decision, 6 October; section 5).
  Each hosted person is still their own identity with their own seed. Hosting
  is never a shared wallet and never a sub-account.
- **No sub-accounts, no shared wallets, no multisig** exist anywhere in the
  app or the node contract it pins today, and none are planned. Nothing in this
  document pretends one does.

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

A call push is caused only by a **paid** offer (kind 400). The box never
pushes for an unpaid or refused offer, and sends at most one push per
registered device per paid offer.

### 3.4 Who sends the push (privacy-critical; decided in 3.5)

APNs and FCM only accept pushes from a server holding the developer's
credentials (APNs key / FCM service account). A long-lived copy of those
credentials in every box would be a key that can push to every BitSov
device, so the box can only send directly if it gets a narrow, short-lived
way to authenticate (section 3.5). Options:

| Sender | What it learns | Cost |
|---|---|---|
| A. Relay run by the publisher | Device push token, the box that asked, time of each wake | One small stateless service; a new party in the metadata path |
| B. Relay per hub / operator | Same, but split across operators | Each operator needs push credentials; harder to run |
| C. No push; keep the phone connected | Nothing new | Not allowed by iOS for a suspended app; drains battery on Android |
| D. The box itself, direct to APNs / FCM | Apple / Google: device push token and wake time, as in every option; no new party | Needs a safe credential path for the box (section 3.5) |

Rules for any push sender (written for the relay options A and B, which
are rejected in 3.5; the box-side rules apply to option D too):

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
  app's privacy text before release. Decided in section 3.5 (D1).

### 3.5 Decision: wake push is a per-user setting (decided)

Status: **decided by the owner** (D1). The wake push is a **setting each
person chooses**, in Settings and once during phone setup, in plain words.
There is no BitSov or publisher relay in the plan; options A and B in the
table above are rejected.

**Wake push on (option D above; the default when the person turns it on).**
The person's own box sends a **content-free wake push directly to the
platform push service** (APNs for iOS, FCM for Android). The phone wakes and
fetches everything else (who calls, which message, which approval) from its
own box over its existing authenticated connection, as section 3.3 requires.

- What Apple / Google learn: the sending network address (the box's IP),
  the device push token, and each wake time. No caller, no peer, no amount,
  no text; the payload is the opaque wake token and type from section 3.3.
- **The wake pattern is itself metadata.** Over time the times of wakes
  reveal how often the person is called or written to, and when two boxes
  both push, the platform can see wakes that line up between them, which
  hints that those two people talk. The privacy text must say this, not only
  "when your box wakes the phone".
- Whether anyone **beyond** Apple / Google learns anything depends on the
  credential path, which is not settled (below). Only options (i) and (ii)
  keep a third party out entirely.
- Rules from 3.4 still apply: wake tokens rotate and are registered by the
  device through its own box; a peer can never trigger a push; the box
  rate-limits per peer and never pushes for calls it would refuse.
- **Platform token rotation.** The APNs device token (and the FCM
  registration token) itself changes on reinstall, restore and some OS
  events. The app re-registers its current token with its own box on every
  launch. The box drops a token as soon as APNs answers `Unregistered`
  (HTTP 410) or FCM answers `UNREGISTERED`, and never retries it. Pushing on
  to dead tokens would make the box a liveness oracle.

**Push credential path: open owner decision.** An earlier draft proposed a
"short-lived sender credential" refreshed on a timer. The review showed that
this only moves the relay: an APNs provider token (a JWT) is signed with the
publisher's APNs auth key, so whoever issues the short-lived token holds a
key that can push to every BitSov device, and still learns which boxes are
alive at each refresh (and can correlate refreshes with wake bursts at
coarse granularity). That proposal is withdrawn. The honest options are:

| Option | Who holds the push key | What leaks beyond Apple / Google | Who it works for |
|---|---|---|---|
| (i) The box holds the APNs / FCM key | every box, for a shared app id | nothing new, but each box holds a key that can push to every device of the app | rejected: one leaked box key pushes to everyone |
| (ii) Per-owner app id and per-owner push key | the owner, for an app they build and sign themselves | nothing new | self-builders only |
| (iii) A token-issuing service | the service, which holds the publisher key | the service learns which boxes are alive at each refresh, and holds a key that can push to every device | everyone, but it is a credential relay: the metadata-light relay the owner rejected in D1 |

The design must not call (iii) "no relay". The owner picks one of:

- (ii) for self-builders, and **push off** for everyone else; or
- (iii) for everyone, accepting and publishing the leak stated above.

Whether wake push is **on or off by default** is part of the same decision
(section 7, D1). Until it is decided, P3 does not start.

**Wake push off (option C above).** No push is ever sent. A locked or
backgrounded phone cannot ring; the person opens the app to see calls and
messages, which it then fetches from the box as today.

Setting copy (draft, plain words):

| | Dansk | English |
|---|---|---|
| Title | Vække telefonen ved opkald | Wake the phone for calls |
| On | Telefonen ringer, også når den er låst. Apple eller Google ser kun, hvornår din boks vækker telefonen, aldrig hvem der ringer eller skriver. | Your phone rings even when locked. Apple or Google only see when your box wakes the phone, never who calls or writes. |
| Off | Telefonen ringer ikke, når den er låst. Åbn appen for at se opkald og beskeder. Et åbent opkald slutter, når telefonen låses. | Your phone does not ring when locked. Open the app to see calls and messages. An open call ends when the phone locks. |

The Off copy states both effects of `SILENCED_GRACE_MS` (section 2.3): a
call rings only while the app is open, and an open call ends when the phone
locks.

The privacy text before release states, for people who turn the push on:
the box's IP as sender, the device push token, each wake time, and the
wake pattern over time (call frequency, and wakes that line up between two
boxes). If option (iii) is chosen, it also names the token-issuing service
and what it learns.

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

## 5. Several people on one box: decided principle

### 5.1 The decision (owner, 6 October)

- **Each person is their own identity with their own seed.** A parent, a
  spouse and a child are three identities, three seeds, three wallets, three
  sets of devices.
- **A node may host several people**, for example a family on one box. The
  box is shared hardware, not a shared account.
- **Hosted people are shown as "hosted by \<name\>"**, where the name is the
  person who runs the box. Contacts see that the identity is hosted, and by
  whom.
- **Each hosted person keeps their own backup** (their own recovery phrase)
  and can **move out** to their own node at any time, keeping their identity,
  funds and contacts.
- **It is not a shared wallet and not a sub-account.** Nobody, including the
  person who runs the box, spends another person's funds or reads another
  person's messages through the app.

Calls and messages therefore reach **a person, not a box**. Today the two are
the same, so the code never had to tell them apart.

### 5.2 Rejected alternative: shared household identity

One identity and one wallet for the whole house, with device labels such as
"kitchen iPad" or "a parent's phone". Everyone would read every message and
spend the shared balance, and a call would ring every device in the house.
**Rejected:** it gives no privacy between people, no separate funds, no way to
move out, and the wording "family account" would mislead. Device labels remain
useful for one person's own devices (section 4), nothing more.

### 5.3 Code that assumes one node = one person

These places are correct today, because a box hosts one person. Each must be
re-keyed from "node" to "identity hosted on a node" before a second person can
be hosted. This list is the work inventory, not a change in this PR.

| Place | Assumption today | Must become |
|---|---|---|
| `src/control/call.ts` `receive(m, ownId)` and the `CALL_OFFER`…`CALL_HANGUP` flow | Peer and own id are node ids; a call targets a node | A call rings a person (identity); the hosting node routes to that person's devices only |
| `docs/CALLS.md` node-routed media: `GET /api/v1/calls/:call_id/media?peer=<counterparty>`, `src-tauri/src/control/media.rs` | The counterparty is a node; the media socket is admitted per `(peer node, call_id)` | Admitted per `(peer identity, call_id)` and bound to the answering person's pairing |
| `src-tauri/src/budget.rs` `book_path()` — `app-spend/budget-<first 16 hex of node id>.json`, "one book per identity" | Book keyed by node id | Keyed by the hosted identity; contact and room budgets keyed by peer identity |
| `src-tauri/src/device.rs` `approvals_path()` — `approval-<node>.json`; `Intent` envelope "for one contact" | Pending approval and envelopes keyed by node id | Keyed by own identity and peer identity |
| Relation grants in `src-tauri/src/app.rs` (`read_grant`, `has_envelope(&intent.peer, …)`) | Grant envelope names a peer node | Names a peer identity; grant issued by one hosted identity only |
| `src-tauri/src/spend_journal.rs` call index (identity/peer/call) | "Identity" is the node's identity | Explicitly the hosted identity the pairing belongs to |
| `src/control/types.ts` `Peer.node_id`, `Introduction.node_id`, `MemberCost.node_id`; `Message.sender` | Contacts, introductions and room members are node ids | A person id plus the node that hosts it ("hosted by") |
| `src/control/messageNotifications.tsx` `message(message, ownId, …)` | Own id = the node id | Own id = the signed-in hosted identity |
| Pairing (`docs/ONBOARDING_PAIRING.md`, `docs/SECOND_DEVICE_JOIN.md`) | A pairing and an owner device belong to the node | A pairing and owner devices belong to one hosted identity; one person's devices never approve another person's |
| Recovery (`src-tauri/src/local_owner.rs`, one-shot recovery phrase) | One recovery phrase per node | One per hosted person; "move out" exports exactly that person |

Most of the change is in the node (identity, routing, pricing, call admission,
pairing scopes, backup and move-out). The app follows the node contract once
it exists; it cannot do this alone.

### 5.4 What this means now

- **Until the node supports hosting:** each person runs their own box or
  their own hosted node. Onboarding can say "each person in the house gets
  their own BitSov". This already matches the decision.
- **After M6:** the node design for hosting several identities (own seeds,
  "hosted by", move-out), then the re-keying in 5.3.

## 6. Phased plan

Each phase is its own PR set with its own review. No phase moves funds in
tests beyond regtest.

| Phase | Scope | Depends on |
|---|---|---|
| P0 | This document; owner decisions D1–D7 | — |
| P1 | Notifications on phones while the app is running (lift the macOS-only gate in `Shell.tsx` and `OwnerApprovalSheet.tsx`; same content-free text) | — |
| P2 | Node: owner-only "answered elsewhere" event; app: stop ringing on it (section 4.2) | Node release |
| P3 | Box-direct push sender and the per-user wake-push setting (D1, decided), wake-token registration through the box, platform-token re-registration on launch and drop on `Unregistered`, rate limits | Node release, D1 credential path and default |
| P4 | iOS PushKit + CallKit; Android FCM + foreground service; privacy text | P3 |
| P5 | Node-side budget grant as single source; local book becomes a cache | Node release, D4 |
| P6 | Node design for hosting several identities (own seeds, "hosted by", move-out); then the re-keying in 5.3 | M6 done, node release |

## 7. Open owner decisions

- **D1. Decided by the owner:** the wake push is a per-user setting, chosen
  in Settings and during phone setup in plain words. On (the default when
  enabled): the box sends a content-free wake push directly to APNs / FCM,
  the phone fetches everything from its own box, and the platform learns
  only wake times. Off: no push; a locked phone cannot ring and the person
  opens the app to see calls and messages. No relay in the plan
  (section 3.5).
  **Still open under D1 (review round 1):** who holds the push credential,
  (ii) per-owner key for self-builders with push off for everyone else, or
  (iii) a token-issuing service with its stated leak; and whether wake push
  is on or off by default (section 3.5).
- **D2.** Is a Google-free Android build allowed to have no locked-phone
  ringing, or is a self-hosted push (for example UnifiedPush) required?
- **D3.** Does "Decline" on one device decline on all, or only silence that
  device?
- **D4.** Single daily budget per person enforced by the node (recommended),
  or synced per-device books?
- **D5.** Several people on one box: the principle is decided (section 5.1).
  Open details only: which name "hosted by" shows and whether a contact always
  sees it, and whether the host may see that a hosted person exists on the box
  (not their messages or funds). Review note: the host can see that a hosted
  person exists by necessity, because the box routes to them; only content
  and funds are hidden.
- **D7. Lost phone without a terminal.** Today revoking a lost device needs
  the box's computer or the recovery phrase. Should a second trusted person
  (for example the box host) be allowed to revoke a device, or is "go to the
  box" acceptable? (Shared with the in-app budget approval design.)
- **D6.** May a CallKit lock screen show the caller's contact name after the
  app has fetched it, or must it always show only "BitSov call"?
