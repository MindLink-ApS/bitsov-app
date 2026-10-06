# Bundled node rc9 and retained rc7 upgrades

The app pins `MindLink-ApS/BitSov-bitsov@v0.3.0-rc9`, signed tag targeting
`cd75c69ed17eeb812d45bdc666b381ca7da1b697`. The source contract was reviewed via
GitHub CLI against [UPGRADING.md at rc9](https://github.com/MindLink-ApS/BitSov-bitsov/blob/v0.3.0-rc9/docs/UPGRADING.md).
No release asset was downloaded for this change.

## Retained identity

Keep the same data directory, wallet, pairing and config. Do not re-run init,
copy/export the seed, delete state or create a replacement password to resolve
an upgrade refusal. With owner opt-in enabled, existing plaintext identities
still use ordinary startup; they do not try to retrieve an owner Keychain item.

1. Startup reports `identity_without_marker` or `identity_and_state_without_marker`.
   The app waits for the supervised node to exit, then asks for explicit repair
   consent. Declining leaves it stopped. Acceptance runs the same sidecar's
   `repair mark-initialized --config <existing config> --confirm`.
2. Restart may refuse the retained rc7 `pricing.web_content_msat = 50`, even
   with web serving disabled. The app asks for **separate** price consent.
   Acceptance preserves a config backup and changes only this known old price
   to 1000 msat (1 sat). Higher/custom values are not silently rewritten.
3. Restart and authenticate through pairing. The existing identity remains live;
   owner creation/first-device enrollment never reopens. Existing rc7 token and
   live-restore fallbacks stay available only under their existing 404 rules.

Remote and externally managed nodes cannot use either repair command or the
local ceremony. Repair is never automatic. Only recognized startup refusals
qualify; missing/corrupt identity material is not permission to fabricate markers.

Normal rc9 startup applies embedded migrations 020–028 after rc7's 019. Remove
stale external migration overrides. Preserve backups and current state; rollback
is only an option before the first LDK start on rc9. After that, roll forward,
never run rc7 on migrated state or restore stale Lightning state. Reachable API
and mock tests do not establish wallet/channel readiness; inspect authenticated
status and reconcile uncertain operations before retrying them.

## Fresh local install

`BUNDLED_NODE_SUPPORTS_LOCAL_OWNER = true` unlocks the rc9 capability. The other
gates stay in place: macOS, Cargo feature `local-owner-ceremony`, and runtime
`BITSOV_LOCAL_OWNER_CEREMONY=1`. Neither opt-in is enabled by default.

A fresh directory persists its Keychain password before bootstrap-only config,
then starts with descriptor password input and `--local-owner-device`. The
one-shot phrase, backup check and device enrollment finish before live startup.
The node decides whether bootstrap is allowed. Encrypted ceremony installs reuse
the existing password on later launches; missing Keychain access never creates
a replacement. No fresh ceremony is offered on an initialized node.

## Expected release bytes and remaining CI checks

These are expected checksums supplied for this re-pin, **not locally verified
release artifacts**. The fetcher still requires the detached GPG signature by
`B299274C200301714DC6F51A7C2D6F8AC842EF6E` and validates each binary against the
signed manifest. No unsigned-manifest fallback is introduced.

| Asset | Expected SHA-256 |
|---|---|
| bitsov-darwin-aarch64 | `2e6826d5ff77e21fce1fc76cb613b92b9b6bf5a969eb2becbe5e7c4c7e9420af` |
| bitsov-darwin-x86_64 | `db3b6b8834b3d703aab721420d35db02e19338f8743f387996ffd25f9692e50a` |
| bitsov-linux-aarch64 | `a63893925163ccbc165524c8887154c5e4a1c222e89a7159d98b6a566a964cca` |
| bitsov-linux-x86_64 | `dac2397db5062569d267b454f308c763e465ce99baa94f02b8f3e62b05651e6f` |
| bitsov-windows-x86_64 | `d14bcbffa9ddd8affca417786d0cb3d12a6ceece962b9b0e73348aad6c723409` |

Attach `SHA256SUMS` and `SHA256SUMS.asc` to rc9 and make the release accessible
to CI (the app repo's token cannot read another repo's private draft). Then:

- **Sidecar CI:** fetch/signature/hash verification, full-tier config drift,
  real owner create/finalize/restart test, CS-1 durable identity smoke, CS-2 bindings.
- **Mac Package CI:** fetch and `--verify-only`, unsigned app/DMG build,
  `check-mac-bundle.sh` comparison to the verified sidecar. Its rc9 label is
  diagnostic; signature/hash verification remains the fetcher's responsibility.
- **Release acceptance:** real retained-directory upgrade, paired live reads,
  and a signed/hardened Mac Keychain + Touch ID ceremony. Neither unsigned
  packaging nor mock tests prove OS credential protection or funded migration.

Historical rc7 fixtures, fallback tests and package spike evidence retain their
original version labels. They describe old-node compatibility, not today's pin.
