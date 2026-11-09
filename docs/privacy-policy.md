# BitSov privacy policy / Privatlivspolitik

## English

### Your node, your funds

BitSov is a non-custodial client for your own Lightning node. Your phone or
Mac controls that node; the phone does not run a Lightning node. A Mac can
also run a local node. The node holds the wallet and Lightning keys, and
executes payments. MindLink does not take custody of your funds through
the app. If someone else hosts your node, that host has access to the
machine holding your keys: use a host you trust.

### Data on your device

The app stores connection and pairing information, node identity pins,
approval state, spending limits and operation records needed to reconcile
payments and retries. These records can include recipient identifiers,
amounts, payment hashes and call identifiers. It also keeps a local wallet
activity list, including invoices you create, and preferences such as
language, appearance, units, notifications and your STUN choice.

On iPhone and iPad, the app's client signing key is stored in the
device-only, non-synchronizing Keychain. On Mac, protected client-key files
use Secure Enclave-backed storage when available. If protected storage
is unavailable before a key is migrated, Mac can use a restricted local
key file instead. Keychain also stores Mac node-launch credentials. Device
approval keys use the Apple security facilities. Remembering a node's
unlock password is optional and uses protected storage. These app
credentials are separate from the wallet keys held by your node.

The Mac assistant can save encrypted question-and-answer history and
watch settings locally. The app does not persist its raw AI disclosure
request bodies in that history. Messages and files are read from your
node for display; files you explicitly save remain on your device. Local
diagnostic output may also be produced. This is not an automatic upload
to MindLink.

### What goes where

- **Node control:** pairing, authentication, messages, attachments,
  payment instructions and node-status requests go to your own selected
  node. Local control uses a loopback connection; remote control uses
  the app's authenticated, encrypted node connection. Messages and
  attachments are then handled by the node for delivery to recipients.
- **Payments:** Lightning payments go from your node to the recipient's
  node over the Lightning network. The per-message payment goes 100% to
  the recipient's node. Separate routing fees and, when required, the
  recipient's admission charge may apply. MindLink takes no in-app cut.
  Your node also makes its own Bitcoin and Lightning network connections;
  a local node's configuration can include external blockchain services.
  The app's local-node setup configuration names Blockstream and
  mempool.space; those services can see the node's IP address and
  blockchain queries.
- **Calls:** call signalling goes through your node. Live audio and video
  use WebRTC directly between participants' devices, so the other
  participant can learn your network address. STUN is used only with
  your node's advertised server or a server you explicitly choose in
  Settings. That server sees your IP address. There is no built-in
  third-party STUN default; you can turn STUN off. Calls may not connect
  across all networks.
- **Optional AI:** built-in rule answers stay on the device apart from
  reads of your node. A selected local model runs on the same computer.
  Remote model providers are off by default. If you configure one, the
  app previews the question and selected node data before you explicitly
  send that request. Those bytes go to that provider, which also sees
  your IP address and receives its configured authentication credential,
  if any. Its own privacy and billing terms apply.
- **Permissions and links:** the camera is used for QR scanning or video
  calls, and the microphone for voice notes or calls. Mac message/call
  notifications are local and can show a sender's name, without message
  content. Opening this policy launches your browser and contacts the
  project website, which receives the normal web request, including your
  IP address. Sending us email shares what you put in that email.

### Analytics, retention and contact

The app includes no analytics SDKs, advertising trackers or automatic
crash-report uploads. It does not send usage telemetry to MindLink.
Optional AI requests, calls and website visits described above are
separate from analytics.

Local settings and operation records remain until removed from device
storage; some operation history has no automatic expiry. Forgetting an
assistant clears that assistant's saved thread. Forgetting a node
connection does not erase data on the node or recipients' devices.
Removing app files does not necessarily remove Keychain items, exported
files, backups or the node's wallet. Manage those separately; do not
delete your only wallet backup when clearing app data.

For privacy questions, contact [info@mindlink.tech](mailto:info@mindlink.tech).
This policy will be updated when the app's data handling changes.

## Dansk

### Din node, dine penge

BitSov er en klient uden depotfunktion til din egen Lightning-node. Din
telefon eller Mac styrer noden; telefonen kører ikke en Lightning-node.
En Mac kan også køre en lokal node. Noden opbevarer wallet- og
Lightning-nøglerne og udfører betalinger. MindLink overtager ikke dine
penge gennem appen. Hvis andre er vært for din node, har de adgang til
maskinen med dine nøgler: brug en vært, du stoler på.

### Data på din enhed

Appen gemmer forbindelses- og parringsoplysninger, fastlåste
nodeidentiteter, godkendelsesstatus, forbrugsgrænser og operationsposter
til afstemning af betalinger og nye forsøg. Posterne kan indeholde
modtageridentifikatorer, beløb, betalingshashes og opkaldsidentifikatorer.
Den gemmer også en lokal liste over wallet-aktivitet, herunder fakturaer,
du opretter, samt indstillinger for sprog, udseende, enheder,
notifikationer og dit valg af STUN.

På iPhone og iPad opbevares appens signeringsnøgle i enhedens lokale
Keychain uden synkronisering. På Mac bruger beskyttede klientnøglefiler
Secure Enclave, når det er tilgængeligt. Hvis beskyttet lagring ikke er
tilgængelig før migrering af en nøgle, kan Mac i stedet bruge en lokal
nøglefil med begrænsede filrettigheder. Keychain gemmer også legitimationsoplysninger
til start af Mac-noden. Enhedens godkendelsesnøgler bruger Apples
sikkerhedsfunktioner. Det er valgfrit at huske nodens adgangskode til
oplåsning, og den gemmes beskyttet. Disse app-oplysninger er adskilt fra
wallet-nøglerne på din node.

Assistenten på Mac kan gemme krypteret historik over spørgsmål og svar
samt overvågningsindstillinger lokalt. Appen gemmer ikke de rå
AI-anmodninger i denne historik. Beskeder og filer hentes fra din node
til visning; filer, du selv gemmer, bliver på din enhed. Der kan også
blive dannet lokalt diagnoseoutput. Det sendes ikke automatisk til MindLink.

### Hvad sendes hvorhen

- **Styring af noden:** parring, autentificering, beskeder, vedhæftninger,
  betalingsinstruktioner og statusforespørgsler sendes til din egen valgte
  node. Lokal styring bruger en loopback-forbindelse; fjernstyring bruger
  appens autentificerede, krypterede nodeforbindelse. Noden håndterer
  derefter levering af beskeder og vedhæftninger til modtagerne.
- **Betalinger:** Lightning-betalinger går fra din node til modtagerens
  node gennem Lightning-netværket. Betalingen pr. besked går 100 % til
  modtagerens node. Separate routinggebyrer og eventuelt modtagerens
  adgangsbetaling kan komme oveni. MindLink tager ingen andel i appen.
  Din node opretter også sine egne forbindelser til Bitcoin- og
  Lightning-netværket; en lokal nodes konfiguration kan omfatte eksterne
  blockchain-tjenester. Appens konfiguration til lokal nodeopsætning
  angiver Blockstream og mempool.space; tjenesterne kan se nodens
  IP-adresse og blockchain-forespørgsler.
- **Opkald:** signalering går gennem din node. Lyd og video under opkald
  bruger WebRTC direkte mellem deltagernes enheder, så den anden deltager
  kan få kendskab til din netværksadresse. STUN bruges kun med den server,
  din node angiver, eller en server, du selv vælger i Indstillinger.
  Serveren ser din IP-adresse. Der er ingen indbygget tredjepartsserver
  som standard for STUN; du kan slå STUN fra. Opkald kan muligvis ikke
  forbindes på tværs af alle netværk.
- **Valgfri AI:** indbyggede regelsvar bliver på enheden bortset fra
  læsninger fra din node. En valgt lokal model kører på samme computer.
  Eksterne modeludbydere er slået fra som standard. Hvis du konfigurerer
  en, viser appen spørgsmålet og de valgte nodedata, før du udtrykkeligt
  sender anmodningen. Disse data sendes til udbyderen, som også ser din
  IP-adresse og modtager sin konfigurerede legitimationsoplysning, hvis
  en sådan bruges. Udbyderens egne privatlivs- og betalingsvilkår gælder.
- **Tilladelser og links:** kameraet bruges til QR-scanning eller
  videoopkald, og mikrofonen til talebeskeder eller opkald.
  Besked- og opkaldsnotifikationer på Mac er lokale og kan vise afsenderens
  navn uden beskedindhold. Dette politiklink åbner din browser og
  kontakter projektets hjemmeside, som modtager den normale webanmodning,
  herunder din IP-adresse. Sender du os en mail, deler du mailens indhold.

### Analyse, opbevaring og kontakt

Appen indeholder ingen analyse-SDK'er, reklamesporing eller automatiske
uploads af fejlrapporter. Den sender ikke brugsstatistik til MindLink.
Valgfrie AI-anmodninger, opkald og hjemmesidebesøg beskrevet ovenfor er
adskilt fra brugsanalyse.

Lokale indstillinger og operationsposter bliver liggende, indtil de
fjernes fra enhedens lager; noget operationshistorik udløber ikke
automatisk. Når du glemmer en assistent, slettes dens gemte samtaletråd.
Når du glemmer en nodeforbindelse, slettes data på noden eller hos
modtagerne ikke. Fjernelse af appfiler fjerner ikke nødvendigvis
Keychain-poster, eksporterede filer, sikkerhedskopier eller nodens wallet.
Håndter dem særskilt; slet ikke din eneste wallet-sikkerhedskopi, når du
rydder appdata.

Kontakt [info@mindlink.tech](mailto:info@mindlink.tech) med spørgsmål om
privatliv. Politikken opdateres, når appens databehandling ændres.

## Maintainer verification / Kontrol for vedligeholdere

These are source references, not claims that the website is already deployed.
Disse kildehenvisninger betyder ikke, at hjemmesiden allerede er udgivet.

| Claim / Oplysning | Source / Kilde |
| --- | --- |
| App dependencies; no analytics/tracking integration found / Afhængigheder; ingen analyse- eller sporingsintegration fundet | `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`; runtime code in `src/`, `src-tauri/src/`, `src-tauri/native/`, mobile native plugins |
| Node API and remote transport / Node-API og fjernforbindelse | `src/control/source.ts`, `src-tauri/src/app.rs`, `src-tauri/src/remote_access.rs` |
| Credentials and protected storage / Legitimationsoplysninger og beskyttet lagring | `src-tauri/src/pairing/`, `src-tauri/native/client_keychain.swift`, `src-tauri/src/at_rest/`, `src-tauri/src/owner_password.rs`, `src-tauri/src/home_keychain.rs` |
| Local settings, wallet and operation records / Lokale indstillinger, wallet- og operationsposter | `src/i18n.ts`, `src/control/prefs.ts`, `src/control/wallet.ts`, `src-tauri/src/spend_journal.rs`, `src-tauri/src/budget.rs` |
| Node payment instructions and fee separation / Betalingsinstruktioner og særskilte gebyrer | `src-tauri/src/act.rs`, `src-tauri/src/app.rs`, `src/control/amountDraft.ts` |
| Node blockchain-service configuration / Nodens blockchain-konfiguration | `src-tauri/src/local_owner.rs` |
| Calls, STUN, microphone and camera / Opkald, STUN, mikrofon og kamera | `src/control/call.ts`, `src/control/Shell.tsx`, `src/control/prefs.ts`, `src/control/voice.ts`, `src/cameraQrScanner.ts` |
| Optional AI and encrypted local history / Valgfri AI og krypteret lokal historik | `src-tauri/src/ai.rs`, `src-tauri/src/ai/local.rs`, `src-tauri/src/ai/threads.rs`, `src-tauri/src/ai/threads/storage.rs` |
| Local notifications / Lokale notifikationer | `src/control/messageNotifications.tsx`, `src-tauri/capabilities/default-approval-notification.json` |
| Policy URL and browser opener / Politikadresse og browseråbning | `src-tauri/src/privacy_policy.rs` (`URL`), `src/PrivacyPolicyLink.tsx`, `src-tauri/src/app.rs` (`privacy_policy_open`) |

TODO(website): publish the English and Danish policy text above at
`/bitsov/privacy` on `mindlink.tech`, before App Review submission. The canonical
URL is in `src-tauri/src/privacy_policy.rs` (`URL`). Keep this verification section out of the
published policy.

TODO(hjemmeside): udgiv den engelske og danske politiktekst ovenfor på
`/bitsov/privacy` på `mindlink.tech` før indsendelse til App Review. Den fælles
URL findes i `src-tauri/src/privacy_policy.rs` (`URL`). Udelad dette kontrolafsnit fra den
offentliggjorte politik.
