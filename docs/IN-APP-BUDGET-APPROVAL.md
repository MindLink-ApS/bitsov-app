# In-app daily budget approval for a single-owner box (design)

Status: **design, docs only.** Nothing here is built. The owner decided
**yes**: on a box with one owner and no second owner device, the daily budget
(the node's spend grant) is approved inside the app, replacing "run
`konsensus grant` on the node's computer". This document says how, and what
the node (a separate repository) must add. It needs review from two
independent reviewers before any code lands. Hardened after an independent
review (round 1). The owner has since accepted the self-approval limits and
decided that a lost phone can be revoked without a terminal (section 10).

**This cannot work on a box whose seed password comes from a file or a flag.**
Section 5.1 requires device approvals to be on, and the node turns them off on
such a box. Reported, node-side, to confirm: both real boxes are such boxes. See
section 5.1 and the node-repository requirement in section 6.

## 1. Current flow

1. The app has a paired token with `read + receive`. To pay, it asks for
   `spend`: `POST /pair/elevation-request` (`act.rs`, `ElevationReply`).
2. The node replies with an `op_id`, an expiry and `owner_action`, normally
   `konsensus grant --op <id>`. The app appends `--config <path>` when it
   knows the node's config (`into_elevation`) and shows the command verbatim.
3. `SpendBar` in `src/control/Shell.tsx` renders the pending state:
   "Confirm at your node.", the command in `<code data-owner-action>`, and
   "This app cannot approve it for you. The request lapses in N min."
   (`uiConfirmAtYourNode`, `uiYourNodeAsksItsOwnerToApproveThis`,
   `uiThisAppCannotApproveItForYouThe` in `src/appCopy.ts`).
4. On the node's computer the owner opens a terminal, runs the command, reads
   the terms and types the short code the node's terminal shows. The node
   writes a G1 grant (`grant.rs`): total budget, per-call maximum, optional
   per-recipient budgets, absolute expiry of at most 24 h.
5. `GET /pair/grant` is the source of truth; the app reads it and bounds its
   own approvals by it.

A second path already exists: **owner approval v1** (`owner_approval.rs`).
A *different* enrolled owner device lists pending requests
(`/pair/approvals/pending?approver_key_id=…`), shows the node's exact
`approval_message`, and signs it with its biometric device key. Request kinds
include `spend_grant {budget_msat, per_call_max_msat, window_secs,
recipient}`. The host refuses when the approver's pairing is the requester's
(`approval_self`), and the pending list leaves out the device's own requests.
`TouchIdFirst` in `Shell.tsx` offers this path when it can be set up.

The first owner device key itself is enrolled at identity creation
(`local_owner.rs`, Touch ID on the app-run node) or by a phone's first claim
(`docs/SECOND_DEVICE_JOIN.md`). Later devices need word comparison and
approval by an existing owner device.

## 2. Why this blocks a first-time user

- It needs a terminal, a command with a quoted path, and a code read from a
  second screen. Many owners have never opened a terminal.
- The "node's computer" may be a box with no screen, or a computer in another
  room. Every day the budget ends, the owner has to go there again.
- Owner approval v1 does not help: a single-owner box has exactly one owner
  device, and that device is the one asking. `approval_self` refuses it, by
  design.
- The result is an app that can receive but quietly stops paying, with an
  instruction the owner cannot follow.

## 3. Security requirements

Any design must keep these:

- **R1. The requesting app must not approve its own request.** The paired
  token (a bearer secret the host holds) and the renderer must never be able
  to produce an approval alone. Malware that steals the token, or script in
  the window, must get nothing more than a pending request.
- **R2. Bind to exact terms.** The approval covers the node's own
  `approval_message` for this `op_id`: amounts, per-call cap, window,
  recipient, client, expiry. The host re-reads it before signing and refuses
  any change (`approval_changed`), as v1 does.
- **R3. No replay.** One signature approves one operation once, before its
  expiry, under the current pairing epoch and key. A captured signature is
  useless for any other op, client or time.
- **R4. Lost or stolen device.** A thief with the unlocked phone must not be
  able to approve; a lost device must be revocable without it; the damage
  before revocation is capped.
- **R5. Never above the node's own bounds.** The node's debit stays the hard
  bound; the grant still expires within 24 h.

## 4. Options

### A. Owner device key signs the exact terms from the app

The app's own enrolled owner device key (Secure Enclave on Mac and iPhone,
hardware-backed keystore on Android, created with `Policy::Biometry`,
device-only, invalidated when biometrics change) signs the node's approval
message after a Touch ID / Face ID / fingerprint prompt.

- R1: the token cannot sign; the key signs nothing without the owner's
  finger or face. The separation is **token vs. biometric key**, not
  device A vs. device B. The prompt text is built by the host from the
  node's terms, never by the renderer.
- **Honest limit of R1.** On one device the paired token and the biometric
  key are used by the **same process**: whatever calls `bitsov_dk_sign` is
  the host. A compromised host, or a renderer bug that reaches a host
  command, can both request a grant and raise the prompt. What protects the
  owner then is only that the prompt shows, and the key signs, the node's
  own `approval_message` bytes (section 5.2), plus the node-side ceiling,
  rate limit and cooldown (section 5.3). This is weaker than device A vs.
  device B, and the design accepts it only for a single-owner box under
  those bounds.
- R2, R3: same message binding, op id, epoch and one-use rule as v1.
- R4: biometric-only policy (no passcode fallback) means an unlocked phone is
  not enough. On Apple this holds today: the key uses `.biometryCurrentSet`
  (`src-tauri/native/device_key.swift`), which has no passcode fallback. On
  **Android** a keystore key with user authentication typically also
  accepts the device PIN unless restricted, so the key must be created for
  **`BIOMETRIC_STRONG` only, with no device-credential (PIN, pattern,
  password) fallback**. A device without strong biometrics gets no self
  grant; it keeps the console path. Revocation is needed from somewhere
  else (section 5.5).
- Precedent: relation envelopes (`device.rs`, `Intent`) are already signed
  by the same device that then pays under them.

### B. The app on the owner's primary device acts as the owner device

Treat the primary device's app as "the other device" and lift `approval_self`
when the box has one owner. Same mechanics as A, but phrased as an exception
to the self rule. **Rejected as stated:** lifting `approval_self` in general
lets any pairing with an enrolled key approve itself, for every request
kind. A must be a separate, narrow request kind, not a weakened v1.

### C. Node-displayed short code confirmed in the app

The node shows a code; the owner types or confirms it in the app.

- Only works where the node has a screen the owner can see, which is the
  very thing that blocks the owner today.
- A code proves presence at the node, not that the owner read the terms;
  R2 still needs a signature over the terms.
- Kept only as the fallback for nodes without the new capability (today's
  flow).

## 5. Recommended design

**Option A as a new, narrow request kind: "owner-present self grant".**

### 5.1 When it is offered

All of these, checked by the node, not only the app:

- The node advertises a new capability, for example
  `owner_present_spend_grant_v1`.
- The box has **exactly one** enrolled, non-revoked owner device key, and it
  belongs to the requesting pairing. With two or more owner devices, v1
  approval by another device stays the only in-app path.
- Device approvals are enabled (`device_approvals == "enabled"`; the
  `NODE_OFF_REASONS` still apply).
- The request kind is `spend_grant` only. Breaker reset, first contact and
  device enrollment are out of scope.
- The terms fit an **owner ceiling** written once at setup (default: the
  app's `DEFAULT_BUDGET_MSAT`, 200 sats a day, with the node's 6-sat cap per
  message). Anything above it falls back to the node's computer. This
  ceiling is owner-confirmed (section 10).
- **Cooldown after a key change.** Self grants are disabled for **3 days**
  after any owner key change on the box: a new enrolment, a re-enrolment of
  the phone, a key invalidated by a biometric change, a restore from the
  recovery phrase, or the revocation of a lost device (section 5.5). A thief
  who re-enrols cannot self-grant at once. The cooldown is owner-accepted
  (section 10); the owner set it to 3 days.
- The key is biometric-strong (section 4, R4). On Android without
  `BIOMETRIC_STRONG`, no self grant.

Eligibility is **re-evaluated by the node at approve time**, never cached
from request time (section 5.3).

**Boxes that cannot qualify today.** The node turns device approvals off when the seed's password came from a file
or a flag: `owner_approval_key` returns `seed_password_not_typed`
(`crates/konsensus-node/src/main.rs:1087-1107`,
`crates/konsensus-api/src/pairing/device.rs:28-30`, node commit `b3f1ad1`). They
are on only with a typed password, or a descriptor or remote unlock together
with `--local-owner-device`, and only with an encrypted seed. Every device route
then refuses (`device_authority`, `pairing/device.rs:1536-1542`). Reported,
node-side, to confirm: both real boxes take the password from a file or flag.
The field test of 1 November approved at the node's console, which fits, but its
record does not name the password source. On such a box the owner has no
enrolled device key either: `POST /pair/device-key` is refused
(`pairing/device.rs:522`). So in-app approval is not offered there, and
`konsensus grant` at the node's computer stays the only path. The capability alone
does not change this; see the device approval policy in section 6.

### 5.2 Message and signature

The node builds a domain-separated message, for example:

```
bitsov-owner-present-grant-v1
kind:spend_grant
message_version:1
node:<fingerprint>
client:<client_id>
device:<key_id>
epoch:<pairing epoch>
op:<op_id>
budget_msat:<n>
per_call_max_msat:<n>
window_secs:<n>
recipient:<node id or "-">
expires_at:<unix s>
nonce:<node nonce>
```

The host fetches it from a requester-readable route, checks it field by
field against what the app asked for, builds the biometric prompt text from
those fields ("approve paying up to 200 sats today, at most 6 per
message"), signs, re-checks the pairing after the prompt (as `approve()`
already does), and posts the signature. The domain differs from v1's, so a
self signature can never be replayed as a v1 approval or the reverse.

**Shown bytes = signed bytes.** The node's `approval_message` bytes are
exactly what is shown and exactly what is signed:

- The prompt is rendered by the host **only from the node's reply**, never
  from the app's own request and never from the renderer. The prompt names
  the request kind and the amount the node stored.
- The key signs the `approval_message` bytes as returned, not a
  re-serialisation of fields the host echoes back. Before signing, the host
  re-reads the message and compares bytes, as `checked_approval` in
  `owner_approval.rs` does for v1 today (`approval_changed` on any
  difference, with no prompt).
- The node verifies the signature against the bytes it stored for this
  `op_id`, not against fields in the approve request.
- `recipient:"-"` means no single named recipient. The owner ceiling bounds
  `budget_msat`, `per_call_max_msat` **and** the sum of any per-recipient
  budgets, so a `"-"` grant can never exceed the ceiling.

### 5.3 What the node enforces

- Signature by the registered key of the requesting pairing, current epoch,
  over the stored `approval_message` bytes (section 5.2).
- `op_id` pending, unexpired (at most 10 min), one use; nonce matches.
- **Single owner re-checked at approve time.** The node evaluates "exactly
  one enrolled, non-revoked owner key, and it is this pairing's" again when
  the signature arrives. A second device enrolled between request and
  approve refuses with `approval_not_single_owner`.
- **Cooldown.** No owner key change on the box in the last 3 days
  (section 5.1); otherwise `approval_key_cooldown`.
- Terms equal the stored request and fit the owner ceiling (budget,
  per-call maximum and the sum of per-recipient budgets).
- Grant written exactly as the console path writes it; expiry at most 24 h
  (owner-confirmed; section 10).
- **Rate limit:** at most **1 live** self-granted grant at a time and at most
  **3 self grants per 24 h** (`approval_rate_limited`). These numbers are the
  review's proposal, accepted by the owner (section 10).
- Each self grant appears in the node's log **and in the app's own audit
  view**, which the owner can read without the node's computer.

### 5.4 Flow in the app

`SpendBar` pending state: if the node has the capability and the conditions
hold, show the terms and one button, "Approve with Face ID". The console
command moves under "Other ways", as `TouchIdFirst` already does for v1.

### 5.5 Lost device

- Grant lifetime of at most 24 h (section 10) and the owner ceiling cap the
  damage.
- Biometry-only key: a thief needs the owner's face or finger.
- The cooldown after a key change (section 5.1) stops a thief who re-enrols
  from self-granting at once.
- Revocation without the device, today: at the node's computer (existing
  console), or by restoring the identity from the recovery phrase onto a new
  device, which enrolls a new key and revokes the old one. **For the target
  owner neither is realistic within a day.**
- **Decided by the owner (section 10): a lost phone can be revoked without
  a terminal**, from another owner device or from the box's own app (for
  example the Mac app on the box's computer). Design sketch: the owner opens
  Devices, picks the lost phone and taps "This phone is lost"; the request
  is confirmed with Touch ID / Face ID on another owner device, or in the
  box's own app with the box's local owner authority. The node revokes the
  phone's pairing tokens and owner device key at once, ends every grant
  issued to that pairing, including a live self grant, and records an owner
  key change, so the cooldown (section 5.1) starts. On a single-owner box
  the box's own app is the path, because there is no other owner device.
  The full sketch is in `docs/DEVICES-AND-PEOPLE.md` (section 4.4, D7). The
  node API it needs is a node-repository requirement (section 6). On a box
  whose seed password comes from a file or a flag this does not work: neither
  path has an owner key to rely on (section 5.1).
- Adding a second owner device later turns self grants off automatically;
  approvals then go device to device (v1).

## 6. Node API needs (node repository)

| Need | Shape |
|---|---|
| Capability | `/status.api_capabilities` gains `owner_present_spend_grant_v1` |
| Eligibility | `GET /pair/device-keys` reports the owner key count and whether this pairing's key is the only one |
| Owner ceiling | stored at owner setup; changed only at the console or by a v1 approval |
| Request message | `GET /pair/approval/{op_id}` returns the self-grant `approval_message` to the requester |
| Approve | `POST /pair/approval/{op_id}/approve-self {approver_key_id, signature}` |
| Cooldown | the node records the time of the last owner key change and refuses self grants within 3 days of it |
| Audit | self grants are listed to the requester (time, terms, expiry) so the app can show them |
| Refusals | `approval_not_single_owner`, `approval_over_ceiling`, `approval_expired`, `approval_changed`, `approval_rate_limited`, `approval_key_cooldown` |
| Device approval policy (node-repository requirement; does not exist) | a supported way for a box whose seed password comes from a file or a flag to have device approvals: either a start that uses neither, or a policy that turns approvals on for it. The node's reason for the gate is that a same-user program could read that password, so this needs its own security review. Without it, this whole design and the lost-phone revoke stay off on such a box |
| Revoke a lost device (node-repository requirement) | a revoke route that accepts either a signature by another enrolled, non-revoked owner device key over a domain-separated revoke message (target device, op id, nonce, expiry), or the box's local owner authority from the box's own app; it revokes the target's tokens and device key, ends its grants, records an owner key change, and refuses revoking the requesting device itself through this route |

The app keeps today's flow for any node without the capability, and for any box
with device approvals off.

## 7. UI copy (draft)

| Key | Dansk | English |
|---|---|---|
| Title | Godkend dagens beløb | Approve today's amount |
| Body | Appen må betale op til {budget} i dag, højst {cap} pr. besked. | The app may pay up to {budget} today, at most {cap} per message. |
| Button (phone) | Godkend med Face ID | Approve with Face ID |
| Button (Mac) | Godkend med Touch ID | Approve with Touch ID |
| Prompt | godkend op til {budget} i dag, højst {cap} pr. besked | approve paying up to {budget} today, at most {cap} per message |
| Done | Godkendt. Gælder til {time}. | Approved. Valid until {time}. |
| Over ceiling | Beløbet er over din grænse. Godkend det på nodens computer. | This is above your limit. Approve it on the node's computer. |
| Second device | Du har to enheder nu. Godkend på den anden. | You now have two devices. Approve on the other one. |
| Cooldown | Du har lige skiftet enhed. Godkend på nodens computer indtil {date}. | You recently changed devices. Approve on the node's computer until {date}. |
| Rate limited | Du har godkendt nok for i dag. Godkend på nodens computer. | You have approved enough for today. Approve on the node's computer. |

Plain words only: no "grant", "token" or "op id" on screen. Android uses the
platform's own biometric word, as `TouchIdFirst` does.

## 8. Phases

| Phase | Scope | Depends on |
|---|---|---|
| P0 | This document, two reviews | — |
| P1 | Node: capability, eligibility, owner ceiling, message, approve-self route, refusals | Node release |
| P2 | App host: an owner-present approve command, message checks, prompt text, pairing re-check | P1 |
| P3 | App UI: `SpendBar` one-button approval; console command under "Other ways" | P2 |
| P4 | Ceiling setting in onboarding, in plain words | P3 |

## 9. Tests

- Host: refuses a changed message, another client's op, an expired op, a
  pairing change during the prompt, a v1-domain message, and terms above the
  ceiling; never prompts before the checks pass.
- Host: the renderer cannot supply the prompt text or the message.
- Host: a message mutated between fetch and sign → `approval_changed`, no
  prompt; the prompt text equals the node's message fields, byte for byte.
- Node contract fixtures: second owner device present → refused; a second
  key enrolled **between request and approve** → `approval_not_single_owner`;
  revoked key → refused; key re-enrolled less than 3 days ago →
  `approval_key_cooldown`; replayed signature → refused; same signature on
  another op → refused; a second live self grant → refused; the fourth self
  grant in 24 h → `approval_rate_limited`; a `"-"` grant whose per-recipient
  sum exceeds the ceiling → `approval_over_ceiling`; a lost device revoked
  from another owner device or the box's own app → its tokens refused, its
  grants ended, and the cooldown started.
- Android: a key that accepts device credentials is refused for self grants;
  a device without `BIOMETRIC_STRONG` is not offered the button.
- UI: button shown only with the capability and a single owner; console
  command still reachable under "Other ways"; Danish and English copy.
- Two-node runs on regtest only; no real funds.

## 10. Owner decisions

Hardening review round 1 left these to the owner. Both are now decided.

1. **Self-approval limits: decided by the owner, accepted as proposed.**
   At most **1 live** self grant and **3 self grants per 24 h**
   (`approval_rate_limited`). No self approval for **3 days** after any
   owner key change (`approval_key_cooldown`). The owner ceiling is the
   app's `DEFAULT_BUDGET_MSAT`, 200 sats a day, with the node's 6-sat cap
   per message (owner-confirmed). The self-grant lifetime is at most
   24 h, as the console path writes it (owner-confirmed). The owner set the cooldown to 3 days.
2. **Lost phone without a terminal: decided by the owner, yes.** A lost
   phone can be revoked from another owner device or from the box's own
   app (for example the Mac app on the box's computer), with no terminal
   (section 5.5; sketch in `docs/DEVICES-AND-PEOPLE.md` section 4.4). The
   node API and a device approval policy are node-repository requirements
   (section 6); today neither path works on a box whose seed password comes
   from a file or a flag. Revocation by a
   second person, such as a box host, is not part of this decision.
