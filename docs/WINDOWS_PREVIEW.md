# BitSov Beta for Windows: preview

This is a **preview** of BitSov Beta on Windows 10 and 11 (x86_64). It is not a
release and it is not supported. It runs on **signet only**, a Bitcoin test network
where coins have no value. It never runs on mainnet.

The Windows app does not run a node. It connects to a signet node that runs
somewhere else (a hosted node or your own box), using a pairing link from that
node's owner.

## What works and what does not work yet

| Area | State in this preview |
|---|---|
| Install, start, window, settings screens | Expected to work. Not yet tested on a Windows machine. |
| Paste a pairing link and see who hosts the node | Works: the link is checked and shown before anything is saved. |
| Save the pairing and connect to the node | **Does not work yet.** Windows has no protected storage for the app's pairing key and records yet. The app refuses with "private pairing storage is not supported on this platform" and saves nothing. |
| Messages | **Not yet.** Needs a saved pairing. |
| Payments (with approval on the node) | **Not yet.** Needs a saved pairing, and the spend journal, budget and approval records also need protected storage on Windows. |
| Calls | **Not yet.** Needs a saved pairing. Microphone use on Windows is untested. |
| A node on this computer | **No.** The Windows app refuses to create or start a local node. |
| Mainnet | **No.** This app accepts signet nodes only. |
| QR scan with the camera | Untested. Paste the link instead. |

The refusals are deliberate. The app stops with a clear message instead of
writing keys or payment records into files that other Windows users could read.
Protected storage for Windows (an owner-only file layer plus encryption with the
Windows user account) is the next step; until it lands, this preview shows the app
but cannot pair.

## Install (unsigned installer)

The installer is not signed, so Windows SmartScreen warns about it.

1. Check the SHA-256 of the installer against the `SHA256SUMS` file you received
   with it. In PowerShell:
   `Get-FileHash .\BitSov-beta-signet-windows-x64-<version>-setup.exe -Algorithm SHA256`
2. Run the installer. If you see **"Windows protected your PC"**, choose
   **More info**, check that the file name is the one you verified, then choose
   **Run anyway**. If your organisation blocks unsigned apps, stop here.
3. The installer installs for your Windows user only and needs no administrator
   rights. It uses Microsoft Edge WebView2, which Windows 11 already has. On
   Windows 10 the installer may download WebView2 from Microsoft.
4. Start **BitSov Beta**. The window title says "BETA · SIGNET".

To remove it, use **Settings → Apps → Installed apps → BitSov Beta → Uninstall**.
App data stays in `%APPDATA%\tech.mindlink.bitsov.beta` and
`%LOCALAPPDATA%\tech.mindlink.bitsov.beta` until you delete those folders.

## Microphone

Calls do not work in this preview. When they do, Windows may block the
microphone per app: **Settings → Privacy & security → Microphone** must allow
desktop apps.

## Reporting problems

Say which Windows version you use (**Settings → System → About**), what you did,
and what the app showed. Do not send pairing links, screenshots of pairing codes,
or files from the app data folders.

## Building the preview

`scripts/build-windows-remote.sh` builds the unsigned NSIS installer from
`packaging/windows/tauri.windows-beta.conf.json`. It refuses an overlay that is not
signet-only, bundles a node, or builds anything other than NSIS. It downloads
nothing unless `--allow-downloads` is given, and it writes the installer,
`build-info.txt` and a verified `SHA256SUMS` to the `--out` directory.

```bash
# Cross-build on macOS or Linux (needs cargo-xwin, makensis and the
# x86_64-pc-windows-msvc Rust target; the first run must fill caches):
bash scripts/build-windows-remote.sh --out /path/to/out --allow-downloads
# Later runs, offline:
bash scripts/build-windows-remote.sh --out /path/to/out
# Validate the overlay and the host only:
bash scripts/build-windows-remote.sh --out /path/to/out --check-only
```

`scripts/test-build-windows-remote.sh` tests the script's refusals without
building.
