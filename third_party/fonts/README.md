# Bundled fonts

`src/assets/fonts/` ships these faces inside the app bundle. They are taken from the
Fontsource 5.3.0 packages, latin subset only. Both are licensed under the SIL Open Font
License 1.1; the full licence texts sit next to this file. The font files live in
`src/assets/fonts/`; only these licence texts are kept out of `src/`, because they contain URLs
and the authority gate (`scripts/authority-check.sh`, G2) scans `src/` for them.

| File | Family | Licence |
|------|--------|---------|
| `inter-latin-wght-normal.woff2` | Inter (variable weight) | `OFL-Inter.txt` |
| `instrument-serif-latin-400-normal.woff2` | Instrument Serif Regular | `OFL-InstrumentSerif.txt` |
