# BitSov App Review notes / Noter til App Review

## English — text for App Review

BitSov is a non-custodial remote control for the user's own Lightning node.
The node holds the wallet keys and executes payments. The phone is a client,
not a Lightning node. On Mac, the user can also run their own local node.
MindLink does not hold the user's funds. A user who chooses a third-party
node host must trust that host, as explained in onboarding.

For paid messages, 100% of the per-message sats go to the recipient's node.
Lightning routing fees are separate, and a recipient can also require an
admission payment. The app sends instructions to the user's node; payments
go node to node. There are no in-app purchases, app credits, paid feature
unlocks or project revenue in the app. Spending approvals authorize the
user's node to spend their own funds; they are not purchases of app access.
An optional, user-configured remote AI provider can bill the user's own
provider account outside the app; MindLink receives no share.

The iOS background audio mode is used only for live calls, including
reconnection of an existing live call. It is released when the call ends.
The app does not play silent audio to keep running. It does not provide
VoIP push or CallKit incoming-call delivery. Camera access is for pairing
QR scanning and video calls; microphone access is for voice notes and
calls. Call connectivity depends on the network and configured STUN server;
universal connectivity is not claimed.

The privacy policy will be linked during onboarding and under
Settings → General before submission (not yet in this build). The app contains no analytics or tracking SDKs.
Optional remote AI requires previewing and explicitly sending a request.
Contact: **[review contact address — set before submission]**.

### Demo-node access — fill out of band, never commit credentials

Provide the following privately in App Store Connect for the submitted
build. This section deliberately contains no working credentials. Do not
replace these placeholders in the repository.

- Demo node endpoint and build/network: **[provide privately]**
- Current pairing QR/link, expiry and renewal instructions: **[provide privately]**
- Expected node fingerprint/comparison words and owner approval steps:
  **[provide privately]**
- Prefunded demo balance and spending approval instructions, without
  wallet recovery words or private keys: **[provide privately]**
- Recipient demo contact and steps for a small paid message and a live call
  on a tested network: **[provide privately]**
- Review support contact/availability: **[provide privately]**

On the phone, start onboarding and scan the supplied pairing QR, or use
Other options → Paste link. Follow the comparison and owner-approval flow
for the supplied demo node, then acknowledge the host-trust notice. Use
the supplied recipient and spending approval to review a message payment.
Call testing needs another participant and a tested network. The supplied
instructions must match the actual submitted build and node capabilities.

## Dansk — tekst til App Review

BitSov er en fjernbetjening uden depotfunktion til brugerens egen
Lightning-node. Noden opbevarer wallet-nøglerne og udfører betalinger.
Telefonen er en klient, ikke en Lightning-node. På Mac kan brugeren også
køre sin egen lokale node. MindLink opbevarer ikke brugerens penge. En
bruger, som vælger en ekstern vært til noden, skal stole på værten, som
forklaret under opsætningen.

Ved betalte beskeder går 100 % af betalingen pr. besked til modtagerens
node. Lightning-routinggebyrer er særskilte, og modtageren kan også kræve
en adgangsbetaling. Appen sender instruktioner til brugerens node;
betalinger går fra node til node. Der er ingen køb i appen, appkreditter,
betalte funktionsoplåsninger eller projektindtægter i appen.
Forbrugsgodkendelser tillader noden at bruge brugerens egne penge; de er
ikke køb af adgang til appen. En valgfri ekstern AI-udbyder, som brugeren
selv konfigurerer, kan fakturere brugerens egen udbyderkonto uden for
appen; MindLink modtager ingen andel.

iOS-baggrundslyd bruges kun til aktive opkald, herunder genoprettelse af
et eksisterende aktivt opkald. Lydsessionen frigives, når opkaldet slutter.
Appen afspiller ikke lydløs lyd for at fortsætte i baggrunden. Den tilbyder
ikke VoIP-push eller levering af indgående opkald gennem CallKit.
Kameraadgang bruges til parrings-QR og videoopkald; mikrofonadgang bruges
til talebeskeder og opkald. Forbindelsen afhænger af netværket og den
konfigurerede STUN-server; universel forbindelse loves ikke.

Privatlivspolitikken linkes under opsætningen og i
Indstillinger → Generelt før indsendelse (endnu ikke i denne build). Appen indeholder ingen analyse- eller
sporings-SDK'er. Valgfri ekstern AI kræver forhåndsvisning og udtrykkelig
afsendelse af en anmodning.
Kontakt: **[kontaktadresse til review — angives før indsendelse]**.

### Adgang til demonode — udfyld særskilt, gem aldrig legitimationsoplysninger i Git

Oplys følgende privat i App Store Connect for den indsendte build. Dette
afsnit indeholder bevidst ingen brugbare legitimationsoplysninger.
Erstat ikke pladsholderne i repositoriet.

- Demonodens adresse og build/netværk: **[oplyses privat]**
- Aktuel parrings-QR/link, udløb og vejledning til fornyelse: **[oplyses privat]**
- Forventet nodefingeraftryk/sammenligningsord og trin til ejerens
  godkendelse: **[oplyses privat]**
- Indsat demosaldo og vejledning til forbrugsgodkendelse, uden
  gendannelsesord eller private nøgler: **[oplyses privat]**
- Demokontakt som modtager og trin til en lille betalt besked og et aktivt
  opkald på et afprøvet netværk: **[oplyses privat]**
- Supportkontakt og tilgængelighed under review: **[oplyses privat]**

Start opsætningen på telefonen og scan den udleverede parrings-QR, eller
brug Andre muligheder → Indsæt link. Følg sammenligningen og ejerens
godkendelse for demonoden, og bekræft derefter tilliden til værten. Brug
den udleverede modtager og forbrugsgodkendelse til at gennemgå en
beskedbetaling. Opkald kræver en anden deltager og et afprøvet netværk.
Vejledningen skal passe til den faktisk indsendte build og nodens funktioner.

## Submission checks / Kontrol før indsendelse

These notes describe current code, not a completed App Store release.
Publish the policy at the path specified in [privacy-policy.md](privacy-policy.md)
and supply working demo access privately before submission. The policy's
maintainer table records the data-handling sources. The iOS audio lifecycle
is in `src/control/call.ts`, `src-tauri/native/call_audio.swift` and
`src-tauri/Info.ios.plist`, with headless coverage in
`src-tauri/tests/ios_call_audio.rs`. Purchase/revenue claims were checked
against app dependencies and payment entry points in `src-tauri/src/app.rs`
and `src-tauri/src/act.rs`; there is no StoreKit/IAP integration or project
commission in those paths. Network-wide fee policies belong to the nodes.

Noterne beskriver den nuværende kode, ikke en færdig App Store-udgivelse.
Udgiv politikken på stien i [privacy-policy.md](privacy-policy.md), og
udlever fungerende demoadgang privat før indsendelse. Politikkens
kontroltabel angiver kilderne til databehandlingen. iOS-lydforløbet findes
i `src/control/call.ts`, `src-tauri/native/call_audio.swift` og
`src-tauri/Info.ios.plist` og testes uden appvindue i
`src-tauri/tests/ios_call_audio.rs`. Oplysninger om køb og indtægter er
kontrolleret mod appens afhængigheder og betalingsfunktionerne i
`src-tauri/src/app.rs` og `src-tauri/src/act.rs`; disse forløb har ingen
StoreKit/IAP-integration eller projektkommission. Nodernes egne regler
bestemmer netværksgebyrerne.
