# AI assistants — v1 rules and order of work

Owner decision, 2026-10-07: this re-scopes [charter gate G4](CHARTER.md) (§9).
These are requirements for v1 AI, not a claim that the controls or paid paths are
implemented. The existing [control-center AI slice](CONTROL_CENTER_AI.md) remains
subject to these gates before shipping v1 paid AI.

## Rules

- **D1 — Named assistants, bounded execution.** Named assistants are allowed. They
  run only when the user invokes them or while the app is open; there is no
  unattended agent runtime. User-facing app and website copy says **"assistant",
  not "agent"**, and only claims abilities that have shipped.
- **D2 — 55 sats all-in per paid AI call.** The total includes the AI service price,
  any admission charge and routing or other fees. The ceiling is not just the
  principal and cannot be raised by an approval or a larger grant. A paid call
  whose all-in cost cannot be bounded to 55 sats must not proceed; off-app/API-key
  billing is not an exception.
- **D3 — Your node first.** v1 AI is a client of the user's own node through the
  app's broker. It does not become a room participant or acquire its own peer/
  `node_id`. AI as its own peer/node is later work under **M11/CS-14**.
- **D4 — Separate authority for paid AI.** Each paid AI has its own separate pairing
  and small spend grant. The user can revoke it without touching the owner's
  pairing or grant. It must never borrow the owner's spending authority.
- **D5 — Counts first, bodies by conversation.** v1 inbox access exposes counts
  only by default. An assistant may see message bodies only after the user turns
  access on for that conversation; enabling or naming an assistant grants no
  blanket inbox access. Remote disclosure still requires the existing explicit
  preview/send consent.
- **Drafts, then the user's send.** Assistants never send payments themselves.
  They produce drafts that the user sends through the existing budget and
  approval flow. A separate grant, open app or body-access opt-in is not permission
  for an assistant to send money.
- **Payee allowlist before payment.** A payee allowlist enforced on the **node
  grant** must land before **any AI pay path** exists. An app-only filter is not
  sufficient. The allowlist, small grant, 55-sat call ceiling and existing
  budget/approval are cumulative constraints.

## Boundary and order of work

The **node never talks to cloud AI; the app brokers** node reads and model calls.
The node remains the identity and payment authority. The app uses the public node
API and only discloses data within the user's chosen trust boundary; remote model
calls retain explicit consent and confidential transport. G1, G2 and the payment
gate remain in force.

1. Build the own-node client assistant path with bounded execution, counts-only
   inbox reads, per-conversation body opt-in and drafts through the user's composer.
2. Before any AI pay path, land separate paid-AI pairing and independently revocable
   small grants, including the **node-enforced payee allowlist**. Enforce the
   **55-sat all-in ceiling** alongside existing budgets and approval before enabling
   paid calls. Verify these controls rather than treating a static copy scan as proof.
3. Only later consider **M11**, AI as its own peer/`node_id`. v1 assistants do not
   depend on M11 and do not authorize an unattended runtime.

## A2 — read-only Mac shell

The sidebar offers **Node** (node, channels, prices), **Wallet** (balance,
payments, prices) and **Inbox** (inbox counts only). These fixed assistants
reuse Ask's GET broker and rules or the existing 127.0.0.1 model path. Rust
checks the assistant's topic before a read or model disclosure. They cannot
prepare drafts, send messages or payments, or open channels. The original
Ask track remains available.

Each assistant keeps up to 100 question/answer turns in the app config folder,
sealed with authenticated encryption through the app's `at_rest::Sealer`
interface. On Mac, a fresh AES data key for each saved file is wrapped through
the same Secure Enclave sealing bridge used for pairing identity storage. Each
file sealing creates a fresh enclave key; it does **not reuse the pairing key**.
The enclave key is `WhenUnlockedThisDeviceOnly`, non-exportable, and never
synced; its opaque representation travels with the ciphertext. This is **device-bound,
prompt-free protection**, covering stolen backups and copying the files to
another Mac, **not a Touch ID/biometry gate**. It does not bind the ciphertext
to BitSov's app identity: other processes running as the same user on the
original Mac can likely unwrap it without a prompt. The legacy login-Keychain
item had a per-app ACL; this sealing bridge does not preserve that boundary.
Binding access to the app requires a `keychain-access-groups` entitlement,
which is a signing change for Rasmus to decide.

If enclave sealing or verification is unavailable, the app logs it and keeps
the existing Keychain AES behavior.
That fallback is not Secure Enclave-backed; its login-Keychain copy can migrate.

On the first non-Forget thread access or watch-settings load per app launch,
under the host thread lock, existing transcripts and watch settings are
migrated independently. The process caches the sweep outcome: migration is
marked complete only after legacy keys are retired, and later requests skip
the sweep. An incomplete sweep is retried on the next app launch, at most
once per launch. Each replacement is written, synced, read back, decrypted
and compared with the original before atomic replacement.
All old Keychain keys remain until every file verifies and directory changes
are synced. A crash resumes from the mixed formats; corrupt/unreadable files
stay untouched and block key retirement, while healthy threads remain usable.
An already device-bound file that cannot be decrypted remains intact and
returns a retry error; it never becomes an empty thread. Migration failures
never abort application startup.

Only transcript text is saved, never broker objects, model request bodies or
credentials. Saved answers are marked historical; they are not fresh reads
and are not automatically included in model requests. **Forget** clears that
assistant's transcript and invalidates saves still in flight. It leaves an
empty sealed generation record so late responses cannot restore forgotten
content. This is logical deletion, not a promise to erase filesystem backups.

Thread operations use the existing guarded `ai_read` command. No command,
capability or network destination is added; the sealed development assistant
window still has no IPC grants. Named assistants keep remote models disabled
pending the paid-AI gates above. A2 does not add paid calls, watches, a tool
loop, body access, or an unattended runtime.

## A3 — invoked Own-model read loop

With a running, selected Own model, named assistants send the owner's question
through `ai_read`'s `local_turn` operation. Rust supplies JSON-schema function tools
with exactly the assistant's A2 topics and rechecks that allowlist before every
broker call. It accepts at most three topic reads per invocation (including a
batch), then allows only a final answer. This counts broker topic reads, not the
internal GETs needed to project a topic. Tool arguments cannot select a URL or
route; only payments accepts an optional integer `since_ms`.

The model transport uses the existing host-resolved Ollama/llama.cpp choice at
`127.0.0.1`, without proxies or redirects. Responses are bounded to 256 KiB and
each completion has a 60-second timeout; there are at most four completions.
This path connects to an already running server and launches no process. The
existing `model_launch` sandbox remains the boundary for host-launched models.
Remote models remain disabled for named assistants. The original Ask track and
its explicit disclosure/send flow are unchanged; Own assistant turns run on the
owner's Ask tap, without a remote disclosure preview.

Broker results remain in tool-role messages, JSON-wrapped as `untrusted_data`.
The fixed system prompt treats all their contents as data, never instructions.
The host ignores model prose alongside tool calls and accepts only a strict
JSON final output: an `answer` with text and the topics read, or a `proposal`
containing a typed draft. Unknown fields, action variants, invalid tool arguments,
missing read citations, or malformed/truncated model output fail closed. These
controls bound authority; they do not establish the truth of model prose. The UI
marks model answers unchecked and displays the broker cards and freshness.

Wallet can propose pay/request drafts; Inbox can propose message drafts; Node
cannot propose drafts. Rust validates whole positive sats within the UI's safe
integer range, a full hex recipient present in the host-local contact budget
book, and field lengths. Message text must exactly match the owner's separately
entered `draft_text`; tool results and model prose cannot supply it. The contact
book is checked locally after generation, never exposed as a new model tool.
An unknown recipient must be clarified by the owner; the model has no contact
lookup tool. Contacts not yet in that local book cannot receive a model draft.

**A3 proposals are display-only cards**, with full recipient IDs, amounts and
text, and no dispatch or composer-prefill callback. The owner must open a contact's
composer separately. Neither a valid Proposal nor a model answer sends, spends,
requests an invoice, or changes channels. The rules-only named path remains as in
A2. Sealed history stores display text only and is never added to the model's
context; raw tool messages and broker objects remain transient.

## A4 — watches while the Mac app is open

The existing app status poll drives deterministic Rust rules through `ai_read`.
There is no watch timer, model call, network read, process, or background runtime.
After the existing trust disclosure is accepted, polling continues on the locked
screen, including a locked/offline startup that identifies that accepted node.
First-run setup retains its existing read limits; closing the app stops watches. The host refuses watch evaluation for hidden/closed
windows or during quit. A poll gap over 10 seconds resets baselines and elapsed
conditions, so sleep or time with the app closed cannot trigger catch-up notices.

Watches use only scalar observations already available to the app. Rust checks
these against the same assistant topic allowlists as A2/A3. They do not receive
message bodies, contacts, IDs, payment secrets, or broker/model payloads. The
renderer supplies these observations as data; notices are observations, not
independent node attestations.

All seven watches default on, with a separate saved switch under each assistant:

| Assistant | Rule | Default behavior |
|---|---|---|
| Node | Locked / offline | Notice after more than five continuously observed minutes, once until recovery |
| Node | Channel count | Compare counts from existing wallet/channel reads; baseline first |
| Node | Money readiness | One notice for `money_ready: false`, rearmed only by a known `true` |
| Wallet | Balance drop | Reported aggregate balance falls by more than 1,000 sats since the previous check; baseline first |
| Wallet | Payment failed | Count increases for explicitly failed payment receipts from the owner's existing pay/keysend flow |
| Inbox | Unread increase | App-session unread count rises; baseline first, counts only |

Unknown/pending payment outcomes and budget refusals are not called failed
payments. Payment failure and unread watches reflect this app session, not a new
history scan. Missing/expired balance or channel observations establish no
change; cached status/balance observations expire after 30/45 seconds. Returning
observations establish a new baseline. Repeated samples do not repeat notices;
disabled change watches establish a new baseline when enabled again.

Notices contain only time, rule and plain text, with no proposal, draft, action,
or composer callback. They appear in the relevant thread, remain sealed on this
Mac, and are bounded to the latest 100 notices alongside the existing 100 turns.
Switches are sealed separately and survive **Forget**. Forget clears notices as
well as turns and changes the thread generation; a queued watch poll from an old
generation cannot restore forgotten content. Baselines and dedupe state remain
in host memory only. A failed notice save leaves its dedupe state unconsumed, and
one assistant's storage failure does not suppress the others' saved notices.
