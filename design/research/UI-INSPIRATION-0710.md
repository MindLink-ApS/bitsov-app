# UI inspiration pass (2026-10-07)

Goal: a surgically clean BitSov app that is lean, modern and robust. This pass collects concrete patterns that
make our interactions simpler. Each one says what to take, where it goes in the app, and why.

## Sources

Read-only, with no sign-ups. Proprietary apps are studied for **patterns only**; no assets or code are copied.

| Source | What it gave tonight |
|---|---|
| 60fps.design | Shot pages for setup, permissions, success, offline and morph patterns. The free tier shows a few shots per filter, and each has a written description. |
| brandguidelines.net → Duolingo design blog ("Elevating craft: how we refreshed our core tabs") | How to make tabs consistent and clear. |
| land-book.com | Mostly marketing sites. Only the "one headline, one action" rhythm applies, already used in Welcome. |
| mobbin.com | Library is behind sign-up, so nothing was collected. |
| inspora.design | Image-only grid with no readable detail, so nothing was collected. |

Some findings are marked *(known pattern)*. These are well-documented public behaviours (Apple pairing sheets,
Signal device linking, Bluetooth numeric comparison). I did not browse them tonight; I include them because they
fit the brief.

---

## 1. Onboarding and pairing

### 1.1 One hardware visual that matches what's in your hand
- **Source:** Oura "Ring Connect Charger".
- **Pattern:** during pairing, a central picture of the device crossfades between hardware generations, so the user
  can confirm *this is my thing*.
- **Take:** one simple line illustration of the box (Pi-style case with its sticker) at the top of the pairing
  stage. If more than one box model exists, crossfade between them.
- **Where:** `Onboarding.tsx` remote stage header (`.ob-head` for a remote target). The SVG stays inline, with no
  image host.
- **Why:** "plug in the box" becomes something you can see, which cuts down on "which device?" doubts.

### 1.2 Connected = one calm pulse, then text, then one button
- **Source:** Grok "App Connected Pulse".
- **Pattern:** on success, the integration's icon gets a single pulse glow. Confirmation text and one dark button
  then stagger in.
- **Take:** when pairing completes, show the box icon with **one** ember pulse (not a loop). Then "Paired with your
  box" and a single **Continue** button.
- **Where:** `Onboarding.tsx` paired panel (`[data-pairing="paired"]`), replacing the current static hero.
- **Why:** the state change gets acknowledged without ambient motion, matching our purposeful-motion rule.
  Under reduced motion it is a fade only.

### 1.3 Biometric step inline in the flow, never a detour
- **Source:** Sabbath "Screen Time permission"; Face ID runs inline during onboarding.
- **Pattern:** the permission or biometric prompt is one step in the sequence. The copy is set up first, the
  system sheet appears, and the flow continues.
- **Take:** "Set up Touch ID approvals" becomes a named onboarding step right after pairing, with the system Touch ID
  sheet appearing in place. Today it is hidden in the + New spend bar.
- **Where:** `Onboarding.tsx` (after `paired`), Settings → Node (`NodePanel` in `Shell.tsx`), and `DeviceSetup`
  stays as the fallback.
- **Why:** Touch ID is how BitSov approves payments per contact, so it belongs in setup, not buried in a spend menu.
  This is papercut (a).

### 1.4 Compare short words on two screens *(known pattern: Bluetooth numeric comparison, Signal safety numbers)*
- **Pattern:** both devices show the same short string. The user confirms they match, and that confirmation is the
  security step.
- **Take:** 4 words, large, in a 2×2 grid, with the same order and the same font weight as the box page shows. One
  question: "Do these match the box?" with **They match** / **They don't match**.
- **Where:** a new `PairWords` component in `src/onboarding/`, used by the remote pairing stage.
- **Why:** this replaces fingerprints and hex. Words are fast to compare out loud and hard to misread.

### 1.5 Scan first, paste second *(known pattern: WhatsApp and Signal "link a device")*
- **Pattern:** the camera is the default. "Paste a link instead" is a small text action below it.
- **Take:**
  - On Android, the QR scan is primary.
  - On Mac, the primary is "Open bitsov.local on this Mac"; the box page carries the link.
  - Paste stays as the fallback.
- **Where:** `Onboarding.tsx` remote form (`[data-remote-access]`). Today the form starts with a password field for
  the link.
- **Why:** pasting a long `bitsov://pair/…` is the slowest step in the real Mac→Pi test.

## 2. Chat and messaging shell

### 2.1 Tabs: consistent headers, whitespace instead of boxes
- **Source:** Duolingo core-tabs refresh.
- **Pattern:** every tab header uses the same position and type scale, with tiered sizes by purpose. Spacing comes
  from whitespace instead of extra containers.
- **Take:**
  - Settings tabs get one header style and a visible active underline.
  - Hover and focus states make clear they are clickable.
  - Fewer bordered panels inside Settings.
- **Where:** `.tabs` and `.settings-head` in `styles.css`; `ControlCenter` settings markup in `Shell.tsx`.
- **Why:** Rasmus found the Settings tabs not obviously clickable. This is papercut (c).

### 2.2 A status pill that is visibly a button
- **Source:** Circle "Menu Dropdown Morph". The pill morphs into the panel it opens.
- **Take:**
  - The "Node running" pill gets a chevron, a hover lift in border/colour (no movement), and `cursor: pointer`.
  - Opening Settings scales from the pill. Under reduced motion it is a fade.
- **Where:** `.node-pill` in `styles.css`; `Rail` in `Shell.tsx`.
- **Why:** a status that is also an entry point needs one affordance cue. This is papercut (c).

## 3. Calls and video
- **Source:** CRED "Swipe to Pay" success state.
- **Pattern:** commit to money with a deliberate gesture. Success is a single drawn checkmark plus a glow, echoed in a
  small persistent status pill.
- **Take (a smaller version for BitSov):**
  - No swipe gesture; Accept stays a button, because a desktop with a mouse makes swipes awkward.
  - Do take the **echo**: while a call is live, the rail shows a small "On call · 03:12" pill that returns to the
    call card.
- **Where:** `CallPanel` and `Rail` in `Shell.tsx`.
- **Why:** today the only place a live call exists is a floating card that can be covered.

## 4. Wallet and "Add sats"

### 4.1 Payment success: a drawn check, then the real amount
- **Source:** CRED success; Revolut "Number of Transactions" (rows expand and collapse with the selector).
- **Take:**
  - After Receive or Send settles, draw a checkmark once with the **actual** amount (not the ceiling) underneath.
  - In Activity, a filter change animates row height instead of jumping.
- **Where:** `WalletPage.tsx` receive/send completion states and the `.wallet-list`.
- **Why:** the moment money moves is the moment that most deserves motion. Showing the proven amount there keeps
  the doctrine.

### 4.2 Add sats as one bottom sheet that can grow
- **Source:** Recollect "Bottom Sheet to Page".
- **Pattern:** a compact sheet holds the one action, and expands into the full page if needed.
- **Take:** Welcome → "Add sats" opens a compact sheet with the QR and amount. "More options" expands it into the
  full Wallet receive tab.
- **Where:** `WelcomeHome.tsx` → `WalletPage.tsx` receive tab.
- **Why:** first funding is a single job; the full wallet page is a lot to land on.

## 5. Empty and offline states
- **Source:** Zomato offline mini-game. We take the principle, not the game.
- **Principle:** an offline or empty state is a designed screen, not an error string.
- **Take:**
  - "Your box is offline" shows the box illustration (1.1) greyed out.
  - It shows the last-seen time, if known, as "last seen …"; unknown stays unknown.
  - It has one action: "Retry now".
- **Where:** `SoftError` callers for node unreachable; `[data-remote-retry]` in `App.tsx`.
- **Why:** after a power cut this is the first screen people see.

## 6. Settings depth
- **Source:** Duolingo again: consistency is balanced with purpose.
- **Take:** Settings is three levels at most.
  - **Tabs:** Node, Wallet, Budget, Profile, Display.
  - **Sections inside a tab:** Touch ID approvals, Pairing, Unlock.
  - **Detail behind a disclosure.**
  - The current repeated "Display + Calls" block on every tab becomes its own **Display** tab.
- **Where:** `Shell.tsx` settings modal.
- **Why:** less scrolling, and every setting has one home.

## 7. Motion that conveys state

| State change | Motion | Reduced motion |
|---|---|---|
| Paired | One pulse on the box icon, then text in (1.2) | Fade |
| Words matched | Each word gets a check, staggered 40 ms | Instant checks |
| Money settled | A drawn check of about 320 ms, then the amount (4.1) | Static check |
| Pill → Settings | Scale from origin (2.2) | Fade |
| Node offline → back online | The greyed box regains colour | Instant |

Never loop, except the existing incoming-call ring, which is already turned off under reduced motion.

## Small UI PRs this suggests (in order)
1. Papercut (a): Touch ID setup in onboarding after pairing and in Settings → Node (1.3).
2. Papercut (b): the lock screen defaults to the typed password until a password is remembered.
3. Papercut (c): Settings tabs and the node pill look clickable (2.1, 2.2).
4. Settings: move Display + Calls into a Display tab (6).
5. Live call pill in the rail (3).
6. Wallet: settled check plus the actual amount (4.1).
7. Offline screen with the box illustration (5, 1.1).
8. Pairing visuals (1.1, 1.2, 1.4, 1.5). These land with the onboarding redesign; see `ONBOARDING-PAIRING-DESIGN-0710.md`.
