# UI lane: morning summary (2026-10-05)

## State of the Ember 2.0 stack
All PRs are drafts. Each needs Fable + Grok review, and nothing gets merged by this lane.

| PR | Scope | Base | Status |
|----|-------|------|--------|
| #137 | Tokens, fonts, design research | main | **Merged** (squash) |
| #138 | Onboarding in 3 stages | **main** (retargeted) | Grok FAIL fixed; new head posted |
| #139 | Rail + Welcome home | #138 | Non-blocking fix; new head |
| #140 | Chat + price breakdown | #139 | 2 non-blocking fixes; new head |
| #141 | Wallet + custody label | #140 | 2 non-blocking fixes; new head |
| #143 | Calls, meetings, rooms, settings, quiet errors, remote retry (#130), call over-cap refusal (#127) | #141 | New, needs review |
| #144 | Purposeful motion + reduced-motion test | #143 | New, needs review |
| #142 | Fix for the two flaky ~5 s tests (bounded fake-clock waits) | main | New, test-only, needs review |

The stack was rebased onto main after the #137 squash. Review fixes went in bottom-up, and each upper branch was rebased onto them. Pushes used `--force-with-lease` on this lane's branches only.

Checks at the top of the stack (#144):
- vitest: 905 passed
- `npm run build`: OK
- `npm run authority`: PASS

The bottom branch (#138) passes 891 tests and the authority check.

## What changed overnight
- **#138 blocking fix.** On an identity-free node, onboarding no longer offers "restore it now"; it says restore is not available on this node yet.
- **Other review fixes:**
  - Access scopes are visible again.
  - The custody badge stays on the selected compact pill.
  - The onboarding glow no longer clips focus rings.
  - Hover lifts stop under reduced motion.
  - "Add sats" keeps its money colour on hover.
  - The breakdown drops "on this path".
  - Money ink appears only for a real ceiling.
  - The settle animation is 320 ms.
  - "Unknown" amounts use muted ink, which meets AA contrast.
- **New surfaces (#143).**
  - Neutral pill buttons.
  - Call and meeting cards. The #127 refusal ("Nothing was sent or paid") now reads as a calm note.
  - Fixed the stretched meeting checkboxes.
  - Settings use sentence case.
  - The #130 "waiting N s before retrying" message is now a status card.
  - Calm SoftError styling.
- **Motion (#144).**
  - Menus and pickers pop in.
  - Disclosures rise in.
  - A test enforces that every infinite animation is switched off under reduced motion.
- **Flaky tests (#142).** Both tests now use a fake clock with bounded steps: about 5 s → about 0.1 s each, with the same assertions.

## Open questions for Rasmus
Each has my recommendation.

1. **Should primary buttons outside onboarding and Welcome turn neutral?**
   - **Today:** the global `.primary` style is still orange, which Grok flagged against the "orange = money" rule.
   - **Recommendation:** yes. Make `.primary` neutral globally and opt the money actions back into orange (Send, Pay, Approve spending, Receive, Create invoice) with a `money` class, as one small PR.
2. **Should `--faint` text be raised to full AA contrast?**
   - **Today:** it is only 3:1 (AA-large), used for timestamps and hints at 11.5–12.5 px.
   - **Recommendation:** yes. Lighten it in dark mode and darken it in light mode until it reaches 4.5:1, and let the contrast test enforce that.
3. **Should the wordmark keep its orange "Sov"?**
   - **Today:** it is the one brand exception to the money rule.
   - **Recommendation:** keep it. It is the brand, it is tiny, and it is never next to a price.
4. **Should the design mocks keep loading Google Fonts?**
   - **Today:** `design/mocks/`, the choice board, and the historical "JetBrains Mono" mention for F all load fonts from Google. They are outside `src/` and are not bundled.
   - **Recommendation:** leave them as historical artifacts.
5. **Should this lane run as an overnight `/loop` and use `~/Desktop/MindLink-Private`?**
   - **Today:** the factory session asked for both. I did the in-repo work in this session but did not self-schedule a loop or read/write MindLink-Private, because your brief scoped me to this repo.
   - **Recommendation:** if you want either, start `/loop` here yourself and confirm the pm/ paths. Meanwhile, verdicts posted as PR comments reach me fine.
