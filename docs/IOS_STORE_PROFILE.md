# iOS store build profile

## English

iOS release builds automatically use the person-to-person payment profile.
Vite derives `VITE_IOS_STORE=1` from Tauri's `TAURI_ENV_PLATFORM=ios` and release
hook (`TAURI_ENV_DEBUG` is not `true`). Cargo sets `cfg(ios_store)` when its
target OS is `ios` and its profile is `release`. Neither side reads a runtime
setting, a node capability, or a saved preference to enable these features.
Supplying `VITE_IOS_STORE` yourself does not override the derived value.

The build removes Browse, porch, room and meeting entry points, including
incoming meeting invitations. The host refuses paid porch reads, legacy room
sends, room-bound message fanout and meeting-marked call signals before payment.
The store capability omits dedicated porch, room-quote and starter commands;
individual messages and calls keep their shared commands. Starter-balance commands and their
host implementation are compiled out; `VITE_STARTER_BALANCE=1` cannot enable
them in this profile. The unused hub-channel confirmation has been removed.

Messages between two people, the recipient's entry fee, files, individual
audio/video calls, direct payments and sponsor gifts keep their existing
payment and approval paths. Desktop and iOS debug builds retain their existing
features. Removing the unused dialog has no effect on desktop workflows.

Verification uses DOM tests in English and Danish with both profile values,
host library tests and build-selection contract tests. A frontend release
check can be run with `TAURI_ENV_PLATFORM=ios npm run build`; an ordinary
`npm run build` checks the desktop bundle. Native tests use `cargo test --lib`
and the contract tests under `src-tauri/tests`, without launching the app.
After the iOS frontend build, run `npm run check:ios-store-bundle` to verify
the emitted JavaScript contains no dormant starter or hub-confirmation paths.

## Dansk

iOS-udgivelsesversioner bruger automatisk profilen til betalinger mellem to
personer. Vite fastlægger `VITE_IOS_STORE=1` ud fra Tauris iOS-mål og
udgivelsestilstand. Cargo fastlægger `cfg(ios_store)` for målet `ios` med
profilen `release`. Profilen kan ikke ændres i appen, via nodefunktioner eller
gemte indstillinger. En særskilt værdi for `VITE_IOS_STORE` tilsidesætter ikke
bygningens profil.

Browse, porch, rum og møder vises ikke, heller ikke indgående mødeinvitationer.
Værten afviser betalte sidelæsninger, rumbeskeder og mødesignaler før betaling.
Kommandoerne til startsaldo og deres værtskode er udeladt, også hvis
`VITE_STARTER_BALANCE=1` er angivet. Den ubrugte bekræftelse af en hubkanal er
fjernet.

Beskeder mellem to personer, modtagerens adgangspris, filer, individuelle
lyd- og videoopkald, direkte betalinger og sponsorgaver bruger fortsat de
eksisterende betalings- og godkendelsesforløb. Desktop og iOS-fejlfindingsbyg
bevarer deres eksisterende funktioner. DOM-test dækker begge profiler på
dansk og engelsk; værts- og kontrakttest åbner intet appvindue. Efter bygning af
iOS-brugerfladen kontrollerer `npm run check:ios-store-bundle`, at den udgivne
JavaScript-kode ikke indeholder de ubrugte købsforløb.
