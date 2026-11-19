# Third-party notices

This inventory records the bundled fonts and the icons and screenshots under
`design/`. Existing licence files retain their full copyright notices and terms.

## Bundled fonts

The font binaries are in `src/assets/fonts/`; their licence files are in
`third_party/fonts/`. The [bundled-font inventory](third_party/fonts/README.md)
records Fontsource 5.3.0 packages as the source, using the Latin subset.

| Font | Bundled file | Licence and copyright notice |
| --- | --- | --- |
| Inter, variable weight | [inter-latin-wght-normal.woff2](src/assets/fonts/inter-latin-wght-normal.woff2) | SIL Open Font License 1.1: [OFL-Inter.txt](third_party/fonts/OFL-Inter.txt) |
| Instrument Serif Regular | [instrument-serif-latin-400-normal.woff2](src/assets/fonts/instrument-serif-latin-400-normal.woff2) | SIL Open Font License 1.1: [OFL-InstrumentSerif.txt](third_party/fonts/OFL-InstrumentSerif.txt) |

Keep these existing copyright notices and full OFL texts with redistributed font
files. The repository's [MIT licence](LICENSE) does not replace the font licences.

## Design screenshots

The screenshot captures are own work produced in this repository from the BitSov
app or its local design mocks. Their git history and capture sources establish
the following origin; this describes the captures, not ownership of every font,
icon or palette rendered inside them.

| Files | Origin and evidence |
| --- | --- |
| `design/inventory/*.png` | App screenshots captured in sample mode. [INVENTORY.md](design/inventory/INVENTORY.md) records the capture context; [capture-inventory.cjs](scripts/design/capture-inventory.cjs) implements it. The screenshots and capture script were added together in commit `33225e8`. |
| `design/mocks/shots/*.png` | Screenshots of the locally authored [mock.html](design/mocks/mock.html) and [directions.js](design/mocks/directions.js). [capture-mocks.cjs](scripts/design/capture-mocks.cjs) renders each direction, screen and theme. These sources and screenshots were added together in commit `33225e8`. |
| `design/after/**/*.png` | App screenshots documenting UI changes, including before/after comparisons. History introduces these with the corresponding UI changes, from commit `33225e8` through `2d1d21e`. Capture sources are in [scripts/design/](scripts/design/), covering sample-mode screens, stubbed onboarding, unlock and offline states, QR scanning and phone layouts. |

The PNG files contain no embedded source or attribution metadata. Their capture
origin is supported by the repository records above; third-party content visible
within a capture is covered separately below where its source can be established.

## Design icons

The `ico` object in [design/mocks/mock.html](design/mocks/mock.html) defines five
inline SVG icons: `call`, `video`, `people`, `more` and `plus`. They first appear
with the mock source in commit `33225e8`. There are no standalone icon image files
under `design/`; other icons and glyphs appear within the app screenshots.

TODO (maintainer): confirm whether the five inline SVG definitions are own work
or adapted from another source. Neither the file nor its introduction records an
upstream icon set, so no third-party attribution or licence can be established
from those records. If adapted, record the source, version and required notices.
Also confirm the origin and applicable notices for app icons and system-rendered
glyphs visible in the screenshots. Adding an icon to git alone does not establish
its authorship.

## Third-party material identified in the design sources

| Material | Source recorded in the files | Status |
| --- | --- | --- |
| Remote design fonts | The Google Fonts stylesheet in [mock.html](design/mocks/mock.html) requests Geist, Geist Mono, Inter, IBM Plex Sans, IBM Plex Mono, Fraunces, Instrument Serif and JetBrains Mono. [choice-board.html](design/choice-board.html) requests Instrument Serif, IBM Plex Sans and IBM Plex Mono from Google Fonts. | These design pages use remote stylesheets, distinct from the two bundled font files above. TODO (maintainer): record the exact versions and applicable font copyright/licence notices; the files do not pin the remote responses or establish which face loaded in each historical screenshot. |
| Radix Colors palette values | Comments in [directions.js](design/mocks/directions.js) identify borrowed Radix Colors values and mark them MIT; direction F specifically identifies the sand and orange scales. | TODO (maintainer): confirm the source revision and retain the corresponding upstream copyright and licence notice for the borrowed values. |
| Catppuccin palette values | Comments in [directions.js](design/mocks/directions.js) identify direction E as Catppuccin Mocha / Latte and mark it MIT. | TODO (maintainer): confirm the source revision and retain the corresponding upstream copyright and licence notice for the borrowed values. |

The source comments establish the palette names and stated licences; they do not
include the full upstream notices. Unrecorded asset origins remain maintainer
TODOs rather than assumed third-party sources or claims of original authorship.
