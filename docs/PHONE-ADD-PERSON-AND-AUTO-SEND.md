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
   - Not published: one line saying a card must be published before it can be shared, and a single action for that. Publishing costs nothing to read about; any cost stays on the button that pays it.
2. **Invite** tells the truth about its state. Each state gets a next step, never a bare "Approve first":
   - Approved: the action, with its price.
   - Waiting: what is being waited for.
   - Approval possible on this phone: the action that approves.
   - Approval not possible on this phone: why, and the steps at the box, using the same steps and who-to-ask line as the approval card in #426.
3. **Accept invite** does the same. Pasting or scanning a link should work before any approval, and the sheet says what it will cost before asking.

### What must not change

The node decides. The phone may not create or accept a paid invite without an approval the node accepts. This spec changes what the phone says and offers, not what is allowed.

### Decisions needed

- Should a phone with approvals off be able to approve invites at all, or only ever point to the box? That is a device-approvals decision, and depends on the in-app approval sketch in #394.
- Can a card be shared before it is published, for example as a plain contact link that isn't public? If not, the first step of adding someone is publishing, and that must be said plainly.

## 2. Sending by itself after approval

### What happens today

The person presses Send, approves, and in some paths has to press Send again. #419 says so for a chosen file ("Approved. Press Send to send it."). On a phone the message can also stop with a note that the amount changed.

### What it should do

One press means one send. After the approval the message goes without a second press, but only when all of these hold:

| Check | If it fails |
|---|---|
| The approval is for this press, and bound to what the node returned for it | Nothing is sent. Say so and ask again |
| The text and the recipient are unchanged | Nothing is sent. The text stays in the box |
| The all-in amount is at most what the person saw when pressing | Nothing is sent. Show the new amount and wait for a press |
| The budget still covers it, at the price it was approved at | Nothing is sent. Say what is short |
| The approval has not lapsed, and the press has not been cancelled | Nothing is sent. Say it lapsed |
| No earlier send has an unknown result | Nothing is sent. Point to the pending check |

### Rules for the reviewer

- It uses the same send path and the same operation id as a pressed send, so a retry can never pay twice.
- It fires at most once for each press, and survives neither a restart nor a change of contact.
- If the amount fell, it still sends, at the lower amount.
- A file or voice note follows the same rules. Holding a file in memory across a long approval is a separate question.
- The message shows as waiting in its own bubble until it has gone.

### Why the amount moves

Traced by reading the code; nothing was run. The composer has two ways of computing the amount, and approval can switch between them. The contact's price and the fee do not drift, and the approval paths do not read the price again.

- **Plain:** the message price plus the routing ceiling.
- **Door:** the signed total, which includes admission.

`doorWanted` picks one from the budget's state, and approving changes that state. So the amount on Send can change with no change in price:

| Case | Before | After | Direction |
|---|---|---|---|
| Returning contact, no budget row | Plain | Door | Up, by the admission |
| No outgoing message in the thread, but a budget row exists | Door | Plain | Down |
| A door quote expires during a slow approval | Door | None | Stops the send |

A true first contact does not move. A note after a press can also appear with no amount moving, if the composer's mode changed during the wait. A price really can change while waiting, but that is the rarer case. Nothing here depends on the phone: the same applies on a Mac with Touch ID.

### What this means for the checks

The "at most what the person saw" check passes when the amount goes down and when only the mode changed, but still stops the first case. That case needs a decision before automatic send can work for it: either the person sees the higher amount before approving, or it stops and asks. What the person saw is also loose, because the button shows no amount on some paths.

Where a fix would sit: the choice of formula, not the checks. That goes to the money review.

### Not known from the code

- Whether the node charges admission to a peer it has already admitted.
- How long a door quote lasts.
- The order the composer's effects run in within one pass.

Logging the amount, the formula choice, the budget state, the mode and which sentence fired, at the press and at each stop, would settle these.

### Not part of this

No change to prices, budgets or the node's approval. The in-app approval itself is in #394.
