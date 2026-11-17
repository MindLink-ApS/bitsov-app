//! Immutable policy selected from Tauri's bundled identifier before host startup.
use std::sync::OnceLock;

const REMOTE_TEST_IDENTIFIER: &str = "tech.mindlink.bitsov.remotetest";
const BETA_IDENTIFIER: &str = "tech.mindlink.bitsov.beta";
/// Phone builds are test-network only until a mainnet decision exists.
const MOBILE_BUILD: bool = cfg!(any(target_os = "ios", target_os = "android"));
static PROFILE: OnceLock<AppProfile> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AppProfile {
    remote_only: bool,
    signet_only: bool,
    beta_storage: bool,
}

/// Test-network policy for an identifier on this kind of build. Phone builds
/// share the product identifier, so the platform decides for them.
pub(crate) fn signet_only_for(identifier: &str, mobile: bool) -> bool {
    mobile || matches!(identifier, BETA_IDENTIFIER | REMOTE_TEST_IDENTIFIER)
}

impl AppProfile {
    pub(crate) fn for_identifier(identifier: &str) -> Self {
        Self::for_platform(identifier, MOBILE_BUILD)
    }

    pub(crate) fn for_platform(identifier: &str, mobile: bool) -> Self {
        Self {
            remote_only: identifier == REMOTE_TEST_IDENTIFIER,
            signet_only: signet_only_for(identifier, mobile),
            // Storage names follow the identifier only, so existing installs
            // keep their keychain items whatever the network policy is.
            beta_storage: identifier == BETA_IDENTIFIER,
        }
    }

    pub(crate) fn remote_only(self) -> bool {
        self.remote_only
    }

    pub(crate) fn signet_only(self) -> bool {
        self.signet_only
    }

    #[cfg(any(test, target_os = "ios", all(target_os = "macos", not(feature = "mobile"))))]
    pub(crate) fn keychain_service(self, service: &str) -> String {
        if self.remote_only {
            format!("{REMOTE_TEST_IDENTIFIER}.{service}")
        } else if self.beta_storage {
            format!("{BETA_IDENTIFIER}.{service}")
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

#[cfg(any(target_os = "ios", all(target_os = "macos", not(feature = "mobile"))))]
pub(crate) fn current() -> Result<AppProfile, String> {
    // Never fall back to production names if a caller runs before setup.
    PROFILE.get().copied().ok_or_else(|| "The app storage profile is not initialized.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_services_use_the_exact_profile_namespace() {
        let service = "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password";
        for (identifier, expected) in [
            ("tech.mindlink.bitsov", "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password"),
            ("tech.mindlink.bitsov.remotetest", "tech.mindlink.bitsov.remotetest.bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password"),
            ("tech.mindlink.bitsov.beta", "tech.mindlink.bitsov.beta.bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password"),
        ] {
            let profile = AppProfile::for_identifier(identifier);
            assert_eq!(profile.keychain_service(service).as_bytes(), expected.as_bytes());
            assert_eq!(profile.keychain_service(&format!("{service}.wrapped-v1")), format!("{expected}.wrapped-v1"));
        }
        for identifier in ["tech.mindlink.bitsov.beta.extra", "TECH.MINDLINK.BITSOV.BETA", "tech.mindlink.bitsov.other"] {
            assert_eq!(AppProfile::for_identifier(identifier).keychain_service(service), service);
        }
    }

    #[test]
    fn phone_builds_are_signet_only_for_every_identifier() {
        for identifier in ["tech.mindlink.bitsov", BETA_IDENTIFIER, REMOTE_TEST_IDENTIFIER, ""] {
            assert!(signet_only_for(identifier, true), "{identifier}");
            assert!(AppProfile::for_platform(identifier, true).signet_only(), "{identifier}");
        }
    }

    #[test]
    fn desktop_signet_policy_is_unchanged() {
        assert!(!signet_only_for("tech.mindlink.bitsov", false));
        assert!(!AppProfile::for_platform("tech.mindlink.bitsov", false).signet_only());
        for identifier in [BETA_IDENTIFIER, REMOTE_TEST_IDENTIFIER] {
            assert!(signet_only_for(identifier, false), "{identifier}");
            assert!(AppProfile::for_platform(identifier, false).signet_only(), "{identifier}");
        }
        for identifier in ["tech.mindlink.bitsov.beta.extra", "TECH.MINDLINK.BITSOV.BETA", "tech.mindlink.bitsov.dev"] {
            assert!(!signet_only_for(identifier, false), "{identifier}");
        }
    }

    #[test]
    fn host_builds_use_the_desktop_policy() {
        assert!(!MOBILE_BUILD);
        assert_eq!(AppProfile::for_identifier("tech.mindlink.bitsov"), AppProfile::for_platform("tech.mindlink.bitsov", false));
    }

    #[test]
    fn phone_policy_keeps_storage_names() {
        let service = "bitsov.node.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.seed-password";
        let profile = AppProfile::for_platform("tech.mindlink.bitsov", true);
        assert!(!profile.remote_only());
        assert_eq!(profile.keychain_service(service).as_bytes(), service.as_bytes());
        assert_eq!(AppProfile::for_platform(BETA_IDENTIFIER, true).keychain_service("s"), format!("{BETA_IDENTIFIER}.s"));
        assert_eq!(AppProfile::for_platform(REMOTE_TEST_IDENTIFIER, true).keychain_service("s"), format!("{REMOTE_TEST_IDENTIFIER}.s"));
    }

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
