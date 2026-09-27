# UI-E2E: the real app window against two mock nodes (DEV ONLY, no money)

`scripts/ui-e2e-two-node.sh /abs/path/to/genome-checkout` runs the owner's evening
through the real Tauri window: first run, a budget grant, first contact to a
stranger, messages inside the budget, pay / request / file / room, refusals and
"Ask your node". It needs no wallet, seed, mainnet node or funds.

## What it runs

| Piece | What |
|---|---|
| Node B | `konsensus` from the genome checkout, fresh identity in `/tmp/uie2e-node-b`, `price_open`, loopback-only sandbox (`sandbox-exec`, no non-loopback egress) |
| Node A | the same binary, **started by the app** through the #44 dev-node path (`scripts/dev-node-from-main.sh`, `BITSOV_DEV_SIDECAR` / `BITSOV_DEV_DATA_DIR`) on `127.0.0.1:3141`, in the same sandbox. The dev path starts it with `--owner-control`, so node A prints the owner's grant code on the terminal that started the app |
| Lightning / chain | `shared_mock` Lightning (one ledger, signed regtest invoices, recipient settlement lookup) and mock chain, as in PR #46 |
| The window | the real app (`tauri dev --features dev-node`), with `tests/e2e/driver.js` injected by the dev server |
| The owner | `konsensus grant --op … --yes`, typed into node A's CLI with the code node A printed on its terminal |

The runner (`scripts/ui-e2e/runner.py`) owns every process and directory it
creates. On exit, including failure or Ctrl-C, it quits the app (which stops node A),
stops node B and deletes both data dirs. Evidence goes to a fresh private
`/tmp/uie2e-evidence.*`:
- `runner.log` and `summary.json` (every step PASS/FAIL, checks, bugs)
- `ui.jsonl` (every UI command and its result) and `node-http.jsonl` (node reads)
- `app.log` (host and node A output, including the owner console) and `node-b.log`
- `snapshots/NN-*.html|png` and `walkthrough.webm`

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
scripts/ui-e2e-two-node.sh /tmp/uie2e-genome
```

Needs macOS, cargo with offline deps, Python 3.11+, and ports `127.0.0.1:3141`
and `:1420` free. Screenshots need a Playwright install with Chromium. The script
looks in `node_modules` and the npx cache, or you can set `PLAYWRIGHT_MODULE` and
`PLAYWRIGHT_CHROMIUM`. The app window opens on your screen while it runs. Don't
edit the app checkout during a run: Vite reloads the window.

## Limits

- **Deposit QR:** it cannot appear on mock Lightning. Only an embedded LDK
  backend has a deposit address. Step 1 checks that the panel says so.
- **Rooms:** one remote member (A+B). A two-remote fan-out needs a third node.
- **Mock Lightning:** no channel liquidity, routing fees or HTLC timing.
