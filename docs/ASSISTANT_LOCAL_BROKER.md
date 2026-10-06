# Assistant local broker (F2)

The sealed assistant window can show the 50 fixture rows read from **your
local node**, not only from the in-process mock. The host decides which, and
the window says which it got. Stacked on F1 pairing
(`docs/ONBOARDING_PAIRING.md`): the broker reads with F1's paired token.

## Status: rc9 pin, retained rc7 fixtures

The app pins `v0.3.0-rc9` (`cd75c69`), which includes pairing and freshness
headers. The broker reads only with a paired token. An older rc7 node still
uses mock rows: its `/auth/local` token never enters the broker. Historical
rc7 route bodies and fixtures below remain compatibility evidence, not the
current binary pin. Release-binary runtime checks remain listed in
[the rc9 checklist](NODE_RC9_UPGRADE.md).

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

- **Routes.** Only the allowlisted GET routes (retaining rc7 compatibility) in `route.rs`:
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

Live rows report node data age only with usable As-Of evidence. A recent
app read alone proves no data freshness. No pin
bump, no polling. The window still reads once per open.

- **Host stamp.** `LocalNodeRead` stamps every response when its body has
  been read: a monotonic `Instant` (ages come from this) and the host wall
  clock. `Snapshot::freshness()` gives one entry per route that answered.
- **States** (`broker/freshness.rs`): *fresh* (age under the route's
  bound, `stale_after(route)`, see the table below); *stale* (age at or over
  it, or an explicit node stale marker); *unknown* (no usable As-Of or
  host wall clock, no host stamp, or a non-2xx read).
- **To the window.** A third frozen init-script global,
  `__BITSOV_LIVE_FRESHNESS__`, defined for a live feed only:
  `{routes: [{route, state, age_ms, clock_skew, stale_after_ms}]}` with ages
  taken when the script is written and each route's own bound. The window
  validates the exact shape (anything else, including the old top-level
  `stale_after_ms`, is *freshness unknown*), then adds the time it has been
  open from its own monotonic clock (`performance.now()`), so a label turns
  stale in place, per route. The tick only redraws text; it reads nothing and
  calls nothing.
- **Label.** Live: *Updated 12 s ago.* / *Stale: updated 1 min ago. Reopen
  to refresh.* / *Freshness unknown.* The header shows the oldest answering
  route's age and is stale if any route is past its own bound. Without a
  stale route, any unknown route makes the overall label unknown. A stale
  marker without an age reads *Stale: data age unknown. Reopen to refresh.* An answer
  (see *Assistant window* below) shows only its own route's age and state.
  Mock rows are *Mock data* with no freshness line, even if a freshness
  global exists.

### Stale thresholds per route (F5 polish)

| Route | Bound | Why |
|---|---|---|
| `/payments/balance` | 180 s (`WALLET_STALE_AFTER`) | With #78 the as-of is the last on-chain wallet sync, 80 s apart by default (`WALLET_SYNC_INTERVAL`). 180 s is two syncs plus 20 s for the read and the window, so one late sync does not flip the label. |
| `/payments/channels` | 180 s (`WALLET_STALE_AFTER`) | Same wallet sync as balance. |
| `/pricing` | 60 s (`STALE_AFTER`) | Chain-aware pricing; the node marks an expired cache with `Stale: 1`. |
| `/health` | 60 s (`STALE_AFTER`) | Unchanged. No node sync interval to allow for; `block_height` moves every ~10 min, so 60 s is already generous. |
| `/messages` | 60 s (`STALE_AFTER`) | Unchanged. New mail can land at any time. |

The bound applies only with usable As-Of evidence. rc7 (no headers)
remains *Freshness unknown*. The window
gets the bound from the host in `stale_after_ms`. It has no copy of the table.

Precedence, per route:

1. `BitSov-Data-Stale: 1` → *stale*, whatever the age.
2. max(node as-of age, app-read age) ≥ route bound → *stale*, else *fresh*.
3. No usable as-of (rc7, malformed, more than 2 s in the future, no host
   wall clock): *unknown*, regardless of time since the app read.
4. No host stamp, or a non-2xx read → *unknown*.

Historical node-side times in the retained rc7 (`958e399`) fixtures:

| Route | rc7 body | Time field | Used for |
|---|---|---|---|
| `/payments/balance` | `BalanceResponse` | none | freshness unknown |
| `/payments/channels` | `[ChannelResponse]` | none | freshness unknown |
| `/health` | `PublicHealthResponse` | none; `block_height` and `uptime_secs` are not times | freshness unknown |
| `/messages` | `[MessageResponse]` | `timestamp` (ms since epoch), per message | skew check only |
| `/pricing` | `OwnPricingResponse` | none; `block_height` is not a time | freshness unknown |

The newest `/messages` `timestamp` is a send time, not an "as of": an idle
mailbox is old and current. It never makes a read fresh or stale. If it is
more than `MAX_NODE_SKEW` (120 s) ahead of the host's clock at fetch time, it
is clamped to the fetch time and the label adds *Node clock is ahead of this
computer.* Without a host wall clock it is not checked. The HTTP `Date`
header is not read: it is not part of the pinned API and would only restate
the fetch time.

### Node data time: `BitSov-Data-As-Of` / `BitSov-Data-Stale` (F5)

Genome PR BitSov-bitsov#78 (included in the rc9 pin) adds
two headers on `200` responses from the five pinned read routes. The app
reads them host-side in `LocalNodeRead` (`broker/local_read.rs`,
`broker/freshness.rs`). Until a genome pin includes #78, missing headers
mean unknown data freshness. No pin bump happens here.

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
  back to *Freshness unknown*. More than `MAX_NODE_SKEW` (120 s) ahead also
  sets `clock_skew` (*Node clock is ahead of this computer.*), the same as
  the `/messages` check. Between 2 s and 120 s ahead there is no warning,
  only unknown freshness. With no host wall clock the as-of is not used.
- **Precedence** per route: `Stale: 1` → *stale* > max(node as-of age,
  app-read age) with usable As-Of evidence > *unknown*. Non-2xx and
  unstamped reads always remain unknown. The route's own bound applies
  only to known data ages; a stale marker may have `age_ms: null`.
- **rc7.** An rc7 node sends neither header, so its data freshness is unknown.
- **Window.** The node's marks reach the window only through `state` and
  `age_ms` (the per-route `stale_after_ms` came later, with the thresholds
  above). The sealed window still cannot pick a backend or trigger a read,
  and there is no new command.

Before #78 (and on rc7), the app cannot establish the age of the node's
figures. A cached balance answering 200 must not be labelled fresh solely
because the request succeeded.

## Assistant window

What a person sees in the sealed window (`src/assistant/`). Still a display
surface: no model, no command, no network, and nothing the page does can
choose the backend or cause a read.

- **Header.** The source label (*Live* / *Mock data* + why) and, for live
  rows, the ticking freshness line. The ticking line is not a live region,
  so screen readers are not interrupted every second.
- **Question box.** A labelled list of the fixture questions the host sent
  rows for (plain-language text from `jarvis/fixtures/questions.json`), an
  **Ask** button and a **Stop** button. Focus starts on the question.
- **Answer area** (`role="status"`, `aria-live="polite"`, `aria-atomic`):
  - *Empty:* "Pick a question, then press Enter or Ask. Press Escape to stop
    or clear."
  - *Loading:* "Looking up the answer…". Focus moves to **Stop**.
  - *Answered:* the question, the value, and one source line, e.g. *Live,
    from your paired node. Updated 12 s ago.* using that answer's route and
    bound, or *Mock data, not your node. Not paired with a node.*
  - *Unavailable:* "No answer for this question right now." plus why and
    what to do, in plain words: the node did not send that part (route
    failed), that part was out of date (route stale), the assistant cannot
    read it yet (broker gap such as q32), or, on mock rows, that the sample
    question has no answer on purpose and how to see your own.
  - *Stopped:* "Stopped. Nothing was changed on your node. …"
  - *Error:* "Something went wrong showing this answer. Nothing was changed
    on your node. Try again, or close and reopen the assistant." No error
    detail is shown.
  - *No rows at all:* one message to close and reopen the assistant from the
    BitSov app (with the developer command on a second line).
- **Keyboard.** Enter on the question asks. Escape stops an answer in
  progress, or clears the answer. After an answer, a stop or an error, focus
  returns to the question. Every control has a visible `:focus-visible`
  ring.
- **Stop.** Aborts the pending answer and shows *Stopped* at once. It never
  waits on the pending answer; a late answer is dropped. Answers come from
  the rows handed over at open, so today they settle immediately; the
  answer seam (`ask.ts`) is async so a slower source cannot block Stop.
- **Layout.** Source and freshness text wrap instead of overlapping; the
  answer's source line sits under the value.

## Known limits

- **Staleness.** rc7 has no stale marker on the wire. mock-node models stale
  reads out of band; a real rc7 node serving a stale cache would answer 200
  with its cached figure, and `LocalNodeRead` cannot tell. The test server
  carries mock-node's stale flag as a `503` so the fixture's stale rows stay
  `Unavailable`. Genome #78's `BitSov-Data-Stale` / `-As-Of` headers are
  read (see above) but are available on the rc9 pin.
- **Wallet sync vs. the bound.** Balance and channels allow 180 s for the
  80 s default on-chain wallet sync. A node configured with a much slower
  sync will read *Stale* between syncs; the node's own `Stale: 1` (LDK sync
  10 min or more old) is still the authority.
- **Snapshot, not live updates.** Rows are read when the window opens. Close
  and reopen it to refresh. The freshness label counts up while it stays
  open and says *Stale* once a route passes its bound (60 s, or 180 s for
  balance and channels).

## Release acceptance still pending

CI must fetch and verify rc9 after the signed checksum assets are attached and
the release is accessible. Run the paired live-reader and freshness checks
against that binary; retained rc7 mocks alone do not establish runtime evidence.

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
- `jarvis::broker::freshness` (thresholds) — each route's bound; per route
  at the boundary (bound − 1 ms fresh, bound stale) for the app-read age
  and for as-of lags of 0, 45 s, bound − 1 ms and bound; `Stale: 1` wins on
  every route; a balance/channels as-of one wallet sync old is fresh while
  pricing at that lag is stale.
- `tests/assistant-freshness.test.tsx` — strict parsing of the freshness
  global (per-route `stale_after_ms`; the old top-level shape is refused),
  summary and text for fresh / stale / unknown / clock skew, each route
  turning stale at its own bound, a single route's summary, the label
  ticking into stale, no freshness for any mock reason, page wiring, and the
  global name and thresholds matching the Rust host.
- `tests/assistant-ask.test.tsx` — question list and routes; empty, loading,
  answered, unavailable (each why), stopped and error states; answer
  freshness per route; aria-live; initial focus, Enter, Escape, focus
  return; Stop while the answer hangs (never resolves), abort signal, late
  answer dropped; no command and no network.
- Onboarding end to end (mock): `src-tauri/tests/onboarding_assistant.rs`
  (`--features sit-mock`) pairs over an ephemeral loopback port against
  mock-node's #77 `/pair/*`, then builds the assistant feed with the paired
  token (first answer q01 live, five routes fresh with their bounds; #78
  as-of 80 s old: balance/channels fresh, others stale; `Stale: 1`; rc7 stays
  mock). `assistant_feed` `the_live_init_script_matches_the_window_golden`
  pins `tests/fixtures/assistant-live-init.js`, which
  `tests/onboarding-assistant-e2e.test.tsx` loads after running the main
  window's first run → pending → paired on stubbed host commands, then asks
  the first question and checks its freshness label.
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
