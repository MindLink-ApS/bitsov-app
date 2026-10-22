# U3: English and Danish copy

The shared lookup in `src/i18n.ts` extends the existing `phoneCopy` table with
`appCopy`. Onboarding keeps its original translation source and uses the same
language resolver as the shell. No dependency was added.

`navigator.language` beginning with `da` selects Danish; everything else selects
English. General settings offers System, Dansk and English. The preference is
stored locally as `bitsov.language`. System language changes update mounted copy
and `<html lang>`. Language selection never changes an amount or recipient.

This slice covers the rail, composer, message/payment stamps, payment review and
confirmation, call panel, wallet front/activity/send, and top-level/General
settings. Deeper settings, other tracks and raw node/host diagnostic messages
remain for later slices. Existing money and custody disclosures retain their
meaning and amounts. Historic wallet activity labels are translated at display
time; invoice notes and contact names are kept verbatim.

Amounts use ASCII spaces for thousands in both languages, with a decimal point
for fractional sats/BTC. Sats retain every integer millisatoshi, including at
`Number.MAX_SAFE_INTEGER`; BTC retains up to 11 fractional places. Input parsing
and payment arithmetic are unchanged.

For another migrated surface:

1. Add matching keys to `appEn` and `appDa`; use `t(key, value, ...)` for `{0}`, `{1}` slots.
2. Resolve text inside a reactive expression/getter, not a component-scope string.
3. Add the component to `tests/i18n-source.test.ts` and exercise its translated UI.
4. Keep protocol tokens, user text and monetary values outside translation.

Validation commands: `npx tsc --noEmit`, `npm test`, `npm run build`,
`npm run authority`, `npm run a11y`, and `npm run test:inputs`.
The browser gates run headlessly. They do not establish native iOS Simulator,
WKWebView or Dynamic Type behavior; no window-opening binary was launched for U3.
