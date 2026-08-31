# App icons

Generate the icon set from a 1024×1024 source PNG (the organic synaptic BitSov mark,
NOT a ₿ glyph — see the brand brief):

    npm run tauri icon path/to/bitsov-1024.png

This writes icon.png / .ico / .icns here. The build references `icons/icon.png`
(tauri.conf.json). Until then, `tauri build` will fail on the missing icon — expected
first-build friction (see docs/CS1_RUNBOOK.md).
