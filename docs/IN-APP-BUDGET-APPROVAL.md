# In-app daily budget approval for a single-owner box (design)

Status: **design, docs only.** Nothing here is built. The owner decided
**yes**: on a box with one owner and no second owner device, the daily budget
(the node's spend grant) is approved inside the app, replacing "run
`konsensus grant` on the node's computer". This document says how, and what
the node (a separate repository) must add. It needs review from two
independent reviewers before any code lands.

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

## 2. Why this blocks a 70-year-old

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
- R2, R3: same message binding, op id, epoch and one-use rule as v1.
- R4: biometric-only policy (no passcode fallback) means an unlocked phone is
  not enough. Revocation is needed from somewhere else (section 5.5).
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
  message). Anything above it falls back to the node's computer.

### 5.2 Message and signature

The node builds a domain-separated message, for example:

```
bitsov-owner-present-grant-v1
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

### 5.3 What the node enforces

- Signature by the registered key of the requesting pairing, current epoch.
- `op_id` pending, unexpired (at most 10 min), one use; nonce matches.
- Terms equal the stored request and fit the owner ceiling.
- Grant written exactly as the console path writes it; expiry at most 24 h.
- Rate limit: a few self grants per day; each one appears in the node's log.

### 5.4 Flow in the app

`SpendBar` pending state: if the node has the capability and the conditions
hold, show the terms and one button, "Approve with Face ID". The console
command moves under "Other ways", as `TouchIdFirst` already does for v1.

### 5.5 Lost device

- Grant lifetime of at most 24 h and the owner ceiling cap the damage.
- Biometry-only key: a thief needs the owner's face or finger.
- Revocation without the device: at the node's computer (existing console),
  or by restoring the identity from the recovery phrase onto a new device,
  which enrolls a new key and revokes the old one.
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
| Refusals | `approval_not_single_owner`, `approval_over_ceiling`, `approval_expired`, `approval_changed`, `approval_rate_limited` |

The app keeps today's flow for any node without the capability.

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
- Node contract fixtures: second owner device present → refused; revoked
  key → refused; replayed signature → refused; same signature on another op
  → refused; rate limit.
- UI: button shown only with the capability and a single owner; console
  command still reachable under "Other ways"; Danish and English copy.
- Two-node runs on regtest only; no real funds.
