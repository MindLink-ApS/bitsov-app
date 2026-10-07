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
