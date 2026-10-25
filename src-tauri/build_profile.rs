// Match Vite's Tauri target/release gate. Never read a runtime preference or a
// VITE_* override to decide which payment surfaces this binary offers.
pub fn ios_store(target_os: &str, profile: &str) -> bool {
    target_os == "ios" && profile == "release"
}

#[cfg(test)]
mod tests {
    #[test]
    fn store_profile_is_automatic_only_for_ios_release() {
        for (target, profile, expected) in [
            ("ios", "release", true), ("ios", "debug", false),
            ("macos", "release", false), ("windows", "release", false),
            ("linux", "release", false), ("android", "release", false),
        ] {
            assert_eq!(super::ios_store(target, profile), expected, "{target}/{profile}");
        }
    }
}
