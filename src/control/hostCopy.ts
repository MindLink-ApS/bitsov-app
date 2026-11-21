import { language } from '../i18n';
import { HOST_COPY_MONEY_DA } from './hostMoneyCopy';

/**
 * Danish for the host's refusals, matched on the host's exact English text.
 * `{}` stands for a value the host filled in. Danish `{0}`, `{1}` take them in
 * order, as they came. Text not
 * listed here stays as the host wrote it, so a sentence about money is never
 * guessed. English is always the host's own text.
 * `tests/host-copy.test.ts` checks this list against the host's source.
 */
export const HOST_COPY_DA: readonly (readonly [string, string])[] = [
  ...HOST_COPY_MONEY_DA,
  ['No app storage.', 'Appen har ikke sit lager klar.'],
  ['Your box’s approval ends before this call could end, and the call would stop there. Nothing was sent or paid. Ask the person who set up your box for a new approval.', 'Godkendelsen fra din boks udløber, før opkaldet kan nå at slutte, så opkaldet ville stoppe der. Intet blev sendt eller betalt. Bed den, der har sat din boks op, om en ny godkendelse.'],
  ['The day’s budget could not be read yet. Nothing was sent.', 'Dagens budget kunne ikke læses endnu. Intet blev sendt.'],
  ['The app could not update its own files. Nothing was sent.', 'Appen kunne ikke opdatere sine egne filer. Intet blev sendt.'],
  ['No node identity.', 'Din boks har ingen identitet endnu.'],
  ['Not authenticated.', 'Du er ikke logget ind.'],
  ['The app data directory is not ready.', 'Appens datamappe er ikke klar.'],
  ['This app is not paired with a node.', 'Denne app er ikke parret med en boks.'],
  ['Your node is not signed in yet.', 'Din boks er ikke logget ind endnu.'],
  ['The request changed after it was shown. Nothing was signed.', 'Anmodningen blev ændret, efter den blev vist. Intet blev underskrevet.'],
  ['Invalid approval operation id.', 'Godkendelsen har et ugyldigt id.'],
  ['Invalid owner approval request.', 'Ugyldig anmodning om ejerens godkendelse.'],
  ['This pairing cannot approve its own request.', 'Denne parring kan ikke godkende sin egen anmodning.'],
  ['You have used {} of {} for {} in the last 24 hours, and this costs {}. Raise the budget to send.', 'Du har brugt {0} af {1} til {2} de seneste 24 timer, og dette koster {3}. Hæv budgettet for at sende.'],
  ['Too many unresolved sends to track another one. Check the pending results first.', 'For mange uafklarede afsendelser til at følge en til. Kontrollér de afventende resultater først.'],
  ['Spending was paused or locked while your approval was being opened. Nothing was opened; approve it again.', 'Betalinger blev sat på pause eller låst, mens din godkendelse blev åbnet. Intet blev åbnet; godkend igen.'],
  ['Your budget approval changed while sending. Nothing was sent; approve it again.', 'Din budgetgodkendelse blev ændret under afsendelsen. Intet blev sendt; godkend igen.'],
  ['Payments are paused. Resume them first.', 'Betalinger er sat på pause. Genoptag dem først.'],
  ['Payments are paused. Resume them to prepare the gift.', 'Betalinger er sat på pause. Genoptag dem for at gøre gaven klar.'],
  ['Payments are paused. Resume them to send.', 'Betalinger er sat på pause. Genoptag dem for at sende.'],
  ['Your budget file could not be read or written ({}). Automatic payments are off.', 'Din budgetfil kunne ikke læses eller skrives ({0}). Automatiske betalinger er slået fra.'],
  ['Your node expects another minute of this call. Nothing was paid for this one.', 'Din boks venter et andet minut af dette opkald. Intet blev betalt for dette.'],
  ['Too many calls are still open at your node. Nothing was paid.', 'For mange opkald er stadig åbne på din boks. Intet blev betalt.'],
  ['Too many earlier calls are still open or settling at your node. End them, or wait a moment, then call again. Nothing was paid.', 'For mange tidligere opkald er stadig åbne eller ved at blive afregnet på din boks. Afslut dem, eller vent lidt, og ring så igen. Intet blev betalt.'],
  ["Your node's hold for this call is not the one you confirmed. Nothing was paid; check the hold and confirm again.", 'Din boks’ reservation til dette opkald er ikke den, du bekræftede. Intet blev betalt; tjek reservationen, og bekræft igen.'],
  ["Confirm your node's hold for this call before its first minute is paid. Nothing was paid.", 'Bekræft din boks’ reservation til dette opkald, før det første minut betales. Intet blev betalt.'],
  ["Your node has not accepted this call's offer yet, so its hold cannot be checked. Nothing was paid.", 'Din boks har ikke taget imod opkaldets tilbud endnu, så reservationen kan ikke tjekkes. Intet blev betalt.'],
  ['This call belongs to another node identity. Nothing was paid.', 'Dette opkald hører til en anden boks’ identitet. Intet blev betalt.'],
  ['This call record belongs to another node identity. Nothing was acknowledged or paid.', 'Denne opkaldspost hører til en anden boks’ identitet. Intet blev kvitteret eller betalt.'],
  ["Your node's channel cannot hold this call's reservation right now. Nothing was paid. If your node just restarted, wait a minute and call again. If this keeps happening, add outbound capacity.", 'Din boks’ kanal kan ikke rumme reservationen til dette opkald lige nu. Intet blev betalt. Hvis din boks lige er genstartet, så vent et minut og ring igen. Hvis det bliver ved, så tilføj udgående kapacitet.'],
  ['They’re offline. Nothing was sent or paid.', 'De er offline. Intet blev sendt eller betalt.'],
  ["Your node could not check whether its channel can hold this call's reservation. Nothing was paid. Try again shortly.", 'Din boks kunne ikke tjekke, om kanalen kan rumme reservationen til dette opkald. Intet blev betalt. Prøv igen om lidt.'],
  ["This app is signed in to your node as its owner, not paired with a spending grant. Your node then keeps no reservation for a call's minutes, so the app cannot pay them. Pair the app with a spending grant to make calls. Nothing was paid.", 'Denne app er logget ind på din boks som ejer og ikke parret med et forbrugsbudget. Så holder din boks ingen reservation til et opkalds minutter, og appen kan ikke betale dem. Par appen med et forbrugsbudget for at ringe. Intet blev betalt.'],
  ['Calls go to contacts you have already paid. Send them a message first. Nothing was paid.', 'Du kan ringe til kontakter, du allerede har betalt. Send dem en besked først. Intet blev betalt.'],
  ['Upgrade your node before making calls: it cannot track call payments and admission safely. Nothing was paid.', 'Opdater din boks, før du ringer: den kan ikke følge opkaldsbetalinger og adgang sikkert. Intet blev betalt.'],
  ['Nothing was paid.', 'Intet blev betalt.'],
  ['This app holds no per-minute price you agreed to for this call, so it pays none of its minutes. Nothing was paid.', 'Appen har ingen minutpris, du har accepteret for dette opkald, så den betaler ingen af minutterne. Intet blev betalt.'],
  ['No outgoing admission is recorded for this call.', 'Der er ikke registreret nogen udgående adgang for dette opkald.'],
  ['No outgoing admission is recorded for this identity.', 'Der er ikke registreret nogen udgående adgang for denne identitet.'],
  ['No outgoing admission is recorded.', 'Der er ikke registreret nogen udgående adgang.'],
  ['This admission has ended. Nothing was dispatched.', 'Denne adgang er afsluttet. Intet blev sendt af sted.'],
  ['This call has ended. Nothing more was paid.', 'Dette opkald er afsluttet. Intet mere blev betalt.'],
  ['Your node has ended this call. Nothing more was paid.', 'Din boks har afsluttet dette opkald. Intet mere blev betalt.'],
  ['Your node no longer lists this call. Nothing more was paid.', 'Din boks viser ikke længere dette opkald. Intet mere blev betalt.'],
  ["Your node would hold more for this call's minutes than you agreed to, so it did not place the call. Nothing was sent, held or paid.", 'Din boks ville reservere mere til opkaldets minutter, end du har accepteret, så den ringede ikke op. Intet blev sendt, reserveret eller betalt.'],
  ["This call's offer was already sent to your node. Nothing more was paid.", 'Opkaldets tilbud er allerede sendt til din boks. Intet mere blev betalt.'],
  ['Their node now asks more per minute than you agreed to, so your node did not place the call. Nothing was sent, held or paid. Check the price and call again.', 'Deres boks beder nu om mere pr. minut, end du har accepteret, så din boks ringede ikke op. Intet blev sendt, reserveret eller betalt. Tjek prisen, og ring igen.'],
  ['Their node now asks more per minute than this call reserved. Nothing more was paid.', 'Deres boks beder nu om mere pr. minut, end dette opkald har reserveret. Intet mere blev betalt.'],
  ['Their per-minute price is no longer the one you agreed to. Nothing was sent or paid; check the price and call again.', 'Deres minutpris er ikke længere den, du accepterede. Intet blev sendt eller betalt; tjek prisen, og ring igen.'],
  ["Your node has closed this call's reservation. Nothing more was paid.", 'Din boks har lukket reservationen til dette opkald. Intet mere blev betalt.'],
  ['Their node does not take calls yet (no call price advertised). Nothing was paid.', 'Deres boks tager ikke imod opkald endnu (den oplyser ingen opkaldspris). Intet blev betalt.'],
  ['The call price is unavailable. Read it again before requesting a call budget.', 'Opkaldsprisen er ikke tilgængelig. Hent den igen, før du beder om et opkaldsbudget.'],
  ['You have used {} of your {} app all-in payment limit (rolling 24 hours), and this costs {}. Raise the limit to send.', 'Du har brugt {0} af appens samlede betalingsgrænse på {1} (seneste 24 timer), og dette koster {2}. Hæv grænsen for at sende.'],
  ['Strong biometric approval is not available on this phone right now (none enrolled, unavailable, or locked out). Nothing was approved. Ask the person who set up your box to approve it there instead.', 'Stærk biometrisk godkendelse er ikke tilgængelig på denne telefon lige nu (ikke sat op, utilgængelig eller låst). Intet blev godkendt. Bed den, der har sat din boks op, om at godkende det der i stedet.'],
  ['Touch ID or Face ID is not available on this device right now (not enrolled, or locked out after failed tries). Nothing was approved. Ask the person who set up your box to approve it there instead.', 'Touch ID eller Face ID er ikke tilgængelig på denne enhed lige nu (ikke sat op, eller låst efter mislykkede forsøg). Intet blev godkendt. Bed den, der har sat din boks op, om at godkende det der i stedet.'],
  ['Biometric approval (Touch ID or Face ID) was cancelled. Nothing was approved.', 'Biometrisk godkendelse (Touch ID eller Face ID) blev annulleret. Intet blev godkendt.'],
  ['Biometric approval was cancelled. Nothing was approved.', 'Biometrisk godkendelse blev annulleret. Intet blev godkendt.'],
  ["This device's approval key no longer works (for example, the enrolled fingerprints or face changed). Set up biometric approvals again.", 'Denne enheds godkendelsesnøgle virker ikke længere (for eksempel fordi fingeraftryk eller ansigt er ændret). Sæt biometrisk godkendelse op igen.'],
  ["This phone's approval key no longer works (for example, biometric enrollment changed). Set up biometric approvals again.", 'Denne telefons godkendelsesnøgle virker ikke længere (for eksempel fordi den biometriske opsætning er ændret). Sæt biometrisk godkendelse op igen.'],
  ['Android Keystore refused ({}). Nothing was approved.', 'Android Keystore afviste ({0}). Intet blev godkendt.'],
  ['The Secure Enclave refused ({}). Nothing was approved.', 'Secure Enclave afviste ({0}). Intet blev godkendt.'],
  ['Could not access the protected device key: {}', 'Kunne ikke få adgang til enhedens beskyttede nøgle: {0}'],
  ['Could not save the device key record: {}', 'Kunne ikke gemme enhedens nøgleoplysninger: {0}'],
  ['Creating the key stopped unexpectedly.', 'Oprettelsen af nøglen stoppede uventet.'],
  ['Invalid device public key record.', 'Enhedens offentlige nøgle er ugyldig.'],
  ['The biometric request stopped unexpectedly.', 'Den biometriske anmodning stoppede uventet.'],
  ['The setup biometric request stopped.', 'Den biometriske anmodning under opsætningen stoppede.'],
  ['This Mac could not produce a random nonce.', 'Denne Mac kunne ikke lave et tilfældigt engangstal.'],
  ["Your node can't take device approvals over remote access yet. Nothing was approved. Update your node, or approve at the node.", 'Din boks kan ikke tage imod enhedsgodkendelser over fjernadgang endnu. Intet blev godkendt. Opdater din boks, eller godkend på boksen.'],
  ['This device has no Secure Enclave the app can use. Approve at the node instead.', 'Denne enhed har ingen Secure Enclave, appen kan bruge. Godkend på boksen i stedet.'],
  ['This phone has no hardware-backed Android Keystore key the app can use. Approve at the node instead.', 'Denne telefon har ingen hardwarebeskyttet Android Keystore-nøgle, appen kan bruge. Godkend på boksen i stedet.'],
  ['This node version does not take device approvals. Approve at the node instead.', 'Denne version af boksen tager ikke imod enhedsgodkendelser. Godkend på boksen i stedet.'],
  ['A previous enrollment is pending. Cancel it before starting a new comparison.', 'En tidligere tilmelding venter. Annuller den, før du starter en ny sammenligning.'],
  ['This enrollment expired, was cancelled, or the node restarted. Cancel any pending setup and start again.', 'Denne tilmelding er udløbet eller annulleret, eller boksen er genstartet. Annuller eventuel ventende opsætning, og start forfra.'],
  ["Paid, and the recipient's node refused this message for good. The payment is not refundable. Do not send it again.", 'Betalt, og modtagerens boks har afvist beskeden endegyldigt. Betalingen kan ikke refunderes. Send den ikke igen.'],
  ['Your first paid message to {} needs your OK once. Nothing was sent.', 'Din første betalte besked til {0} kræver dit OK én gang. Intet blev sendt.'],
  ["Your node's spend budget has ended (expired or revoked). Nothing was sent. Ask for a new budget.", 'Din boks’ forbrugsbudget er slut (udløbet eller trukket tilbage). Intet blev sendt. Bed om et nyt budget.'],
  ["Your node's spend budget has {} left, less than this costs. Nothing was sent. Ask for a new budget.", 'Din boks’ forbrugsbudget har {0} tilbage, mindre end dette koster. Intet blev sendt. Bed om et nyt budget.'],
  ['Your node is waiting for unresolved payments before allowing more spending. Nothing was sent.', 'Din boks venter på uafklarede betalinger, før den tillader mere forbrug. Intet blev sendt.'],
  ['Your node needs your OK for this first contact, and it did not get it. Nothing was sent. Confirm the first message again.', 'Din boks skal have dit OK til denne første kontakt og fik det ikke. Intet blev sendt. Bekræft den første besked igen.'],
  ['Your node could not record the spend, so it refused. Nothing was sent. Try again shortly.', 'Din boks kunne ikke registrere forbruget og afviste derfor. Intet blev sendt. Prøv igen om lidt.'],
  ['You have not approved spending for this contact yet. Nothing was sent. Approve this contact first.', 'Du har ikke godkendt forbrug til denne kontakt endnu. Intet blev sendt. Godkend kontakten først.'],
  ['Your node accepted the approval, but its spend grant for this contact could not be confirmed. Nothing was opened; try again.', 'Din boks tog imod godkendelsen, men forbrugsbudgettet til denne kontakt kunne ikke bekræftes. Intet blev åbnet; prøv igen.'],
  ['Your node paused spending after failed payments. Nothing was sent.', 'Din boks satte forbrug på pause efter mislykkede betalinger. Intet blev sendt.'],
  ['This is more than the {} per payment your node allows. Nothing was sent.', 'Det er mere end de {0} pr. betaling, din boks tillader. Intet blev sendt.'],
  ['Too many payments this hour. Nothing was sent. Wait before trying again.', 'For mange betalinger i denne time. Intet blev sendt. Vent, før du prøver igen.'],
  ['Too many payments this minute. Nothing was sent. Wait a little before trying again.', 'For mange betalinger i dette minut. Intet blev sendt. Vent lidt, før du prøver igen.'],
  ["This contact reconnected and asks to be admitted again. Your node's budget does not cover them yet, so it needs your OK once. Nothing was sent.", 'Denne kontakt har forbundet igen og beder om adgang igen. Din boks’ budget dækker dem ikke endnu, så den skal have dit OK én gang. Intet blev sendt.'],
  ["Your node's budget for this recipient has {} left, less than this costs. Nothing was sent.", 'Din boks’ budget til denne modtager har {0} tilbage, mindre end dette koster. Intet blev sendt.'],
  ['Your node refused this under its spend budget. Nothing was sent.', 'Din boks afviste dette under sit forbrugsbudget. Intet blev sendt.'],
  ["Your node's spend budget could not be read. Nothing was sent or opened.", 'Din boks’ forbrugsbudget kunne ikke læses. Intet blev sendt eller åbnet.'],
  ["Your node can't pay this from a budget: its price isn't known before paying (an invoice without an amount, or a first contact). Nothing was sent.", 'Din boks kan ikke betale dette fra et budget: prisen kendes ikke før betalingen (en faktura uden beløb eller en første kontakt). Intet blev sendt.'],
  ['Spending is too fast for this grant. Nothing was sent. Wait before trying again.', 'Forbruget går for hurtigt for dette budget. Intet blev sendt. Vent, før du prøver igen.'],
  ["Only an enrolled owner device can add devices. This pairing or approval key is not authorized, or was revoked.", 'Kun en tilmeldt ejerenhed kan tilføje enheder. Denne parring eller godkendelsesnøgle har ikke tilladelse eller er trukket tilbage.'],
  ["Your node keeps no reservation for this call's minutes, so the app pays none of them. No minute was paid.", 'Din boks holder ingen reservation til opkaldets minutter, så appen betaler ingen af dem. Intet minut blev betalt.'],
  ['Your node reserved {} for this call ({} a minute plus up to {} routing), more than the {} ({} a minute plus up to {} routing) you agreed to before calling. No minute was paid.', 'Din boks reserverede {0} til dette opkald ({1} pr. minut plus op til {2} til routing), mere end de {3} ({4} pr. minut plus op til {5} til routing), du accepterede, før du ringede. Intet minut blev betalt.'],
  ['Another payment action is still running. Nothing was changed; try again in a moment.', 'En anden betaling er stadig i gang. Intet blev ændret; prøv igen om et øjeblik.'],
  ['Could not reach your node for owner approval.', 'Kunne ikke nå din boks for at få ejerens godkendelse.'],
  ["The device's Noise session is not connected.", 'Enhedens krypterede forbindelse er ikke oprettet.'],
  ['Your node returned an invalid grant expiry.', 'Din boks svarede med en ugyldig udløbstid for budgettet.'],
  ['Your node returned an unreadable approval response.', 'Din boks svarede med et ulæseligt godkendelsessvar.'],
  ['Your node returned an unreadable pending approval list.', 'Din boks svarede med en ulæselig liste over ventende godkendelser.'],
  ['Your node returned no approval requester.', 'Din boks oplyste ikke, hvem der beder om godkendelsen.'],
  ['Your node returned unreadable approval terms.', 'Din boks svarede med ulæselige godkendelsesvilkår.'],
  ['Your node returned unreadable breaker reset terms.', 'Din boks svarede med ulæselige vilkår for at nulstille betalingsstoppet.'],
  ['Waiting for the connection. Your node will retry automatically.', 'Venter på forbindelsen. Din boks prøver automatisk igen.'],
  ['Your node refused this retry: its text differs from the message it retries. Nothing was paid. Retry with the original text, or send it as a new message once the earlier one is resolved.', 'Din boks afviste dette nye forsøg: teksten er ikke den samme som i den oprindelige besked. Intet blev betalt. Prøv igen med den oprindelige tekst, eller send den som en ny besked, når den tidligere er afklaret.'],
  ['Contact approval expired. Get a fresh quote and request approval again. Nothing was sent.', 'Godkendelsen af kontakten er udløbet. Hent en ny pris, og bed om godkendelse igen. Intet blev sendt.'],
  ['Remote contact approval status is not available: this may be an older node, owner control may be off, or the budget operation may have ended. Check the node and request approval again. Nothing was sent.', 'Status for godkendelsen af kontakten er ikke tilgængelig: boksen kan være ældre, ejerkontrol kan være slået fra, eller budgethandlingen kan være afsluttet. Tjek boksen, og bed om godkendelse igen. Intet blev sendt.'],
  ['This contact approval was already used. Check the pending message result. Nothing was sent.', 'Denne godkendelse af kontakten er allerede brugt. Kontrollér beskedens afventende resultat. Intet blev sendt.'],
  ['Approve this contact at your node first. Nothing was sent.', 'Godkend først denne kontakt på din boks. Intet blev sendt.'],
  ['Approve this contact at your node. Nothing was sent.', 'Godkend denne kontakt på din boks. Intet blev sendt.'],
  ['The owner approval receipt is expired or does not match this contact and cap. Request approval again.', 'Ejerens godkendelse er udløbet eller passer ikke til denne kontakt og dette loft. Bed om godkendelse igen.'],
  ['This contact approval was cancelled.', 'Denne godkendelse af kontakten blev annulleret.'],
  ['This owner request ended or the budget grant changed. Cancel and request approval again.', 'Denne ejeranmodning er afsluttet, eller budgettet er ændret. Annuller, og bed om godkendelse igen.'],
  ['Waiting for your approval at the node. Nothing was sent.', 'Venter på din godkendelse på boksen. Intet blev sendt.'],
  ['This Mac is not added as an owner device yet. Ask the person who set up your box to add it; setup cannot reopen on a box that is already set up.', 'Denne Mac er ikke tilføjet som ejerenhed endnu. Bed den, der har sat din boks op, om at tilføje den; opsætningen kan ikke åbnes igen på en boks, der allerede er sat op.'],
  ['This Mac needs approval before it can approve payments. It has only what your box allows it. Ask the person who set up your box to add it; the recovery phrase cannot be shown again.', 'Denne Mac skal godkendes, før den kan godkende betalinger. Den har kun det, din boks giver den lov til. Bed den, der har sat din boks op, om at tilføje den; gendannelsesfrasen kan ikke vises igen.'],
  ["Your box allows this only from its owner, not from a paired app. Ask the person who set it up.", 'Din boks tillader kun dette fra sin ejer, ikke fra en parret app. Spørg den, der har sat den op.'],
  ["Accounted: {} msat of payment evidence, but the operation's final outcome is unknown. Another spend is blocked; check the pending result again in a few minutes. Nothing was dispatched again.", 'Registreret: {0} msat i betalingsbevis, men handlingens endelige udfald er ukendt. Nye betalinger er blokeret; kontrollér det afventende resultat igen om et par minutter. Intet blev sendt af sted igen.'],
  ['Payment unknown: the original send may still reach your node. Another spend is blocked; check again in a few minutes. Nothing was dispatched again.', 'Betaling ukendt: den oprindelige afsendelse kan stadig nå din boks. Nye betalinger er blokeret; tjek igen om et par minutter. Intet blev sendt af sted igen.'],
  ["The node's network is not checked yet. Nothing was sent.", 'Boksens netværk er ikke tjekket endnu. Intet blev sendt.'],
  ["The node's network is not checked yet. Nothing was dispatched again.", 'Boksens netværk er ikke tjekket endnu. Intet blev sendt af sted igen.'],
  ["Payment unknown: your node has not resolved whether this message's payment went through. It will not pay for it again, and the app will not resend it. Check the pending result later.", 'Betaling ukendt: din boks har ikke afklaret, om betalingen for beskeden gik igennem. Den betaler ikke igen, og appen sender den ikke igen. Kontrollér det afventende resultat senere.'],
  ['Paid {}, but the answer could not be shown: {}.', 'Betalt {0}, men svaret kunne ikke vises: {1}.'],
  ['Your node cannot read porches yet. Update it to read contacts’ cards and pages. Nothing was paid.', 'Din boks kan ikke læse profiler endnu. Opdater den for at læse kontakters kort og sider. Intet blev betalt.'],
  ['The node refused the changed price before any payment. Refresh the quote.', 'Boksen afviste den ændrede pris før enhver betaling. Hent prisen igen.'],
  ['Your node refused before paying: delivering it now costs more than the price you approved, or needs an admission the node pays only on a new send. Nothing was paid. Retry delivery for the current price, or stop retrying.', 'Din boks afviste før betaling: levering koster nu mere end den pris, du godkendte, eller kræver en adgang, boksen kun betaler ved en ny afsendelse. Intet blev betalt. Prøv at levere igen til den aktuelle pris, eller stop forsøgene.'],
  ['This node cannot enforce your confirmed spending ceiling. Upgrade the node before sending messages or files.', 'Denne boks kan ikke overholde dit bekræftede forbrugsloft. Opdater boksen, før du sender beskeder eller filer.'],
  ['Upgrade the node to enforce an all-in message ceiling.', 'Opdater boksen, så den kan overholde et samlet loft for beskeder.'],
  ['Refresh the room quote before sending.', 'Hent rummets pris igen, før du sender.'],
  ['The current price is {} msat, above the confirmed ceiling of {} msat. Nothing was dispatched; refresh the quote.', 'Den aktuelle pris er {0} msat, over det bekræftede loft på {1} msat. Intet blev sendt af sted; hent prisen igen.'],
  ['The room all-in price changed. Review the new quote before sending.', 'Rummets samlede pris er ændret. Se den nye pris, før du sender.'],
  ['Node capabilities unavailable: {}. Nothing was paid.', 'Boksens funktioner er ikke tilgængelige: {0}. Intet blev betalt.'],
  ['Node capabilities unavailable: {}', 'Boksens funktioner er ikke tilgængelige: {0}'],
  ['Quote unavailable: {}', 'Prisen er ikke tilgængelig: {0}'],
  ['Not delivered - nothing new was paid. This contact asks your node to pay their admission again (every reconnect or node restart starts unpaid), and your node cannot pay that under an app cap yet. The paid message stays here; retry later, or stop retrying.', 'Ikke leveret – intet nyt blev betalt. Kontakten beder din boks betale for adgang igen (hver genforbindelse eller genstart begynder ubetalt), og din boks kan ikke betale det under appens loft endnu. Den betalte besked bliver her; prøv igen senere, eller stop forsøgene.'],
  ['Not sent - nothing was paid. They reconnected and ask to be admitted again, which costs more than you confirmed for this room message. Message them once in their own chat, then send to the room again.', 'Ikke sendt – intet blev betalt. De har forbundet igen og beder om adgang igen, hvilket koster mere, end du bekræftede for denne rumbesked. Skriv til dem én gang i deres egen chat, og send så til rummet igen.'],
  ["Not sent - nothing was paid. This contact asks your node to pay their admission again (every reconnect or node restart starts unpaid), and your node cannot pay that under the app's all-in cap yet. The app will not retry; sending the same message again reuses its operation, so it can never be paid twice.", 'Ikke sendt – intet blev betalt. Kontakten beder din boks betale for adgang igen (hver genforbindelse eller genstart begynder ubetalt), og din boks kan ikke betale det under appens samlede loft endnu. Appen prøver ikke igen; sender du samme besked igen, genbruges handlingen, så den aldrig kan betales to gange.'],
  ['Not sent - nothing was paid: your node reports no payment for this message. Nothing was dispatched again.', 'Ikke sendt – intet blev betalt: din boks melder ingen betaling for denne besked. Intet blev sendt af sted igen.'],
  ['Not sent - nothing was paid: your node reports that the payment failed. Nothing was dispatched again. You can send it again.', 'Ikke sendt – intet blev betalt: din boks melder, at betalingen mislykkedes. Intet blev sendt af sted igen. Du kan sende den igen.'],
  ['Not sent - nothing was paid.', 'Ikke sendt – intet blev betalt.'],
  ['Not sent - nothing was paid. Recipient is offline.', 'Ikke sendt – intet blev betalt. Modtageren er offline.'],
  ['Not sent - nothing was paid. {}', 'Ikke sendt – intet blev betalt. {0}'],
  ['Their node is catching up and could not take this minute yet. Nothing was paid for it.', 'Deres boks er ved at indhente og kunne ikke tage imod dette minut endnu. Intet blev betalt for det.'],
  ['There is no secure session with them yet. Message them once in their own chat first; a room never pays a first contact.', 'Der er ingen sikker forbindelse til dem endnu. Skriv først til dem én gang i deres egen chat; et rum betaler aldrig for en første kontakt.'],
  ['Their node cannot take room messages right now: it is not connected, or it needs an update.', 'Deres boks kan ikke tage imod rumbeskeder lige nu: den er ikke forbundet, eller den skal opdateres.'],
  ["This room's details did not check out at your node. Start a new room with the same people.", 'Rummets oplysninger stemte ikke på din boks. Start et nyt rum med de samme personer.'],
  ["Your node is not in this room's member list.", 'Din boks er ikke på rummets medlemsliste.'],
  ["They are not in this room's member list.", 'De er ikke på rummets medlemsliste.'],
  ['That message is no longer waiting for delivery. Nothing was changed.', 'Den besked venter ikke længere på levering. Intet blev ændret.'],
  ['There is no paid, undelivered message to retry for this contact. Check the pending result; do not send the message again.', 'Der er ingen betalt, ikke-leveret besked at prøve igen for denne kontakt. Kontrollér det afventende resultat; send ikke beskeden igen.'],
  ['Room send incomplete: a member was refused or a paid message could not be stored. Do not resend the whole room message.', 'Afsendelsen til rummet blev ikke færdig: et medlem afviste, eller en betalt besked kunne ikke gemmes. Send ikke hele rumbeskeden igen.'],
  ['This room has more than 256 members.', 'Dette rum har mere end 256 medlemmer.'],
  ['This room has no other members yet.', 'Dette rum har ingen andre medlemmer endnu.'],
  ['Your spending approval has expired. Approve again to send.', 'Din godkendelse af forbrug er udløbet. Godkend igen for at sende.'],
  ['Approval changed while preparing this action. Confirm it again.', 'Godkendelsen blev ændret, mens handlingen blev gjort klar. Bekræft den igen.'],
  ['Sending spends from your node. Approve spending first.', 'At sende bruger penge fra din boks. Godkend forbrug først.'],
  ["Your node refused: this app's token cannot spend. Spending needs an owner grant on a node you run yourself.", 'Din boks afviste: denne apps adgang kan ikke bruge penge. Forbrug kræver et budget fra ejeren på en boks, du selv kører.'],
  ['Outcome unknown; another spend is blocked until reconciled. {}', 'Udfaldet er ukendt; nye betalinger er blokeret, indtil det er afklaret. {0}'],
  ['Room outcome missing or inconsistent; do not retry.', 'Rummets udfald mangler eller stemmer ikke; prøv ikke igen.'],
  ['The reported all-in total overflows.', 'Det oplyste samlede beløb er for stort til at kunne regnes.'],
  ['Your node cannot run starter-bitcoin kits yet.', 'Din boks kan ikke køre startpakker med bitcoin endnu.'],
  ['Accounted: {} msat paid, and the message is not delivered yet. Your node keeps resending it; nothing was dispatched again. Retry delivery from its card (it pays nothing new), or stop retrying it.', 'Registreret: {0} msat betalt, og beskeden er ikke leveret endnu. Din boks bliver ved med at sende den; intet blev sendt af sted igen. Prøv at levere igen fra dens kort (det koster ikke noget nyt), eller stop forsøgene.'],
  ['Accounted: {} msat paid, and the message is still not delivered. Nothing was dispatched again. Retry delivery from its card, or stop retrying it.', 'Registreret: {0} msat betalt, og beskeden er stadig ikke leveret. Intet blev sendt af sted igen. Prøv at levere igen fra dens kort, eller stop forsøgene.'],
  ["Encrypt your recovery phrase to enable biometric approvals. On the node's computer: stop the node, run `konsensus seed encrypt --config <path>` once, then start it again and type the password.", 'Krypter din gendannelsesfrase for at slå biometrisk godkendelse til. På boksens computer: stop boksen, kør `konsensus seed encrypt --config <path>` én gang, start den igen, og skriv adgangskoden.'],
  ['Restart your node and type its recovery-phrase password at start to enable biometric approvals (a password file or flag leaves them off).', 'Genstart din boks, og skriv adgangskoden til gendannelsesfrasen ved start for at slå biometrisk godkendelse til (en adgangskodefil eller et flag lader den være slået fra).'],
  ['Biometric approvals are off on your node. Approve at the node instead.', 'Biometrisk godkendelse er slået fra på din boks. Godkend på boksen i stedet.'],
  ["Encrypt your recovery phrase to enable Touch ID approvals. On the node's computer: stop the node, run `konsensus seed encrypt --config <path>` once, then start it again and type the password.", 'Krypter din gendannelsesfrase for at slå Touch ID-godkendelse til. På boksens computer: stop boksen, kør `konsensus seed encrypt --config <path>` én gang, start den igen, og skriv adgangskoden.'],
  ['Restart your node and type its recovery-phrase password at start to enable Touch ID approvals (a password file or flag leaves them off).', 'Genstart din boks, og skriv adgangskoden til gendannelsesfrasen ved start for at slå Touch ID-godkendelse til (en adgangskodefil eller et flag lader den være slået fra).'],
  ['Touch ID approvals are off on your node. Approve at the node instead.', 'Touch ID-godkendelse er slået fra på din boks. Godkend på boksen i stedet.'],
  ['Files up to 1.4 MB can be sent from the app for now.', 'Indtil videre kan filer op til 1,4 MB sendes fra appen.'],
  ['Network fee would exceed your limit.', 'Netværksgebyret ville overstige din grænse.'],
  ["This device already has a pairing. Reconnect with its saved pairing; a second-device ticket is for a new device.", 'Denne enhed er allerede parret. Forbind igen med den gemte parring; en billet til en ekstra enhed er til en ny enhed.'],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The values the host itself words: a refusal inside a refusal, or who it is about.
 * Any other value is the node's or a figure, and stays exactly as it came, even if it reads like a known refusal.
 */
const HOST_WORDED: Readonly<Record<string, readonly number[]>> = {
  'This call needs up to {}. {} The owner would need to approve enough remaining budget for that ceiling. Nothing was sent or paid.': [1],
  'This call needs up to {} per payment. {} The owner would need to approve at least {} per payment. Nothing was sent or paid.': [1],
  'Retry delivery paid nothing new. Delivering the message needs a new payment: its price, and admission again if the contact reconnected. Nothing was paid.{} Approve it to continue, or stop retrying.': [0],
  'You have used {} of {} for {} in the last 24 hours, and this costs {}. Raise the budget to send.': [2],
  'Your first paid message to {} needs your OK once. Nothing was sent.': [0],
};
const compiled = HOST_COPY_DA.map(([en, da]) => ({ re: new RegExp(`^${escape(en).replace(/\\\{\\\}/g, '(.+?)')}$`, 's'), da, worded: HOST_WORDED[en] ?? [] }));

/** The Danish for exactly this text, or null. A value is kept as it came, around any Danish for it. */
function exact(message: string, depth: number): string | null {
  for (const { re, da, worded } of compiled) {
    const m = re.exec(message);
    if (m) return da.replace(/\{(\d+)\}/g, (_, i: string) => {
      const value = m[Number(i) + 1] ?? '';
      if (!worded.includes(Number(i))) return value;
      const lead = /^\s*/.exec(value)![0];
      return lead + danish(value.slice(lead.length), depth + 1);
    });
  }
  return null;
}
/** Sentences the host joins: only when every part is known, so a message is never half translated. */
function joined(message: string, depth: number): string | null {
  if (depth > 2) return null;
  for (const at of message.matchAll(/[.!?] +/g)) {
    const end = at.index + at[0].length;
    const left = exact(message.slice(0, at.index + 1), depth);
    if (left === null) continue;
    const rest = message.slice(end);
    const right = exact(rest, depth) ?? joined(rest, depth + 1);
    if (right !== null) return `${left} ${right}`;
  }
  return null;
}
function danish(message: string, depth: number): string {
  if (depth > 2) return message;
  return exact(message, depth) ?? joined(message, depth) ?? message;
}

/** The refusal in the app's language: Danish where the host's exact text is known, otherwise as the host wrote it. */
export function hostText(message: string, lang: string = language()): string {
  return lang === 'da' ? danish(message, 0) : message;
}
