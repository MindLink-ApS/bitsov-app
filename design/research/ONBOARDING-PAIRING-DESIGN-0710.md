# Onboarding and pairing with a home box: UX design (2026-10-07)

**Product/UX design only.** The security model is the one in `docs/` and the node's own documentation. This file
adds no claims beyond them.

## Target experience

> Plug in the box → open **bitsov.local** → scan its QR in the app → compare **4 words** on both screens →
> tap **Approve** on the box page → **Touch ID**. After a power cut: one **Unlock with Touch ID**.

## Decisions this design follows

1. **The box page.** It lives at `bitsov.local` on the home network and is the box's only screen.
   - During setup it shows a QR code and, later, the 4 words and an **Approve** button.
   - After setup it shows **status only**.
2. **The claim code.** Every box has one from day one.
   - It is printed on a sticker on the box, or shown once on the console for a self-flashed Pi.
   - It feeds into the 4 words, so only someone holding the box (or its first console) gets matching words.
3. **The password.**
   - The owner picks it in v1 and types it **once** in the app.
   - The app stores it behind Touch ID and sends it only over the pinned encrypted tunnel to the box.
4. **More devices.** Further devices are approved **from an existing owner device**, not from the box page.
5. **Lost device vs lost box.** These are kept apart everywhere in the copy.
   - **Lost device** means re-pair from another device or the box.
   - **Lost box** means recover with SSH plus the 24-word recovery phrase.
6. **Delivery order.** The node work lands first, one PR at a time:
   1. `--home`/systemd
   2. endpoints/mDNS
   3. 4 words + claim code
   4. the box page

   The app then removes its block on remote first run. Today `onboardingSteps()` in `src/onboarding/pairing.ts`
   marks identity **blocked** for a remote bootstrap node.

## The claim-code sticker

```
┌──────────────────────────────────────┐
│  BitSov home box                     │
│                                      │
│   ▓▓▓▓▓▓▓▓      Claim code           │
│   ▓ QR   ▓      K7Q2-M9XD            │
│   ▓▓▓▓▓▓▓▓                           │
│                 bitsov.local         │
│  Keep this sticker. You need it      │
│  only to set the box up.             │
└──────────────────────────────────────┘
```

- **Size and placement.** About 40 × 25 mm, on the underside of the case. A spare copy goes in the box.
- **The QR.** It encodes the claim code only. The app can scan it as an alternative to the box page's QR.
- **The code.** Eight characters in two groups, from an alphabet without look-alikes (no 0/O, 1/I/L).
- **Copy.** No security promise on the sticker: it says what the code is *for*, not that it makes anything "secure".
- **Self-flashed Pi.** The console prints the same block once at first boot, with the line "Write this down now. It
  is shown once."

## Screens

Each screen is described in words. The repo has no Figma, so this is the spec.

### S1 · Where should your node run? (exists today)
- No change to structure: **This Mac** first, and the home box under *Advanced*.
- Copy change: the Advanced label reads **"A BitSov box at home"**, with one line: "Plug it in, then we'll find it on
  your network."

### S2 · Find your box
```
Your node   ·   Your identity   ·   Add sats
────────────────────────────────────────────
Plug in your box
[ box illustration ]

1  Connect the box to power and your router.
2  On this Mac, open  bitsov.local  ↗
   (or scan the sticker on the box)

[ Open bitsov.local ]          Paste a link instead
```
- **Primary action.** On Mac, the primary opens the box page in the default browser. On Android, the primary is
  **Scan the QR**.
- **Fallback.** "Paste a link instead" keeps today's `[data-remote-access]` form.
- **If the app cannot reach `bitsov.local`.** It says exactly that: "This Mac can't find bitsov.local on this
  network." It offers **Try again** and "Use the box's address instead".

### S3 · Scan
- The box page shows a QR. The app's scanner opens (Android), or the user pastes/opens the link (Mac).
- One line under the scanner: "Point at the QR on the box page or the sticker."
- After a successful scan, the screen moves straight to S4 with no extra confirm.

### S4 · Compare 4 words (the security step)
```
Do these words match the box page?

   ┌────────────┬────────────┐
   │  harbor    │  violet    │
   ├────────────┼────────────┤
   │  pencil    │  orbit     │
   └────────────┴────────────┘

[ They match ]          They don't match
```
- **The words.** They are shown large, in the same order as the box page, and are lowercase.
- **They match.** The app waits for the box: "Now tap **Approve** on the box page."
- **They don't match.**
  - The app stops, saves nothing, and says: "Don't continue. Something else may be answering on your network.
    Unplug the box, plug it back in, and start again."
  - It offers no "continue anyway".
- **Motion.** Each word gets a check in sequence (40 ms stagger) once the box confirms. Under reduced motion the
  checks appear at once.

### S5 · Approve on the box page
- **App:** "Waiting for you to tap Approve on the box page…" plus a spinner. **Cancel** is shown.
- **Box page:** the same 4 words and one button, **Approve this Mac**.
- **Timeout.** If nothing happens for 2 minutes, the app shows: "The box didn't answer. Start again from the box
  page."

### S6 · Choose the box password
```
Choose a password for your box
It unlocks the box after a power cut.

[ ••••••••••••          ]
[ ••••••••••••          ]  repeat

BitSov keeps it on this Mac behind Touch ID and sends it only to your box.
Write it down somewhere safe; it is different from your 24-word recovery phrase.

[ Save with Touch ID ]
```
- **Input.** Typed once. The renderer clears the field the moment it is submitted, the same rule as today's restore
  phrase and unlock fields.
- **Touch ID.** The sheet appears inline (a pattern from the inspiration doc, 1.3).

### S7 · Touch ID approvals (moved here from the + New spend bar)
- **Title:** "Approve payments with Touch ID".
- **Body:** one line on what a tap allows, using the existing envelope wording: "up to N a day per contact, at most M
  per message".
- **Actions:** **Set up Touch ID approvals** / **Not now**.
- **If skipped.** A reminder card later appears on Welcome home, and the same control lives in Settings → Node.

### S8 · Before you add sats (exists today)
- The G6 trust disclosure is unchanged: remote trust wording, plus "I understand — continue to funding".

### S9 · After a power cut
```
Your box restarted
It can't read your keys until you unlock it from this Mac.

[ Unlock with Touch ID ]

Type the password instead
```
- **Default.** One button, and only when a password is remembered on this device.
- **No remembered password.** The typed field is the default and Touch ID is not offered (papercut b).
- **Lost device vs lost box.** The footer separates them:
  - "Lost this Mac? Approve a new device from another owner device or at the box."
  - "Lost the box? You'll need SSH and your 24 words. Recovery guide ↗"

### S10 · Box page after setup (status only)
- It shows: Online / Locked / Updating, the last unlock time, and the number of approved owner devices.
- It has no buttons that change anything. Adding a device happens from an owner device (Settings → Node → Devices).

## Copy rules for these screens
- **Payments.** "Your box" is the owner's own node. Hosted or custody wording appears only when it applies.
- **No unproven claims.** No "secure", "private" or "connected" unless the app knows it. For example, "Paired with
  your box" appears only after the box confirms.
- **Unknown stays unknown.** If last-seen is not known, it is not shown.
- **Lost device vs lost box.** The two are never phrased the same way.

## Small UI PRs (app side, after the node PRs land)

| # | PR | Depends on | Files |
|---|---|---|---|
| 1 | Touch ID approvals in onboarding (S7) and Settings → Node | none | `Onboarding.tsx`, `Shell.tsx` (`NodePanel`, `DeviceSetup`) |
| 2 | Lock screen: typed password default until remembered (S9) | none | `LockedNode.tsx` |
| 3 | Settings tabs and node pill read as clickable | none | `styles.css`, `Shell.tsx` |
| 4 | Advanced label → "A BitSov box at home" + S2 "Find your box" screen (link only) | node: endpoints/mDNS | `Onboarding.tsx` |
| 5 | `PairWords` component + S4 compare screen | node: 4 words + claim code | `src/onboarding/PairWords.tsx` |
| 6 | S5 approve-wait state with timeout | node: box page | `Onboarding.tsx` |
| 7 | S6 choose-password screen | node: `--home` password flow | `Onboarding.tsx`, host command |
| 8 | Remove remote first-run block in `onboardingSteps()` | node PRs 1–4 | `pairing.ts` + tests |
| 9 | Lost device / lost box footer copy on the lock and settings screens | none | `LockedNode.tsx`, `Shell.tsx` |

PRs 1–3 and 9 need no node change and can ship now. The rest wait for the node work, in its order.
