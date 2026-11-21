# Installing the iPhone app on a device

These steps are for the owner of the Apple developer account. They sign the
app with that account's identity, so they are run by that person on their own
Mac. Nothing here is automated; the simulator smoke (`docs/IOS-SMOKE.md`)
never signs or installs on a phone.

## Before you start

- A Mac with full Xcode, signed in to the developer account in
  **Xcode → Settings → Accounts**.
- From the repo root: `npm ci` and `rustup target add aarch64-apple-ios`.
- A home node that is already set up. A phone is a client only: pasting a
  link to an empty box shows "this box is not set up yet". Set the box up from
  the desktop app first, then create the phone's pairing link there
  (**Settings → Devices → Add a device**) or on the box.
- The node's pairing endpoint must be reachable from the phone: a LAN address
  or a VPN address such as Tailscale. `127.0.0.1` in a link means the phone
  itself and will not work.
- Use a signet test node with small spending limits.

## First iPhone: build and run from Xcode

1. Connect the iPhone by cable and unlock it. Tap **Trust** on the phone.
2. On the phone, turn on **Settings → Privacy & Security → Developer Mode**
   and restart it when asked. This is needed once per phone.
3. From the repo root run:

   ```sh
   npx tauri ios run --open
   ```

   This builds the web frontend (M6 node-routed calls are the default) and the
   Rust library, then opens `src-tauri/gen/apple/bitsov-app.xcodeproj`. Keep the
   terminal open while Xcode builds: Xcode's build phase calls back into it.
4. In Xcode select the **bitsov-app_iOS** scheme and the target
   **bitsov-app_iOS → Signing & Capabilities**:
   - tick **Automatically manage signing**;
   - **Team**: choose the developer account;
   - **Bundle Identifier**: `tech.mindlink.bitsov` (leave as is).
   Xcode creates the development certificate and profile and asks to register
   the phone. Approve both prompts. If macOS asks for the login keychain
   password to let Xcode sign, that prompt is for the owner only.
5. Choose the iPhone as the run destination and press **Run** (⌘R).
6. On the phone, approve in this order as they appear:
   - **Local Network** access (needed to reach a box on the LAN);
   - **Face ID** for BitSov when the device key is created;
   - **Microphone**, the first time a call starts.
   Declining Local Network or Microphone blocks pairing or calls; they can be
   turned back on in **Settings → BitSov**.
7. Pair: **Scan the box QR code**, or **Other options → Paste link**. Compare
   the code on both screens and choose **They match**.

## Second iPhone

Each person in an iPhone-to-iPhone call needs their own home node. Pick one
of the following for installing the app.

**A. The phone can be connected to the same Mac (simplest).** Repeat the
first-iPhone steps with that phone. Xcode registers it in the account
automatically. A development build expires after the profile's lifetime;
re-run from Xcode to renew.

**B. TestFlight internal testing (phone not at hand).**

1. In App Store Connect, **Apps → +  → New App**: platform iOS, name, primary
   language, bundle ID `tech.mindlink.bitsov` (registered automatically by
   step 4 above; otherwise add it under Certificates, Identifiers & Profiles),
   and a SKU.
2. Give each tester an App Store Connect user account on the team (**Users and
   Access**). Internal testers must be team users; up to 100. Internal builds
   do not go through beta review.
3. Set a new build number for every upload, for example
   `npx tauri ios build --open --build-number 2`. Then in Xcode choose the
   destination **Any iOS Device (arm64)** and **Product → Archive**.
4. In the Organizer: **Distribute App → App Store Connect → Upload**, with
   automatic signing. Xcode creates the distribution certificate and profile.
5. In App Store Connect, open the build under **TestFlight**, answer the export
   compliance question (the app uses encryption for its node connection), and
   add the build to an **Internal Testing** group with the tester.
6. The tester installs **TestFlight** from the App Store, accepts the invite
   and installs BitSov. TestFlight builds expire after 90 days.

**C. Ad hoc (phone not at hand, no TestFlight).** Add the phone's UDID under
**Certificates, Identifiers & Profiles → Devices**, archive as in B, then
**Distribute App → Release Testing** (ad hoc) and install the exported `.ipa`
with Apple Configurator or Finder on a Mac the phone connects to.

## Known limits on iPhone today

- Incoming calls ring only while the app is open in the foreground. There is
  no push wake-up or CallKit yet; keep the receiving phone unlocked with the
  app open, and turn off Auto-Lock for a test.
- A Live call requests background audio. Locked-screen continuity for the M6
  node-routed audio path is not yet verified on a device; follow
  [the device checks](qa/ios-call-background-audio.md#physical-device-verification-required-not-performed-by-these-tests).
- Calls use the earpiece by default; there is no speaker button yet. Bluetooth
  headsets are available through the voice-chat audio mode.
