# First TestFlight build

For the owner of the paid Apple Developer membership, once it is active. Every
step that signs or touches App Store Connect is done by that person in Xcode or
in the browser; the repository never stores a team, certificate or profile.

## Before the first upload (once)

1. **Check the release inputs.** From the repo root:

   ```sh
   npm ci
   rustup target add aarch64-apple-ios
   rustup component add llvm-tools
   python3 scripts/check-ios-release.py --xcode --toolchain
   ```

   It must print `iOS release check: ok`. It confirms the microphone, camera,
   local-network and Face ID texts, background audio only, the export
   compliance answer, bitcode off, that no simulator-only entitlements or
   team are committed, and that the Rust toolchain has `llvm-objcopy` (see
   [Release link with Xcode 27](#release-link-with-xcode-27)).
2. **Pick the paid team in Xcode.** Run `npx tauri ios build --open`, or open
   `src-tauri/gen/apple/bitsov-app.xcodeproj`. Select target **bitsov-app_iOS →
   Signing & Capabilities**, keep **Automatically manage signing** ticked, and
   set **Team** to the paid team (not the Personal Team used so far). The bundle
   identifier stays `tech.mindlink.bitsov`. Xcode registers the identifier and
   creates the distribution certificate the first time it archives. Do not
   commit the team change Xcode makes to `project.pbxproj`.
3. **Create the App Store Connect record.** In App Store Connect choose **Apps →
   + → New App**:
   - Platforms: iOS
   - Name: BitSov (it must be unique on the App Store; pick another if taken)
   - Primary language: your choice
   - Bundle ID: `tech.mindlink.bitsov` (it appears after step 2, or add it
     under Certificates, Identifiers & Profiles → Identifiers)
   - SKU: any private string, for example `bitsov-ios`
   - User Access: Full Access

## Release link with Xcode 27

Xcode 27's Swift toolchain keeps the `@_cdecl` entry points of tauri's Swift
packages local in Release builds (`log_stdout`, `on_webview_created`,
`register_plugin`, `run_plugin_command` and the barcode scanner's
`init_plugin_barcode_scanner` show as `t` in `nm`). Debug builds export them,
which is why debug installs from Xcode work. The `swift-rs` build helper used
by tauri re-exports them with `llvm-objcopy` from rustup's `llvm-tools`
component, but it skips that step without failing the build when the tool is
missing. The Release app then fails to link with `Undefined symbols … _log_stdout`.

`rustup component add llvm-tools` fixes it. `scripts/ios-testflight.sh` refuses
to start without the tool and rebuilds the two Swift packages each time, so an
archive made before the tool was installed is never reused.

## Each build

1. Commit or stash local changes, then run:

   ```sh
   scripts/ios-testflight.sh
   ```

   This builds the release app for iPhone with the version from
   `src-tauri/tauri.conf.json` (shown as the app version) and the build number
   set to the repository's commit count, so every later commit gives a higher
   number, as App Store Connect requires. `scripts/ios-testflight.sh --dry-run`
   prints the command without running it. To force a number, set
   `IOS_BUILD_NUMBER=<n>`; it must be higher than any build already uploaded
   for that version. If the command stops because no development team is
   configured, run it as `APPLE_DEVELOPMENT_TEAM=<your Team ID>
   scripts/ios-testflight.sh`. The Team ID is shown under Membership in your
   developer account.
2. Upload: open the `.xcarchive` the command made under
   `src-tauri/gen/apple/build/` (double-click opens Xcode's Organizer), then
   **Distribute App → App Store Connect → Upload**, with automatic signing.
   Alternatively, run `scripts/ios-testflight.sh -- --open` and use
   **Product → Archive** in Xcode with **Any iOS Device (arm64)** selected.
3. The build writes the build number into
   `src-tauri/gen/apple/bitsov-app_iOS/Info.plist`. Discard that change with
   `git checkout -- src-tauri/gen/apple/bitsov-app_iOS/Info.plist`.
4. Wait for App Store Connect to finish processing (usually 5–30 minutes; you
   get an email).

## Internal testing

1. In App Store Connect, open **Users and Access** and invite the other tester
   as a user on your team (role Developer or Marketing is enough). Internal
   testers must be users on the team, up to 100.
2. Open the app → **TestFlight → Internal Testing → +**. Create a group, for
   example "M6", and add yourself and the tester.
3. Add the processed build to the group. Internal builds need no beta review.
   If App Store Connect still asks about encryption, see the next section.
4. The tester accepts the team invitation email, installs **TestFlight** from
   the App Store on their iPhone, signs in with the same Apple Account, and
   taps **Install** on BitSov (or opens the TestFlight invitation email on the
   phone). Builds expire after 90 days. Upload a new one before then.
5. On first launch, allow Local Network, Face ID and (at the first call)
   Microphone, then pair with the tester's own home node.

## Export compliance (`ITSAppUsesNonExemptEncryption = false`)

The app's encryption:
- TLS through rustls for HTTPS;
- the Noise protocol `Noise_XX_25519_ChaChaPoly_BLAKE2s` (snow) for the box tunnel;
- Ed25519, X25519 and BLAKE3 for keys, signatures and pairing codes;
- P-256 keys in the Secure Enclave through Apple's Security framework.

All of these are published, standard algorithms from open-source libraries or
the operating system. Nothing is proprietary. The app is a mass-market consumer
app and its source is meant to be public. That is the case U.S. export rules
(EAR Category 5 Part 2, mass-market and publicly available software) treat as
exempt from export documentation. Apple's key records that answer, so App
Store Connect does not ask on every upload.

**The account owner must confirm this answer for their own filing.** It is a
legal statement made by the account holder, not a technical setting. If the
app is later distributed on the App Store in France, France has its own
declaration rules for encryption. If either answer changes, set the key to
`true` in `src-tauri/Info.ios.plist` and `src-tauri/gen/apple/bitsov-app_iOS/Info.plist`
and answer App Store Connect's questions per build.
