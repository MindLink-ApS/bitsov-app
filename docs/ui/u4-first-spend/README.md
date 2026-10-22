# U4 first-spend sheet verification

The first Send opens a modal budget sheet. Opening it, choosing an option, and
Not now grant nothing. Allow uses the existing `budget_approve` action:

- Owner approval: “Approve at your box”; Allow starts that approval flow.
- Live node grant or local/rc7 fallback: “Starts now, up to N a day”, with
  the exact amount and unit. A live grant also names its remaining balance and
  expiry date/time (in local time), outside Other options.
- A paired spend-scoped session without a visible grant: Allow may start
  immediately or ask for fresh owner approval. The host does not expose the G1
  capability to the renderer, so the sheet does not assume which path applies.

Presets are app budget constants supplied by the host, not node-selected values.
The title, options, button and submitted amount use the same effective ceiling:
`min(choice, node_grant.budget_msat)` on the grant path, matching `arm_want`.
The maximum is capped by that grant budget too. `remaining_msat` is not the
host's arming clamp. Grants with less than one sat left disable Allow with a
request to ask the node’s owner for a new approval. Local fallback uses the
selected app budget directly.
Whole-sat ceilings display in sats; fractional ceilings display in integer msat,
matching the owner-approval terms at the box without rounding. Preset options
with equal effective ceilings collapse to one chip; the selected preset’s policy
is retained until a different amount option is selected, including when returning
from Custom. Custom totals retain the selected preset's contact/room policy.
Existing Touch ID contact approvals retain their existing path.

The first-contact entry fee, message price, routing-fee ceiling, and total remain
outside Other options. File sends show their own principal, routing-fee ceiling,
and total. Lapsed requests and expired daily approvals are explained in the sheet.
An expired or failed quote has its own read-only Retry button; its cost-line
explanation also describes the disabled Allow button without repeating the text.
Retry follows Other options so inserting it does not hide WebKit’s summary label.
The composer shows entry-fee loading only once a quote fetch has started.

The modal uses the browser top layer, traps focus, and restores focus on dismissal.
Not now, Escape, scrim dismissal, and a downward grabber swipe close it without
requesting approval. Danish `1.000` is refused with “Brug mellemrum: 1 000”.

## Visual evidence

The `ios-*.png` captures use a real WKWebView in a temporary preview app on
**BitSov U1 iPhone 16**, UUID `71E314A6-5C92-4507-994B-7F7E67DE9495`, iOS 27.0.
The viewport is 393 × 852. The existing active iPhone Duo simulator was untouched.
The rebuilt preview loads this worktree's actual `ControlCenter` and stylesheet,
with `sampleSource`, empty message history, and no contact budget rows.
Only Send was pressed to open the sheet; no Allow or paid action was invoked.
The harness additionally blocks approval and paid methods.

English and Danish default/large captures use OS content sizes `large` and
`accessibility-extra-extra-extra-large`. Existing px-based typography does not
scale with the OS setting; Dynamic Type remains U2b. The expired captures show
the sample quote after its real 60-second lifetime, including the visible Retry.
The grant captures use a 300.5-sat grant budget and a 200-sat remaining balance;
the local captures show the immediate 500-sat path. These captures predate the
P3 follow-up: the current sheet displays that ceiling as 300 500 msat, shows the
200-sat remaining balance and grant expiry, and collapses identical chips.

`ios-geometry.json` records native bounds: the sheet ends at y=852; Not now ends
at y=817, above the 34px bottom inset. `browser-layout.json` records checks at
393×852, 852×393 and 1280×800 in both languages: modal focus containment, Other
options, custom input with space-grouped amounts, Escape preserving the draft,
and no horizontal clipping at 200% text. The short landscape panel scrolls.

The temporary harness is under ignored `.cache/u4` and excluded from production.
These are sample-data layout checks, not a real-node payment or biometric run.

The seven unused copy keys restored during the #314 merge are removed in both
languages: `uiAllowPayments`, `uiApprovalNeeded`, `uiLetMessagesPayAsYouChat`,
`uiSomeoneNewAlwaysAsksFirst`, `presetCareful`, `presetEveryday`, and
`presetGenerous`.

## Automated verification (P3 follow-up)

- `npx tsc --noEmit`: passed.
- `npx vitest run`: 112 files, 2,081 tests passed.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --lib`: 1,104 passed
  (1,092 app + 12 FFI), one FFI test ignored. The sandboxed attempt could not bind local mock-server sockets;
  the rerun with local socket access passed.
- `TAURI_CONFIG='{"bundle":{"externalBin":[]}}' cargo test --test '*' --no-fail-fast`:
  88 passed across 16 integration targets, none failed or ignored.
- Tests cover owner, live-grant, local and ambiguous paired paths in en/da;
  custom amounts through `submit` → `budget_approve`; Danish ambiguity;
  lapse/expiry; in-sheet retry; no idle loading line; and Shell swipe dismissal,
  draft preservation, focus containment and restoration without approval.
- P3 regressions cover remaining balance and expiry, fractional custom limits
  through `budget_approve`, under-one-sat disabled reasons, deduplicated chips,
  and preservation of the selected contact/room policy when selecting a
  collapsed chip or returning from Custom.
- Independent P3 code review: no remaining substantive findings.

The original U4 verification also passed `npm run build` (with the existing
bundle-size advisory) and `npm run authority`; those were not rerun for this
follow-up.

The P3 follow-up changes no Rust files, signed `approval_message` bytes, or host
command semantics. `cargo fmt` was not run.
