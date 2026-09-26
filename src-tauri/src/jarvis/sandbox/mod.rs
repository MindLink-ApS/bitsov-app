//! Seatbelt profile for the local model process.
//!
//! The profile is the deny-by-default SBPL from the J0 spike
//! (`scripts/spike/j0-confined-child.sb`), without the test-only `SYSTEM_EXEC`
//! switch and without the LLM unix socket. The model talks to the broker only
//! through the pipes the launcher puts on stdin and stdout.
//!
//! App Sandbox is the fallback the spike names if Apple removes custom SBPL
//! (`docs/spike/J0-MACOS-ISOLATION.md` §1, "Rejected as primary"). It is not
//! implemented. `network.client` cannot express "these pipes and no TCP", and
//! the container would have to live under the home directory this profile denies.
//!
//! The spawn path is [`crate::model_launch`], compiled only for
//! `target_os = "macos"`. It uses `posix_spawn`, which is unsafe, so it lives
//! outside this module: `jarvis` forbids unsafe code.

mod profile;

// The macOS launcher is the consumer. Linux builds do not compile it, so
// these re-exports look unused there.
#[allow(unused_imports)]
pub use profile::{default_keychain_dirs, render_profile, ProfileError, SandboxPaths};
