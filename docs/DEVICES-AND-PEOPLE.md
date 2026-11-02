# Devices and people: locked phones, several devices, several people

Status: **design proposal, docs only.** Nothing here is built. It needs two
independent reviews and the owner decisions listed at the end before any slice
starts. No code, node contract or release note may cite this file as shipped
behavior. Hardened after an independent review (round 1): section 3.5 adds token
rotation and the wake-pattern leak. Owner decisions since: wake push is **for
self-builders only**, and off for everyone else (D1, section 3.5); a lost phone
can be revoked **without a terminal** (D7, section 4.4); hosting other people on
a box is **parked** until the key boundary meets the charter (section 5). Corrected
after a second review: what a person running a shared box can read and hear
(section 5.1), and which boxes the revoke in section 4.4 can work on.

**Principle.** Build little policy in; ship defaults the user can change. BitSov
is the base for open source, and what nodes share is timechain entrainment and
payment attached to the packet. Money-path correctness and the review gate are
not defaults.

Three questions, in the order they will hurt users:

- **(a)** A call or a paid message arrives while the phone is locked or the app
  is in the background. Today the phone does not ring.
- **(b)** One person has a phone and a Mac. Both should show the same
  conversations, and a call should ring on both and stop on both when one
  answers.
- **(c)** Several people (for example a household) use one box. **Parked, not
  planned** (section 5). The analysis stays; nothing here is scheduled.

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
- **Hosting several people on a box is parked** (section 5). The owner's
  principle of 6 October still describes the shape: each hosted person is their
  own identity with their own seed, never a shared wallet and never a sub-account.
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

Decided: this design applies only to an app a person builds and signs themselves
with their own push credentials (section 3.5). A locked phone does not ring for
anyone else.

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
credentials (APNs key / FCM service account). A shared copy of those credentials
in every box would be a key that can push to every BitSov device, so no box holds
one (section 3.5). Options:

| Sender | What it learns | Cost |
|---|---|---|
| A. Relay run by the publisher (rejected) | Device push token, the box that asked, time of each wake | One small stateless service; a new party in the metadata path |
| B. Relay per hub / operator (rejected) | Same, but split across operators | Each operator needs push credentials; harder to run |
| C. No push; keep the phone connected | Nothing new | Not allowed by iOS for a suspended app; drains battery on Android |
| D. The box itself, direct to APNs / FCM | Apple / Google: device push token and wake time, as in every option; no new party | Self-builders only, with their own credentials (section 3.5) |

Rules for the box as push sender:

- Wake tokens rotate and are registered by the device through its own box,
  not by the caller's box. A peer can never trigger a push directly.
- Rate limits at the box (per peer, per minute) so a stranger cannot use
  pushes to drain a battery or probe whether a device is online. Calls from
  strangers that the node would refuse anyway never cause a push.
- Apple and Google learn "this box woke this device at this time". This is a
  real leak and must be written down in the privacy text of a self-built app
  (section 3.5).

### 3.5 Decision: wake push is for self-builders only (decided)

Status: **decided by the owner** (D1). Wake push exists only in an app a person
builds and signs themselves, with their own push credentials. It starts off there
too; that person turns it on in Settings after plain words about what Apple /
Google learn (setting copy below). For everyone else it is off and cannot be turned
on. There is no BitSov or publisher relay in the plan; options A and B in the table
above are rejected.

**Wake push on (option D above; self-builders only).**
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
- Nobody **beyond** Apple / Google learns anything: no relay and no token
  service sit in the path, and the credentials are the person's own.
- Rules from 3.4 still apply: wake tokens rotate and are registered by the
  device through its own box; a peer can never trigger a push; the box
  rate-limits per peer and never pushes for calls it would refuse.
- **Platform token rotation.** The APNs device token (and the FCM
  registration token) itself changes on reinstall, restore and some OS
  events. The app re-registers its current token with its own box on every
  launch. The box drops a token as soon as APNs answers `Unregistered`
  (HTTP 410) or FCM answers `UNREGISTERED`, and never retries it. Pushing on
  to dead tokens would make the box a liveness oracle.

**Push credential path: decided by the owner: self-builders only.** A person
who builds and signs their own app, with their own app id and their own APNs / FCM
credentials, can enable wake push. Those credentials live on that person's own box
and can push only to that person's own app. It is off for everyone else:

- no shared app-wide key on any box, because one leaked box key could push to
  every device of the app;
- no relay and no token-issuing service, because either one holds a key that can
  push to every device and learns which boxes are alive.

**A locked phone does not ring for anyone else.** In a build the person did not
sign themselves there is no wake-push setting to turn on.

**Wake push off (option C above; everyone else, and a self-builder's default).**
No push is ever sent. A locked or
backgrounded phone cannot ring; the person opens the app to see calls and
messages, which it then fetches from the box as today.

Setting copy (draft, plain words):

| | Dansk | English |
|---|---|---|
| Title | Vække telefonen ved opkald | Wake the phone for calls |
| On (self-built app only) | Telefonen ringer, også når den er låst. Apple eller Google ser kun, hvornår din boks vækker telefonen, aldrig hvem der ringer eller skriver. | Your phone rings even when locked. Apple or Google only see when your box wakes the phone, never who calls or writes. |
| Off (self-built app only) | Telefonen ringer ikke, når den er låst. Åbn appen for at se opkald og beskeder. Et åbent opkald slutter, når telefonen låses. | Your phone does not ring when locked. Open the app to see calls and messages. An open call ends when the phone locks. |
| Every other build, no setting | Telefonen ringer ikke, når den er låst. Åbn appen for at se opkald og beskeder. Et åbent opkald slutter, når telefonen låses. Kun en app, du selv bygger og signerer med dine egne push-nøgler, kan vække telefonen. | Your phone does not ring when locked. Open the app to see calls and messages. An open call ends when the phone locks. Only an app you build and sign yourself, with your own push keys, can wake the phone. |

In a self-built app the setting starts **Off** and lives in Settings, so the person
reads what Apple / Google learn before they turn it on.

The Off copy states both effects of `SILENCED_GRACE_MS` (section 2.3): a
call rings only while the app is open, and an open call ends when the phone
locks.

The privacy text of a self-built app states, for people who turn the push on:
the box's IP as sender, the device push token, each wake time, and the
wake pattern over time (call frequency, and wakes that line up between two
boxes).

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
  push (section 3) where not and where a self-built app has it on.
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

### 4.4 Revoking a lost phone without a terminal (decided, D7)

Owner decision (D7): a lost phone can be revoked **without a terminal and
without the recovery phrase**, from either of:

- **another owner device** of the same identity (for example the Mac, when
  the phone is lost), or
- **the box's own app**, for example the Mac app running on the box's
  computer, acting with the box's local owner authority. On a box with one
  owner device this is the path.

Design sketch:

1. Devices lists the identity's owner devices (the node already labels them
   by platform, section 2.4). The owner picks the lost phone and taps "This
   phone is lost".
2. The app shows in plain words what happens: the phone is signed out of
   the box, it can no longer pay or approve anything, and any budget it was
   given ends now.
3. On another owner device, the request is confirmed with Touch ID / Face ID
   using that device's own key (`device.rs`), signing a domain-separated
   revoke message (target device, op id, nonce, expiry). In the box's own
   app, it is confirmed through the box's local owner authority.
4. The node revokes the phone's pairing tokens and its owner device key at
   once, ends every grant issued to that pairing, drops its push
   registration, and records an owner key change (which starts the self
   grant cooldown in `docs/IN-APP-BUDGET-APPROVAL.md`).
5. The phone, if found, joins again as a new device (`docs/SECOND_DEVICE_JOIN.md`).

Revocation by a second person, such as a box host revoking a hosted
person's phone, is not part of this decision.

**Node-repository requirement.** A revoke route that accepts either a
signature by another enrolled, non-revoked owner device key of the same
identity over the revoke message, or the box's local owner authority; that
revokes the target's tokens and device key, ends its grants and records an
owner key change; and that refuses a device revoking itself through this
route. The app cannot do this alone.

**This does not work on a box whose seed password comes from a file or a flag,
and no planned route changes that yet.** The node turns device approvals off when the seed's password came from a file
or a flag: `owner_approval_key` returns `seed_password_not_typed`
(`crates/konsensus-node/src/main.rs:1087-1107`,
`crates/konsensus-api/src/pairing/device.rs:28-30`, node commit `b3f1ad1`). They
are on only with a typed password, or a descriptor or remote unlock together
with `--local-owner-device`, and only with an encrypted seed. Every device route
then refuses (`device_authority`, `pairing/device.rs:1536-1542`). Reported,
node-side, to confirm: both real boxes take the password from a file or flag.
The field test of 1 November approved at the node's console, which fits, but its
record does not name the password source. On such a box both paths
above fail: a device signature chains to the owner key that is off
(`pairing/device.rs:1569`), and the box's local owner authority needs
`--local-owner-device`, which needs `--password-fd` or home mode
(`main.rs:1204-1210`). Today the only revoke there is at the node's computer.

**Second node-repository requirement: a device approval policy for those boxes.**
Either a supported start that does not use a file or flag, or a policy that turns
approvals on for them. The node's reason for the gate is that a same-user program
could read that password, so this needs its own security review. Until it exists,
D7 is a decision about the design, not something that works on such a box.

## 5. Several people on one box: PARKED

**Parked, not planned, until the key boundary meets the charter.** The reason is
the honest host-trust statement in section 5.1: whoever runs the box holds a hosted
person's decrypted seed in memory and can read and hear what passes through. The
analysis below stays as the record. Nothing in this section is scheduled.

### 5.1 The principle as decided on 6 October (parked)

- **Each person is their own identity with their own seed.** Three people are
  three identities, three seeds, three wallets, three sets of devices.
- **A node may host several people**, for example a household on one box. The
  box is shared hardware, not a shared account.
- **Hosted people are shown as "hosted by \<name\>"**, where the name is the
  person who runs the box. Contacts see that the identity is hosted, and by
  whom.
- **Each hosted person keeps their own backup** (their own recovery phrase)
  and can **move out** to their own node at any time, keeping their identity,
  funds and contacts.
- **It is not a shared wallet and not a sub-account.** The app gives nobody a
  way to spend another person's funds or read another person's messages.
- **That is a limit of the app, not a technical guarantee, and it is the reason
  hosting is parked.** The person running
  a shared box could technically read and hear what passes through it. The box
  decrypts every message: the node's end-to-end session runs between nodes, and
  the app hands its node the plaintext (`plaintext` in `POST /messages/compose`,
  `crates/konsensus-api/src/handlers/messages/compose.rs:67`, encrypted for the
  peer at `:3076`). Call audio reaches the box as plain codec frames, which the
  node forwards (`docs/CALLS.md`, "Wire format"; the call card already says *both
  nodes can hear it*). The seed of a hosted identity is decrypted into the host's
  memory too (`custody_mode`, `crates/konsensus-node/src/main.rs`). **So being
  hosted requires trusting the host, until there is end-to-end encryption
  between apps.** That encryption does not exist and is not in this plan.
- **Saying so is part of the "hosted by" consent.** Before someone agrees to be
  hosted, the app says in plain words:
  - Dansk: "\<navn\> driver den boks, du bliver hostet på. \<navn\> ser ikke
    dine beskeder i appen, men kan teknisk set læse og høre det, der går gennem
    boksen. Bliv kun hostet af en, du stoler på."
  - English: "\<name\> runs the box that hosts you. \<name\> doesn't see your
    messages in the app, but could technically read and hear what passes through
    the box. Only be hosted by someone you trust."

Calls and messages therefore reach **a person, not a box**. Today the two are
the same, so the code never had to tell them apart.

### 5.2 Rejected alternative: shared household identity (parked with the rest)

One identity and one wallet for the whole house, with device labels such as
"kitchen iPad" or "the old phone". Everyone would read every message and
spend the shared balance, and a call would ring every device in the house.
**Rejected:** it gives no privacy between people, no separate funds, no way to
move out, and the wording "household account" would mislead. Device labels remain
useful for one person's own devices (section 4), nothing more.

### 5.3 Code that assumes one node = one person (parked)

These places are correct today, because a box hosts one person. Each would have to
be re-keyed from "node" to "identity hosted on a node" before a second person could
be hosted. This list is the analysis, not a work list: none of it is planned.

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

- **Each person runs their own box.** Onboarding can say "each person in the
  house gets their own BitSov".
- **Hosting comes back only** when the key boundary meets the charter. Until then
  there is no node design for it and no re-keying.

## 6. Phased plan

Each phase is its own PR set with its own review. No phase moves funds in
tests beyond regtest.

| Phase | Scope | Depends on |
|---|---|---|
| P0 | This document; owner decisions (D1, D7 and D8 decided; D5 parked) | — |
| P1 | Notifications on phones while the app is running (lift the macOS-only gate in `Shell.tsx` and `OwnerApprovalSheet.tsx`; same content-free text) | — |
| P2 | Node: owner-only "answered elsewhere" event; app: stop ringing on it (section 4.2) | Node release |
| P3 | Self-builders only: box-direct push sender using the person's own credentials and the wake-push setting (D1, decided), wake-token registration through the box, platform-token re-registration on launch and drop on `Unregistered`, rate limits | Node release |
| P4 | Self-builders only: iOS PushKit + CallKit; Android FCM + foreground service; privacy text | P3 |
| P5 | Node-side budget grant as single source; local book becomes a cache | Node release, D4 |
| P2b | Revoke a lost phone without a terminal, from another owner device or the box's own app (section 4.4, D7) | Node release (revoke route, and a device approval policy for boxes whose seed password comes from a file or a flag) |

Hosting other people on a box is not a phase. It is parked (section 5).

## 7. Owner decisions (decided and open)

- **D1. Decided by the owner:** wake push is for self-builders only. A person
  who builds and signs their own app with their own push credentials can enable
  it, in Settings, with plain words about what Apple / Google learn. On: the box
  sends a content-free wake push directly to APNs / FCM, the phone fetches
  everything from its own box, and the platform learns the box's address, the
  device push token and each wake time (and the wake pattern over time). It is off
  for everyone else: no push; a locked phone cannot ring and the person opens the
  app to see calls and messages. No shared app-wide key on boxes, no relay
  (section 3.5).
- **D2.** Is a Google-free Android build allowed to have no locked-phone
  ringing, or is a self-hosted push (for example UnifiedPush) required?
- **D3.** Does "Decline" on one device decline on all, or only silence that
  device?
- **D4.** Single daily budget per person enforced by the node (recommended),
  or synced per-device books?
- **D5. Parked with hosting (section 5).** Several people on one box: the
  principle was decided (section 5.1). Details not to be decided now: which name "hosted by" shows and whether a contact always
  sees it, and whether the host may see that a hosted person exists on the box
  (the app shows the host no messages or funds). Review note: the host can see
  that a hosted person exists by necessity, because the box routes to them. The
  app hides content and funds from the host, but the box itself does not:
  section 5.1.
- **D7. Lost phone without a terminal: decided by the owner.** A lost phone
  can be revoked without a terminal, from another owner device or from the
  box's own app (for example the Mac app on the box's computer). Design
  sketch in section 4.4; the revoke route is a node-repository requirement. So
  is a device approval policy for boxes whose seed password comes from a file or
  a flag: on those, neither path works today (section 4.4).
  Revocation by a second person (for example the box host) is not part of
  this decision. (Shared with the in-app budget approval design.)
- **D6.** May a CallKit lock screen show the caller's contact name after the
  app has fetched it, or must it always show only "BitSov call"?
- **D8. Decided by the owner:** video requires encryption first, or the two
  designed together.
