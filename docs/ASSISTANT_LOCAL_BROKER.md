# Assistant local broker (F2)

The sealed assistant window can show the 50 fixture rows read from **your
local node**, not only from the in-process mock. The host decides which, and
the window says which it got. Stacked on F1 pairing
(`docs/ONBOARDING_PAIRING.md`): the broker reads with F1's paired token.

## Status: mock-verified only

The app pins genome `v0.3.0-rc7` (`958e399`). That sidecar has no `/pair/*`
routes, so F1 falls back to `/auth/local`. **The assistant does not read with
that token.** With the bundled node the window therefore always shows mock
rows labelled *rc7 fallback*. The live path is verified here against a
test-only loopback server that serves mock-node's rc7 bodies. It has not run
against a real node.

## Live vs mock

The host computes this when the window opens (menu → Assistant), on a
background thread. One snapshot per open: each route is read at most once.

| Host state | Window shows | Label |
|---|---|---|
| Paired (#77), token has `read` scope, `GET /health` answers, no read fails in transport, no 401 | **live** rows from the node | **Live** — read from your paired node |
| No session: not started, pairing pending, pairing failed, or refused | mock rows | **Mock data** — Not paired with a node |
| Paired, but the scopes lack `read` | mock rows | **Mock data** — Not paired with a node |
| Paired, but the node answers 401 on any read | mock rows | **Mock data** — Not paired with a node |
| Paired, but the node does not answer on loopback (connect refused, timeout, closed connection), `/health` is not a usable report, or the base URL is refused | mock rows | **Mock data** — Node unreachable |
| rc7: `/pair/request` was 404, F1 used `/auth/local` | mock rows | **Mock data** — Node has no pairing routes (rc7 fallback) |
| Assistant-only startup (`npm run tauri:assistant`, no node) | mock rows | **Mock data** — Not paired with a node |
| The page finds no source global, a malformed one, or `live` without valid live rows | mock rows | **Mock data** — Source unknown |

The live rows answer the same 50 questions with the same broker. The fixture's
fault rows (q33–q50) ask the same keys as earlier rows, so a healthy node
answers them. q20, q24, q25, q27 and q32 stay `Unavailable`: the broker has
no allowlisted route that answers them. That is unchanged from the mock.

Running it (not run in this change; no `tauri dev` here):

```bash
BITSOV_ASSISTANT=node npx tauri dev --features sit-mock
```

`BITSOV_ASSISTANT=1` is unchanged: the node-free, assistant-only mock path.
`node` needs a debug build and `sit-mock` (the fixture answering lives there).
Without `sit-mock` there is no live reader; the window stays mock.

## Deny list

`LocalNodeRead` (`src-tauri/src/jarvis/broker/local_read.rs`) is the only
code that reads the node for the assistant. It is deny-by-default:

- **Routes.** Only the pinned rc7 GET routes in `route.rs`:
  `/api/v1/health`, `/api/v1/payments/balance`, `/api/v1/payments/channels`,
  `/api/v1/messages?limit=N`, `/api/v1/pricing`. Exact byte match, no path
  normalisation. The one query key is `limit`, on `/messages` only.
- **Methods.** GET only. Every other method is refused before a socket opens.
- **Refused and logged,** among others: every `POST`; `/pair/*`,
  `/auth/local`; `/identity`, `/identity/restore`; `/payments/pay`,
  `/invoice`, `/keysend`, `/send-onchain`, `/open-channel`,
  `/close-channel`, `/funding-address`, `/payments`, `/payments/price/:kind`;
  `/onboarding/*`; `/status`; `/peers`; `/messages/compose`; `../` paths.
  Segments that name spend, restore, admin, seed or auth routes are refused
  even inside an allowlisted-looking path (`route.rs` `FORBIDDEN_SEGMENTS`).
- **Tools.** Only the five read tools parse (`Broker::execute`). Anything
  else is `Rejected` and never reaches a reader.
- **Network.** The base URL must be plain `http` to a loopback IP literal
  (`127.0.0.0/8` or `::1`), an explicit non-zero port, path `/api/v1`.
  Refused: host names (including `localhost`), non-loopback and unspecified
  addresses, `https`/`ws`, credentials, other paths. The client is plain
  `std::net`: no proxy environment, no redirects, no DNS, no cookies, one
  request per connection, 2 s connect / 5 s I/O, 8 MiB response cap, and no
  `Transfer-Encoding` decoding. No cloud model and no other outbound network.
- **Auth.** The paired token only. The broker never calls `/auth/local` or
  `/pair/*`; F1's rules for both are unchanged. The token is refreshed through
  F1 (`ensure_fresh_token`) before the snapshot. A token with anything but
  visible ASCII is refused, so it cannot split a header.
- **Backend choice.** Host-side only. No command was added (`build.rs` and the
  handler list are unchanged, asserted in `main.rs`). The window receives the
  source as frozen, non-writable, non-configurable init-script globals
  (`__BITSOV_ASSISTANT_SOURCE__`, `__BITSOV_LIVE_ROWS__`). It still has no
  IPC grants and `connect-src 'none'`.

Host log lines (stderr) carry a method, a path and a reason only:

```text
[assistant-broker] denied POST /api/v1/payments/pay: method not allowed
[assistant-broker] denied GET /api/v1/identity: route not allowlisted
[assistant-broker] GET /api/v1/payments/channels: http 502
[assistant-broker] GET /api/v1/health: transport error
[assistant-broker] refused base url: not http on a loopback IP with /api/v1
```

A refused path is cut at `?`, capped at 96 characters and made printable. No
line or error carries a body, a token, a key or the refused base URL. Tests
use a canary token and assert it appears in none of them.

## Freshness (F4)

Live rows say how old the read is. App-side only: no genome change, no pin
bump, no polling. The window still reads once per open.

- **Host stamp.** `LocalNodeRead` stamps every response when its body has
  been read: a monotonic `Instant` (ages come from this) and the host wall
  clock. `Snapshot::freshness()` gives one entry per route that answered.
- **States** (`broker/freshness.rs`): *fresh* (age under `STALE_AFTER`,
  60 s); *stale* (age at or over it); *unknown* (no host stamp: a mock read,
  or a non-2xx read whose rows are `Unavailable` anyway).
- **To the window.** A third frozen init-script global,
  `__BITSOV_LIVE_FRESHNESS__`, defined for a live feed only:
  `{stale_after_ms, routes: [{route, state, age_ms, clock_skew}]}` with ages
  taken when the script is written. The window validates the exact shape
  (anything else is *freshness unknown*), then adds the time it has been open
  from its own monotonic clock (`performance.now()`), so a label turns stale
  in place. The tick only redraws text; it reads nothing and calls nothing.
- **Label.** Live: *Updated 12 s ago.* / *Stale: updated 1 min ago. Reopen
  to refresh.* / *Freshness unknown.* The oldest answering route sets the
  age. Mock rows are *Mock data* with no freshness line, even if a
  freshness global exists.

Node-side times on the pinned rc7 (`958e399`) routes:

| Route | rc7 body | Time field | Used for |
|---|---|---|---|
| `/payments/balance` | `BalanceResponse` | none | host stamp only |
| `/payments/channels` | `[ChannelResponse]` | none | host stamp only |
| `/health` | `PublicHealthResponse` | none; `block_height` and `uptime_secs` are not times | host stamp only |
| `/messages` | `[MessageResponse]` | `timestamp` (ms since epoch), per message | skew check only |
| `/pricing` | `OwnPricingResponse` | none; `block_height` is not a time | host stamp only |

The newest `/messages` `timestamp` is a send time, not an "as of": an idle
mailbox is old and current. It never makes a read fresh or stale. If it is
more than `MAX_NODE_SKEW` (120 s) ahead of the host's clock at fetch time, it
is clamped to the fetch time and the label adds *Node clock is ahead of this
computer.* Without a host wall clock it is not checked. The HTTP `Date`
header is not read: it is not part of the pinned API and would only restate
the fetch time.

### Node data time: `BitSov-Data-As-Of` / `BitSov-Data-Stale` (F5)

Genome PR BitSov-bitsov#78 (draft, **not** in the pinned `v0.3.0-rc7`) adds
two headers on `200` responses from the five pinned read routes. The app
reads them host-side in `LocalNodeRead` (`broker/local_read.rs`,
`broker/freshness.rs`). This code does nothing until a genome pin includes
#78. No pin bump happens here.

- **`BitSov-Data-As-Of`.** When the node's data was last known current.
  The node sends RFC 3339 UTC with whole seconds, e.g.
  `2026-09-27T08:20:00Z`, never later than its own clock. The app accepts:
  - RFC 3339 with `Z`/`z` or a numeric `+hh:mm`/`-hh:mm` offset,
    normalised to UTC;
  - an optional fraction, truncated to ms;
  - plain ms-since-epoch digits, the form the original G-STALENESS-MARKER
    spec proposed.

  The app ignores the header (treats it as absent) when it is malformed,
  before 1970, a leap second, or repeated. It logs only the route and
  reason (`... GET /api/v1/payments/balance: ignored BitSov-Data-As-Of:
  malformed`), never the value. The node leaves the header off `/health`
  when `block_height` is null, and off balance/channels when LDK has never
  synced.
- **`BitSov-Data-Stale: 1`.** The node says the data is past its own bound:
  an LDK sync 10 min or more old, or an expired chain-aware pricing cache.
  The value must be exactly `1` after trimming; any other value, or no
  header, has no effect.
- **Errors.** Headers on a non-2xx response are dropped unread and not
  logged. The rows are `Unavailable` and the route is *unknown*, as before.
- **Age with an as-of.** The node must never claim fresher data than the
  app can prove. The shown age is always max(node as-of age, app-read age):
  the node as-of age is the host wall clock at fetch time minus the as-of,
  plus the host monotonic time since the fetch; the app-read age is the
  monotonic time since the fetch alone.
- **Future as-of.** An as-of up to `AS_OF_TOLERANCE` (2 s) ahead of the
  host at fetch time is used (the max rule keeps the age at or above the
  app-read age). Further ahead, the as-of is dropped and the route falls
  back to the app-read age. More than `MAX_NODE_SKEW` (120 s) ahead also
  sets `clock_skew` (*Node clock is ahead of this computer.*), the same as
  the `/messages` check. Between 2 s and 120 s ahead there is no warning,
  only the fallback. With no host wall clock the as-of is not used.
- **Precedence** per route: `Stale: 1` → *stale* > max(node as-of age,
  app-read age) > app-read age > *unknown* (no host stamp or non-2xx).
  `STALE_AFTER` (60 s) applies to whichever age is used.
- **rc7.** An rc7 node sends neither header, so behaviour is unchanged:
  app-read age, or *Freshness unknown*.
- **Window.** The shape of `__BITSOV_LIVE_FRESHNESS__` does not change.
  The node's marks reach the window only through `state` and `age_ms`. The
  sealed window still cannot pick a backend or trigger a read, and there is
  no new command.

Before #78 (and on rc7), the age is how long ago the *app* read the node,
not how old the node's figures are. A node serving a cached balance
answers 200 and reads as fresh.

## Known limits

- **Staleness.** rc7 has no stale marker on the wire. mock-node models stale
  reads out of band; a real rc7 node serving a stale cache would answer 200
  with its cached figure, and `LocalNodeRead` cannot tell. The test server
  carries mock-node's stale flag as a `503` so the fixture's stale rows stay
  `Unavailable`. Genome #78's `BitSov-Data-Stale` / `-As-Of` headers are
  read (see above) but only take effect once the pin includes #78.
- **Node age vs. the 60 s threshold.** With #78, balance/channels as-of is
  the older LDK wallet sync (every 30 s / 80 s by default), so a label can
  read *Stale* between syncs even when the node does not mark it stale. A
  per-route threshold would be a follow-up.
- **Snapshot, not live updates.** Rows are read when the window opens. Close
  and reopen it to refresh. The freshness label counts up while it stays
  open and says *Stale* after 60 s.

## Waits on HUMAN

1. A genome tag that contains #77 pairing (BitSov-bitsov `56c0ee0` is in no
   tag), then a pin bump from `v0.3.0-rc7` with
   `scripts/fetch-node-sidecar.sh` and the CS-1/CS-2 smokes. Until then the
   bundled node is always *rc7 fallback* and the window is always mock.
2. A real-node run of the live path after that bump.
3. Merge and tag BitSov-bitsov#78 (freshness headers), then a pin bump,
   before the F5 as-of / stale handling is live.

## Tests

- `jarvis::broker::local_read` — base-URL allow/deny table, `admit` table,
  POST/write and unlisted routes refused and logged with nothing sent,
  bounded log lines, paired bearer sent, error status vs transport fault,
  unreachable port, strict response framing, token never in logs, errors or
  `Debug`.
- `jarvis::assistant_feed` — all 50 fixture questions over a real loopback
  socket (ephemeral port, asserted `!= 3141`) answer identically to the
  in-process mock; live values; one read per route; rc7, not paired, missing
  `read` scope, refused token, unreachable node, a route dropping mid-read and
  a non-loopback base all give mock with the right reason.
- `jarvis::assistant_source` — script shape, reasons, frozen globals,
  escaping, per-route ages at script time, no freshness on mock; node
  as-of / stale reach the window only as `state` and `age_ms`.
- `jarvis::broker::freshness` — every pinned route over a loopback socket is
  host-stamped and ages from fresh to stale at the threshold; only
  `/messages` yields a node time; future node time clamped and flagged;
  malformed or missing timestamps; unstamped (mock) and non-2xx reads are
  unknown; no host wall clock means no skew check. F5, over a loopback
  socket: `BitSov-Data-As-Of` in RFC 3339 `Z`, numeric offsets, lower/upper
  case names and ms digits; malformed and repeated values ignored and logged
  without the value; future as-of clamped and flagged; `Data-Stale: 1`
  forces stale, other values do nothing; headers on error statuses ignored;
  no headers (rc7) keeps the app-read age on every route.
- `tests/assistant-freshness.test.tsx` — strict parsing of the freshness
  global, summary and text for fresh / stale / unknown / clock skew, the
  label ticking into stale, no freshness for any mock reason, page wiring,
  and the global name and threshold matching the Rust host.
- `main.rs` — `node_auth` follows F1's mode (paired / rc7 / refused);
  `BITSOV_ASSISTANT=node` gating; no new command and the node read stays
  outside the sealed-window section.
- `tests/assistant-source.test.tsx` — label for live and each mock reason,
  unknown/malformed sources, live without rows, no rows at all.

The existing Jarvis guards are unchanged and pass: `sit_mock.rs` and mock-node
stay socket-free (the test server is `broker/test_server.rs`, `cfg(test)`).

## Non-goals

Model inference or J5 sandbox changes; spend; cloud; real-node end to end;
pin bump; packaging.
