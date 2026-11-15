# Plain-language sweep

Status: proposal only. No copy has changed. Each row needs a decision; nothing here should ship as a batch without a read by a native Danish speaker. Keys are in `src/appCopy.ts` and `src/controlCopy.ts`.

The aim is that someone who has never heard of a node, a channel or a routing fee can read the main screens. Where a word is needed for support, it stays behind Details.

## Rules for this sweep

- A replacement must stay true. Money wording says only what the code keeps. If in doubt, say less.
- "Nothing was paid" and "up to" keep their meaning exactly.
- Commands, addresses and codes stay as they are.
- Technical words stay available in Details and in reports.

## Decision for the owner: boks or node

The app says both today, sometimes on the same screen: "Din boks skal sige ja først" beside "Noden kører" and "Denne node understøtter ikke rum endnu". By a rough count the two copy files have about 680 strings with node or Node, and a much smaller number with box or boks.

| | A. "boks" / "box" | B. "node" |
|---|---|---|
| For | A thing you can picture. Already used in the phone onboarding and the newer call copy. Says nothing about how it works | The accurate word. Used in the docs, commands and logs. No rewording needed |
| Against | Odd when it is software on a Mac or a hosted service. A large copy change that needs review | Means nothing to a newcomer, and in Danish is plainly a technical word |
| Cost | About 680 strings to read through, in two languages, with tests | The newer "boks" copy has to be changed back |

**Recommendation: A, "boks" / "box", everywhere a person reads it.** Keep "node" only in Details, reports, commands and developer screens. For a node on this computer, say "BitSov på denne Mac" where "boks" would mislead. Do it as one separate change, after the open copy PRs have merged, so that reviews don't collide.

The proposals below use "boks". If the owner picks B, read "node" in each.

## Words on the main screens

| Today (Danish) | Today (English) | Key | Where | Proposed Danish | Proposed English | Note |
|---|---|---|---|---|---|---|
| Loft for signalomkostninger: | Signal cost cap: | `uiSignalCostCap` | Call card | Opkaldets opsætning koster højst: | Setting up the call costs at most: | The money reviewer should confirm "at most" holds for this figure |
| routinggebyrer, routinggebyr | routing fees, routing fee | `uiUpToIncludesMaxRoutingFee` and about 25 others | Cost lines | netværksgebyr | network fee | Same word as the receipts. In Details, name the routing fee once |
| Medier faktureres ikke. | Media is not billed. | Inside `uiUpToToRingTheirCallPricePlus` and one other | Call card | Selve samtalen koster ikke ekstra. | The conversation itself costs nothing extra. | **Only for calls with no paid minutes.** Node-routed calls pay per minute, so there it must not be said at all |
| skrivebeskyttet | read-only | `uiReadOnly` | Rail, beside assistants | kan kun læse | can only read | Consider dropping it from the rail and saying it inside the assistant |
| der er endnu intet vagttårn | there is no watchtower yet | `uiYourHomeNodeMustStayOnlineToMonitor` | Wallet | Din boks skal være tændt for at passe på dine penge. | Your box must stay on to look after your money. | The watchtower goes behind Details. Reviewer: check this isn't a stronger promise than today's |
| Din hjemmenode skal være online for at overvåge og beskytte dine Lightning-kanaler | Your home node must stay online to monitor and protect your Lightning channels | Same key | Wallet | See the row above | See the row above | Same sentence |
| Kontrollér afventende resultat | Check pending result | `uiCheckPendingResult390` and about 22 others | Message cards, approval | Tjek, om betalingen gik igennem | Check whether the payment went through | Where the check is not about one payment: "Tjek, om en betaling venter" |
| netværksgebyr ikke oplyst | network fee not reported | `uiNetworkFeeNotReported` | Every sent message without a fee | Move to the message's details. Keep it on the receipt if any review requires it | Same | #428 removed a phone-only hiding of this after review, so this needs the money reviewer's agreement |
| Kontakt uden navn (aaaaaaaa…aaaaaaaa) | Unnamed contact (aaaaaaaa…aaaaaaaa) | `extraUnnamedContact` | Chat title, call screen, rail | Ny kontakt, with a button: Giv et navn | New contact, with a button: Add a name | The id moves to Details. Two unnamed contacts must stay apart: add a short ending such as "Ny kontakt · aaaa" only then |
| Noden kører, genopretter liveforbindelsen | Node up, live feed reconnecting | `uiNodeUpLiveFeedReconnecting` | Status pill | Forbinder igen… | Reconnecting… | The pill should be short. Details says the rest |
| Noden kører | Node running | `uiNodeRunning` | Status pill | Din boks kører | Your box is running | |
| Denne node understøtter ikke rum endnu. | This node does not support rooms yet. | `uiThisNodeDoesNotSupportRoomsYet` | Rail | Din boks kan ikke lave rum endnu. Den skal opdateres. | Your box can't do rooms yet. It needs an update. | Only if an update is really what's needed |
| Deres Lightning-betalingsadresse er utilgængelig. Din node skal oplyse den, før du kan betale denne kontakt. | Their Lightning payment address is unavailable. Your node must report it before you can pay this contact. | `uiTheirLightningPaymentAddressIsUnavailableYourNode` | Pay | Du kan ikke betale denne kontakt direkte lige nu. Prøv igen senere. | You can't pay this contact directly right now. Try again later. | Details keeps the reason |
| Udgående kapacitet … routinggebyrer, HTLC-grænser og modpartens likviditet | Outbound capacity … routing fees, HTLC limits and the peer's liquidity | `uiOutboundCapacityNotAGuaranteeAPaymentOf` | Wallet | Det er ikke sikkert, at en betaling af denne størrelse kan gå igennem. | A payment this size may not go through. | The technical causes go behind Details |
| Ingen STUN-server er valgt | No STUN server is chosen | About 20 keys with STUN | Call card, settings | Opkald virker måske kun på samme netværk. Se Indstillinger. | Calls may only work on the same network. See Settings. | Lab path only: a node-routed call doesn't show it. Settings keeps the word |
| Tegnebog skrivebeskyttet, Indbakke skrivebeskyttet | Wallet read-only, Inbox read-only | Assistant names with `uiReadOnly` | Rail | See "skrivebeskyttet" | Same | |
| reservation, Bekræft reservation | hold, Confirm hold | Keys with `caMinutes` and `uiMinutes` | Call card | Beløb sat til side til opkaldet / Godkend beløbet | Set aside for this call / Approve the amount | Money reviewer: must still say it can be released |
| fingeraftryk | fingerprint | About 3 keys | Pairing, Details | sikkerhedskode | security code | Avoid confusion with Touch ID |

## Not in this sweep

- "Send · 6 sats" on the file button against "betalt 1 sat" on the message: with the money reviewer.
- Accept and Decline showing no amount: waiting for the money PR.
- Error text from the host: covered by the Danish table in the host-copy PRs. It says "boks", so option B would change that table too.
- Everything behind Details, in developer screens and in commands.

## What to test

Nobody who has never used a terminal has read these words. Before shipping, read the proposed wording aloud with someone new to the app, on a phone, in Danish, and note where they stop.
