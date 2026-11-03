# End-to-end encryption for calls and messages, with video on top

Status: design draft, 3 Nov 2026. No product code. Nothing here is built.

Read against:

- `node:` the node repo at `v0.3.0-rc21` (`b3f1ad1`)
- `app:` this repo at `origin/main` (`edd59ae`)

Every claim carries one mark:

- **[S]** read from source, cited where it matters
- **[I]** inferred from source or arithmetic, not run
- **[U]** unverified: outside knowledge or a guess that a device run must settle

Design proposals carry no mark: they say what should be built, not what is. The summary
below repeats claims that are marked in their sections. Nothing was run for this
document: no call, no device, no packet capture.

## The answer in short

- **Today both boxes can hear every call and read every message.** The current
  call label says so honestly. Some other wording does not (section 1).
- **Calls can be sealed in the app with no node change and no new service.** The
  node already forwards media bytes without reading them, and already passes the
  SDP field through unread. Metering and cut-off do not read content, so they do
  not change.
- **The boxes keep what the cell needs:** who, when, how long, how many bytes,
  and the money. Encryption does not hide those.
- **A box can still attack actively** by swapping keys during call setup. Only
  people comparing four words on the call catches that. The label must say which
  state a call is in.
- **13 Nov is realistic for one thing:** sealed audio between two current apps,
  proven on Mac and iPhone. It is tight, with no slack. **It is not realistic for
  messages, video, Android and Windows parity, or an outside audit.** See section 6.
- **Sealed messages are a larger job** than sealed calls because a message must
  reach every device and survive offline. Two to three weeks after calls [I].
- **Video fits on the same frame format.** 64 KiB/s buys low-resolution video only.
  Better video needs a node rate change on both boxes, and a price for it.

Assumptions taken where the brief left room:

- "The date line for E2E" is read as calls first. Messages are designed here but
  are not promised by 13 Nov.
- 1 / 5 / 2 is read as the owner's price for a message, an offer and a minute, in
  sats. It is not the rc21 default: rc21 defaults the offer and the minute to
  10 sats (`node:crates/konsensus-node/src/config.rs:2349-2351`) [S].
- The sovereignty charter that `node:CHARTER.md:25` names is not in the node tree
  [S]. I read a copy whose SHA-256 matches the pin in `node:CHARTER.md:27` [S] and
  do not quote it here.

### How this meets the owner's four principles

| Principle | What it means here |
|---|---|
| Little built-in policy, defaults the user can change | Three settings: only private calls, the video minute price, and the words prompt. Defaults in section 7. No key server, no directory, no central rule. |
| The shared layer is timechain entrainment and payment attached to the packet | Encryption sits above that layer and changes neither. Envelopes still carry payment proofs, minutes are still paid blocks, price adverts still carry a block height (`node:crates/konsensus-message/src/wire.rs:1091`) [S]. The word "entrainment" does not appear in rc21's crates [S], so I claim no integration with it. Media frames are unpaid inside a paid minute today (`wire.rs:1191-1194`) [S], and this design leaves that as it is. |
| Honesty about who can hear what | Four label states (section 3.6), tied to what actually happened on that call. |
| No relay of his own | Nothing new is hosted: no TURN, no SFU, no key server, no push service. Keys and media pass only through the two people's own boxes. |

## 1. Today's truth

"Box" means a person's node. "Operator" means whoever runs that box: usually the
owner, and on the far side, the peer.

### A call

The path is app, own box, peer box, peer app (`node:crates/konsensus-node/src/call_media.rs:3-9`) [S].

| Who | What they get | Evidence |
|---|---|---|
| Own box | Raw codec bytes. Could decode and hear every word. | The socket payload is the codec packet: `node:crates/konsensus-api/src/call_media.rs:7-10`. `app:src-tauri/src/control/media.rs:120-123` calls it "decrypted call audio". [S] |
| Peer box | The same | `Frame::CallMedia.data` is "the codec packet": `wire.rs:1203-1206` [S] |
| Network between boxes | Noise ciphertext, plus timing and sizes | `wire.rs:1188-1189` [S] |
| Network between a phone and its box when away | Noise tunnel ciphertext | `node:crates/konsensus-api/src/remote_access.rs:1-6` [S] |
| Second paired device | Sees signalling. Does not get the media unless it holds the one media socket. | `/ws` broadcasts to every read-scoped device (`node:crates/konsensus-api/src/ws.rs:111-135`). One socket per call, second refused (`call_media.rs:309-310`). A device with `spend` could attach during a reconnect gap [I]. |
| Box operator at rest | No stored audio. The router holds media only in memory queues. | `node:crates/konsensus-node/src/call_media.rs` uses storage only for admission (`:69`, `:81`) [S]. An operator who patches the box can record [I]. |

The node docs say the same: `node:docs/v2/CALLS-PROTOTYPE.md:19-20` [S]. So does the
call label: `app:src/controlCopy.ts:842` [S].

### A message

| Who | What they get | Evidence |
|---|---|---|
| Own box | The plaintext. The app posts it, the box encrypts it. | `node:crates/konsensus-api/src/handlers/messages/compose.rs:66-67`, `:3776` [S] |
| Peer box | The plaintext. It decrypts, caches and forwards. | `node:crates/konsensus-node/src/msg_handler.rs:794`, `:671-672`, `:946-951` [S] |
| Network between boxes | Double Ratchet inside Noise | `node:crates/konsensus-crypto/src/session.rs:1-9` [S] |
| Every paired device | The plaintext, live | `ws.rs:111-135`, `node:crates/konsensus-api/src/state.rs:40-43` [S] |
| Box operator at rest | Ciphertext on disk, but under a key the box itself holds. Anyone running the box with its seed password can read it. | `node:crates/konsensus-crypto/src/plaintext_cache.rs:1-12`, ratchet keys from the node's identity at `session.rs:542` [S] |

The X3DH, Double Ratchet and Sender Keys code is real
(`node:crates/konsensus-crypto/src/x3dh.rs`, `double_ratchet.rs`, `sender_keys.rs`)
[S]. **But its ends are nodes, not apps.** "E2EE" in the node's code means box to box.

### Wording that claims more than this

| Where | Problem | Mark |
|---|---|---|
| `node:README.md:18` | Says message content is end-to-end encrypted | [S] |
| `app:src/assistantQuestionsCopy.ts:13`, `:66` | Calls box-to-box sessions "end-to-end encrypted" in English and Danish | [S] |
| `node:CHARTER.md:20-21` | Says an operator must never be able to decrypt user content. True only while the person running the box is the owner. | [S] for the text, [I] for the reading |
| `node:docs/DESIGN-REASONING.md:176` | Already records this tension and the missing charter file | [S] |

`app:docs/ARCHITECTURE_BOUNDARY.md:21-22` already states it correctly [S]. Hosting
other people on one box stays out of scope until sealed messages exist.

## 2. Threat model

### What E2E must and must not protect

| Attacker | Calls after this design | Messages after the later slices |
|---|---|---|
| **Own box, passive** (operator curious, disk stolen, box logs, backup leaked) | Protected | Protected for sealed kinds only |
| **Peer's box, passive** | Protected | Protected for sealed kinds only |
| **Either box, active** (swaps keys in signalling) | Detected only if the words are compared. Otherwise not. | Detected only once keys were compared. Otherwise not. |
| **Network** | Already covered by Noise. Unchanged. | Unchanged |
| **Second paired device, honest but curious** | Protected. It never receives the call key. | **Not protected, by design.** An owner's device reads the owner's messages. |
| **Stolen or hostile device still paired** | Not protected. It can answer as the owner, and the words would match. Revoking the pairing is the defence. | Not protected until rotation and revocation |
| **The person on the other end** | Not protected. They can record. | Not protected |
| **A compromised app or OS on either device** | Not protected. Plaintext exists there. | Not protected |
| **Metadata**: who, when, how long, sizes, price | Not protected. Both boxes need it for the cell and the money. | Not protected |
| **Speech inferred from packet sizes** | Protected by padding (section 4). Without padding this is a real leak. | n/a |
| **Recorded now, broken later by a quantum computer** | Not protected in v1 (X25519) | Not protected in v1 |

A box can always drop or delay frames and end a call. Encryption cannot change that.
All cells above are [I]: they are design consequences, not tested results.

Packet sizes leak because the encoder config sets a target bitrate and no fixed
mode (`app:src/control/callAudio.ts:191`) [S]. The WebCodecs default is variable bitrate
[U], and published work recovers phrases from variable-bitrate packet sizes [U].

### What "the node is the cell" means once media is encrypted

The node stays the cell in every way but one. It still decides who may connect, for
how long, at what rate, and for how much money, and it still carries every byte.
There is still no direct app-to-app path (`app:src/control/callFlags.ts:4-8`) [S]. The
one change: **the cell stops being able to listen.**

The cost is everything a tower could do by hearing: no recording on the box, no
transcription on the box, no voicemail made by the box, no mixing of a meeting on the
box [I]. Meetings stay a mesh of 1:1 legs (`app:docs/CALLS.md:382`) [S], so each leg
seals on its own. Mesh is parked with video and is not in the first slices.

### Node functions that need plaintext, and what breaks

| Function | Today | After sealing | Breaks? |
|---|---|---|---|
| Call admission, blocks, hangup | The box reads kinds 400 to 404 (`node:crates/konsensus-api/src/calls.rs:538-539`) [S] | Signals stay readable to the box. The SDP carries only public values. | No |
| Metering and cut-off | Time and length only (section 4) [S] | Same | No |
| Price and payment gate | By kind and payment proof, outside the body (`node:docs/v2/CALLS-PROTOTYPE.md:22-28` for calls) [S] | Same | No [I] |
| Assistants | Run on the app host, not the box. The broker strips bodies (`app:src-tauri/src/jarvis/broker/tools.rs:4`) [S]. | Reading a sealed body stays on the device, as an explicit per-client choice. A model running on the box cannot read sealed content. | Only box-side assistants, and none exist in rc21 that read call audio [I] |
| Search | I found no message search in the node API or the app (`handlers/` and `src/control/`, keyword search only, so a miss is possible) [I] | Must be on-device if ever built | No, nothing exists to break [I] |
| Notifications | Desktop Mac only, from the renderer (`app:src/control/Shell.tsx:355`). iOS has audio background mode only, no VoIP push (`app:src-tauri/Info.ios.plist:5-7`). [S] | The device decrypts, then notifies. Wake push stays empty. | No for Mac. A wake on a phone still needs the app to open [I]. |
| Rooms | The box reads the binding in `KIND_CHAT` (`node:crates/konsensus-api/src/room_binding.rs:29-33`, `:39-43`) and encrypts per member (`compose.rs:3076`) [S] | **Excluded from v1.** | Rooms stay box-readable |
| Files, voice memos, calendar, browse, profile, front door | The box stores or processes them (`node:crates/konsensus-api/src/handlers/files.rs:4-5`, `:531-534`; `calendar.rs:563`) [S] | **Excluded from v1.** Each needs its own design. | Stay box-readable, and the UI must say so |
| History on a new device | The box serves cached plaintext (`node:crates/konsensus-api/src/handlers/messages/query.rs:183`) [S] | Serves sealed text. The device must hold the key. | Depends on decision D6 |
| Recovery from seed | Restores the box's identity and access [S] | Sealed content cannot be restored from the seed, on purpose. Otherwise the box could read it. | Yes, and it must be stated plainly (D7) |

## 3. Key agreement, rotation and keys

### Why not the existing ratchet

The Double Ratchet lives in a node crate. The app may not link node crates: that is
gate G1 (`app:src-tauri/Cargo.toml:48-50`, `app:scripts/authority-check.sh`) [S]. It is
also keyed from the node's identity (`session.rs:542`) [S], so reusing it as it stands
would keep the box as an end. Calls do not need a ratchet anyway: each call can start
from fresh keys.

What the app already has and can reuse [S]:

| Need | Exists |
|---|---|
| X25519 | `x25519-dalek`, `app:src-tauri/Cargo.toml:43` |
| Hash and key derivation | `blake3`, `:35` |
| AEAD | `chacha20poly1305`, already in the lockfile through `snow` (`app:src-tauri/Cargo.lock:4128`). It would become a direct dependency. |
| Wipe secrets | `zeroize`, `:41` |
| Words people already know | `app:src-tauri/src/sas.rs:48-55`: four BIP-39 English words, 44 bits |
| A carrier for key material | The SDP field. The node checks only that it is non-empty and at most 16 KiB (`node:crates/konsensus-core/src/payloads/call.rs:14`, `:221`, `:230-232`). The app's check for a node-routed peer ignores extra lines (`app:src/control/nodeRoutedConnection.ts:45-46`). |
| A carrier that needs no payment | Media frames, opaque to both boxes (`node:crates/konsensus-node/src/call_media.rs:350`, `:406`) and to the host (`app:src-tauri/src/control/media.rs:15`) |

**So no node change is needed for sealed audio** [I from the above; to be proven in the
two-box run].

### Key agreement: three steps, one commitment

This is the standard hash-commitment pattern (ZRTP-style) built from existing parts.
It is a composition, not a new primitive, and it has had no outside audit.

1. **Offer (paid, kind 400).** The caller's host makes an ephemeral X25519 key `A` and
   a 16-byte nonce. The offer's SDP gains
   `a=x-bitsov-e2e:1 commit=<BLAKE3(A, nonce)> caps=<bits>`.
2. **Answer (paid, kind 401).** The callee's host makes ephemeral `B`. The answer's SDP
   gains `a=x-bitsov-e2e:1 key=<B> nonce=<...> caps=<bits>`.
3. **Reveal (unpaid, first media frames).** The caller sends `A` and its nonce in a
   cleartext type `0x10` frame, about once a second until a sealed frame from the callee
   authenticates. The callee checks the commitment. If it fails, or no reveal comes
   within 5 s, the call ends with a plain reason.

Both sides then derive:

- `transcript` = hash of a domain string, call id, both node ids, both caps, the
  commitment, `A`, `B`, both nonces
- `root` = BLAKE3 key derivation over the X25519 secret and `transcript`
- one send key per direction, from `root`
- the words, from `root`, through the same four-word mapping as `sas.rs`

**Why the commitment matters.** Without it, a box in the middle sees both public keys
before choosing its own, so it can search for keys that make the two screens show the
same words. Four words are 44 bits, and a collision search needs only about 2^22 tries
[I]. With the commitment the box must choose before it has seen what it would need, so
it gets one guess at 44 bits [I].

**Cost.** Media opens only after the first minute settles (`app:docs/CALLS.md:195-198`,
`node:crates/konsensus-core/src/payloads/call.rs:336-338`) [S], so a failed reveal has
already cost the offer and one minute: 7 sats at 1 / 5 / 2 before routing [I]. Adding the
attributes changes no price, since signals are priced by kind (`CALLS-PROTOTYPE.md:22-28`)
[S].

**Downgrade.** A box can strip the attribute. Then the app shows the "boxes can hear"
label. If this device has a stored continuity secret for that contact (below), a missing
attribute becomes a warning instead. The setting "Only private calls" refuses the call
outright (D2). `caps` sits in the transcript, so changing it changes the words [I].

**Older apps.** An old app ignores the attribute and answers without one [I from
`nodeRoutedConnection.ts:45-46`]. An old app receiving a sealed frame ignores the
unknown type (`app:src/control/mediaFrame.ts:71-80`) [S], so the new app must send old
frames to a peer that did not agree [I].

### Rotation

- **Inside a call:** each direction ratchets its key forward by hash every 60 s of its
  own clock, or every 65,536 frames, whichever is first. The epoch travels in the frame
  header. The receiver keeps the previous epoch briefly for reordered frames, then wipes
  it. A key taken from memory later cannot read earlier minutes [I].
- **A 4-hour call is 240 epochs,** which fits one byte (`MAX_CALL_MS`,
  `call.rs:39`) [S].
- **Not tied to paid blocks.** A box can lie about minute boundaries, so the crypto takes
  no input from the box.
- **No fresh DH mid-call in v1.** If a device is compromised during a call, the rest of
  that call is exposed.
- **Between calls:** every call starts from new ephemeral keys, so calls are forward
  secret by construction [I].

### Where keys live, and who holds them

**Decision: in the Rust host, not the webview** (D1). The host already owns the socket
and treats the payload as opaque (`app:src-tauri/src/control/media.rs:4-18`), and the
single uplink entry point is `call_media_send` (`app:src-tauri/src/app.rs:10383-10394`)
[S]. One implementation then covers all four platforms, the key never enters JavaScript,
and the webview differences stop mattering for crypto. The renderer still handles plain
audio and always must [I].

| Secret | Holder | Lifetime | Storage | Box sees it? |
|---|---|---|---|---|
| Ephemeral X25519 and send keys | The one device on the call | One call | Host memory only, wiped | Never |
| Continuity secret (later slice, below) | One device, per contact | Replaced on each verified call | See the platform table | Never |
| Message key (later slices) | Each of the owner's devices | Until rotated | See the platform table | Never |

| Platform | Protected storage for a persisted secret | Mark |
|---|---|---|
| iOS | Enclave-wrapped sealer | [S] `app:src-tauri/src/at_rest.rs:1-13`, `:84` |
| macOS | Secure Enclave sealer, including ad-hoc builds | [S] `at_rest.rs:1-13`, `app:src-tauri/src/pairing/key.rs:3-4` |
| Android | Non-exportable Keystore sealer | [S] `at_rest.rs:1-13` |
| Windows | **I found no sealer.** `at_rest.rs` has none, and Windows is a compile check and a preview (`app:README.md:28`). Continuity stays off there until one exists. Ephemeral call keys work regardless. | [I] |

No key is derived from the seed, because the seed sits on the box
(`node:crates/konsensus-core/src/identity.rs:3`) [S]. No key reaches the box, not even
wrapped. `node:CHARTER.md:18-21` then holds for sealed calls without an exception.

### A second owner device

**For calls, no key joins.** Keys exist per call on whichever device answers, so a new
phone just works [I]. Its first call with a contact shows the words again, because it is
a different phone, which is true.

If two devices ring, whichever answers makes `B`. A second answer is refused once the call is
no longer ringing (`node:crates/konsensus-core/src/payloads/call.rs:412`), and a second
socket by `node:crates/konsensus-api/src/call_media.rs:309-310` [S].
The real experience of two devices ringing has not been tried on sealed calls [U].

**For messages, a key must move between devices.** The existing second-device join binds
a new device to the box and the owner's approval (`app:docs/SECOND_DEVICE_JOIN.md:56-58`,
`:65-70`) [S]. It was built to stop a rogue device, with the box as the authority. It does
not stop a hostile box from substituting a device key [I]. So moving a message key needs
its own direct check between the two devices: a QR code or words shown on one and
confirmed on the other, with the box carrying ciphertext only.

### What a person actually does

No terminal, no settings, no key strings. The bar is a 70-year-old on their own.

1. They place or take a call as they do now. The card shows **Private, not yet checked**.
2. On the card, a line: *"Say these four words to each other."* Under it, four large
   words and two buttons: **Same words** and **Different**.
3. **Same words:** the card shows **Private, checked**. Done. From a later slice, the next
   call between the same two phones skips this step and shows **Private, checked before**.
4. **Different:** the call ends. *"Your words did not match. Someone may be listening.
   Nothing more will be paid for this call."*
5. Ignoring the words is allowed. The call goes on and the label stays truthful.

Four English words are read aloud across a Danish household [U]. The first real
person test decides whether words or six digits work better. That is a display choice:
the digest behind it does not change, so swapping costs nothing later (D3).

A live voice clone could in theory read the right words while a box swaps keys. Word
comparison assumes people recognise each other's voices [U].

### The labels

| State | English | Danish |
|---|---|---|
| Not sealed (today's text, `app:src/controlCopy.ts:842`, `:2003`) | Encrypted between your node and theirs — both nodes can hear it | Krypteret mellem din node og deres — begge noder kan høre opkaldet |
| Sealed, not compared | Private to your two apps. The nodes carry it but cannot hear it, unless one is attacking the call. Compare the words to be sure. | Privat mellem jeres to apps. Noderne bærer opkaldet, men kan ikke høre det, medmindre en af dem angriber opkaldet. Sammenlign ordene for at være sikker. |
| Sealed, compared | Private and checked. Neither node can hear it. | Privat og tjekket. Ingen af noderne kan høre det. |
| Warning | This contact's call was private before and is not now. | Opkald med denne kontakt var private før, men ikke nu. |

The call details should add, in every state: *"Both nodes still see who called whom, when,
and for how long."* The copy above is a proposal and has not been tested on a person.

### Messages, briefly

This is a design direction, not a build plan for 13 Nov.

Today's envelope and payment stay as they are. The app seals the body, and the box treats
the sealed string as the plaintext of an ordinary `KIND_CHAT` message: it is still
ratcheted box to box, still paid, still gated [I]. `compose.rs:154` allows 1 MiB [S]. A
sealed string that does not start with `{` is treated as a non-room chat
(`node:crates/konsensus-core/src/payloads/room.rs:120-123`) [S]. Rooms, files and all
other kinds stay out.

| Option | Good | Bad |
|---|---|---|
| **A. One message key per owner, copied between their devices. Each message sealed to the contact's public key, signed by the sender.** | Every device reads everything, including history. No per-device fan-out, so no ghost-device list for a box to fake. Little code. | No per-message forward secrecy: a stolen key reads old mail until rotation, and old mail after. |
| **B. Per-device sessions (Signal's Sesame shape).** | Forward secrecy per message | Prekey store on the box, fan-out, device lists a box can falsify, no history on new devices, a ratchet to port because the node's cannot be linked. Weeks more. |
| **C. Leave messages box-readable, say so plainly.** | Nothing to build | The charter's promise stays false for hosting |

Recommendation: **C until sealed calls are proven, then A, rotating on device removal and
on a timer.** The contact's public key can be bound into a compared call transcript, so one
act by a person verifies both calls and messages [I]. The app must seal only for a contact
whose app announced a key, or an old app would show a sealed string as text [I].

## 4. Frame format, metering and overhead

### The format

Nothing in the node changes. The sealed frame is simply another payload inside today's
4,096 bytes, with a new type byte in the app's own format (`mediaFrame.ts:22-24`) [S for
existing types].

```text
On the socket (unchanged):   seq u32 BE | payload <= 4096 bytes
Reveal (type 0x10, clear):   0x10 | A 32 | nonce 16
Sealed (type 0x11):          0x11 | epoch u8 | counter u32 BE | ciphertext | tag 16
                             AAD = header bytes + call id
                             nonce = 8 zero bytes + counter (one key per direction and epoch)
Inside the ciphertext:       type u8 | stream_seq u32 BE | len u16 | data | zero padding
```

- **Sealed overhead: 22 bytes, plus 7 inside, of which one is the type byte frames already
  carry.** That is 28 bytes more than today, before padding.
- **A single counter per direction, across all media types.** Video then needs no new
  key handling, and a nonce cannot repeat.
- **HELLO moves inside the seal** once keys exist, so a box cannot read or rewrite codec
  choices [I].
- **The receiver keeps a replay window** on the counter and drops duplicates and anything
  that fails the tag.
- **Outer `seq` is not trusted and is no longer the media clock.** It is unauthenticated,
  and a box could change it. Today playout uses it (`app:src/control/callAudio.ts:329-345`)
  [S]. After sealing, the jitter buffer reads `stream_seq`. This is required for video,
  where fragments would otherwise look like audio loss [I].
- **Audio padding:** pad the inside to the next multiple of 128 bytes, so Opus at 24 kbit/s
  (`callAudio.ts:37`) [S] becomes one constant size in normal speech [I]. Peak frame sizes
  are [U] and must be measured. A frame over the bucket reveals one bit about that frame.
  This also hides talking from silence at the size level; timing is constant at 50 frames
  a second [I].

### Can boxes still meter and cut off without reading content?

**Yes, and they already do. Encryption changes nothing here.**

| Control | How it works | Reads content? |
|---|---|---|
| Admission | Stored call is live and `now <= paid_until + 10 s` (`call.rs:336-338`, `:24`) [S] | No |
| Re-check | At most every second, plus a per-route timer that runs even when idle or stalled (`node:crates/konsensus-node/src/call_media.rs:55`, `:420-436`) [S] | No |
| Cut-off | A missed block ends the route about 11 s after the paid boundary at worst (`call_media.rs:344-345`, `:437-440`) [I from those numbers] | No |
| Rate cap | 100 frames and 64 KiB per second, by length (`:48`, `:50`, `:186-199`) [S] | No |
| Size cap | 4,096 bytes (`wire.rs:258`) [S] | No |

Encryption takes nothing away, but it exposes something true already: **a paid call is a
paid byte pipe of up to 64 KiB/s.** The box cannot tell audio from anything else. A box that
wants to bill by codec cannot, and today cannot either [I]. The `media` field in the offer
exists (`call.rs:70-73`), but I found no code that prices or caps by it [S, by keyword
search of `calls.rs`, `compose.rs`, `msg_handler.rs`].

### Overhead on a 4 KB frame at the rate caps

| Case | Today's payload | Sealed payload | Bytes per second | Share of the 64 KiB/s cap |
|---|---|---|---|---|
| Opus at 24 kbit/s, 50 frames/s, sealed and padded | 61 (average, [I]) | 150 | 7,500 | 11.4% (today 4.7%) |
| Same, sealed without padding | 61 | 89 | 4,450 | 6.8% |
| G.711 fallback, 50 frames/s, padded | 161 | 278 | 13,900 | 21.2% (today 12.3%) |
| A full 4,096-byte frame, 16 frames/s | 4,095 of data | 4,067 of data | 448 lost of 65,536 | **0.7% lost** |
| Worst case: small frames at the 100/s limit | | +28 each | 2,800 | 4.3% of the cap |

**The node-to-node link is more expensive than the cap suggests.** `Frame::CallMedia` is
JSON with base64 data inside Noise (`wire.rs:1-23`, `:364`; `noise.rs:248-256`) [S], and
the cap counts decoded bytes. Per direction, before TCP/IP headers [I from a computed
serialisation]:

| Case | Bytes per frame on the link | kbit/s between boxes |
|---|---|---|
| Opus today | 189 | 76 |
| Opus sealed and padded | 305 | 122 |
| G.711 today | 321 | 128 |
| G.711 sealed and padded | 477 | 191 |
| Full frames at the cap | 5,569 | **713** |

Encryption and padding take a voice call from about 76 to about 122 kbit/s each way. I
expect that to be acceptable; the two-box run must confirm it, including CPU and latency
[U]. Seal and open cost should be negligible at these rates [U].

**One sharp edge.** The socket's budget counts the whole message, including `seq` and
pings, and going over **closes the socket** instead of dropping a frame
(`node:crates/konsensus-api/src/call_media.rs:332-333`, `:346-359`, `:410-413`) [S]. Full
frames are 4,100 bytes, so only 15 fit per second [I]. Audio is nowhere near this. Video
would hit it unless the host paces.

## 5. Video on top

### Codecs, per webview

Everything here is [U] except the deployment targets, and no decision should rest on it
until the probe (slice V0) has run on real devices.

| Webview | Video encode and decode | Risk |
|---|---|---|
| **WKWebView** (iOS, macOS) | WebCodecs video since about Safari 16.4 [U]. H.264 in hardware. VP8 and VP9 encode uncertain [U]. | The app targets iOS 15.0 and macOS 11 (`app:src-tauri/gen/apple/bitsov-app.xcodeproj/project.pbxproj:532`, `app:src-tauri/tauri.conf.json:39`) [S], so older devices have no WebCodecs at all. Audio `AudioEncoder` arrived much later than video [U], which is why the mu-law fallback exists (`callAudio.ts:95-100`) [S]. Camera frames may need a video element and canvas route if `MediaStreamTrackProcessor` is absent [U]. |
| **WebView2** (Windows) | Chromium WebCodecs. VP8 and VP9 in software, H.264 available [U]. | Preview platform (`README.md:28`) [S]. Never tested with this path [I]. |
| **Android WebView** | Chromium WebCodecs. H.264 encode depends on the phone's hardware. VP8 in software [U]. | `minSdk` 24 (`app:src-tauri/gen/android/app/build.gradle.kts:22`) [S]. Old phones with a hot software encoder [U]. |

**Recommendation:** offer H.264 first and VP8 second, each direction choosing what the far
decoder says it can decode. The HELLO model already works that way for audio
(`mediaFrame.ts:10-13`) [S]. Reject a bundled WASM encoder: size and battery [I]. Reject
WebRTC encoded transforms: WebRTC is off in this profile and would bring back the direct
path the owner ruled out (`callFlags.ts:4-8`) [S].

### Bitrate against the cap and home uplinks

With sealed audio taking its share, what is left for video at the current cap [I]:

- Socket budget 65,536 B/s, minus audio at 154 B x 50 = 7,700 B/s, leaves 57,836 B/s
- That is 14 full messages a second, 56,826 B/s of video data, **about 455 kbit/s at most**
- With a 15% margin against the socket close: **about 385 kbit/s**

That is roughly 320x240 to 480x270 at 10 to 15 frames a second: a recognisable face, not
good video [U, general experience with these codecs]. The frame limit of 100/s is not the
one that binds.

**Uplink is doubled when the phone is away from its box.** The box sends to the peer's box
and also sends the far party to its own phone. Before TCP/IP headers, per call [I]:

| Tier, per direction | Between boxes | Box uplink, phone at home | Box uplink, phone away |
|---|---|---|---|
| Sealed audio only | 122 kbit/s | 122 kbit/s | about 195 kbit/s |
| 64 KiB/s (today's cap) | 713 kbit/s | 713 kbit/s | about 1.25 Mbit/s |
| 128 KiB/s | 1.43 Mbit/s | 1.43 Mbit/s | about 2.5 Mbit/s |
| 256 KiB/s | 2.85 Mbit/s | 2.85 Mbit/s | about 5 Mbit/s |

Real home uplinks vary widely, and I have no measurement of any box's uplink [U]. The app
should measure and step down rather than assume. Media runs over TCP on the same connection
as other frames, with frames dropped after a 200 ms write deadline
(`node:crates/konsensus-message/src/transport/mod.rs:410`, `messaging.rs:208-257`) [S]. So
loss becomes a stall on all three hops, and congestion hits audio too [I].

### Fragmentation of the 4 KB limit

A key frame at 320x240 is often 5 to 30 KB [U]. So:

- **Fragment inside the seal.** Inner type `0x20` carries `frame_id u32, index u16, count
  u16`, with room for 4,059 data bytes per frame [I]. Each 4 KB frame stays independently
  authenticated, so a forged fragment fails on its own. The box sees sizes and bursts, and
  can guess a key frame from those. That is not hidden.
- **Pace in the host.** A 30 KB key frame is 8 messages, over half a second at 14/s. Spread
  it. A burst at the start of the node's fixed one-second window can hit the cap
  (`call_media.rs:186-199`) [S]. An open node change proposes a token bucket instead; the
  host's pacing must work under both.
- **Audio first.** Queues drop the oldest **by frame count, not by type**: 32 at the node
  (`node:crates/konsensus-api/src/call_media.rs:48`), 50 at the host
  (`app:src-tauri/src/control/media.rs:38`) [S]. Video can evict audio. The node cannot
  prioritise what it cannot read, so the host must keep the queue short [I]. If that proves
  impossible, the fallback is one clear priority bit per frame, which leaks only what size
  already leaks. That would be a node change.
- **Few key frames.** Send them on start and on a sealed "please send a key frame" control
  message. Never on a timer at this bitrate [I]. On audio priority, drop video first.

### Price at 1 / 5 / 2

The minute is 2 sats and the hold is time-based. For a call at the 60-minute default
(`node:crates/konsensus-node/src/config.rs:1333`) [S], the formula is minutes times price
plus routing, plus closing, plus the offer (`node:crates/konsensus-api/src/spend_budget/calls.rs:51-85`,
`compose.rs:3668-3676`) [S]. Worked out [I, not run on a node]:

| Minute price | Free at Ring, routed | Free at Ring, direct | Note |
|---|---|---|---|
| **2** (audio today, and the 64 KiB/s tier) | **436** | 126 | |
| 5 | 616 | 306 | |
| 8 (proposed 256 KiB/s tier) | 796 | 486 | |
| 10 | 916 | 606 | |
| 20 | 1,516 | 1,206 | Over the default limit of 1,000 sats reserved per 10 minutes (`node:crates/konsensus-api/src/spend_budget.rs:141-144`, `:631-638`) [S]: refused unless the owner changes it or the call limit is lower |

Routed is `(p + 5) x 60`, plus a 6-sat closing (1 sat price, 5 sat routing ceiling), plus a
10-sat offer. Routing allowance is a held ceiling, not spend; what is really paid may be
far lower.

**Recommendation:** price the **rate tier, not the codec**, because the box can see rate
and cannot see codec.

- **The 64 KiB/s tier stays at the owner's 2 sats, for audio or video alike.** A caller can
  already push 64 KiB/s at that price [I]. No new policy, no code.
- **A higher tier is a separate advertised minute price set by the callee.** Default 8 sats
  for 256 KiB/s: 4 times the rate for 4 times the price. A single number the user can change.

### What must be decided now so video does not force a rebuild

Decide in the first audio slices:

1. Encrypt in the host, on opaque bytes. Crypto never learns the codec.
2. The inner layout: `type`, `stream_seq`, `len`, padding. Reserve `0x20` to `0x2F` for
   video and `0x30` to `0x3F` for control.
3. Playout reads `stream_seq`, not outer `seq`.
4. One key and one counter per direction, across all streams.
5. A pacer in the host from day one, even when audio alone never needs it.
6. A versioned `a=x-bitsov-e2e` attribute with a capability field. There is room in 16 KiB
   for a post-quantum key later [I].
7. Key rotation independent of payment and of the media type.
8. Label copy that says "call", never "audio".

Leave open: the codec list, resolutions, the higher tier's rate and price, a binary node
frame (which would cut the 33% base64 cost), and meetings.

Any higher tier is a node change on **both** boxes, because each caps inbound and outbound
(`call_media.rs:252`, `:394`) and the socket also holds its own copy of the constant
(`node:crates/konsensus-api/src/call_media.rs:333`) [S]. It needs a new capability beside
`call_media_v1` (`wire.rs:267`) and must fall back to 64 KiB/s [I].

## 6. Slices, dates and what cannot be promised

**Is 13 Nov realistic? For sealed audio on Mac and iPhone, yes, but tight, with no slack.
For anything more, no.** The estimates below are mine, not measured. They assume a start on
6 Nov after the 5 Nov proof, and each slice merged within about a day of being built. A
single failed real-device run or one slow merge uses up the margin.

### Needed for 13 Nov

All in this repo. No node release. Behind a build flag until E5 passes.

| Slice | What | Build days [I] | Size of the change |
|---|---|---|---|
| **E1** | Host crypto module: derive, seal, open, epoch, replay window, published test vectors. Not wired to anything. | 1 | One Rust file and its tests |
| **E2** | Key agreement: SDP attributes, reveal frame, commit check, state machine. Fail closed on a bad reveal. | 1.5 | Adapter and host, with a fake peer |
| **E3** | Seal and open in the media bridge, inner layout, padding, `stream_seq` for playout, pacer, peer without support | 1 to 1.5 | Media path only |
| **E4** | Three label states, words card, mismatch ending, Danish and English. Correct the "end-to-end" assistant copy. | 1 | UI, no crypto |
| **E5** | Two boxes on signet, Mac and iPhone, phone at home and away. Lab-only tap on a box to show the frames are not decodable. Measure latency, size and CPU. | 1 to 2 | Evidence and fixes |

That is 5.5 to 7 build days inside 8 calendar days, with merging running alongside. The
suggested cut if it slips, in order: the pacer's tuning, then "phone away", then the Danish
polish. **Never cut:** the commitment, the test vectors, the truthful label, or E5. If E5
has not passed by 13 Nov, the flag stays off and the label stays as it is. That is an honest
result. A sealed call shipped unproven is not.

### Not needed for 13 Nov

| Slice | What | Build days [I] |
|---|---|---|
| E6 | Continuity secret per contact, "checked before", missing-attribute warning | 1.5 |
| E7 | "Only private calls" setting | 0.5 |
| E8 | Android and Windows device runs, Windows sealer | 2 to 3 |
| E9 | Outside audit of the protocol | Depends on who does it |
| M0 to M5 | Messages (option A): decision, key and key card, seal and open, device-to-device key move, history and notifications, proof. One kind only at first. | 10 to 14, so 2 to 3 weeks |
| V0 | Codec probe matrix on real devices | 1 |
| V1 | Fragmentation and pacing, tested with synthetic data on today's path | 2 |
| V2 | Camera, WebCodecs, UI at the 64 KiB/s tier | 3 to 5 |
| V3 | Node rate tier, capability, advertised price, app quote and hold | 3 to 4 node, 2 app |
| V4 | Two-box proof, including a poor uplink | 1 to 2 |

Video: 3 to 4 weeks after sealed audio if nothing else competes [I]. Video and sealed
messages should not run at once.

### What cannot be promised by 13 Nov

- Sealed messages of any kind
- Video of any kind
- Android and Windows parity
- An outside audit of the protocol. It is composed from standard parts and unaudited.
- Protection from an active box when the words were not compared
- Hiding who called whom, when, for how long and how much was paid
- Recording protection against the person on the other end
- Post-quantum protection
- Any measured call quality with sealing on, until E5 reports

## 7. Open owner decisions

| # | Decision | Recommendation | Why |
|---|---|---|---|
| **D1** | Where sealing happens | **In the host, not the webview.** | One implementation on four webviews. The key never reaches JavaScript. |
| **D2** | A peer cannot do sealed calls, or a box stripped the offer | **Allow with today's label by default, and warn if this contact was sealed before. Setting: "Only private calls", off by default.** Turn the default on once most contacts have upgraded. | Little policy, default the user can change. A hard refusal would break calls in the rollout week. |
| **D3** | Words or digits | **Four words, the same as device join.** Test on a person, switch to six digits if it fails. | Nothing new to learn. The switch costs nothing later. |
| **D4** | Must words be compared? | **Offered, never required.** The label stays truthful either way. | Forced ceremony gets clicked through, which is worse than an honest label. |
| **D5** | Padding, at about 3 extra KB/s per direction | **Pad.** | Sealed but unpadded still leaks speech patterns to the box, which is the very thing being removed. |
| **D6** | Messages model | **Box-readable and plainly labelled until sealed calls are proven, then one key per owner (option A).** | Works with several devices and history, passes the 70-year-old bar. Accepts weaker forward secrecy, with rotation. |
| **D7** | All devices lost | **Sealed content is gone. New messages work. No copy with the box or the seed, ever.** An optional owner export later. | Any box-held copy breaks `CHARTER.md:18-21`. Must be said before someone relies on it. |
| **D8** | Video rate and price | **64 KiB/s at the audio minute price. 256 KiB/s as a later tier with a callee-set price, default 8 sats.** | Price what the box can see. Rate-proportional default, user-changeable. |
| **D9** | Wording that overclaims today | **Correct now, before any of this ships:** `node:README.md:18` and the assistant questions. Put the charter file in the node tree or stop pinning it. | The honesty principle costs nothing to meet here. |
| **D10** | Post-quantum | **Not in v1.** The attribute is versioned, so it can be added later. | A date is at stake and a device-tested X25519 call comes first. |

## Not verified, in one place

- No call was run. Everything about latency, CPU, audio quality and bitrates is [I] or [U].
- That the node passes the new SDP attribute unchanged end to end is [I]: the parser allows
  it, but no two-box test has done it.
- The hold figure of 436 sats at 1 / 5 / 2 is worked from source and has not been run on a
  node.
- All webview codec facts are [U] until V0.
- Peak Opus packet size under padding is [U] until E5.
- How two ringing devices of one owner behave on a sealed call is [U].
- Absence claims (no search, no box-side call assistant, no price by media type, no Windows
  sealer) come from keyword searches of the pinned trees, so a miss is possible.
