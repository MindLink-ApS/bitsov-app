//! Build-profile selection is pure and needs no webview or device.
#[path = "../build_profile.rs"]
mod build_profile;

#[test]
fn store_capability_keeps_individual_payments_without_restricted_commands() {
    let capability: serde_json::Value = serde_json::from_str(include_str!("../mobile-capabilities/ios-store.json")).unwrap();
    let permissions = capability["permissions"].as_array().unwrap();
    for command in ["starter-current", "starter-request", "room-quote", "porch-quote", "porch-read", "porch-cards"] {
        assert!(!permissions.contains(&serde_json::json!(format!("allow-{command}"))), "{command}");
    }
    for command in ["message-send", "message-retry", "first-contact-quote", "first-contact-request", "file-send", "call-quote", "call-signal", "payment-pay", "payment-keysend", "sponsor-request", "sponsor-owner-approval"] {
        assert!(permissions.contains(&serde_json::json!(format!("allow-{command}"))), "{command}");
    }
}
