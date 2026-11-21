# App on a node you already run (DEV ONLY)

**Signet-only beta:** configure your node's Lightning backend and chain
providers for signet before starting it. Check the network in the app before
testing payments. Use test coins only; this debug mode does not enforce the
network selection. See [signet configuration](DEV_NODE_FROM_MAIN.md).

Use this when the owner already runs `konsensus start … --owner-control` on this Mac
and wants the desktop app on that node, instead of the app starting its own sidecar.

To bundle a separate debug `.app` for pairing a test Mac with a remote node, see
[DEV_REMOTE_TEST.md](DEV_REMOTE_TEST.md).

```bash
BITSOV_DEV_EXTERNAL_NODE=/abs/path/to/your/node-data-dir npm run tauri:dev:external
```

## Dock icon wrapper

`tauri.dev-external.conf.json` sets `bundle.active=false`, so Tauri makes no `.app`
and the bare debug binary shows a generic Dock icon. To get the BitSov icon, wrap the
binary that `npm run tauri:dev:external` built:

```bash
BITSOV_DEV_EXTERNAL_NODE=/abs/path/to/your/node-data-dir \
  scripts/make-dev-external-wrapper.sh src-tauri/target/debug/bitsov-app \
  "$HOME/Applications/BitSov Dev External.app"
```

With `CARGO_TARGET_DIR` set, the binary is under that directory's `debug/`. The
wrapper's `Info.plist` starts from `src-tauri/Info.plist`, so the microphone, camera
and local network usage strings stay; macOS ends an app that asks for the microphone
without one. The wrapper then gets identifier `tech.mindlink.bitsov.devexternal`, `CFBundleIconFile` =
`icon.icns` and a copy of `src-tauri/icons/icon.icns` in `Contents/Resources/`.
`BITSOV_DEV_EXTERNAL_NODE` is optional; when set, it goes into `LSEnvironment` so a
Dock or Finder launch attaches to that node dir. The wrapper is unsigned and is not
built, launched or notarised by the script. Rebuild it after each new debug build.
`scripts/test-dev-external-wrapper.sh` checks the generated bundle.

## What the app does in this mode

- It talks to `http://127.0.0.1:3141/api/v1` only, as in every other mode. It refuses
  to attach unless the node's `konsensus.toml` has `[api] listen_addr = "127.0.0.1:3141"`
  (or no `[api]` bind, which is the node default).
- It **never** runs `konsensus init`, never spawns a node, and never stops, restarts or
  signals one. Quitting the app leaves your node running. Identity restore is refused
  in this mode, and so is the restart that would follow it.
- It needs `konsensus.toml` and `NODE_INITIALIZED` in the dir, and a node answering
  `/health`. Otherwise it shows an error and does nothing.
- It **reads** the node dir for two things only: the `0600` pairing challenge file that
  the node names in `/pair/request`, from `<dir>/pairing/`, and the routing-fee policy
  in `konsensus.toml`.
- It **writes** only under its own data dir,
  `~/Library/Application Support/tech.mindlink.bitsov.devexternal/external-node/`: the
  client key, the pairing record and the spend journal/budget book. Nothing is written
  to the node dir.
- The window title reads **"BitSov — DEV, EXTERNAL NODE (127.0.0.1:3141, not started by
  the app)"**.
- It can't be combined with `BITSOV_DEV_SIDECAR` / `BITSOV_DEV_DATA_DIR`, and it can't
  point at an app data dir.

Like the #44 dev-node path, it exists only in `debug_assertions` builds with the
non-default `dev-node` feature. Every other build compiles a stub that never reads the
environment (`src-tauri/src/dev_node.rs`, `scripts/test-dev-node-release-guard.sh`).

## Pairing

The app doesn't own the node's stdout here, so it can't compare the short code
itself. The app shows the code, and you compare it with the line the node printed
(`bitsov pairing code for "<pair_id>": XXXX-XXXX`, wherever your node's stdout goes).
The code is a tripwire, not a lock (`docs/ONBOARDING_PAIRING.md`).

Once one client is paired, the node accepts a new pairing only while you have a window
open:

```bash
konsensus pair-window --config /abs/path/to/konsensus.toml --seconds 300
```

Open it, then start the app (or press retry on the pairing screen) inside the window.
The pairing is `read + receive`. It is stored, so later starts reuse it.

## Spend

Spend works as on the dev-node path. You approve a budget in the app, then run the
`konsensus grant --op …` it shows, adding `--config`. Genome prints the
elevation confirmation only to the **node's controlling terminal** (`/dev/tty`). A node
started detached (no TTY, e.g. with `nohup … &` or launchd) can't print it, so every
grant fails closed. To spend, the node has to run in a terminal you can read.
