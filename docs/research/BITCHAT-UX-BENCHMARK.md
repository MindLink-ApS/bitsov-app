# BitChat UX benchmark and ticket list

Research note, 2026-10-23. Docs only: nothing in this file has shipped. It compares BitSov's current flows with BitChat. It then turns the useful lessons into small UI tickets.

## Sources and method

**BitChat (primary sources only).** I read source code at a pinned commit, not marketing copy:

| Repo | Commit read | Last commit date |
|---|---|---|
| iOS/macOS: https://github.com/permissionlesstech/bitchat | `5e9287f` | 2026-09-24 |
| Android: https://github.com/permissionlesstech/bitchat-android | `dfc67da` | 2026-10-22 |

From those repos I read:
- the READMEs and `WHITEPAPER.md`;
- the iOS string catalog `bitchat/Localizable.xcstrings` (English values are quoted verbatim below);
- the view and view-model code;
- the Android onboarding code and `docs/screenshots/`;
- the Android fastlane changelog.

Below, iOS source paths are relative to the iOS repo and Android paths to the Android repo.

What I could not check:
- **The App Store listing and bitchat.free.** Both were unreachable from the research environment (DNS blocked). Nothing here comes from them. Store screenshots, the "What's New" text and store version numbers are **not verified**.
- **A changelog for iOS.** The iOS repo has no CHANGELOG file.
- **The Android changelog.** `fastlane/metadata/android/en-US/changelog/3.txt` is old (AGP 8.10 / Kotlin 2.2 era), so it was used only for the onboarding note.
- **Runtime behaviour on a device.** The BitChat step counts below come from reading the code. The order in which iOS shows system permission prompts at runtime is not device-verified.

**BitSov.** I read `main` at `6d5854b` (#335): `README.md`, `src/onboarding/`, `src/control/`, `src/App.tsx`, `docs/ui/*` and the flow docs. BitSov's own UI evidence (U4, U5) comes from sample-data simulator runs (`docs/ui/u4-first-spend/README.md`, `docs/ui/u5-phone-shell/README.md`). Physical-device acceptance is still outstanding (`docs/PHONE_ONBOARDING_PR2.md`). `README.md` still says mobile is gated. Treat "shipped on main" below as "merged code", not "released to users".

---

## 1. What BitChat does (cited)

### First run and onboarding
- **iOS has no onboarding screen.** I found no onboarding or welcome view in `bitchat/Views/`.
  - On first launch a nickname is generated: `nickname = "anon\(Int.random(in: 1000...9999))"` (`bitchat/ViewModels/ChatViewModel.swift:1264-1267`).
  - The user lands in the public `#mesh` channel.
  - The only gate is the system Bluetooth prompt, whose purpose string is "bitchat uses Bluetooth to create a secure mesh network for chatting with nearby users." (`bitchat/Info.plist`).
  - Empty-state copy teaches in place:
    - "you're on #mesh — reaches people within bluetooth range"
    - "nobody in range yet... messages appear here"
    - "tap the channel name above to switch · tap bitchat/ for help"

    (`content.empty.*` in `Localizable.xcstrings`)
- **Android has a short permission funnel.** The states are `CHECKING → BLUETOOTH_CHECK → LOCATION_CHECK → BATTERY_OPTIMIZATION_CHECK → PERMISSION_EXPLANATION → BACKGROUND_LOCATION_EXPLANATION → PERMISSION_REQUESTING → INITIALIZING → COMPLETE` (`app/src/main/java/com/bitchat/android/onboarding/OnboardingState.kt`).
  - On a fresh install with Bluetooth on, the user sees one explanation screen with a "Grant permissions" button, then the OS permission dialogs.
  - The Bluetooth/location/battery screens only appear when something is off (`MainActivity.kt:395-445`).
  - The rationale strings state *why* for each permission. For example: "Location permission is required to discover nearby devices via Bluetooth." (`res/values/strings.xml`).

### Identity: nicknames and ephemeral keys
- **No accounts, no phone numbers** (iOS `README.md`).
- **The nickname is free text** of at most 50 characters (`bitchat/Utils/InputValidator.swift:11`).
  - It is edited inline in the header (`content.input.nickname_placeholder` = "nickname").
  - When names collide, a `#xxxx` suffix is added (`bitchat/Utils/PeerDisplayNameResolver.swift`).
- **The mesh identity is *not* ephemeral.** The whitepaper says so plainly: the peer ID "is the first 8 bytes of the SHA-256 fingerprint of the device's Noise static key, so it is stable … and it changes only when the identity itself is replaced by a panic wipe" (`WHITEPAPER.md` §3).
- **The ephemeral part is per-geohash keys** for location channels: "Fresh cryptographic identity per geohash area" (iOS `README.md`).

### Channels, #rooms and private DMs
- **Channel types** (iOS `README.md`):
  - `#mesh`: Bluetooth only.
  - Geohash location channels at levels `block`, `neighborhood`, `city`, `province` and `region`, carried over Nostr.
- **Android adds topic channels** with optional password protection (Argon2id + AES-256-GCM) (Android `README.md`).
- **IRC-style commands** include `/msg`, `/who`, `/fav`, `/block`, `/group`, `/pay` and `/drop` (`bitchat/Services/CommandProcessor.swift:165`, `command.help.text`).
- **The composer placeholder states the scope** of every message:
  - "message #mesh — public, nearby"
  - "message #%@ — public"
  - "message %@ — private"

  (`content.input.placeholder.*`)
- **DMs:**
  - Over Bluetooth, they use a Noise XX session.
  - Over the internet, they fall back to Nostr private envelopes, **only between mutual favourites** (`WHITEPAPER.md` §2, §5.3).

### Offline BLE mesh and store-and-forward
- **Relay:** multi-hop, at most 7 hops (READMEs).
- **Routing order:** live mesh link first, then Nostr, then couriers (`WHITEPAPER.md` §2).
- **Couriers** carry sealed envelopes for people who are out of range (`WHITEPAPER.md` §6.2):
  - up to 3 couriers per message;
  - a spray-and-wait copy budget;
  - 16 KiB / 24 h caps;
  - a larger quota for mutual favourites.
- The whitepaper states openly that the courier path "has no forward secrecy" (§5.1–5.2).
- **The UI names these states plainly:**
  - "Carried by a friend who may meet them"
  - "sent — no delivery confirmation yet"
  - "delivered to %@"
  - "failed: %@"

  (`content.delivery.*`)
- **Degraded-state banners say what is lost and how to fix it:**
  - "bluetooth is off — nobody nearby can reach you. tap to fix."
  - "tor can't connect — internet features are paused. mesh still works."

  (`content.banner.*`)

### Panic wipe
- **The README feature** says "Triple-tap to instantly clear all data" (both READMEs).
- **Current iOS main adds a confirmation step** after the triple-tap on the `bitchat/` logo. A comment in the code explains: "Confirm before destroying: … a fumbled tap must never be able to wipe the device. … under duress it costs one extra tap." (`bitchat/Views/ContentHeaderView.swift:53-59`).
  - The dialog reads "wipe all data?" / "wipe everything" (`bitchat/Views/ContentView.swift:555-570`).
- **There is also a visible button** in Settings under "DANGER ZONE", labelled "panic wipe". Its note says it "erases all messages, keys, and identity. triple-tapping the bitchat/ logo does the same, instantly." (`app_info.settings.danger.panic_note`). That "instantly" is stale: the triple-tap now asks for confirmation too (`ContentHeaderView.swift:53-59`).
- **What the wipe resets** (`ChatViewModel.swift:1557-1630`):
  - the nickname, back to `anon####`;
  - favourites;
  - location state;
  - queued and courier mail.

### Favourites and verification
- **Favourites** are described as "get notified when your favorite people join" (`app_info.features.favorites.*`).
  - Mutual favourites unlock Nostr delivery and a larger courier quota (`WHITEPAPER.md` §7).
- **Verification:**
  - A sheet with "show my qr" and "scan someone else's qr" (`bitchat/Views/VerificationViews.swift:465-471`).
  - A fingerprint view with "their fingerprint:" and "your fingerprint:", badges "✓ VERIFIED" and "⚠️ NOT VERIFIED", and "mark as verified".
  - A device-local alias: "only on this device. leave blank to use their claimed nickname."
  - A "✓ VOUCHED" badge: "vouched for by %#@people@ you verified" (`bitchat/Views/FingerprintView.swift`, `fingerprint.*`).

### Notifications and battery modes
- **There is a "hide message previews" privacy toggle.** Redacted notifications read "🔒 new dm", "🫵 you were mentioned" and "open bitchat to read" (`notification.redacted.*`).
- **There is also an engagement-style notification:** "👥 bitchatters nearby!" (`notification.nearby.*`).
- **Battery handling is automatic, not a user setting.** On Android:
  - `PowerManager` picks `PERFORMANCE / BALANCED / POWER_SAVER / ULTRA_LOW_POWER` from foreground/background state and the battery band `NORMAL / LOW / CRITICAL` (`app/src/main/java/com/bitchat/android/mesh/PowerManager.kt:36-45, 297-310`).
  - A foreground service keeps the mesh alive (Android `README.md`).
  - I found no user-facing power-mode picker in `ui/`.

  On iOS, the README lists "adaptive battery modes" and BLE duty cycling.

### Localization
- **iOS:** 520 keys in one `Localizable.xcstrings`.
  - 30 locales: ar, bn, de, en, es, fa, fil, fr, he, hi, id, it, ja, ko, ms, ne, nl, pl, pt, pt-BR, ru, sv, ta, th, tr, uk, ur, vi, zh-Hans, zh-Hant.
  - There is an in-app language picker. It says "restart bitchat to apply the new language" (`app_info.settings.language.*`).
  - Keys are named by intent (iOS `README.md` § Localization).
  - CI runs a per-catalog l10n coverage guard (commit `7113187`, #1679).
- **Android:** a similar set of `values-*` folders.
- **Neither app ships Danish (`da`).**

### Payments
- **No built-in wallet.** BitChat recognises Cashu tokens and Lightning links in messages and shows chips: "pay via cashu", "pay via lightning", "redeem in wallet", "redeem on web" (`bitchat/Views/Components/PaymentChipView.swift`, `content.payment.*`).
  - "the app itself never contacts a mint" (`PaymentChipView.swift`, comment on `cashuWebRedeemURL`).
- **`/pay <token>` sends a Cashu bearer token** (`CommandProcessor.swift:504-537`).
  - It warns: "cashu is a bearer token; whoever redeems it first gets the funds".
  - In public channels it requires a second, explicit command: "this is a public channel — anyone reading it can redeem the token. send anyway: /pay <token> public".
- **Messaging is free.** Payment is optional, peer-to-peer and outside the protocol.

---

## 2. What BitSov does today (`main` at `6d5854b`)

### Phone onboarding
Code: `src/onboarding/PhoneOnboarding.tsx`, copy in `phoneCopy.ts`.

1. "Scan your box’s QR"
2. Native scanner
3. Connecting: "Keep your other device nearby."
4. "Do these words match?" / "Approve on your other device." The owner approves with biometrics on the other device.
5. "You're connected" → "Open BitSov"
6. Trust disclosure: "I understand — continue" (`PhoneTrust.tsx:23`)
7. Chats tab

The box must already be claimed. A phone cannot set up an unclaimed box: it shows "This box isn't set up yet / Set up on your computer first." (`PhoneOnboarding.tsx:102`).

### Mac onboarding
Code: `Onboarding.tsx`, `LocalOwnerCeremony.tsx`, `App.tsx`. The stepper is Your node → Your identity → Add sats (optional).

1. Pick "This Mac".
2. Automatic loopback pairing.
3. Owner ceremony:
   - Create identity.
   - Recovery phrase → "I wrote it down".
   - 3-word check.
   - Confirm with Touch ID.
4. Touch ID approvals setup (can be skipped).
5. Trust disclosure.
6. Optional funding: 50 000 sats default, with a QR.

### From the shell to a first paid message
1. Browse → Profiles "paste a card"
2. Paste a `bitsov://front-door#…` link, then "Read card"
3. "Knock", which pays their admission (`Discover.tsx:139-196`)
4. Type the message, then Send
5. FirstSpendSheet: "Let messages spend up to {0} a day?" → "Allow {0} a day" (`appCopy.ts:117-143`)
6. Per-contact "Approve with Touch ID" / biometrics, when the device key is registered (`Shell.tsx:4846-4859`)
7. Send

The app cannot scan a contact's card with the camera. It says so: "This app does not scan profile QR codes with the camera." (`Discover.tsx:142`).

### Price and delivery
- **Price on the Send button:** "Send · N sats".
- **Cost line:** "Entry fee · message · routing fee at most · total at most".
- **Paid but undelivered:** "Paid {0} · not delivered yet", with a retry that pays nothing new (`appCopy.ts:210-214`).
- **Delivery marks:** ✓ for accepted or delivered; the words Sent / Queued / Rejected otherwise (`Shell.tsx:3940-3961`).
- **No read receipts.**

### Calls
A **regtest prototype** (`docs/CALLS.md:1`):
- 1:1 WebRTC, with paid signalling messages.
- Only contacts you have already paid can be called.
- No TURN.
- Meetings of up to 4 people.

### Wallet
- Activity / Channels / Receive / Send; the phone adds an "Add sats" button (`WalletPage.tsx`).
- The signet starter balance is behind a build flag that is **off by default** (`docs/STARTER-BALANCE.md`).

### Phone tabs
Chats · Wallet · You. Calls is inserted second only once call history exists (`src/control/PhoneShell.tsx:21-23`).

### Verification
Shipped:
- a local petname;
- an out-of-band fingerprint/QR compare;
- "Mark verified";
- a "Key changed" pill (`ContactPanel.tsx`, `petnames.ts`).

### Localization
- **Languages:** English and Danish, from the system language or a Settings pref (`src/i18n.ts`).
- **The hardcoded-English test guard** covers only `src/onboarding/**` and `App.tsx`.
- **These control screens are still English-only:**
  - Discover/Knock
  - the contact verify sheet
  - OfflineNode
  - the New/introduction track
  - send-queue announcements
  - parts of wallet/settings (per `docs/ui/u5-phone-shell/README.md`)

### Notifications
- **Mac only:** a local notification for owner approvals, with generic text (`ownerApprovalNotification.ts:45`).
- **Nothing on mobile** for messages or calls.

### Not found in BitSov
- a panic wipe;
- favourites or pinning;
- offline or BLE delivery;
- push notifications.

---

## (a) Step counts to the first message

Counted from code; not device-timed. A "tap" is a deliberate user action. OS permission prompts count as a tap each.

| | BitChat iOS | BitChat Android | BitSov iPhone/Android | BitSov Mac |
|---|---|---|---|---|
| Setup before the app is usable | Launch → allow Bluetooth: **1 tap** | "Grant permissions" + about 2–3 OS dialogs (nearby devices, location, notifications; depends on Android version). Battery-optimization screen only if needed: **3–4 taps** | Requires a box that was **already set up from a Mac**. Scan → (allow camera) → owner approves words on the other device with biometrics → "Open BitSov" → "I understand — continue": **3–4 taps + 1 biometric on another device** | Node → owner ceremony (write down the phrase, 3-word check) → Touch ID → approvals setup → disclosure → optional funding: **about 7 taps + 2 Touch ID + phrase backup** |
| Reach someone | Already in `#mesh`. For a DM: open people list → tap a peer (**+2**) | Same | Get a card out of band → Browse → Profiles → paste → "Read card" → "Knock" (paid admission): **about 4 taps** | Same, about 4 taps |
| Send the first message | Type → Send: **1 tap** | Same | Type → Send → "Allow N a day" → Touch ID / biometric approve → Send: **about 3 taps + 1 biometric** | Same |
| **Total from install** | **2 taps** (public) / **4** (DM) | **4–5** / **6–7** | **about 10–11 taps + 2 biometrics** (and a prior Mac setup) | **about 14 taps + 3 Touch ID + phrase backup** |
| Money moved before the first message | none | none | admission (Knock) + message price + routing fee at most | same |

**How to read this.** BitChat's two-tap number is not a target BitSov should chase. Most of BitSov's extra steps exist on purpose:
- owner custody (the recovery phrase);
- paid admission ("payment is the connection");
- budget consent.

The steps BitSov *can* cut without weakening money or security clarity:
1. **No camera scan for contact cards.** Pasting is the only way in today.
2. **"Browse → Profiles → paste" is three hops** to what should be one "Add someone" action.
3. **Knock, first Send and Allow are separate moments.** That stays correct, because each has its own price. But the empty state never tells the user about them in advance.

---

## (b) Top 10 UX lessons

BitSov doctrine applied throughout:
- payment is the connection, so there is **no free first message**;
- **Bitcoin is never identity**;
- **never trade money or security clarity for polish**;
- **one action per screen**.

**1. No profile gate before the first act.** BitChat assigns `anon####` and lets you talk at once.
- *Adopt:* never add a nickname or profile step to BitSov onboarding. Default the contact's display name from their card, and let the petname be edited later in ContactPanel.
- *Don't adopt:* anonymous throwaway identity. BitSov identity is the node, not a nickname, and never a Bitcoin address or key.

**2. Empty states that name the next action.** BitChat's empty `#mesh` explains its reach and how to switch. BitSov's empty Chats list says only "No contacts yet".
- *Adopt:* an empty state with one primary action ("Add someone") and one line saying that messages cost what the other person sets, and that the price is shown before anything is paid.
- *Don't adopt:* stacking help text. Keep one action, one sentence.

**3. The composer says where the words go.** "message %@ — private" / "message #mesh — public, nearby".
- *Adopt:* add a scope word to BitSov's placeholder, for example "Message Maya · private", and "Message room · N members" for rooms.
- *Don't adopt:* moving the price into the placeholder. A placeholder disappears as you type. The persistent cost line and "Send · N sats" stay where they are.

**4. Degraded-state banners name the consequence and one fix.** "bluetooth is off — nobody nearby can reach you. tap to fix."
- *Adopt:* BitSov's OfflineNode copy already does this well ("New messages can’t be sent until your node is back; ones already sent may still complete."). It needs Danish, and a compact one-line banner form for the chat view.
- *Don't adopt:* banners that say "paused" for a payment that may still settle. Money state must be exact.

**5. Honest delivery vocabulary.** BitChat separates "sent — no delivery confirmation yet", "Carried by a friend who may meet them" and "failed: reason", and has a "tap to show delivery details" hint.
- *Adopt:* make BitSov's paid line tappable. Open a detail sheet that separates **paid** (amount, routing fee) from **delivered** (state, time), and shows retry with "pays nothing new".
- *Don't adopt:* read receipts as a side effect. If BitSov ever adds them, they are an act with a price and the user's consent, not an implicit leak.

**6. A wipe that is reachable and confirmed.** BitChat now confirms even the triple-tap, so "a fumbled tap must never be able to wipe the device". There is also a visible "DANGER ZONE" button.
- *Adopt:* a visible "Remove BitSov from this phone" in You → Settings. It sits behind a destructive confirm, which says plainly that the box, its funds and its identity are untouched. It extends the existing "Forget this box".
- *Don't adopt:* the hidden triple-tap gesture. Undiscoverable destructive actions conflict with security clarity. Never imply a wipe destroys funds or the node.

**7. Verification in both directions, from one sheet.** "show my qr" and "scan someone else's qr", with "✓ VERIFIED" / "⚠️ NOT VERIFIED" and a device-local alias.
- *Adopt:*
  - camera scan for the card/verification QR on iPhone (the native scanner already exists for pairing);
  - a verified/not-verified mark in the chat header that opens the ContactPanel verify sheet.
- *Don't adopt:* "✓ VOUCHED" transitive trust for now. It turns verification into a social count and blurs what was actually checked.

**8. Favourites as a local list tool.** BitChat favourites also unlock transport and quota.
- *Adopt:* pin contacts to the top of Chats, stored on the device only.
- *Don't adopt:* favourites that change price, skip budget approval, or grant free messages. A pin is a sort order, never a payment rule.

**9. Notifications private by default.** "hide message previews" gives "🔒 new dm" / "open bitchat to read". BitSov's Mac approval notification is already generic; mobile has no notifications at all.
- *Adopt:* when mobile notifications are built, make them redacted by default, with no amounts, no names and no message text on the lock screen unless the user opts in.
- *Don't adopt:* engagement pings like "👥 bitchatters nearby!".

**10. Localization as a guarded system.** BitChat has 30 locales, intent-named keys, an in-app picker and a per-catalog coverage guard in CI. BitSov has two locales, but its guard covers only onboarding.
- *Adopt:*
  - extend the hardcoded-English guard to `src/control/**`;
  - translate Discover, ContactPanel, OfflineNode and the New track.
- *Don't adopt:* machine-translating signed approval terms. They stay English, as `docs/ui/m1a/README.md` documents, with a Danish explanation around them, until signed-term localisation is designed.

**Payments, as a contrast rather than a lesson.** BitChat's bearer-token honesty is worth copying in spirit: "whoever redeems it first gets the funds", plus a second explicit step before a public send. Its model is not worth copying. Free messaging with optional tips is the opposite of "payment is the connection", and pasting bearer tokens into chat is not something BitSov should ever do.

---

## (c) UI tickets

Small, one-PR tickets. Every ticket needs Danish and English copy, a Dynamic Type AX5 check, and no change to price, budget or approval logic unless stated. iOS tickets come first, then Mac.

### iOS (and Android where the phone shell is shared)

**I-1. Scan a contact card with the camera**
- *Files:* `src/control/Discover.tsx`, `src/pairingScanner.ts` (reuse), `src/appCopy.ts`
- *Acceptance:*
  - On iPhone, Discover shows "Scan card" next to paste.
  - It opens the native scanner. A `bitsov://front-door#…` QR gives the same result as "Read card".
  - Scanning **never** knocks by itself. "Knock" stays a separate tap showing the admission price.
  - A wrong QR type (for example a pairing QR) shows a clear error and pays nothing.
  - The line "This app does not scan profile QR codes with the camera." is removed or updated.

**I-2. Empty Chats state with one action**
- *Files:* `src/control/Shell.tsx` (around the `uiNoContactsYet` fallback), `src/appCopy.ts`
- *Acceptance:*
  - When there are no contacts, the list shows one primary button, "Add someone". It opens Discover (or the scan from I-1).
  - It shows one line of copy, roughly "Messages cost what the other person sets. You’ll see the price before anything is paid."
  - No other buttons appear.

**I-3. The composer placeholder states the scope**
- *Files:* `src/control/Shell.tsx` (composer), `src/appCopy.ts`
- *Acceptance:*
  - 1:1 chats show "Message {name} · private"; rooms show "Message {room} · {n} members".
  - The cost line and "Send · N sats" are unchanged.
  - The U5 chat snapshots are updated.

**I-4. Translate control screens and widen the English guard**
- *Files:* `src/control/Discover.tsx`, `src/control/ContactPanel.tsx`, `src/control/OfflineNode.tsx`, the New track in `Shell.tsx`, `src/appCopy.ts`, `tests/onboarding-copy.test.ts`
- *Acceptance:*
  - All visible strings in these files come from `appCopy`, with Danish entries.
  - The guard covers these files and fails on new hardcoded English.
  - Signed approval terms stay allowlisted as English.

**I-5. Delivery detail sheet**
- *Files:* `src/control/Shell.tsx` (delivery marks, about lines 3940-3961, and the paid line), `src/appCopy.ts`
- *Acceptance:*
  - Tapping the paid/delivery line of a sent message opens a sheet with two sections:
    - **Paid:** amount, routing fee, or "not reported".
    - **Delivery:** Sent / Queued / Delivered / Rejected, and time.
  - Retry appears only for paid-but-undelivered messages, with "pays nothing new".
  - The sheet has one action and adds no new payments.

**I-6. Verified mark in the chat header**
- *Files:* `src/control/Shell.tsx` (chat header), `src/control/ContactPanel.tsx`, `src/control/petnames.ts`
- *Acceptance:*
  - The header shows "Verified" or "Not verified" from existing petname state.
  - Tapping it opens the existing verify sheet.
  - "Key changed" takes priority over Verified.
  - It has an accessible label and no new crypto.

**I-7. Pin contacts (local only)**
- *Files:* `src/control/petnames.ts`, `src/control/Shell.tsx` (chat list), `src/appCopy.ts`
- *Acceptance:*
  - "Pin" / "Unpin" lives in ContactPanel.
  - Pinned contacts sort first in Chats.
  - Pins are stored on the device only, never sent to the node.
  - A test proves that pinning does not change price, budget or approval paths.

**I-8. "Remove BitSov from this phone"**
- *Files:* `src/onboarding/PhoneOnboarding.tsx` ("Forget this box"), You → Settings in `src/control/Shell.tsx`, `src/appCopy.ts`
- *Acceptance:*
  - A visible destructive item opens a confirmation. The confirmation states that the box, its funds and its identity are not affected, and what *is* removed from this phone (pairing, local names, cached messages).
  - There is no gesture shortcut.
  - After confirming, the app returns to phone onboarding.
  - The list of removed data is checked against actual local storage before the copy ships.

**I-9. Compact offline banner in chat**
- *Files:* `src/control/OfflineNode.tsx`, `src/control/Shell.tsx`, `src/appCopy.ts`
- *Acceptance:*
  - When the node is offline and a chat is open, a one-line banner shows: "Your node is offline — new messages can’t be sent" plus "Retry".
  - The full card stays where it is today.
  - The copy matches the existing OfflineNode wording, which already avoids claiming that in-flight payments stopped.
  - Danish copy is added.

### Mac

**M-1. Camera scan of a contact card on Mac**
- *Files:* `src/control/Discover.tsx`, `src/cameraQrScanner.ts`
- *Acceptance:* the same behaviour as I-1 using the jsQR camera path, with the same "scan never knocks" rule.

**M-2. Empty state, composer scope and delivery sheet on the Mac rail layout**
- *Files:* `src/control/Shell.tsx`
- *Acceptance:*
  - I-2, I-3 and I-5 render correctly in the wide/rail layout.
  - The m1a-style browser layout check passes in Danish and English at default and large text.

**M-3. Visible "Danger zone" placement on Mac**
- *Files:* `src/control/Shell.tsx` (settings)
- *Acceptance:*
  - "Use this Mac instead" / forget-node actions are grouped under one clearly labelled destructive section, each behind its own confirmation.
  - No funds-affecting action sits in that section without a separate owner approval.

---

## (d) Design note: does offline or BLE delivery fit BitSov later?

**Status: design note only. Nothing here is planned, built or promised.**

### Where it fits
BitChat's courier model (`WHITEPAPER.md` §6.2) solves the case "both people are out of reach of the internet". It does this by moving sealed ciphertext through nearby phones. BitSov's doctrine already provides two pieces it could build on:
- zero plaintext at any layer;
- the node as identity anchor.

A sealed envelope carried over BLE fits "zero plaintext". The phone is a thin client of the user's box, so the natural shape is:
- **the phone carries sealed, already-paid envelopes** to the box (or to a peer's box) when it gets back in range;
- **it never settles payments offline.**

### Where it conflicts

**1. Payment is the connection.**
- A message delivered over BLE without a Lightning payment would be a free first message. That breaks the doctrine.
- Any offline design must either:
  - carry a **pre-authorised, budget-bounded payment** that only settles when it reaches the recipient's node (this needs node-protocol support that does not exist today), or
  - be limited to contacts already admitted and paid for, with the price charged on arrival.
- Both options mean money is "pending" for longer. That status must be shown exactly, as "Paid / not delivered yet" is today.

**2. Bitcoin is never identity, and the node is the anchor.**
- BitChat's BLE peer ID is a stable device fingerprint, and the whitepaper itself says it can be tracked.
- A BitSov BLE layer must not broadcast the node ID or any payment identifier.
- Rotating, unlinkable tags (like BitChat's daily HMAC recipient tag) are the minimum.

**3. Security clarity.**
- BitChat's courier path has **no forward secrecy**, and its whitepaper says so.
- BitSov would need either a prekey design or the same plain-language disclosure in the UI before offering it.

**4. Scope and boundary.**
- `docs/ARCHITECTURE_BOUNDARY.md` says the app consumes the node API and does not implement protocol logic.
- A mesh transport is protocol work. It belongs in the node repo first. The app would show only a transport badge and delivery states (lesson 5).

### Verdict
It is plausible later, as a **node-protocol feature** for already-admitted contacts with settle-on-arrival payments. It is not an app-side feature, and not a way to get a free first message. Until then, the honest UI stays: "New messages can’t be sent until your node is back."
