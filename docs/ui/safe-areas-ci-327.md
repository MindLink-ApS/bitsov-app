# Safe-area regression investigation (#327)

Base: `dfa4b88e` (main), 23 October 2026. Baseline command:
`npx playwright test -c playwright.safe-areas.config.ts` — 30 passed, 4 failed.

## The four original failures

Every failure was the same stale `paddingBottom === '16px'` assertion, after
the card bounds, rail top and composer bottom assertions had already passed.
#322 replaced fixed spacing with capped rem values: iOS `--s-4` is
`min(.941176rem, 24px)`. Desktop WebKit on this Mac resolves
`font: -apple-system-body` to a **13px root**, with a **17px body**, producing
`12.235288px` padding. At the native Large root of 17px, the computed value is
`15.999992px`, which also fails strict string equality with `16px`.

Baseline measurements in CSS pixels (before any production change):

| Failing case | Safe rectangle (left, top, right, bottom) | Card bounds (left, top, right, bottom) | Composer bottom | Composer button bottom | Classification |
| --- | --- | --- | --- | --- | --- |
| Call 390×844 | 0, 59, 390, 810 | 31.656, 472.984, 371.656, 810 | 810 | 797.766 | Stale padding expectation |
| Meeting 390×844 | 0, 59, 390, 810 | 31.656, 126.109, 371.656, 810 | 810 | 797.766 | Stale padding expectation |
| Call 852×393 | 59, 0, 793, 372 | 453, 89.094, 793, 372 | 372 | 359.766 | Stale padding expectation |
| Meeting 852×393 | 59, 0, 793, 372 | 453, 12.25, 793, 372 | 372 | 359.766 | Stale padding expectation |

Composer controls had equal client/scroll dimensions in all four cases: no
clipped control content. The landscape meeting card has vertical overflow,
with `overflow-y: auto`; this is intentional scrolling, not hidden content.

The tests now explicitly emulate the measured native **17px Large** and
**53px AX5** roots. They expect approximately 16px and exactly 24px spacing,
allowing only 0.001px rounding. They also assert composer controls fit without
overflow, card content has no horizontal overflow, and each call action or
meeting contact fits inside the card when scrolled into view. Existing real
12-contact planner tests retain primary-action reachability and hit testing.
Geometry JSON and screenshots accompany the expanded tests.

## Additional real regression caught at AX5

The expanded tests failed on both portrait cards before the CSS fix:
their top was **57.015625px**, above the **59px** safe boundary. #318's keyboard
height rule subtracted `max(--s-4, safe-bottom)`, but the bottom anchor used
`max(--s-6, safe-bottom)`. #322's AX5 spacing exposes the mismatch: s-4 is 24px,
s-6 is 36px, and the portrait bottom inset is 34px. The card was allowed to
be 2px too tall. This was not caused by #324's wallet/type follow-ups.

The iOS call/meeting height limit now reserves the same s-6 bottom offset as
its anchor. Info and QR modals keep their existing centered height budget.
The tests failed before this production fix and pass with it.

Settled measurements after the fix (CSS pixels):

| Case | Root | Card top–bottom | Composer bottom | Composer button bottom |
| --- | --- | --- | --- | --- |
| Call portrait | 17 | 430.109–810 | 810 | 794.016 |
| Meeting portrait | 17 | 92.234–810 | 810 | 794.016 |
| Call portrait | 53 | 59.016–808 | 810 | 786 |
| Meeting portrait | 53 | 59.016–808 | 810 | 786 |
| Call landscape | 17 | 45.094–369 | 372 | 356.016 |
| Meeting landscape | 17 | 16–369 | 372 | 356.016 |
| Call landscape | 53 | 24–357 | 372 | 348 |
| Meeting landscape | 53 | 24–357 | 372 | 348 |

All bounds are inside the injected safe rectangle; the new control clipping
and scroll-reachability assertions pass. These are desktop WebKit checks with
native-measured roots/insets, not a new simulator or physical-device run.
No money wording, amount formatting, signed bytes or native code changed.

## CI and validation

`.github/workflows/webkit.yml` runs **WebKit (safe areas + type + keyboard)**
on PRs to main, pushes to main and merge groups, with no path/job skip filter.
**Make this job a required check in branch protection.**

The job uses Build's Node 22, npm cache and `npm ci --no-audit --no-fund` setup.
All action references are pinned to commit SHAs; workflow and job permissions
are `contents: read`. It installs only WebKit and its Linux dependencies, uses
one Vite server/worker, fails on `test.only`, has no retries, and retains failed
run screenshots/traces for seven days. Scene/font readiness replaces the
Dynamic Type suite's one-second sleep; geometry measurements disable motion.

`npm run test:webkit` runs both safe-area specs (38 tests), Dynamic Type
including keyboard/legacy fallback coverage (27), and inputs (3): **68 tests**.
There is no standalone keyboard or phone-shell spec at this main revision.
When phone-shell lands, include it in `playwright.webkit.config.ts`.

Local validation: `npx tsc --noEmit`; `npx vitest run` (**120 files, 2,204
tests passed**); `CI=1 npm run test:webkit` (**68 passed**). Workflow YAML
parses and `git diff --check` passes. Linux execution will be verified by CI.
