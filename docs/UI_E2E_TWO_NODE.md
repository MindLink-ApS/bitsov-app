# UI-E2E: the real app window against two mock nodes (DEV ONLY, no money)

`scripts/ui-e2e-two-node.sh /abs/path/to/genome-checkout` runs the owner's evening
through the real Tauri window on current app main: first run, an owner spending
approval, capped first contact to a stranger, message delivery and wallet updates,
pay / request / file / room, spending lock, price refusals and
"Ask your node". It needs no wallet, seed, mainnet node or funds.

## What it runs

| Piece | What |
|---|---|
| Node B | `konsensus` from the genome checkout, fresh identity in the private run’s `node-b/` directory, `price_open`, loopback binds, host-local Seatbelt policy and fail-closed `lsof` socket observations |
| Node A | the same binary, **started by the app** through the #44 dev-node path (`scripts/dev-node-from-main.sh`, `BITSOV_DEV_SIDECAR` / `BITSOV_DEV_DATA_DIR`) on `127.0.0.1:3141`, in the same sandbox. The dev path starts it with `--owner-control`, so node A prints the owner's grant code on the terminal that started the app |
| Lightning / chain | `shared_mock` Lightning (one ledger, signed regtest invoices, recipient settlement lookup) and mock chain, as in PR #46 |
| The window | the real app (`tauri dev --features dev-node`), with `tests/e2e/driver.js` injected by the dev server |
| The owner | `konsensus grant --op … --yes`, typed into node A's CLI with the code node A printed on its terminal |

The runner (`scripts/ui-e2e/runner.py`) owns every process and directory it
creates. It records node B’s direct child PID and node A’s actual PID from a
private exec wrapper started by the app. On exit, including failure or Ctrl-C,
it stops those owned nodes and the app’s process group, reaps children, joins
console readers and deletes only the data dirs it created. Preflight refusal
does not signal existing processes. Each invocation has unique node paths under
`/tmp/uie2e-run.*`; it never reuses the former shared `/tmp/uie2e-node-*` paths. Evidence goes to a fresh private
`/tmp/uie2e-evidence.*`:
- `runner.log` and `summary.json` (every step PASS/FAIL, checks, bugs)
- `ui.jsonl` (every UI command and its result) and `node-http.jsonl` (node reads)
- `app.log` (sanitized host and node A output) and `node-b.log`
- `node-sockets.jsonl` (actual node PIDs, observation stages and endpoints)
- `processes.jsonl` (owned process starts and stops)
- `snapshots/NN-*.html|png` and `walkthrough.webm`

Credentials are sanitized **before** every evidence write using #46’s
`Evidence` and line-buffered `ConsoleCapture`. Tokens, grant phrases and pairing
codes remain in memory/private runtime state. HTTP bodies, terminal output,
UI transcripts, snapshots and errors all pass through the sanitizer. The runner
scans evidence after shutdown while its remembered secrets are still available;
any unsafe artifact is removed and the run fails. The shell scans again before
rendering and on exit. PNG/video files are produced offline from sanitized DOM
snapshots; the final scanner checks their format and credential byte patterns
as well as all text. This is not OCR or detection of arbitrary unlabeled random
secrets.

Both actual node processes are sampled at launch, readiness, every 0.25 seconds,
before a restart and before shutdown. Any observed non-loopback, wildcard or
unreadable endpoint, or inspection failure, latches a failing exit. Seatbelt’s
`localhost` policy also permits this Mac’s LAN addresses. **The lsof guard is
snapshot detection, not packet prevention**: short-lived sockets between samples
can escape observation.

## Why a driver inside the window, not Playwright on it

macOS has no WebDriver for `WKWebView`, so neither Playwright nor `tauri-driver`
can attach to a Tauri window there. `tests/e2e/driver.js` runs **inside** the real
window instead.
- **Injection:** the dev server adds it only when `BITSOV_UI_E2E=1` and only in
  `vite serve` (`uiE2eDriver` in `vite.config.ts`). `vite build` never includes it.
- **Command loop:** it long-polls the dev server for one command at a time (click,
  fill, wait, read text, attach a file, snapshot).
- **What it does:** it only does what the owner could do with the mouse and
  keyboard. It calls no Tauri command itself.
- **Screenshots:** a snapshot serializes the live DOM with its stylesheets and
  form values. Afterwards `scripts/ui-e2e/render.mjs` renders the snapshots with
  Playwright (Chromium, all network blocked) into PNGs and one webm walk-through.
  These are faithful to the DOM, but they are Chromium's rendering of it, not a
  capture of the WebKit window.

Node-side calls in the spec are limited to three things:
1. Evidence reads, with an operator token from the throwaway config secret.
2. What the owner types at node A's terminal (`konsensus grant`).
3. Owner setup the app has no screen for: creating the A+B room. In step 6, B's
   owner also adds A as a known peer after raising B's price.

Each is labelled where it happens.

## Run

```bash
# genome under test, e.g. main + open PRs merged in a throwaway worktree
cd ~/Desktop/BitSov-bitsov && git fetch origin
git worktree add --detach /tmp/uie2e-genome origin/main
# (merge the PRs you want into /tmp/uie2e-genome)

# app under test (this branch, plus any open app PRs merged the same way)
cd /path/to/bitsov-app && npm ci
CARGO_TARGET_DIR=/tmp/bitsov-target-l1 APP_CARGO_TARGET_DIR=/tmp/bitsov-target-app \
  scripts/ui-e2e-two-node.sh /tmp/uie2e-genome
```

Cargo honors `CARGO_TARGET_DIR` for genome dependencies and links the executable
directly into a private invocation directory, avoiding shared-binary replacement
races. `APP_CARGO_TARGET_DIR` controls the separate app cache. The defaults are
`/tmp/bitsov-target-l1` and `/tmp/bitsov-target-app`.

Needs macOS, native `/usr/sbin/lsof`, cargo with offline deps, Python 3.11+, and ports `127.0.0.1:3141`
and `:1420` free. Screenshots need a Playwright install with Chromium. The script
looks in `node_modules` and the npx cache, or you can set `PLAYWRIGHT_MODULE` and
`PLAYWRIGHT_CHROMIUM`. The app window opens on your screen while it runs. Don't
edit the app checkout during a run: Vite reloads the window.

## Limits

- **Current-main UI:** Budget presets/tallies, Body organs and door cards are
  absent from app main and are not covered or reported as passing. The scenario
  uses its existing ten-minute approval, wallet and visible refusal controls.
- **First-contact ceiling:** current main displays its own chat price as the
  aggregate cap when the peer price is unknown. The fixture sets A to 4,000 msat
  and B to 2,000 msat, covering B’s 2,000 admission plus 2,000 message. The run
  verifies the actual debit against the displayed cap and both settlements.
  Equal 2,000-msat defaults correctly produce a cap refusal; the harness never
  bypasses a failed UI send with an operator-key compose call.

- **Deposit QR:** it cannot appear on mock Lightning. Only an embedded LDK
  backend has a deposit address. Step 1 checks the expected HTTP 400 and the
  panel’s explanation. `tests/fund-no-address.test.tsx` separately tests a
  successful deposit-address QR with a host fixture; no real Lightning is enabled.
- **Rooms:** one remote member (A+B). A two-remote fan-out needs a third node.
- **Mock Lightning:** no channel liquidity, routing fees or HTLC timing.
