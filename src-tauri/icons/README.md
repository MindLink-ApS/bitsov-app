# App icons

Generated from `source/bitsov-1024.png`: the organic synaptic BitSov mark (NOT a ₿
glyph) on a 1024×1024 transparent canvas, with the artwork in
the centred 824×824 rounded square that macOS app icons use, so the Dock icon is not
edge-to-edge. Regenerate with:

    npm run tauri icon src-tauri/icons/source/bitsov-1024.png --output <tmp-dir>

then copy `32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`, `icon.ico` and
`icon.png` here (the files `bundle.icon` lists in tauri.conf.json). The iOS and Android
icon sets under `src-tauri/gen/` are separate and are not regenerated from this
padded source: iOS icons must be opaque.
