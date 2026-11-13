# Face ID / Touch ID prompts

Rule: at most one biometric prompt per user action. Retries, polls, focus and
foreground changes never show one. Protection is unchanged: the client identity
stays a Keychain item that requires user presence, and the device key stays a
Secure Enclave key that requires biometrics for every signature.

## What the user sees

| When | Prompt | Why |
|---|---|---|
| First connection in an app session: app launch with a saved box, pasting or scanning a link, or **Try again** | One prompt ("Access your BitSov device identity") | The client identity is read from the Keychain once. It then stays in memory for the session, as it already did for token refreshes. |
| Later connections in the same session: the identity comparison, reconnects, the live feed's backoff, returning to the app, focus changes | None | The identity in memory is reused. |
| A background reconnect before any user action read the identity (for example, the first prompt was cancelled) | None | The app waits and says "Tap Try again to confirm it's you and reconnect." |
| Phone joins as another device (after the identity comparison) | Two today: "prepare this device for owner approval", then "confirm this device's comparison words" | Two separate device-key signatures, with a network round trip between them. |
| Set up Face ID / Touch ID approvals | One per tap | Signs the registration proof. |
| Unlock the home node | One per tap | Signs the unlock challenge. |
| Approving a spend, contact or other owner action | One per approval | Signs that approval. |
| Status screens and polls | None | They read public metadata only. |

## Before this change

The host read the client identity on every attach to the box. Import, each
**Try again**, the live feed's backoff reconnect, the onboarding retry on return
to the foreground, and every window focus or resume event while the proxy was
down each opened a prompt. A Face ID sheet moves window focus itself, so closing
one could trigger the next.

## Follow-up

The second-device join still shows two prompts for one step. Sharing one
authenticated context across both signatures needs that context to live across
the network round trip. That is a separate change to the native signing bridge.
