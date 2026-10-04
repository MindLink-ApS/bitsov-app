# Bundled fonts

`src/assets/fonts/` ships these faces inside the app bundle. They are taken from the
Fontsource 5.3.0 packages, latin subset only. Both are licensed under the SIL Open Font
License 1.1; the full licence texts sit next to this file. They are kept out of `src/`
because the authority gate (`scripts/authority-check.sh`, G2) scans `src/` for URLs.

| File | Family | Licence |
|------|--------|---------|
| `inter-latin-wght-normal.woff2` | Inter (variable weight) | `OFL-Inter.txt` |
| `instrument-serif-latin-400-normal.woff2` | Instrument Serif Regular | `OFL-InstrumentSerif.txt` |
