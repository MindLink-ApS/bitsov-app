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

## O1 v2: when the node reports N1 / N2

`/status` `api_capabilities` (genome PR #82) decides it: `energy_v1` and
`membrane_v1` are forwarded by the host (`NodeOverview.capabilities`, known
names only). An rc7 node lists neither and the v1 sources above stay in use.

- **Metabolism (`energy_v1`)**: host `energy_read` (`GET /energy?window=1h|24h`),
  polled every 30 s and shortly after a live admission. Node-wide rows, including
  tracks never opened, and 24 hourly bars. An hour the node reported nothing for
  is a gap, not a zero. The age shown is the read's age.
- **Membrane (`membrane_v1`)**: host `membrane_read` seeds from the node's ring,
  then `/ws` `membrane` events (`node-live` type `membrane`) fold in, once each by
  node `seq`. Inbound refusals are shown by reason ("at your door: unpaid 2 · …").
  A refused sender is named only when the node verified the signature; otherwise
  the entry says "unsigned". The v1 message-based admission count steps aside so
  admissions are not counted twice. The node's own outbound events are not used,
  because this app already records its refused sends with their track.
- **Door cards in the stream** (`Artifact` type `door`): a first contact
  admitted by payment (in the stranger's track, just before the message it
  admitted), a verified sender refused at your door (in their track), and your
  send refused at their price (replaces the failure row). The cards have no
  buttons: nothing is admitted, added or paid from them. First contacts appear
  under **At your door** in the rail (`data-door-track`), apart from Peers.
  They are never added as contacts, and the list lives in memory only.

Sample: `?sample&organism=v2`. Screens: `51-door-first-contact`,
`51-door-refused-inbound`, `51-door-refused-outbound`, `51-door-body`,
`51-door-phone`. Tests: `tests/control-organism-v2.test.tsx`; host projection
tests in `src-tauri/src/control.rs`.

Model: `src/control/body.ts` (pure). View: `src/control/BodyPanel.tsx`.
Screens (`docs/control-center/`, sample data): `50-organism-idle`,
`50-organism-desktop`, `50-organism-full`, `50-organism-pulse`,
`50-organism-phone`, `50-organism-phone-open`.
