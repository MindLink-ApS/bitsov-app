# Organism view (O1 v1): the Body tab

The context panel opens on **Body**: the node's physiology, drawn only from data
the app already holds. It needs no node changes. Physiology words appear in
headers only; rows are plain facts with units.

| Organ | Reading | Source | Not yet |
|---|---|---|---|
| Metabolism | sats in/out, 1 h and 24 h, per peer/room, acts | messages in tracks read here (`messages_list`) + `/ws` `message`; sends' receipts for what a room send paid | node-wide totals and hourly bars (N1) |
| Membrane | door price; admissions (settled inbound messages, first contacts flagged, never added to peers); outbound refusals: their door (`/ws` delivery `rejected`), price (`price_changed`/`price_cap_exceeded`), your setpoint (`budget_*`, `ceiling_exhausted`, `grant_*`) | `price_quote` (own), `/ws`, host `ActionError` | inbound refusals (N2) |
| Setpoints | daily total, per-contact budgets, reached setpoints ("Resting"), G1 grant left | `budget_status` (B2, `node_grant` from G1) | — |
| Immune memory | "Evidence keeping: not built." | — | N3 |
| Nucleus | node id, block height, chain source, "Recovery words not verified in this app." | `node_status` / `node_overview` (`/status`) | fingerprint, pairing epoch, backup verification flow |

Rules, pinned in `tests/control-body.test.tsx`:

- **Every mark is a reading with an age.** Live-fed organs say `Live`, or `Feed
  down · last reading 3 min ago`. Polled organs use `freshness()`.
- **Never zeroed.** When the node stops answering, organs grey out and keep their
  last reading.
- **One event, one pulse.** A real event brightens its own row for 400 ms. With
  reduced motion, the row changes weight instead. Nothing animates while idle.
- **Membrane log:** in memory, at most `MEMBRANE_KEEP` entries, never saved or exported.
- Sample mode tags every organ `SAMPLE`.
- Phone: Body opens from the node pill, one line per organ; tap to open one.

Model: `src/control/body.ts` (pure). View: `src/control/BodyPanel.tsx`.
Screens (`docs/control-center/`, sample data): `50-organism-idle`,
`50-organism-desktop`, `50-organism-full`, `50-organism-pulse`,
`50-organism-phone`, `50-organism-phone-open`.
