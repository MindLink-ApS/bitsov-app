# U4 first-spend sheet verification

The first Send opens a modal budget sheet. Allow calls the existing owner-approval
path; opening, choosing an option, and Not now grant nothing. Node preset values
and the node's maximum daily amount are used directly. A custom total retains the
selected preset's contact/room policy. Existing Touch ID contact approvals keep
their existing path; this budget request says “Approve at your box”.

The first-contact entry fee, message price, routing-fee ceiling, and total remain
outside Other options. File sends show their own principal, routing-fee ceiling,
and total. The modal uses the browser top layer, traps focus, and restores focus
on dismissal. Not now, Escape, scrim dismissal, and a downward grabber swipe all
close it without requesting approval.

## Visual evidence

The four default/large `ios-*.png` captures use a real WKWebView in a temporary preview app on
**BitSov U1 iPhone 16**, UUID `71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS 27.0.
The viewport is 393 × 852. The existing active iPhone Duo simulator was untouched.
The preview loads this worktree's actual `ControlCenter` and stylesheet, with
`sampleSource`, empty message history, and no existing contact budget rows.
Only Send was pressed to open the sheet; no Allow or paid action was invoked.
The additional `ios-*-expired.png` captures show the disabled primary and its
reason after the sample’s 60-second first-contact quote expires.

English and Danish were captured with OS content sizes `large` (default) and
`accessibility-extra-extra-extra-large`. Existing px-based typography does not
scale with the OS setting; Dynamic Type remains U2b. The explicit 200% browser
text check below verifies wrapping and scrolling independently.

`ios-geometry.json` records native bounds: the sheet ends at y=852; Not now ends
at y=817, above the 34px bottom inset. `browser-layout.json` records checks at
393×852, 852×393 and 1280×800 in both languages: modal focus containment, Other
options, custom input with space-grouped amounts, Escape preserving the draft,
and no horizontal clipping at 200% text. The short landscape panel scrolls.

The preview harness is temporary, under ignored `.cache/u4`, and is excluded
from the production build. These are sample-data layout checks, not a real-node
payment or biometric approval run.

## Automated verification

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 110 files, 1,982 tests passed.
- `npm run build`: passed (existing bundle-size advisory).
- `npm run authority`: passed.
- Independent review: no remaining important findings.

No Rust files, signed payloads, or host commands changed. Cargo tests and
`cargo fmt` were not run.
