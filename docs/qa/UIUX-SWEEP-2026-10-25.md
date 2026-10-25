# UI/UX sweep — 2026-10-25

Walk of the BitSov web shell against `805a064` (current `main`), starting from the 2026-10-23 report. That report walked `321f437`. This pass reads the UI copy since then — phone tabs, the Danish/English rounds, and the send, delivery, and notification copy from #341 — and checks that one thing has one name, in both languages.

Shared copy is the reference: `docs/qa/U3-DA-EN-STRINGS.md` and the tables merged in `src/i18n.ts` (`appCopy`, `controlCopy`, `onboardingCopy`, `phoneCopy`, `assistantQuestionsCopy`). `navigator.language` starting with `da` selects Danish; everything else is English. The preference is `bitsov.language`.

Draft PR #340 (`cursor/uiux-sweep-4-7f8b`, report `docs/qa/2026-10-24-uiux-sweep-4.md`) covers phone layout and recovery states. This pass does not edit those lines. Its leftover “phone tabs stay Chats in Danish” is the chat-name fix below.

Not in this walk: the Tauri host as a native window, the iOS/Android shells as installed apps, and `assistant.html`. Phone-width strings were measured in Chrome against `src/styles.css` at 320px (`data-platform=ios` and `android`), with the real composer and tab markup.

## Counts

| Severity | Found | Fixed here | Left as findings |
| --- | ---: | ---: | ---: |
| High | 0 | 0 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 5 | 3 | 2 |
| **Total** | **10** | **8** | **2** |

Items still open from the 22 Oct report, the 23 Oct report, and PR #340 are listed at the end and are not in this table.

## What changed since 23 Oct

`git log 321f437..805a064` adds the phone shell (Chats · Wallet · You, Calls only when history exists, #325), onboarding and pairing copy (#334), chats, wallet, calls, and the assistant in both languages (#338), and the truthful send flow, Mac notifications, and Touch ID recovery (#341). The hardcoded-English guard now covers `src/control`, `src/assistant`, onboarding, and `App.tsx`.

Delivery wording was checked against `docs/UX2_SEND_FLOW.md` and left as #341 wrote it. `deliveryFromReceipt` in `src/control/state.ts` maps a recipient ack (`accepted` or `state === 'acked'`) to `accepted`, and `delivered: true` with no ack to `sent`. The tick in `DeliveryMark` (`src/control/Shell.tsx`) is `accepted` or a later `/ws` `delivered`, and both use `chatDelivered` (“Delivered” / “Leveret”). `sent` stays the word “Sent” / “Sendt”. A receipt flag alone does not draw the tick.

## Findings

### 1. The chat list has four names

- **Screen:** Desktop rail (accessible name) and phone tabs
- **Severity:** Medium
- **What:** The same list was “Tracks” on the desktop rail (`uiTracks`, English), “Chats” on the phone tab (`phoneChats`, English), “Samtaler” on the Danish rail, and “Chats” on the Danish phone tab. The calls row under that list said “Åbn chat” in Danish. PR #340 left the Danish tab as “Chats” because a test expected that spelling.
- **Fix:** English is “Chats” in both places (`uiTracks` and `phoneChats`, `src/appCopy.ts`). Danish is “Samtaler” in both places, and the calls row is “Åbn samtale” (`phoneOpenChat`). The rail name is `Shell.tsx` (`aria-label={tr(props.phone ? 'phoneChats' : 'uiTracks')}`).

### 2. Danish setup quotes an English button, and the wrong Danish one

- **Screen:** Phone onboarding, after “De er ikke ens”
- **Severity:** Medium
- **What:** The owner’s refusal button is “Words differ” / “Ordene er forskellige” (`obWordsDiffer` in `src/onboarding/onboardingCopy.ts`). The phone’s own button is “They don't match” / “De er ikke ens”. The Danish stopped line was `“Words differ”: Ordene er ikke ens.` (`phoneCopy.ts`), so it showed an English label and a gloss that is the phone’s button, not the button on the other device.
- **Fix:** The Danish line is `Vælg også “Ordene er forskellige” der.` The English line stays `Choose “Words differ” there too.` The two English phrases for the same refusal are still finding 12 from 23 Oct.

### 3. The notification prompt says you will hear the message

- **Screen:** Settings → General, notifications
- **Severity:** Medium
- **What:** #341 asks for permission with “to hear incoming paid messages” and “controls delivery and sound”. Danish said “høre” and “visning og lyd”. The alert body is `notificationMessage` (“{0} sent you a message” / “{0} har sendt dig en besked”) plus the system sound (`messageNotifications.tsx`). The message text is not in the alert, and the app does not promise the sound will play.
- **Fix:** Both languages say the system decides whether a notification appears and whether it makes a sound, and that the alert shows the sender’s name, not the message (`notificationReason`, `notificationGranted` in `src/appCopy.ts`).

### 4. A disabled send says “Node grant limit”

- **Screen:** Composer, when the node’s per-payment cap is too small; the spend line under it
- **Severity:** Medium
- **What:** The disabled reason and the file/pay label were “Node grant limit” / “Nodens tilladelsesgrænse” (`uiNodeGrantLimit`). The English spend line said “spend grant” and “a new grant” (`uiYourNodeSSpendGrantCannotCoverThis`, `uiPerPaymentAskYourNodeSOwnerFor`). Danish already said “betalingstilladelse” and “ny tilladelse”.
- **Fix:** The short label is “Over the limit” / “Over tilladelsen”. The English sentence is “Your node’s spending limit cannot cover this payment” and “a new spending limit.”

### 5. Danish budget sentences still contain the English word “limit”

- **Screen:** Budget and the app spending window
- **Severity:** Medium
- **What:** After #338, these Danish sentences still said “døgnlimit”, “applimit”, “betalingslimit”, and “samlede limit”. The same ideas in `controlCopy.ts` already use “grænse”.
- **Fix:** Those words are “døgnsgrænse”, “appgrænse”, “betalingsgrænse”, and “samlede grænse” (`src/appCopy.ts`, the Danish entries for the all-in and reserve sentences).

### 6. The pair step says “Forbind” where every other pair step says “Par”

- **Screen:** First-run progress, the pair pip (screen-reader prefix)
- **Severity:** Low
- **What:** `obPairApp` was “Forbind denne app”. The rest of pairing uses “Par” (“Par en anden node”, “Par denne {0} med din node”, “Denne app er parret”). “Forbind” is the word for the network connection, a different step.
- **Fix:** “Par denne app”. English stays “Pair this app”.

### 7. The node pip is still English in Danish

- **Screen:** First-run progress, the node pip (screen reader only)
- **Severity:** Low
- **What:** `obStartNode` was “Start node” in both languages. The visible label on that pip is read with the pair step; the node words are `sr-only`.
- **Fix:** Danish is “Start noden”. English stays “Start node”.

### 8. The Android nearby line drops “in Settings”

- **Screen:** Phone onboarding, local-network error on Android
- **Severity:** Low
- **What:** English is “Allow Nearby devices in Settings.” The Danish line was “Tillad Enheder i nærheden.” The iOS line and the button under it already name Settings. Android shows this line (`PhoneOnboarding.tsx`, `local_network`).
- **Fix:** “Tillad Enheder i nærheden i Indstillinger.”

## Left as findings

### 9. Settings calls the same tab “Body” and “Tilstand”

- **Screen:** Settings tabs
- **Severity:** Low
- **What:** `uiBody` is “Body” in English and “Tilstand” in Danish (`src/appCopy.ts`). The tab is the organism view; `docs/CONTROL_CENTER_ORGANISM.md` names it “the Body tab”. The other tabs match (“Wallet” / “Tegnebog”, “Devices” / “Enheder”). “Tilstand” is a plain word and does not mean “body”.
- **Fix:** Not changed. Renaming the product tab needs the product owner.

### 10. Deeper English budget copy still says “grant” and “all-in”

- **Screen:** Budget, node spending, first spend
- **Severity:** Low
- **What:** The send-limit sentence in finding 4 is plain. These are still in English, with Danish already on “tilladelse” or “grænse”: “Spend grant stale…” (`uiSpendGrantStaleCheckingYourNodeAutoPay`), “owner grant” (`uiYourNodeSOwnerGrantIsInEffect`), and the “all-in limit” sentences (`uiAppAllInPaymentsLimitRolling24Hours` and the neighbouring reserve and raise lines). “keysend” stays in both languages as the protocol word. First-spend “msat” is finding 11 from 23 Oct.
- **Fix:** Not changed. Those sentences are the owner’s budget explanation; shortening them is a product pass.

## Checked and left alone

- Phone tabs at 320px, four Danish labels (“Samtaler”, “Opkald”, “Tegnebog”, “Dig”) and three at 360px: each tab is at least 44px and the row does not scroll sideways. `phone-tabs` already wraps (`white-space: normal`).
- Message send titles at 320px (“Send”, “Godkend med Touch ID”, “Godkend med biometri”, “Genoptag betalinger”, “Godkend og send”, and the English Touch ID and biometrics labels) sit on the second composer row (`.signal-bar` gives the text its own row under 480px) and stay inside the row at 44px tall.
- “Venter på kontaktgodkendelse” on a pay row at 320px iOS is fully visible (about 281px). The cost beside it collapses, and the row’s scroll width is about 3px over its client width. Letting that button shrink onto two lines hid the cost completely, so the label was left as the sentence that says why Pay is disabled. The page itself does not scroll sideways.
- “Waiting for contact approval”, “Venter på din anden enhed”, and “Betaling er utilgængelig” fit that same pay row. “Godkend med Touch ID” fits the message row at 360px.
- Assistant examples (`caDraftAMessageToMaya` and the other typed examples) stay English. The Danish wrapper already says those commands are English for now.
- “Sats”, “Send”, “Ring”, “Offline”, “Budget”, and “Node” are the same spelling in Danish. They are the unit, the verb, or the product word already used across both tables. The Settings tab “Node” was left as that product word.

## Still open from earlier reports

Re-checked where the line is still in the tree. Layout items from 23 Oct were not re-shot. PR #340’s layout fixes are on its own draft branch and are not in `805a064`.

| From | Severity | Still true |
| --- | --- | --- |
| 20 Oct #20 | Medium | `.stream` is not a keyboard scroll region. `npm run a11y` still disables `scrollable-region-focusable`. |
| 20 Oct #22 | Medium | Desktop `.track-link .name` still ellipsizes at the end. |
| 20 Oct #23 | Low | Location radio stays 11px. The approvals badge stays 11px. |
| 20 Oct #24 | Low | Touch ID check glyph stays 10px. |
| 23 Oct #9 | Low | `button:disabled { opacity: 0.5 }` remains outside the sheets and phone onboarding. |
| 23 Oct #10 | Low | A soft button’s edge is still under 3:1. The label is `--ink`. |
| 23 Oct #11 | Low | First spend still says “Approve at your box”, “App budget presets”, and “msat” for a fractional amount. |
| 23 Oct #12 | Low | English “They don't match” and “Words differ” are still the same refusal. Danish now names “Ordene er forskellige” (finding 2). |
| 23 Oct #13 | Low | Starter balance still says “The hub funds…” and “Channel opening” / “Kanalen åbnes”. |
| 23 Oct #14 | Low | The approval sheets are still not their own keyboard scroll stop. |
| 22 Oct #8 | Low | Settings tabs still scroll under the cut edge at a phone width. |
| 22 Oct #9 | Medium | Unresolved-call repair is still a paragraph plus “Check repair / acknowledge”. |
| 22 Oct #10 | Medium | Add a device is still several sentences. |
| 22 Oct #11 | Medium | Desktop first run is still a lede and location cards. |
| 22 Oct #12 | Low | The recovery sentence is still on the call card for every phase except ended. |
| 22 Oct #13 | Low | Welcome home is still three actions. |
| 22 Oct #14 | Low | “A phone should not be your only owner device.” is still the only-owner hint, including on an iPad. |
| PR #340 | Medium | Empty phone Chats still shows the desktop rail, not the welcome. On that draft branch, not on `main`. |
| PR #340 | Low | The offline card is a checklist, and the pill can name the outage differently. On that draft branch. |

Done on that draft, and not repeated here: call cards under the tabs, the phone “+” covering the sample tag, offline Retry below the fold, the 180px pill wrap, and wallet chips wrapping. The Danish phone tab “Chats” from that report is finding 1 above.

## Local check

Commands run in this VM against the change. No Rust sources were edited, so `cargo check` and `cargo test` were not run. No workflow files were edited. `npm run a11y` is local Playwright against `npm run dev` on port 1421; it is not a GitHub Actions workflow.

- `npx tsc --noEmit` — exit 0.
- `npm run build` (`tsc --noEmit` again, then Vite) — exit 0. The bundle warns that `main` is over 500 kB (737.19 kB); that warning was already there.
- Focused Vitest (phone shell, phone onboarding, message notifications, onboarding language, control budget, Danish copy, i18n source guard, onboarding copy, phone layout) — 10 files, 282 passed.
- `npm run a11y` — 125 passed, 15 failed. Fourteen are `tests/a11y/phone-shell.spec.ts`: the config uses desktop Chrome at 1280×820 and does not set an iPhone user agent, so `createPhoneLayout()` keeps the desktop rail (`navigation "Chats"` after this change) and `[data-phone-tabs]` is absent. The same harness with an iPhone user agent shows the Danish tabs. One failure is `tests/a11y/routes.spec.ts` (“emoji picker and the body energy table are valid aria”): the energy figure’s computed `font-size` is `14px` and the token is `0.875rem`. That comparison does not depend on these strings.
- Chrome, iPhone user agent, the phone-shell harness at 320px: Danish tabs are “Samtaler”, “Tegnebog”, “Dig”, each 104×44, list name “Samtaler”, no sideways page scroll. English tabs are “Chats”, “Wallet”, “You”. A desktop sample with `bitsov.language=da` names the rail “Samtaler”. Settings tabs read “Generelt”, “Tilstand”, “Node”, “Enheder”, “Tegnebog”, “Budget”, “Profil”. Forcing a fourth tab label “Opkald” into that 320px row keeps every word fully visible and does not scroll the page.
