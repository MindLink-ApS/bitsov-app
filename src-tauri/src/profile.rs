//! Immutable policy selected from Tauri's bundled identifier before host startup.
use std::sync::OnceLock;

const REMOTE_TEST_IDENTIFIER: &str = "tech.mindlink.bitsov.remotetest";
static PROFILE: OnceLock<AppProfile> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AppProfile {
    remote_only: bool,
}

impl AppProfile {
    pub(crate) fn for_identifier(identifier: &str) -> Self {
        Self { remote_only: identifier == REMOTE_TEST_IDENTIFIER }
    }

    pub(crate) fn remote_only(self) -> bool {
        self.remote_only
    }

    pub(crate) fn keychain_service(self, service: &str) -> String {
        if self.remote_only {
            format!("{REMOTE_TEST_IDENTIFIER}.{service}")
        } else {
            service.to_owned()
        }
    }
}

pub(crate) fn install(identifier: &str) -> Result<(), String> {
    let profile = AppProfile::for_identifier(identifier);
    if *PROFILE.get_or_init(|| profile) != profile {
        return Err("The app storage profile cannot change after startup.".into());
    }
    Ok(())
}

pub(crate) fn current() -> Result<AppProfile, String> {
    // Never fall back to production names if a caller runs before setup.
    PROFILE.get().copied().ok_or_else(|| "The app storage profile is not initialized.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_keychain_services_remain_byte_for_byte_unchanged() {
        for identifier in ["tech.mindlink.bitsov", "tech.mindlink.bitsov.dev", ""] {
            let profile = AppProfile::for_identifier(identifier);
            assert!(!profile.remote_only());
            for service in [
                "tech.mindlink.bitsov.ai-threads.v1",
                "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password",
                "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password.wrapped-v1",
                "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.box-transport",
                "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.unlock-binding",
            ] {
                assert_eq!(profile.keychain_service(service).as_bytes(), service.as_bytes());
            }
        }
    }

    #[test]
    fn only_the_exact_remote_profile_prefixes_keychain_services() {
        let profile = AppProfile::for_identifier("tech.mindlink.bitsov.remotetest");
        assert!(profile.remote_only());
        for (service, expected) in [
            ("tech.mindlink.bitsov.ai-threads.v1",
             "tech.mindlink.bitsov.remotetest.tech.mindlink.bitsov.ai-threads.v1"),
            ("bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password",
             "tech.mindlink.bitsov.remotetest.bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password"),
            ("bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password.wrapped-v1",
             "tech.mindlink.bitsov.remotetest.bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password.wrapped-v1"),
        ] {
            assert_eq!(profile.keychain_service(service), expected);
            for identifier in ["tech.mindlink.bitsov.remotetest.extra", "TECH.MINDLINK.BITSOV.REMOTETEST"] {
                let other = AppProfile::for_identifier(identifier);
                assert!(!other.remote_only());
                assert_eq!(other.keychain_service(service), service);
            }
        }
    }
}
