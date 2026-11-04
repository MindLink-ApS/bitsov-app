# Phone: adding a person, and sending after approval

Status: spec only. Nothing here is built. Both parts need a decision first: part 1 touches device approvals, and part 2 needs a money review.

## 1. Adding a second person from a phone

### What happens today

- "Share my card / QR" on the You page opens Settings at the front door. That is a profile form. The QR only appears once a card has been published, so someone who has not published sees no QR after pressing a button that promises one.
- Create invite and Accept invite both say "Approve first" until spending is approved. With biometric approvals off on the box, the phone has no way to approve, so the button leads nowhere.
- Today a phone user with approvals off cannot add a second person.

### What it should do

1. **Share my card** opens a sheet that leads with what was promised.
   - Card published: the QR and a copy button. Details and editing sit below.
   - Not published: one line saying a card must be published before it can be shared, and a single action for that. Publishing moves no sats, but `PUT /front-door` needs the `front_door` scope. A paired app without it asks the owner once and says what the owner must run; the sheet shows that step.
2. **Invite** tells the truth about its state. Each state gets a next step, never a bare "Approve first":
   - Approved: the action, with no amount. Creating and accepting an invite move no sats (`/invites`, `/invites/accept`), but both still need spending approved.
   - Waiting: what is being waited for.
   - Approval possible on this phone: the action that approves.
   - Approval not possible on this phone: why, and the steps at the box, using the same steps and who-to-ask line as the approval card in #426.
3. **Accept invite** does the same. Pasting or scanning a link should work before any approval. It charges nothing, so it shows no price.

### What must not change

The node decides. The phone may not create or accept an invite without the approval the host requires today. This spec changes what the phone says and offers, not what is allowed.

### Decisions needed

- Should a phone with approvals off be able to approve invites at all, or only ever point to the box? That is a device-approvals decision, and depends on the in-app approval sketch in #394.
- Can a card be shared before it is published, for example as a plain contact link that isn't public? If not, the first step of adding someone is publishing, and that must be said plainly.

## 2. Sending by itself after approval

### What happens today

The person presses Send, approves, and in some paths has to press Send again. #419 says so for a chosen file ("Approved. Press Send to send it."). On a phone the message can also stop with "the amount changed while it waited for approval", and has to be put back in the box.

### The one rule

One press means one send, but only if the amount was shown and has not gone up. When in doubt it stops. Nothing here widens what an approval covers.

### What is stored at the press

- The all-in amount as an integer in msat, and **whether a number was on screen**. Today the button shows no amount with autopay off ("Send") or on biometric approval, so those presses have nothing to hold it to. **No number shown means no automatic send.**
- The text, the recipient and the composer's mode.
- For a file or voice note: a hash of its bytes.

### One cap

There is one cap for the budget check and for `max_total_msat`: **min(msat at press, msat now)**. If the amount fell, it sends at the lower amount. It never sends above what was shown.

### When it stops

Each stop keeps its own reason, so the person is told what happened. Nothing is dispatched a second time.

| Stop | Reason shown |
|---|---|
| The amount now is above the amount at press | The amount changed; show the new one and wait for a press |
| The formula changed, the quote expired or a new quote arrived | The amount has to be checked again |
| The budget stand is `first`, the amount is above `first_contact_msat`, or the door quote is the cap | This first contact needs its own approval |
| The composer's mode changed, or the text or recipient changed | Cancelled; the draft is put back |
| The approval lapsed or was cancelled | It lapsed |
| An earlier send has an unknown result | Point to the pending check |
| `readmission_quoted`, `grant_readmission`, `price_changed` or `price_cap_exceeded` | Stop with that refusal's own words; no second dispatch |

**First contact fails closed.** A budget approval does not cover a true first contact, which is a separate owner approval. Today the continuation stops when the stand is `first`, and that stays. Note that `confirm_first_contact` succeeds without an approval when there is no re-admission quote, so the host does not stop this for us. Automatic send may follow only a contact approval for the same recipient and the same msat.

**Mode changes cancel.** Any change of composer mode cancels the press and restores the draft. A send continues only with the same mode, recipient and text. Pay never rides on this continuation.

### Exactly once

- **Messages** use the same send path and operation id as a pressed send.
- **Files and voice notes are not protected by an operation id.** File send has `operation: false`, because the node's file send takes no `operation_id`. The fence is the pending spend journal. So an unknown result stays blocked, a re-quote that comes back higher refuses before the paid POST, and the file is bound by its bytes hash. Holding a file in memory across a long approval is a separate question.
- It fires at most once for each press, and survives neither a restart nor a change of contact.

### Cases a test must cover

Each row states the amounts and the one result. A result is a single `max_total_msat`, or "no POST".

| Case | At press (msat) | After approval (msat) | Formula | Stand | Result |
|---|---|---|---|---|---|
| Plain send, nothing changes | 6,000 shown | 6,000 | plain → plain | `ok` | `max_total_msat` 6,000 |
| Amount falls | 106,000 shown | 6,000 | door → plain | `ok` | Formula changed: no POST, ask again |
| Amount rises, returning contact | 6,000 shown | 106,000 | plain → door | `first` | No POST |
| Button shows no amount | 6,000 not shown | 6,000 | plain → plain | `off` | No POST |
| True first contact | 106,000 shown | 106,000 | door → door | `first` | No POST until contact approval for the same recipient and msat |
| Above `first_contact_msat` | shown | above the limit | any | any | No POST |
| Mode changes during the wait | 6,000 shown | 6,000 | plain → plain | `ok` | No POST, draft restored |
| File re-quote higher | 8,000 shown | 9,000 | file | `ok` | No POST |
| Unknown journal across a restart | 6,000 shown | n/a | plain | any | No POST, still blocked after restart |
| Re-admission quote on the same press | 6,000 shown | quote 106,000 | plain | `ok` | First POST `max_total_msat` 6,000 refused; no second POST |

The amounts are examples. The second row stops by the formula rule even though the amount fell: a decision for the money review, which may prefer to let a fall through.

### Why the amount moves

Traced by reading the code; nothing was run. The composer has two ways of computing the amount, and approval can switch between them. The approval paths do not read the price again.

- **Plain:** the message price plus the routing ceiling.
- **Door:** the signed total, which includes admission.

`doorWanted` picks one from the budget's state, and approving changes that state. Flipping it fetches a new quote, so compare all-in totals rather than assuming the difference is the admission.

| Case | Before | After | Direction |
|---|---|---|---|
| Returning contact, no budget row | Plain | Door | Usually up |
| No outgoing message in the thread, but a budget row exists | Door | Plain | Usually down |
| A door quote expires during a slow approval | Door | None | Stops the send |

A true first contact does not move. A note after a press can also appear with no amount moving, if the composer's mode changed. A price really can change while waiting, but that looks like the rarer case. Nothing here depends on the phone: the same applies on a Mac with Touch ID.

Where a fix would sit: the choice of formula, not the checks. That goes to the money review.

### Not known from the code

- Whether the node charges admission to a peer it has already admitted.
- How long a door quote lasts.
- The order the composer's effects run in within one pass.

Logging the amount, the formula choice, the budget state, the mode and which sentence fired, at the press and at each stop, would settle these.

### Not part of this

No change to prices, budgets or the node's approval. The in-app approval itself is in #394.
